import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { QuestionSpec, ToolResult } from '../../shared/types.js'
import type { McpServerSettings } from '../../shared/types.js'
import type { ToolContext, ToolDef } from '../tools/types.js'
import type { McpCallOptions, McpElicitationRequest, McpElicitationResult, McpProgress, McpToolInfo } from './client.js'
import { META_ALWAYS_LOAD, approvalOf, type ResolvedToolPolicy } from './policy.js'
import { withMcpHint } from './hints.js'

/**
 * First-class MCP tools: every tool of every connected server becomes a registry tool named
 * `mcp__<server>__<tool>`, like Claude Code does. This file turns the servers' listings into `ToolDef`s
 * (names, schemas, risk, approval, deferral) and runs the calls. It does not own connections: the host
 * lookup happens at call time, so a reloaded server is picked up without rebuilding anything.
 */

/** What the builder needs from a connected server; `McpClient` satisfies it. */
export interface McpToolHost {
  readonly name: string
  readonly state: 'stopped' | 'starting' | 'ready' | 'error'
  readonly lastError: string | null
  /** Tools the model may call (after include/exclude and toolPolicy deny). */
  exposedToolsList(): McpToolInfo[]
  policyFor(name: string): ResolvedToolPolicy
  callTool(name: string, args: unknown, timeoutMs?: number, signal?: AbortSignal, options?: McpCallOptions): Promise<ToolResult>
}

/** More tools than this (summed over the servers that are not exempt) and the biggest servers are found with tool_search. */
export const MCP_INLINE_TOOL_LIMIT = 15
const MAX_TOOL_NAME = 64
const INLINE_DESCRIPTION_CHARS = 2_048
const DEFERRED_DESCRIPTION_CHARS = 4_096

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

function sanitizePart(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 4)
}

/**
 * `mcp__<server>__<tool>` restricted to [a-zA-Z0-9_-] and 64 characters (what the model APIs accept). A name
 * that does not fit keeps a readable start and ends with a hash of the original pair, so it stays stable.
 */
export function mcpToolName(server: string, tool: string): string {
  const s = sanitizePart(server)
  const t = sanitizePart(tool)
  const full = `mcp__${s}__${t}`
  if (full.length <= MAX_TOOL_NAME) return full
  const prefix = `mcp__${s.slice(0, 24)}__`
  const hash = shortHash(`${server}\u0000${tool}`)
  return `${prefix}${t.slice(0, MAX_TOOL_NAME - prefix.length - hash.length - 1)}_${hash}`
}

/**
 * Names for a list of (server, tool) pairs, unique and deterministic: the first claimant keeps the clean
 * name; a later pair that sanitizes to the same name gets a hash of its own original names.
 */
