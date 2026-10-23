import type { ProviderErrorKind } from '../../shared/types.js'
import { sleep } from '../util/ids.js'

const CONTEXT_OVERFLOW =
  /context.{0,24}(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|context_length_exceeded|exceeds? the (model'?s )?(maximum|max)|max_tokens.{0,40}(exceed|too large)|request too large|string too long/i
const QUOTA = /insufficient_quota|exceeded your current quota|quota|billing|credit balance|payment required|out of credits/i
const RATE_LIMIT = /rate.?limit|too many requests|requests per minute|tpm|rpm/i
const OVERLOADED = /overloaded|capacity|temporarily unavailable/i
const AUTH = /invalid.{0,12}(api.?key|token|x-api-key)|unauthori[sz]ed|authentication|permission denied|incorrect api key/i

/** Maps a provider failure to a kind the agent loop can act on. */
export function classifyProviderError(status: number | undefined, message: string): ProviderErrorKind {
  if (status === 402 || QUOTA.test(message)) return 'quota'
  if (status === 401 || status === 403 || AUTH.test(message)) return 'auth'
  if (CONTEXT_OVERFLOW.test(message) || status === 413) return 'context_overflow'
  if (status === 429 || RATE_LIMIT.test(message)) return 'rate_limit'
  if (status === 529 || status === 503 || OVERLOADED.test(message)) return 'overloaded'
  if (status === 408 || /timed? ?out|timeout|ociosa/i.test(message)) return 'timeout'
  if (status !== undefined && status >= 500) return 'server'
  if (status !== undefined && status >= 400) return 'bad_request'
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|terminated/i.test(message)) return 'network'
  return 'unknown'
}

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'overloaded' || kind === 'server' || kind === 'timeout' || kind === 'network'
}

/** Kind of any error thrown while talking to a provider. */
export function errorKindOf(err: unknown): ProviderErrorKind {
  if (err instanceof ProviderHttpError) return err.kind
  return classifyProviderError(undefined, err instanceof Error ? err.message : String(err))
}

/** Parses Retry-After (seconds or HTTP date) and the OpenAI/Anthropic ms variants. */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined
  const ms = Number(headers.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms > 0) return ms
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export class ProviderHttpError extends Error {
  readonly kind: ProviderErrorKind

  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
    readonly retryAfter?: number,
    private readonly shouldRetryHeader?: boolean
  ) {
    super(message ?? `HTTP ${status}: ${body.slice(0, 500)}`)
    this.name = 'ProviderHttpError'
    this.kind = classifyProviderError(status, body)
  }

  get retryable(): boolean {
    if (this.shouldRetryHeader !== undefined) return this.shouldRetryHeader
    return this.status === 409 || isRetryableKind(this.kind)
  }
}

export interface SseFrame {
  event?: string
  data: string
}

/**
 * Parses a text/event-stream body into frames. Handles CRLF, multi-line data
 * and comment lines. Yields raw `data:` payloads (already joined).
 */
export async function* readSse(body: ReadableStream<Uint8Array>, idleTimeoutMs = 0): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const read = (): ReturnType<typeof reader.read> => {
    if (!idleTimeoutMs) return reader.read()
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject before cancelling: cancel() settles the pending read with
          // done=true, which would otherwise win the race and look like a
          // normal end of stream.
          reject(new Error(`stream ociosa por ${Math.round(idleTimeoutMs / 1000)}s (timeout)`))
          void reader.cancel().catch(() => undefined)
        }, idleTimeoutMs)
      })
    ]).finally(() => clearTimeout(timer))
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let dataLines: string[] = []

  const flush = (): SseFrame | undefined => {
    if (dataLines.length === 0) {
      event = undefined
      return undefined
    }
    const frame = { event, data: dataLines.join('\n') }
    event = undefined
    dataLines = []
    return frame
  }

  try {
    for (;;) {
      const { done, value } = await read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          const frame = flush()
          if (frame) yield frame
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        // other fields (id:, retry:) are not needed here
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const frame = flush()
      if (frame) yield frame
    }
    const last = flush()
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

export interface PostOptions {
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
  maxAttempts?: number
  /** Time allowed until response headers arrive. Defaults to 5 minutes. */
  headerTimeoutMs?: number
  /** Base delay of the exponential backoff (tests shrink it). */
  baseDelayMs?: number
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
}

/** Longest wait honoured from a Retry-After header. */
const MAX_RETRY_AFTER_MS = 120_000

function backoff(attempt: number, base: number): number {
  const exp = Math.min(30_000, base * 2 ** (attempt - 1))
  return Math.round(exp * (0.85 + Math.random() * 0.3))
}

/**
 * POST that streams. Retries only while nothing has been consumed yet, so a
 * partially delivered stream is never replayed (the caller surfaces the error
 * instead of duplicating content). Rate limits honour Retry-After.
 */
export async function postStream(opts: PostOptions): Promise<Response> {
  const attempts = opts.maxAttempts ?? 5
  const base = opts.baseDelayMs ?? 1000
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted')
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const headerTimer = setTimeout(() => controller.abort(), opts.headerTimeoutMs ?? 300_000)
    let response: Response
    try {
      response = await fetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(headerTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) throw err instanceof Error ? err : new Error(String(err))
      lastError = controller.signal.aborted
        ? new Error(`sem resposta do provedor em ${Math.round((opts.headerTimeoutMs ?? 300_000) / 1000)}s (timeout)`)
        : err instanceof Error
          ? err
          : new Error(String(err))
      if (attempt === attempts) throw lastError
      const delay = backoff(attempt, base)
      opts.onRetry?.(attempt, lastError, delay)
      await sleep(delay, opts.signal)
      continue
    }
    clearTimeout(headerTimer)
    // The body stream keeps reading after this point; the caller's signal
    // must still be able to cancel it.
    if (response.ok) return response
    opts.signal?.removeEventListener('abort', onAbort)

    const text = await response.text().catch(() => '')
    const shouldRetry = response.headers.get('x-should-retry')
    const httpError = new ProviderHttpError(
      response.status,
      text,
      undefined,
      retryAfterMs(response.headers),
      shouldRetry === 'true' ? true : shouldRetry === 'false' ? false : undefined
    )
    if (!httpError.retryable || attempt === attempts) throw httpError
    const delay = httpError.retryAfter !== undefined ? Math.min(MAX_RETRY_AFTER_MS, httpError.retryAfter) : backoff(attempt, base)
    opts.onRetry?.(attempt, httpError, delay)
    await sleep(delay, opts.signal)
    lastError = httpError
  }

  throw lastError ?? new Error('request failed')
}
