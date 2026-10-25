import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  HarnessEvent,
  HarnessLimits,
  ImagePart,
  Message,
  PlanItem,
  PolicyConfig,
  Provider,
  ProviderConfig,
  RunState,
  StopReason,
  ToolCall,
  ToolResult,
  Usage
} from '../../shared/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { AgentCatalog, AiMemoryToolService, CreateAgentInput, SubagentOutcome, SubagentSpec, ToolContext } from '../tools/types.js'
import type { FileTracker } from '../session/tracker.js'
import { WorkspaceGuard } from '../security/policy.js'
import type { BrowserLayer } from '../browser/layer.js'
import type { ComputerLayer } from '../computer/layer.js'
import type { SkillLibrary } from '../skills/library.js'
import type { MemoryFact, MemoryStore } from '../memory/store.js'
import type { ProjectMemory } from '../memory/project.js'
import type { HookOutcome, HookRunner } from '../hooks/runner.js'
import { claudeToolInput } from '../hooks/runner.js'
import { buildSystemPrompt, loadProjectInstructions } from './context.js'
import { compactIfNeeded, estimateContextTokens } from './compaction.js'
import { evaluateTool, toolsForMode } from '../security/permissions.js'
import { scanForInjection } from '../security/policy.js'
import { errorKindOf, isRetryableKind } from '../providers/http.js'
import { id, sleep, truncate, truncateMiddle } from '../util/ids.js'
import type { ProviderBlocks, ProviderErrorKind, ReasoningEffort, SessionSurface, ToolSpec } from '../../shared/types.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { SubagentCaller } from '../agents/types.js'
import { DEFAULT_MAX_AGENT_DEPTH } from '../agents/limits.js'

const TOOL_TIMEOUT_MS = 10 * 60 * 1000
/** Inline budget for one tool result; longer output is written to a file instead. */
const MAX_RESULT_CHARS = 60_000
/** What the model still sees of a spilled output: a head and a tail, never the whole thing. */
const SPILL_HEAD_CHARS = 10_000
const SPILL_TAIL_CHARS = 4_000
/** Mirrors the size cap in tools/fs.ts: read_file refuses bigger files, so the hint must not promise it. */
const READ_FILE_MAX_BYTES = 512 * 1024
/** Size cap for the summary handed to PostCompact hooks. */
const COMPACT_SUMMARY_HOOK_CHARS = 20_000
/** Modes that may use MCP server tools (read-only modes never do: every MCP tool is at least `exec` risk). */
const MCP_MODES = new Set<string>(['ask', 'code', 'debug', 'autonomous', 'web', 'computer'])
/** Delegation tools: offered only when this runner has someone to delegate to. */
const AGENT_TOOLS = new Set<string>(['agent', 'list_agents'])
/** Automatic "continue" requests after the model hits its output cap. */
const MAX_LENGTH_CONTINUATIONS = 2
/** Stream-level retries per turn (HTTP-level retries happen in postStream). */
const MAX_STREAM_RETRIES = 2
/** Times a Stop hook may send the agent back to work in one turn. */
const MAX_STOP_HOOK_LOOPS = 3
/** How many models one turn may switch to before giving up. */
const MAX_MODEL_FALLBACKS = 8

function isFallbackKind(kind: ProviderErrorKind | undefined): boolean {
  return (
    kind === 'quota' ||
    kind === 'rate_limit' ||
    kind === 'overloaded' ||
    kind === 'auth' ||
    kind === 'bad_request' ||
    kind === 'server' ||
    kind === 'network' ||
    kind === 'timeout'
  )
}

/**
 * A crash or a forced quit can leave a tool_call without its tool_result. On
 * resume, providers reject that shape and the UI can keep a spinner forever.
 * Insert an explicit "interrupted" result for every missing call.
 */
export function repairOrphanToolCalls(messages: Message[]): { messages: Message[]; repaired: number } {
  const results = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_result') results.add(part.toolCallId)
    }
  }
  let repaired = 0
  const out: Message[] = []
  for (const message of messages) {
    out.push(message)
    if (message.role !== 'assistant') continue
    const missing = message.parts.filter(
      (part): part is Extract<Message['parts'][number], { type: 'tool_call' }> =>
        part.type === 'tool_call' && !results.has(part.id)
    )
    if (!missing.length) continue
    for (const call of missing) results.add(call.id)
    repaired += missing.length
    out.push({
      id: `msg_repair_${message.id}`,
      role: 'tool',
      ts: Date.now(),
      parts: missing.map((call) => ({
        type: 'tool_result' as const,
        toolCallId: call.id,
        name: call.name,
        ok: false,
        text: 'Ação interrompida: o aplicativo foi encerrado antes de a ferramenta concluir. O estado do computador é desconhecido; verifique antes de repetir.'
      }))
    })
  }
  return { messages: out, repaired }
}

const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024
const TARGET_INLINE_IMAGE_BYTES = 15 * 1024 * 1024

/**
 * Screen captures accumulate fast. Before a request, keep the newest images up
 * to a 15 MB target (trimming only after a 25 MB trigger) and replace the older
 * ones with an explicit note, so the model never claims to have seen them.
 */
export function trimInlineImages(
  messages: Message[],
  triggerBytes = MAX_INLINE_IMAGE_BYTES,
  targetBytes = TARGET_INLINE_IMAGE_BYTES
): Message[] {
  const bytesOf = (data: string): number => Math.ceil((data.length * 3) / 4)
  let total = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'image') total += bytesOf(part.data)
      if (part.type === 'tool_result' && part.images) {
        for (const image of part.images) total += bytesOf(image.data)
      }
    }
  }
  if (total <= triggerBytes) return messages

  const out = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => ({ ...part })) as Message['parts']
  }))
  for (let m = 0; m < out.length && total > targetBytes; m++) {
    const parts = out[m].parts
    for (let p = 0; p < parts.length && total > targetBytes; p++) {
      const part = parts[p]
      if (part.type === 'image') {
        total -= bytesOf(part.data)
        parts[p] = {
          type: 'text',
          text: '[captura de tela antiga removida para poupar contexto; não afirme nada sobre ela]'
        }
      } else if (part.type === 'tool_result' && part.images?.length) {
        const removed = part.images.length
        for (const image of part.images) total -= bytesOf(image.data)
        part.images = undefined
        part.text = `${part.text ?? ''}\n[${removed} imagem(ns) antiga(s) removida(s) para poupar contexto; não afirme nada sobre elas]`.trim()
      }
    }
  }
  return out
}

