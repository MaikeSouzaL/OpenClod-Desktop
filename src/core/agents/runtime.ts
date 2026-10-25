import path from 'node:path'
import type {
  AgentDefinition,
  ApprovalDecision,
  ApprovalRequest,
  HarnessEvent,
  Message,
  PolicyConfig,
  Provider,
  ProviderConfig,
  RunState,
  Usage
} from '../../shared/types.js'
import { SessionRunner, type RunnerDeps } from '../agent/runner.js'
import { BrowserLayer } from '../browser/layer.js'
import { modeAllowsWrite } from '../security/permissions.js'
import { FileTracker } from '../session/tracker.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { SubagentOutcome, SubagentSpec, Tracker } from '../tools/types.js'
import { id } from '../util/ids.js'
import { GENERAL_WORKER, WORKER_AGENT, WORKER_TOOLS } from './definitions.js'
import { DEFAULT_AGENT_CAPS, DEFAULT_MAX_AGENT_DEPTH, childLimits, type AgentCaps } from './limits.js'
import type { AgentRegistry } from './registry.js'
import type { SubagentCaller } from './types.js'

/** First characters of a child's answer carried by its end event. */
const SUMMARY_CHARS = 400
/** The task text carried by the start event is capped so one event stays small. */
const PROMPT_EVENT_CHARS = 4000

/** Who a child is, handed to the provider factory (useful for logging and for tests). */
export interface ChildInfo {
  agent: string
  label: string
  childId: string
  depth: number
  parentChildId?: string
}

/**
 * Everything the runtime needs from the host app. The Orchestrator provides
 * the real thing; tests inject scripted providers.
 */
export interface AgentRuntimeEnv {
  agents: AgentRegistry
  /** Tools the children can use (the same registry as the user's session). */
  tools: ToolRegistry
  createProvider(config: ProviderConfig, info: ChildInfo): Provider
  /** Looks up a configured provider by id, for `model: "providerId/model"`. */
  findProvider(providerId: string): ProviderConfig | undefined
  /** Best model/provider currently configured and unlocked, used by `model: "best"` agents. */
  bestModel?: () => ProviderConfig | undefined
  /** Receives every event of the tree (subagent lifecycle, forwarded tool events, notices), already addressed to the root session. */
  emit(event: HarnessEvent): void
  /** Routes a child's approval request to the user. Its `sessionId` is the root session. */
  approve(request: ApprovalRequest): Promise<ApprovalDecision | boolean>
  /** One browser per child so parallel children do not fight over a page. Defaults to a new BrowserLayer. */
  createBrowser?(): BrowserLayer
  /** Facts about the machine (installed toolchains...) appended to every child's system prompt. */
  extraContext?: string
  /** Base folder for spilled tool output; children write under `<base>/<rootSessionId>/`. */
  toolOutputDir?: string
  onChildStart?(rootSessionId: string, childId: string): void
  onChildEnd?(rootSessionId: string, childId: string): void
  caps?: Partial<AgentCaps>
  /** Passed to the children's runners (stream retry delay). */
  retryBaseMs?: number
}

/* ------------------------------------------------------------------ */
/* Tree bookkeeping                                                    */
/* ------------------------------------------------------------------ */

interface Gate {
  active: number
  waiters: Array<() => void>
}

/** Counters shared by every agent started by one user turn. */
export class AgentTree {
  /** Children started so far in this turn, across all levels. */
  spawned = 0
  private readonly gates = new Map<string, Gate>()

