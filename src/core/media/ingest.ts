import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { sanitizedEnv } from '../security/policy.js'
import { resourcePath } from '../util/resources.js'

/**
 * Media ingestion: an audio file becomes a transcript, a video becomes a transcript plus the frames that matter
 * (scene changes, no repeats) and contact sheets of them. The work is done by `resources/media/forja_media.py` on the
 * embedded Python runtime (PyAV, numpy, faster-whisper): no ffmpeg binary, no network, nothing leaves the machine.
 * Frame logic ported from claude-real-video (MIT, (c) 2026 LeoAido); see THIRD_PARTY_NOTICES.md.
 */

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.amr'])
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp'])

export function mediaKindOf(file: string): 'audio' | 'video' | null {
  const extension = path.extname(file).toLowerCase()
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return null
}

export interface MediaFrame {
  /** Relative to the media folder, e.g. `frames/frame_012.jpg`. */
  file: string
  t: number
  ts: string
  via: string
  selected_by?: string
  sheet?: string
  cell?: number
  number?: number
}

export interface MediaSheet {
  file: string
  frames: string[]
  first: number
  t0: number
  t1: number
  cols: number
  rows: number
}

export interface MediaSegment {
  start: number
  end: number
  text: string
}

export interface MediaTranscript {
  language: string | null
  language_probability: number
  duration?: number
  model: string | null
  device: string | null
  compute_type?: string
  note: string
  segments: MediaSegment[]
  dropped_segments?: number
  elapsed?: number
}

export interface MediaManifest {
  version: 1
  kind: 'audio' | 'video'
  source: { path: string; name: string; size: number; mtime: number }
  info: {
    format?: string
    duration: number
    has_video: boolean
    has_audio: boolean
    width?: number
    height?: number
    fps?: number
    video_codec?: string
    audio_codec?: string
    processed_duration?: number
  }
  options_signature: string
  frames: MediaFrame[]
  sheets: MediaSheet[]
  transcript: MediaTranscript
  stats: { decoded: number; candidates: number; kept: number; frames_seconds?: number; transcribe_seconds?: number | null }
  warnings: string[]
  /** Things worth knowing that do not make the run incomplete (a few damaged stretches in the video). */
  notes?: string[]
  complete: boolean
  created: string
}

export interface MediaProgress {
  step: string
  pct: number
  message: string
}

export interface IngestOptions {
  /** Folder that receives frames/, sheets/, transcript.json and manifest.json. */
  outDir: string
  /** `auto` = small on a GPU, base on the CPU. */
  model?: 'auto' | 'tiny' | 'base' | 'small'
  /** ISO 639-1 code or `auto` (default). */
  language?: string
  maxFrames?: number
  /** Process only the first N seconds (0 = all). */
  maxSeconds?: number
  noTranscribe?: boolean
  noFrames?: boolean
  /** Ignore a previous run of the same file and options. */
  overwrite?: boolean
  signal?: AbortSignal
  onProgress?: (progress: MediaProgress) => void
  timeoutMs?: number
}

export interface IngestResult {
  manifest: MediaManifest
  manifestPath: string
  /** True when the folder already held a complete run of the same file and options. */
  cached: boolean
}

const MAX_BYTES = 8 * 1024 * 1024 * 1024

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function ingestMedia(file: string, options: IngestOptions): Promise<IngestResult> {
  const source = path.resolve(file)
  const kind = mediaKindOf(source)
  if (!kind) throw new Error('formato de áudio/vídeo não suportado')
  const stat = await fs.promises.stat(source)
  if (!stat.isFile()) throw new Error('a mídia não é um arquivo')
  if (stat.size > MAX_BYTES) throw new Error('mídia maior que 8 GB')
  const python = resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
  const script = resourcePath('media', 'forja_media.py')
  const models = resourcePath('models', 'whisper')
  if (!python || !script) throw new Error('runtime de mídia embutido indisponível')
  const outDir = path.resolve(options.outDir)
  await fs.promises.mkdir(outDir, { recursive: true })

  const args = ['-I', '-X', 'utf8', script, 'ingest', source, '--out', outDir]
  const model = options.model ?? 'auto'
  if (!/^(auto|tiny|base|small)$/.test(model)) throw new Error(`modelo Whisper inválido: ${model}`)
  args.push('--model', model)
  const language = options.language ?? 'auto'
  if (!/^([a-z]{2,3}|auto)$/.test(language)) throw new Error(`idioma inválido: ${language}`)
  args.push('--language', language)
  if (options.maxFrames && options.maxFrames > 0) args.push('--max-frames', String(Math.min(1_000, Math.floor(options.maxFrames))))
  if (options.maxSeconds && options.maxSeconds > 0) args.push('--max-seconds', String(Math.floor(options.maxSeconds)))
  if (options.noTranscribe) args.push('--no-transcribe')
  if (options.noFrames) args.push('--no-frames')
  if (options.overwrite) args.push('--overwrite')

  const timeoutMs = Math.max(60_000, Math.min(3 * 60 * 60_000, options.timeoutMs ?? 45 * 60_000))
  return new Promise<IngestResult>((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: path.dirname(script),
      env: {
        ...sanitizedEnv(),
        ...(models ? { FORJA_STT_MODELS: models } : {}),
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000)
    })
    let result: { manifest: string; cached: boolean } | null = null
    let failure = ''
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      const message = parseLine(line)
      if (!message) return
      if (message.type === 'progress') {
        options.onProgress?.({ step: String(message.step ?? ''), pct: Number(message.pct) || 0, message: String(message.message ?? '') })
      } else if (message.type === 'result' && typeof message.manifest === 'string') {
        const summary = message.summary as { cached?: boolean } | undefined
        result = { manifest: message.manifest, cached: Boolean(summary?.cached) }
      } else if (message.type === 'error') {
        failure = String(message.message ?? 'erro desconhecido')
      }
    })
    const timer = setTimeout(() => {
      failure = `tempo esgotado (${Math.round(timeoutMs / 60_000)} min); o que já foi processado fica na pasta e uma nova chamada continua dali`
      child.kill()
    }, timeoutMs)
    const onAbort = (): void => {
      failure = 'processamento cancelado'
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const finish = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      finish()
      reject(new Error(`não consegui iniciar o motor de mídia: ${error.message}`))
    })
    child.on('close', (code) => {
      finish()
      if (!result) {
        reject(new Error(`${failure || `o motor de mídia terminou (código ${code}) sem resultado`}${stderrTail ? ` · ${stderrTail.trim().slice(-600)}` : ''}`))
        return
      }
      try {
        const manifestPath = path.resolve(result.manifest)
        if (path.relative(outDir, manifestPath).startsWith('..')) throw new Error('manifesto fora da pasta de saída')
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as MediaManifest
        if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.frames) || !manifest.transcript) throw new Error('manifesto inválido')
        resolve({ manifest, manifestPath, cached: result.cached })
      } catch (error) {
        reject(new Error(`manifesto de mídia ilegível: ${(error as Error).message}`))
      }
    })
  })
}