const CONTINUE_PROMPT =
  'Sua resposta anterior foi cortada pelo limite de saída. Continue exatamente de onde parou, sem repetir o que já escreveu.'
const FINAL_STEP_PROMPT =
  'Você atingiu o limite de iterações deste turno. Não chame mais ferramentas. Responda agora com um resumo: o que foi feito, o que foi verificado, o que falta e o próximo passo.'

export interface ProjectMeta {
  name: string
  branch?: string
  isGitRepo: boolean
}

export interface RunnerDeps {
  sessionId: string
  /** Reasoning depth for this session; providers map it to their API. */
  effort?: ReasoningEffort
  cwd: string
  mode: AgentMode
  provider: Provider
  providerConfig: ProviderConfig
  /** Execution environment selected for this session. Missing means local. */
  environment?: import('../../shared/types.js').EnvironmentProfile
  registry: ToolRegistry
  policy: PolicyConfig
  limits: HarnessLimits
  tracker: FileTracker
  workspace: WorkspaceGuard
  /** Hard allowlist of tool names (used by subagents). */
  allowedTools?: string[]
  services: {
    browser: BrowserLayer
    computer: ComputerLayer
    skills: SkillLibrary
    memory: MemoryStore
    projectMemory: ProjectMemory
    /** Self-installation of MCP servers; absent in isolated harness tests. */
    mcp?: import('../tools/types.js').McpToolService
    /** Project long-term index (AI-Memory); absent in isolated harness tests. */
    aiMemory?: AiMemoryToolService
  }
  project: ProjectMeta
  /** Id of the owning project, used as the AI-Memory scope. */
  projectId?: string
  /** Lifecycle hooks (Claude Code settings format). */
  hooks?: HookRunner
  emit: (event: HarnessEvent) => void
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision | boolean>
  /** Starts a subagent for the `agent` / `task` tools; `caller` describes this runner (see agents/runtime.ts). */
  runSubagent?: (spec: SubagentSpec, caller: SubagentCaller) => Promise<SubagentOutcome>
  /** Agent definitions this runner may delegate to. Without it the `agent` and `list_agents` tools are not offered. */
  agents?: AgentRegistry
  /** Writes a new specialist agent and registers it in `agents` immediately. */
  createAgent?: (input: CreateAgentInput) => Promise<{ path: string; agent: import('../../shared/types.js').AgentDefinition }>
  /** Team mode: the system prompt tells the model to split work across agents (also on at max effort). */
  autoAgents?: boolean
  /** UI surface; Cowork and Chat get their own operating guidance. */
  surface?: SessionSurface
  /** Ordered alternatives to switch to when the active model is exhausted or unavailable. */
  fallback?: Array<{ provider: Provider; config: ProviderConfig }>
  persist?: (state: RunnerSnapshot) => void
  systemExtra?: string
  initial?: { messages?: Message[]; plan?: PlanItem[]; usage?: Usage }
  /** Set by the parent when this runner is a subagent. */
  depth?: number
  /** Definition this runner runs as; undefined for the user's own session. */
  agentName?: string
  /** Agent names from the first child down to this runner (empty for the user's session). */
  agentChain?: string[]
  /** The user's session that owns this tree; events and approvals are reported under it. Defaults to `sessionId`. */
  rootSessionId?: string
  /** Aborting this signal aborts every turn of this runner (set for subagents, so cancelling the user's turn stops the whole tree). */
  parentSignal?: AbortSignal
  /** Base delay before re-requesting after a transient stream failure. */
  retryBaseMs?: number
  /**
   * Base directory for spilled tool output (one sub-folder per session).
   * Defaults to <os tmpdir>/forja-tool-output.
   */
  toolOutputDir?: string
}

export interface RunnerSnapshot {
  messages: Message[]
  plan: PlanItem[]
  usage: Usage
  state: RunState
}

export interface SendOptions {
  images?: ImagePart[]
  hidden?: boolean
}

function addUsage(total: Usage, delta: Usage, config: ProviderConfig): Usage {
  const input = total.input + (delta.input ?? 0)
  const output = total.output + (delta.output ?? 0)
  const cachedInput = (total.cachedInput ?? 0) + (delta.cachedInput ?? 0)
  const cost =
    (config.inputCostPerMTok ? (input / 1_000_000) * config.inputCostPerMTok : 0) +
    (config.outputCostPerMTok ? (output / 1_000_000) * config.outputCostPerMTok : 0)
  return {
    input,
    output,
    cachedInput: cachedInput || undefined,
    costUsd: cost || total.costUsd
  }
}

/** Ids come from the model; keep only characters that are safe in a file name. */
function safeFileName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '').slice(0, 80)
  return cleaned || fallback
}

