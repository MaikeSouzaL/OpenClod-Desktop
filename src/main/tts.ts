import { execFile, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TtsSpeakOptions, TtsSpeakResult, TtsState, TtsVoiceInfo } from '../shared/api.js'
import { sanitizedEnv } from '../core/security/policy.js'
import { resourcePath } from '../core/util/resources.js'

const MAX_TEXT = 20_000
const MAX_EDGE_AUDIO_BYTES = 24 * 1024 * 1024
const EDGE_DEFAULT_VOICE = 'pt-BR-FranciscaNeural'
const EDGE_VOICE_CACHE_MS = 10 * 60_000
const EDGE_FALLBACK_VOICES: TtsVoiceInfo[] = [
  { provider: 'edge', id: 'pt-BR-FranciscaNeural', displayName: 'Francisca — neural, natural', name: 'pt-BR-FranciscaNeural', culture: 'pt-BR', gender: 'Female', age: 'Adult', personalities: ['Friendly', 'Positive'] },
  { provider: 'edge', id: 'pt-BR-AntonioNeural', displayName: 'Antônio — neural, natural', name: 'pt-BR-AntonioNeural', culture: 'pt-BR', gender: 'Male', age: 'Adult', personalities: ['Friendly', 'Positive'] },
  { provider: 'edge', id: 'pt-BR-ThalitaMultilingualNeural', displayName: 'Thalita — neural multilíngue', name: 'pt-BR-ThalitaMultilingualNeural', culture: 'pt-BR', gender: 'Female', age: 'Adult', personalities: ['Friendly', 'Positive'] }
]
const VOICES_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$out = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ name=$_.VoiceInfo.Name; culture=$_.VoiceInfo.Culture.Name; gender=$_.VoiceInfo.Gender.ToString(); age=$_.VoiceInfo.Age.ToString() } })',
  '$out | ConvertTo-Json -Compress',
  '$s.Dispose()'
].join('\r\n')

const SPEAK_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENCLOD_TTS_TEXT))',
  '$voice = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENCLOD_TTS_VOICE))',
  'if ($voice) { try { $s.SelectVoice($voice) } catch {} }',
  '$s.Rate = [int]$env:OPENCLOD_TTS_RATE',
  '$s.Volume = [int]$env:OPENCLOD_TTS_VOLUME',
  '$s.Speak($text)',
  '$s.Dispose()'
].join('\r\n')

export function normalizeTtsOptions(input: Partial<TtsSpeakOptions> = {}): Required<TtsSpeakOptions> {
  const rate = input.rate === undefined ? 0 : Number(input.rate)
  const volume = input.volume === undefined ? 100 : Number(input.volume)
  const provider = input.provider === 'windows' ? 'windows' : 'edge'
  return {
    text: String(input.text ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT),
    provider,
    voice: String(input.voice ?? (provider === 'edge' ? EDGE_DEFAULT_VOICE : '')).replace(/[^\p{L}\p{N} ._()\-]/gu, '').slice(0, 200),
    rate: Math.max(-10, Math.min(10, Math.round(Number.isFinite(rate) ? rate : 0))),
    volume: Math.max(0, Math.min(100, Math.round(Number.isFinite(volume) ? volume : 100)))
  }
}

export function parseTtsVoices(raw: string): TtsVoiceInfo[] {
  try {
    const parsed = JSON.parse(raw.trim() || '[]') as TtsVoiceInfo | TtsVoiceInfo[]
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((voice) => voice && typeof voice.name === 'string' && voice.name)
      .map((voice): TtsVoiceInfo => ({
        provider: 'windows',
        id: voice.name.slice(0, 200),
        displayName: voice.displayName ?? voice.name.slice(0, 200),
        name: voice.name.slice(0, 200),
        culture: String(voice.culture ?? '').slice(0, 40),
        gender: String(voice.gender ?? '').slice(0, 30),
        age: String(voice.age ?? '').slice(0, 30)
      }))
  } catch {
    return []
  }
}

export function parseEdgeTtsVoices(raw: string): TtsVoiceInfo[] {
  try {
    const parsed = JSON.parse(raw.trim() || '[]') as Array<Record<string, unknown>>
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((voice) => {
      const id = typeof voice.id === 'string' ? voice.id : ''
      if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(id)) return []
      return [{
        provider: 'edge' as const,
        id,
        displayName: String(voice.name ?? id).slice(0, 200),
        name: id,
        culture: String(voice.culture ?? '').slice(0, 40),
        gender: String(voice.gender ?? '').slice(0, 30),
        age: 'Adult',
        categories: Array.isArray(voice.categories) ? voice.categories.filter((item): item is string => typeof item === 'string').slice(0, 20) : [],
        personalities: Array.isArray(voice.personalities) ? voice.personalities.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
      }]
    }).slice(0, 500)
  } catch {
    return []
  }
}

