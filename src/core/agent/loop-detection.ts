/**
 * Detect runaway model output early. A model can enter a loop while producing
 * chain-of-thought or the visible answer: the same paragraph, line or phrase is
 * repeated until the output budget ends. The harness must stop the stream, keep
 * the conversation valid and explain what happened instead of waiting for the
 * provider's maximum token limit.
 */

export interface RepetitionHit {
  /** Block that repeated. */
  sample: string
  /** How many times the block repeated consecutively. */
  repeats: number
  /** Length of the repeating period in normalized characters. */
  period: number
  /** Where the pattern was found. */
  kind: 'line' | 'sentence' | 'tail'
}

/** Minimum number of consecutive repetitions before a turn is considered stuck. */
export const MIN_REPEATS = 4
/** Reasoning-only time without a visible token/tool call before the turn is stopped. */
export const MAX_REASONING_ONLY_MS = 180_000
/** Reasoning-only characters before the turn is stopped. */
export const MAX_REASONING_ONLY_CHARS = 80_000

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function shorten(value: string, max = 180): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function prefixFunction(text: string): number[] {
  const pi = new Array<number>(text.length).fill(0)
  for (let i = 1, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== text[k]) k = pi[k - 1]
    if (text[i] === text[k]) k++
    pi[i] = k
  }
  return pi
}

function isPeriodic(text: string, period: number): boolean {
  if (period < 16 || text.length < period * MIN_REPEATS) return false
  for (let i = period; i < text.length; i++) {
    if (text[i] !== text[i % period]) return false
  }
  return true
}

/**
 * Finds a repeated suffix. It tries several suffix lengths because the loop may
 * have started after a long, non-repeated introduction. The prefix function
 * gives the shortest period of each suffix in O(n).
 */
function repeatedSuffix(text: string): { sample: string; repeats: number; period: number } | null {
  const maxWindow = Math.min(8000, text.length)
  for (let window = 120; window <= maxWindow; window += 40) {
    const tail = text.slice(-window)
    const pi = prefixFunction(tail)
    const period = window - pi[window - 1]
    if (period < 16 || period === window) continue
    const repeats = Math.floor(window / period)
    if (repeats < MIN_REPEATS) continue
    // The last whole repeats must be exactly periodic; the prefix may contain
    // unrelated text before the loop started.
    const piece = tail.slice(-period * Math.min(repeats, 12))
    if (!isPeriodic(piece, period)) continue
    return {
      sample: shorten(piece.slice(-period), 220),
      repeats: Math.floor(piece.length / period),
      period
    }
  }
  return null
}

/**
 * Returns a repetition hit when the tail of `raw` is stuck in a loop.
 * The check is conservative: short text is ignored and a phrase must repeat at
 * least four times. Natural prose that merely reuses a word is not flagged.
 */
export function detectRepetition(raw: string): RepetitionHit | null {
  if (normalize(raw).length < 120) return null

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length >= MIN_REPEATS) {
    const last = lines[lines.length - 1]
    let repeats = 1
    for (let index = lines.length - 2; index >= 0 && lines[index] === last; index--) repeats++
    if (repeats >= MIN_REPEATS && last.length >= 12) {
      return { sample: shorten(last, 220), repeats, period: last.length, kind: 'line' }
    }
  }

  const sentences = raw
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  if (sentences.length >= MIN_REPEATS) {
    const last = sentences[sentences.length - 1]
    let repeats = 1
    for (let index = sentences.length - 2; index >= 0 && sentences[index] === last; index--) repeats++
    if (repeats >= MIN_REPEATS && last.length >= 24) {
      return { sample: shorten(last, 220), repeats, period: last.length, kind: 'sentence' }
    }
  }

  const tail = repeatedSuffix(normalize(raw))
  if (tail) return { ...tail, kind: 'tail' }
  return null
}
