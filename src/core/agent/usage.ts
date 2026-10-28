import type { ProviderConfig, Usage } from '../../shared/types.js'

/** Cost of one provider response, with cache hits priced at their own rate. */
export function usageCost(delta: Usage, config: ProviderConfig): number {
  const deltaInput = Math.max(0, delta.input ?? 0)
  const cached = Math.min(Math.max(0, delta.cachedInput ?? 0), deltaInput)
  const fresh = deltaInput - cached
  const inputRate = config.inputCostPerMTok ?? 0
  const cachedRate = config.cachedInputCostPerMTok ?? inputRate
  const outputRate = config.outputCostPerMTok ?? 0
  return (
    (fresh / 1_000_000) * inputRate +
    (cached / 1_000_000) * cachedRate +
    (Math.max(0, delta.output ?? 0) / 1_000_000) * outputRate
  )
}

/**
 * Accumulates usage and cost. Cached input is billed at its own rate (it is a
 * subset of `input`, not an extra): the delta is charged, never the cumulative
 * total, so retries cannot double-bill.
 */
export function addUsage(total: Usage, delta: Usage, config: ProviderConfig): Usage {
  const input = (total.input ?? 0) + (delta.input ?? 0)
  const output = (total.output ?? 0) + (delta.output ?? 0)
  const cachedInput = (total.cachedInput ?? 0) + (delta.cachedInput ?? 0)

  const costUsd = (total.costUsd ?? 0) + usageCost(delta, config)

  return {
    input,
    output,
    cachedInput: cachedInput || undefined,
    ...(costUsd > 0 ? { costUsd } : {})
  }
}
