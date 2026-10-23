import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_MODES, REASONING_EFFORTS } from '../../shared/types.js'
import type { AgentDefinition, AgentLoadWarning, AgentSource } from './types.js'
import { BUILTIN_AGENTS } from './definitions.js'

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME_LENGTH = 64
const MAX_FILE_BYTES = 256 * 1024
const MAX_DESCRIPTION = 2000
const MAX_PROMPT = 100_000

export interface LoadedAgents {
  agents: AgentDefinition[]
  warnings: AgentLoadWarning[]
}

export interface LoadAgentsOptions {
  /** Forja's per-user folder (the app uses %APPDATA%\Forja\agents). */
  userDir?: string
  /** Project root: `.forja/agents` is read from it, and `.claude/agents` when `importClaude` is set. */
  cwd?: string
  /** Also read Claude Code's agent folders (project `.claude/agents` and `~/.claude/agents`), read-only. */
  importClaude?: boolean
  /** Replaces os.homedir() when locating `~/.claude/agents`. */
  homeDir?: string
  /** Replaces the built-in agents. */
  builtins?: AgentDefinition[]
}

export function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && name.length <= MAX_NAME_LENGTH && NAME_RE.test(name)
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

type Scalar = string | number | boolean | null
type FrontValue = Scalar | Scalar[]

export type FrontmatterResult = { data: Record<string, FrontValue>; body: string } | { error: string }

/**
 * Splits `---` YAML-ish frontmatter from the body. It understands what agent
 * files use in practice: `key: value` scalars (plain, "double" and 'single'
 * quoted, also across lines), `[flow, lists]`, `- block` lists and `|` / `>`
 * block scalars. Anything fancier (nested maps, anchors) is skipped.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  if (lines[0].trimEnd() !== '---') return { error: 'faltou o bloco de frontmatter (--- ... ---) no início do arquivo' }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return { error: 'frontmatter sem a linha de fechamento ---' }
  const parsed = parseHeader(lines.slice(1, end))
  if ('error' in parsed) return parsed
  return { data: parsed.values, body: lines.slice(end + 1).join('\n').trim() }
}

function parseHeader(lines: string[]): { values: Record<string, FrontValue> } | { error: string } {
  const values: Record<string, FrontValue> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Nested maps (hooks, mcpServers...) are not used by agents; what is indented under them is skipped.
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) {
      i++
      continue
    }
    const match = /^([A-Za-z_][\w.-]*)\s*:(?:[ \t]+(.*))?$/.exec(line)
    if (!match) return { error: `linha inválida no frontmatter: "${line.slice(0, 60)}"` }
    const key = match[1]
    const rest = (match[2] ?? '').trim()
    i++

    if (rest === '') {
      // A block list, or an empty value.
      const items: Scalar[] = []
      let sawList = false
      while (i < lines.length) {
        const item = /^\s*-(?:\s+(.*))?$/.exec(lines[i])
        if (!item) {
          // Skip nested content that belongs to this key but is not a list.
          if (/^\s+\S/.test(lines[i]) && !sawList) {
            i++
            continue
          }
          break
        }
        sawList = true
        items.push(scalarOf((item[1] ?? '').trim()))
        i++
      }
      values[key] = sawList ? items : null
      continue
    }

    if (/^[|>][+-]?\d*$/.test(rest)) {
      const block: string[] = []
      while (i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i]))) block.push(lines[i++])
      values[key] = blockScalar(block, rest.startsWith('>'))
      continue
    }

    if (rest.startsWith('[')) {
      let joined = rest
      while (!closesFlow(joined) && i < lines.length) joined += ` ${lines[i++].trim()}`
      if (!closesFlow(joined)) return { error: `lista sem fechamento "]" em "${key}"` }
      values[key] = splitList(joined.slice(1, joined.lastIndexOf(']'))).map(scalarOf)
      continue
    }

    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]
      let joined = rest
      while (!quoteCloses(joined, quote) && i < lines.length) joined += `\n${lines[i++]}`
      if (!quoteCloses(joined, quote)) return { error: `texto entre aspas sem fechamento em "${key}"` }
      values[key] = unquote(joined, quote)
      continue
    }

    // Plain scalar; indented follow-up lines continue it, as in YAML.
    let plain = stripComment(rest)
    while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*-(\s|$)/.test(lines[i])) plain += ` ${stripComment(lines[i++].trim())}`
    values[key] = scalarOf(plain.trim())
  }
  return { values }
}

function stripComment(text: string): string {
  const at = text.search(/\s#/)
  return at >= 0 ? text.slice(0, at) : text
}

function closesFlow(text: string): boolean {
  let depth = 0
  let quote = ''
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[') depth++
    else if (ch === ']') depth--
  }
  return depth <= 0 && text.includes(']')
}

/** True when `text` (which starts with `quote`) contains the matching closing quote. */
function quoteCloses(text: string, quote: string): boolean {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i++
        continue
      }
      return true
    }
  }
  return false
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' }

