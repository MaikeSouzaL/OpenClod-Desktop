import type { BudgetInfo } from '../../../shared/types'
import { budgetKindLabel } from '../../../shared/budget'
import { formatTokens } from './format'

export interface BudgetView {
  title: string
  badge: string
  usage: string
  text: string
}

/** What the "turn stopped" card says: a token or cost budget that ran out, or the cap on iterations. */
export function describeBudget(info: BudgetInfo): BudgetView {
  if (info.kind === 'iterations') {
    return {
      title: 'Limite de iterações do turno atingido',
      badge: budgetKindLabel(info.kind),
      usage: `${info.used} de ${info.limit} iterações`,
      text: 'O agente gerou um resumo e parou no limite de iterações, com o plano salvo. Continue de onde parou: ele retoma do passo em aberto.'
    }
  }
  const cost = info.kind === 'cost'
  return {
    title: 'Orçamento do turno esgotado',
    badge: budgetKindLabel(info.kind),
    usage: cost ? `US$ ${info.used.toFixed(2)} de US$ ${info.limit.toFixed(2)}` : `${formatTokens(info.used)} de ${formatTokens(info.limit)} tokens`,
    text: 'O agente gerou um resumo e parou com o plano salvo. Continue de onde parou com um novo orçamento.'
  }
}
