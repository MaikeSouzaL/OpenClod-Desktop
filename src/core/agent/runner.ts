import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  BudgetInfo,
  ContextBreakdown,
  HarnessEvent,
  HarnessLimits,
  ImagePart,
  LimitationReport,
  Message,
  PlanItem,
  PolicyConfig,
  Provider,
  ProviderConfig,
  QuestionAnswer,
  QuestionRequest,
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
import type { TerminalRunner } from '../terminal/runner.js'
import type { SkillLibrary } from '../skills/library.js'
import type { MemoryFact, MemoryStore } from '../memory/store.js'
import type { ProjectMemory } from '../memory/project.js'
import type { HookOutcome, HookRunner } from '../hooks/runner.js'
import { claudeToolInput } from '../hooks/runner.js'
import { buildSystemPrompt, describeSkills, loadProjectInstructions } from './context.js'
import { composeTurnContext, createTurnContextState, hydrateTurnContext, isTurnContext, noteTurnPlan, resetTurnContext, type TurnContextState } from './turn-context.js'
import { buildPack } from '../memory/pack.js'
import { digestCapsule } from '../memory/state-page.js'
import { renderSuggestions, suggest, type Candidate } from './suggest.js'
import { mergePlanTimes } from './plan-times.js'
import { appendPlanActivity, planActivityEntry } from './plan-activity.js'
import { discardedPlanNotice, resumePlanAt } from './plan-control.js'
import { buildAutoLimitation } from './auto-limitation.js'
import { detectRepetition, MAX_REASONING_ONLY_CHARS, MAX_REASONING_ONLY_MS, type RepetitionHit } from './loop-detection.js'
import { addUsage, usageCost } from './usage.js'
import { billableTokens, effectiveMaxTokens } from '../../shared/limits.js'
import { compactIfNeeded, estimateContextTokens } from './compaction.js'
import { evaluateTool, toolsForMode } from '../security/permissions.js'
import { CORE_TOOL_NAMES, DEFERRED_ESSENTIAL_TOOL_NAMES, TEAM_CORE_TOOL_NAMES } from '../tools/lazy.js'
import { summarizeMcpTools } from '../mcp/tools.js'
import { scanForInjection } from '../security/policy.js'
import { errorKindOf, isRetryableKind } from '../providers/http.js'
import type { FallbackCandidate } from '../providers/chain.js'
import { describeFailure, isAccountLevelKind, type ProviderHealth } from '../providers/health.js'
import { accountKeyOf } from '../providers/order.js'
import { describeImage, inlineImageDescriptions, pendingImages, recordDescription, type DescribeCandidate } from '../vision/relay.js'
import { estimateTokens, id, sleep, truncate, truncateMiddle } from '../util/ids.js'
import type { ProviderBlocks, ProviderErrorKind, ReasoningEffort, SessionSurface, ToolSpec } from '../../shared/types.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { SubagentCaller } from '../agents/types.js'
import { DEFAULT_MAX_AGENT_DEPTH } from '../agents/limits.js'

const TOOL_TIMEOUT_MS = 10 * 60 * 1000
/** Inline budget for one tool result; longer output is written to a file instead. */
const MAX_RESULT_CHARS = 60_000
/** Non-read_file tools spill earlier: their output is re-sent every iteration. */
const MAX_TOOL_RESULT_CHARS = 16_000
/** What the model still sees of a spilled output: a head and a tail, never the whole thing. */
const SPILL_HEAD_CHARS = 10_000
const SPILL_TAIL_CHARS = 4_000
/** Mirrors the size cap in tools/fs.ts: read_file refuses bigger files, so the hint must not promise it. */
const READ_FILE_MAX_BYTES = 512 * 1024
/** Size cap for the summary handed to PostCompact hooks. */
const COMPACT_SUMMARY_HOOK_CHARS = 20_000
/** Each source of the per-turn context (wiki, index, facts) gets this long; past it that source adds nothing. */
const TURN_CONTEXT_STEP_MS = 2_500

/** A conversation longer than this, taken over by another model, is summarised before the first request. */
const MODEL_SWITCH_COMPACTION_TOKENS = 20_000

/** "há 12 min", "há 3 h", "há 2 dias": how long ago a continuity capsule was written. */
function ageLabel(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso || '')) / 60_000))
  if (!Number.isFinite(minutes)) return 'há tempos'
  if (minutes < 60) return `há ${Math.max(1, minutes)} min`
  if (minutes < 60 * 48) return `há ${Math.round(minutes / 60)} h`
  return `há ${Math.round(minutes / 1440)} dias`
}

/** Reason recorded when the user stops a turn; turn_end carries `cancelled` so it is not counted as a failure. */
/** Local servers (Ollama, LM Studio, llama.cpp) cost nothing per token, so a missing tariff is correct there. */
function isLocalProvider(config: ProviderConfig): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(config.baseUrl ?? '')
}

export const TURN_CANCELLED = 'turno cancelado pelo usuário'
/** Modes that may use MCP server tools (read-only modes never do: every MCP tool is at least `exec` risk). */
const MCP_MODES = new Set<string>(['ask', 'code', 'debug', 'autonomous', 'web', 'computer'])
/** Delegation tools: offered only when this runner has someone to delegate to. */
const AGENT_TOOLS = new Set<string>(['agent', 'list_agents'])
/** Automatic "continue" requests after the model hits its output cap. */
const TOOL_ALIASES: Record<string, string[]> = {
  mouse: ['computer_mouse_move', 'computer_mouse_button', 'computer_click', 'computer_cursor_position'],
  ponteiro: ['computer_mouse_move', 'computer_mouse_button', 'computer_click', 'computer_cursor_position'],
  cursor: ['computer_cursor_position', 'computer_mouse_move', 'computer_click'],
  tela: ['computer_screenshot', 'computer_snapshot'],
  screenshot: ['computer_screenshot', 'computer_snapshot'],
  captura: ['computer_screenshot', 'computer_snapshot'],
  janela: ['computer_list_windows', 'computer_wait_for_window', 'computer_activate', 'computer_snapshot'],
  window: ['computer_list_windows', 'computer_wait_for_window', 'computer_activate', 'computer_snapshot'],
  desktop: ['computer_screenshot', 'computer_open_path', 'computer_launch'],
  navegador: ['browser_'],
  browser: ['browser_'],
  abrir: ['computer_open_path', 'computer_launch', 'browser_open'],
  open: ['computer_open_path', 'computer_launch', 'browser_open'],
  teclado: ['computer_press_key', 'computer_type_text'],
  keyboard: ['computer_press_key', 'computer_type_text'],
  // The former essentials, found by the words a model uses for them ("catálogo de skills", "passagem de bastão"...).
  skill: ['list_skills'],
  skills: ['list_skills'],
  agente: ['list_agents'],
  agentes: ['list_agents'],
  agents: ['list_agents'],
  handoff: ['memory_handoff'],
  bastão: ['memory_handoff'],
  bastao: ['memory_handoff'],
  servidores: ['mcp_servers', 'mcp_reload'],
  servers: ['mcp_servers', 'mcp_reload'],
  briefing: ['memory_brief']
}

/** The former essentials a request names: by the words people use for them (TOOL_ALIASES) or by the tool's own name. */
function essentialsNamedBy(query: string): Set<string> {
  const wanted = query.toLowerCase()
  const named = new Set<string>()
  for (const [key, names] of Object.entries(TOOL_ALIASES)) {
    if (!wanted.includes(key)) continue
    for (const name of names) if (DEFERRED_ESSENTIAL_TOOL_NAMES.has(name)) named.add(name)
  }
  // By its own name too, except `task`: an ordinary English word in a request about code.
  for (const name of DEFERRED_ESSENTIAL_TOOL_NAMES) if (name.includes('_') && wanted.includes(name)) named.add(name)
  return named
}

const MAX_LENGTH_CONTINUATIONS = 2
/** Stream-level retries per turn (HTTP-level retries happen in postStream). */
const MAX_STREAM_RETRIES = 2
/** How much of the turn's diff the self-review shows the model; the rest it reads with git_diff/read_file. */
const SELF_REVIEW_DIFF_CHARS = 12_000
/** Times a Stop hook may send the agent back to work in one turn. */
const MAX_STOP_HOOK_LOOPS = 3
/** Times the plan guard may send the agent back to finish an open checklist item. */
const MAX_PLAN_GUARD_LOOPS = 2
/** Iterations of a turn without update_plan, while the plan has open steps, before the agent is reminded to bring it up to date. */
const PLAN_REMINDER_EVERY = 12
/** Reminders per turn (the iteration cap is 60 by default: a reminder every 12 is at most four or five). */
const MAX_PLAN_REMINDERS = 4
/** How many models one turn may switch to before giving up (the user can tick several models per provider). */
const MAX_MODEL_FALLBACKS = 16
/** Pictures described per request by the vision relay (the newest first matter), and how many at once. */
const MAX_DESCRIBED_PER_REQUEST = 6
const VISION_PARALLEL = 3
/** After every vision model failed, the relay leaves the pictures alone for this long. */
const VISION_REST_MS = 2 * 60_000

function isFallbackKind(kind: ProviderErrorKind | undefined): boolean {
  // Failures another model or provider can get around. A bad request here means "this model is unavailable on this
  // provider"; the switch is always announced in the conversation, never silent.
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
/** How many of the automatic "after" pictures (one per browser/computer action) go out with each request. */
const ACTION_VIEWS_KEPT = 3

/** Tools whose images the agent asked for on purpose: those follow the normal budget, never this view-trimming. */
const EXPLICIT_CAPTURE = new Set(['browser_screenshot', 'computer_screenshot', 'computer_snapshot'])

/**
 * Every browser and computer action now returns a picture of the result. Only the newest few go out with a
 * request (the older ones become a note): a local model with a 64k window would otherwise spend it on pictures
 * of screens it already left. Captures the model requested explicitly keep following trimInlineImages instead.
 */
export function keepRecentActionViews(messages: Message[], keep = ACTION_VIEWS_KEPT): Message[] {
  const isView = (part: Message['parts'][number]): boolean =>
    part.type === 'tool_result' &&
    Boolean(part.images?.length) &&
    (part.name.startsWith('browser_') || part.name.startsWith('computer_')) &&
    !EXPLICIT_CAPTURE.has(part.name)
  let seen = 0
  let changed = false
  const out = [...messages]
  for (let m = out.length - 1; m >= 0; m--) {
    const message = out[m]
    if (!message.parts.some(isView)) continue
    const parts = [...message.parts]
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]
      if (!isView(part) || part.type !== 'tool_result') continue
      seen++
      if (seen <= keep) continue
      changed = true
      parts[p] = {
        ...part,
        images: undefined,
        text: `${part.text ?? ''}\n[a captura desta etapa saiu do contexto: a página mudou depois; valem as capturas mais recentes]`.trim()
      }
    }
    out[m] = { ...message, parts: parts as Message['parts'] }
  }
  return changed ? out : messages
}