function unquote(text: string, quote: string): string {
  let out = ''
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (quote === '"' && ch === '\\') {
      const next = text[++i]
      out += ESCAPES[next] ?? `\\${next ?? ''}`
      continue
    }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        out += "'"
        i++
        continue
      }
      break
    }
    if (ch === '\n') {
      // A raw line break inside a quoted scalar folds into one space; a blank line keeps one break.
      out = out.replace(/[ \t]+$/, '')
      let blank = 0
      while (text[i + 1] === '\n' || text[i + 1] === ' ' || text[i + 1] === '\t') {
        if (text[i + 1] === '\n') blank++
        i++
      }
      out += blank > 0 ? '\n' : ' '
      continue
    }
    out += ch
  }
  return out
}

function blockScalar(block: string[], folded: boolean): string {
  while (block.length && block[block.length - 1].trim() === '') block.pop()
  const indent = Math.min(Infinity, ...block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length))
  const lines = block.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l))
  if (!folded) return lines.join('\n').trim()
  return lines
    .join('\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, ' '))
    .join('\n')
    .trim()
}

/** Splits `a, b(c, d), "e, f"` on top-level commas. */
function splitList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === '(' || ch === '[') {
      depth++
      current += ch
    } else if (ch === ')' || ch === ']') {
      depth--
      current += ch
    } else if (ch === ',' && depth <= 0) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

function scalarOf(text: string): Scalar {
  if (!text) return null
  if (text.startsWith('"') && quoteCloses(text, '"')) return unquote(text, '"')
  if (text.startsWith("'") && quoteCloses(text, "'")) return unquote(text, "'")
  if (/^true$/i.test(text)) return true
  if (/^false$/i.test(text)) return false
  if (/^(null|~)$/i.test(text)) return null
  if (/^-?\d+$/.test(text)) return Number(text)
  return text
}

/* ------------------------------------------------------------------ */
/* Definitions from markdown                                           */
/* ------------------------------------------------------------------ */

const SHELL_TOOLS = ['run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process']

/** Claude Code tool names (lowercase) and the Forja tools that cover them. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ['read_file'],
  write: ['write_file'],
  edit: ['edit_file'],
  multiedit: ['edit_file'],
  bash: SHELL_TOOLS,
  powershell: SHELL_TOOLS,
  grep: ['grep'],
  glob: ['glob'],
  ls: ['list_dir'],
  webfetch: ['fetch_url'],
  websearch: ['web_search'],
  todowrite: ['update_plan'],
  skill: ['use_skill', 'list_skills'],
  notebookedit: []
}

/** Claude Code accepts aliases (sonnet, opus, haiku) that no Forja provider understands. */
function normalizeModel(raw: string, imported: boolean): string {
  const model = raw.trim()
  if (!model || model.toLowerCase() === 'inherit') return 'inherit'
  // Explicit `providerId/model` is Forja's own syntax and always kept.
  if (model.includes('/')) return model
  // Bare names in Claude folders name Claude models; they only make sense on a Claude provider.
  if (imported) return 'inherit'
  return /^(sonnet|opus|haiku)$/i.test(model) ? 'inherit' : model
}

function toAgentName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function stringList(value: FrontValue | undefined): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string | number => v !== null && typeof v !== 'boolean')
      .map((v) => String(v).trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') return splitList(value)
  return []
}

/**
 * Tool lists accept Forja names, globs (`browser_*`) and Claude Code names.
 * `Task` / `Agent` entries are not tools here: `Task(a, b)` becomes canCall
 * [a, b] and a bare `Task` becomes '*'.
 */
