import type { ReasoningEffort } from './types.js'

/**
 * Reasoning ("effort") request shaping for the providers.
 *
 * Anthropic rules encoded here (from the current Messages API docs):
 *  - Claude Fable/Mythos 5.x, Opus 4.7+, Sonnet 5.x, Haiku 5.x take
 *    `thinking: {type: "adaptive"}` only; `budget_tokens` is rejected (400).
 *    Depth is controlled by `output_config.effort` (low..max, xhigh since 4.7).
 *  - Opus 4.6 / Sonnet 4.6 take adaptive thinking; effort is low/medium/high/max.
 *  - Opus 4.5 takes `thinking: {type: "enabled", budget_tokens}` and effort
 *    low/medium/high. Older Claude 4 / Haiku 4.5 take only the budget form.
 *  - Sampling parameters are rejected on Opus 4.7+, Fable/Mythos, Sonnet 5.x and
 *    Haiku 5.x, and whenever thinking is on.
 */

export const ALL_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type AnthropicThinkingKind = 'adaptive' | 'budget' | 'none'

export interface AnthropicFamily {
  thinking: AnthropicThinkingKind
  /** Efforts the model accepts in `output_config.effort` (empty: not supported). */
  efforts: readonly ReasoningEffort[]
  /** Thinking is part of the model's default behaviour (Fable, Opus 5.x, Sonnet 5.x, Haiku 5.x). */
  thinkingByDefault: boolean
  /** The model accepts `temperature` / `top_p` / `top_k` when thinking is off. */
  sampling: boolean
}

const NO_FAMILY: AnthropicFamily = { thinking: 'none', efforts: [], thinkingByDefault: false, sampling: true }
const ALL5: readonly ReasoningEffort[] = ALL_EFFORTS
const FOUR: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max']
const THREE: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/** `anthropic/claude-opus-4.5`, `anthropic.claude-sonnet-4-5-v1:0`, `claude-opus-4-5@20251101` -> `claude-opus-4-5`. */
export function normalizeClaudeId(model: string): string {
  return model
    .toLowerCase()
    .split('/')
    .pop()!
    .replace(/^anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .replace(/-\d{8}$/, '')
}

export function anthropicFamily(model: string): AnthropicFamily {
  const id = normalizeClaudeId(model)
  if (/^claude-3-7-sonnet/.test(id)) return { thinking: 'budget', efforts: [], thinkingByDefault: false, sampling: true }
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id)
  if (!match) return NO_FAMILY
  const [, name, majorText, minorText] = match
  const major = Number(majorText)
  const minor = minorText === undefined ? 0 : Number(minorText)

  if (name === 'fable' || name === 'mythos') {
    return { thinking: 'adaptive', efforts: ALL5, thinkingByDefault: true, sampling: false }
  }
  if (name === 'opus') {
    if (major >= 5) return { thinking: 'adaptive', efforts: ALL5, thinkingByDefault: true, sampling: false }
    if (major === 4 && minor >= 7) return { thinking: 'adaptive', efforts: ALL5, thinkingByDefault: false, sampling: false }
    if (major === 4 && minor === 6) return { thinking: 'adaptive', efforts: FOUR, thinkingByDefault: false, sampling: true }
    if (major === 4 && minor === 5) return { thinking: 'budget', efforts: THREE, thinkingByDefault: false, sampling: true }
    if (major >= 4) return { thinking: 'budget', efforts: [], thinkingByDefault: false, sampling: true }
    return NO_FAMILY
  }
  if (name === 'sonnet') {
    if (major >= 5) return { thinking: 'adaptive', efforts: ALL5, thinkingByDefault: true, sampling: false }
    if (major === 4 && minor >= 6) return { thinking: 'adaptive', efforts: FOUR, thinkingByDefault: false, sampling: true }
    if (major >= 4) return { thinking: 'budget', efforts: [], thinkingByDefault: false, sampling: true }
    return NO_FAMILY
  }
  // haiku
  if (major >= 5) return { thinking: 'adaptive', efforts: ALL5, thinkingByDefault: true, sampling: false }
  if (major === 4) return { thinking: 'budget', efforts: [], thinkingByDefault: false, sampling: true }
  return NO_FAMILY
}

/** The highest supported effort that is not above the requested one (or the lowest supported). */
export function clampEffort(effort: ReasoningEffort, supported: readonly ReasoningEffort[]): ReasoningEffort | undefined {
  if (!supported.length) return undefined
  if (supported.includes(effort)) return effort
  const want = ALL_EFFORTS.indexOf(effort)
  let best: ReasoningEffort | undefined
  for (const level of supported) {
    if (ALL_EFFORTS.indexOf(level) <= want) best = level
  }
  return best ?? supported[0]
}