/** `preview` pictures are for the chat only (ToolResult.preview): they never go into a request, whatever the adapter. */
export function withoutPreviews(messages: Message[]): Message[] {
  const hasPreview = (message: Message): boolean => message.parts.some((part) => part.type === 'tool_result' && Boolean(part.preview))
  if (!messages.some(hasPreview)) return messages
  return messages.map((message) =>
    hasPreview(message)
      ? { ...message, parts: message.parts.map((part) => (part.type === 'tool_result' && part.preview ? { ...part, preview: undefined } : part)) }
      : message
  )
}

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
const CUT_ANSWER_PROMPT =
  '<resposta-interrompida>\nA resposta acima foi cortada no meio por uma falha do provedor anterior, e você é o modelo que assumiu a conversa. Continue exatamente de onde ela parou, sem repetir o que já foi escrito e sem comentar a troca de modelo.\n</resposta-interrompida>'
const FINAL_STEP_PROMPT =
  'Você atingiu o limite de iterações deste turno. Não chame mais ferramentas. Responda agora com um resumo: o que foi feito, o que foi verificado, o que falta e o próximo passo.'
const BUDGET_FINAL_PROMPT =
  'O orçamento de tokens deste turno acabou. Não chame mais ferramentas. Responda agora com um resumo curto: o que foi feito, o que ficou pendente no plano e o próximo passo exato. O usuário poderá continuar de onde parou em um novo turno.'

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
    /** The session's visible integrated terminal; absent in isolated harness tests. */
    terminal?: TerminalRunner
    /** Describes a picture with a model that reads images (memory_file); absent in isolated harness tests. */
    describeImage?(image: import('../../shared/types.js').ImagePart, question?: string): Promise<{ text: string; via: string } | null>
  }
  project: ProjectMeta
  /** Id of the owning project, used as the AI-Memory scope. */
  projectId?: string
  /** Lifecycle hooks (Claude Code settings format). */
  hooks?: HookRunner
  emit: (event: HarnessEvent) => void
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision | boolean>
  /** Asks the user structured questions; absent for subagents and isolated tests. */
  ask?: (request: QuestionRequest) => Promise<QuestionAnswer[] | null>
  /** Starts a subagent for the `agent` / `task` tools; `caller` describes this runner (see agents/runtime.ts). */
  runSubagent?: (spec: SubagentSpec, caller: SubagentCaller) => Promise<SubagentOutcome>
  /** Agent definitions this runner may delegate to. Without it the `agent` and `list_agents` tools are not offered. */
  agents?: AgentRegistry
  /** Writes a new specialist agent and registers it in `agents` immediately. */
  createAgent?: (input: CreateAgentInput) => Promise<{ path: string; agent: import('../../shared/types.js').AgentDefinition }>
  /** Team mode: the system prompt tells the model to split work across agents (also on at max effort). */
  autoAgents?: boolean
  /**
   * Before a turn that changed files ends, the model sees its own diff once and confirms it or fixes it (on unless
   * set to false in Configurações → Harness).
   */
  selfReview?: boolean
  /** UI surface; Cowork and Chat get their own operating guidance. */
  surface?: SessionSurface
  /** Ordered alternatives to switch to when the active model is exhausted or unavailable. */
  fallback?: FallbackCandidate[]
  /** What the harness has learned about which providers work (shared by every session); optional in isolated tests. */
  health?: ProviderHealth
  /**
   * Models that can read images, in the order to try. When the active model cannot, the pictures of the conversation
   * are described by the first of these that answers and the text goes in their place (core/vision/relay.ts).
   */
  vision?: { candidates(): DescribeCandidate[] }
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
   * Defaults to <os tmpdir>/openclod-tool-output.
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
  /** Preallocated id so a filesystem checkpoint can be keyed before the turn starts. */
  messageId?: string
  /**
   * Work that must finish before the first model call, run with the user's message already on screen (an audio or video
   * attached to the message is processed here, with progress notices). Its text becomes a hidden message after the user's;
   * its images only reach a model that can see them. A failure is reported and the turn goes on without it.
   */
  prepare?: (control: { signal: AbortSignal; progress: (note: string) => void }) => Promise<{ text: string; images?: ImagePart[] } | null | undefined>
  /** Name the preparation shows under in the live activity (a running tool with its elapsed time); defaults to `preparar`. */
  prepareLabel?: string
  /**
   * A slash command's `allowed-tools`: the only tools this turn may use (plus planning and asking). A restriction, never
   * an approval: each call still goes through the permission mode and rules.
   */
  allowedTools?: string[]
}

