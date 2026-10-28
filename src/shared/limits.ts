import type { HarnessLimits, Usage } from './types'

/**
 * Token budget for one turn. `maxTokens = 0` scales with the model window so a
 * 1M-context model is not killed by a cap designed for 128k models.
 */
export function effectiveMaxTokens(
  limits: Pick<HarnessLimits, 'maxTokens'>,
  contextWindow: number
): number {
  if (limits.maxTokens > 0) return limits.maxTokens
  return Math.max(6_000_000, Math.round(Math.max(0, contextWindow) * 10))
}

/**
 * Tokens that count against the turn budget: fresh input plus output. Cache
 * hits are reported separately (and billed cheaper); they must not exhaust a
 * budget designed to catch runaway loops.
 */
export function billableTokens(usage: Usage): number {
  const input = usage.input ?? 0
  const cached = Math.min(usage.cachedInput ?? 0, input)
  return Math.max(0, input - cached) + (usage.output ?? 0)
}