const BUDGETS: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 16384,
  max: 24576
}
const BUDGET_HEADROOM = 6144
/** Output cap when thinking is on and nothing narrower was configured. */
const ADAPTIVE_MAX_TOKENS = 32_000

export interface AnthropicReasoning {
  thinking?: Record<string, unknown>
  outputConfig?: Record<string, unknown>
  maxTokens: number
  /** `temperature` may be sent for this request. */
  allowSampling: boolean
  /** Whether thinking blocks of earlier turns are meaningful for this model. */
  family: AnthropicFamily
}

/**
 * @param explicitMaxTokens request or config cap; when unset and thinking is on,
 *   a larger default is used because thinking tokens count toward `max_tokens`.
 */
export function anthropicReasoning(model: string, effort: ReasoningEffort | undefined, explicitMaxTokens: number | undefined): AnthropicReasoning {
  const family = anthropicFamily(model)
  const baseline = explicitMaxTokens ?? 8192
  const wantsThinking = family.thinking !== 'none' && (effort !== undefined || family.thinkingByDefault)

  if (!wantsThinking || family.thinking === 'none') {
    return { maxTokens: baseline, allowSampling: family.sampling, family }
  }

  if (family.thinking === 'adaptive') {
    const level = effort ? clampEffort(effort, family.efforts) : undefined
    return {
      // `display: "summarized"` lets the UI show the reasoning; omitted is the default on newer models.
      thinking: { type: 'adaptive', display: 'summarized' },
      outputConfig: level ? { effort: level } : undefined,
      maxTokens: explicitMaxTokens ?? ADAPTIVE_MAX_TOKENS,
      allowSampling: false,
      family
    }
  }

  // Budget form: only when the user picked an effort (older models do not think by default).
  if (!effort) return { maxTokens: baseline, allowSampling: family.sampling, family }
  const level = clampEffort(effort, family.efforts)
  // An explicit cap is respected: the budget shrinks to fit (it must stay below max_tokens, min 1024).
  const maxTokens = explicitMaxTokens ?? BUDGETS[effort] + BUDGET_HEADROOM
  const budget = Math.min(BUDGETS[effort], maxTokens - 1024)
  if (budget < 1024) return { maxTokens, allowSampling: family.sampling, family }
  return {
    thinking: { type: 'enabled', budget_tokens: budget },
    outputConfig: level ? { effort: level } : undefined,
    maxTokens,
    allowSampling: false,
    family
  }
}

/** DeepSeek V4 exposes low/high/max and rejects the OpenAI `medium` tier. */
export function isDeepSeekV4Model(model: string): boolean {
  const id = model.toLowerCase()
  return /(^|[/])deepseek-(v4|flash)/.test(id) || /deepseek-v4\.\d/.test(id)
}

/**
 * `reasoning_effort` for OpenAI reasoning models (o-series, gpt-5); other
 * values are clamped to `high`. DeepSeek V4 maps its own three-tier API.
 */
export function openaiReasoningEffort(
  effort: ReasoningEffort,
  model = ''
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (isDeepSeekV4Model(model)) {
    if (effort === 'low') return 'low'
    if (effort === 'max') return 'max'
    // DeepSeek maps medium/xhigh to high for compatibility.
    return 'high'
  }
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}

/** OpenAI reasoning families (o-series, gpt-5) accept `reasoning_effort`. */
export function isOpenAIReasoningId(model: string): boolean {
  return /^(o\d+|gpt-5)/.test(model.toLowerCase().split('/').pop() ?? '')
}

/**
 * Efforts worth offering for a provider/model pair; empty when the harness
 * cannot translate an effort into that API (the picker then says so).
 */
export function effortLevelsFor(
  kind: 'openai' | 'anthropic',
  model: string,
  forced = false,
  explicit?: readonly ReasoningEffort[]
): readonly ReasoningEffort[] {
  if (explicit?.length) return explicit
  if (kind === 'anthropic') {
    const family = anthropicFamily(model)
    if (family.thinking === 'none') return []
    return family.efforts.length ? family.efforts : ALL_EFFORTS
  }
  if (kind === 'openai' && isDeepSeekV4Model(model)) return ['low', 'high', 'max']
  if (kind === 'openai' && (forced || isOpenAIReasoningId(model))) return ['low', 'medium', 'high']
  return []
}
