import { describe, expect, it } from 'vitest'
import { addUsage, usageCost } from '../src/core/agent/usage'
import type { ProviderConfig } from '../src/shared/types'

const deepseek: ProviderConfig = {
  id: 'deepseek',
  kind: 'openai',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  contextWindow: 1_048_576,
  supportsVision: false,
  supportsTools: true,
  inputCostPerMTok: 0.3,
  outputCostPerMTok: 1.2,
  cachedInputCostPerMTok: 0.006
}

describe('usage accounting', () => {
  it('accumulates tokens and prices cache hits at their own rate', () => {
    const first = addUsage(
      { input: 0, output: 0 },
      { input: 1_000_000, cachedInput: 500_000, output: 1_000_000 },
      deepseek
    )
    expect(first).toMatchObject({ input: 1_000_000, output: 1_000_000, cachedInput: 500_000 })
    // 500k fresh * $0.30/M + 500k cache * $0.006/M + 1M output * $1.20/M
    expect(first.costUsd).toBeCloseTo(0.15 + 0.003 + 1.2, 6)

    const second = addUsage(first, { input: 100_000, output: 10_000 }, deepseek)
    expect(second.input).toBe(1_100_000)
    expect(second.output).toBe(1_010_000)
    expect(second.costUsd).toBeCloseTo(first.costUsd! + 0.03 + 0.012, 6)
  })

  it('computes the cost of a single response', () => {
    expect(
      usageCost({ input: 1_000_000, cachedInput: 500_000, output: 1_000_000 }, deepseek)
    ).toBeCloseTo(0.15 + 0.003 + 1.2, 6)
  })

  it('leaves cost unset when the provider has no rates', () => {    const usage = addUsage(
      { input: 0, output: 0 },
      { input: 10_000, output: 1_000 },
      { ...deepseek, inputCostPerMTok: undefined, outputCostPerMTok: undefined }
    )
    expect(usage.costUsd).toBeUndefined()
    expect(usage.input).toBe(10_000)
  })

  it('never charges more cached tokens than the input', () => {
    const usage = addUsage(
      { input: 0, output: 0 },
      { input: 1_000, cachedInput: 5_000, output: 0 },
      deepseek
    )
    expect(usage.cachedInput).toBe(5_000)
    expect(usage.costUsd).toBeCloseTo((1_000 / 1_000_000) * 0.006, 9)
  })
})
