/**
 * Shared contracts between the harness (main process), the IPC bridge and the
 * renderer. Nothing in this file may import Electron or Node APIs.
 */

export type AgentMode =
  | 'ask'
  | 'plan'
  | 'code'
  | 'debug'
  | 'review'
  | 'computer'
  | 'web'
  | 'autonomous'

export const AGENT_MODES: AgentMode[] = [
  'ask',
  'plan',
  'code',
  'debug',
  'review',
  'computer',
  'web',
  'autonomous'
]

/**
 * The mode a new session opens in on each surface. Chat opens in Computer Use: a request like "crie uma pasta na minha área de
 * trabalho" has to be done, not explained (the read-only "ask" mode is still one click away in the composer).
 */
export function defaultAgentMode(surface: 'chat' | 'cowork' | 'code'): AgentMode {
  return surface === 'chat' ? 'computer' : surface === 'cowork' ? 'autonomous' : 'code'
}

export type PermissionMode = 'readonly' | 'ask' | 'accept-edits' | 'auto' | 'unrestricted'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  /** base64, no data: prefix */
  data: string
  label?: string
  /**
   * What a model that CAN read images saw in this picture, written for models that cannot (the vision relay, see
   * core/vision). It travels with the image, so the picture is described once and every later request reuses it.
   */
  description?: string
  /** `provider/model` that wrote `description`. */
  describedBy?: string
  /**
   * Where the picture went when it was stored, so the chat can say whether the model really saw it: `model` reads it,
   * `relay` is described first by a model with vision (then `description` is set), `none` reaches no model. Display only.
   */
  delivery?: 'model' | 'relay' | 'none'
}

export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  args: unknown
}

export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  name: string
  ok: boolean
  text: string
  images?: ImagePart[]
  /** ToolResult.preview: shown in the chat, never sent to a model. */
  preview?: ImagePart[]
  detail?: string
  /**
   * Descriptions of `images` written by the vision relay. The pictures themselves are not stored with the session;
   * the descriptions are, so a model that cannot read images still knows what each screenshot showed.
   */
  imageDescriptions?: string[]
}

/**
 * Model reasoning kept on assistant messages. Some OpenAI-compatible models
 * (Kimi/DeepSeek thinking) require it to be echoed back between tool calls.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

/** Structured self-analysis shown as a card in the transcript. */
export interface LimitationReport {
  title: string
  goal: string
  error: string
  difficulty: string
  suggestion: string
  workaround?: string
  /** Actions the agent tried before stopping, with a short outcome. */
  attempts?: string[]
  severity?: 'blocked' | 'degraded'
  /** True when the harness produced the report (not the model's report_limitation call). */
  automatic?: boolean
}

export interface LimitationPart {
  type: 'limitation'
  report: LimitationReport
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart | ReasoningPart | LimitationPart

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** Reasoning depth the user picks per session (Claude Desktop: Baixo/Médio/Alto/Extra/Máx). */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The assistant content exactly as the provider returned it. Anthropic thinking
 * blocks carry signatures and must be replayed unchanged, in order, in later
 * requests; `parts` alone cannot reproduce them.
 */
export interface ProviderBlocks {
  kind: 'anthropic'
  model: string
  blocks: unknown[]
}

export interface Message {
  id: string
  role: MessageRole
  parts: ContentPart[]
  ts: number
  /** Raw provider content for faithful replay (Anthropic thinking blocks). */
  providerBlocks?: ProviderBlocks
  /** Sub-agent / compaction messages are hidden from the main transcript. */
  hidden?: boolean
  model?: string
  usage?: Usage
  error?: string
  /**
   * A line the harness wrote for the USER, shown in the conversation (a model switch, for instance). Such a message has
   * role 'system': providers skip it, so no model ever reads it.
   */
  notice?: { kind: 'model_switch'; level: 'info' | 'warn' }
}

export interface Usage {
  input: number
  output: number
  cachedInput?: number
  costUsd?: number
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export type StopReason = 'stop' | 'tool_use' | 'length' | 'error'

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'provider_blocks'; kind: 'anthropic'; model: string; blocks: unknown[] }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'end'
      stopReason: StopReason
      toolCalls: ToolCall[]
      error?: string
      retryable?: boolean
      /** Classified provider failure, used by the loop to compact or back off. */
      errorKind?: ProviderErrorKind
    }

