import { useEffect, useState, type ReactElement } from 'react'
import type { PlanItem } from '../../../shared/types'
import { formatDuration } from '../lib/activity'
import { Icon } from './Icons'
import './plan-dock-actions.css'

function durationOf(item: PlanItem, now: number): number {
  if (!item.startedAt) return 0
  const end = item.endedAt ?? (item.status === 'active' && !item.interrupted ? now : item.startedAt)
  return Math.max(0, end - item.startedAt)
}

/** The step that was running when the turn stopped (or one the agent left blocked): ▶ continues from it. */
function resumable(item: PlanItem): boolean {
  return item.status === 'active' || item.status === 'blocked' || Boolean(item.interrupted)
}

/** Two clicks discard: the first arms the button for a few seconds, like the bulk delete of the Memory screen. */
const CONFIRM_MS = 4_000

/**
 * The checklist the agent keeps with `update_plan`. Clicking a step opens the
 * right panel with the saved activity for that step (and the live tools).
 * Once the turn stopped, ▶ in front of the step that was running resumes from
 * it, and the trash discards the whole plan (turn, queue and memory capsule).
 */
export function PlanDock({
  plan,
  running,
  onOpenStep,
  onResumeStep,
  onDiscard
}: {
  plan: PlanItem[]
  running: boolean
  onOpenStep?(itemId: string): void
  onResumeStep?(itemId: string): Promise<void>
  onDiscard?(): Promise<void>
}): ReactElement | null {
  const [open, setOpen] = useState(true)
  const [now, setNow] = useState(Date.now())
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  // A turn that starts (or a new plan) disarms a pending discard.
  useEffect(() => {
    if (running) setConfirming(false)
  }, [running])

  if (!plan.length) return null
  const done = plan.filter((item) => item.status === 'done').length
  // Finished plans get out of the way once the agent stops.
  if (done === plan.length && !running) return null
  const active = plan.find((item) => item.status === 'active')
  const stopped = !running && !pending
  const canDiscard = Boolean(onDiscard) && !running

  const run = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    try {
      await action()
    } finally {
      setPending(false)
    }
  }

  const discard = (): void => {
    if (!onDiscard || pending) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    void run(onDiscard)
  }

  return (
    <div className="plan-dock" role="region" aria-label="Plano do agente">
      <div className={`plan-dock-headrow ${canDiscard ? 'has-discard' : ''} ${confirming ? 'is-confirming' : ''}`}>
        <button type="button" className="plan-dock-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="plan-dock-count">
            {done}/{plan.length}
          </span>
          <span className="plan-dock-title">{open ? 'Plano' : (active?.text ?? 'Plano')}</span>
          <span className="plan-dock-hint">clique em um passo para abrir no painel</span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {canDiscard ? (
          <button
            type="button"
            className={`plan-dock-discard ${confirming ? 'is-confirming' : ''}`}
            onClick={discard}
            disabled={pending}
            title={confirming ? 'Clique de novo para descartar o plano de vez' : 'Descartar o plano: não executa mais nada e apaga a continuação da memória'}
            aria-label={confirming ? 'Confirmar: descartar o plano de vez' : 'Descartar o plano'}
          >
            <Icon name="trash" size={13} />
            {confirming ? <span>Descartar de vez?</span> : null}
          </button>
        ) : null}
      </div>
      {open ? (
        <ol className="plan-dock-list">
          {plan.map((item) => {
            const duration = durationOf(item, now)
            const showResume = Boolean(onResumeStep) && !running && resumable(item)
            return (
              <li key={item.id} className={`plan-dock-entry ${showResume ? 'has-resume' : ''}`}>
                {showResume ? (
                  <button
                    type="button"
                    className="plan-dock-resume"
                    onClick={() => onResumeStep && void run(() => onResumeStep(item.id))}
                    disabled={!stopped}
                    title="Retomar a execução a partir deste passo"
                    aria-label={`Retomar a partir do passo: ${item.text}`}
                  >
                    <Icon name="play" size={12} />
                  </button>
                ) : null}
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