function parseToolList(value: FrontValue | undefined): { tools: string[] | undefined; canCall?: string[] | '*' } {
  // An explicit empty list means "no tools at all", unlike a missing or empty value.
  if (Array.isArray(value) && !value.length) return { tools: [] }
  const items = stringList(value)
  if (!items.length || (items.length === 1 && items[0] === '*')) return { tools: undefined }
  const tools: string[] = []
  let canCall: string[] | '*' | undefined
  for (const item of items) {
    const delegate = /^(task|agent)\s*(?:\((.*)\))?$/i.exec(item)
    if (delegate) {
      const inner = delegate[2]?.trim()
      if (!inner || inner === '*') canCall = '*'
      else if (canCall !== '*') canCall = [...new Set([...(canCall ?? []), ...splitList(inner).map(toAgentName).filter(Boolean)])]
      continue
    }
    for (const name of CLAUDE_TOOLS[item.toLowerCase()] ?? [item]) if (!tools.includes(name)) tools.push(name)
  }
  return { tools, canCall }
}

/** Looks a frontmatter key up ignoring case, `_` and `-` (maxTurns, max_turns...). */
function field(data: Record<string, FrontValue>, ...names: string[]): FrontValue | undefined {
  const wanted = new Set(names.map((n) => n.toLowerCase().replace(/[_-]/g, '')))
  for (const [k, v] of Object.entries(data)) if (wanted.has(k.toLowerCase().replace(/[_-]/g, ''))) return v
  return undefined
}

export interface ParsedAgent {
  agent?: AgentDefinition
  /** Why the file was ignored. */
  error?: string
}

/** Builds a definition from the text of one agent file. `fallbackName` is the file name without extension. */
export function parseAgentMarkdown(raw: string, fallbackName: string, source: AgentSource, imported = false): ParsedAgent {
  const front = parseFrontmatter(raw)
  if ('error' in front) return { error: front.error }
  const { data, body } = front

  const rawName = field(data, 'name')
  const name = toAgentName(typeof rawName === 'string' || typeof rawName === 'number' ? String(rawName) : fallbackName)
  if (!isValidAgentName(name)) return { error: `nome de agente inválido: "${String(rawName ?? fallbackName)}"` }

  const rawDescription = field(data, 'description')
  const description = typeof rawDescription === 'number' ? String(rawDescription) : rawDescription
  if (typeof description !== 'string' || !description.trim()) return { error: 'o frontmatter precisa de uma "description"' }
  if (!body) return { error: 'o arquivo não tem prompt (corpo vazio depois do frontmatter)' }

  const def: AgentDefinition = { name, description: description.trim(), systemPrompt: body, source }

  const mode = field(data, 'mode')
  if (mode !== undefined && mode !== null) {
    if (typeof mode !== 'string' || !AGENT_MODES.includes(mode as never)) {
      return { error: `modo inválido: "${String(mode)}" (use ${AGENT_MODES.join(', ')})` }
    }
    def.mode = mode as AgentDefinition['mode']
  }

  const tools = parseToolList(field(data, 'tools'))
  if (tools.tools) def.tools = tools.tools
  const disallowed = parseToolList(field(data, 'disallowedTools')).tools
  if (disallowed?.length) def.disallowedTools = disallowed

  const canCall = field(data, 'canCall')
  if (canCall !== undefined && canCall !== null && canCall !== '') {
    const list = stringList(canCall)
    def.canCall = list.includes('*') ? '*' : list.map(toAgentName).filter(Boolean)
  } else if (tools.canCall) def.canCall = tools.canCall

  const model = field(data, 'model')
  if (typeof model === 'string') {
    const normalized = normalizeModel(model, imported)
    if (normalized !== 'inherit') def.model = normalized
  }

  const effort = field(data, 'effort')
  if (effort !== undefined && effort !== null) {
    if (typeof effort !== 'string' || !REASONING_EFFORTS.includes(effort as never)) {
      return { error: `effort inválido: "${String(effort)}" (use ${REASONING_EFFORTS.join(', ')})` }
    }
    def.effort = effort as AgentDefinition['effort']
  }

  const maxTurns = field(data, 'maxTurns')
  if (maxTurns !== undefined && maxTurns !== null) {
    const n = typeof maxTurns === 'number' ? maxTurns : Number(maxTurns)
    if (!Number.isInteger(n) || n < 1 || n > 500) return { error: `maxTurns inválido: "${String(maxTurns)}" (inteiro de 1 a 500)` }
    def.maxTurns = n
  }

  const color = field(data, 'color')
  if (typeof color === 'string' && color.trim()) def.color = color.trim().slice(0, 32)

  if (field(data, 'hidden') === true) def.hidden = true

  return { agent: def }
}

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

