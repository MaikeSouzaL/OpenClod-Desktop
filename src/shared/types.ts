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

export type PermissionMode = 'readonly' | 'ask' | 'accept-edits' | 'auto'

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
  detail?: string
}

/**
 * Model reasoning kept on assistant messages. Some OpenAI-compatible models
 * (Kimi/DeepSeek thinking) require it to be echoed back between tool calls.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart | ReasoningPart

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
  signal?: AbortSignal
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
}

export interface ApprovalResponse {
  id: string
  approved: boolean
  /** When true the same tool+preview is allowed for the rest of the session. */
  always?: boolean
  reason?: string
}

export interface PolicyConfig {
  mode: PermissionMode
  /** Additional deny patterns, e.g. ["git push", "npm publish"]. */
  blockedCommands: string[]
  /** Filesystem roots the agent may write to. Reads are limited to these too. */
  allowedRoots: string[]
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
  /** Regex over the tool name (Forja or Claude Code alias). Empty matches all. */
  matcher?: string
  hooks: HookDefinition[]
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

/* ------------------------------------------------------------------ */
/* Events emitted by the harness                                       */
/* ------------------------------------------------------------------ */

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
  | { type: 'plan'; sessionId: string; items: PlanItem[] }
  | { type: 'usage'; sessionId: string; usage: Usage; total: Usage }
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
  | { type: 'turn_end'; sessionId: string; messageId: string; stopReason: StopReason; error?: string }
  | { type: 'notice'; sessionId: string; level: 'info' | 'warn' | 'error'; text: string }

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

export interface PlanItem {
  id: string
  text: string
  status: 'pending' | 'active' | 'done' | 'blocked'
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
  kind: 'openai' | 'anthropic' | 'mock'
  label: string
  baseUrl: string
  model: string
  apiKeyRef?: string
  contextWindow: number
  supportsVision: boolean
  supportsTools: boolean
  /** Models offered by the model picker; the active `model` is always first. */
  models?: string[]
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  temperature?: number
  /** Output token cap sent with each request (provider default when unset). */
  maxOutputTokens?: number
  /** Per-model wire quirks; unset fields are auto-detected from the model id. */
  compat?: ModelCompat
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

export interface SessionMeta {
  id: string
  title: string
  projectId: string
  cwd: string
  mode: AgentMode
  /** Which desktop tab created the session: chat, cowork or code. */
  surface?: SessionSurface
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
  maxTokens: 3_000_000,
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
  /** True when read from a Claude Code folder (`.claude/agents`); such files are never written by Forja. */
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

export interface AppSettings {
  providers: ProviderConfig[]
  defaultProviderId: string
  policy: PolicyConfig
  limits: HarnessLimits
  theme: 'dark' | 'light'
  telemetry: false
  /** Team mode: split work across specialist agents (also on at max effort). */
  autoAgents?: boolean
  /** Try the next model/provider when one runs out of quota or is unavailable. */
  useAllModels?: boolean
  /** Last provider/model picked by the user; survives restarts. */
  lastModel?: { providerId: string; model: string }
  mcpServers: McpServerSettings[]
  /** User-level hooks (Claude Code format). */
  hooks?: HooksConfig
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
    /** Electron accelerator; default Control+Alt+Space. */
    shortcut?: string
    /** toggle = press to start, press again to insert; hold is reserved for a native key hook. */
    mode?: 'toggle' | 'hold'
    /** Send the final text through the current model to fix punctuation/filler (costs tokens). */
    polish?: boolean
    /** Where the final text goes when Forja is not focused. */
    insert?: 'composer' | 'focused'
  }
  /** Settings schema version, used for one-time migrations. */
  settingsVersion?: number
}

export interface McpServerSettings {
  name: string
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
}

export interface MCPStatus {
  name: string
  command: string
  state: 'stopped' | 'starting' | 'ready' | 'error'
  tools: string[]
  error?: string
}

export interface CapabilityReport {
  computer: ComputerStatus
  browser: BrowserStatus
  mcp: MCPStatus[]
  providers: { id: string; label: string; configured: boolean; reachable?: boolean }[]
  /** Language toolchains found on this machine (Go, Rust, Python, Node…). */
  toolchains?: Array<{ id: string; label: string; version: string; command: string }>
  node: string
  platform: string
}
