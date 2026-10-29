import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { createLogStats, readLogLine, type ServerLogStats } from '../../core/llamacpp/log.js'
import { killTree } from '../../core/tools/shell.js'
import type { LlamaServerState } from '../../shared/llamacpp.js'

const LOG_LINES = 800
/** Large models from a slow disk take minutes to load; the first CUDA run also compiles kernels once. */
const READY_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 500
const EXE_NAME = 'llama-server.exe'

export interface ServerSnapshot {
  state: LlamaServerState
  error: string
  hint: string
  port: number
  pid?: number
  startedAt: number
  readyAt: number
  speed: { prompt: number; gen: number }
  offload: string
  device: string
  deviceMiB: number
  models: string[]
  nCtx?: number
  slots?: number
  vision: boolean
  build: string
}

export interface LlamaServerDeps {
  spawn?: typeof nodeSpawn
  fetch?: typeof fetch
  readyTimeoutMs?: number
  pollMs?: number
  /** Where the running server's pid is kept, so the next start of the app can stop one an app crash left behind. */
  pidFile?: string
  onReady?(snapshot: ServerSnapshot): void
  onExit?(snapshot: ServerSnapshot): void
  onLine?(line: string): void
}

/** A free TCP port on 127.0.0.1, chosen by the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Node has no Windows job object with "kill on close", so the llama-server of an app that crashed keeps running.
 * The pid file names it; on the next start this stops it — but only when that pid really is a llama-server.exe
 * (a reused pid now belonging to another program is left alone).
 */
export function stopStaleServer(pidFile: string): boolean {
  let pid = 0
  try {
    pid = Number(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid) || 0
  } catch {
    return false
  }
  fs.rmSync(pidFile, { force: true })
  if (!pid || process.platform !== 'win32') return false
  try {
    const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
    if (!row.toLowerCase().includes(`"${EXE_NAME}"`)) return false
  } catch {
    return false
  }
  killTree(pid)
  return true
}

/** One llama-server at a time: starts it, follows its log and health, stops it. */
export class LlamaServer {
  private proc: ChildProcess | null = null
  private lines: Array<[number, string]> = []
  private seq = 0
  private stopping = false
  private apiKey = ''
  private stats: ServerLogStats = createLogStats()
  private snap: ServerSnapshot = LlamaServer.empty('parado')

  constructor(private readonly deps: LlamaServerDeps = {}) {}

  private static empty(state: LlamaServerState): ServerSnapshot {
    return { state, error: '', hint: '', port: 0, startedAt: 0, readyAt: 0, speed: { prompt: 0, gen: 0 }, offload: '', device: '', deviceMiB: 0, models: [], vision: false, build: '' }
  }

  get running(): boolean {
    return this.proc !== null
  }

  status(): ServerSnapshot {
    const { offload, device, deviceMiB } = this.stats
    return { ...this.snap, speed: { ...this.stats.speed }, offload, device, deviceMiB, pid: this.proc?.pid }
  }

  log(since = 0, limit = 400): { seq: number; lines: string[] } {
    return { seq: this.seq, lines: this.lines.filter(([number]) => number > since).slice(-limit).map(([, line]) => line) }
  }