/** Reads every `*.md` file of `dir`. A missing folder is not an error. */
export function loadAgentsFromDir(dir: string, source: AgentSource, imported = false): LoadedAgents {
  const out: LoadedAgents = { agents: [], warnings: [] }
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') out.warnings.push({ file: dir, message: `não foi possível ler a pasta: ${(err as Error).message}` })
    return out
  }
  const seen = new Set<string>()
  for (const entry of files.sort((a, b) => a.localeCompare(b))) {
    if (!/\.md$/i.test(entry) || entry.startsWith('.') || /^readme\.md$/i.test(entry)) continue
    const file = path.join(dir, entry)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) {
        out.warnings.push({ file, message: `arquivo grande demais (${Math.round(stat.size / 1024)} KB, máximo ${MAX_FILE_BYTES / 1024} KB)` })
        continue
      }
      const parsed = parseAgentMarkdown(fs.readFileSync(file, 'utf8'), entry.replace(/\.md$/i, ''), source, imported)
      if (!parsed.agent) {
        out.warnings.push({ file, message: parsed.error ?? 'arquivo inválido' })
        continue
      }
      if (seen.has(parsed.agent.name)) {
        out.warnings.push({ file, message: `agente "${parsed.agent.name}" duplicado nesta pasta; o primeiro arquivo foi mantido` })
        continue
      }
      seen.add(parsed.agent.name)
      out.agents.push({ ...parsed.agent, file, ...(imported ? { imported: true } : {}) })
    } catch (err) {
      out.warnings.push({ file, message: `falha ao ler o arquivo: ${(err as Error).message}` })
    }
  }
  return out
}

/**
 * Built-ins first, then each folder; a later definition replaces an earlier one
 * with the same name. Order (later wins): built-ins, ~/.claude/agents, the user
 * folder, <project>/.claude/agents, <project>/.forja/agents. So the project
 * beats the user, and Forja's own files beat imported Claude ones at the same
 * level. Claude folders are read only when `importClaude` is set.
 */
