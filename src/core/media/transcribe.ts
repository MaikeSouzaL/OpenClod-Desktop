import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizedEnv } from '../security/policy.js'
import { resourcePath } from '../util/resources.js'

export interface TranscriptionSegment {
  start: number
  end: number
  text: string
}

export interface TranscriptionResult {
  source: string
  text: string
  segments: TranscriptionSegment[]
  language: string
  languageProbability: number
  duration: number
  device: string
  computeType: string
}

export interface TranscribeOptions {
  model?: string
  language?: string
  signal?: AbortSignal
  timeoutMs?: number
}

const MEDIA_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.mp4', '.mov', '.mkv', '.avi'])

export async function transcribeMedia(file: string, options: TranscribeOptions = {}): Promise<TranscriptionResult> {
  const resolved = path.resolve(file)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('mídia não é um arquivo')
  if (stat.size > 2 * 1024 * 1024 * 1024) throw new Error('mídia maior que 2 GB')
  if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error('formato de áudio/vídeo não suportado')
  const python = resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
  const script = resourcePath('stt', 'forja_stt.py')
  const models = resourcePath('models', 'whisper')
  if (!python || !script || !models) throw new Error('runtime Whisper embutido indisponível')
  const model = typeof options.model === 'string' && /^[A-Za-z0-9._-]+$/.test(options.model) ? options.model : 'base'
  const language = typeof options.language === 'string' && /^([a-z]{2,3}|auto)$/.test(options.language) ? options.language : 'pt'
  if (!fs.existsSync(path.join(models, model, 'model.bin'))) throw new Error(`modelo Whisper não encontrado: ${model}`)

  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-I', '-X', 'utf8', script, '--transcribe-file', resolved, '--model', model, '--language', language],
      {
        cwd: path.dirname(script),
        env: {
          ...sanitizedEnv(),
          FORJA_STT_MODELS: models,
          FORJA_STT_MODEL: model,
          FORJA_STT_LANGUAGE: language,
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          TOKENIZERS_PARALLELISM: 'false'
        },
        windowsHide: true,
        timeout: Math.max(30_000, Math.min(30 * 60_000, options.timeoutMs ?? 10 * 60_000)),
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        signal: options.signal
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`transcrição falhou: ${error.message}${stderr ? ` · ${String(stderr).trim().slice(-800)}` : ''}`))
          return
        }
        const messages = String(stdout ?? '').split(/\r?\n/).flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
        })
        const result = messages.find((message) => message.type === 'transcription')
        if (!result) {
          reject(new Error(`motor Whisper não retornou transcrição${stderr ? `: ${String(stderr).trim().slice(-800)}` : ''}`))
          return
        }
        const segments = Array.isArray(result.segments)
          ? result.segments.flatMap((item) => {
              const segment = item as Record<string, unknown>
              const text = typeof segment.text === 'string' ? segment.text.trim() : ''
              return text ? [{ start: Number(segment.start) || 0, end: Number(segment.end) || 0, text }] : []
            })
          : []
        resolve({
          source: resolved,
          text: typeof result.text === 'string' ? result.text.trim() : segments.map((segment) => segment.text).join(' '),
          segments,
          language: typeof result.language === 'string' ? result.language : language,
          languageProbability: Number(result.language_probability) || 0,
          duration: Number(result.duration) || 0,
          device: typeof result.device === 'string' ? result.device : 'auto',
          computeType: typeof result.compute_type === 'string' ? result.compute_type : ''
        })
      }
    )
    child.stdin?.end()
  })
}