export type ProviderErrorKind =
  | 'context_overflow'
  | 'rate_limit'
  | 'overloaded'
  | 'auth'
  | 'quota'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown'

export interface ModelRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  temperature?: number
  maxTokens?: number
  /** 'none' keeps the tool definitions (cache-friendly) but forbids calling them. */
  toolChoice?: 'auto' | 'none'
  /** Per-session reasoning depth; providers map it to what their API supports. */
  effort?: ReasoningEffort
  /**
   * false: answer straight away, without a thinking phase, where the server can be told so (llama.cpp passes it to the
   * chat template). A local Qwen describing a picture spent its whole token budget thinking and answered nothing.
   */
  thinking?: boolean
  signal?: AbortSignal
  /**
   * The caller has another model to move to when this one fails: do not wait out a long rate-limit pause and retry at
   * most once, so the switch happens in seconds instead of minutes.
   */
  fastFail?: boolean
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Provider {
  readonly id: string
  readonly label: string
  readonly supportsVision: boolean
  readonly contextWindow: number
  stream(req: ModelRequest): AsyncGenerator<ProviderEvent, void, unknown>
  /** Rough token estimate for a request, used for context accounting. */
  countTokens(text: string): number
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'read' | 'write' | 'exec' | 'network' | 'destructive'

export interface ToolResult {
  ok: boolean
  /** Text handed back to the model. */
  text: string
  /** Absolute paths touched, used by the UI and by file-lock tracking. */
  files?: string[]
  images?: ImagePart[]
  /**
   * Pictures for the chat only, never sent to any model: what a tool looked at when the model gets text instead (the
   * PDF page an OCR read, the image file it read), so the user sees what was read. Keep them few and small.
   */
  preview?: ImagePart[]
  /** Short human-facing summary for the transcript card. */
  summary?: string
  /** Structured payload for the UI (diff, exit code, etc). */
  data?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export type Decision = 'allow' | 'ask' | 'deny'

export interface ApprovalRequest {
  id: string
  tool: string
  title: string
  detail: string
  risk: RiskLevel
  /** Machine-readable preview (command line, path, url...). */
  preview?: string
  sessionId: string
  /** Permission engine: what the action does (tool name). */
  action?: string
  /** Permission engine: the concrete resource (path, command, URL). */
  resource?: string
  /** Permission engine: read | write | execute | network | control | destructive. */
  effect?: PermissionEffect
}

export type PermissionEffect = 'read' | 'write' | 'execute' | 'network' | 'control' | 'destructive'

/** What the user decided; the reason is fed back to the model verbatim. */
export interface ApprovalDecision {
  approved: boolean
  reason?: string
}

export interface ApprovalResponse {
  id: string
  approved: boolean
  /** When true the same tool+preview is allowed for the rest of the session. */
  always?: boolean
  reason?: string
}

/* ------------------------------------------------------------------ */
/* Questions to the user (ask_user)                                    */
/* ------------------------------------------------------------------ */

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionSpec {
  /** Short label shown above the question ("Backend", "Prazo"). */
  header: string
  question: string
  /** Concrete choices. Without options the user gets a free-text field. */
  options?: QuestionOption[]
  /** Allow checking more than one option. */
  multi?: boolean
  /** Offer a free-text answer in addition to the options (default true). */
  allowOther?: boolean
}

export interface QuestionAttachment {
  name: string
  /** Absolute path the agent can read with its file/shell tools. */
  path: string
  kind: 'file' | 'folder'
}

export interface QuestionAnswer {
  header: string
  answers: string[]
  attachments?: QuestionAttachment[]
}

export interface QuestionRequest {
  id: string
  sessionId: string
  questions: QuestionSpec[]
}

/**
 * What the next request of a session would carry, measured from the real system prompt, tool schemas and history (not
 * guessed): the context meter shows it, and it tells where the tokens go.
 */
export interface ContextBreakdown {
  items: Array<{ id: string; label: string; tokens: number }>
  /** Sum of the items. */
  total: number
  /** Context window of the session's model. */
  window: number
  /** Size the provider reported for the last real request (0 before the first one). */
  lastRequest: number
}

/** Why a turn stopped at its budget, with enough detail for the UI and logs. */
export interface BudgetInfo {
  /** `iterations`: the turn used up its iteration cap (`used` and `limit` count iterations). */
  kind: 'tokens' | 'cost' | 'iterations'
  used: number
  limit: number
  input: number
  output: number
  cachedInput: number
  iterations: number
  toolCalls: number
  contextTokens: number
  contextWindow: number
}

export interface PolicyConfig {
  mode: PermissionMode
  /** Additional deny patterns, e.g. ["git push", "npm publish"]. */
  blockedCommands: string[]
  /** Filesystem roots the agent may write to. Reads are limited to these too. */
  allowedRoots: string[]
  /**
   * Personal-workstation mode: the agent may read/write any absolute path, not
   * only the project roots. Dangerous commands and secret files still ask.
   */
  fullAccess?: boolean
  /** Allow network tools (fetch, browser, web search). */
  allowNetwork: boolean
  /** Allow computer-use tools to move the real mouse/keyboard. */
  allowComputerControl: boolean
  /** Maximum seconds a single shell command may run. */
  shellTimeoutSec: number
  /**
   * Permission rules in Claude Code syntax: "Tool" or "Tool(pattern)", e.g.
   * "Bash(npm test:*)", "Edit(src/**)", "Read(./.env)". Evaluated deny > ask >
   * allow before the permission mode.
   */
  rules?: PermissionRules
}

export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

/* ------------------------------------------------------------------ */
/* Hooks (same JSON shape as Claude Code's settings "hooks" key)        */
/* ------------------------------------------------------------------ */

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'PreCompact'
  | 'PostCompact'
  | 'SessionEnd'
  | 'Notification'

export interface HookCommand {
  type: 'command'
  command: string
  /** Seconds; defaults to 60. */
  timeout?: number
}

/** POSTs the event payload as JSON; only http(s) URLs are accepted. */
export interface HookHttp {
  type: 'http'
  url: string
  /** Seconds; defaults to 60. */
  timeout?: number
  /** Literal header values (no environment expansion). */
  headers?: Record<string, string>
}

export type HookDefinition = HookCommand | HookHttp

export interface HookMatcher {
  /** Regex over the tool name (Openclod or Claude Code alias). Empty matches all. */
  matcher?: string
  hooks: HookDefinition[]
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

/* ------------------------------------------------------------------ */
/* Events emitted by the harness                                       */
/* ------------------------------------------------------------------ */

/** A provider and the model of it a session talks to. */
export interface ModelRef {
  providerId: string
  label: string
  model: string
}

export type HarnessEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'turn_start'; sessionId: string; messageId: string }
  | { type: 'text_delta'; sessionId: string; messageId: string; text: string }
  | { type: 'reasoning_delta'; sessionId: string; messageId: string; text: string }
  | { type: 'message'; sessionId: string; message: Message }
  | {
      type: 'tool_start'
      sessionId: string
      toolCallId: string
      name: string
      args: unknown
      /** Set on events forwarded from a subagent: its `childId`. Absent for the session's own tools. */
      agentId?: string
    }
  | {
      type: 'tool_progress'
      sessionId: string
      toolCallId: string
      name: string
      /** Last chunk of live output. UI-only; never added to the model context. */
      text?: string
      data?: Record<string, unknown>
      agentId?: string
    }
  | {
      type: 'tool_end'
      sessionId: string
      toolCallId: string
      name: string
      ok: boolean
      summary: string
      text?: string
      files?: string[]
      data?: Record<string, unknown>
      /** See `tool_start.agentId`. */
      agentId?: string
    }
  | { type: 'approval_request'; sessionId: string; request: ApprovalRequest }
  | { type: 'approval_resolved'; sessionId: string; id: string; approved: boolean }
  | { type: 'question_request'; sessionId: string; request: QuestionRequest }
  | { type: 'question_resolved'; sessionId: string; id: string; answers: QuestionAnswer[] }
  | { type: 'budget'; sessionId: string; info: BudgetInfo }
  | { type: 'limitation'; sessionId: string; report: LimitationReport }
  | { type: 'plan'; sessionId: string; items: PlanItem[] }
  | { type: 'usage'; sessionId: string; usage: Usage; total: Usage; turn?: Usage; limit?: number; providerId?: string; providerLabel?: string; model?: string; costUsd?: number }
  | { type: 'status'; sessionId: string; state: RunState; detail?: string }
  | { type: 'audit'; sessionId: string; level: AuditLevel; message: string }
  | { type: 'diff'; sessionId: string; files: FileChange[] }
  | {
      /**
       * A subagent started (state 'thinking', with startedAt/prompt) or ended
       * (state 'done' | 'error' | 'cancelled', with endedAt/summary).
       * `sessionId` is always the user's (root) session, even for nested calls.
       */
      type: 'subagent'
      sessionId: string
      childId: string
      label: string
      state: RunState
      /** Name of the agent definition that runs this child. */
      agent?: string
      /** `providerId/model` the child talks to. */
      model?: string
      /** `childId` of the caller; absent when the user's session called it. */
      parentChildId?: string
      /** 1 = called by the user's session, 2 = called by a child, ... */
      depth?: number
      startedAt?: number
      endedAt?: number
      /** Task given to the child (start event only). */
      prompt?: string
      /** First 400 characters of the child's answer (or of its error), on the end event. */
      summary?: string
    }
  | { type: 'turn_end'; sessionId: string; messageId: string; stopReason: StopReason; error?: string; /** The user stopped the turn: not a failure. */ cancelled?: boolean }
  | { type: 'notice'; sessionId: string; level: 'info' | 'warn' | 'error'; text: string; desktop?: boolean }
  | {
      /**
       * The session moved to another model because the one it was on could not answer. The main process saves the new
       * provider/model on the session, and the composer shows it.
       */
      type: 'model_switch'
      sessionId: string
      from: ModelRef
      to: ModelRef
      reason: ProviderErrorKind
    }
  | { type: 'settings_changed'; sessionId: string; scope: 'mcp' | 'browser' | 'general' }

export type RunState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool'
  | 'waiting_approval'
  | 'cancelled'
  | 'error'
  | 'done'

export type AuditLevel = 'info' | 'warn' | 'blocked'

export interface PlanStepActivity {
  id: string
  name: string
  kind: 'command' | 'tool' | 'agent'
  title: string
  status: 'done' | 'failed'
  startedAt: number
  endedAt: number
  detail?: string
  /** Tail of the tool output, capped; persisted with the session. */
  output?: string
  exitCode?: number
}

export interface PlanItem {
  id: string
  text: string
  status: 'pending' | 'active' | 'done' | 'blocked'
  /** Stamped by the runner when the item starts/finishes; used by the plan UI. */
  startedAt?: number
  endedAt?: number
  /** The app closed while this item was active; the next turn must resume it. */
  interrupted?: boolean
  /** What the agent did while this item was active, persisted with the plan. */
  activity?: PlanStepActivity[]
}

export interface FileChange {
  path: string
  status: 'modified' | 'added' | 'deleted'
  additions: number
  deletions: number
  diff: string
}

/* ------------------------------------------------------------------ */
/* Sessions / projects                                                 */
/* ------------------------------------------------------------------ */

export interface ProviderConfig {
  id: string
  kind: 'openai' | 'anthropic'
  label: string
  baseUrl: string
  model: string
  apiKeyRef?: string
  contextWindow: number
  supportsVision: boolean
  supportsTools: boolean
  /** Models offered by the model picker; the active `model` is always first. */
  models?: string[]
  /**
   * Models of `models` known to read images (filled by "Detectar modelos" when the server says so). When present it
   * decides per model; `supportsVision` stays the answer for providers that do not tell.
   */
  visionModels?: string[]
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  /** Cost of cache-hit input tokens; falls back to the normal input rate. */
  cachedInputCostPerMTok?: number
  temperature?: number
  /** Output token cap sent with each request (provider default when unset). */
  maxOutputTokens?: number
  /** Per-model wire quirks; unset fields are auto-detected from the model id. */
  compat?: ModelCompat
  /** Explicit effort levels this provider/model accepts; empty = auto-detect. */
  effortLevels?: ReasoningEffort[]
  /** Effort applied to new sessions of this provider; unset = automatic. */
  defaultEffort?: ReasoningEffort
  /** Set on the provider made by Settings → Provedores → Google Colab (GPU): where the model runs and which notebook made it. */
  colab?: ColabLinkInfo
}

/** What the app remembers about the Colab server a provider points to. Never holds the key (that is in the vault). */
export interface ColabLinkInfo {
  host: string
  gpu: string
  vramMiB?: number
  notebookVersion: string
  engine?: string
  connectedAt: number
  /** The notebook's server module is the one this build ships. Informative only: a server can claim anything. */
  verified?: boolean
}

export interface ModelCompat {
  /** Do not send `temperature` (OpenAI o-series / gpt-5 reject it). */
  omitTemperature?: boolean
  /** Name of the output cap field for OpenAI-compatible APIs. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Echo previous reasoning back as `reasoning_content` (Kimi/DeepSeek thinking + tools). */
  echoReasoning?: boolean
  /** Anthropic prompt caching (cache_control breakpoints). Defaults to true. */
  promptCaching?: boolean
  /** Send `reasoning_effort` on OpenAI-compatible endpoints (default: only for o-series / gpt-5). */
  reasoningEffort?: boolean
}

export interface SkillInfo {
  name: string
  description: string
  source: 'usuario' | 'projeto'
}

export type EnvironmentKind = 'local' | 'wsl' | 'ssh' | 'cloud'

export interface EnvironmentProfile {
  id: string
  label: string
  kind: EnvironmentKind
  /** For ssh/cloud: command prefix, e.g. `ssh user@host` or `docker exec -i box`. */
  command?: string
  /** Remote working directory for ssh/cloud. */
  remoteCwd?: string
  /** WSL distribution name; empty uses the default distro. */
  distro?: string
}

export interface SessionMeta {
  id: string
  title: string
  projectId: string
  cwd: string
  mode: AgentMode
  /** Which desktop tab created the session: chat, cowork or code. */
  surface?: SessionSurface
  /** Execution environment profile id; missing means local. */
  environment?: string
  providerId: string
  model: string
  /** Reasoning depth; unset means the model's own default. */
  effort?: ReasoningEffort
  createdAt: number
  updatedAt: number
  totalUsage: Usage
  archived?: boolean
}

export type SessionSurface = 'chat' | 'cowork' | 'code'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  lastOpenedAt: number
  /** Default LLM for sessions in this project; other projects keep their own. */
  model?: { providerId: string; model: string }
}

export interface SessionState {
  meta: SessionMeta
  messages: Message[]
  plan: PlanItem[]
  changes: FileChange[]
  approvals: ApprovalRequest[]
  usage: Usage
  state: RunState
}

export interface SessionSummary {
  meta: SessionMeta
  messageCount: number
  preview: string
}

export interface HarnessLimits {
  maxIterations: number
  maxToolCalls: number
  maxWallClockMs: number
  /** Cumulative turn cap. 0 = automatic: max(6M, 10 × contextWindow). */
  maxTokens: number
  maxCostUsd: number
  maxParallelTools: number
  /** How many levels of agents may call agents (the user's session is level 0). Default 3. */
  maxAgentDepth?: number
}

export const DEFAULT_LIMITS: HarnessLimits = {
  maxIterations: 60,
  maxToolCalls: 400,
  maxWallClockMs: 45 * 60 * 1000,
  maxTokens: 0,
  maxCostUsd: 10,
  maxParallelTools: 4
}

/* ------------------------------------------------------------------ */
/* Agents (multi-agent definitions; loaded from markdown by core/agents) */
/* ------------------------------------------------------------------ */

export type AgentSource = 'builtin' | 'user' | 'project'

/** One specialist the harness can run as the user's session helper or as a subagent. */
export interface AgentDefinition {
  /** kebab-case id (also the file name without `.md`). */
  name: string
  /** When to use this agent. Shown to the model in the `agent` tool description. */
  description: string
  systemPrompt: string
  /** Defaults to 'code'. */
  mode?: AgentMode
  /** Allowlist of tool names (globs such as `browser_*` allowed). Undefined = every tool the mode allows. */
  tools?: string[]
  disallowedTools?: string[]
  /** Agents this one may delegate to: names, or '*' for any. Default: none. */
  canCall?: string[] | '*'
  /** 'inherit' (default) = the caller's provider and model; else `providerId/model` or a model id of the caller's provider. */
  model?: 'inherit' | string
  effort?: ReasoningEffort
  /** Cap on model iterations (becomes limits.maxIterations). */
  maxTurns?: number
  color?: string
  /** Hidden agents are internal utilities: never listed to the model, never callable through `agent`. */
  hidden?: boolean
  source: AgentSource
  /** Absolute path of the markdown file that defined it (absent for built-ins). */
  file?: string
  /** True when read from a Claude Code folder (`.claude/agents`); such files are never written by Openclod. */
  imported?: boolean
}

export interface AgentLoadWarning {
  /** File the problem was found in (or the directory, when it could not be read). */
  file: string
  message: string
}

/** What the UI shows in the agents list. */
export interface AgentsListing {
  agents: AgentDefinition[]
  warnings: AgentLoadWarning[]
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface HarnessSelfRepairSettings {
  /** Allow the agent to open a repair session and modify/build the harness itself. */
  enabled: boolean
  /** Source checkout of Openclod Desktop. Empty disables the feature. */
  repoPath: string
  /** Relaunch Openclod after a repair session ends with HARNESS_OK. */
  restartAfterRepair: boolean
}

export interface AppSettings {
  providers: ProviderConfig[]
  defaultProviderId: string
  policy: PolicyConfig
  limits: HarnessLimits
  theme: 'dark' | 'light'
  /** How the assistant should address the user (Home greeting). */
  profileName?: string
  telemetry: false
  /** Team mode: split work across specialist agents (also on at max effort). */
  autoAgents?: boolean
  /** Before a turn that changed files ends, the agent reviews its own diff once (on unless false). */
  selfReview?: boolean
  /** Execution environments shown in the composer. */
  environments?: EnvironmentProfile[]
  /**
   * Move the conversation to the next working model/provider when the one in use runs out of balance, hits a rate
   * limit, refuses the key or goes down. On by default.
   */
  useAllModels?: boolean
  /** Providers in the order the reserve tries them (ids). Providers not listed follow, in the order they are listed. */
  fallbackOrder?: string[]
  /** Providers that must never be used as a reserve. */
  fallbackExclude?: string[]
  /**
   * Which models of each provider take part in the reserve (the boxes ticked in Settings → Ordem da reserva), by provider id.
   * No entry: only the provider's own model. An empty list: none of its models (the provider is out of the line).
   */
  fallbackModels?: Record<string, string[]>
  /**
   * Model that describes images for models that cannot read them (the vision relay). Unset = the first reserve
   * provider with a credential and a model known to read images.
   */
  visionModel?: { providerId: string; model: string }
  /** Last provider/model picked by the user; survives restarts. */
  lastModel?: { providerId: string; model: string }
  /** Opt-in self-evolution: repair the harness when it detects a limitation. */
  selfRepair?: HarnessSelfRepairSettings
  /** The Claude Desktop/Code catalog (skills, agents, MCPs) was imported once. */
  claudeCatalogImported?: boolean
  mcpServers: McpServerSettings[]
  /** User-level hooks (Claude Code format). */
  hooks?: HooksConfig
  /** Browser automation target. Auto uses an attached Chrome extension when available. */
  browser?: {
    mode: 'auto' | 'chrome-existing' | 'playwright'
    /** Give each Openclod session its own named Chrome tab group. */
    groupBySession?: boolean
    /** "Chrome existente" without the extension: open an isolated Chromium instead of failing. Default true. */
    fallbackToManaged?: boolean
  }
  /**
   * Also read `.claude/settings.json` / `.claude/settings.local.json` of the
   * project (permissions + hooks), like Claude Code does. Off by default
   * because project hooks run commands.
   */
  importClaudeSettings?: boolean
  /** Dictation: Whisper model size, language and the Wispr-Flow-style behavior. */
  voice?: {
    model: string
    language: string
    /** Electron accelerator. Empty/absent = no global shortcut; the mic button still works. */
    shortcut?: string
    /** Show the floating Wispr-Flow-style pill. Off by default: text goes straight to the field. */
    overlay?: boolean
    /** toggle = press to start, press again to insert; hold is reserved for a native key hook. */
    mode?: 'toggle' | 'hold'
    /** Send the final text through the current model to fix punctuation/filler (costs tokens). */
    polish?: boolean
    /** Where the final text goes when Openclod is not focused. */
    insert?: 'composer' | 'focused'
    /** Read assistant responses with the native Windows speech synthesizer. */
    ttsProvider?: 'windows' | 'edge'
    ttsVoice?: string
    /** System.Speech rate, -10..10. */
    ttsRate?: number
    /** System.Speech volume, 0..100. */
    ttsVolume?: number
  }
  /** Desktop notification filters. Internal activity is always recorded. */
  notifications?: NotificationPreferences
  updates?: {
    feedUrl?: string
    autoCheck?: boolean
  }
  /** Settings schema version, used for one-time migrations. */
  settingsVersion?: number
}

export interface NotificationPreferences {
  desktop: boolean
  turnFinished: boolean
  failures: boolean
  approvals: boolean
  minimumSeverity: 'info' | 'success' | 'warning' | 'error'
  quietStart?: string
  quietEnd?: string
}

export interface McpServerSettings {
  name: string
  /** Transport. Missing means stdio, matching Claude Desktop's config. */
  type?: 'stdio' | 'http' | 'sse'
  /** Remote endpoint for http/sse transports. */
  url?: string
  /** Static headers for remote servers (Authorization, X-Api-Key, ...). */
  headers?: Record<string, string>
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
  /** Working directory of the server process (defaults to the app's cwd). */
  cwd?: string
  /** Per-request timeout for tools/call, in ms (default 120 000). */
  timeoutMs?: number
  /** Timeout for the initialize + tools/list handshake, in ms (default 20 000). */
  startTimeoutMs?: number
  /**
   * Tool filter over the server's own tool names; `*` and `?` are wildcards.
   * When `includeTools` is non-empty only matching tools are exposed;
   * `excludeTools` then removes matches (exclude wins).
   */
  includeTools?: string[]
  excludeTools?: string[]
  /** Tools (same patterns) that must always ask for approval, even in auto mode. */
  approvalTools?: string[]
  /**
   * Per-tool permission over the server's own tool names (exact name or glob; `'*'` is the server default).
   * 'deny' hides and blocks the tool, 'ask' always asks (even in unrestricted mode), 'allow' skips the
   * prompt when the app policy allows it. An exact name beats a glob; both beat `approvalTools`.
   */
  toolPolicy?: Record<string, 'allow' | 'ask' | 'deny'>
  /** Largest tool result handed to the model, in tokens (default 25 000; `MAX_MCP_OUTPUT_TOKENS` overrides it). */
  maxOutputTokens?: number
  /**
   * true: this server's tools are always sent to the model; false: always found with tool_search;
   * unset: sent when the total number of MCP tools is small, deferred otherwise (like Claude Code's `alwaysLoad`).
   */
  alwaysLoad?: boolean
  /**
   * stdio servers get only what a program needs from Openclod's environment (PATH, TEMP, the user folders, proxies)
   * plus their own `env`. true passes the whole environment, for a server that reads a variable set on the system.
   */
  inheritEnv?: boolean
}

export interface ComputerStatus {
  available: boolean
  backend: 'open-computer-use' | 'native' | 'none'
  detail: string
  platform: string
  screen?: { width: number; height: number }
}

export interface BrowserStatus {
  available: boolean
  detail: string
  engine?: string
  mode?: 'auto' | 'chrome-existing' | 'playwright'
  /** True when the companion Chrome extension is attached to the native host. */
  attached?: boolean
  browser?: string
  /** Version reported by the extension in its hello message. */
  extensionVersion?: string
}

export interface MCPStatus {
  name: string
  command: string
  state: 'stopped' | 'starting' | 'ready' | 'error'
  tools: string[]
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>
  prompts: Array<{
    name: string
    description?: string
    arguments: Array<{ name: string; description?: string; required?: boolean }>
  }>
  error?: string
}

export interface CapabilityReport {
  computer: ComputerStatus
  browser: BrowserStatus
  mcp: MCPStatus[]
  providers: {
    id: string
    label: string
    configured: boolean
    reachable?: boolean
    /** The failure the harness is working around right now (no balance, refused key...), until `until`. */
    unavailable?: { kind: ProviderErrorKind; since: number; until: number; cloud?: boolean }
  }[]
  /** Language toolchains found on this machine (Go, Rust, Python, Node…). */
  toolchains?: Array<{ id: string; label: string; version: string; command: string }>
  node: string
  platform: string
}
