import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ImagePart, McpServerSettings, RiskLevel, ToolResult } from '../../shared/types.js'
import { hintForMcpError } from './hints.js'
import { DEFAULT_START_TIMEOUT_MS, MIN_LISTING_TIMEOUT_MS } from './limits.js'
import {
  META_MAX_RESULT_CHARS,
  approvalOf,
  resolveToolPolicy,
  sanitizeAnnotations,
  sanitizeToolPolicy,
  type McpPolicyConfig,
  type McpToolAnnotations,
  type McpToolMeta,
  type ResolvedToolPolicy
} from './policy.js'
import { SseParser, type SseEvent } from './sse.js'
import { childProcessEnv } from '../security/policy.js'
import { WARN_OUTPUT_TOKENS, approxTokens, limitMcpErrorText, limitMcpText, maxOutputChars } from './output.js'

export {
  filterMcpTools,
  isMcpToolExposed,
  matchesAnyToolPattern,
  matchesToolPattern,
  mcpToolRisk
} from './policy.js'

/**
 * One MCP server. The persisted shape is `McpServerSettings`; `enabled` is
 * optional here so internal callers (computer-use backend) can omit it.
 */
export interface McpServerConfig extends Omit<McpServerSettings, 'enabled'> {
  enabled?: boolean
  /** Access token obtained by the interactive OAuth flow (in-memory only). */
  oauthToken?: string
  /** Called on 401; returns a fresh token or null when login was refused. */
  onUnauthorized?: (challenge?: string) => Promise<string | null>
  /**
   * Called after the client reloaded its own tools/resources/prompts because the server announced a
   * `list_changed` notification (debounced). The client never restarts anything by itself for this.
   */
  onToolsChanged?: (kind?: 'tools' | 'resources' | 'prompts') => void
  /** Called whenever `state`, `lastError` or the reconnection progress changes. */
  onStateChange?: (client: McpClient) => void
  /**
   * Automatic reconnection (exponential backoff) after the connection was lost mid-session: HTTP/SSE servers
   * that stop answering and stdio servers whose process died. Off unless set.
   */
  reconnect?: false | { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }
  /** Debounce of `list_changed` reloads, in ms (default 250). */
  listChangedDebounceMs?: number
  /** false: do not advertise the `elicitation` client capability. */
  elicitation?: boolean
}

export interface McpToolInfo {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: McpToolAnnotations
  /** `_meta` of the tool entry (only read for the `anthropic/*` hints). */
  meta?: McpToolMeta
}

export interface McpResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpResourceTemplateInfo {
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpPromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments: McpPromptArgument[]
}

export interface McpPromptMessage {
  role: string
  content: string
}

export interface McpPromptResult {
  description?: string
  messages: McpPromptMessage[]
}

export interface McpProgress {
  progress: number
  total?: number
  message?: string
}

export interface McpElicitationRequest {
  message: string
  requestedSchema?: Record<string, unknown>
  [key: string]: unknown
}

export interface McpElicitationResult {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

/** Per-call hooks: progress notifications and elicitation (the server asks the user a question mid-call). */
export interface McpCallOptions {
  onProgress?: (progress: McpProgress) => void
  onElicit?: (request: McpElicitationRequest) => Promise<McpElicitationResult>
}

export type McpTransportKind = 'stdio' | 'http' | 'sse'

export interface McpClientInfo {
  name: string
  state: McpClient['state']
  transport: McpTransportKind
  protocolVersion: string | null
  serverName?: string
  serverVersion?: string
  instructions?: string
  lastError: string | null
  /** Known fix for `lastError`, in pt-BR. */
  hint?: string
  tools: number
  hiddenTools: number
  resources: number
  prompts: number
  reconnectAttempt: number
  nextRetryAt?: number
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000
const DEFAULT_STOP_GRACE_MS = 2_000
const DEFAULT_LIST_CHANGED_DEBOUNCE_MS = 250
/** Newest first: the client offers the first one and accepts any of them in the answer. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const OLDEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]
/**
 * Newer revisions a server may answer with even though the client offered an older one (Square's connectors answer
 * 2025-11-25 to an offer of 2025-06-18). What this client uses (initialize, tools, resources, prompts, progress,
 * cancellation, elicitation) is unchanged in them, so the answer is accepted instead of refusing the server.
 */
export const MCP_ACCEPTED_NEWER_VERSIONS = ['2025-11-25'] as const
const MAX_PAGES = 50
/** Claude Code stops reading a remote response at 16 MiB; so do we. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
/** Times a request's dropped SSE stream is resumed with Last-Event-ID before the connection counts as lost. */
const MAX_SSE_RESUMES = 3
const CLIENT_INFO = { name: 'openclod', title: 'Openclod Desktop', version: '0.1.0' }

/** Registry name of a server tool: `mcp__<server>__<tool>`, sanitized and capped at 60 chars. Kept for compatibility; see `assignMcpToolNames`. */
export function mcpQualifiedName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)
}

function positiveMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function clampMs(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : undefined
}

function sanitizePatterns(value: unknown): string[] | undefined {
  const list = (Array.isArray(value) ? value : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .slice(0, 100)
    .map((pattern) => pattern.slice(0, 120))
  return list.length ? list : undefined
}

/**
 * Shapes untrusted settings JSON (from the renderer or settings.json) into a
 * McpServerSettings: strings capped, numbers clamped, junk dropped. Unset
 * optional fields stay absent.
 */
export function normalizeMcpServerSettings(raw: unknown): McpServerSettings {
  const server = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const env =
    server.env && typeof server.env === 'object' && !Array.isArray(server.env)
      ? Object.fromEntries(
          Object.entries(server.env as Record<string, unknown>)
            .slice(0, 30)
            .map(([key, value]) => [key.slice(0, 80), String(value).slice(0, 2000)])
        )
      : undefined
  const out: McpServerSettings = {
    name: String(server.name ?? '').slice(0, 60),
    command: String(server.command ?? '').slice(0, 500),
    args: Array.isArray(server.args) ? server.args.slice(0, 30).map((arg) => String(arg).slice(0, 500)) : [],
    env,
    enabled: server.enabled !== false
  }
  const url = typeof server.url === 'string' ? server.url.trim().slice(0, 2000) : ''
  const type = server.type === 'http' || server.type === 'sse' || server.type === 'stdio' ? server.type : url ? 'http' : 'stdio'
  if (type !== 'stdio') {
    if (!/^https?:\/\//i.test(url)) throw new Error(`servidor MCP "${out.name}": url http(s) obrigatória`)
    out.type = type
    out.url = url
    out.command = ''
    out.args = []
  }
  if (server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)) {
    const headers = Object.fromEntries(
      Object.entries(server.headers as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, value]) => [key.slice(0, 120), String(value).slice(0, 4000)])
    )
    if (Object.keys(headers).length) out.headers = headers
  }
  if (typeof server.cwd === 'string' && server.cwd.trim()) out.cwd = server.cwd.trim().slice(0, 500)
  const timeoutMs = clampMs(server.timeoutMs, 1000, 3_600_000)
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs
  const startTimeoutMs = clampMs(server.startTimeoutMs, 1000, 600_000)
  if (startTimeoutMs !== undefined) out.startTimeoutMs = startTimeoutMs
  for (const key of ['includeTools', 'excludeTools', 'approvalTools'] as const) {
    const patterns = sanitizePatterns(server[key])
    if (patterns) out[key] = patterns
  }
  const toolPolicy = sanitizeToolPolicy(server.toolPolicy)
  if (toolPolicy) out.toolPolicy = toolPolicy
  const maxOutputTokens = clampMs(server.maxOutputTokens, 1000, 400_000)
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens
  if (typeof server.alwaysLoad === 'boolean') out.alwaysLoad = server.alwaysLoad
  if (server.inheritEnv === true) out.inheritEnv = true
  return out
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: (progress: McpProgress) => void
  /** Aborts the HTTP request that carries this call. */
  abort?: () => void
}