export interface TtsDependencies {
  emit(state: TtsState): void
  log(scope: string, message: unknown): void
}

export class TtsService {
  private child: ChildProcess | null = null
  private temporaryAudio: string | null = null
  /** Bumped by every speak() and stop(): a call whose number is no longer current has been replaced or stopped. */
  private epoch = 0
  private edgeVoicesCache: { at: number; voices: TtsVoiceInfo[] } | null = null
  private state: TtsState = { phase: 'idle' }

  constructor(private readonly deps: TtsDependencies) {}

  get available(): boolean {
    return process.platform === 'win32' || this.edgeAvailable()
  }

  status(): TtsState & { available: boolean } {
    return { ...this.state, available: this.available }
  }

  async listVoices(provider?: 'windows' | 'edge'): Promise<TtsVoiceInfo[]> {
    const [windows, edge] = await Promise.all([
      provider === 'edge' ? Promise.resolve([]) : this.listWindowsVoices(),
      provider === 'windows' ? Promise.resolve([]) : this.listEdgeVoices()
    ])
    return [...windows, ...edge]
  }

  private listWindowsVoices(): Promise<TtsVoiceInfo[]> {
    if (process.platform !== 'win32') return Promise.resolve([])
    const executable = powershell()
    return new Promise((resolve) => {
      execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', VOICES_SCRIPT], {
        windowsHide: true,
        timeout: 20_000,
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error) this.deps.log('tts', `vozes indisponíveis: ${error.message} ${String(stderr).slice(0, 500)}`)
        resolve(parseTtsVoices(String(stdout ?? '')))
      })
    })
  }

  async speak(input: TtsSpeakOptions): Promise<TtsSpeakResult> {
    if (!this.available) throw new Error('nenhum mecanismo de voz está disponível')
    const options = normalizeTtsOptions(input)
    if (!options.text) throw new Error('texto vazio para leitura')
    this.stop()
    const epoch = this.epoch
    if (options.provider === 'edge') {
      try {
        const audio = await this.speakEdge(options)
        if (epoch !== this.epoch) return { provider: 'edge', cancelled: true }
        return { provider: 'edge', audioBase64: audio.toString('base64'), mediaType: 'audio/mpeg' }
      } catch (error) {
        // A newer request or the stop button killed the synthesis on purpose (taskkill ends the process with code 1).
        // That is not a failure, and the Windows voice must not start reading something nobody wants any more: it
        // used to, whenever the button was pressed again while the neural voice was still being made.
        if (epoch !== this.epoch) return { provider: 'edge', cancelled: true }
        this.deps.log('tts', `Edge Neural TTS falhou: ${(error as Error).message}`)
        if (process.platform !== 'win32') throw error
        await this.speakWindows({ ...options, provider: 'windows', voice: '' })
        return { provider: 'windows', fallbackReason: (error as Error).message }
      }
    }
    await this.speakWindows(options)
    return { provider: 'windows' }
  }

  private speakWindows(options: Required<TtsSpeakOptions>): Promise<void> {
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-Command', SPEAK_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        OPENCLOD_TTS_TEXT: Buffer.from(options.text, 'utf8').toString('base64'),
        OPENCLOD_TTS_VOICE: Buffer.from(options.voice, 'utf8').toString('base64'),
        OPENCLOD_TTS_RATE: String(options.rate),
        OPENCLOD_TTS_VOLUME: String(options.volume)
      }
    })
    this.child = child
    this.setState({ phase: 'speaking', text: options.text.slice(0, 160) })
    child.stderr?.on('data', (chunk: Buffer) => this.deps.log('tts', String(chunk).slice(-500)))
    child.on('error', (error) => {
      this.child = null
      this.setState({ phase: 'error', error: error.message })
      this.deps.log('tts', error)
    })
    child.on('close', (code) => {
      if (this.child !== child) return
      this.child = null
      this.setState(code === 0 ? { phase: 'idle' } : { phase: 'error', error: `processo de voz terminou com código ${code}` })
    })
    return Promise.resolve()
  }

  private async speakEdge(options: Required<TtsSpeakOptions>): Promise<Buffer> {
    const python = this.edgePython()
    const bridge = this.edgeBridge()
    if (!python || !bridge) throw new Error('runtime neural gratuito indisponível')
    const output = path.join(os.tmpdir(), `openclod-edge-${crypto.randomUUID()}.mp3`)
    this.temporaryAudio = output
    this.setState({ phase: 'synthesizing', text: options.text.slice(0, 160) })
    const edgeRate = Math.max(-50, Math.min(100, options.rate * 10))
    const child = spawn(python, ['-I', '-X', 'utf8', bridge, '--synthesize', output], {
      cwd: path.dirname(bridge),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...sanitizedEnv(),
        OPENCLOD_EDGE_TEXT: Buffer.from(options.text, 'utf8').toString('base64'),
        OPENCLOD_EDGE_VOICE: options.voice || EDGE_DEFAULT_VOICE,
        OPENCLOD_EDGE_RATE: String(edgeRate)
      }
    })
    this.child = child
    let stdout = ''
    let stderr = ''
    let cancelled = false
    child.stdout?.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-20_000) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cancelled = true
          child.kill()
          reject(new Error('síntese neural excedeu 45 s'))
        }, 45_000)
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (cancelled) return reject(new Error('síntese neural cancelada'))
          if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `motor neural terminou com código ${code}`))
          resolve()
        })
      })
      // Only the request that is still current owns `child` and the state: one that was replaced must not wipe the
      // newer request's process (stop() could no longer reach it) or tell the screen the voice is idle.
      const current = this.child === child
      if (current) this.child = null
      const audio = await fs.promises.readFile(output)
      if (audio.length > MAX_EDGE_AUDIO_BYTES) throw new Error('áudio neural maior que 24 MB; divida o texto em partes')
      if (!audio.length || audio.subarray(0, 3).toString('latin1') !== 'ID3' && !/^\xFF[\xE0-\xFF]/.test(audio.subarray(0, 2).toString('latin1'))) {
        throw new Error('serviço neural retornou áudio inválido')
      }
      if (current) this.setState({ phase: 'idle' })
      return audio
    } finally {
      if (this.child === child) this.child = null
      if (this.temporaryAudio === output) this.temporaryAudio = null
      await fs.promises.rm(output, { force: true }).catch(() => undefined)
    }
  }

  private async listEdgeVoices(): Promise<TtsVoiceInfo[]> {
    if (!this.edgeAvailable()) return []
    if (this.edgeVoicesCache && Date.now() - this.edgeVoicesCache.at < EDGE_VOICE_CACHE_MS) return this.edgeVoicesCache.voices
    const python = this.edgePython()
    const bridge = this.edgeBridge()
    if (!python || !bridge) return EDGE_FALLBACK_VOICES
    return new Promise((resolve) => {
      execFile(python, ['-I', '-X', 'utf8', bridge, '--list-voices'], {
        cwd: path.dirname(bridge),
        windowsHide: true,
        timeout: 25_000,
        encoding: 'utf8',
        env: sanitizedEnv()
      }, (error, stdout) => {
        if (error) this.deps.log('tts', `lista de vozes neurais indisponível: ${error.message}`)
        const voices = parseEdgeTtsVoices(String(stdout ?? ''))
        const result = voices.length ? voices : EDGE_FALLBACK_VOICES
        this.edgeVoicesCache = { at: Date.now(), voices: result }
        resolve(result)
      })
    })
  }

  private edgePython(): string | null {
    return resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
  }

  private edgeBridge(): string | null {
    return resourcePath('tts', 'edge_tts_bridge.py')
  }

  private edgeAvailable(): boolean {
    return Boolean(this.edgePython() && this.edgeBridge())
  }

  stop(): boolean {
    this.epoch++
    const child = this.child
    if (!child) return false
    this.child = null
    try {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else child.kill()
    } catch (error) {
      this.deps.log('tts', error)
    }
    if (this.temporaryAudio) {
      void fs.promises.rm(this.temporaryAudio, { force: true }).catch(() => undefined)
      this.temporaryAudio = null
    }
    this.setState({ phase: 'idle' })
    return true
  }

  dispose(): void {
    this.stop()
  }

  private setState(state: TtsState): void {
    this.state = state
    this.deps.emit(state)
  }
}

function powershell(): string {
  const windows = process.env.SystemRoot || 'C:\\Windows'
  return path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
