import { randomUUID } from 'node:crypto'

export function id(prefix = ''): string {
  const v = randomUUID()
  return prefix ? `${prefix}_${v}` : v
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })
}

/** Approximate token count; deliberately conservative for budgeting. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // ~3.4 chars/token for code+prose, plus per-message overhead handled by caller.
  return Math.ceil(text.length / 3.4)
}

export function truncate(text: string, max: number, note = '…[truncated]'): string {
  if (text.length <= max) return text
  return text.slice(0, max) + note
}

/** Middle-out truncation keeps the head and tail of large tool outputs. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 40) / 2)
  return `${text.slice(0, half)}\n…[${text.length - max} chars omitted]…\n${text.slice(-half)}`
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return String(value)
  }
}
