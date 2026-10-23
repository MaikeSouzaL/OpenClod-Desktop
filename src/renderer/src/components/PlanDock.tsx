import { useState, type ReactElement } from 'react'
import type { PlanItem } from '../../../shared/types'
import { Icon } from './Icons'

/**
 * The checklist the agent keeps with `update_plan`, pinned above the composer
 * while it works (as in Claude Desktop). It only shows what the agent wrote.
 */
export function PlanDock({ plan, running }: { plan: PlanItem[]; running: boolean }): ReactElement | null {
  const [open, setOpen] = useState(true)
  if (!plan.length) return null
  const done = plan.filter((item) => item.status === 'done').length
  // Finished plans get out of the way once the agent stops.
  if (done === plan.length && !running) return null
  const active = plan.find((item) => item.status === 'active')

  return (
    <div className="plan-dock" role="region" aria-label="Plano do agente">
      <button type="button" className="plan-dock-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="plan-dock-count">
          {done}/{plan.length}
        </span>
        <span className="plan-dock-title">{open ? 'Plano' : (active?.text ?? 'Plano')}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {open ? (
        <ol className="plan-dock-list">
          {plan.map((item) => (
            <li key={item.id} className={`plan-dock-item status-${item.status}`}>
              <span className="plan-dock-mark" aria-hidden="true">
                {item.status === 'done' ? (
                  <Icon name="checkCircle" size={14} />
                ) : item.status === 'active' ? (
                  <span className="spinner tiny" />
                ) : item.status === 'blocked' ? (
                  <Icon name="alert" size={14} />
                ) : (
                  <span className="plan-dock-ring" />
                )}
              </span>
              <span className="plan-dock-text">{item.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
