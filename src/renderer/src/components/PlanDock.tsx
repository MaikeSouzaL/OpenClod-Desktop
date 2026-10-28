import { useEffect, useState, type ReactElement } from 'react'
import type { PlanItem } from '../../../shared/types'
import { formatDuration } from '../lib/activity'
import { Icon } from './Icons'

function durationOf(item: PlanItem, now: number): number {
  if (!item.startedAt) return 0
  const end = item.endedAt ?? (item.status === 'active' && !item.interrupted ? now : item.startedAt)
  return Math.max(0, end - item.startedAt)
}

/**
 * The checklist the agent keeps with `update_plan`. Clicking a step opens the
 * right panel with the saved activity for that step (and the live tools).
 */
export function PlanDock({
  plan,
  running,
  onOpenStep
}: {
  plan: PlanItem[]
  running: boolean
  onOpenStep?(itemId: string): void
}): ReactElement | null {
  const [open, setOpen] = useState(true)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

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
        <span className="plan-dock-hint">clique em um passo para abrir no painel</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {open ? (
        <ol className="plan-dock-list">
          {plan.map((item) => {
            const duration = durationOf(item, now)
            return (
              <li key={item.id} className="plan-dock-entry">
                <button
                  type="button"
                  className={`plan-dock-item status-${item.status} ${item.interrupted ? 'is-interrupted' : ''}`}
                  onClick={() => onOpenStep?.(item.id)}
                  title="Abrir os detalhes deste passo no painel lateral"
                >
                  <span className="plan-dock-mark" aria-hidden="true">
                    {item.interrupted ? (
                      <Icon name="alert" size={14} />
                    ) : item.status === 'done' ? (
                      <Icon name="checkCircle" size={14} />
                    ) : item.status === 'active' ? (
                      running ? <span className="spinner tiny" /> : <Icon name="clock" size={14} />
                    ) : item.status === 'blocked' ? (
                      <Icon name="alert" size={14} />
                    ) : (
                      <span className="plan-dock-ring" />
                    )}
                  </span>
                  <span className="plan-dock-text">{item.text}</span>
                  {duration > 0 ? <span className="plan-dock-duration">{formatDuration(duration)}</span> : null}
                  <Icon name="chevronRight" size={12} className="plan-dock-chevron" />
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
    </div>
  )
}
