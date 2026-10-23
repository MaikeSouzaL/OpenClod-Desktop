import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ImagePart, McpServerSettings, RiskLevel, ToolResult } from '../../shared/types.js'

/**
 * One MCP server. The persisted shape is `McpServerSettings`; `enabled` is
 * optional here so internal callers (computer-use backend) can omit it.
 */
export interface McpServerConfig extends Omit<McpServerSettings, 'enabled'> {
  enabled?: boolean
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000
const DEFAULT_START_TIMEOUT_MS = 20_000

/* ------------------------------------------------------------------ */
/* Tool filtering / risk (pure helpers, shared with the orchestrator)   */
/* ------------------------------------------------------------------ */

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** Usable patterns only: settings are user-edited JSON, so entries may be junk. */
function cleanPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return []
  return patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
}

/**
 * Glob-ish match over a server's own tool name: `*` is any run of characters,
 * `?` exactly one; everything else is literal. Case-insensitive.
 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  const source = pattern
    .trim()
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegex(ch)))
    .join('')
  return new RegExp(`^${source}$`, 'i').test(name)
}

export function matchesAnyToolPattern(patterns: unknown, name: string): boolean {
  return cleanPatterns(patterns).some((pattern) => matchesToolPattern(pattern, name))
}

type ToolFilterConfig = Pick<McpServerConfig, 'includeTools' | 'excludeTools'>

/** Whether the filter lets this tool through. An empty include list means "all". */
export function isMcpToolExposed(config: ToolFilterConfig, name: string): boolean {
  const include = cleanPatterns(config.includeTools)
  if (include.length && !include.some((pattern) => matchesToolPattern(pattern, name))) return false
  return !matchesAnyToolPattern(config.excludeTools, name)
}

export function filterMcpTools<T extends { name: string }>(tools: T[], config: ToolFilterConfig): T[] {
  return tools.filter((tool) => isMcpToolExposed(config, tool.name))
}

/**
 * Risk level the harness should give a tool of this server. `approvalTools`
 * map to `destructive`, the only level that still asks in `auto` mode;
 * everything else keeps the MCP default (`exec`: asks in `ask`/`accept-edits`).
 */
export function mcpToolRisk(config: Pick<McpServerConfig, 'approvalTools'>, name: string): RiskLevel {
  return matchesAnyToolPattern(config.approvalTools, name) ? 'destructive' : 'exec'
}

