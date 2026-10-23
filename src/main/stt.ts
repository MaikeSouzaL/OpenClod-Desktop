import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SttEvent, SttModelInfo, SttReady, SttStartOptions, SttStatusInfo } from '../shared/api.js'
import { sanitizedEnv } from '../core/security/policy.js'
import { resourcePath, resourcesRoot } from '../core/util/resources.js'

/**
 * Supervisor for the embedded Whisper sidecar (`resources/stt/forja_stt.py`).
 *
 * The sidecar is a long-lived Python process that speaks one JSON object per
 * line on stdin/stdout. It owns the model and the VAD; this class only moves
 * audio in and events out, so the Electron main process never blocks on a
 * decode.
 */

const START_TIMEOUT_MS = 180_000
const FLUSH_TIMEOUT_MS = 6_000
const EXIT_TIMEOUT_MS = 3_000
/** 100 ms of 16 kHz mono int16 is ~3.2 kB; anything much larger is a bug. */
const MAX_AUDIO_BYTES = 512 * 1024
const MODEL_ORDER: Record<string, number> = { tiny: 0, base: 1, small: 2, medium: 3, large: 4 }

export interface SttServiceOptions {
  emit(event: SttEvent): void
  log(scope: string, message: unknown): void
}

interface ReadyWait {
  resolve(ready: SttReady): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface FlushWait {
  resolve(): void
  timer: NodeJS.Timeout
}

/** Models shipped in `resources/models/whisper`, sorted smallest first. */
export function discoverSttModels(dir: string | null = resourcePath('models', 'whisper')): SttModelInfo[] {
  if (!dir) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const models: SttModelInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = path.join(dir, entry.name)
    const weights = path.join(folder, 'model.bin')
    let stat: fs.Stats
    try {
      stat = fs.statSync(weights)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0) continue
    let id = entry.name
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder, 'forja-model.json'), 'utf8')) as { id?: unknown }
      if (typeof meta.id === 'string' && meta.id) id = meta.id
    } catch {
      /* the folder name is enough */
    }
    models.push({ id, sizeMB: Math.round(stat.size / (1024 * 1024)) })
  }
  return models.sort((a, b) => (MODEL_ORDER[a.id] ?? 99) - (MODEL_ORDER[b.id] ?? 99) || a.id.localeCompare(b.id))
}

export interface SttAvailability {
  available: boolean
  reason?: string
  models: SttModelInfo[]
}

/** Whether the embedded runtime, the sidecar and at least one model are on disk. */
export function sttAvailability(): SttAvailability {
  const models = discoverSttModels()
  if (!resourcesRoot()) {
    return { available: false, reason: 'Os recursos de voz não foram encontrados nesta instalação.', models }
  }
  const python = pythonPath()
  if (!python) return { available: false, reason: 'O Python embutido do reconhecimento de voz não foi encontrado.', models }
  if (!resourcePath('stt', 'forja_stt.py')) {
    return { available: false, reason: 'O motor de voz (forja_stt.py) não foi encontrado.', models }
  }
  if (!models.length) {
    return { available: false, reason: 'Nenhum modelo Whisper foi encontrado em resources/models/whisper.', models }
  }
  return { available: true, models }
}

function pythonPath(): string | null {
  return resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
}

export class SttService {
  private child: ChildProcess | null = null
  private readonly options: SttServiceOptions
  private stdoutBuffer = ''
  private readyWait: ReadyWait | null = null
  private flushWait: FlushWait | null = null
  private ready: SttReady | null = null
  private stopping = false
  private disposed = false
  private lastError: string | undefined

  constructor(options: SttServiceOptions) {
    this.options = options
  }

  private log(message: unknown): void {
    this.options.log('stt', message)
  }

  status(): SttStatusInfo {
    const availability = sttAvailability()
    return {
      available: availability.available,
      reason: availability.reason,
      models: availability.models,
      device: this.ready?.device ?? 'auto',
      running: this.child !== null
    }
  }

  async start(options: SttStartOptions = {}): Promise<SttReady> {
    if (this.disposed) throw new Error('o serviço de voz foi encerrado')
    if (this.child) await this.stop()

    const availability = sttAvailability()
    if (!availability.available) throw new Error(availability.reason ?? 'o reconhecimento de voz não está disponível')

    const python = pythonPath()
    const script = resourcePath('stt', 'forja_stt.py')
    const modelsDir = resourcePath('models', 'whisper')
    if (!python || !script || !modelsDir) throw new Error('os recursos de voz estão incompletos')

    const requested = typeof options.model === 'string' && /^[A-Za-z0-9._-]+$/.test(options.model) ? options.model : ''
    const model = availability.models.some((item) => item.id === requested) ? requested : availability.models[0].id
    const language = normalizeLanguage(options.language)

    this.lastError = undefined
    this.stopping = false
    this.stdoutBuffer = ''
    const child = spawn(python, ['-I', '-X', 'utf8', script, modelsDir], {
      cwd: path.dirname(script),
      env: {
        ...sanitizedEnv(),
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false'
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.attach(child)

    const ready = new Promise<SttReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWait = null
        this.kill()
        reject(new Error(`o modelo de voz demorou mais de ${START_TIMEOUT_MS / 1000}s para carregar`))
      }, START_TIMEOUT_MS)
      this.readyWait = { resolve, reject, timer }
    })