  private add(raw: string): void {
    const line = raw.replace(/\r?\n$/, '')
    if (!line) return
    this.seq += 1
    this.lines.push([this.seq, line])
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES)
    readLogLine(this.stats, line)
    if (this.stats.error) this.snap.error = this.stats.error
    if (this.stats.hint) this.snap.hint = this.stats.hint
    this.deps.onLine?.(line)
  }

  /** Starts the server. The key is NOT in `args`: the caller passes it in `env` (LLAMA_API_KEY) and here only to authenticate the checks. */
  start(input: { exe: string; args: string[]; port: number; apiKey: string; env: Record<string, string> }): void {
    if (this.proc) throw new Error('O llama-server já está rodando.')
    if (input.args.includes(input.apiKey)) throw new Error('a chave não pode ir na linha de comando')
    this.stats = createLogStats()
    this.snap = { ...LlamaServer.empty('iniciando'), port: input.port, startedAt: Date.now() }
    this.stopping = false
    this.apiKey = input.apiKey
    this.add(`[openclod] iniciando: ${path.basename(input.exe)} ${input.args.join(' ')}`)
    const spawn = this.deps.spawn ?? nodeSpawn
    const proc = spawn(input.exe, input.args, {
      cwd: path.dirname(input.exe),
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.proc = proc
    if (this.deps.pidFile && proc.pid) {
      fs.mkdirSync(path.dirname(this.deps.pidFile), { recursive: true })
      fs.writeFileSync(this.deps.pidFile, JSON.stringify({ pid: proc.pid, exe: input.exe, startedAt: this.snap.startedAt }))
    }
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => this.add(line))
    }
    proc.on('error', (error) => {
      this.add(`[openclod] não consegui iniciar o llama-server: ${error.message}`)
      this.snap.error = `Não consegui iniciar o llama-server: ${error.message}`
    })
    proc.on('exit', (code) => this.exited(proc, code))
    void this.waitReady(proc)
  }

  private exited(proc: ChildProcess, code: number | null): void {
    if (this.proc !== proc) return
    this.proc = null
    if (this.deps.pidFile) fs.rmSync(this.deps.pidFile, { force: true })
    if (this.stopping) {
      this.snap.state = 'parado'
    } else {
      this.snap.state = 'erro'
      this.snap.error = this.stats.hint || this.snap.error || `O llama-server fechou sozinho (código ${code ?? '?'}). Veja o log.`
    }
    this.add(`[openclod] llama-server encerrado (código ${code ?? '?'})`)
    this.deps.onExit?.(this.status())
  }

  private async request(route: string, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
    const response = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${this.snap.port}${route}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: response.status, body }
  }

  private async waitReady(proc: ChildProcess): Promise<void> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
    const poll = this.deps.pollMs ?? POLL_MS
    let ready = false
    while (Date.now() < deadline) {
      if (this.proc !== proc) return
      try {
        // 503 = still loading the model; 200 = ready.
        if ((await this.request('/health', 3_000)).status === 200) {
          ready = true
          break
        }
      } catch {
        /* not listening yet */
      }
      await sleep(poll)
    }
    if (this.proc !== proc) return
    if (!ready) {
      this.snap.error = `O modelo não terminou de carregar em ${Math.round((this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS) / 60_000)} minutos.`
      await this.stop()
      return
    }
    let props: Record<string, unknown> = {}
    let models: string[] = []
    try {
      const read = await this.request('/props')
      if (read.body && typeof read.body === 'object') props = read.body as Record<string, unknown>
      const listing = await this.request('/v1/models')
      const data = (listing.body as { data?: Array<{ id?: unknown }> } | null)?.data
      models = Array.isArray(data) ? data.map((item) => item.id).filter((id): id is string => typeof id === 'string') : []
    } catch {
      /* the server answers chat even if these fail */
    }
    if (this.proc !== proc) return
    const generation = props.default_generation_settings as { n_ctx?: unknown } | undefined
    const modalities = props.modalities as { vision?: unknown } | undefined
    this.snap = {
      ...this.snap,
      state: 'pronto',
      readyAt: Date.now(),
      models,
      nCtx: typeof generation?.n_ctx === 'number' ? generation.n_ctx : undefined,
      slots: typeof props.total_slots === 'number' ? props.total_slots : undefined,
      vision: Boolean(modalities?.vision),
      build: typeof props.build_info === 'string' ? props.build_info : ''
    }
    this.add(`[openclod] pronto em ${((this.snap.readyAt - this.snap.startedAt) / 1000).toFixed(1)} s, na porta ${this.snap.port}`)
    this.deps.onReady?.(this.status())
  }

  /** Stops the server; resolves true when one was running. */
  async stop(timeoutMs = 15_000): Promise<boolean> {
    const proc = this.proc
    if (!proc) {
      if (this.snap.state !== 'erro') this.snap.state = 'parado'
      return false
    }
    this.stopping = true
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    if (proc.pid) killTree(proc.pid)
    else proc.kill()
    await Promise.race([exited, sleep(timeoutMs)])
    if (this.proc === proc) {
      proc.kill('SIGKILL')
      this.exited(proc, null)
    }
    return true
  }
}