export function assignMcpToolNames(pairs: Array<{ server: string; tool: string }>): string[] {
  const taken = new Set<string>()
  return pairs.map(({ server, tool }) => {
    let name = mcpToolName(server, tool)
    if (taken.has(name)) {
      const hash = shortHash(`${server}\u0000${tool}`)
      const base = name.slice(0, MAX_TOOL_NAME - hash.length - 1)
      name = `${base}_${hash}`
      for (let counter = 2; taken.has(name); counter++) {
        const suffix = `_${hash}${counter}`
        name = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`
      }
    }
    taken.add(name)
    return name
  })
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/

export interface NormalizedSchema {
  schema?: Record<string, unknown>
  /** Why the tool cannot be offered to a model API (the server's other tools keep working). */
  error?: string
  /** Sentence to prepend to the description (alternative parameter groups of a root combinator). */
  note?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Makes a server's input schema acceptable to the model APIs: an object at the root, no `$schema`, root-level
 * `anyOf`/`oneOf`/`allOf` flattened into one object (Claude Code does the same), and property names the
 * providers accept. A schema that cannot be fixed comes back with an `error` and the tool is skipped.
 */
export function normalizeMcpInputSchema(input: unknown): NormalizedSchema {
  if (input === undefined || input === null) return { schema: { type: 'object', properties: {} } }
  if (!isRecord(input)) return { error: 'inputSchema não é um objeto JSON Schema' }
  const schema: Record<string, unknown> = { ...input }
  delete schema.$schema
  let note: string | undefined

  const combinator = (['allOf', 'anyOf', 'oneOf'] as const).find((key) => Array.isArray(schema[key]))
  if (combinator && !isRecord(schema.properties)) {
    const branches = (schema[combinator] as unknown[]).filter(isRecord)
    const properties: Record<string, unknown> = {}
    for (const branch of branches) {
      if (isRecord(branch.properties)) Object.assign(properties, branch.properties)
    }
    delete schema[combinator]
    schema.properties = properties
    if (combinator === 'allOf') {
      const required = branches.flatMap((branch) => (Array.isArray(branch.required) ? branch.required.filter((r): r is string => typeof r === 'string') : []))
      if (required.length) schema.required = [...new Set(required)]
    } else {
      const groups = branches
        .map((branch) => (Array.isArray(branch.required) ? branch.required.filter((r): r is string => typeof r === 'string') : []))
        .filter((group) => group.length)
      if (groups.length) note = `Use um destes grupos de parâmetros: ${groups.map((group) => `(${group.join(', ')})`).join(' ou ')}.`
    }
  }

  if (schema.type !== undefined && schema.type !== 'object') return { error: `inputSchema com type "${String(schema.type)}" (esperado object)` }
  schema.type = 'object'
  if (!isRecord(schema.properties)) schema.properties = {}
  for (const key of Object.keys(schema.properties as Record<string, unknown>)) {
    if (!PROPERTY_NAME.test(key)) return { error: `a propriedade "${key.slice(0, 40)}" tem nome inválido para provedores de modelo (use letras, dígitos, _ . -; até 64)` }
  }
  return { schema, note }
}

function schemaProperties(schema: Record<string, unknown>): Record<string, { type?: unknown; description?: unknown }> {
  return isRecord(schema.properties) ? (schema.properties as Record<string, { type?: unknown }>) : {}
}

/** Converts string values to the type the schema declares (local models often send "5" or "true"). */
export function coerceMcpArgs(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const properties = schemaProperties(schema)
  const out: Record<string, unknown> = { ...args }
  for (const [key, definition] of Object.entries(properties)) {
    if (!(key in out)) continue
    const value = out[key]
    const types = Array.isArray(definition?.type) ? (definition.type as unknown[]) : definition?.type ? [definition.type] : []
    if (!types.length) continue
    if (typeof value === 'string' && !types.includes('string')) {
      const trimmed = value.trim()
      if ((types.includes('number') || types.includes('integer')) && trimmed !== '' && Number.isFinite(Number(trimmed))) out[key] = Number(trimmed)
      else if (types.includes('boolean') && /^(true|false)$/i.test(trimmed)) out[key] = trimmed.toLowerCase() === 'true'
      else if ((types.includes('array') || types.includes('object')) && /^[[{]/.test(trimmed)) {
        try {
          out[key] = JSON.parse(trimmed)
        } catch {
          /* leave as sent: the server will say what is wrong */
        }
      }
    } else if ((typeof value === 'number' || typeof value === 'boolean') && types.length === 1 && types[0] === 'string') {
      out[key] = String(value)
    }
  }
  return out
}

export function missingRequiredArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
  return required.filter((key) => args[key] === undefined || args[key] === null)
}

function parameterSummary(schema: Record<string, unknown>): string {
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const entries = Object.entries(schemaProperties(schema)).slice(0, 14)
  if (!entries.length) return '(sem parâmetros)'
  return entries
    .map(([key, definition]) => `${key}${required.has(key) ? '*' : ''}: ${Array.isArray(definition?.type) ? definition.type.join('|') : String(definition?.type ?? 'any')}`)
    .join(', ')
}

/* ------------------------------------------------------------------ */
/* Deferral                                                            */
/* ------------------------------------------------------------------ */

export interface McpExposureInput {
  name: string
  toolCount: number
  /** Server setting `alwaysLoad`: true is exempt from deferral, false is always deferred. */
  alwaysLoad?: boolean
}

/**
 * Which servers send their tool schemas in every request ('inline') and which are found with
 * tool_search/tool_load ('deferred'). Servers marked `alwaysLoad` are exempt and do not count; the others are
 * taken from the smallest to the largest while the running total stays within `limit`, so one big server (Jira,
 * GitHub) is deferred whole while small ones stay at hand.
 */
export function planMcpExposure(servers: McpExposureInput[], limit = MCP_INLINE_TOOL_LIMIT): Map<string, 'inline' | 'deferred'> {
  const plan = new Map<string, 'inline' | 'deferred'>()
  const rest: McpExposureInput[] = []
  for (const server of servers) {
    if (server.alwaysLoad === true) plan.set(server.name, 'inline')
    else if (server.alwaysLoad === false) plan.set(server.name, 'deferred')
    else rest.push(server)
  }
  rest.sort((a, b) => a.toolCount - b.toolCount || a.name.localeCompare(b.name))
  let used = 0
  for (const server of rest) {
    if (used + server.toolCount <= limit) {
      plan.set(server.name, 'inline')
      used += server.toolCount
    } else {
      plan.set(server.name, 'deferred')
    }
  }
  return plan
}

/* ------------------------------------------------------------------ */
/* Elicitation                                                         */
/* ------------------------------------------------------------------ */

interface ElicitationField {
  key: string
  kind: 'enum' | 'boolean' | 'number' | 'integer' | 'string'
  required: boolean
  /** Option label -> value, for enums. */
  values?: Map<string, string>
}

/** Turns an elicitation form (flat object schema) into questions for the user (ask_user's question model). */
export function elicitationToQuestions(request: McpElicitationRequest): { questions: QuestionSpec[]; fields: ElicitationField[] } {
  const schema = isRecord(request.requestedSchema) ? request.requestedSchema : {}
  const properties = isRecord(schema.properties) ? (schema.properties as Record<string, Record<string, unknown>>) : {}
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const questions: QuestionSpec[] = []
  const fields: ElicitationField[] = []
  for (const [key, definition] of Object.entries(properties).slice(0, 8)) {
    if (!isRecord(definition)) continue
    const title = typeof definition.title === 'string' && definition.title ? definition.title : key
    const description = typeof definition.description === 'string' ? definition.description : ''
    const prefix = questions.length === 0 && request.message ? `${request.message}\n` : ''
    const enumValues = Array.isArray(definition.enum) ? definition.enum.map(String) : undefined
    const oneOf = Array.isArray(definition.oneOf) ? (definition.oneOf as Array<Record<string, unknown>>).filter(isRecord) : undefined
    if (enumValues || oneOf?.length) {
      const values = new Map<string, string>()
      if (oneOf?.length) {
        for (const option of oneOf) values.set(String(option.title ?? option.const), String(option.const))
      } else {
        const names = Array.isArray(definition.enumNames) ? (definition.enumNames as unknown[]).map(String) : []
        enumValues!.forEach((value, index) => values.set(names[index] || value, value))
      }
      questions.push({
        header: title.slice(0, 40),
        question: `${prefix}${title}${description ? ` — ${description}` : ''}`,
        options: [...values.keys()].slice(0, 8).map((label) => ({ label })),
        allowOther: false
      })
      fields.push({ key, kind: 'enum', required: required.has(key), values })
    } else if (definition.type === 'boolean') {
      questions.push({
        header: title.slice(0, 40),
        question: `${prefix}${title}${description ? ` — ${description}` : ''}`,
        options: [{ label: 'Sim' }, { label: 'Não' }],
        allowOther: false
      })
      fields.push({ key, kind: 'boolean', required: required.has(key) })
    } else {
      const kind = definition.type === 'number' || definition.type === 'integer' ? definition.type : 'string'
      questions.push({
        header: title.slice(0, 40),
        question: `${prefix}${title}${description ? ` — ${description}` : ''}`
      })
      fields.push({ key, kind, required: required.has(key) })
    }
  }
  return { questions, fields }
}

/** Maps the user's answers back into the `content` object of an elicitation response. */
export function answersToElicitation(
  fields: ElicitationField[],
  answers: Array<{ answers: string[] }> | null
): McpElicitationResult {
  if (!answers) return { action: 'cancel' }
  const content: Record<string, unknown> = {}
  for (const [index, field] of fields.entries()) {
    const answer = (answers[index]?.answers ?? []).join(', ').trim()
    if (!answer) {
      if (field.required) return { action: 'decline' }
      continue
    }
    if (field.kind === 'enum') content[field.key] = field.values?.get(answer) ?? answer
    else if (field.kind === 'boolean') content[field.key] = /^(s|sim|y|yes|true|1)/i.test(answer)
    else if (field.kind === 'number' || field.kind === 'integer') {
      const value = Number(answer.replace(',', '.'))
      if (!Number.isFinite(value)) return { action: 'decline' }
      content[field.key] = field.kind === 'integer' ? Math.round(value) : value
    } else content[field.key] = answer
  }
  return { action: 'accept', content }
}

function elicitViaAsk(ctx: ToolContext): McpCallOptions['onElicit'] | undefined {
  if (!ctx.ask) return undefined
  return async (request) => {
    const { questions, fields } = elicitationToQuestions(request)
    if (!questions.length) return { action: 'cancel' }
    const answers = await ctx.ask!({ questions })
    return answersToElicitation(fields, answers)
  }
}

function progressText(progress: McpProgress): string {
  const amount = progress.total ? `${progress.progress}/${progress.total}` : String(progress.progress)
  return progress.message ? `${progress.message} (${amount})` : `progresso ${amount}`
}

/** Progress and elicitation hooks wired to a tool context (progress goes to the UI card, elicitation to ask_user). */
export function callOptionsFor(ctx: ToolContext): McpCallOptions {
  return {
    onProgress: (progress) => ctx.progress?.(progressText(progress), { progress: progress.progress, total: progress.total }),
    onElicit: elicitViaAsk(ctx)
  }
}

/* ------------------------------------------------------------------ */
/* Building the registry tools                                         */
/* ------------------------------------------------------------------ */

export interface McpToolBuildInput {
  /** Connected servers (anything not `ready` contributes no tools). */
  hosts: McpToolHost[]
  /** Settings of a server (for hints, remote detection and `alwaysLoad`). */
  settings(server: string): McpServerSettings | undefined
  /** Live lookup used when a tool runs, so reloaded servers are found. */
  getHost(server: string): McpToolHost | undefined
  inlineLimit?: number
}

export interface McpSkippedTool {
  server: string
  tool: string
  reason: string
}

export interface McpToolBuild {
  tools: ToolDef[]
  /** Tools left out: unusable schema (the server's other tools stay). */
  skipped: McpSkippedTool[]
  plan: Map<string, 'inline' | 'deferred'>
}

function compactJson(value: unknown, max: number): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    text = '[argumentos não serializáveis]'
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function buildMcpToolDefs(input: McpToolBuildInput): McpToolBuild {
  const ready = input.hosts.filter((host) => host.state === 'ready').sort((a, b) => a.name.localeCompare(b.name))
  const skipped: McpSkippedTool[] = []
  interface Candidate {
    host: McpToolHost
    info: McpToolInfo
    schema: Record<string, unknown>
    note?: string
    policy: ResolvedToolPolicy
  }
  const candidates: Candidate[] = []
  for (const host of ready) {
    for (const info of host.exposedToolsList()) {
      const normalized = normalizeMcpInputSchema(info.inputSchema)
      if (normalized.error || !normalized.schema) {
        skipped.push({ server: host.name, tool: info.name, reason: normalized.error ?? 'schema inválido' })
        continue
      }
      candidates.push({ host, info, schema: normalized.schema, note: normalized.note, policy: host.policyFor(info.name) })
    }
  }

  const counts = new Map<string, number>()
  for (const candidate of candidates) counts.set(candidate.host.name, (counts.get(candidate.host.name) ?? 0) + 1)
  const plan = planMcpExposure(
    ready.map((host) => ({ name: host.name, toolCount: counts.get(host.name) ?? 0, alwaysLoad: input.settings(host.name)?.alwaysLoad })),
    input.inlineLimit ?? MCP_INLINE_TOOL_LIMIT
  )
  const names = assignMcpToolNames(candidates.map((candidate) => ({ server: candidate.host.name, tool: candidate.info.name })))
  const tools = candidates.map((candidate, index) => {
    const deferred = (plan.get(candidate.host.name) ?? 'deferred') === 'deferred' && candidate.info.meta?.[META_ALWAYS_LOAD] !== true
    return makeToolDef(names[index], candidate.host.name, candidate.info, candidate.schema, candidate.note, candidate.policy, deferred, input)
  })
  return { tools, skipped, plan }
}

function makeToolDef(
  name: string,
  server: string,
  info: McpToolInfo,
  schema: Record<string, unknown>,
  note: string | undefined,
  policy: ResolvedToolPolicy,
  deferred: boolean,
  input: McpToolBuildInput
): ToolDef {
  const base = (info.description || info.title || info.name).trim()
  const text = note ? `${note} ${base}` : base
  const limit = deferred ? DEFERRED_DESCRIPTION_CHARS : INLINE_DESCRIPTION_CHARS
  const description = text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  const remote = Boolean(input.settings(server)?.url)
  const tool = info.name
  return {
    name,
    description,
    schema: z.record(z.string(), z.unknown()),
    jsonSchema: schema,
    risk: policy.risk,
    approval: approvalOf(policy),
    parallelSafe: info.annotations?.readOnlyHint === true,
    requires: remote ? 'network' : undefined,
    mcp: { server, tool, deferred, title: info.title ?? info.annotations?.title },
    describe(raw) {
      return {
        title: `MCP ${server}/${tool}`,
        detail: compactJson(raw, 200),
        preview: `${server}/${tool} ${compactJson(raw, 600)}`
      }
    },
    async execute(raw, ctx) {
      const host = input.getHost(server)
      const settings = input.settings(server)
      if (!host || host.state !== 'ready') {
        const why = host?.lastError ? `: ${host.lastError}` : ''
        return {
          ok: false,
          text: withMcpHint(server, settings, `o servidor MCP "${server}" não está conectado${why}. Use mcp_servers para ver o estado e mcp_reload para reconectar.`),
          summary: 'servidor desconectado'
        }
      }
      const current = host.exposedToolsList().find((item) => item.name === tool)
      if (!current) {
        return {
          ok: false,
          text: `a ferramenta "${tool}" não existe mais em "${server}" (a lista do servidor mudou ou a política a ocultou). Use tool_search ou mcp_catalog para ver o que há.`,
          summary: 'ferramenta ausente'
        }
      }
      const currentSchema = normalizeMcpInputSchema(current.inputSchema).schema ?? schema
      const args = coerceMcpArgs(currentSchema, isRecord(raw) ? raw : {})
      const missing = missingRequiredArgs(currentSchema, args)
      if (missing.length) {
        return {
          ok: false,
          text: `argumentos inválidos para ${name}: faltam ${missing.join(', ')}. Parâmetros (* = obrigatório): ${parameterSummary(currentSchema)}`,
          summary: 'argumentos inválidos'
        }
      }
      try {
        const result = await host.callTool(tool, args, undefined, ctx.signal, callOptionsFor(ctx))
        return result.ok ? result : { ...result, text: withMcpHint(server, settings, result.text) }
      } catch (err) {
        const message = (err as Error).message
        ctx.log('warn', `MCP ${server}/${tool}: ${message.slice(0, 300)}`)
        return {
          ok: false,
          text: withMcpHint(server, settings, `erro em ${server}/${tool}: ${message}`),
          summary: 'falhou'
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* System prompt summary                                               */
/* ------------------------------------------------------------------ */

/**
 * One line per connected server for the system prompt: how many tools, whether they are sent directly or
 * found with tool_search. Only server names and counts (tool names are sanitized), never server-provided prose.
 */
export function summarizeMcpTools(defs: Array<Pick<ToolDef, 'name' | 'mcp'>>): string {
  const servers = new Map<string, { inline: string[]; deferred: number }>()
  for (const def of defs) {
    if (!def.mcp) continue
    const entry = servers.get(def.mcp.server) ?? { inline: [], deferred: 0 }
    if (def.mcp.deferred) entry.deferred++
    else entry.inline.push(def.name)
    servers.set(def.mcp.server, entry)
  }
  const lines: string[] = []
  for (const [server, entry] of [...servers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts: string[] = []
    if (entry.inline.length) {
      parts.push(`${entry.inline.length} direta(s): ${entry.inline.slice(0, 8).join(', ')}${entry.inline.length > 8 ? ', …' : ''}`)
    }
    if (entry.deferred) parts.push(`${entry.deferred} sob demanda (tool_search("${sanitizePart(server)}") e tool_load)`)
    lines.push(`- ${server}: ${parts.join('; ')}`)
  }
  return lines.join('\n')
}
