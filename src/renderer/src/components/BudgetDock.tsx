import type { ReactElement } from 'react'
import type { BudgetInfo } from '../../../shared/types'
import { Icon } from './Icons'
import { formatTokens } from '../lib/format'
import { describeBudget } from '../lib/budget'

/**
 * Shown when a turn stops at its token/cost budget or at its iteration cap.
 * The final summary is already in the transcript and the plan is preserved;
 * this dock offers a fresh turn that continues from where it stopped.
 */
export function BudgetDock({
  info,
  onContinue,
  onClose
}: {
  info: BudgetInfo | null
  onContinue(): void
  onClose(): void
}): ReactElement | null {
  if (!info) return null
  const view = describeBudget(info)
  const contextPercent = info.contextWindow
    ? Math.min(100, Math.round((info.contextTokens / info.contextWindow) * 100))
    : 0
  return (
    <div className="approval-dock budget-dock">
      <div className="budget-card">
        <div className="budget-head">
          <span className="approval-icon">
            <Icon name="gauge" size={15} />
          </span>
          <div className="budget-heading">
            <strong>{view.title}</strong>
            <span>{view.usage}</span>
          </div>
          <span className="budget-badge">{view.badge}</span>
        </div>

        <p className="budget-text">{view.text}</p>

        <div className="budget-stats">
          <span>entrada {formatTokens(info.input)}</span>
          <span>saída {formatTokens(info.output)}</span>
          <span>cache {formatTokens(info.cachedInput)}</span>
          <span>{info.iterations} iterações</span>
          <span>{info.toolCalls} ferramentas</span>
          <span>contexto {contextPercent}%</span>
        </div>

        <div className="budget-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Fechar
          </button>
          <button type="button" className="btn primary" onClick={onContinue}>
            <Icon name="send" size={12} /> Continuar de onde parou
          </button>
        </div>
      </div>
    </div>
  )
}