  /**
   * Takes one of the `cap` slots a runner has for concurrent children, waiting
   * for a free one. Returns the function that frees it. Rejects when `signal` aborts first.
   */
  acquire(runnerId: string, cap: number, signal: AbortSignal): Promise<() => void> {
    const gate = this.gates.get(runnerId) ?? { active: 0, waiters: [] }
    this.gates.set(runnerId, gate)
    const release = (): void => {
      gate.active--
      gate.waiters.shift()?.()
    }
    if (gate.active < cap) {
      gate.active++
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort)
        gate.active++
        resolve(release)
      }
      const onAbort = (): void => {
        const at = gate.waiters.indexOf(grant)
        if (at >= 0) gate.waiters.splice(at, 1)
        reject(new Error('aborted'))
      }
      gate.waiters.push(grant)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** The user's turn owns one abort signal; it keys the tree of that turn. */
const trees = new WeakMap<AbortSignal, AgentTree>()

function treeFor(signal: AbortSignal): AgentTree {
  let tree = trees.get(signal)
  if (!tree) {
    tree = new AgentTree()
    trees.set(signal, tree)
  }
  return tree
}

/* ------------------------------------------------------------------ */
/* Toolset, model, policy                                              */
/* ------------------------------------------------------------------ */

const DELEGATION_TOOLS = ['agent', 'list_agents', 'task']
/** Tools a child only gets when its definition names them: they reach outside the task or persist state. */
const OPT_IN_TOOLS = ['external_agent', 'memory_write']

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact tool name, or a glob where `*` matches anything (`browser_*`, `mcp__*`). */
export function toolMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*')) return false
  return new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`).test(name)
}

const named = (patterns: string[] | undefined, tool: string): boolean => patterns?.some((p) => toolMatches(p, tool)) ?? false

export interface ToolsetInput {
  def: AgentDefinition
  /** The legacy `task` path: `requested` replaces the default toolset instead of narrowing it. */
  generic: boolean
  requested?: string[]
  /** Tools the caller can use; a child never gets more. */
  available: string[]
  canDelegate: boolean
}

/**
 * Allowlist for a child: the caller's tools, cut down to the definition's `tools`
 * (all of them when unset, except the opt-in ones), minus `disallowedTools`, then
 * narrowed by what the caller asked for. Delegation tools are present only when the
 * definition may call someone.
 */
export function resolveChildTools(input: ToolsetInput): { tools: string[]; ignored: string[] } {
  const { def, generic, requested, available } = input
  const base = generic ? (requested ?? def.tools) : def.tools
  let pool = available.filter((tool) => !DELEGATION_TOOLS.includes(tool))
  pool = base ? pool.filter((tool) => named(base, tool)) : pool.filter((tool) => !OPT_IN_TOOLS.includes(tool))
  if (input.canDelegate) {
    const wanted = ['agent', 'list_agents', ...(def.canCall === '*' ? ['task'] : [])]
    for (const tool of wanted) if (available.includes(tool) && !pool.includes(tool)) pool.push(tool)
  }
  if (def.disallowedTools?.length) pool = pool.filter((tool) => !named(def.disallowedTools, tool))
  let ignored: string[] = []
  if (!generic && requested) {
    ignored = requested.filter((pattern) => !pool.some((tool) => toolMatches(pattern, tool)))
    pool = pool.filter((tool) => named(requested, tool))
  }
  return { tools: pool, ignored }
}

/** A child is never more permissive than its caller: `auto` and `readonly` carry over, everything else asks. */
export function childPolicy(parent: PolicyConfig): PolicyConfig {
  const mode =
    parent.mode === 'unrestricted'
      ? 'unrestricted'
      : parent.mode === 'auto'
        ? 'auto'
        : parent.mode === 'readonly'
          ? 'readonly'
          : 'ask'
  return { ...parent, mode }
}

/**
 * `inherit` (or nothing) keeps the caller's provider and model. `providerId/model`
 * switches provider when the prefix is a configured one; anything else is a model
 * id of the caller's provider (ids such as `meta/llama-3` keep their slash).
 */
export function resolveAgentModel(
  model: string | undefined,
  parent: ProviderConfig,
  findProvider: (providerId: string) => ProviderConfig | undefined
): ProviderConfig {
  if (!model || model === 'inherit') return parent
  const slash = model.indexOf('/')
  if (slash > 0) {
    const other = findProvider(model.slice(0, slash))
    if (other) return { ...other, model: model.slice(slash + 1) }
  }
  return { ...parent, model }
}

/** The child's file changes also land in the caller's tracker, so the diff panel shows them. Reads stay separate. */
class ForwardingTracker extends FileTracker {
  constructor(
    base: string,
    private readonly parent: Tracker
  ) {
    super(base)
  }

  override recordChange(file: string, before: string | null, after: string | null): void {
    super.recordChange(file, before, after)
    this.parent.recordChange(file, before, after)
  }
}

/* ------------------------------------------------------------------ */
/* Spawning                                                            */
/* ------------------------------------------------------------------ */

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function refuse(text: string): SubagentOutcome {
  return { ok: false, text, sessionId: '' }
}

function callableNames(env: AgentRuntimeEnv, caller: SubagentCaller): string {
  const names = env.agents.callableBy(caller.agentName).map((a) => a.name)
  return names.length ? names.join(', ') : '(nenhum)'
}

/**
 * Runs one child agent to completion and returns its final answer. Every
 * limit is checked here, before anything starts, so a refusal costs nothing
 * and reaches the model as an ordinary tool error:
 * the target must be callable by `caller`, depth, repetition of the same agent
 * in the chain, children per turn, and (by waiting) children at once.
 */
export async function spawnAgent(
  env: AgentRuntimeEnv,
  caller: SubagentCaller,
  spec: SubagentSpec,
  tree: AgentTree = treeFor(caller.signal)
): Promise<SubagentOutcome> {
  const caps = { ...DEFAULT_AGENT_CAPS, ...env.caps }
  const generic = spec.agent === undefined
  const name = spec.agent ?? WORKER_AGENT
  const callerDef = caller.agentName ? env.agents.get(caller.agentName) : undefined

  const def = generic ? (env.agents.get(WORKER_AGENT) ?? GENERAL_WORKER) : env.agents.get(name)
  // The generic worker serves `task`: the user's session may use it, and so may agents that can call anyone.
  const allowed = generic ? !caller.agentName || callerDef?.canCall === '*' : env.agents.canCall(caller.agentName, name)
  if (!def || !allowed) {
    return refuse(`o agente "${name}" não está disponível para você. Agentes que você pode chamar: ${callableNames(env, caller)}.`)
  }

  const depth = caller.depth + 1
  const maxDepth = caller.limits.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH
  if (depth > maxDepth) {
    return refuse(
      `limite de profundidade de agentes atingido: o máximo é ${maxDepth} níveis e você já está no nível ${caller.depth}. ` +
        'Faça este trabalho você mesmo ou devolva o que descobriu ao agente que chamou você.'
    )
  }

  if (!generic) {
    const repeats = caller.chain.filter((n) => n === def.name).length
    if (repeats >= caps.maxRepeat) {
      return refuse(
        `ciclo de agentes bloqueado: "${def.name}" já aparece ${repeats}x na cadeia de chamadas (${[...caller.chain, def.name].join(' → ')}). ` +
          'Faça esta parte você mesmo ou devolva o resultado ao chamador.'
      )
    }
  }

  if (tree.spawned >= caps.maxPerTurn) {
    return refuse(`limite de ${caps.maxPerTurn} subagentes por turno atingido. Conclua com o que já foi feito ou faça o restante você mesmo.`)
  }

  const canDelegate = !generic && env.agents.callableBy(def.name).length > 0
  const { tools, ignored } = resolveChildTools({ def, generic, requested: spec.tools, available: caller.availableTools, canDelegate })
  if (spec.tools?.length && !generic && !tools.length) {
    return refuse(`nenhuma das ferramentas pedidas (${spec.tools.join(', ')}) está disponível para o agente "${def.name}".`)
  }

  // The caller's mode caps ours: an agent that writes cannot be started from a read-only mode.
  const wanted = generic ? (spec.mode ?? def.mode ?? 'code') : (def.mode ?? 'code')
  const mode = modeAllowsWrite(wanted) && !modeAllowsWrite(caller.mode) ? caller.mode : wanted

  const providerConfig = def.model === 'best'
    ? env.bestModel?.() ?? caller.providerConfig
    : resolveAgentModel(def.model, caller.providerConfig, env.findProvider)
  const childId = id('sub')
  const parentChildId = caller.depth > 0 ? caller.sessionId : undefined
  const info: ChildInfo = { agent: def.name, label: spec.label, childId, depth, parentChildId }
  let provider: Provider
  try {
    provider = env.createProvider(providerConfig, info)
  } catch (err) {
    return refuse(`não foi possível iniciar o agente "${def.name}": ${(err as Error).message}`)
  }

  tree.spawned++
  let release: () => void
  try {
    release = await tree.acquire(caller.sessionId, caps.maxConcurrent, caller.signal)
  } catch {
    return refuse('chamada cancelada antes de começar')
  }

  const root = caller.rootSessionId
  const model = `${providerConfig.id}/${providerConfig.model}`
  const startedAt = Date.now()
  const identity = { agent: def.name, model, parentChildId, depth }
  env.emit({ type: 'subagent', sessionId: root, childId, label: spec.label, state: 'thinking', ...identity, startedAt, prompt: spec.prompt.slice(0, PROMPT_EVENT_CHARS) })
  env.onChildStart?.(root, childId)

  const services = {
    ...caller.services,
    browser: (env.createBrowser ?? (() => new BrowserLayer({ sessionId: childId })))()
  }
  let lastError: string | undefined

  const deps: RunnerDeps = {
    sessionId: childId,
    rootSessionId: root,
    agentName: def.name,
    agentChain: [...caller.chain, def.name],
    agents: env.agents,
    autoAgents: caller.autoAgents,
    createAgent: caller.createAgent,
    effort: def.effort ?? caller.effort,
    cwd: caller.cwd,
    mode,
    provider,
    providerConfig,
    registry: env.tools,
    policy: childPolicy(caller.policy),
    limits: childLimits(caller.limits, depth, def),
    tracker: new ForwardingTracker(caller.cwd, caller.tracker),
    workspace: caller.workspace,
    allowedTools: tools,
    services,
    project: { ...caller.project, name: `${caller.project.name} / ${spec.label}`.slice(0, 120) },
    projectId: caller.projectId,
    environment: caller.environment,
    hooks: caller.hooks,
    emit: (event) => {
      switch (event.type) {
        case 'tool_start':
        case 'tool_end':
          // Prefixed so ids from different children (or the session itself) can never collide in the UI.
          env.emit({ ...event, sessionId: root, toolCallId: `${childId}:${event.toolCallId}`, agentId: childId })
          break
        case 'notice':
          if (event.level === 'error') lastError = event.text
          env.emit({ ...event, sessionId: root, text: `[${spec.label}] ${event.text}` })
          break
        case 'audit':
          if (event.level !== 'info') env.emit({ ...event, sessionId: root, message: `[${spec.label}] ${event.message}` })
          break
        case 'turn_end':
          if (event.error) lastError = event.error
          break
        default:
          // Text and reasoning deltas, messages, plans and usage stay inside the child.
          break
      }
    },
    approve: (request) => env.approve({ ...request, sessionId: root, title: `[${def.name}] ${request.title}` }),
    persist: () => undefined,
    runSubagent: (childSpec, childCaller) => spawnAgent(env, childCaller, childSpec, tree),
    systemExtra: [childPrompt(def, caller, depth, maxDepth, canDelegate), env.extraContext].filter(Boolean).join('\n\n'),
    depth,
    parentSignal: caller.signal,
    toolOutputDir: env.toolOutputDir ? path.join(env.toolOutputDir, root) : undefined,
    retryBaseMs: env.retryBaseMs
  }

  let state: RunState = 'error'
  let text = ''
  let outcome: SubagentOutcome
  try {
    const runner = new SessionRunner(deps)
    await runner.send(spec.prompt)
    state = caller.signal.aborted && runner.state !== 'done' ? 'cancelled' : runner.state
    text = lastAssistantText(runner.messages)
    outcome = outcomeOf({ state, text, error: lastError, childId, usage: runner.usage, ignored })
  } catch (err) {
    lastError = (err as Error).message
    outcome = { ok: false, text: `subagente falhou: ${lastError}`, sessionId: childId }
  } finally {
    release()
    await services.browser.close().catch(() => undefined)
  }

  const ended = state === 'done' ? 'done' : state === 'cancelled' ? 'cancelled' : 'error'
  const summary = ended === 'done' ? text : (lastError ?? text)
  env.emit({ type: 'subagent', sessionId: root, childId, label: spec.label, state: ended, ...identity, startedAt, endedAt: Date.now(), summary: summary.slice(0, SUMMARY_CHARS) })
  env.onChildEnd?.(root, childId)
  return outcome
}

function outcomeOf(input: { state: RunState; text: string; error?: string; childId: string; usage: Usage; ignored: string[] }): SubagentOutcome {
  const { state, text, error, childId, usage } = input
  if (state === 'done') {
    const note = input.ignored.length ? `\n\n[aviso: ferramentas ignoradas por não existirem na lista do agente: ${input.ignored.join(', ')}]` : ''
    return { ok: true, text: `${text || '(subagente não produziu resposta final)'}${note}`, sessionId: childId, usage }
  }
  if (state === 'cancelled') return { ok: false, text: 'subagente cancelado', sessionId: childId, usage }
  const detail = error ? `subagente falhou: ${error}` : 'subagente falhou'
  return { ok: false, text: text ? `${detail}\n\nÚltima resposta parcial:\n${text}` : detail, sessionId: childId, usage }
}

/** The definition's prompt plus one line saying who called and how deep this agent sits. */
function childPrompt(def: AgentDefinition, caller: SubagentCaller, depth: number, maxDepth: number, canDelegate: boolean): string {
  const by = caller.agentName ? `o agente "${caller.agentName}"` : 'a sessão principal do usuário'
  const delegation = !canDelegate ? '' : depth >= maxDepth ? ' Você está no nível máximo: não há mais delegação possível.' : ' Você pode delegar a outros agentes (ferramenta agent).'
  return `${def.systemPrompt}\n\nVocê foi chamado como agente "${def.name}" por ${by}, no nível ${depth} de ${maxDepth}. Quem chamou só lê a sua resposta final: devolva um relatório curto e factual.${delegation}`
}
