import { describe, expect, it } from 'vitest'
import { billableTokens, effectiveMaxTokens } from '../src/shared/limits'

describe('effective turn budget', () => {
  it('respects a manual cap', () => {
    expect(effectiveMaxTokens({ maxTokens: 3_000_000 }, 1_048_576)).toBe(3_000_000)
  })

  it('scales automatic budgets with the context window and keeps a 6M floor', () => {
    expect(effectiveMaxTokens({ maxTokens: 0 }, 1_048_576)).toBe(10_485_760)
    expect(effectiveMaxTokens({ maxTokens: 0 }, 128_000)).toBe(6_000_000)
    expect(effectiveMaxTokens({ maxTokens: 0 }, 32_000)).toBe(6_000_000)
  })

  it('counts fresh input plus output and ignores cache hits', () => {
    expect(billableTokens({ input: 1_000_000, cachedInput: 800_000, output: 20_000 })).toBe(220_000)
    expect(billableTokens({ input: 500, output: 100 })).toBe(600)
    expect(billableTokens({ input: 100, cachedInput: 500, output: 10 })).toBe(10)
  })
})