    this.send({ type: 'start', model, language, device: 'auto', partial_interval_ms: 1200, silence_ms: 700 })
    return ready
  }

  /** Finalizes what is buffered (so the last utterance still arrives), then exits. */
  async stop(): Promise<boolean> {
    const child = this.child
    if (!child) return true
    this.stopping = true
    try {
      if (this.ready && child.exitCode === null) {
        const flushed = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.flushWait = null
            resolve()
          }, FLUSH_TIMEOUT_MS)
          this.flushWait = { resolve, timer }
        })
        this.send({ type: 'flush' })
        await flushed
      }
      if (child.exitCode === null) this.send({ type: 'stop' })
      await waitForExit(child, EXIT_TIMEOUT_MS)
    } finally {
      if (child.exitCode === null) this.kill()
      this.reset()
      this.stopping = false
    }
    return true
  }

  /** Fire-and-forget: 16 kHz mono little-endian int16 samples from the renderer. */
  audio(pcm: ArrayBuffer | Uint8Array): void {
    const child = this.child
    if (!child || !this.ready || this.stopping || child.exitCode !== null) return
    const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
    if (!bytes.byteLength || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_AUDIO_BYTES) return
    // Back-pressure: drop instead of growing the main process without bound.
    if (child.stdin && child.stdin.writableLength > 4 * 1024 * 1024) {
      this.log('áudio descartado: o motor de voz está atrasado')
      return
    }
    this.send({ type: 'audio', pcm: Buffer.from(bytes).toString('base64') })
  }

  dispose(): void {
    this.disposed = true
    this.kill()
    this.reset()
  }

  private reset(): void {
    this.child = null
    this.ready = null
    this.readyWait = null
    this.flushWait = null
    this.stdoutBuffer = ''
  }

  private send(command: Record<string, unknown>): boolean {
    const child = this.child
    if (!child?.stdin || child.stdin.destroyed || child.exitCode !== null) return false
    try {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      return true
    } catch (err) {
      this.log(`falha ao enviar comando para o motor de voz: ${(err as Error).message}`)
      return false
    }
  }

  private attach(child: ChildProcess): void {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim()
        if (text) this.log(text)
      }
    })
    child.on('error', (error) => this.fail(`falha ao iniciar o motor de voz: ${error.message}`))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.stdin?.on('error', (error) => this.log(`stdin do motor de voz: ${error.message}`))
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.onLine(line)
    }
    // A malformed/hostile line must not grow forever.
    if (this.stdoutBuffer.length > 2_000_000) this.stdoutBuffer = ''
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') return
      message = parsed as Record<string, unknown>
    } catch {
      this.log(`linha inválida do motor de voz: ${line.slice(0, 200)}`)
      return
    }

    switch (message.type) {
      case 'ready': {
        const ready: SttReady = {
          model: String(message.model ?? ''),
          device: String(message.device ?? 'cpu'),
          computeType: typeof message.compute_type === 'string' ? message.compute_type : undefined,
          loadMs: Number(message.load_ms) || 0
        }
        this.ready = ready
        const waiter = this.readyWait
        this.readyWait = null
        if (waiter) {
          clearTimeout(waiter.timer)
          waiter.resolve(ready)
        }
        this.log(`modelo ${ready.model} pronto em ${ready.device} (${ready.loadMs} ms)`)
        break
      }
      case 'partial':
        this.options.emit({ type: 'partial', utterance: Number(message.utterance) || 0, text: String(message.text ?? '') })
        break
      case 'final':
        this.options.emit({
          type: 'final',
          utterance: Number(message.utterance) || 0,
          text: String(message.text ?? ''),
          language: typeof message.language === 'string' ? message.language : undefined
        })
        break
      case 'level':
        this.options.emit({ type: 'level', rms: clamp01(Number(message.rms)) })
        break
      case 'flushed': {
        const waiter = this.flushWait
        this.flushWait = null
        if (waiter) {
          clearTimeout(waiter.timer)
          waiter.resolve()
        }
        break
      }
      case 'error': {
        const text = String(message.message ?? 'erro no motor de voz')
        this.lastError = text
        this.options.emit({ type: 'error', message: text, fatal: Boolean(message.fatal) })
        if (message.fatal) this.fail(text)
        break
      }
      case 'exit':
        if (!this.stopping) this.options.emit({ type: 'exit' })
        break
      default:
        this.log(`evento desconhecido do motor de voz: ${String(message.type)}`)
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.stopping
    const detail = this.lastError ?? (code === null ? `sinal ${signal ?? 'desconhecido'}` : `código ${code}`)
    this.log(`motor de voz encerrou (${detail})`)

    const waiter = this.readyWait
    this.readyWait = null
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(this.lastError ?? `o motor de voz encerrou antes de carregar (${detail})`))
    }
    const flush = this.flushWait
    this.flushWait = null
    if (flush) {
      clearTimeout(flush.timer)
      flush.resolve()
    }
    this.child = null
    this.ready = null
    if (!wasStopping && !this.disposed) this.options.emit({ type: 'exit' })
  }

  private fail(reason: string): void {
    this.lastError = reason
    const waiter = this.readyWait
    this.readyWait = null
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    if (!this.stopping) this.options.emit({ type: 'error', message: reason, fatal: true })
    this.kill()
  }

  private kill(): void {
    const child = this.child
    if (!child || child.exitCode !== null) return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

function normalizeLanguage(value: unknown): string {
  if (typeof value !== 'string') return 'auto'
  const language = value.trim().toLowerCase()
  if (!language || language === 'auto') return 'auto'
  return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(language) ? language : 'auto'
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)
    const done = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.removeListener('exit', done)
    }
    child.once('exit', done)
  })
}