/** Writes `text` to `<dir>/<base>.txt`, or `<base>-<n>.txt` when a call id repeats within a session. */
async function writeSpillFile(dir: string, base: string, text: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const file = path.join(dir, n === 0 ? `${base}.txt` : `${base}-${n}.txt`)
    try {
      await fs.promises.writeFile(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('não foi possível escolher um nome de arquivo livre')
}

/** Head of `text`, ending at a line break when one is close to the limit. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text
  const newline = text.lastIndexOf('\n', max)
  return text.slice(0, newline > max * 0.7 ? newline : max)
}

/** Tail of `text`, starting after a line break when one is close to the limit. */
function tailOf(text: string, max: number): string {
  if (text.length <= max) return text
  let start = text.length - max
  const newline = text.indexOf('\n', start)
  if (newline !== -1 && newline - start < max * 0.3) start = newline + 1
  return text.slice(start)
}

/** The inline replacement for an oversized tool output: where the full text lives plus a head and tail preview. */
function spillNotice(args: { tool: string; file: string; text: string; readable: boolean; canRunCommand: boolean }): string {
  const { tool, file, text, readable, canRunCommand } = args
  const head = headOf(text, SPILL_HEAD_CHARS)
  const tail = tailOf(text, SPILL_TAIL_CHARS)
  const omitted = Math.max(0, text.length - head.length - tail.length)
  const lineCount = text.split('\n').length
  const nextLine = head.split('\n').length + 1
  let how: string
  if (readable) {
    how = `Para ver o trecho que falta, chame read_file com path="${file}" e offset/limit (por exemplo offset=${nextLine}, limit=200), ou use grep nesse arquivo.`
  } else if (canRunCommand) {
    const slice =
      process.platform === 'win32'
        ? `powershell -NoProfile -Command "Get-Content -LiteralPath '${file}' -TotalCount 200"`
        : `sed -n '${nextLine},${nextLine + 199}p' '${file}'`
    how = `O arquivo é grande demais para o read_file. Leia trechos com run_command (por exemplo: ${slice}) ou pesquise com grep.`
  } else {
    how = 'O arquivo é grande demais para o read_file; pesquise nele com grep.'
  }
  return [
    `[Saída de ${tool} grande demais para o contexto (${text.length} caracteres, ${lineCount} linhas). A saída completa foi salva em arquivo.]`,
    `Arquivo: ${file}`,
    how,
    '',
    `--- INÍCIO (primeiros ${head.length} caracteres) ---`,
    head,
    `--- ${omitted} caracteres omitidos ---`,
    `--- FIM (últimos ${tail.length} caracteres) ---`,
    tail
  ].join('\n')
}

export class SessionRunner {
  messages: Message[]
  plan: PlanItem[]
  usage: Usage
  state: RunState = 'idle'
  busy = false
  private controller: AbortController | null = null
  private readonly deps: RunnerDeps
  /** Active provider/config; a fallback may replace them between iterations. */
  private provider: Provider
  private providerConfig: ProviderConfig
  private fallback: Array<{ provider: Provider; config: ProviderConfig }>
  private lastToolSignature = ''
  private repeatedCalls = 0
  private toolCallCount = 0
  private startedAt = 0
  private memoryFacts: MemoryFact[] = []
  /** Bounded wiki briefing from the project memory (pages + open handoffs). */
  private projectMemoryBrief = ''
  /** Bounded recall from the project's AI-Memory index (recent + matches). */
  private aiMemoryBrief = ''
  private sessionStartContext: string[] | null = null
  /** Directories holding spilled tool output; read-only tools may open files there. */
  private readonly spillRoots: string[] = []

  constructor(deps: RunnerDeps) {
    this.deps = deps
    this.provider = deps.provider
    this.providerConfig = deps.providerConfig
    this.fallback = [...(deps.fallback ?? [])]
    this.messages = deps.initial?.messages
      ? repairOrphanToolCalls(deps.initial.messages).messages
      : []
    this.plan = deps.initial?.plan ? [...deps.initial.plan] : []
    this.usage = deps.initial?.usage ?? { input: 0, output: 0 }
  }

  get sessionId(): string {
    return this.deps.sessionId
  }

  snapshot(): RunnerSnapshot {
    return {
      messages: this.messages,
      plan: this.plan,
      usage: this.usage,
      state: this.state
    }
  }

  private persist(): void {
    this.deps.persist?.(this.snapshot())
  }

  private setState(state: RunState, detail?: string): void {
    this.state = state
    this.deps.emit({ type: 'status', sessionId: this.deps.sessionId, state, detail })
  }

  private emit(event: HarnessEvent): void {
    this.deps.emit(event)
  }

  abort(): void {
    this.controller?.abort()
  }

  /**
   * Injects a user instruction into the turn that is already running. The
   * model sees it on the next iteration, without losing the work in progress.
   */
  steer(text: string): boolean {
    if (!this.busy || !text.trim()) return false
    this.addMessage({
      id: id('msg'),
      role: 'user',
      ts: Date.now(),
      parts: [{ type: 'text', text: `[instrução do usuário durante o turno]\n${text.trim()}` }]
    })
    this.emit({
      type: 'audit',
      sessionId: this.deps.sessionId,
      level: 'info',
      message: 'instrução injetada no turno em execução'
    })
    return true
  }

  /** Manual compaction triggered from the context panel. */
  async compactNow(): Promise<boolean> {
    if (this.busy) throw new Error('aguarde o turno atual terminar para compactar')
    await this.runHook('PreCompact', { trigger: 'manual' })
    const result = await compactIfNeeded({
      system: this.buildSystem(),
      messages: this.messages,
      provider: this.provider,
      contextWindow: this.providerConfig.contextWindow,
      keepRecent: 4,
      force: true,
      onNote: (note) =>
        this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'info', text: note })
    })
    if (!result.compacted) {
      this.emit({
        type: 'notice',
        sessionId: this.deps.sessionId,
        level: 'info',
        text: 'Contexto curto demais para compactar.'
      })
      return false
    }
    const before = this.messages.length
    this.messages = result.messages
    this.persist()
    await this.afterCompaction('manual', before)
    return true
  }

  /** PostCompact hooks run once the shorter history is in place and saved. */
  private async afterCompaction(trigger: 'manual' | 'auto' | 'overflow', before: number, signal?: AbortSignal): Promise<void> {
    const first = this.messages[0]?.parts[0]
    await this.runHook(
      'PostCompact',
      {
        trigger,
        compact_summary: first?.type === 'text' ? truncate(first.text, COMPACT_SUMMARY_HOOK_CHARS) : '',
        messages_before: before,
        messages_after: this.messages.length
      },
      undefined,
      signal
    )
  }

  private addMessage(message: Message): void {
    this.messages.push(message)
    this.emit({ type: 'message', sessionId: this.deps.sessionId, message })
    this.persist()
  }

  private availableTools(): string[] {
    const allowed = [...toolsForMode(this.deps.mode)]
    // MCP tools are registered per server at runtime, so no static mode list can name them.
    // Read-only modes never get them: every MCP tool is at least `exec` risk.
    if (MCP_MODES.has(this.deps.mode)) {
      for (const name of this.deps.registry.names()) if (name.startsWith('mcp__')) allowed.push(name)
    }
    const hard = this.deps.allowedTools ? new Set(this.deps.allowedTools) : null
    return allowed.filter((name) => {
      if (hard && !hard.has(name)) return false
      const tool = this.deps.registry.get(name)
      if (!tool) return false
      if (tool.requires === 'network' && !this.deps.policy.allowNetwork) return false
      if (AGENT_TOOLS.has(name) && !this.canDelegate()) return false
      return true
    })
  }

  /** `agent` / `list_agents` make sense only when a registry exists and names at least one agent this runner may call. */
  private canDelegate(): boolean {
    return Boolean(this.deps.runSubagent && this.deps.agents?.callableBy(this.deps.agentName).length)
  }

  private agentCatalog(): AgentCatalog {
    const registry = this.deps.agents
    const caller = this.deps.agentName
    return {
      depth: this.deps.depth ?? 0,
      maxDepth: this.deps.limits.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      callable: () => (registry ? registry.callableBy(caller) : []),
      get: (name) => registry?.get(name)
    }
  }

  /** Tool specs for the model; a tool may word its description after the session (the `agent` tool lists who can be called). */
  private toolSpecs(names: string[]): ToolSpec[] {
    const agents = this.agentCatalog()
    return this.deps.registry.specs(names).map((spec) => {
      const dynamic = this.deps.registry.get(spec.name)?.dynamicDescription?.({ agents })
      return dynamic ? { ...spec, description: dynamic } : spec
    })
  }

  private linkParentSignal(controller: AbortController): () => void {
    const parent = this.deps.parentSignal
    if (!parent) return () => undefined
    if (parent.aborted) {
      controller.abort()
      return () => undefined
    }
    const onAbort = (): void => controller.abort()
    parent.addEventListener('abort', onAbort, { once: true })
    return () => parent.removeEventListener('abort', onAbort)
  }

  /** What the agent runtime needs to know about this runner when it makes a call. */
  private callerInfo(signal: AbortSignal): SubagentCaller {
    const deps = this.deps
    return {
      sessionId: deps.sessionId,
      rootSessionId: deps.rootSessionId ?? deps.sessionId,
      depth: deps.depth ?? 0,
      agentName: deps.agentName,
      chain: deps.agentChain ?? [],
      cwd: deps.cwd,
      mode: deps.mode,
      policy: deps.policy,
      providerConfig: this.providerConfig,
      effort: deps.effort,
      limits: deps.limits,
      availableTools: this.availableTools(),
      signal,
      hooks: deps.hooks,
      workspace: deps.workspace,
      tracker: deps.tracker,
      project: { ...deps.project, name: deps.project.name },
      projectId: deps.projectId,
      environment: deps.environment,
      services: deps.services,
      autoAgents: deps.autoAgents,
      createAgent: deps.createAgent
    }
  }

  private buildSystem(): string {
    const extra = [this.deps.systemExtra, ...(this.sessionStartContext ?? [])].filter(Boolean).join('\n\n')
    return buildSystemPrompt({
      mode: this.deps.mode,
      cwd: this.deps.cwd,
      policy: this.deps.policy,
      model: this.providerConfig.model,
      provider: this.providerConfig.label,
      surface: this.deps.surface,
      skills: this.deps.services.skills.list().map((s) => ({ name: s.name, description: s.description })),
      memory: this.memoryFacts,
      projectMemory: this.projectMemoryBrief,
      longTermMemory: this.aiMemoryBrief,
      agentsMd: loadProjectInstructions(this.deps.cwd),
      projectName: this.deps.project.name,
      gitBranch: this.deps.project.branch,
      isGitRepo: this.deps.project.isGitRepo,
      teamMode: this.deps.effort === 'max' || Boolean(this.deps.autoAgents),
      environment: this.deps.environment ? `${this.deps.environment.label} (${this.deps.environment.kind})` : undefined,
      extra: extra || undefined
    })
  }

  private async refreshMemory(query = ''): Promise<void> {
    try {
      this.memoryFacts = await this.deps.services.memory.all()
    } catch {
      this.memoryFacts = []
    }
    try {
      this.projectMemoryBrief = (await this.deps.services.projectMemory.brief()).text
    } catch {
      this.projectMemoryBrief = '(memória do projeto indisponível nesta sessão)'
    }
    try {
      const projectId = this.deps.projectId
      this.aiMemoryBrief =
        projectId && this.deps.services.aiMemory
          ? (await this.deps.services.aiMemory.recall(projectId, query, 8)).text
          : ''
    } catch {
      this.aiMemoryBrief = ''
    }
  }

  private reportHook(event: string, outcome: HookOutcome): void {
    for (const warning of outcome.warnings) {
      this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', text: warning })
    }
    if (outcome.results.length) {
      this.emit({
        type: 'audit',
        sessionId: this.deps.sessionId,
        level: outcome.blocked ? 'blocked' : 'info',
        message: `hook ${event}: ${outcome.results.length} hook(s)${outcome.blocked ? ` — bloqueou: ${outcome.reason ?? ''}` : ''}`
      })
    }
  }

  private async runHook(
    event: Parameters<HookRunner['run']>[0],
    payload: Record<string, unknown>,
    toolName?: string,
    signal?: AbortSignal
  ): Promise<HookOutcome | null> {
    // Explicit opt-in: unrestricted sessions run tools without local vetoes.
    // Notification-only hooks still run and can enrich the agent's context.
    if (this.deps.policy.mode === 'unrestricted' && (event === 'PreToolUse' || event === 'UserPromptSubmit')) return null
    const hooks = this.deps.hooks
    if (!hooks || !hooks.has(event, toolName)) return null
    const outcome = await hooks.run(event, payload, toolName, signal)
    this.reportHook(event, outcome)
    return outcome
  }

  private hiddenUserMessage(text: string): void {
    this.messages.push({ id: id('msg'), role: 'user', ts: Date.now(), hidden: true, parts: [{ type: 'text', text }] })
    this.persist()
  }

  /** The session's workspace, widened to the spill folders once something was spilled so read_file can open them. */
  private toolWorkspace(): WorkspaceGuard {
    if (this.deps.workspace.unrestricted) {
      return new WorkspaceGuard([...this.deps.workspace.rootList, ...this.spillRoots], true)
    }
    if (!this.spillRoots.length) return this.deps.workspace
    return new WorkspaceGuard([...this.deps.workspace.rootList, ...this.spillRoots])
  }

  /**
   * Builds the tool_result part. Output beyond MAX_RESULT_CHARS is written to
   * a file and replaced by a head/tail preview plus its path; if the file
   * cannot be written the old middle-out truncation applies. read_file output
   * is only truncated: spilling it would just copy a file the model can
   * already read in smaller slices.
   */
  private async toolResultPart(call: ToolCall, result: ToolResult): Promise<Message['parts'][number]> {
    const raw = result.text ?? ''
    let text = raw
    if (raw.length > MAX_RESULT_CHARS) {
      const notice = call.name === 'read_file' ? null : await this.spillOutput(call, raw)
      text = notice ?? truncateMiddle(raw, MAX_RESULT_CHARS)
    }
    return {
      type: 'tool_result',
      toolCallId: call.id,
      name: call.name,
      ok: result.ok,
      text,
      images: result.images,
      detail: result.summary
    }
  }

  private async spillOutput(call: ToolCall, text: string): Promise<string | null> {
    try {
      const base = path.resolve(this.deps.toolOutputDir ?? path.join(os.tmpdir(), 'forja-tool-output'))
      const dir = path.join(base, safeFileName(this.deps.sessionId, 'session'))
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
      const file = await writeSpillFile(dir, safeFileName(call.id, 'call'), text)
      if (!this.spillRoots.includes(dir)) this.spillRoots.push(dir)
      this.emit({
        type: 'audit',
        sessionId: this.deps.sessionId,
        level: 'info',
        message: `saída de ${call.name} (${text.length} caracteres) salva em ${file}`
      })
      return spillNotice({
        tool: call.name,
        file,
        text,
        readable: Buffer.byteLength(text, 'utf8') <= READ_FILE_MAX_BYTES,
        canRunCommand: this.availableTools().includes('run_command')
      })
    } catch {
      return null
    }
  }

  private makeContext(signal: AbortSignal): ToolContext {
    const deps = this.deps
    return {
      sessionId: deps.sessionId,
      cwd: deps.cwd,
      mode: deps.mode,
      policy: deps.policy,
      workspace: this.toolWorkspace(),
      signal,
      tracker: deps.tracker,
      environment: deps.environment,
      services: deps.services,
      projectId: deps.projectId,
      emit: (event) => this.emit(event),
      approve: async (request) => {
        const decision = await deps.approve({ ...request, id: id('appr'), sessionId: deps.sessionId })
        return typeof decision === 'boolean' ? decision : decision.approved
      },
      setPlan: (items) => {
        this.plan = items
        this.emit({ type: 'plan', sessionId: deps.sessionId, items })
        this.persist()
      },
      runSubagent: async (spec) => {
        if (!deps.runSubagent) return { ok: false, text: 'subagentes indisponíveis nesta sessão', sessionId: '' }
        return deps.runSubagent(spec, this.callerInfo(signal))
      },
      agents: this.agentCatalog(),
      createAgent: async (input) => {
        if (!deps.createAgent) throw new Error('criação de agentes indisponível nesta sessão')
        return deps.createAgent(input)
      },
      log: (level, message) =>
        this.emit({
          type: 'audit',
          sessionId: deps.sessionId,
          level: level === 'error' ? 'warn' : level,
          message
        })
    }
  }

  async send(text: string, options: SendOptions = {}): Promise<void> {
    if (this.busy) throw new Error('já existe um turno em execução nesta sessão')
    this.busy = true
    this.toolCallCount = 0
    this.repeatedCalls = 0
    this.startedAt = Date.now()
    this.controller = new AbortController()
    const signal = this.controller.signal
    const unlinkParent = this.linkParentSignal(this.controller)

    const userMessage: Message = {
      id: id('msg'),
      role: 'user',
      ts: Date.now(),
      hidden: options.hidden,
      parts: [
        { type: 'text', text },
        ...(options.images ?? [])
      ]
    }
    this.addMessage(userMessage)
    this.setState('thinking')
    this.emit({ type: 'turn_start', sessionId: this.deps.sessionId, messageId: userMessage.id })

    const turnId = userMessage.id
    let stopReason: StopReason = 'stop'
    let errorMessage: string | undefined
    let lengthContinuations = 0
    let streamRetries = 0
    let stopHookLoops = 0
    let overflowCompactions = 0
    let fallbacksUsed = 0

    try {
      await this.refreshMemory(text)

      if (this.sessionStartContext === null) {
        const started = await this.runHook('SessionStart', { source: this.messages.length > 1 ? 'resume' : 'startup' })
        this.sessionStartContext = started?.additionalContext ?? []
      }

      const prompt = await this.runHook('UserPromptSubmit', { prompt: text }, undefined, signal)
      if (prompt?.blocked || prompt?.stop) {
        stopReason = 'error'
        errorMessage = `mensagem bloqueada por hook: ${prompt.reason ?? prompt.stop}`
        this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', text: errorMessage })
        this.setState('error', errorMessage)
        return
      }
      if (prompt?.additionalContext.length) {
        this.hiddenUserMessage(`<hook-context event="UserPromptSubmit">\n${prompt.additionalContext.join('\n\n')}\n</hook-context>`)
      }

      for (let iteration = 1; iteration <= this.deps.limits.maxIterations; iteration++) {
        if (signal.aborted) {
          stopReason = 'error'
          errorMessage = 'turno cancelado pelo usuário'
          this.setState('cancelled', errorMessage)
          break
        }

        const limitError = this.checkLimits()
        if (limitError) {
          stopReason = 'error'
          errorMessage = limitError
          this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'error', text: limitError })
          this.setState('error', limitError)
          break
        }

        // The last iteration keeps the tool list (cache-friendly) but forbids
        // calls, so the turn ends with a summary instead of a bare error.
        const finalStep = iteration === this.deps.limits.maxIterations
        if (finalStep) this.hiddenUserMessage(FINAL_STEP_PROMPT)

        let system = this.buildSystem()
        const compacted = await this.compact(system, signal, false)
        if (compacted) system = this.buildSystem()

        const assistantId = id('msg')
        const toolNames = this.availableTools()
        const requestMessages = trimInlineImages(this.messages)
        const contextUsed = estimateContextTokens(system, requestMessages)
        const requestedOutput = this.providerConfig.maxOutputTokens ?? 32_000
        const outputRoom = this.providerConfig.contextWindow - contextUsed - Math.ceil(contextUsed * 0.15)
        const maxTokens = Math.max(1_024, Math.min(requestedOutput, outputRoom))
        const request = {
          system,
          messages: requestMessages,
          tools: this.toolSpecs(toolNames),
          toolChoice: finalStep ? ('none' as const) : undefined,
          effort: this.deps.effort,
          maxTokens,
          signal
        }

        this.setState('streaming')
        let textBuffer = ''
        let reasoningBuffer = ''
        const toolCalls: ToolCall[] = []
        let providerError: string | undefined
        let errorKind: ProviderErrorKind | undefined
        let usageDelta: Usage | null = null
        let providerBlocks: ProviderBlocks | undefined
        let iterationStop: StopReason = 'stop'

        try {
          for await (const event of this.provider.stream(request)) {
            switch (event.type) {
              case 'text_delta':
                textBuffer += event.text
                this.emit({
                  type: 'text_delta',
                  sessionId: this.deps.sessionId,
                  messageId: assistantId,
                  text: event.text
                })
                break
              case 'reasoning_delta':
                reasoningBuffer += event.text
                this.emit({
                  type: 'reasoning_delta',
                  sessionId: this.deps.sessionId,
                  messageId: assistantId,
                  text: event.text
                })
                break
              case 'tool_call_start':
                // The `tool_start` event is emitted once, with arguments, right
                // before execution. Emitting here too duplicated every card in
                // the UI and every tool in the activity panel.
                break
              case 'provider_blocks':
                providerBlocks = { kind: event.kind, model: event.model, blocks: event.blocks }
                break
              case 'usage':
                usageDelta = event.usage
                break
              case 'end':
                toolCalls.push(...event.toolCalls)
                if (event.stopReason === 'error') {
                  providerError = event.error ?? 'erro do provedor'
                  errorKind = event.errorKind ?? (event.retryable ? 'server' : 'unknown')
                }
                iterationStop = event.stopReason
                break
              default:
                break
            }
          }
        } catch (err) {
          if (signal.aborted) {
            stopReason = 'error'
            errorMessage = 'turno cancelado pelo usuário'
            this.setState('cancelled', errorMessage)
            break
          }
          providerError = (err as Error).message
          errorKind = errorKindOf(err)
          iterationStop = 'error'
        }

        if (usageDelta) {
          this.usage = addUsage(this.usage, usageDelta, this.providerConfig)
          this.emit({ type: 'usage', sessionId: this.deps.sessionId, usage: usageDelta, total: this.usage })
        }

        if (providerError) {
          const nothingEmitted = !textBuffer && !toolCalls.length
          if (errorKind === 'context_overflow' && overflowCompactions < 1) {
            overflowCompactions++
            this.emit({
              type: 'notice',
              sessionId: this.deps.sessionId,
              level: 'warn',
              text: 'A conversa passou da janela de contexto do modelo; compactando e tentando de novo.'
            })
            if (await this.compact(system, signal, true)) {
              iteration--
              continue
            }
          }
          if (nothingEmitted && errorKind && isRetryableKind(errorKind) && streamRetries < MAX_STREAM_RETRIES) {
            streamRetries++
            const delay = (this.deps.retryBaseMs ?? 2000) * streamRetries
            this.emit({
              type: 'notice',
              sessionId: this.deps.sessionId,
              level: 'warn',
              text: `Falha transitória do provedor (${errorKind}); nova tentativa em ${delay / 1000}s.`
            })
            await sleep(delay, signal).catch(() => undefined)
            iteration--
            continue
          }
          // Quota/rate limit/auth: switch to the next model and keep the same
          // conversation and project memory, instead of aborting the task.
          if (nothingEmitted && errorKind && isFallbackKind(errorKind) && this.fallback.length && fallbacksUsed < MAX_MODEL_FALLBACKS) {
            const next = this.fallback.shift() as { provider: Provider; config: ProviderConfig }
            const previous = `${this.providerConfig.label}/${this.providerConfig.model}`
            this.provider = next.provider
            this.providerConfig = next.config
            fallbacksUsed++
            this.emit({
              type: 'notice',
              sessionId: this.deps.sessionId,
              level: 'warn',
              text: `${previous} falhou (${errorKind}); continuando com ${next.config.label}/${next.config.model}. O contexto e a memória do projeto foram preservados.`
            })
            iteration--
            continue
          }
          this.messages.push({
            id: assistantId,
            role: 'assistant',
            ts: Date.now(),
            parts: [{ type: 'text', text: textBuffer }],
            error: providerError
          })
          this.persist()
          stopReason = 'error'
          errorMessage = providerError
          this.emit({
            type: 'notice',
            sessionId: this.deps.sessionId,
            level: 'error',
            text: `Falha do provedor${errorKind ? ` (${errorKind})` : ''}: ${providerError}`
          })
          this.setState('error', providerError)
          break
        }

        const assistantParts: Message['parts'] = []
        if (reasoningBuffer.trim()) assistantParts.push({ type: 'reasoning', text: reasoningBuffer })
        if (textBuffer.trim()) assistantParts.push({ type: 'text', text: textBuffer })
        for (const call of toolCalls) {
          assistantParts.push({ type: 'tool_call', id: call.id, name: call.name, args: call.args })
        }
        this.addMessage({
          id: assistantId,
          role: 'assistant',
          ts: Date.now(),
          parts: assistantParts,
          providerBlocks,
          model: this.providerConfig.model,
          usage: usageDelta ?? undefined
        })

        if (!toolCalls.length) {
          if (finalStep) {
            stopReason = 'length'
            errorMessage = `limite de ${this.deps.limits.maxIterations} iterações atingido; o agente resumiu o progresso`
            this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', text: errorMessage })
            break
          }
          if (iterationStop === 'length' && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
            lengthContinuations++
            this.hiddenUserMessage(CONTINUE_PROMPT)
            continue
          }
          const stopHook = await this.runHook(
            this.deps.depth ? 'SubagentStop' : 'Stop',
            { stop_hook_active: stopHookLoops > 0, last_assistant_message: textBuffer },
            undefined,
            signal
          )
          if (stopHook?.blocked && stopHookLoops < MAX_STOP_HOOK_LOOPS) {
            stopHookLoops++
            this.hiddenUserMessage(`<hook-feedback event="Stop">\n${stopHook.reason ?? 'continue o trabalho'}\n</hook-feedback>`)
            continue
          }
          stopReason = iterationStop === 'length' ? 'length' : 'stop'
          this.setState('done')
          break
        }

        this.setState('tool')
        const results = await this.executeToolCalls(toolCalls, signal)

        const resultParts: Message['parts'] = []
        for (const call of toolCalls) {
          const result = results.get(call.id) ?? {
            ok: false,
            text: 'ferramenta não executada'
          }
          const part = await this.toolResultPart(call, result)

          // Vision-less models still receive a textual description.
          if (part.type === 'tool_result' && part.images?.length) {
            if (!this.provider.supportsVision) {
              part.text += `\n[${part.images.length} imagem(ns) capturada(s) — o modelo atual não suporta visão]`
              part.images = undefined
            }
          }
          resultParts.push(part)

          const findings = scanForInjection(part.type === 'tool_result' ? part.text : '')
          if (findings.length) {
            this.emit({
              type: 'audit',
              sessionId: this.deps.sessionId,
              level: 'warn',
              message: `Possível prompt injection em ${call.name}: ${findings.map((f) => f.label).join(', ')}`
            })
          }
        }
        this.addMessage({ id: id('msg'), role: 'tool', ts: Date.now(), parts: resultParts })

        const changes = this.deps.tracker.changes()
        if (changes.length) this.emit({ type: 'diff', sessionId: this.deps.sessionId, files: changes })

        // Memory tools may have changed what the system prompt shows next turn.
        if (toolCalls.some((c) => c.name === 'memory_write' || c.name === 'memory_page' || c.name === 'memory_handoff')) {
          await this.refreshMemory()
        }
        stopReason = 'tool_use'
      }
      // Some local servers ignore tool_choice "none"; the loop then runs out
      // of iterations while still calling tools.
      if (stopReason === 'tool_use') {
        stopReason = 'length'
        errorMessage = `limite de ${this.deps.limits.maxIterations} iterações atingido`
        this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', text: errorMessage })
      }
    } catch (err) {
      stopReason = 'error'
      errorMessage = (err as Error).message
      this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'error', text: errorMessage })
      this.setState('error', errorMessage)
    } finally {
      unlinkParent()
      this.busy = false
      this.controller = null
      if (stopReason !== 'error') this.setState('done')
      this.emit({ type: 'turn_end', sessionId: this.deps.sessionId, messageId: turnId, stopReason, error: errorMessage })
      this.persist()
    }
  }

  /** Budget-driven (or forced, after a context overflow) compaction. */
  private async compact(system: string, signal: AbortSignal, force: boolean): Promise<boolean> {
    const run = (): ReturnType<typeof compactIfNeeded> =>
      compactIfNeeded({
        system,
        messages: this.messages,
        provider: this.provider,
        contextWindow: this.providerConfig.contextWindow,
        keepRecent: force ? 4 : undefined,
        force,
        signal,
        onNote: (note) => this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'info', text: note })
      })
    if (!force && estimateContextTokens(system, this.messages) < this.providerConfig.contextWindow * 0.75) return false
    const trigger = force ? 'overflow' : 'auto'
    await this.runHook('PreCompact', { trigger }, undefined, signal)
    const result = await run()
    if (!result.compacted) return false
    const before = this.messages.length
    this.messages = result.messages
    this.persist()
    await this.afterCompaction(trigger, before, signal)
    return true
  }

  private checkLimits(): string | null {
    const limits = this.deps.limits
    if (this.toolCallCount >= limits.maxToolCalls) {
      return `limite de ${limits.maxToolCalls} chamadas de ferramenta atingido`
    }
    if (Date.now() - this.startedAt > limits.maxWallClockMs) {
      return `limite de tempo (${Math.round(limits.maxWallClockMs / 60000)} min) atingido`
    }
    if (this.usage.input + this.usage.output > limits.maxTokens) {
      return `orçamento de tokens esgotado (${this.usage.input + this.usage.output})`
    }
    if (limits.maxCostUsd > 0 && (this.usage.costUsd ?? 0) > limits.maxCostUsd) {
      return `orçamento de custo esgotado (US$ ${(this.usage.costUsd ?? 0).toFixed(2)})`
    }
    return null
  }

  private async executeToolCalls(
    calls: ToolCall[],
    signal: AbortSignal
  ): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>()
    const ctx = this.makeContext(signal)
    const prepared: Array<{ call: ToolCall; tool: NonNullable<ReturnType<ToolRegistry['get']>> }> = []

    for (const call of calls) {
      this.toolCallCount++
      const signature = `${call.name}:${JSON.stringify(call.args)}`
      if (signature === this.lastToolSignature) this.repeatedCalls++
      else {
        this.lastToolSignature = signature
        this.repeatedCalls = 1
      }

      const tool = this.deps.registry.get(call.name)
      if (!tool) {
        const available = this.availableTools()
        results.set(call.id, {
          ok: false,
          text: `ferramenta desconhecida: ${call.name}. Disponíveis: ${available.join(', ')}`
        })
        this.emit({
          type: 'tool_end',
          sessionId: this.deps.sessionId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          summary: 'ferramenta desconhecida'
        })
        continue
      }

      if (!this.availableTools().includes(call.name)) {
        results.set(call.id, {
          ok: false,
          text: `a ferramenta ${call.name} não está disponível no modo ${this.deps.mode}`
        })
        this.emit({
          type: 'tool_end',
          sessionId: this.deps.sessionId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          summary: 'indisponível neste modo'
        })
        continue
      }

      if (this.repeatedCalls >= 3) {
        results.set(call.id, {
          ok: false,
          text: `chamada idêntica repetida ${this.repeatedCalls} vezes. Pare, verifique o estado atual com outra ferramenta e mude de abordagem.`
        })
        this.emit({
          type: 'tool_end',
          sessionId: this.deps.sessionId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          summary: 'repetição bloqueada'
        })
        continue
      }

      let parsed = parseToolArgs(tool, call.args)
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
          .join('; ')
        results.set(call.id, { ok: false, text: `argumentos inválidos: ${issues}` })
        this.emit({
          type: 'tool_end',
          sessionId: this.deps.sessionId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          summary: 'argumentos inválidos',
          text: issues
        })
        continue
      }
      // Tools receive the validated (and possibly repaired) arguments.
      call.args = parsed.data

      const pre = await this.runHook('PreToolUse', { tool_input: claudeToolInput(parsed.data) }, call.name, signal)
      if (pre?.blocked || pre?.permissionDecision === 'deny') {
        const reason = pre.reason ?? 'negado por hook'
        results.set(call.id, { ok: false, text: `bloqueado por hook PreToolUse: ${reason}` })
        this.emit({
          type: 'tool_end',
          sessionId: this.deps.sessionId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          summary: 'bloqueado por hook'
        })
        continue
      }
      if (pre?.updatedInput) {
        const merged = { ...(parsed.data as Record<string, unknown>), ...pre.updatedInput }
        delete (merged as Record<string, unknown>).file_path
        const reparsed = parseToolArgs(tool, merged)
        if (reparsed.success) {
          parsed = reparsed
          call.args = reparsed.data
        }
      }

      const args = parsed.data
      let description: { title: string; detail: string; preview?: string }
      try {
        description = tool.describe(args)
      } catch {
        description = { title: tool.name, detail: '' }
      }

      let evaluation = evaluateTool(tool, description.preview ?? description.detail, this.deps.policy, this.deps.cwd, args)
      // A hook may skip the confirmation (allow) or demand one (ask), but it
      // never overrides a deny from the policy (credential locations included).
      if (evaluation.decision !== 'deny' && pre?.permissionDecision === 'allow') {
        evaluation = { ...evaluation, decision: 'allow', reason: 'aprovado por hook PreToolUse' }
      } else if (evaluation.decision === 'allow' && pre?.permissionDecision === 'ask') {
        evaluation = { ...evaluation, decision: 'ask', reason: 'hook PreToolUse pediu confirmação' }
      }
      if (evaluation.decision === 'deny') {
        results.set(call.id, { ok: false, text: `ação negada pela política: ${evaluation.reason}` })
        this.emit({
          type: 'tool_end',
          sessionId: this.deps.sessionId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          summary: `negado: ${evaluation.reason}`
        })
        this.emit({
          type: 'audit',
          sessionId: this.deps.sessionId,
          level: 'blocked',
          message: `${call.name} negado — ${evaluation.reason}`
        })
        continue
      }

      if (evaluation.decision === 'ask') {
        this.setState('waiting_approval')
        const approval: ApprovalRequest = {
          id: id('appr'),
          sessionId: this.deps.sessionId,
          tool: call.name,
          title: description.title,
          detail: description.detail || JSON.stringify(args).slice(0, 800),
          risk: tool.risk,
          preview: description.preview,
          action: evaluation.action,
          resource: evaluation.resource,
          effect: evaluation.effect
        }
        const rawDecision = await this.deps.approve(approval)
        const decision = typeof rawDecision === 'boolean' ? { approved: rawDecision } : rawDecision
        if (!decision.approved) {
          const feedback = decision.reason?.trim()
          results.set(call.id, {
            ok: false,
            text: feedback
              ? `o usuário negou esta ação. Motivo informado: ${feedback}\nNão tente contornar; proponha uma alternativa que respeite o motivo.`
              : 'o usuário negou esta ação. Não tente contornar; proponha uma alternativa.'
          })
          this.emit({
            type: 'audit',
            sessionId: this.deps.sessionId,
            level: 'warn',
            message: `ação negada: ${call.name}${feedback ? ` — ${feedback}` : ''}`
          })
          this.emit({
            type: 'tool_end',
            sessionId: this.deps.sessionId,
            toolCallId: call.id,
            name: call.name,
            ok: false,
            summary: feedback ? `negado: ${feedback.slice(0, 120)}` : 'negado pelo usuário'
          })
          this.setState('tool')
          continue
        }
        this.setState('tool')
      }

      prepared.push({ call, tool })
    }

    const runOne = async (item: { call: ToolCall; tool: NonNullable<ReturnType<ToolRegistry['get']>> }) => {
      const started = Date.now()
      this.emit({
        type: 'tool_start',
        sessionId: this.deps.sessionId,
        toolCallId: item.call.id,
        name: item.call.name,
        args: item.call.args
      })
      let result: ToolResult
      try {
        result = await withTimeout(
          item.tool.execute(item.call.args, ctx),
          TOOL_TIMEOUT_MS,
          `ferramenta ${item.call.name} excedeu ${TOOL_TIMEOUT_MS / 1000}s`
        )
      } catch (err) {
        const message = (err as Error).message
        const injected = scanForInjection(message)
        result = { ok: false, text: `erro em ${item.call.name}: ${message}` }
        this.emit({
          type: 'audit',
          sessionId: this.deps.sessionId,
          level: injected.length ? 'warn' : 'info',
          message: `${item.call.name} falhou em ${Date.now() - started}ms: ${message.slice(0, 300)}`
        })
      }
      const post = await this.runHook(
        'PostToolUse',
        {
          tool_input: claudeToolInput(item.call.args),
          tool_response: { success: result.ok, output: truncateMiddle(result.text ?? '', 20_000) }
        },
        item.call.name,
        signal
      )
      if (post?.blocked || post?.additionalContext.length) {
        const feedback = [post.blocked ? post.reason : undefined, ...post.additionalContext].filter(Boolean).join('\n')
        result = { ...result, text: `${result.text}\n\n<hook-feedback event="PostToolUse">\n${feedback}\n</hook-feedback>` }
      }
      results.set(item.call.id, result)
      this.emit({
        type: 'tool_end',
        sessionId: this.deps.sessionId,
        toolCallId: item.call.id,
        name: item.call.name,
        ok: result.ok,
        summary: result.summary ?? (result.ok ? 'ok' : 'falhou'),
        text: truncateMiddle(result.text, 1500),
        files: result.files,
        data: result.data
      })
      return result
    }

    const allParallel = prepared.length > 1 && prepared.every((p) => p.tool.parallelSafe)
    if (allParallel) {
      const limit = Math.max(1, this.deps.limits.maxParallelTools)
      let cursor = 0
      const workers = Array.from({ length: Math.min(limit, prepared.length) }, async () => {
        while (cursor < prepared.length) {
          const item = prepared[cursor++]
          await runOne(item)
        }
      })
      await Promise.all(workers)
    } else {
      for (const item of prepared) await runOne(item)
    }

    return results
  }
}

