import type { BudgetInfo } from './types.js'

/** What ran out at a budget stop, in pt-BR. */
export function budgetKindLabel(kind: BudgetInfo['kind'] | string | undefined): 'custo' | 'tokens' | 'iterações' {
  return kind === 'cost' ? 'custo' : kind === 'iterations' ? 'iterações' : 'tokens'
}

/** One side of "used de limit" for the activity log: "US$ 1.20", "840k tokens" or "60 iterações". */
export function budgetAmount(kind: BudgetInfo['kind'], value: number): string {
  if (kind === 'cost') return `US$ ${value.toFixed(2)}`
  if (kind === 'iterations') return `${Math.round(value)} iterações`
  return `${Math.round(value / 1000)}k tokens`
}