/** Registry name of a server tool: `mcp__<server>__<tool>`, sanitized and capped at 60 chars. */
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
  const list = cleanPatterns(value)
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
  if (typeof server.cwd === 'string' && server.cwd.trim()) out.cwd = server.cwd.trim().slice(0, 500)
  const timeoutMs = clampMs(server.timeoutMs, 1000, 3_600_000)
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs
  const startTimeoutMs = clampMs(server.startTimeoutMs, 1000, 600_000)
  if (startTimeoutMs !== undefined) out.startTimeoutMs = startTimeoutMs
  for (const key of ['includeTools', 'excludeTools', 'approvalTools'] as const) {
    const patterns = sanitizePatterns(server[key])
    if (patterns) out[key] = patterns
  }
  return out
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0).
 * Supports initialize, tools/list and tools/call — the surface the harness
 * needs. Server *prompts* and *resources* are intentionally out of scope.
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private tools: McpToolInfo[] = []
  private hidden = 0
  state: 'stopped' | 'starting' | 'ready' | 'error' = 'stopped'
  lastError: string | null = null

  constructor(private readonly config: McpServerConfig) {}

  get name(): string {
    return this.config.name
  }

  /** Tools the server offers but the include/exclude filter hides. */
  get hiddenToolCount(): number {
    return this.hidden
  }

  async start(timeoutMs = positiveMs(this.config.startTimeoutMs, DEFAULT_START_TIMEOUT_MS)): Promise<void> {
    if (this.state === 'ready') return
    this.state = 'starting'
    const command = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.config.command)
      ? 'cmd.exe'
      : this.config.command
    const args =
      command === 'cmd.exe' ? ['/d', '/s', '/c', this.config.command, ...this.config.args] : this.config.args

    try {
      this.child = spawn(command, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.config.cwd || undefined,
        env: { ...process.env, ...(this.config.env ?? {}) }
      })
    } catch (err) {
      this.state = 'error'
      this.lastError = (err as Error).message
      throw err
    }

    // A server that dies mid-write must not surface as an uncaught EPIPE.
    this.child.stdin.on('error', () => undefined)
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      this.lastError = chunk.toString().slice(0, 500)
    })
    this.child.on('exit', (code) => {
      this.state = code === 0 ? 'stopped' : 'error'
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`servidor MCP ${this.name} encerrou (código ${code})`))
        clearTimeout(pending.timer)
      }
      this.pending.clear()
    })

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'forja', version: '0.1.0' }
      },
      timeoutMs
    )
    this.notify('notifications/initialized', {})
    const list = (await this.request('tools/list', {}, timeoutMs)) as { tools?: McpToolInfo[] }
    const all = (list.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }
    }))
    this.tools = filterMcpTools(all, this.config)
    this.hidden = all.length - this.tools.length
    this.state = 'ready'
  }

  /** Tools exposed to the harness: the server's list after include/exclude filtering. */
  toolsList(): McpToolInfo[] {
    return [...this.tools]
  }

  /** Whether the config lets the model see/call this tool (independent of what the server lists). */
  isToolExposed(name: string): boolean {
    return isMcpToolExposed(this.config, name)
  }

  /** Whether this tool must always ask for approval (`approvalTools`). */
  requiresApproval(name: string): boolean {
    return matchesAnyToolPattern(this.config.approvalTools, name)
  }

  /** Risk level to register the tool with; see `mcpToolRisk`. */
  toolRisk(name: string): RiskLevel {
    return mcpToolRisk(this.config, name)
  }

  /**
   * Calls a tool. The timeout defaults to the server's `timeoutMs` setting
   * (120 s when unset); `signal` aborts the wait and tells the server via
   * `notifications/cancelled`.
   */
  async callTool(
    name: string,
    args: unknown,
    timeoutMs = positiveMs(this.config.timeoutMs, DEFAULT_CALL_TIMEOUT_MS),
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (!this.isToolExposed(name)) {
      throw new Error(`ferramenta ${name} do servidor MCP ${this.name} está desativada pela configuração (includeTools/excludeTools)`)
    }
    const raw = (await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs, signal)) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
      isError?: boolean
    }
    const text = (raw.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    const images: ImagePart[] = (raw.content ?? [])
      .filter((c) => c.type === 'image' && c.data)
      .map((c) => ({
        type: 'image' as const,
        mediaType: (c.mimeType as ImagePart['mediaType']) ?? 'image/png',
        data: c.data!
      }))
    return {
      ok: !raw.isError,
      text: text || (images.length ? `(${images.length} imagem(ns))` : '(sem conteúdo)'),
      images: images.length ? images : undefined,
      summary: `${this.name}/${name}`
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: { id?: number; result?: unknown; error?: { message: string; code: number }; method?: string }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`))
        else pending.resolve(message.result)
      }
      // Server-initiated requests/notifications are acknowledged implicitly.
    }
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('servidor MCP não iniciado'))
    if (signal?.aborted) return Promise.reject(new Error(`chamada MCP ${this.name}.${method} cancelada`))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        this.notify('notifications/cancelled', { requestId: id, reason: 'cancelado pelo usuário' })
        reject(new Error(`chamada MCP ${this.name}.${method} cancelada`))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        reject(new Error(`timeout de MCP ${this.name}.${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer
      })
      this.child!.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async stop(): Promise<void> {
    if (!this.child) return
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      /* ignore */
    }
    this.child = null
    this.state = 'stopped'
    this.tools = []
    this.hidden = 0
  }
}