class McpUnauthorizedError extends Error {
  constructor(message: string, readonly challenge?: string) {
    super(message)
    this.name = 'McpUnauthorizedError'
  }
}

class McpHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'McpHttpError'
  }
}

class McpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(`MCP ${code}: ${message}`)
    this.name = 'McpRpcError'
  }
}

class McpNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpNetworkError'
  }
}

/** The transport went away while calls were in flight. */
export class McpConnectionLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpConnectionLostError'
  }
}

class McpSessionExpiredError extends Error {
  constructor() {
    super('sessão MCP expirada (HTTP 404)')
    this.name = 'McpSessionExpiredError'
  }
}

/** The URL does not speak the transport that was tried first (so the other one is worth trying). */
class McpTransportMismatch extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpTransportMismatch'
  }
}

/**
 * An answer that is not JSON-RPC: say what it was. A WAF/CDN that redirects the POST to an error page (Akamai in front of
 * Credit Karma) ends as an HTML 200, and "resposta inválida" alone sends the user looking for a bug that is not there.
 */
function invalidResponseMessage(method: string, response: Response, contentType: string, text: string): string {
  const html = /^\s*(?:<!doctype|<html|<head)/i.test(text)
  let via = ''
  if (response.redirected) {
    try {
      const target = new URL(response.url)
      via = `, redirecionado para ${target.host}${target.pathname}`
    } catch {
      /* no url */
    }
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 100)
  const what = html
    ? ': o endereço devolveu uma página HTML, não MCP (provável bloqueio de WAF/CDN ou URL que não é do servidor MCP)'
    : snippet
      ? `: ${snippet}`
      : ''
  return `resposta MCP inválida para ${method} (HTTP ${response.status}, ${contentType || 'sem content-type'}${via})${what}`
}

function networkMessage(err: unknown): string {
  const error = err as Error & { cause?: { code?: string; message?: string } }
  const cause = error.cause?.code ?? error.cause?.message
  return `${error.message}${cause ? ` (${cause})` : ''}`
}

function isTransient(err: unknown): boolean {
  if (err instanceof McpNetworkError) return true
  if (err instanceof McpHttpError) return err.status >= 500 || err.status === 429
  return false
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Kills a process and everything it started (cmd.exe /c npx ... leaves the real server as a grandchild on Windows). */
function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid
    if (!pid) return resolve()
    if (process.platform === 'win32') {
      let finished = false
      const done = (): void => {
        if (finished) return
        finished = true
        resolve()
      }
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('exit', done)
        killer.once('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          done()
        })
      } catch {
        done()
      }
      setTimeout(done, 4_000).unref?.()
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    resolve()
  })
}

interface ActiveCall {
  onElicit?: McpCallOptions['onElicit']
}