export function loadAgents(options: LoadAgentsOptions = {}): LoadedAgents {
  const layers: LoadedAgents[] = [{ agents: options.builtins ?? BUILTIN_AGENTS, warnings: [] }]
  if (options.importClaude) {
    layers.push(loadAgentsFromDir(path.join(options.homeDir ?? os.homedir(), '.claude', 'agents'), 'user', true))
  }
  if (options.userDir) layers.push(loadAgentsFromDir(options.userDir, 'user'))
  if (options.cwd) {
    if (options.importClaude) layers.push(loadAgentsFromDir(path.join(options.cwd, '.claude', 'agents'), 'project', true))
    layers.push(loadAgentsFromDir(path.join(options.cwd, '.forja', 'agents'), 'project'))
  }
  const byName = new Map<string, AgentDefinition>()
  const warnings: AgentLoadWarning[] = []
  for (const layer of layers) {
    for (const agent of layer.agents) byName.set(agent.name, agent)
    warnings.push(...layer.warnings)
  }
  return { agents: [...byName.values()], warnings }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** Problems that make a definition unsafe or unusable to write; empty when it is fine. */
export function validateAgentDefinition(def: AgentDefinition): string[] {
  const problems: string[] = []
  if (!isValidAgentName(def.name)) problems.push('o nome deve estar em kebab-case (letras minúsculas, números e hifens, até 64 caracteres)')
  if (typeof def.description !== 'string' || !def.description.trim()) problems.push('a descrição não pode ser vazia')
  else if (def.description.length > MAX_DESCRIPTION) problems.push(`a descrição passa de ${MAX_DESCRIPTION} caracteres`)
  if (typeof def.systemPrompt !== 'string' || !def.systemPrompt.trim()) problems.push('o prompt não pode ser vazio')
  else if (def.systemPrompt.length > MAX_PROMPT) problems.push(`o prompt passa de ${MAX_PROMPT} caracteres`)
  if (def.mode !== undefined && !AGENT_MODES.includes(def.mode)) problems.push(`modo inválido: ${String(def.mode)}`)
  if (def.effort !== undefined && !REASONING_EFFORTS.includes(def.effort)) problems.push(`effort inválido: ${String(def.effort)}`)
  if (def.maxTurns !== undefined && (!Number.isInteger(def.maxTurns) || def.maxTurns < 1 || def.maxTurns > 500)) {
    problems.push('maxTurns deve ser um inteiro de 1 a 500')
  }
  for (const list of ['tools', 'disallowedTools'] as const) {
    const names = def[list]
    if (names !== undefined && (!Array.isArray(names) || names.some((t) => typeof t !== 'string' || !t.trim() || /[,\n]/.test(t)))) {
      problems.push(`${list} deve ser uma lista de nomes`)
    }
  }
  if (def.canCall !== undefined && def.canCall !== '*' && (!Array.isArray(def.canCall) || def.canCall.some((n) => !isValidAgentName(n)))) {
    problems.push('canCall deve ser "*" ou uma lista de nomes de agentes em kebab-case')
  }
  if (def.model !== undefined && (typeof def.model !== 'string' || !def.model.trim() || def.model.length > 200 || /\n/.test(def.model))) {
    problems.push('model inválido')
  }
  return problems
}

function yamlValue(text: string): string {
  const plain = /^[A-Za-z0-9_][A-Za-z0-9_ ./@-]*$/.test(text) && !/^(true|false|null|\d+)$/i.test(text) && text === text.trim()
  return plain ? text : JSON.stringify(text)
}

/** Markdown with frontmatter in the format `parseAgentMarkdown` reads (and Claude Code's, for the shared keys). */
export function serializeAgent(def: AgentDefinition): string {
  const lines = ['---', `name: ${yamlValue(def.name)}`, `description: ${JSON.stringify(def.description.trim())}`]
  if (def.mode) lines.push(`mode: ${def.mode}`)
  if (def.tools) lines.push(def.tools.length ? `tools: ${yamlValue(def.tools.join(', '))}` : 'tools: []')
  if (def.disallowedTools?.length) lines.push(`disallowedTools: ${yamlValue(def.disallowedTools.join(', '))}`)
  if (def.canCall !== undefined) lines.push(`canCall: ${def.canCall === '*' ? '"*"' : yamlValue(def.canCall.join(', '))}`)
  if (def.model) lines.push(`model: ${yamlValue(def.model)}`)
  if (def.effort) lines.push(`effort: ${def.effort}`)
  if (def.maxTurns !== undefined) lines.push(`maxTurns: ${def.maxTurns}`)
  if (def.color) lines.push(`color: ${yamlValue(def.color)}`)
  if (def.hidden) lines.push('hidden: true')
  lines.push('---', '', def.systemPrompt.trim(), '')
  return lines.join('\n')
}

export interface WriteAgentOptions {
  /** Replace an existing file with the same name. Off by default. */
  overwrite?: boolean
}

/**
 * Writes `<dir>/<name>.md`. Refuses invalid definitions, names that would
 * leave `dir`, Claude Code's own folder, and existing files unless `overwrite`.
 * Returns the absolute path of the file.
 */
export function writeAgentFile(dir: string, def: AgentDefinition, options: WriteAgentOptions = {}): string {
  const problems = validateAgentDefinition(def)
  if (problems.length) throw new Error(`agente inválido: ${problems.join('; ')}`)
  const root = path.resolve(dir)
  const file = path.resolve(root, `${def.name}.md`)
  if (path.dirname(file) !== root) throw new Error('nome de agente inválido: o arquivo ficaria fora da pasta de agentes')
  if (path.basename(root).toLowerCase() === 'agents' && path.basename(path.dirname(root)).toLowerCase() === '.claude') {
    throw new Error('o Forja não grava na pasta .claude/agents; ela é só leitura')
  }
  fs.mkdirSync(root, { recursive: true })
  try {
    fs.writeFileSync(file, serializeAgent(def), { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`já existe um agente "${def.name}" em ${root}; ative a substituição para sobrescrevê-lo`)
    }
    throw err
  }
  return file
}
