/**
 * Size limits for what an MCP tool may hand to the model. Claude Code warns
 * above 10 000 tokens and stops at 25 000 (`MAX_MCP_OUTPUT_TOKENS`); the same
 * numbers apply here. The text is cut in the middle, because the beginning
 * (what was asked for) and the end (totals, errors, pagination hints) are the
 * parts that matter.
 */

export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000
export const WARN_OUTPUT_TOKENS = 10_000
/** Rough ratio the harness uses for token accounting. */
export const CHARS_PER_TOKEN = 4
/** Hard ceiling for a size the server asks for in `_meta["anthropic/maxResultSizeChars"]`. */
export const MAX_RESULT_CHARS_CEILING = 500_000
/** An error text longer than this keeps its first and last 5 000 characters (Claude Code does the same). */
const ERROR_TEXT_LIMIT = 11_000
const ERROR_TEXT_EDGE = 5_000

export interface OutputLimitInput {
  /** Server setting `maxOutputTokens`. */
  maxOutputTokens?: number
  /** `_meta["anthropic/maxResultSizeChars"]` of the tool, when the server declared one. */
  toolMaxChars?: number
  env?: Record<string, string | undefined>
}

function positive(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
}

/** Largest text, in characters, a tool result may carry: server setting > tool meta > environment > default. */
export function maxOutputChars(input: OutputLimitInput = {}): number {
  const fromSetting = positive(input.maxOutputTokens)
  if (fromSetting) return Math.round(fromSetting * CHARS_PER_TOKEN)
  const fromMeta = positive(input.toolMaxChars)
  if (fromMeta) return Math.min(Math.round(fromMeta), MAX_RESULT_CHARS_CEILING)
  const fromEnv = positive((input.env ?? process.env).MAX_MCP_OUTPUT_TOKENS)
  if (fromEnv) return Math.round(fromEnv * CHARS_PER_TOKEN)
  return DEFAULT_MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN
}

export function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export interface LimitedText {
  text: string
  truncated: boolean
  originalChars: number
  omittedChars: number
}

/** Cuts `text` to `maxChars` keeping 70% head and 30% tail, with a marker that says what was removed and how to get it. */
export function limitMcpText(text: string, maxChars: number): LimitedText {
  const originalChars = text.length
  if (originalChars <= maxChars) return { text, truncated: false, originalChars, omittedChars: 0 }
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head)
  const omittedChars = originalChars - head - tail
  const marker =
    `\n\n[... ${omittedChars} caracteres omitidos: a saída tinha ~${approxTokens(originalChars)} tokens e o limite é ~${approxTokens(maxChars)}. ` +
    `Peça menos dados (filtros, paginação, campos específicos) ou aumente "maxOutputTokens" do conector ...]\n\n`
  return {
    text: `${text.slice(0, head)}${marker}${tail ? text.slice(originalChars - tail) : ''}`,
    truncated: true,
    originalChars,
    omittedChars
  }
}

/** Error results keep the edges only, like Claude Code (long stack traces or HTML pages are noise). */
export function limitMcpErrorText(text: string): string {
  if (text.length <= ERROR_TEXT_LIMIT) return text
  const omitted = text.length - ERROR_TEXT_EDGE * 2
  return `${text.slice(0, ERROR_TEXT_EDGE)}\n[... ${omitted} caracteres omitidos ...]\n${text.slice(text.length - ERROR_TEXT_EDGE)}`
}