/**
 * MCP client: stdio (newline-delimited JSON-RPC 2.0), Streamable HTTP and the
 * legacy HTTP+SSE transport, with protocol version negotiation, tools,
 * resources (and templates), prompts, pagination, `list_changed`, progress,
 * cancellation, elicitation, session recovery, automatic reconnection and
 * bounded start/stop. Optional collections are only requested when the server
 * advertised their capability.
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private allTools: McpToolInfo[] = []
  private resources: McpResourceInfo[] = []
  private resourceTemplates: McpResourceTemplateInfo[] = []
  private prompts: McpPromptInfo[] = []
  private capabilities: Record<string, unknown> = {}
  private httpSession: string | null = null
  /** Version the server agreed to; sent as `MCP-Protocol-Version` after init. */
  private protocolVersion: string | null = null
  private serverName: string | undefined
  private serverVersion: string | undefined
  private serverInstructions: string | undefined
  private mode: 'stdio' | 'streamable' | 'legacy-sse' = 'stdio'
  private legacyEndpoint: string | null = null
  private legacyAbort: AbortController | null = null
  private listenAbort: AbortController | null = null
  private stopping = false
  private startPromise: Promise<void> | null = null
  private reinit: Promise<void> | null = null
  private stderrTail = ''
  private activeCalls = new Set<ActiveCall>()
  private refreshTimers = new Map<string, NodeJS.Timeout>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectNextAt: number | undefined
  /** The `oauthToken` is replaced in place by the 401 handler; kept apart so a config object can be reused. */
  state: 'stopped' | 'starting' | 'ready' | 'error' = 'stopped'
  lastError: string | null = null
  /** 0 when connected; the attempt number while the client is reconnecting. */
  reconnectAttempt = 0

  constructor(private readonly config: McpServerConfig) {}

  get name(): string {
    return this.config.name
  }

  private get remote(): boolean {
    return this.config.type === 'http' || this.config.type === 'sse' || Boolean(this.config.url)
  }

  /** Transport actually in use (after the automatic fallback between Streamable HTTP and legacy SSE). */
  get transport(): McpTransportKind {
    if (!this.remote) return 'stdio'
    if (this.state === 'stopped' || this.state === 'starting') return this.config.type === 'sse' ? 'sse' : 'http'
    return this.mode === 'legacy-sse' ? 'sse' : 'http'
  }

  private setState(state: McpClient['state']): void {
    this.state = state
    this.emitChange()
  }

  private emitChange(): void {
    try {
      this.config.onStateChange?.(this)
    } catch {
      /* a listener must not break the transport */
    }
  }

  /* ----------------------------- policy ------------------------------ */

  private policyConfig(): McpPolicyConfig {
    return {
      includeTools: this.config.includeTools,
      excludeTools: this.config.excludeTools,
      approvalTools: this.config.approvalTools,
      toolPolicy: this.config.toolPolicy
    }
  }

  /** Replaces the per-tool policy (include/exclude/approval/toolPolicy) without reconnecting. */
  setPolicy(next: Partial<McpPolicyConfig>): void {
    for (const key of ['includeTools', 'excludeTools', 'approvalTools', 'toolPolicy'] as const) {
      if (key in next) (this.config as unknown as Record<string, unknown>)[key] = next[key]
    }
  }

  /** What the policy decides for one tool (annotations and `_meta` are taken from the server's own listing). */
  policyFor(name: string): ResolvedToolPolicy {
    const tool = this.allTools.find((item) => item.name === name)
    return resolveToolPolicy(this.policyConfig(), name, tool?.annotations, tool?.meta)
  }

  /**
   * The tools the user can configure: the server's list minus what `includeTools`/`excludeTools` filter out. A tool
   * with `toolPolicy: deny` stays here (the connector settings must list it to let the user turn it back on); the
   * model never sees it: use `exposedToolsList()` for what it may call.
   */
  toolsList(): McpToolInfo[] {
    return this.allTools.filter((tool) => this.policyFor(tool.name).source !== 'filter')
  }

  /** Tools the model may see and call: `toolsList()` minus `toolPolicy: deny`. */
  exposedToolsList(): McpToolInfo[] {
    return this.allTools.filter((tool) => this.policyFor(tool.name).exposed)
  }

  /** `toolsList()` with the resolved policy of each tool (for settings screens). */
  toolPolicies(): Array<McpToolInfo & { policy: ResolvedToolPolicy }> {
    return this.toolsList().map((tool) => ({ ...tool, policy: this.policyFor(tool.name) }))
  }

  /** Tools the server offers but the configuration hides from the model (include/exclude filter or `toolPolicy: deny`). */
  get hiddenToolCount(): number {
    return this.allTools.length - this.exposedToolsList().length
  }

  /** Whether the config lets the model see/call this tool (independent of what the server lists). */
  isToolExposed(name: string): boolean {
    return this.policyFor(name).exposed
  }

  /** Whether this tool must always ask for approval (`approvalTools` or `toolPolicy: ask`). */
  requiresApproval(name: string): boolean {
    const resolved = this.policyFor(name)
    return approvalOf(resolved) === 'ask'
  }

  /** Risk level to register the tool with. */
  toolRisk(name: string): RiskLevel {
    return this.policyFor(name).risk
  }

  resourcesList(): McpResourceInfo[] {
    return [...this.resources]
  }

  resourceTemplatesList(): McpResourceTemplateInfo[] {
    return [...this.resourceTemplates]
  }

  promptsList(): McpPromptInfo[] {
    return this.prompts.map((prompt) => ({ ...prompt, arguments: [...prompt.arguments] }))
  }

  get capabilitiesInfo(): { tools: boolean; resources: boolean; prompts: boolean } {
    return {
      tools: Boolean(this.capabilities.tools),
      resources: Boolean(this.capabilities.resources),
      prompts: Boolean(this.capabilities.prompts)
    }
  }

  /** `instructions` the server sent in `initialize` (usable as a hint about when to use its tools). */
  get instructions(): string | undefined {
    return this.serverInstructions
  }

  /** Diagnostic snapshot for `mcp_servers` and the connectors screen. */
  describe(): McpClientInfo {
    return {
      name: this.name,
      state: this.state,
      transport: this.transport,
      protocolVersion: this.protocolVersion,
      serverName: this.serverName,
      serverVersion: this.serverVersion,
      instructions: this.serverInstructions,
      lastError: this.lastError,
      hint: this.lastError ? hintForMcpError(this.name, this.config, this.lastError) : undefined,
      tools: this.exposedToolsList().length,
      hiddenTools: this.hiddenToolCount,
      resources: this.resources.length,
      prompts: this.prompts.length,
      reconnectAttempt: this.reconnectAttempt,
      nextRetryAt: this.reconnectNextAt
    }
  }

  /* ------------------------------ start ------------------------------ */

  /**
   * Connects and loads tools, resources and prompts. `timeoutMs` bounds the handshake, and the listings share what is
   * left of it, but never get less than MIN_LISTING_TIMEOUT_MS each: a server that took almost the whole budget to
   * answer `initialize` (a cold `uvx`, a loaded machine) used to be left with a few milliseconds to list its tools and
   * failed although it was up. On failure the process or connection is torn down, never left running.
   */
  async start(timeoutMs = positiveMs(this.config.startTimeoutMs, DEFAULT_START_TIMEOUT_MS)): Promise<void> {
    if (this.state === 'ready') return
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.clearReconnect()
    this.startPromise = this.connect(timeoutMs).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async connect(timeoutMs: number): Promise<void> {
    this.lastError = null
    this.setState('starting')
    const started = Date.now()
    let first = true
    /** Time for the next request: the full timeout for the first one, what is left of the start budget (with a floor) after that. */
    const budget = (): number => {
      if (first) {
        first = false
        return timeoutMs
      }
      const left = timeoutMs - (Date.now() - started)
      return Math.max(Math.min(timeoutMs, MIN_LISTING_TIMEOUT_MS), Math.min(timeoutMs, left))
    }
    try {
      if (this.remote) await this.connectRemote(budget, timeoutMs, started)
      else await this.connectStdio(budget)
      this.reconnectAttempt = 0
      this.reconnectNextAt = undefined
      this.setState('ready')
      this.startListening()
    } catch (err) {
      await this.teardownTransport()
      this.lastError = (err as Error).message.slice(0, 800)
      this.setState('error')
      throw err
    }
  }

  private spawnCommand(): { command: string; args: string[] } {
    const win = process.platform === 'win32'
    const useShell =
      win &&
      (/\.(cmd|bat)$/i.test(this.config.command) ||
        ['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'uv', 'deno'].includes(this.config.command))
    return useShell
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', this.config.command, ...this.config.args] }
      : { command: this.config.command, args: this.config.args }
  }

  private async connectStdio(budget: () => number): Promise<void> {
    this.mode = 'stdio'
    this.buffer = ''
    this.stderrTail = ''
    const { command, args } = this.spawnCommand()
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd || undefined,
      // Only what a program needs to run, plus the server's own env: the app's keys and tokens are not the server's.
      // `inheritEnv: true` in its config passes the whole environment again (for a server that reads a variable of the system).
      env: this.config.inheritEnv ? { ...process.env, ...(this.config.env ?? {}) } : childProcessEnv(this.config.env ?? {}),
      // A process group lets stop() kill the server's children on POSIX; Windows uses taskkill /T.
      detached: process.platform !== 'win32'
    })
    this.child = child

    // A server that dies mid-write must not surface as an uncaught EPIPE.
    child.stdin.on('error', () => undefined)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    // spawn ENOENT arrives here, asynchronously. Without a listener it would crash the process.
    child.on('error', (err) => {
      if (this.child !== child) return
      this.failPending(new McpConnectionLostError(`não foi possível iniciar o servidor MCP ${this.name}: ${err.message}`))
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      const detail = this.stderrLine()
      const message = `servidor MCP ${this.name} encerrou (código ${code})${detail ? `: ${detail}` : ''}`
      this.failPending(new McpConnectionLostError(message))
      if (this.stopping) return
      if (this.state === 'ready') this.connectionLost(message)
    })

    // Nothing is written before the process exists: a missing command fails here, with its own message.
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (err) => reject(new McpConnectionLostError(`não foi possível iniciar o servidor MCP ${this.name}: ${err.message}`)))
    })
    await this.handshake(budget)
  }

  private stderrLine(): string {
    const lines = this.stderrTail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.slice(-2).join(' | ').slice(0, 300)
  }

  private async connectRemote(budget: () => number, timeoutMs: number, started: number): Promise<void> {
    let attempt = 0
    for (;;) {
      attempt++
      try {
        await this.connectRemoteOnce(budget)
        return
      } catch (err) {
        // Claude Code retries a first connection 3 times on transient errors (5xx, refused, reset).
        const left = timeoutMs - (Date.now() - started)
        if (attempt >= 3 || !isTransient(err) || left < 800) throw err
        await this.teardownTransport()
        await sleepMs(Math.min(400 * attempt, Math.max(0, left - 400)))
      }
    }
  }

  /** Streamable HTTP first, legacy HTTP+SSE as the fallback (or the other way round when the setting says `sse`). */
  private async connectRemoteOnce(budget: () => number): Promise<void> {
    const order: Array<'streamable' | 'legacy-sse'> =
      this.config.type === 'sse' ? ['legacy-sse', 'streamable'] : ['streamable', 'legacy-sse']
    let firstError: Error | null = null
    for (const [index, mode] of order.entries()) {
      this.mode = mode
      try {
        if (mode === 'legacy-sse') await this.openLegacyStream(budget())
        await this.handshake(budget)
        return
      } catch (err) {
        const canFallback =
          index === 0 &&
          (err instanceof McpTransportMismatch ||
            (mode === 'streamable' && err instanceof McpHttpError && [400, 404, 405].includes(err.status)))
        if (!canFallback) {
          // Neither transport works at this address: say what each one answered, not only the last.
          const mismatch = err instanceof McpTransportMismatch || (err instanceof McpHttpError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403)
          if (index === 1 && firstError && mismatch) {
            throw new McpHttpError(
              `nenhum transporte MCP funcionou neste endereço: ${firstError.message}; ${(err as Error).message}`,
              err instanceof McpHttpError ? err.status : 404
            )
          }
          throw err
        }
        firstError = err as Error
        await this.teardownTransport()
        this.httpSession = null
        this.protocolVersion = null
      }
    }
  }

  private clientCapabilities(): Record<string, unknown> {
    return this.config.elicitation === false ? {} : { elicitation: {} }
  }

  /** initialize (with version negotiation) + notifications/initialized + the listings. */
  private async handshake(budget: () => number): Promise<void> {
    await this.initializeSession(budget)
    await this.loadCollections(budget)
  }

  private async initializeSession(budget: () => number): Promise<void> {
    let offered: string = MCP_PROTOCOL_VERSIONS[0]
    type InitResult = { protocolVersion?: unknown; capabilities?: unknown; serverInfo?: unknown; instructions?: unknown }
    let init = null as InitResult | null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        init = (await this.request(
          'initialize',
          { protocolVersion: offered, capabilities: this.clientCapabilities(), clientInfo: CLIENT_INFO },
          budget()
        )) as InitResult | null
        break
      } catch (err) {
        // A server that predates the current revision may reject the offered version instead of negotiating
        // down. Authentication, network and timeout failures are not a version problem.
        const versionProblem = err instanceof McpRpcError || (err instanceof McpHttpError && [400, 422].includes(err.status))
        if (attempt === 1 || !versionProblem) throw err
        const supported = (err instanceof McpRpcError && (err.data as { supported?: unknown } | undefined)?.supported) || null
        const common = Array.isArray(supported)
          ? MCP_PROTOCOL_VERSIONS.find((version) => (supported as unknown[]).includes(version) && version !== offered)
          : undefined
        offered = common ?? OLDEST_PROTOCOL_VERSION
      }
    }
    const answered = typeof init?.protocolVersion === 'string' && init.protocolVersion ? init.protocolVersion : offered
    const understood: readonly string[] = [...MCP_ACCEPTED_NEWER_VERSIONS, ...MCP_PROTOCOL_VERSIONS]
    if (!understood.includes(answered)) {
      throw new Error(`versão de protocolo MCP não suportada: o servidor respondeu ${answered} (suportadas: ${understood.join(', ')})`)
    }
    this.protocolVersion = answered
    this.capabilities = init?.capabilities && typeof init.capabilities === 'object' ? (init.capabilities as Record<string, unknown>) : {}
    const info = init?.serverInfo && typeof init.serverInfo === 'object' ? (init.serverInfo as Record<string, unknown>) : {}
    this.serverName = typeof info.name === 'string' ? info.name.slice(0, 120) : undefined
    this.serverVersion = typeof info.version === 'string' ? info.version.slice(0, 60) : undefined
    this.serverInstructions = typeof init?.instructions === 'string' && init.instructions.trim() ? init.instructions.slice(0, 8000) : undefined
    await this.notify('notifications/initialized', {})
  }

  /* --------------------------- listings ------------------------------ */

  private async listPaged<T>(method: string, key: string, timeoutMs: number): Promise<T[]> {
    const all: T[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await this.request(method, cursor ? { cursor } : {}, timeoutMs)) as Record<string, unknown> | null
      const items = result?.[key]
      if (Array.isArray(items)) all.push(...(items as T[]))
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor || seen.has(cursor)) break
      seen.add(cursor)
    }
    return all
  }

  private async loadCollections(budget: () => number): Promise<void> {
    await this.loadTools(budget())
    if (this.capabilities.resources) {
      await this.loadResources(budget()).catch(() => {
        /* A capability without a working list endpoint must not block tools. */
        this.resources = []
        this.resourceTemplates = []
      })
    } else {
      this.resources = []
      this.resourceTemplates = []
    }
    if (this.capabilities.prompts) {
      await this.loadPrompts(budget()).catch(() => {
        this.prompts = []
      })
    } else {
      this.prompts = []
    }
  }

  private async loadTools(timeoutMs: number): Promise<void> {
    const advertised = Boolean(this.capabilities.tools) || Object.keys(this.capabilities).length === 0
    if (!advertised) {
      this.allTools = []
      return
    }
    let raw: unknown[]
    try {
      raw = await this.listPaged<unknown>('tools/list', 'tools', timeoutMs)
    } catch (err) {
      // A server with no tools capability that rejects tools/list simply has no tools.
      if (err instanceof McpRpcError && err.code === -32601 && !this.capabilities.tools) {
        this.allTools = []
        return
      }
      throw err
    }
    this.allTools = raw
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
      .filter((item): item is Record<string, unknown> & { name: string } => item !== null && typeof item.name === 'string' && item.name !== '')
      .map((item) => {
        const tool: McpToolInfo = {
          name: item.name,
          description: typeof item.description === 'string' ? item.description : '',
          inputSchema:
            item.inputSchema && typeof item.inputSchema === 'object' && !Array.isArray(item.inputSchema)
              ? (item.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} }
        }
        if (typeof item.title === 'string' && item.title) tool.title = item.title.slice(0, 200)
        if (item.outputSchema && typeof item.outputSchema === 'object' && !Array.isArray(item.outputSchema)) {
          tool.outputSchema = item.outputSchema as Record<string, unknown>
        }
        const annotations = sanitizeAnnotations(item.annotations)
        if (annotations) tool.annotations = annotations
        if (item._meta && typeof item._meta === 'object' && !Array.isArray(item._meta)) tool.meta = item._meta as McpToolMeta
        return tool
      })
  }

  private async loadResources(timeoutMs: number): Promise<void> {
    const raw = await this.listPaged<Record<string, unknown>>('resources/list', 'resources', timeoutMs)
    this.resources = raw
      .filter((item): item is Record<string, unknown> & { uri: string; name: string } => typeof item.uri === 'string' && typeof item.name === 'string')
      .map((item) => ({
        uri: item.uri,
        name: item.name,
        description: typeof item.description === 'string' ? item.description : undefined,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined
      }))
    // Templates are optional; a server that does not implement them answers "method not found".
    try {
      const templates = await this.listPaged<Record<string, unknown>>('resources/templates/list', 'resourceTemplates', timeoutMs)
      this.resourceTemplates = templates
        .filter((item): item is Record<string, unknown> & { uriTemplate: string; name: string } => typeof item.uriTemplate === 'string' && typeof item.name === 'string')
        .map((item) => ({
          uriTemplate: item.uriTemplate,
          name: item.name,
          description: typeof item.description === 'string' ? item.description : undefined,
          mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined
        }))
    } catch {
      this.resourceTemplates = []
    }
  }

  private async loadPrompts(timeoutMs: number): Promise<void> {
    const raw = await this.listPaged<Record<string, unknown>>('prompts/list', 'prompts', timeoutMs)
    this.prompts = raw
      .filter((item): item is Record<string, unknown> & { name: string } => typeof item.name === 'string')
      .map((item) => ({
        name: item.name,
        description: typeof item.description === 'string' ? item.description : undefined,
        arguments: Array.isArray(item.arguments)
          ? item.arguments
              .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
              .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry.name === 'string')
              .map((entry) => ({
                name: entry.name as string,
                description: typeof entry.description === 'string' ? entry.description : undefined,
                required: entry.required === true
              }))
          : []
      }))
  }

  private callTimeout(): number {
    return positiveMs(this.config.timeoutMs, DEFAULT_CALL_TIMEOUT_MS)
  }

  /** Fresh, fully paginated listing (and updates the cached `resourcesList()`). */
  async listResources(timeoutMs = this.callTimeout()): Promise<McpResourceInfo[]> {
    if (this.state !== 'ready') throw new Error('servidor MCP não iniciado')
    if (!this.capabilities.resources) return []
    await this.loadResources(timeoutMs)
    return this.resourcesList()
  }

  async listResourceTemplates(timeoutMs = this.callTimeout()): Promise<McpResourceTemplateInfo[]> {
    if (this.state !== 'ready') throw new Error('servidor MCP não iniciado')
    if (!this.capabilities.resources) return []
    await this.loadResources(timeoutMs)
    return this.resourceTemplatesList()
  }

  async listPrompts(timeoutMs = this.callTimeout()): Promise<McpPromptInfo[]> {
    if (this.state !== 'ready') throw new Error('servidor MCP não iniciado')
    if (!this.capabilities.prompts) return []
    await this.loadPrompts(timeoutMs)
    return this.promptsList()
  }

  async readResource(uri: string, timeoutMs = this.callTimeout(), signal?: AbortSignal): Promise<McpResourceContent[]> {
    const raw = (await this.request('resources/read', { uri }, timeoutMs, signal)) as { contents?: unknown[] } | null
    return (raw?.contents ?? [])
      .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry.uri === 'string')
      .map((entry) => ({
        uri: entry.uri as string,
        mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : undefined,
        text: typeof entry.text === 'string' ? entry.text : undefined,
        blob: typeof entry.blob === 'string' ? entry.blob : undefined
      }))
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
    timeoutMs = this.callTimeout(),
    signal?: AbortSignal
  ): Promise<McpPromptResult> {
    const raw = (await this.request('prompts/get', { name, arguments: args }, timeoutMs, signal)) as {
      description?: unknown
      messages?: unknown[]
    } | null
    const messages = (raw?.messages ?? []).map((entry) => {
      const message = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
      return {
        role: typeof message.role === 'string' ? message.role : 'user',
        content: this.promptContentText(message.content)
      }
    })
    return {
      description: typeof raw?.description === 'string' ? raw.description : undefined,
      messages
    }
  }

  private promptContentText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!content || typeof content !== 'object') return ''
    const item = content as Record<string, unknown>
    if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
    if (item.type === 'resource') {
      const resource = item.resource && typeof item.resource === 'object' ? (item.resource as Record<string, unknown>) : item
      return `[resource ${typeof resource.uri === 'string' ? resource.uri : ''}]${typeof resource.text === 'string' ? `\n${resource.text}` : ''}`
    }
    if (item.type === 'image') return `[imagem ${typeof item.mimeType === 'string' ? item.mimeType : ''}]`
    return JSON.stringify(item).slice(0, 2000)
  }

  /* ----------------------------- tools/call -------------------------- */

  /**
   * Calls a tool. The timeout defaults to the server's `timeoutMs` setting (120 s when unset); `signal` aborts the
   * wait and tells the server via `notifications/cancelled`. A read-only/idempotent tool whose connection dropped
   * is repeated once on the new connection when automatic reconnection is on.
   */
  async callTool(
    name: string,
    args: unknown,
    timeoutMs = this.callTimeout(),
    signal?: AbortSignal,
    options: McpCallOptions = {}
  ): Promise<ToolResult> {
    const resolved = this.policyFor(name)
    if (!resolved.exposed) {
      const why = resolved.source === 'filter' ? 'includeTools/excludeTools' : 'toolPolicy'
      throw new Error(`ferramenta ${name} do servidor MCP ${this.name} está desativada pela configuração (${why})`)
    }
    try {
      return await this.callToolOnce(name, args, timeoutMs, signal, options)
    } catch (err) {
      const annotations = this.allTools.find((tool) => tool.name === name)?.annotations
      const repeatable = annotations?.readOnlyHint === true || annotations?.idempotentHint === true
      if (err instanceof McpConnectionLostError && repeatable && this.config.reconnect && !signal?.aborted) {
        if (await this.waitReady(Math.min(timeoutMs, 15_000), signal)) {
          return this.callToolOnce(name, args, timeoutMs, signal, options)
        }
      }
      throw err
    }
  }

  private async callToolOnce(
    name: string,
    args: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    options: McpCallOptions
  ): Promise<ToolResult> {
    const active: ActiveCall = { onElicit: options.onElicit }
    this.activeCalls.add(active)
    let raw: Record<string, unknown> | null
    try {
      raw = (await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs, signal, options.onProgress)) as Record<string, unknown> | null
    } finally {
      this.activeCalls.delete(active)
    }
    return this.toToolResult(name, raw ?? {})
  }

  private toToolResult(name: string, raw: Record<string, unknown>): ToolResult {
    const content = Array.isArray(raw.content) ? (raw.content as Array<Record<string, unknown>>) : []
    const parts: string[] = []
    const images: ImagePart[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      switch (item.type) {
        case 'text':
          if (typeof item.text === 'string') parts.push(item.text)
          break
        case 'image':
          if (typeof item.data === 'string' && item.data) {
            images.push({
              type: 'image',
              mediaType: (item.mimeType as ImagePart['mediaType']) ?? 'image/png',
              data: item.data
            })
          }
          break
        case 'audio':
          parts.push(`[áudio ${typeof item.mimeType === 'string' ? item.mimeType : ''}, ${typeof item.data === 'string' ? item.data.length : 0} caracteres base64; o Openclod não reproduz áudio]`)
          break
        case 'resource_link':
          parts.push(
            `[link de recurso: ${typeof item.name === 'string' ? item.name : ''} ${typeof item.uri === 'string' ? item.uri : ''}${typeof item.mimeType === 'string' ? ` (${item.mimeType})` : ''}; leia com mcp_read_resource]`
          )
          break
        case 'resource': {
          const resource = item.resource && typeof item.resource === 'object' ? (item.resource as Record<string, unknown>) : {}
          const uri = typeof resource.uri === 'string' ? resource.uri : ''
          if (typeof resource.text === 'string') parts.push(`[recurso ${uri}]\n${resource.text}`)
          else parts.push(`[recurso binário ${uri}${typeof resource.mimeType === 'string' ? ` (${resource.mimeType})` : ''}]`)
          break
        }
        default:
          parts.push(JSON.stringify(item).slice(0, 2000))
      }
    }
    const isError = raw.isError === true
    const joined = parts.join('\n')
    const tool = this.allTools.find((item) => item.name === name)
    const metaChars = typeof tool?.meta?.[META_MAX_RESULT_CHARS] === 'number' ? (tool.meta[META_MAX_RESULT_CHARS] as number) : undefined
    const limit = maxOutputChars({ maxOutputTokens: this.config.maxOutputTokens, toolMaxChars: metaChars })
    const limited = isError ? { text: limitMcpErrorText(joined), truncated: joined.length > 11_000, originalChars: joined.length, omittedChars: 0 } : limitMcpText(joined, limit)
    const data: Record<string, unknown> = { server: this.name, tool: name }
    if (raw.structuredContent !== undefined) data.structuredContent = raw.structuredContent
    if (limited.truncated) {
      data.truncated = true
      data.originalChars = limited.originalChars
    } else if (approxTokens(joined.length) > WARN_OUTPUT_TOKENS) {
      data.warning = `saída grande (~${approxTokens(joined.length)} tokens)`
    }
    return {
      ok: !isError,
      text: limited.text || (images.length ? `(${images.length} imagem(ns))` : '(sem conteúdo)'),
      images: images.length ? images : undefined,
      summary: `${this.name}/${name}`,
      data
    }
  }

  /* --------------------------- JSON-RPC core ------------------------- */

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  /** Routes a message from the server: a response, a server request or a notification. */
  private dispatch(message: unknown): void {
    if (Array.isArray(message)) {
      for (const item of message) this.dispatch(item)
      return
    }
    if (!message || typeof message !== 'object') return
    const msg = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) void this.handleServerRequest(msg.id as number | string, msg.method, msg.params)
      else this.handleNotification(msg.method, msg.params)
      return
    }
    if (msg.id === undefined || msg.id === null) return
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id)
    const pending = this.pending.get(id)
    if (!pending) return
    if (msg.error) pending.reject(new McpRpcError(Number(msg.error.code ?? -32603), String(msg.error.message ?? 'erro'), msg.error.data))
    else pending.resolve(msg.result)
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
    switch (method) {
      case 'notifications/tools/list_changed':
        this.scheduleRefresh('tools')
        break
      case 'notifications/resources/list_changed':
        this.scheduleRefresh('resources')
        break
      case 'notifications/prompts/list_changed':
        this.scheduleRefresh('prompts')
        break
      case 'notifications/progress': {
        const token = typeof p.progressToken === 'number' ? p.progressToken : Number(p.progressToken)
        const pending = this.pending.get(token)
        if (pending?.onProgress && typeof p.progress === 'number') {
          try {
            pending.onProgress({
              progress: p.progress,
              total: typeof p.total === 'number' ? p.total : undefined,
              message: typeof p.message === 'string' ? p.message : undefined
            })
          } catch {
            /* a progress listener must not break the call */
          }
        }
        break
      }
      default:
    }
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const reply = (body: Record<string, unknown>): void => {
      void this.transportSend({ jsonrpc: '2.0', id, ...body }).catch(() => undefined)
    }
    switch (method) {
      case 'ping':
        reply({ result: {} })
        return
      case 'elicitation/create': {
        const handler = [...this.activeCalls].reverse().find((call) => call.onElicit)?.onElicit
        if (!handler || this.config.elicitation === false) {
          reply({ result: { action: 'cancel' } })
          return
        }
        try {
          const result = await handler((params ?? {}) as McpElicitationRequest)
          reply({ result })
        } catch {
          reply({ result: { action: 'cancel' } })
        }
        return
      }
      default:
        // Sampling, roots and anything else: the capability was never advertised.
        reply({ error: { code: -32601, message: `method not found: ${method}` } })
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (progress: McpProgress) => void
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error(`chamada MCP ${this.name}.${method} cancelada`))
    if (this.remote) {
      if (this.state === 'error') return Promise.reject(new McpConnectionLostError(`servidor MCP ${this.name} indisponível: ${this.lastError ?? 'sem conexão'}`))
      if (this.state !== 'ready' && this.state !== 'starting') return Promise.reject(new Error('servidor MCP não iniciado'))
    } else if (!this.child) {
      return Promise.reject(new Error('servidor MCP não iniciado'))
    }
    const id = this.nextId++
    const withToken =
      onProgress && params && typeof params === 'object'
        ? { ...(params as Record<string, unknown>), _meta: { ...(((params as Record<string, unknown>)._meta as object) ?? {}), progressToken: id } }
        : params
    const body = { jsonrpc: '2.0', id, method, params: withToken }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          const entry = this.pending.get(id)
          this.pending.delete(id)
          entry?.abort?.()
          fn(value)
        }
      const onAbort = (): void => {
        this.sendCancel(id, method, 'cancelado pelo usuário')
        settle(reject)(new Error(`chamada MCP ${this.name}.${method} cancelada`))
      }
      const timer = setTimeout(() => {
        this.sendCancel(id, method, 'tempo esgotado')
        settle(reject)(new Error(`timeout de MCP ${this.name}.${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { method, resolve: settle(resolve), reject: settle(reject), onProgress })
      this.transportSend(body, id).catch((err) => settle(reject)(err as Error))
    })
  }

  private sendCancel(id: number, method: string, reason: string): void {
    // The spec forbids cancelling `initialize`; a request that already finished is simply ignored by the server.
    if (method === 'initialize') return
    void this.notify('notifications/cancelled', { requestId: id, reason }).catch(() => undefined)
  }

  private failPending(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error)
    this.pending.clear()
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.transportSend({ jsonrpc: '2.0', method, params }).catch(() => undefined)
  }

  /* ---------------------------- transports --------------------------- */

  private async transportSend(body: Record<string, unknown>, id?: number): Promise<void> {
    if (this.mode === 'stdio') return this.writeLine(body)
    if (this.mode === 'legacy-sse') return this.postWithAuthRetry(() => this.postLegacy(body))
    return this.sendStreamable(body, id)
  }

  private writeLine(body: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.child
      if (!child || !child.stdin.writable) return reject(new Error('servidor MCP não iniciado'))
      child.stdin.write(`${JSON.stringify(body)}\n`, (err) => (err ? reject(err) : resolve()))
    })
  }

  private remoteHeaders(extra: Record<string, string> = {}, withSession = true): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(withSession && this.httpSession ? { 'mcp-session-id': this.httpSession } : {}),
      ...(this.config.headers ?? {}),
      ...extra
    }
    // A token obtained by OAuth is the current credential. A leftover Basic or
    // expired Bearer header in settings must not override it, or the retry
    // after login would repeat the same 401.
    if (this.config.oauthToken) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') delete headers[key]
      }
      headers.authorization = `Bearer ${this.config.oauthToken}`
    }
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
    return headers
  }

  private async postWithAuthRetry(send: () => Promise<void>): Promise<void> {
    try {
      await send()
    } catch (err) {
      if (err instanceof McpUnauthorizedError && this.config.onUnauthorized) {
        const token = await this.config.onUnauthorized(err.challenge)
        if (token) {
          this.config.oauthToken = token
          return send()
        }
      }
      throw err
    }
  }

  private async sendStreamable(body: Record<string, unknown>, id?: number): Promise<void> {
    try {
      await this.postWithAuthRetry(() => this.postStreamable(body, id))
    } catch (err) {
      // 404 on a request that carried a session id: the session ended. Start a new one (once) and repeat.
      if (err instanceof McpSessionExpiredError) {
        await this.reinitializeSession()
        await this.postWithAuthRetry(() => this.postStreamable(body, id))
        return
      }
      throw err
    }
  }

  private reinitializeSession(): Promise<void> {
    if (!this.reinit) {
      this.reinit = (async () => {
        this.httpSession = null
        this.protocolVersion = null
        const timeout = positiveMs(this.config.startTimeoutMs, DEFAULT_START_TIMEOUT_MS)
        await this.initializeSession(() => timeout)
      })().finally(() => {
        this.reinit = null
      })
    }
    return this.reinit
  }

  private failedFetch(method: string, err: unknown): Error {
    const error = new McpNetworkError(`falha de rede em ${method}: ${networkMessage(err)}`)
    if (this.state === 'ready') this.connectionLost(error.message)
    return error
  }

  /**
   * One POST of the Streamable HTTP transport. The answer may be a JSON body or an SSE stream; messages are
   * routed as they arrive (so progress reaches the caller before the result) and the call's own response resolves
   * the pending request.
   */
  private async postStreamable(body: Record<string, unknown>, id?: number): Promise<void> {
    const url = this.config.url
    if (!url) throw new Error(`servidor MCP ${this.name} sem url`)
    const method = String(body.method ?? 'resposta')
    const controller = new AbortController()
    const pending = id !== undefined ? this.pending.get(id) : undefined
    if (pending) pending.abort = () => controller.abort()
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.remoteHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) return
      throw this.failedFetch(method, err)
    }
    const session = response.headers.get('mcp-session-id')
    if (session) this.httpSession = session
    const challenge = response.headers.get('www-authenticate') ?? undefined
    if (response.status === 401 || (response.status === 403 && /bearer/i.test(challenge ?? ''))) {
      const text = await this.readText(response, controller).catch(() => '')
      throw new McpUnauthorizedError(
        `HTTP ${response.status} em ${method}: ${text.slice(0, 300)}${challenge ? ` [desafio: ${challenge.slice(0, 300)}]` : ''}`,
        challenge
      )
    }
    if (response.status === 404 && this.httpSession && method !== 'initialize') {
      await response.body?.cancel().catch(() => undefined)
      throw new McpSessionExpiredError()
    }
    if (!response.ok) {
      const text = await this.readText(response, controller).catch(() => '')
      throw new McpHttpError(`HTTP ${response.status} em ${method}: ${text.slice(0, 400)}`, response.status)
    }
    if (id === undefined) {
      // Notifications and responses: a 202 without a body is the normal answer.
      await response.body?.cancel().catch(() => undefined)
      return
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const position = await this.consumeSse(response, controller)
      // Dropped before the answer: the rest may still come from where it stopped.
      if (this.pending.has(id) && !controller.signal.aborted && position.lastEventId) await this.resumeSse(id, position, controller)
      if (this.pending.has(id) && !controller.signal.aborted) {
        throw new McpConnectionLostError(`a conexão com ${this.name} foi encerrada antes da resposta de ${method}`)
      }
      return
    }
    const text = await this.readText(response, controller)
    if (!text.trim()) {
      pending?.resolve(null)
      return
    }
    const message = parseRpcResponse(text, id)
    if (!message) throw new Error(invalidResponseMessage(method, response, contentType, text))
    this.dispatch(message)
    if (this.pending.has(id)) throw new Error(invalidResponseMessage(method, response, contentType, text))
  }

  private async readText(response: Response, controller: AbortController): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort()
        throw new Error('resposta MCP maior que 16 MiB; o servidor deve paginar os resultados')
      }
      out += decoder.decode(value, { stream: true })
    }
    return out + decoder.decode()
  }

  /**
   * Reads an SSE response to its end, routing every `message` event. Returns the stream's last event id and `retry:`,
   * what resuming it needs (`Last-Event-ID`).
   */
  private async consumeSse(
    response: Response,
    controller: AbortController,
    onEvent?: (event: SseEvent) => void
  ): Promise<{ lastEventId?: string; retryMs?: number }> {
    if (!response.body) return {}
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    const position = (): { lastEventId?: string; retryMs?: number } => ({
      ...(parser.lastEventId ? { lastEventId: parser.lastEventId } : {}),
      ...(parser.retryMs !== undefined ? { retryMs: parser.retryMs } : {})
    })
    let total = 0
    const handle = (events: SseEvent[]): void => {
      for (const event of events) {
        onEvent?.(event)
        if (event.event !== 'message' || !event.data.trim() || event.data === '[DONE]') continue
        try {
          this.dispatch(JSON.parse(event.data))
        } catch {
          /* ignore malformed events */
        }
      }
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES * 4) {
          controller.abort()
          throw new Error('fluxo SSE do servidor MCP passou do limite de tamanho')
        }
        handle(parser.push(decoder.decode(value, { stream: true })))
      }
      handle(parser.push(decoder.decode())) // flush a trailing partial character
      handle(parser.end())
    } catch (err) {
      if (controller.signal.aborted) return position()
      // The stream dropped: the caller may resume it from the last event it got.
      if (parser.lastEventId) return position()
      throw err
    }
    return position()
  }

  /**
   * The SSE stream of a request ended before its answer: ask the server for the rest with `Last-Event-ID` (Streamable
   * HTTP resumability), a few times, waiting what its `retry:` asked. False when it cannot resume (no id, no stream).
   */
  private async resumeSse(id: number, from: { lastEventId?: string; retryMs?: number }, controller: AbortController): Promise<boolean> {
    let position = from
    for (let attempt = 0; attempt < MAX_SSE_RESUMES && position.lastEventId && this.pending.has(id); attempt++) {
      if (controller.signal.aborted || !this.config.url) return false
      await sleepMs(Math.min(Math.max(position.retryMs ?? 500, 100), 10_000), controller.signal)
      const headers = this.remoteHeaders({ accept: 'text/event-stream', 'last-event-id': position.lastEventId })
      delete headers['content-type']
      let response: Response
      try {
        response = await fetch(this.config.url, { method: 'GET', headers, signal: controller.signal })
      } catch {
        continue
      }
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        await response.body?.cancel().catch(() => undefined)
        return false
      }
      const next = await this.consumeSse(response, controller).catch(() => ({}) as { lastEventId?: string; retryMs?: number })
      position = { lastEventId: next.lastEventId ?? position.lastEventId, retryMs: next.retryMs ?? position.retryMs }
    }
    return !this.pending.has(id)
  }

  /** Legacy HTTP+SSE: GET the stream, wait for the `endpoint` event, then POST messages there. */
  private async openLegacyStream(timeoutMs: number): Promise<void> {
    const url = this.config.url
    if (!url) throw new Error(`servidor MCP ${this.name} sem url`)
    const controller = new AbortController()
    this.legacyAbort = controller
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.remoteHeaders({ accept: 'text/event-stream' }, false),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(timer)
      if (controller.signal.aborted) throw new Error(`timeout de MCP ${this.name}.sse (${timeoutMs}ms)`)
      throw new McpNetworkError(`falha de rede em sse: ${networkMessage(err)}`)
    }
    if (response.status === 401 || response.status === 403) {
      clearTimeout(timer)
      const challenge = response.headers.get('www-authenticate') ?? undefined
      const text = await this.readText(response, controller).catch(() => '')
      const unauthorized = new McpUnauthorizedError(`HTTP ${response.status} em sse: ${text.slice(0, 300)}${challenge ? ` [desafio: ${challenge.slice(0, 300)}]` : ''}`, challenge)
      if (this.config.onUnauthorized) {
        const token = await this.config.onUnauthorized(challenge)
        if (token) {
          this.config.oauthToken = token
          return this.openLegacyStream(timeoutMs)
        }
      }
      throw unauthorized
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      clearTimeout(timer)
      await response.body?.cancel().catch(() => undefined)
      // 200 without an event stream, or any 4xx that is not about credentials/rate (404, 405, 410 Gone: many
      // providers retired their /sse endpoint): this URL does not speak the old transport, so try the other one.
      if (response.ok || (response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status))) {
        throw new McpTransportMismatch(`o endereço não é um fluxo SSE (HTTP ${response.status})`)
      }
      throw new McpHttpError(`HTTP ${response.status} em sse`, response.status)
    }
    const endpoint = await new Promise<string>((resolve, reject) => {
      let found = false
      const onTimer = setTimeout(() => {
        controller.abort()
        reject(new Error(`timeout de MCP ${this.name}.sse (${timeoutMs}ms): o servidor não enviou o evento endpoint`))
      }, timeoutMs)
      void this.consumeSse(response, controller, (event) => {
        if (event.event === 'endpoint' && !found) {
          found = true
          clearTimeout(onTimer)
          resolve(event.data.trim())
        }
      })
        .then(() => {
          // The stream ended: before the endpoint it is a failure to connect; later it is a lost connection.
          if (!found) {
            clearTimeout(onTimer)
            reject(new McpTransportMismatch('o fluxo SSE terminou sem enviar o evento endpoint'))
          } else if (!this.stopping && this.state === 'ready') {
            this.connectionLost('o fluxo SSE do servidor foi encerrado')
          }
        })
        .catch((err) => {
          if (!found) {
            clearTimeout(onTimer)
            reject(err)
          } else if (!this.stopping && this.state === 'ready') {
            this.connectionLost(`o fluxo SSE falhou: ${(err as Error).message}`)
          }
        })
    }).finally(() => clearTimeout(timer))
    const target = new URL(endpoint, url)
    // A server must not be able to point the client (and its credentials) at another host.
    if (target.origin !== new URL(url).origin) {
      controller.abort()
      throw new Error(`o servidor SSE indicou um endpoint de outra origem (${target.origin}); conexão recusada`)
    }
    this.legacyEndpoint = target.toString()
  }

  private async postLegacy(body: Record<string, unknown>): Promise<void> {
    const endpoint = this.legacyEndpoint
    if (!endpoint) throw new Error('servidor MCP não iniciado')
    const method = String(body.method ?? 'resposta')
    let response: Response
    try {
      response = await fetch(endpoint, { method: 'POST', headers: this.remoteHeaders({}, false), body: JSON.stringify(body) })
    } catch (err) {
      throw this.failedFetch(method, err)
    }
    const challenge = response.headers.get('www-authenticate') ?? undefined
    const text = await response.text().catch(() => '')
    if (response.status === 401 || (response.status === 403 && /bearer/i.test(challenge ?? ''))) {
      throw new McpUnauthorizedError(`HTTP ${response.status} em ${method}: ${text.slice(0, 300)}`, challenge)
    }
    if (!response.ok) throw new McpHttpError(`HTTP ${response.status} em ${method}: ${text.slice(0, 400)}`, response.status)
  }

  /** Streamable HTTP: an optional GET stream for server-initiated messages, opened only if the server announces list changes. */
  private startListening(): void {
    if (this.mode !== 'streamable' || this.listenAbort || !this.config.url) return
    const caps = this.capabilities as Record<string, { listChanged?: boolean } | undefined>
    const announces = Boolean(caps.tools?.listChanged || caps.resources?.listChanged || caps.prompts?.listChanged)
    if (!announces) return
    const controller = new AbortController()
    this.listenAbort = controller
    const url = this.config.url
    void (async () => {
      let failures = 0
      // Where the stream was: a reconnection asks for what came after it, so no notification is lost.
      let lastEventId: string | undefined
      while (!controller.signal.aborted && this.state === 'ready') {
        try {
          const headers = this.remoteHeaders({ accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) })
          delete headers['content-type']
          const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
          if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
            await response.body?.cancel().catch(() => undefined)
            return // 405 and friends: the server offers no stream
          }
          failures = 0
          lastEventId = (await this.consumeSse(response, controller)).lastEventId ?? lastEventId
        } catch {
          if (controller.signal.aborted) return
          failures++
        }
        if (failures >= 3 || controller.signal.aborted) return
        await sleepMs(Math.min(500 * 2 ** failures, 8_000), controller.signal)
      }
    })()
  }

  /* ------------------------ list_changed, reconnect ------------------ */

  private scheduleRefresh(kind: 'tools' | 'resources' | 'prompts'): void {
    const existing = this.refreshTimers.get(kind)
    if (existing) clearTimeout(existing)
    const delay = positiveMs(this.config.listChangedDebounceMs, DEFAULT_LIST_CHANGED_DEBOUNCE_MS)
    const timer = setTimeout(() => {
      this.refreshTimers.delete(kind)
      void this.refresh(kind)
    }, delay)
    timer.unref?.()
    this.refreshTimers.set(kind, timer)
  }

  /** Reloads one collection after `list_changed`. A failure keeps the previous list, like Claude Code. */
  private async refresh(kind: 'tools' | 'resources' | 'prompts'): Promise<void> {
    if (this.state !== 'ready') return
    const timeout = this.callTimeout()
    try {
      if (kind === 'tools') await this.loadTools(timeout)
      else if (kind === 'resources' && this.capabilities.resources) await this.loadResources(timeout)
      else if (kind === 'prompts' && this.capabilities.prompts) await this.loadPrompts(timeout)
      else return
    } catch {
      return
    }
    try {
      this.config.onToolsChanged?.(kind)
    } catch {
      /* listener errors are not the server's problem */
    }
    this.emitChange()
  }

  /** The transport went away while the client was `ready`. */
  private connectionLost(reason: string): void {
    if (this.stopping || this.state !== 'ready') return
    this.lastError = `conexão perdida: ${reason}`.slice(0, 800)
    // Synchronous, so late signals from the dying transport (stream end, exit event) are ignored.
    this.state = 'error'
    this.failPending(new McpConnectionLostError(this.lastError))
    this.emitChange()
    void this.teardownTransport().finally(() => {
      if (!this.stopping && this.config.reconnect) this.scheduleReconnect(1)
    })
  }

  private reconnectOptions(): { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } {
    const cfg = this.config.reconnect || {}
    return {
      maxAttempts: positiveMs(cfg.maxAttempts, 5),
      baseDelayMs: positiveMs(cfg.baseDelayMs, 1_000),
      maxDelayMs: positiveMs(cfg.maxDelayMs, 30_000)
    }
  }

  private scheduleReconnect(attempt: number): void {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.reconnectOptions()
    if (attempt > maxAttempts) {
      this.reconnectAttempt = 0
      this.reconnectNextAt = undefined
      this.lastError = `${this.lastError ?? 'conexão perdida'} (reconexão esgotada após ${maxAttempts} tentativas; use mcp_reload)`.slice(0, 900)
      this.emitChange()
      return
    }
    const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
    this.reconnectAttempt = attempt
    this.reconnectNextAt = Date.now() + delay
    this.emitChange()
    this.clearReconnect()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping || this.state === 'ready') return
      this.reconnectNextAt = undefined
      const attempting = this.connect(positiveMs(this.config.startTimeoutMs, DEFAULT_START_TIMEOUT_MS))
      this.startPromise = attempting.finally(() => {
        this.startPromise = null
      })
      this.startPromise.then(
        () => {
          this.reconnectAttempt = 0
          try {
            this.config.onToolsChanged?.('tools')
          } catch {
            /* ignore */
          }
        },
        (err) => {
          if (this.stopping) return
          // Authentication and not-found errors will not fix themselves: stop retrying.
          if (err instanceof McpUnauthorizedError || (err instanceof McpHttpError && err.status === 404)) {
            this.reconnectAttempt = 0
            this.emitChange()
            return
          }
          this.scheduleReconnect(attempt + 1)
        }
      )
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /** Reconnects now (resets the backoff). Resolves when the server is ready, rejects with the failure. */
  async reconnectNow(): Promise<void> {
    this.clearReconnect()
    this.reconnectAttempt = 0
    this.reconnectNextAt = undefined
    if (this.state === 'ready') return
    await this.teardownTransport()
    this.state = 'stopped'
    await this.start()
  }

  /** Waits until the client is `ready` again (during a reconnection); false when the time runs out or it was stopped. */
  private async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !signal?.aborted && !this.stopping) {
      if (this.state === 'ready') return true
      await sleepMs(100, signal)
    }
    return this.state === 'ready'
  }

  /* ------------------------------ stop ------------------------------- */

  /** Drops the transport (process, streams) without touching the cached lists or the stop flag. */
  private async teardownTransport(): Promise<void> {
    this.listenAbort?.abort()
    this.listenAbort = null
    this.legacyAbort?.abort()
    this.legacyAbort = null
    this.legacyEndpoint = null
    this.failPending(new McpConnectionLostError(`servidor MCP ${this.name} desconectado`))
    const child = this.child
    this.child = null
    if (child) await this.terminate(child, 1_000)
  }

  private async terminate(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
    // No pid: the process never started (spawn ENOENT), so there is nothing to wait for.
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    const quick = await Promise.race([exited.then(() => true), sleepMs(graceMs).then(() => false)])
    if (quick) return
    await killProcessTree(child)
    await Promise.race([exited, sleepMs(2_000)])
  }

  /**
   * Stops the server: closes stdin and waits `graceMs` for the process to leave, then kills it and its children
   * (taskkill /T on Windows). Remote servers get a DELETE for their session. Never waits longer than that.
   */
  async stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<void> {
    this.stopping = true
    this.clearReconnect()
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
    const session = this.httpSession
    const remoteUrl = this.remote && session && this.config.url ? this.config.url : null
    const headers = remoteUrl ? this.remoteHeaders() : undefined
    this.listenAbort?.abort()
    this.listenAbort = null
    this.legacyAbort?.abort()
    this.legacyAbort = null
    this.failPending(new McpConnectionLostError(`servidor MCP ${this.name} parado`))
    const child = this.child
    this.child = null
    if (remoteUrl && headers) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1_500)
      await fetch(remoteUrl, { method: 'DELETE', headers, signal: controller.signal })
        .then((response) => response.body?.cancel().catch(() => undefined))
        .catch(() => undefined)
      clearTimeout(timer)
    }
    if (child) await this.terminate(child, graceMs)
    this.httpSession = null
    this.protocolVersion = null
    this.legacyEndpoint = null
    this.state = 'stopped'
    this.reconnectAttempt = 0
    this.reconnectNextAt = undefined
    this.allTools = []
    this.resources = []
    this.resourceTemplates = []
    this.prompts = []
    this.capabilities = {}
    this.serverInstructions = undefined
    this.emitChange()
  }
}

interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * Reads a JSON-RPC response from either a plain JSON body or an SSE stream
 * (`data: {...}` lines). Returns the message matching `id`, then falls back to
 * the first response without an error.
 */
export function parseRpcResponse(body: string, id: number): RpcMessage | null {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as RpcMessage
    } catch {
      return null
    }
  }
  if (trimmed.startsWith('[')) {
    try {
      const list = JSON.parse(trimmed) as RpcMessage[]
      return list.find((message) => message.id === id) ?? list[0] ?? null
    } catch {
      return null
    }
  }
  const messages: RpcMessage[] = []
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        messages.push(JSON.parse(data) as RpcMessage)
      } catch {
        /* ignore malformed events */
      }
    }
  }
  return messages.find((message) => message.id === id) ?? messages.find((message) => !message.error) ?? messages[0] ?? null
}
