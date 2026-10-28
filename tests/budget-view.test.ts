import { describe, expect, it } from 'vitest'
import { budgetAmount, budgetKindLabel } from '../src/shared/budget'
import { describeBudget } from '../src/renderer/src/lib/budget'
import { ActivityStore } from '../src/main/activity-store'
import type { BudgetInfo } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

// The card that offers "Continuar de onde parou" when a turn stops: the token and cost budgets, and the iteration cap.

const info = (over: Partial<BudgetInfo>): BudgetInfo => ({
  kind: 'tokens',
  used: 6_250_000,
  limit: 6_000_000,
  input: 5_000_000,
  output: 200_000,
  cachedInput: 4_000_000,
  iterations: 41,
  toolCalls: 88,
  contextTokens: 100_000,
  contextWindow: 1_000_000,
  ...over
})

describe('budget stop wording', () => {
  it('names what ran out', () => {
    expect(budgetKindLabel('tokens')).toBe('tokens')
    expect(budgetKindLabel('cost')).toBe('custo')
    expect(budgetKindLabel('iterations')).toBe('iterações')
    expect(budgetKindLabel(undefined)).toBe('tokens')
  })

  it('formats one side of "used of limit"', () => {
    expect(budgetAmount('tokens', 6_250_000)).toBe('6250k tokens')
    expect(budgetAmount('cost', 10.456)).toBe('US$ 10.46')
    expect(budgetAmount('iterations', 60)).toBe('60 iterações')
  })

  it('the card for an iteration stop talks about iterations and offers to pick up the open step', () => {
    const view = describeBudget(info({ kind: 'iterations', used: 60, limit: 60, iterations: 60 }))
    expect(view.title).toBe('Limite de iterações do turno atingido')
    expect(view.badge).toBe('iterações')
    expect(view.usage).toBe('60 de 60 iterações')
    expect(view.text).toContain('limite de iterações')
    expect(view.text).toContain('Continue de onde parou')
  })

  it('the card for a token or cost stop is as it was', () => {
    const tokens = describeBudget(info({ kind: 'tokens' }))
    expect(tokens).toMatchObject({ title: 'Orçamento do turno esgotado', badge: 'tokens' })
    expect(tokens.text).toContain('novo orçamento')
    const cost = describeBudget(info({ kind: 'cost', used: 10.1, limit: 10 }))
    expect(cost).toMatchObject({ badge: 'custo', usage: 'US$ 10.10 de US$ 10.00' })
  })
})

describe('activity log for a budget stop', () => {
  it('records an iteration stop with its own title and counts', async () => {
    const dir = await makeTempDir('openclod-activity-budget-')
    try {
      const store = new ActivityStore(dir)
      await store.init()
      store.record({ type: 'budget', sessionId: 'ses_1', info: info({ kind: 'iterations', used: 60, limit: 60, iterations: 60 }) })
      const item = store.list().find((entry) => entry.type === 'budget')!
      expect(item.title).toBe('Orçamento do turno esgotado (iterações)')
      expect(item.detail).toContain('60 iterações de 60 iterações')
      expect(item.metadata).toMatchObject({ kind: 'iterations' })
    } finally {
      await removeTempDir(dir)
    }
  })
})