type ParseResult = ReturnType<ToolDef['schema']['safeParse']>
type ToolDef = NonNullable<ReturnType<ToolRegistry['get']>>

function coerceValue(value: unknown, expected: string): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((expected === 'number' || expected === 'integer') && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
    if (expected === 'boolean' && /^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
    if ((expected === 'array' || expected === 'object') && /^[[{]/.test(trimmed)) {
      try {
        return JSON.parse(trimmed)
      } catch {
        return value
      }
    }
  }
  if (expected === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value)
  return value
}

/**
 * Validates tool arguments; when a model sends "5" for a number or "true" for
 * a boolean (common with local models), coerces the reported paths once and
 * validates again.
 */
export function parseToolArgs(tool: Pick<ToolDef, 'schema'>, raw: unknown): ParseResult {
  const first = tool.schema.safeParse(raw)
  if (first.success || !raw || typeof raw !== 'object') return first
  const copy = structuredClone(raw) as Record<string, unknown>
  let changed = false
  for (const issue of first.error.issues) {
    if (issue.code !== 'invalid_type' || !issue.path.length) continue
    let parent: any = copy
    for (const key of issue.path.slice(0, -1)) parent = parent?.[key as string]
    const last = issue.path[issue.path.length - 1] as string
    if (!parent || !(last in parent)) continue
    const next = coerceValue(parent[last], issue.expected)
    if (next !== parent[last]) {
      parent[last] = next
      changed = true
    }
  }
  return changed ? tool.schema.safeParse(copy) : first
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export { estimateContextTokens }