/** What a turn limited by a command's `allowed-tools` keeps anyway: the plan, asking the user and reporting a limit. */
const TURN_ESSENTIAL_TOOLS = ['update_plan', 'ask_user', 'report_limitation']

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
  private fallback: FallbackCandidate[]
  /** After every vision model failed, the relay rests until then instead of failing again in each request. */
  private visionRestUntil = 0
  private lastToolSignature = ''
  private repeatedCalls = 0
  /** A fourth identical tool call ends the turn instead of nudging forever. */
  private toolLoopTripped = false
  /** Instructions the user sent while a turn ran (steer): the turn compares it with what its last request carried. */
  private steerCount = 0
  /** The tools of the current turn when a slash command limited them (`allowed-tools`); null = no limit. */
  private turnTools: Set<string> | null = null
  private toolCallCount = 0
  private startedAt = 0
  /** Usage of the current user turn; `usage` remains the session total. */
  private turnUsage: Usage = { input: 0, output: 0 }
  /** Actual prompt size of the last provider call, including tool schemas. */
  private lastRequestTokens = 0
  /** The no-tariff warning is shown once per runner. */
  private costNoticeShown = false
  private limitKind: 'tokens' | 'cost' | 'iterations' | 'time' | 'tools' | null = null
  private budgetReported = false
  /** Iteration of the current turn being prepared, and when the plan was last written or the agent last reminded about it. */
  private iterationNow = 0
  private planTouchedAt = 0
  private planRemindedAt = 0
  private planReminders = 0
  /** Provider error class of the last failed request, used by the auto limitation card. */
  private lastErrorKind: string | null = null
  /** Non-core tools enabled by tool_load during this turn. */
  private loadedTools = new Set<string>()
  /** True until the first request after another model took over the conversation (see `compact`). */
  private modelChanged = false
  /** What the hidden per-turn context already put into the history (see turn-context.ts). */
  private readonly turnContext: TurnContextState = createTurnContextState()
  /** Size of each section of the last turn context, for the context meter. */
  private lastTurnContextSections: Array<{ name: string; chars: number }> = []
  private sessionStartContext: string[] | null = null
  /** Directories holding spilled tool output; read-only tools may open files there. */
  private readonly spillRoots: string[] = []
  /** Ids of the interrupted plan items already announced in this runner. */
  private resumeNoticeFor: string | null = null

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
    hydrateTurnContext(this.turnContext, this.messages)
    // A session whose last answer came from another model: the user switched models (or one ran out of quota).
    const previousModel = [...this.messages].reverse().find((message) => message.role === 'assistant' && message.model)?.model
    this.modelChanged = Boolean(previousModel && previousModel !== this.providerConfig.model)
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

  /** Stores what one tool did under the step that was active when it finished. */
  private recordPlanActivity(call: ToolCall, result: ToolResult, startedAt: number, endedAt: number): void {
    const entry = planActivityEntry(call.id, call.name, call.args, result, startedAt, endedAt)
    if (!entry) return
    const next = appendPlanActivity(this.plan, entry)
    if (next === this.plan) return
    this.plan = next
    this.emit({ type: 'plan', sessionId: this.deps.sessionId, items: this.plan })
    this.persist()
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
   * ▶ on a step of the dock after the user stopped the turn: that step becomes the interrupted active one, so the next
   * turn gets the `<retomada>` notice and continues exactly from it. Between turns only. Null when the step cannot be resumed.
   */
  resumePlanFrom(itemId: string): PlanItem | null {
    if (this.busy) throw new Error('aguarde o turno atual terminar para retomar o plano')
    const next = resumePlanAt(this.plan, itemId)
    if (!next) return null
    this.plan = next
    this.resumeNoticeFor = null
    this.emit({ type: 'plan', sessionId: this.deps.sessionId, items: this.plan })
    this.persist()
    return this.plan.find((item) => item.id === itemId) ?? null
  }

  /**
   * 🗑 on the dock: the user gave the plan up. It is cleared, and a hidden note in the history keeps the next turn from
   * picking the abandoned steps up again from the update_plan calls. Between turns only.
   */
  discardPlan(): void {
    if (this.busy) throw new Error('aguarde o turno atual terminar para descartar o plano')
    const previous = this.plan
    this.plan = []
    this.resumeNoticeFor = null
    noteTurnPlan(this.turnContext, this.plan)
    this.emit({ type: 'plan', sessionId: this.deps.sessionId, items: this.plan })
    if (previous.length) this.messages.push(discardedPlanNotice(previous))
    this.persist()
  }

  /**
   * Injects a user instruction into the turn that is already running. The
   * model sees it on the next iteration, without losing the work in progress.
   */
  steer(text: string): boolean {
    if (!this.busy || !text.trim()) return false
    this.steerCount++
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

  /**
   * Where the tokens of the NEXT request go, measured from the real system prompt, the real tool schemas and the real
   * history (the panel used to show fixed numbers: 1 100 for the system prompt, 320 for skills). The sizes are estimates
   * of the same kind the compaction uses (characters / 3.4); `lastRequest` is what the provider reported.
   */
  contextBreakdown(): ContextBreakdown {
    const system = this.buildSystem()
    const instructions = loadProjectInstructions(this.deps.cwd) ?? ''
    let skillsText = ''
    try {
      const list = this.deps.services.skills.list()
      skillsText = list.length ? describeSkills(list) : ''
    } catch {
      /* no skill library */
    }
    const tokens = (text: string): number => estimateTokens(text)
    const specs = this.toolSpecs(this.availableTools())
    const mcpSpecs = specs.filter((spec) => spec.name.startsWith('mcp__'))
    const otherSpecs = specs.filter((spec) => !spec.name.startsWith('mcp__'))
    let turnContexts = 0
    let summary = 0
    let conversation = 0
    let toolResults = 0
    let toolCalls = 0
    let images = 0
    for (const message of this.messages) {
      if (isTurnContext(message)) {
        turnContexts += tokens(message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n'))
        continue
      }
      for (const part of message.parts) {
        if (part.type === 'text') {
          if (message.hidden && part.text.startsWith('[Contexto compactado')) summary += tokens(part.text)
          else conversation += tokens(part.text)
        } else if (part.type === 'reasoning') conversation += tokens(part.text)
        else if (part.type === 'tool_result') toolResults += tokens(part.text)
        else if (part.type === 'tool_call') toolCalls += tokens(JSON.stringify(part.args ?? {}))
        else if (part.type === 'image') images += 850
      }
    }
    const items = [
      { id: 'system', label: 'Instruções do sistema', tokens: Math.max(0, tokens(system) - tokens(instructions) - tokens(skillsText)) },
      { id: 'instructions', label: 'Instruções do projeto (CLAUDE.md)', tokens: tokens(instructions) },
      { id: 'skills', label: 'Skills (índice)', tokens: tokens(skillsText) },
      { id: 'tools', label: 'Ferramentas (schemas)', tokens: tokens(JSON.stringify(otherSpecs)) },
      { id: 'mcp', label: 'Ferramentas MCP (schemas)', tokens: tokens(JSON.stringify(mcpSpecs)) },
      { id: 'memory', label: 'Memória e contexto do turno', tokens: turnContexts },
      { id: 'summary', label: 'Resumo da conversa antiga', tokens: summary },
      { id: 'messages', label: 'Mensagens', tokens: conversation },
      { id: 'results', label: 'Resultados de ferramentas', tokens: toolResults },
      { id: 'calls', label: 'Chamadas de ferramentas', tokens: toolCalls },
      { id: 'images', label: 'Imagens', tokens: images }
    ].filter((item) => item.tokens > 0)
    return {
      items,
      total: items.reduce((sum, item) => sum + item.tokens, 0),
      window: this.providerConfig.contextWindow,
      lastRequest: this.lastRequestTokens
    }
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
      tools: this.toolSpecs(this.availableTools()),
      usedTokens: this.lastRequestTokens,
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
    this.lastRequestTokens = 0
    this.persist()
    await this.afterCompaction('manual', before)
    return true
  }

  /** PostCompact hooks run once the shorter history is in place and saved. */
  private async afterCompaction(trigger: 'manual' | 'auto' | 'overflow', before: number, signal?: AbortSignal): Promise<void> {
    // The history that held the turn contexts is gone: the next turn sends the map, the plan and the pages again.
    resetTurnContext(this.turnContext)
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
    const allowed = new Set(toolsForMode(this.deps.mode))
    // Lazy meta-tools stay available so the model can discover everything else.
    allowed.add('tool_search')
    allowed.add('tool_list')
    allowed.add('tool_load')
    for (const name of this.indirectMcpTools()) allowed.add(name)
    // First-class MCP tools (mcp__server__tool): sent directly unless the server's tools are deferred.
    for (const tool of this.mcpToolDefs()) allowed.add(tool.name)
    for (const name of this.loadedTools) allowed.add(name)
    // Local plugins are dynamic; they only enter after tool_load.
    for (const name of this.deps.registry.names()) {
      if (name.startsWith('plugin__') && this.loadedTools.has(name)) allowed.add(name)
    }
    return [...allowed].filter((name) => (this.isCoreTool(name) || this.loadedTools.has(name)) && this.toolAllowed(name).ok)
  }

  /** Max effort or the user's "separate into agents" toggle: delegating is the point of the session. */
  private teamMode(): boolean {
    return this.deps.effort === 'max' || Boolean(this.deps.autoAgents)
  }

  /**
   * `mcp_catalog` and `mcp_call`, the indirect path to a server's tools. They are in no mode's list (they exist only when the
   * app has MCP servers to talk to) and are no longer sent in every request: tool_search finds them, tool_load enables them.
   */
  private indirectMcpTools(): string[] {
    return this.deps.services.mcp && MCP_MODES.has(this.deps.mode) ? ['mcp_catalog', 'mcp_call'] : []
  }

  /** The former essentials this runner may use but has not loaded (see DEFERRED_ESSENTIAL_TOOL_NAMES). */
  private deferredEssentialTools(): string[] {
    const modeTools = new Set([...toolsForMode(this.deps.mode), ...this.indirectMcpTools()])
    return [...DEFERRED_ESSENTIAL_TOOL_NAMES].filter((name) => modeTools.has(name) && this.toolAllowed(name).ok)
  }

  /**
   * Tools sent in every request: the fixed core set, the MCP tools of servers that are not deferred and the delegation helpers
   * when delegating is the point: team mode, or an agent whose definition may call others (its allowlist names them).
   */
  private isCoreTool(name: string): boolean {
    if (CORE_TOOL_NAMES.has(name)) return true
    if (TEAM_CORE_TOOL_NAMES.has(name) && (this.teamMode() || Boolean(this.deps.allowedTools?.includes(name)))) return true
    const mcp = this.deps.registry.get(name)?.mcp
    return Boolean(mcp && !mcp.deferred)
  }

  /**
   * MCP tools this session may use. Modes that write may use all of them; the read-only modes (plan, review)
   * only the ones that declare themselves read-only and never ask for approval.
   */
  private mcpToolDefs(): ToolDef[] {
    const open = MCP_MODES.has(this.deps.mode)
    return this.deps.registry
      .list()
      .filter((tool) => tool.mcp && (open || (tool.risk === 'read' && tool.approval !== 'ask')))
  }

  /** Mode, policy, hard allowlist and delegation checks shared by search/load. */
  private toolAllowed(name: string): { ok: boolean; reason?: string } {
    const hard = this.deps.allowedTools ? new Set(this.deps.allowedTools) : null
    if (hard && !hard.has(name)) return { ok: false, reason: 'não permitida para este agente' }
    if (this.turnTools && !this.turnTools.has(name)) return { ok: false, reason: 'fora das ferramentas do comando (allowed-tools)' }
    const tool = this.deps.registry.get(name)
    if (!tool) return { ok: false, reason: 'ferramenta não registrada' }
    if (tool.requires === 'network' && !this.deps.policy.allowNetwork) {
      return { ok: false, reason: 'acesso de rede desativado' }
    }
    if (AGENT_TOOLS.has(name) && !this.canDelegate()) {
      return { ok: false, reason: 'delegação indisponível nesta sessão' }
    }
    return { ok: true }
  }

  private searchTools(query: string, limit = 30): Array<{
    name: string
    description: string
    risk: 'read' | 'write' | 'exec' | 'destructive' | 'network'
    requires?: string
    loaded: boolean
  }> {
    const wanted = query.trim().toLowerCase()
    const aliases = Object.entries(TOOL_ALIASES)
      .filter(([key]) => wanted === key || wanted.includes(key))
      .flatMap(([, names]) => names)
    const max = Math.max(1, Math.min(50, limit))
    const candidates = new Set(toolsForMode(this.deps.mode))
    for (const name of this.deps.registry.names()) {
      if (name.startsWith('plugin__')) candidates.add(name)
    }
    for (const tool of this.mcpToolDefs()) candidates.add(tool.name)
    for (const name of this.indirectMcpTools()) candidates.add(name)
    const tokens = wanted.split(/\s+/).filter(Boolean)
    const hits: Array<{
      name: string
      description: string
      risk: 'read' | 'write' | 'exec' | 'destructive' | 'network'
      requires?: string
      loaded: boolean
    }> = []
    for (const name of candidates) {
      if (this.isCoreTool(name) || this.loadedTools.has(name)) continue
      if (this.deps.allowedTools && !this.deps.allowedTools.includes(name)) continue
      if (!this.toolAllowed(name).ok) continue
      const tool = this.deps.registry.get(name)
      if (!tool) continue
      const aliasMatch = aliases.some((alias) =>
        alias.endsWith('_') ? name.startsWith(alias) : name === alias
      )
      const lowerName = name.toLowerCase()
      const lowerDescription = tool.description.toLowerCase()
      // The whole phrase, or every word of it somewhere in the name or the description ("jira create issue").
      const textMatch =
        lowerName.includes(wanted) ||
        lowerDescription.includes(wanted) ||
        (tokens.length > 1 && tokens.every((token) => lowerName.includes(token) || lowerDescription.includes(token)))
      if (wanted && !aliasMatch && !textMatch) {
        continue
      }
      hits.push({
        name,
        description: tool.description,
        risk: tool.risk,
        requires: tool.requires,
        loaded: false
      })
    }
    return hits.sort((a, b) => a.name.localeCompare(b.name)).slice(0, max)
  }

  private listToolCatalog(limit = 200): Array<{
    name: string
    description: string
    risk: 'read' | 'write' | 'exec' | 'destructive' | 'network'
    requires?: string
    loaded: boolean
  }> {
    const names = new Set(toolsForMode(this.deps.mode))
    for (const name of this.deps.registry.names()) {
      if (name.startsWith('plugin__')) names.add(name)
    }
    for (const tool of this.mcpToolDefs()) names.add(tool.name)
    for (const name of this.indirectMcpTools()) names.add(name)
    const hits: Array<{
      name: string
      description: string
      risk: 'read' | 'write' | 'exec' | 'destructive' | 'network'
      requires?: string
      loaded: boolean
    }> = []
    for (const name of names) {
      if (this.deps.allowedTools && !this.deps.allowedTools.includes(name)) continue
      if (!this.toolAllowed(name).ok) continue
      const tool = this.deps.registry.get(name)
      if (!tool) continue
      hits.push({
        name,
        description: tool.description,
        risk: tool.risk,
        requires: tool.requires,
        loaded: this.isCoreTool(name) || this.loadedTools.has(name)
      })
    }
    return hits.sort((a, b) => a.name.localeCompare(b.name)).slice(0, Math.max(1, Math.min(300, limit)))
  }

  private loadTools(names: string[]): {
    loaded: string[]
    rejected: Array<{ name: string; reason: string }>
  } {
    const loaded: string[] = []
    const rejected: Array<{ name: string; reason: string }> = []
    const modeTools = new Set([...toolsForMode(this.deps.mode), ...this.indirectMcpTools()])
    const mcpNames = new Set(this.mcpToolDefs().map((tool) => tool.name))
    // `mcp__server__*` loads every tool of a server at once (a server can have more than 20).
    let wanted: string[] = []
    let globbed = false
    for (const name of names) {
      if (name.includes('*') && name.startsWith('mcp__')) {
        globbed = true
        const pattern = new RegExp(`^${name.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
        const matches = [...mcpNames].filter((candidate) => pattern.test(candidate))
        if (!matches.length) rejected.push({ name, reason: 'nenhuma ferramenta MCP corresponde' })
        wanted.push(...matches)
      } else wanted.push(name)
    }
    wanted = [...new Set(wanted)].slice(0, globbed ? 60 : 20)
    for (const name of wanted) {
      if (this.isCoreTool(name)) {
        if (this.availableTools().includes(name)) loaded.push(name)
        else rejected.push({ name, reason: 'não disponível neste modo' })
        continue
      }
      if (!modeTools.has(name) && !name.startsWith('plugin__') && !mcpNames.has(name)) {
        rejected.push({ name, reason: 'não disponível neste modo' })
        continue
      }
      const check = this.toolAllowed(name)
      if (!check.ok) {
        rejected.push({ name, reason: check.reason ?? 'não permitida' })
        continue
      }
      this.loadedTools.add(name)
      loaded.push(name)
    }
    return { loaded, rejected }
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
      // A specialist may find (tool_search) the MCP tools the caller has not loaded yet, if its definition names them; the
      // essentials that wait for tool_load in this session (memory_search, list_skills, list_agents...) stay in its pool too.
      availableTools: [...new Set([...this.availableTools(), ...this.deferredEssentialTools(), ...this.mcpToolDefs().map((tool) => tool.name)])],
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
      agentsMd: loadProjectInstructions(this.deps.cwd),
      projectName: this.deps.project.name,
      gitBranch: this.deps.project.branch,
      isGitRepo: this.deps.project.isGitRepo,
      teamMode: this.deps.effort === 'max' || Boolean(this.deps.autoAgents),
      environment: this.deps.environment ? `${this.deps.environment.label} (${this.deps.environment.kind})` : undefined,
      extra: extra || undefined
    })
  }

  /**
   * What the harness knows for this turn, as ONE hidden message (see turn-context.ts): the plan if it changed outside the
   * model's own calls, the memory pages that match the request and the pages they are linked to (memory/pack.ts), the
   * facts and connected servers when they changed, open handoffs, and a map of the memory on the first turn. Nothing of
   * it goes in the system prompt, so the provider's cache survives. Every source is bounded in time and best effort: a
   * slow or broken memory service never delays the model call, it just contributes nothing.
   */
  private async buildTurnContext(query: string): Promise<string | null> {
    const services = this.deps.services
    const state = this.turnContext
    const projectId = this.deps.projectId
    const bounded = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          work(),
          new Promise<T>((resolve) => {
            timer = setTimeout(() => resolve(fallback), TURN_CONTEXT_STEP_MS)
          })
        ])
      } catch {
        return fallback
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    // A subagent works on one delegated task: it is not handed the unfinished work of the user's other sessions.
    const isChild = (this.deps.depth ?? 0) > 0
    const [facts, pages, indexed, handoffs, capsules, map] = await Promise.all([
      bounded(async () => (await services.memory.all()).slice(-40).map((fact: MemoryFact) => fact.text), [] as string[]),
      bounded(() => services.projectMemory.listPages(), [] as Awaited<ReturnType<ProjectMemory['listPages']>>),
      bounded(
        async () => (projectId && services.aiMemory?.search ? await services.aiMemory.search(projectId, query, 12) : []),
        [] as Array<{ path: string }>
      ),
      bounded(() => services.projectMemory.listHandoffs(), [] as Awaited<ReturnType<ProjectMemory['listHandoffs']>>),
      isChild
        ? Promise.resolve([] as Awaited<ReturnType<ProjectMemory['openWork']>>)
        : bounded(
            () => services.projectMemory.openWork({ excludeContext: `sessao:${this.deps.sessionId}` }),
            [] as Awaited<ReturnType<ProjectMemory['openWork']>>
          ),
      state.mapSent ? Promise.resolve('') : bounded(async () => (await services.projectMemory.map()).text, '')
    ])
    const pack = buildPack(pages, query, {
      indexed: indexed.map((hit) => hit.path.replace(/^pages\//, '').replace(/\.md$/, '')),
      seen: state.seen,
      // This session's own capsule says what the history already says.
      exclude: (page) => page.tags.includes('estado') && page.context === `sessao:${this.deps.sessionId}`
    })
    const work: string[] = []
    capsules.forEach((capsule, position) => {
      const label = capsule.status === 'concluido' ? 'última sessão, concluída' : capsule.status === 'interrompido' ? 'interrompida' : 'em aberto'
      work.push(`- ${capsule.title} [${capsule.slug}] — ${label}, atualizada ${ageLabel(capsule.updated)}`)
      // The first capsule is put in front of the model whole: after "continue de onde paramos" there is nothing else to go on.
      if (position === 0) work.push(...digestCapsule(capsule.body).split('\n').map((line) => `  ${line}`))
      else if (capsule.next) work.push(`  Próximo passo: ${capsule.next}`)
    })
    for (const handoff of handoffs.slice(0, 3)) work.push(`- handoff ${handoff.id}: ${handoff.summary}${handoff.next ? ` · próximo: ${handoff.next}` : ''}`)
    const openWork = work.length
      ? `${work.join('\n')}\n(detalhes: memory_page action=read slug=<slug>${handoffs.length ? '; para assumir um handoff: tool_load memory_handoff e chame action=accept id=<id>' : ''})`
      : undefined
    const suggested = this.suggestionsFor(query)
    // Nos chats do Início a memória é SOB DEMANDA: não empurramos a cápsula de continuidade ("de onde paramos") nem as
    // páginas que casam com o pedido. Assim o modelo atende a mensagem atual em vez de retomar a tarefa anterior sozinho
    // ao ver um simples "oi". O mapa continua (para ele saber que há memória) e memory_recall busca o contexto quando ele
    // sentir que precisa. No modo Code/Cowork o comportamento é o de sempre (contexto do projeto injetado).
    const onDemandMemory = this.deps.surface === 'chat'
    const result = composeTurnContext(state, {
      plan: this.plan,
      facts,
      mcp: summarizeMcpTools(this.mcpToolDefs()) || undefined,
      map: map || undefined,
      openWork: onDemandMemory ? undefined : openWork,
      recall: onDemandMemory ? undefined : pack.text || undefined,
      suggestions: suggested.text
    })
    this.lastTurnContextSections = result.sections
    // A suggestion counts as made only if it reached the message (the budget can cut the last section).
    if (result.sections.some((section) => section.name === 'sugestoes')) for (const name of suggested.names) state.suggested.add(name)
    if (result.sections.some((section) => section.name === 'memoria')) {
      const updated = new Map(pages.map((page) => [page.slug, page.updated]))
      for (const entry of pack.entries) state.seen.set(entry.slug, updated.get(entry.slug) ?? '*')
    }
    return result.text
  }

  /**
   * Skills, agents and tools that are not in the context but match the request (see suggest.ts). The system prompt carries
   * no catalogue: the harness looks for what fits and names it, once, when the request calls for it.
   */
  private suggestionsFor(query: string): { text?: string; names: string[] } {
    const candidates: Candidate[] = []
    try {
      for (const skill of this.deps.services.skills.list()) candidates.push({ kind: 'skill', name: skill.name, description: skill.description })
    } catch {
      /* no skill library in this session */
    }
    try {
      for (const agent of this.agentCatalog().callable()) candidates.push({ kind: 'agente', name: agent.name, description: agent.description })
    } catch {
      /* no agents in this session */
    }
    for (const tool of this.listToolCatalog(300)) if (!tool.loaded) candidates.push({ kind: 'ferramenta', name: tool.name, description: tool.description })
    const picked = suggest(query, candidates, { skip: this.turnContext.suggested })
    if (!picked.length) return { names: [] }
    return { text: renderSuggestions(picked), names: picked.map((item) => `${item.kind}:${item.name}`) }
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

  private hiddenUserMessage(text: string, images?: ImagePart[]): void {
    this.messages.push({ id: id('msg'), role: 'user', ts: Date.now(), hidden: true, parts: [{ type: 'text', text }, ...(images ?? [])] })
    this.persist()
  }

  /**
   * Where a picture stored now goes, written on it so the chat can say whether the model really saw it: the model
   * reads it, a model with vision describes it first (the relay), or no model sees it. Nothing sent changes.
   */
  private imageDelivery(): NonNullable<ImagePart['delivery']> {
    if (this.provider.supportsVision) return 'model'
    return this.deps.vision?.candidates().length ? 'relay' : 'none'
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
   * Builds the tool_result part. Output beyond the inline cap is written to a
   * file and replaced by a head/tail preview plus its path; if the file
   * cannot be written the old middle-out truncation applies. read_file output
   * keeps the larger cap (a slice the model asked for), and past it is saved
   * like any other output, so the middle of very long lines is not lost unseen.
   */
  private async toolResultPart(call: ToolCall, result: ToolResult): Promise<Message['parts'][number]> {
    const raw = result.text ?? ''
    const cap = call.name === 'read_file' ? MAX_RESULT_CHARS : MAX_TOOL_RESULT_CHARS
    let text = raw
    if (raw.length > cap) {
      const notice = await this.spillOutput(call, raw)
      text = notice ?? truncateMiddle(raw, cap)
    }
    return {
      type: 'tool_result',
      toolCallId: call.id,
      name: call.name,
      ok: result.ok,
      text,
      images: result.images?.map((image) => ({ ...image })),
      ...(result.preview?.length ? { preview: result.preview.map((image) => ({ ...image })) } : {}),
      detail: result.summary
    }
  }

  private async spillOutput(call: ToolCall, text: string): Promise<string | null> {
    try {
      const base = path.resolve(this.deps.toolOutputDir ?? path.join(os.tmpdir(), 'openclod-tool-output'))
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
      vision: this.provider.supportsVision,
      model: this.providerConfig.model,
      cwd: deps.cwd,
      mode: deps.mode,
      policy: deps.policy,
      workspace: this.toolWorkspace(),
      signal,
      tracker: deps.tracker,
      environment: deps.environment,
      surface: deps.surface,
      services: deps.services,
      projectId: deps.projectId,
      emit: (event) => this.emit(event),
      approve: async (request) => {
        const decision = await deps.approve({ ...request, id: id('appr'), sessionId: deps.sessionId })
        return typeof decision === 'boolean' ? decision : decision.approved
      },
      ask: deps.ask
        ? (request) => deps.ask!({ ...request, id: id('qst'), sessionId: deps.sessionId })
        : undefined,
      setPlan: (items) => {
        this.planTouchedAt = this.iterationNow
        this.plan = mergePlanTimes(this.plan, items, Date.now())
        // The model wrote this plan itself (it is in the history as the tool call): the next turn need not repeat it.
        noteTurnPlan(this.turnContext, this.plan)
        this.emit({ type: 'plan', sessionId: deps.sessionId, items: this.plan })
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
      searchTools: (query, limit) => this.searchTools(query, limit),
      listTools: () => this.listToolCatalog(),
      loadTools: (names) => this.loadTools(names),
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
    // Heal an earlier abort/crash before the provider sees the history. The
    // provider serializers also normalize the sequence, but persisting the
    // missing results keeps the transcript and the next requests stable.
    const repaired = repairOrphanToolCalls(this.messages)
    if (repaired.repaired) {
      this.messages = repaired.messages
      this.persist()
      this.emit({
        type: 'notice',
        sessionId: this.deps.sessionId,
        level: 'warn',
        text: `${repaired.repaired} resultado(s) de ferramenta ausente(s) foram marcados como interrompidos para manter a conversa válida.`
      })
    }
    this.busy = true
    this.toolCallCount = 0
    this.repeatedCalls = 0
    this.toolLoopTripped = false
    this.turnTools = options.allowedTools?.length ? new Set([...options.allowedTools, ...TURN_ESSENTIAL_TOOLS]) : null
    this.deps.tracker.beginTurn?.()
    this.startedAt = Date.now()
    this.turnUsage = { input: 0, output: 0 }
    this.lastRequestTokens = 0
    this.limitKind = null
    this.budgetReported = false
    this.iterationNow = 0
    this.planTouchedAt = 0
    this.planRemindedAt = 0
    this.planReminders = 0
    this.lastErrorKind = null
    // Loaded tools last for the turn, except MCP tools and the former essentials: once found and loaded they stay for the
    // session (as in Claude Code), so the next request does not repeat tool_search/tool_load. The tool list is the head of
    // the provider's cached prompt: one that shrinks back at every turn would break the cache again each time, and these
    // schemas are small.
    for (const name of [...this.loadedTools]) {
      if (!this.deps.registry.get(name)?.mcp && !DEFERRED_ESSENTIAL_TOOL_NAMES.has(name)) this.loadedTools.delete(name)
    }
    // A command that names its tools gets them in this turn's list, even the ones that wait for tool_load.
    for (const name of options.allowedTools ?? []) if (this.deps.registry.get(name)) this.loadedTools.add(name)
    // A request that names a former essential in the words people use for it ("catálogo de skills", "handoff") gets it in the
    // tool list from the first call. A strong model finds it with tool_search; a small one does not look for a tool it cannot
    // see (a 4B model went 4 for 4 with the tools in the list and 2 for 4 without them), and the model that would have spent
    // a tool_load call spends none. Only the user's own words count, and the usual checks (mode, permissions) still apply.
    if (!options.hidden) for (const name of essentialsNamedBy(text)) this.loadTools([name])
    this.controller = new AbortController()
    const signal = this.controller.signal
    // Provider requests use a turn-scoped child controller. A loop guard can
    // abort it without making the turn look like a user cancellation, while a
    // real user abort still propagates to every stream of the turn.
    const providerAbort = new AbortController()
    signal.addEventListener('abort', () => providerAbort.abort(), { once: true })
    const unlinkParent = this.linkParentSignal(this.controller)
    const turnStart = this.messages.length
    const blockedBefore = new Set(this.plan.filter((item) => item.status === 'blocked').map((item) => item.id))

    const attachedDelivery = options.images?.length ? this.imageDelivery() : undefined
    const userMessage: Message = {
      id: options.messageId ?? id('msg'),
      role: 'user',
      ts: Date.now(),
      hidden: options.hidden,
      parts: [
        { type: 'text', text },
        // Copies: the vision relay writes the description onto the picture, and the caller's object must stay as it was.
        ...(options.images ?? []).map((image) => ({ ...image, delivery: attachedDelivery }))
      ]
    }
    this.addMessage(userMessage)
    const interrupted = this.plan.filter((item) => item.interrupted)
    if (interrupted.length) {
      const key = interrupted.map((item) => item.id).join(',')
      if (this.resumeNoticeFor !== key) {
        this.resumeNoticeFor = key
        this.hiddenUserMessage(
          [
            '<retomada>',
            'A execução anterior foi interrompida (o app fechou ou o usuário parou o turno) no passo:',
            ...interrupted.map((item) => `- ${item.text}`),
            'Reabra esse item como active com update_plan e continue exatamente dele. Não avance para os próximos passos sem concluí-lo.',
            '</retomada>'
          ].join('\n')
        )
      }
    } else {
      this.resumeNoticeFor = null
    }
    this.setState('thinking')
    this.emit({ type: 'turn_start', sessionId: this.deps.sessionId, messageId: userMessage.id })

    const turnId = userMessage.id
    let stopReason: StopReason = 'stop'
    let errorMessage: string | undefined
    let lengthContinuations = 0
    let streamRetries = 0
    let stopHookLoops = 0
    let planGuardLoops = 0
    let selfReviewed = false
    let steersSeen = this.steerCount
    let overflowCompactions = 0
    let fallbacksUsed = 0
    /** Set when reasoning, visible text or an identical tool call starts looping. */
    const loopState: {
      current: { channel: 'raciocínio' | 'resposta' | 'ferramenta'; detail: string; sample?: string } | null
    } = { current: null }

    try {
      if (options.prepare) {
        // Shown like a tool that is running (its name, the elapsed time, the last progress note), so a minute of
        // processing is not a silent "thinking"; it is not a model tool call and never enters the history.
        const sessionId = this.deps.sessionId
        const prepareId = id('prep')
        const label = options.prepareLabel ?? 'preparar'
        this.emit({ type: 'tool_start', sessionId, toolCallId: prepareId, name: label, args: {} })
        let prepared: Awaited<ReturnType<NonNullable<SendOptions['prepare']>>> = null
        let failure = ''
        try {
          prepared = await options.prepare({
            signal,
            progress: (note) => {
              this.emit({ type: 'notice', sessionId, level: 'info', desktop: false, text: note })
              this.emit({ type: 'tool_progress', sessionId, toolCallId: prepareId, name: label, text: note })
            }
          })
          // The chat shows these pictures (they are what the model looks at); a model without vision gets the text only.
          if (prepared?.text) {
            this.hiddenUserMessage(
              prepared.text,
              this.provider.supportsVision ? prepared.images?.map((image) => ({ ...image, delivery: 'model' as const })) : undefined
            )
          }
        } catch (err) {
          failure = (err as Error).message
          // A cancelled turn is handled by the loop's first check; anything else is reported and the turn goes on.
          if (!signal.aborted) this.emit({ type: 'notice', sessionId, level: 'warn', text: `preparação do pedido falhou: ${failure}` })
        }
        this.emit({ type: 'tool_end', sessionId, toolCallId: prepareId, name: label, ok: !failure, summary: failure ? `falhou: ${failure.slice(0, 120)}` : 'concluído' })
      }
      const turnContext = await this.buildTurnContext(text)
      if (turnContext) this.hiddenUserMessage(turnContext)

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
          errorMessage = TURN_CANCELLED
          this.setState('cancelled', errorMessage)
          break
        }

        let budgetFinal = false
        const limitError = this.checkLimits()
        if (limitError) {
          if (this.limitKind === 'tokens' || this.limitKind === 'cost') {
            budgetFinal = true
            if (!this.budgetReported) {
              this.budgetReported = true
              this.emit({ type: 'budget', sessionId: this.deps.sessionId, info: this.budgetInfo(iteration) })
              this.emit({
                type: 'notice',
                sessionId: this.deps.sessionId,
                level: 'warn',
                text: `${limitError}. Vou gerar um resumo e parar; o plano fica salvo para continuar.`
              })
            }
          } else {
            stopReason = 'error'
            errorMessage = limitError
            this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'error', text: limitError })
            this.setState('error', limitError)
            break
          }
        }

        // The last iteration (or a budget stop) keeps the tool list
        // (cache-friendly) but forbids calls, so the turn ends with a summary.
        const finalStep = budgetFinal || iteration === this.deps.limits.maxIterations
        this.iterationNow = iteration
        if (finalStep) this.hiddenUserMessage(budgetFinal ? BUDGET_FINAL_PROMPT : FINAL_STEP_PROMPT)
        else this.remindAboutPlan(iteration)

        let system = this.buildSystem()
        const takenOver = this.modelChanged
        this.modelChanged = false
        const compacted = await this.compact(system, signal, false, takenOver)
        if (compacted) {
          system = this.buildSystem()
          // The turn contexts went away with the old history: this turn's (plan, memory map, pages) goes back after the summary.
          const again = await this.buildTurnContext(text)
          if (again) this.hiddenUserMessage(again)
        }

        const assistantId = id('msg')
        const toolNames = this.availableTools()
        const tools = this.toolSpecs(toolNames)
        // A model that cannot read images never gets one: a model that can describes each picture first (once).
        await this.describePendingImages(signal, text)
        const requestMessages = inlineImageDescriptions(trimInlineImages(keepRecentActionViews(withoutPreviews(this.messages))), {
          vision: this.provider.supportsVision
        })
        const contextUsed = Math.max(
          estimateContextTokens(system, requestMessages, tools),
          this.lastRequestTokens
        )
        const requestedOutput = this.providerConfig.maxOutputTokens ?? 32_000
        const outputRoom = this.providerConfig.contextWindow - contextUsed - Math.ceil(contextUsed * 0.15)
        const maxTokens = Math.max(1_024, Math.min(requestedOutput, outputRoom))
        const request = {
          system,
          messages: requestMessages,
          tools,
          toolChoice: finalStep ? ('none' as const) : undefined,
          effort: this.deps.effort,
          maxTokens,
          signal: providerAbort.signal,
          // Another model is ready to take over: do not sit out a long rate-limit pause here.
          fastFail: this.hasReserve()
        }
        // What the user sent mid-turn up to here is in this request; anything later must not be left unanswered.
        steersSeen = this.steerCount

        this.setState('streaming')
        let textBuffer = ''
        let reasoningBuffer = ''
        const toolCalls: ToolCall[] = []
        let providerError: string | undefined
        let errorKind: ProviderErrorKind | undefined
        let usageDelta: Usage | null = null
        let providerBlocks: ProviderBlocks | undefined
        let iterationStop: StopReason = 'stop'
        let lastLoopCheckAt = 0
        let lastLoopCheckLength = 0
        let reasoningOnlySince = Date.now()
        const reasoningBudgetMs =
          this.deps.effort === 'max' || this.deps.effort === 'xhigh' ? 300_000 : MAX_REASONING_ONLY_MS

        const tripLoop = (channel: 'raciocínio' | 'resposta' | 'ferramenta', detail: string, sample?: string): void => {
          if (loopState.current) return
          loopState.current = { channel, detail, ...(sample ? { sample } : {}) }
          this.lastErrorKind = 'loop'
          const where = channel === 'ferramenta' ? 'na ferramenta' : channel === 'resposta' ? 'na resposta' : 'no raciocínio'
          this.emit({
            type: 'notice',
            sessionId: this.deps.sessionId,
            level: 'warn',
            text: `Loop detectado ${where}: ${detail}. Interrompi a resposta para não gastar o restante do turno.`
          })
          this.hiddenUserMessage(
            [
              '<loop-guard>',
              `O turno anterior foi interrompido automaticamente porque o modelo entrou em loop de ${channel}: ${detail}.`,
              'Não repita a mesma cadeia de raciocínio, resposta ou chamada de ferramenta.',
              'Reformule a abordagem, reduza o escopo, use outra ferramenta ou peça uma decisão ao usuário antes de continuar.',
              '</loop-guard>'
            ].join('\n')
          )
          providerAbort.abort()
        }

        const inspectLoop = (channel: 'raciocínio' | 'resposta', buffer: string): void => {
          if (loopState.current) return
          const now = Date.now()
          if (channel === 'raciocínio' && !textBuffer && !toolCalls.length) {
            const elapsed = now - reasoningOnlySince
            if (elapsed >= reasoningBudgetMs || buffer.length >= MAX_REASONING_ONLY_CHARS) {
              tripLoop(
                channel,
                buffer.length >= MAX_REASONING_ONLY_CHARS
                  ? `o modelo produziu ${buffer.length} caracteres de raciocínio sem responder ou chamar ferramenta`
                  : `o modelo passou ${Math.round(elapsed / 1000)}s só raciocinando, sem responder ou chamar ferramenta`,
                buffer.slice(-240)
              )
              return
            }
          }
          // Checking the whole tail on every token would be wasteful. A short
          // gate catches a loop within half a second without throttling the UI.
          if (now - lastLoopCheckAt < 400 && buffer.length - lastLoopCheckLength < 200) return
          lastLoopCheckAt = now
          lastLoopCheckLength = buffer.length
          const hit: RepetitionHit | null = detectRepetition(buffer)
          if (hit) {
            tripLoop(channel, `o modelo repetiu o mesmo trecho ${hit.repeats} vezes`, hit.sample)
          }
        }

        try {
          for await (const event of this.provider.stream(request)) {
            switch (event.type) {
              case 'text_delta':
                if (!textBuffer) reasoningOnlySince = Date.now()
                textBuffer += event.text
                this.emit({
                  type: 'text_delta',
                  sessionId: this.deps.sessionId,
                  messageId: assistantId,
                  text: event.text
                })
                inspectLoop('resposta', textBuffer)
                break
              case 'reasoning_delta':
                reasoningBuffer += event.text
                this.emit({
                  type: 'reasoning_delta',
                  sessionId: this.deps.sessionId,
                  messageId: assistantId,
                  text: event.text
                })
                inspectLoop('raciocínio', reasoningBuffer)
                break
              case 'tool_call_start':
                // A tool call is progress: do not count the preceding reasoning
                // as an idle reasoning-only stream.
                reasoningOnlySince = Date.now()
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
            if (loopState.current) break
          }
        } catch (err) {
          if (loopState.current) {
            // The abort came from our own loop guard, not from the user.
          } else if (signal.aborted) {
            stopReason = 'error'
            errorMessage = TURN_CANCELLED
            this.setState('cancelled', errorMessage)
            break
          } else {
            providerError = (err as Error).message
            errorKind = errorKindOf(err)
            this.lastErrorKind = errorKind
            iterationStop = 'error'
          }
        }

        if (usageDelta) {
          if (!this.costNoticeShown && (usageDelta.input ?? 0) > 0 && this.providerConfig.inputCostPerMTok === undefined && this.providerConfig.outputCostPerMTok === undefined && !isLocalProvider(this.providerConfig)) {
            this.costNoticeShown = true
            this.emit({
              type: 'notice',
              sessionId: this.deps.sessionId,
              level: 'warn',
              text: `O provedor "${this.providerConfig.label}" não tem tarifa configurada: o custo aparece como US$ 0 e o limite de custo por turno (US$ ${this.deps.limits.maxCostUsd}) não protege este uso. Informe os preços em Configurações → Provedores (o limite de tokens continua valendo).`,
              desktop: false
            })
          }
          this.usage = addUsage(this.usage, usageDelta, this.providerConfig)
          this.turnUsage = addUsage(this.turnUsage, usageDelta, this.providerConfig)
          this.lastRequestTokens = (usageDelta.input ?? 0) + (usageDelta.output ?? 0)
          this.emit({
            type: 'usage',
            sessionId: this.deps.sessionId,
            usage: usageDelta,
            total: this.usage,
            turn: this.turnUsage,
            limit: effectiveMaxTokens(this.deps.limits, this.providerConfig.contextWindow),
            providerId: this.providerConfig.id,
            providerLabel: this.providerConfig.label,
            model: this.providerConfig.model,
            costUsd: usageCost(usageDelta, this.providerConfig)
          })
        }

        if (loopState.current) {
          stopReason = 'error'
          const where =
            loopState.current.channel === 'ferramenta'
              ? 'na ferramenta'
              : loopState.current.channel === 'resposta'
                ? 'na resposta'
                : 'no raciocínio'
          errorMessage = `Loop detectado ${where}: ${loopState.current.detail}. O turno foi interrompido para não gastar o orçamento restante; o plano e a conversa foram preservados.`
          this.setState('error', errorMessage)
          break
        }

        if (providerError) {
          this.lastErrorKind = errorKind ?? 'unknown'
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
          // With another model ready to take over, a transient failure is not waited out: one more try at most,
          // none at all for a limit or an overload (the other model answers in seconds).
          const reserve = errorKind ? this.hasReserve(errorKind) : false
          const retryBudget = reserve ? (errorKind === 'rate_limit' || errorKind === 'overloaded' ? 0 : 1) : MAX_STREAM_RETRIES
          if (nothingEmitted && errorKind && isRetryableKind(errorKind) && streamRetries < retryBudget) {
            streamRetries++
            const delay = (this.deps.retryBaseMs ?? 2000) * streamRetries
            this.emit({
              type: 'notice',
              sessionId: this.deps.sessionId,
              level: 'warn',
              desktop: false,
              text: `Falha transitória do provedor (${errorKind}); nova tentativa em ${delay / 1000}s.`
            })
            await sleep(delay, signal).catch(() => undefined)
            iteration--
            continue
          }
          // What the harness learned: this provider (or this model) cannot answer right now (a failure that a retry cured
          // is not recorded). Every session shares it.
          if (errorKind && isFallbackKind(errorKind)) this.deps.health?.mark(this.providerConfig, errorKind)
          // No balance / rate limit / refused key / outage / context window too small: move the conversation to the
          // next model that works, with the same history, plan and project memory, instead of aborting the task.
          if (errorKind && (isFallbackKind(errorKind) || errorKind === 'context_overflow') && !toolCalls.length && fallbacksUsed < MAX_MODEL_FALLBACKS) {
            const next = await this.takeFallback(
              errorKind,
              this.providerConfig,
              errorKind === 'context_overflow' ? { minContextWindow: this.providerConfig.contextWindow } : {}
            )
            if (next) {
              // An answer that already reached the screen stays as it is; the next model is told to pick it up from there.
              const cutAnswer = textBuffer.trim().length > 0
              if (cutAnswer) {
                this.addMessage({
                  id: assistantId,
                  role: 'assistant',
                  ts: Date.now(),
                  parts: [{ type: 'text', text: textBuffer }],
                  model: this.providerConfig.model
                })
              }
              this.switchModel(next, errorKind)
              if (cutAnswer) this.hiddenUserMessage(CUT_ANSWER_PROMPT)
              fallbacksUsed++
              iteration--
              continue
            }
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

        if (budgetFinal && toolCalls.length) {
          // The provider ignored toolChoice: do not spend more tokens running tools.
          stopReason = 'stop'
          break
        }

        if (!toolCalls.length) {
          if (finalStep) {
            if (budgetFinal) {
              // The budget notice already explained the stop; the summary is
              // the final assistant message.
              stopReason = 'stop'
              break
            }
            stopReason = 'length'
            errorMessage = `limite de ${this.deps.limits.maxIterations} iterações atingido; o agente resumiu o progresso`
            this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', text: errorMessage })
            // The turn is over: the plan must not keep showing a step "in progress" (it resumes on the next turn).
            this.blockActivePlanItems()
            // Like a token or cost stop, the user is offered to continue from where it stopped (not for a subagent's own cap).
            if (!this.deps.depth) this.emit({ type: 'budget', sessionId: this.deps.sessionId, info: this.budgetInfo(iteration, 'iterations') })
            break
          }
          if (iterationStop === 'length' && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
            lengthContinuations++
            this.hiddenUserMessage(CONTINUE_PROMPT)
            continue
          }
          // The user sent an instruction after the last request went out (while this answer was being written): it is
          // answered now, in this turn, instead of sitting unread at the end of the history.
          if (this.steerCount > steersSeen && !signal.aborted) {
            this.hiddenUserMessage(
              '<instrucao-pendente>\nO usuário mandou a instrução acima enquanto você escrevia esta resposta. Atenda a ela agora.\n</instrucao-pendente>'
            )
            continue
          }
          // A plan is a promise to the user: never end with open work while
          // the agent can still act. Blocked items are a legitimate stop.
          const openPlan = this.plan.filter((item) => item.status === 'pending' || item.status === 'active')
          if (openPlan.length && planGuardLoops < MAX_PLAN_GUARD_LOOPS) {
            planGuardLoops++
            this.hiddenUserMessage(
              [
                '<plan-guard>',
                'O plano ainda tem itens abertos:',
                ...openPlan.map((item) => `- [${item.status}] ${item.text}`),
                'Continue o trabalho agora. Conclua cada item ou marque como blocked com o motivo exato.',
                'Não encerre o turno nem peça uma decisão sem antes atualizar o plano com update_plan.',
                '</plan-guard>'
              ].join('\n')
            )
            continue
          }
          // Out of nudges: stop the animated spinner honestly instead of
          // showing work in progress after the turn is over.
          if (openPlan.length) this.blockActivePlanItems()
          // "Done" becomes "reviewed": a turn that changed files shows the model its own diff once before it ends.
          if (!selfReviewed && !signal.aborted) {
            selfReviewed = true
            const review = this.selfReviewPrompt()
            if (review) {
              this.hiddenUserMessage(review)
              continue
            }
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
          if (part.type === 'tool_result' && part.images?.length) {
            // The Anthropic adapter drops the pictures of a failed tool; say so instead of claiming the model saw them.
            const delivery = !part.ok && this.providerConfig.kind === 'anthropic' && this.provider.supportsVision ? 'none' : this.imageDelivery()
            for (const image of part.images) image.delivery = delivery
          }

          // Vision-less models still receive a textual description, but the
          // images stay in the stored part so the user can see the screenshot
          // in the chat (providers that do not accept them never receive them).
          // With a model that reads images available, the vision relay describes the picture before the next request
          // and the description is added then; the note below is for when there is none.
          if (part.type === 'tool_result' && part.images?.length && !this.provider.supportsVision && !(this.deps.vision?.candidates().length)) {
            // Say it plainly: a text-only model that is merely "told" an image exists tends to describe one anyway
            // and to keep asking for more screenshots. Point it at the tools that return text instead.
            part.text +=
              `\n[${part.images.length} imagem(ns) capturada(s) — o modelo atual não suporta visão e NÃO recebeu a imagem. ` +
              'Não descreva nem deduza o que ela mostra e não repita a captura: use computer_snapshot / browser_snapshot / ' +
              'browser_read para ler a tela em texto, ou image_ocr / image_inspect em um arquivo de imagem salvo.]'
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

        if (this.toolLoopTripped) {
          tripLoop(
            'ferramenta',
            `a mesma chamada de ferramenta foi repetida ${this.repeatedCalls} vezes sem mudar o estado`,
            this.lastToolSignature
          )
          stopReason = 'error'
          errorMessage = `Loop detectado na ferramenta: ${this.lastToolSignature} foi chamada ${this.repeatedCalls} vezes. ` +
            'O turno foi interrompido para não gastar o restante do orçamento; o plano e a conversa foram preservados.'
          this.setState('error', errorMessage)
          break
        }

        const changes = this.deps.tracker.changes()
        if (changes.length) this.emit({ type: 'diff', sessionId: this.deps.sessionId, files: changes })

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
      try {
        this.recordAutoLimitation({ stopReason, errorMessage, goal: text, turnStart, blockedBefore, loop: Boolean(loopState.current) })
      } catch (err) {
        // A failed self-analysis must never prevent the turn from ending.
        this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', text: `análise da falha indisponível: ${(err as Error).message}` })
      }
      this.busy = false
      this.controller = null
      if (stopReason !== 'error') this.setState('done')
      this.emit({
        type: 'turn_end',
        sessionId: this.deps.sessionId,
        messageId: turnId,
        stopReason,
        error: errorMessage,
        ...(errorMessage === TURN_CANCELLED ? { cancelled: true } : {})
      })
      this.persist()
    }
  }

  /**
   * Last-resort self-analysis: when a turn fails or blocks a step without the
   * model calling `report_limitation`, the harness records what it tried, the
   * exact error and a suggested fix, so the transcript never ends in a bare
   * error. The part is never sent to the provider.
   */
  private recordAutoLimitation(input: {
    stopReason: StopReason
    errorMessage?: string
    goal: string
    turnStart: number
    blockedBefore: Set<string>
    loop?: boolean
  }): void {
    if (this.controller?.signal.aborted) return
    if (input.errorMessage === TURN_CANCELLED) return
    const reported = this.messages
      .slice(input.turnStart)
      .some((message) => message.parts.some((part) => part.type === 'tool_call' && part.name === 'report_limitation'))
    if (reported) return
    const blocked = this.plan.filter((item) => item.status === 'blocked' && !input.blockedBefore.has(item.id))
    const failed = input.stopReason === 'error'
    if (!failed && !blocked.length) return

    const active = this.plan.find((item) => item.status === 'active')
    // If this turn failed before doing anything, the persisted activity of the
    // current step still shows what the agent tried in earlier turns.
    const attempts = this.attemptsSince(input.turnStart)
    const recentPlanAttempts = [...(active?.activity ?? []), ...(blocked[0]?.activity ?? [])]
      .slice(-12)
      .map((entry) => `${entry.name}: ${entry.title}${entry.status === 'failed' ? ' (falhou)' : ''}`)
    const report: LimitationReport = buildAutoLimitation({
      goal: input.goal,
      error: input.errorMessage,
      errorKind: input.loop ? 'loop' : this.lastErrorKind ?? undefined,
      blocked,
      active,
      attempts: attempts.length ? attempts : recentPlanAttempts,
      loop: input.loop
    })
    this.addMessage({
      id: id('msg'),
      role: 'assistant',
      ts: Date.now(),
      parts: [{ type: 'limitation', report }]
    })
    this.emit({ type: 'limitation', sessionId: this.deps.sessionId, report })
  }

  /** What the agent actually did this turn, for the self-analysis card. */
  private attemptsSince(turnStart: number): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const message of this.messages.slice(turnStart)) {
      for (const part of message.parts) {
        if (part.type !== 'tool_call' || part.name === 'report_limitation') continue
        const args = part.args && typeof part.args === 'object' ? (part.args as Record<string, unknown>) : {}
        const detail =
          typeof args.path === 'string'
            ? args.path
            : typeof args.command === 'string'
              ? args.command
              : typeof args.query === 'string'
                ? args.query
                : typeof args.url === 'string'
                  ? args.url
                  : ''
        const entry = `${part.name}${detail ? `: ${truncate(detail.replace(/\s+/g, ' ').trim(), 180)}` : ''}`
        if (seen.has(entry)) continue
        seen.add(entry)
        out.push(entry)
        if (out.length >= 12) return out.slice(-12)
      }
    }
    return out.slice(-12)
  }

  /**
   * Whether another model could take over after a failure of this kind (no request is made). Account-level failures
   * (no balance, refused key, no connection) rule out the same provider's other models: they would fail the same way.
   */
  private hasReserve(kind?: ProviderErrorKind): boolean {
    const account = kind !== undefined && isAccountLevelKind(kind)
    const mine = accountKeyOf(this.providerConfig)
    return this.fallback.some(
      (candidate) => !(account && accountKeyOf(candidate.config) === mine) && !this.deps.health?.unavailable(candidate.config)
    )
  }

  /**
   * Takes the next model of the reserve out of the line: skips the same provider after an account-level failure, models
   * with a window no bigger than `minContextWindow` (a context overflow), models known to be down (unless nothing else is
   * left) and local servers that are not running. Returns undefined when nothing can take over.
   */
  private async takeFallback(
    kind: ProviderErrorKind,
    failed: ProviderConfig,
    options: { minContextWindow?: number } = {}
  ): Promise<FallbackCandidate | undefined> {
    const account = isAccountLevelKind(kind)
    const failedAccount = accountKeyOf(failed)
    for (const strict of [true, false]) {
      for (let index = 0; index < this.fallback.length; index++) {
        const candidate = this.fallback[index]
        if (account && accountKeyOf(candidate.config) === failedAccount) continue
        if (options.minContextWindow && candidate.config.contextWindow <= options.minContextWindow) continue
        if (strict && this.deps.health?.unavailable(candidate.config)) continue
        if (candidate.probe && !(await candidate.probe())) {
          // Nothing is listening there: it is not part of this reserve any more.
          this.deps.health?.mark(candidate.config, 'network')
          this.fallback.splice(index, 1)
          index--
          continue
        }
        this.fallback.splice(index, 1)
        return candidate
      }
    }
    return undefined
  }

  /** Makes `next` the model of the session: from the next request on it answers, and the user is told in the conversation. */
  private switchModel(next: FallbackCandidate, kind: ProviderErrorKind): void {
    const from = this.providerConfig
    this.provider = next.provider
    this.providerConfig = next.config
    // The conversation goes to a model that has not read it: a long one is summarised first.
    this.modelChanged = true
    this.lastRequestTokens = 0
    const text =
      `${from.label}/${from.model} falhou (${kind}: ${describeFailure(kind)}); continuando com ${next.config.label}/${next.config.model}. ` +
      'A conversa, o plano e a memória do projeto foram preservados.'
    // Written for the user, in the conversation (role system: no model ever reads it) and as a notice.
    this.addMessage({ id: id('msg'), role: 'system', ts: Date.now(), parts: [{ type: 'text', text }], notice: { kind: 'model_switch', level: 'warn' } })
    this.emit({
      type: 'model_switch',
      sessionId: this.deps.sessionId,
      from: { providerId: from.id, label: from.label, model: from.model },
      to: { providerId: next.config.id, label: next.config.label, model: next.config.model },
      reason: kind
    })
    // A transition between models is transcript information, not a desktop alert: the user is only notified if the
    // turn actually fails.
    this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'warn', desktop: false, text })
  }

  /**
   * The vision relay. The active model cannot read images: every picture of the conversation that has no description
   * yet is described by a model that can, and the description is written onto the picture, so it is paid for once and
   * every later request (and every model that takes over) reuses it. Nothing here throws: without a model that sees,
   * the pictures stay undescribed and the request says so.
   */
  private async describePendingImages(signal: AbortSignal, question: string): Promise<void> {
    if (this.provider.supportsVision || Date.now() < this.visionRestUntil) return
    const pending = pendingImages(this.messages)
    if (!pending.length) return
    const candidates = this.deps.vision?.candidates() ?? []
    if (!candidates.length) return
    // The newest pictures matter most; a long session of screenshots is not described from the beginning.
    const batch = pending.slice(-MAX_DESCRIBED_PER_REQUEST)
    this.emit({
      type: 'notice',
      sessionId: this.deps.sessionId,
      level: 'info',
      desktop: false,
      text: `${this.providerConfig.label}/${this.providerConfig.model} não lê imagens: ${batch.length === 1 ? 'a imagem está sendo descrita' : `${batch.length} imagens estão sendo descritas`} por ${candidates[0].config.label}/${candidates[0].config.model}.`
    })
    let described = 0
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = batch[next++]
        if (!item || signal.aborted) return
        const result = await describeImage({
          candidates,
          image: item.image,
          question,
          signal,
          onFailure: (failure) => this.deps.health?.mark(failure.config, failure.kind)
        })
        if (result) {
          recordDescription(item, result)
          described++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(VISION_PARALLEL, batch.length) }, () => worker()))
    if (signal.aborted) return
    if (!described) {
      this.visionRestUntil = Date.now() + VISION_REST_MS
      this.emit({
        type: 'notice',
        sessionId: this.deps.sessionId,
        level: 'warn',
        text: 'Nenhum modelo com visão conseguiu descrever a imagem; o modelo atual segue sem ela. Verifique o modelo de visão em Configurações → Provedores.'
      })
      return
    }
    // The chat holds its own copy of each message: send the described ones again, so their seal names who described them.
    const writtenOn = new Set(batch.filter((item) => item.image.description).map((item) => item.image))
    for (const message of this.messages) {
      const touched = message.parts.some(
        (part) => (part.type === 'image' && writtenOn.has(part)) || (part.type === 'tool_result' && part.images?.some((image) => writtenOn.has(image)))
      )
      if (touched) this.emit({ type: 'message', sessionId: this.deps.sessionId, message })
    }
    this.persist()
  }

  /**
   * Budget-driven (or forced, after a context overflow) compaction. `modelChanged`: another model is taking over a long
   * conversation; it starts from the summary and the project memory instead of paying to read 100 000 tokens of history
   * it never saw (and, if its window is smaller, instead of overflowing).
   */
  private async compact(system: string, signal: AbortSignal, force: boolean, modelChanged = false): Promise<boolean> {
    const tools = this.toolSpecs(this.availableTools())
    const estimated = estimateContextTokens(system, this.messages, tools)
    const used = Math.max(estimated, this.lastRequestTokens)
    const handover = modelChanged && used > MODEL_SWITCH_COMPACTION_TOKENS
    // Compact earlier than the hard window: every iteration re-sends the whole
    // conversation, so a 1M-context turn at 75% is needlessly expensive.
    if (!force && !handover && used < this.providerConfig.contextWindow * 0.65) return false
    if (handover && !force) {
      this.emit({
        type: 'notice',
        sessionId: this.deps.sessionId,
        level: 'info',
        desktop: false,
        text: `Outro modelo (${this.providerConfig.label}/${this.providerConfig.model}) assumiu esta conversa de ~${Math.round(used / 1000)} mil tokens: resumo o histórico para ele partir do resumo e da memória do projeto.`
      })
    }
    const run = (): ReturnType<typeof compactIfNeeded> =>
      compactIfNeeded({
        system,
        messages: this.messages,
        provider: this.provider,
        contextWindow: this.providerConfig.contextWindow,
        tools,
        usedTokens: used,
        keepRecent: force || handover ? 4 : undefined,
        force: force || handover,
        signal,
        onNote: (note) => this.emit({ type: 'notice', sessionId: this.deps.sessionId, level: 'info', text: note })
      })
    const trigger = force ? 'overflow' : 'auto'
    await this.runHook('PreCompact', { trigger }, undefined, signal)
    const result = await run()
    if (!result.compacted) return false
    const before = this.messages.length
    this.messages = result.messages
    this.lastRequestTokens = 0
    this.persist()
    await this.afterCompaction(trigger, before, signal)
    return true
  }

  private checkLimits(): string | null {
    const limits = this.deps.limits
    this.limitKind = null
    if (this.toolCallCount >= limits.maxToolCalls) {
      this.limitKind = 'tools'
      return `limite de ${limits.maxToolCalls} chamadas de ferramenta atingido`
    }
    if (Date.now() - this.startedAt > limits.maxWallClockMs) {
      this.limitKind = 'time'
      return `limite de tempo (${Math.round(limits.maxWallClockMs / 60000)} min) atingido`
    }
    const budget = effectiveMaxTokens(limits, this.providerConfig.contextWindow)
    const used = billableTokens(this.turnUsage)
    if (budget > 0 && used > budget) {
      this.limitKind = 'tokens'
      return `orçamento de tokens do turno esgotado (${used} de ${budget}; ${this.turnUsage.input} entrada, ${this.turnUsage.cachedInput ?? 0} cache, ${this.turnUsage.output} saída)`
    }
    if (limits.maxCostUsd > 0 && (this.turnUsage.costUsd ?? 0) > limits.maxCostUsd) {
      this.limitKind = 'cost'
      return `orçamento de custo do turno esgotado (US$ ${(this.turnUsage.costUsd ?? 0).toFixed(2)} de ${limits.maxCostUsd.toFixed(2)})`
    }
    return null
  }

  /** The turn ended with a step still marked active: show it as blocked (not as work in progress) and keep it for the next turn. */
  private blockActivePlanItems(): void {
    if (!this.plan.some((item) => item.status === 'active')) return
    const items = this.plan.map((item) => (item.status === 'active' ? { ...item, status: 'blocked' as const, endedAt: Date.now() } : item))
    this.plan = items
    this.emit({ type: 'plan', sessionId: this.deps.sessionId, items })
    this.persist()
  }

  /**
   * The plan is the user's view of the work: when many iterations pass without the agent writing it and steps are still open,
   * a hidden reminder asks it to bring the plan up to date (steps that finished, the one it is on). A few times per turn, for
   * the user's own session only: a subagent's plan is not on the screen.
   */
  private remindAboutPlan(iteration: number): void {
    if (this.deps.depth || this.planReminders >= MAX_PLAN_REMINDERS) return
    const open = this.plan.filter((item) => item.status === 'pending' || item.status === 'active')
    if (!open.length) return
    const quiet = iteration - Math.max(this.planTouchedAt, this.planRemindedAt)
    if (quiet < PLAN_REMINDER_EVERY) return
    this.planRemindedAt = iteration
    this.planReminders++
    this.hiddenUserMessage(
      [
        '<plan-reminder>',
        `Faz ${quiet} iterações que o plano não é atualizado. Passos ainda em aberto:`,
        ...open.map((item) => `- [${item.status}] ${item.text}`),
        'Se algum passo já terminou, marque-o como done com update_plan agora e indique o que está fazendo (o usuário acompanha o plano na tela). Depois continue o trabalho; não pare por causa deste aviso.',
        '</plan-reminder>'
      ].join('\n')
    )
  }

  /**
   * The review round before a turn that changed files ends: the diff of what the turn changed (bounded) and what to
   * check. Null when there is nothing to review: no file changed, a subagent (its caller reviews), read-only or chat,
   * or the user turned it off.
   */
  private selfReviewPrompt(): string | null {
    if (this.deps.selfReview === false || this.deps.depth) return null
    if (this.deps.policy.mode === 'readonly' || this.deps.mode === 'ask' || this.deps.surface === 'chat') return null
    const changes = this.deps.tracker.turnChanges?.() ?? []
    if (!changes.length) return null
    const added = changes.reduce((sum, change) => sum + change.additions, 0)
    const removed = changes.reduce((sum, change) => sum + change.deletions, 0)
    let diff = ''
    for (const change of changes) {
      if (diff.length + change.diff.length > SELF_REVIEW_DIFF_CHARS) {
        diff += `\n… o diff de ${change.path} e dos seguintes ficou de fora (grande demais): veja com git_diff ou read_file.\n`
        break
      }
      diff += `${change.diff.trimEnd()}\n`
    }
    return [
      '<self-review>',
      `Antes de encerrar, revise o que você mudou neste turno: ${changes.length} arquivo(s), +${added} -${removed}.`,
      ...changes.map((change) => `- ${change.path} (${change.status}, +${change.additions} -${change.deletions})`),
      '',
      'Confira:',
      '- Faz o que o usuário pediu, inteiro? Falta algum arquivo ou caso?',
      '- Há erro, sobra de depuração (console.log, print, TODO), código morto ou mudança fora do pedido?',
      '- Se dava para verificar (teste, typecheck, build, rodar), você verificou e leu a saída?',
      'Se achar um problema, corrija agora com as ferramentas. Se estiver certo, responda só com uma confirmação curta, sem repetir o resumo.',
      '<diff>',
      diff.trimEnd(),
      '</diff>',
      '</self-review>'
    ].join('\n')
  }

  private budgetInfo(iteration: number, kindOverride?: BudgetInfo['kind']): BudgetInfo {
    const cost = this.limitKind === 'cost'
    const iterations = kindOverride === 'iterations'
    return {
      kind: kindOverride ?? (cost ? 'cost' : 'tokens'),
      used: iterations ? iteration : cost ? (this.turnUsage.costUsd ?? 0) : billableTokens(this.turnUsage),
      limit: iterations ? this.deps.limits.maxIterations : cost ? this.deps.limits.maxCostUsd : effectiveMaxTokens(this.deps.limits, this.providerConfig.contextWindow),
      input: this.turnUsage.input,
      output: this.turnUsage.output,
      cachedInput: this.turnUsage.cachedInput ?? 0,
      iterations: iteration,
      toolCalls: this.toolCallCount,
      contextTokens: this.lastRequestTokens,
      contextWindow: this.providerConfig.contextWindow
    }
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

      if (
        !this.availableTools().includes(call.name) &&
        (DEFERRED_ESSENTIAL_TOOL_NAMES.has(call.name) || toolsForMode(this.deps.mode).includes(call.name))
      ) {
        // A built-in tool of this mode the model asked for by name (a former essential, or a deferred one such as
        // computer_screenshot): load it and run the call instead of refusing it. The refusal cost a model call, and models
        // that did not follow the "tool_search, then tool_load" hint gave up or improvised (seen with computer_screenshot in
        // the Chat). loadTools still refuses what the policy does not allow, and the call still goes through validation and
        // approval. MCP tools keep the explicit tool_load: they act on other systems.
        this.loadTools([call.name])
      }

      if (!this.availableTools().includes(call.name)) {
        const loadable =
          toolsForMode(this.deps.mode).includes(call.name) ||
          this.indirectMcpTools().includes(call.name) ||
          this.mcpToolDefs().some((def) => def.name === call.name)
        const hint = loadable
          ? `use tool_search para encontrá-la e tool_load para habilitá-la neste turno (se já sabe o nome: tool_load({ "tools": ["${call.name}"] }) e repita a chamada)`
          : `não disponível no modo ${this.deps.mode}`
        results.set(call.id, {
          ok: false,
          text: `a ferramenta ${call.name} não está carregada: ${hint}`
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
        if (this.repeatedCalls >= 4) this.toolLoopTripped = true
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
          risk: evaluation.risk ?? tool.risk,
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
      // The user stopped the turn while earlier calls of this batch were running: the rest must not
      // start (they would still edit files or ask for new approvals after "Parar").
      if (signal.aborted) {
        const skipped: ToolResult = { ok: false, text: 'não executada: o usuário interrompeu o turno antes desta ferramenta começar.' }
        results.set(item.call.id, skipped)
        this.emit({ type: 'tool_end', sessionId: this.deps.sessionId, toolCallId: item.call.id, name: item.call.name, ok: false, summary: 'cancelada' })
        return skipped
      }
      const started = Date.now()
      this.emit({
        type: 'tool_start',
        sessionId: this.deps.sessionId,
        toolCallId: item.call.id,
        name: item.call.name,
        args: item.call.args
      })
      const toolCtx: ToolContext = {
        ...ctx,
        toolCallId: item.call.id,
        vision: this.provider.supportsVision,
        model: this.providerConfig.model,
        progress: (text, data) =>
          this.emit({
            type: 'tool_progress',
            sessionId: this.deps.sessionId,
            toolCallId: item.call.id,
            name: item.call.name,
            text,
            data
          })
      }
      let result: ToolResult
      try {
        result = await withTimeout(
          item.tool.execute(item.call.args, toolCtx),
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
      this.recordPlanActivity(item.call, result, started, Date.now())
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
