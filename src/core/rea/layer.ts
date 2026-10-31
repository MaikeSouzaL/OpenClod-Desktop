import fs from 'node:fs'
import path from 'node:path'
import type { ToolResult } from '../../shared/types.js'
import { McpClient, type McpCallOptions } from '../mcp/client.js'
import { resourcePath } from '../util/resources.js'
import { loadReaCatalog, type ReaCatalog } from './catalog.js'
import { buildReaEnvironment, readReaState, type ReaEngineStatus, type ReaState } from './engines.js'

/**
 * The REA server bundled with the app (resources/rea, see scripts/embed-rea.mjs): REA's own MCP server, started with the
 * bundled Node only when a REA tool is first called and kept for the rest of the app's life (Ghidra sessions, Frida
 * sessions and evidence live in that process). A crash is not fatal: the next call starts a new one.
 */

/** Ghidra's first import of a binary takes minutes; REA's own start budget is 330 s. */
export const REA_CALL_TIMEOUT_MS = 12 * 60_000
/**
 * The MCP client must not cut REA's answers: a complete result is one JSON document (250 kB for a small JavaScript app),
 * and a cut in the middle leaves JSON nobody can parse. REA caps its own responses (REA_MCP_MAX_RESPONSE_BYTES); the
 * runner then writes anything too long for the context to a file the model can read whole.
 */
export const REA_MAX_OUTPUT_TOKENS = 4_000_000
const REA_START_TIMEOUT_MS = 90_000

export interface ReaStatus {
  available: boolean
  /** Why it is not available, in pt-BR. */
  detail: string
  version?: string
  node?: string
  tools: number
  state: 'stopped' | 'starting' | 'ready' | 'error'
  lastError?: string
  engines: ReaEngineStatus[]
}

export interface ReaLayerOptions {
  /** resources/rea (default: the bundled one). */
  reaDir?: string | null
  /** Writable folder for REA's temporary files (inside the app's data folder). */
  tmpDir: string
  log?: (message: string) => void
}

export class ReaLayer {
  readonly reaDir: string | null
  private readonly tmpDir: string
  private readonly log?: (message: string) => void
  private catalogCache: ReaCatalog | null | undefined
  private stateCache: ReaState | null | undefined
  private client: McpClient | null = null
  private starting: Promise<McpClient> | null = null
  private lastError: string | undefined

  constructor(options: ReaLayerOptions) {
    this.reaDir = options.reaDir === undefined ? resourcePath('rea') : options.reaDir
    this.tmpDir = options.tmpDir
    this.log = options.log
  }

  private get nodeExe(): string | null {
    if (!this.reaDir) return null
    const file = path.join(this.reaDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    return fs.existsSync(file) ? file : null
  }

  private get entry(): string | null {
    if (!this.reaDir) return null
    const file = path.join(this.reaDir, 'app', 'scripts', 'rea.mjs')
    return fs.existsSync(file) ? file : null
  }

  catalog(): ReaCatalog | null {
    if (this.catalogCache === undefined) this.catalogCache = this.reaDir ? loadReaCatalog(this.reaDir) : null
    return this.catalogCache
  }

  private state(): ReaState | null {
    if (this.stateCache === undefined) this.stateCache = this.reaDir ? readReaState(this.reaDir) : null
    return this.stateCache
  }

  get available(): boolean {
    return Boolean(this.nodeExe && this.entry && this.catalog())
  }

  private unavailableReason(): string {
    if (!this.reaDir) return 'REA não embutido: falta resources/rea (rode node scripts/embed-rea.mjs)'
    if (!this.nodeExe) return 'falta o Node do REA em resources/rea/node (node scripts/embed-rea.mjs --only node)'
    if (!this.entry) return 'falta o REA em resources/rea/app (node scripts/embed-rea.mjs --only app)'
    return 'falta o catálogo resources/rea/catalog.json (node scripts/embed-rea.mjs --only catalog)'
  }

  status(): ReaStatus {
    const engines = this.reaDir ? buildReaEnvironment(this.reaDir, this.tmpDir, { state: this.state() }).engines : []
    const catalog = this.catalog()
    return {
      available: this.available,
      detail: this.available ? `REA ${catalog?.version} embutido (${catalog?.tools.length} ferramentas)` : this.unavailableReason(),
      version: catalog?.version,
      node: this.state()?.parts.node?.version,
      tools: catalog?.tools.length ?? 0,
      state: this.client?.state ?? (this.starting ? 'starting' : this.lastError ? 'error' : 'stopped'),
      lastError: this.client?.lastError ?? this.lastError,
      engines
    }
  }

  private async backend(): Promise<McpClient> {
    if (this.client?.state === 'ready') return this.client
    if (this.starting) return this.starting
    const nodeExe = this.nodeExe
    const entry = this.entry
    if (!nodeExe || !entry || !this.reaDir) throw new Error(this.unavailableReason())
    const reaDir = this.reaDir
    this.starting = (async () => {
      await this.client?.stop().catch(() => undefined)
      this.client = null
      fs.mkdirSync(this.tmpDir, { recursive: true })
      const { env } = buildReaEnvironment(reaDir, this.tmpDir, { state: this.state() })
      const client = new McpClient({
        name: 'rea',
        command: nodeExe,
        args: [entry, 'mcp'],
        cwd: path.dirname(path.dirname(entry)),
        env,
        timeoutMs: REA_CALL_TIMEOUT_MS,
        startTimeoutMs: REA_START_TIMEOUT_MS,
        maxOutputTokens: REA_MAX_OUTPUT_TOKENS,
        // Answers and questions of REA go through the harness (the call carries its own elicitation handler).
        reconnect: false
      })
      const started = Date.now()
      try {
        await client.start(REA_START_TIMEOUT_MS)
      } catch (err) {
        await client.stop().catch(() => undefined)
        throw err
      }
      this.log?.(`REA: pronto em ${((Date.now() - started) / 1000).toFixed(1)} s (${client.exposedToolsList().length} ferramentas)`)
      this.client = client
      this.lastError = undefined
      return client
    })()
      .catch((err: Error) => {
        this.lastError = err.message
        throw err
      })
      .finally(() => {
        this.starting = null
      })
    return this.starting
  }

  /** Calls one REA tool (the server's own name, without the rea_ prefix). */
  async call(tool: string, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal; call?: McpCallOptions } = {}): Promise<ToolResult> {
    const client = await this.backend()
    return client.callTool(tool, args, options.timeoutMs ?? REA_CALL_TIMEOUT_MS, options.signal, options.call ?? {})
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    await client?.stop().catch(() => undefined)
  }
}
