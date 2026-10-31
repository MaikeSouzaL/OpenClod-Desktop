import { useEffect, useState, type ReactElement } from 'react'
import type { LoopBudgetSettings, LoopState } from '../../../shared/types'
import { describeLoop, LOOP_PHASES } from '../lib/loop-view'
import { Icon } from './Icons'
import './loop-dock.css'

/**
 * Loop Engineering progress, above the composer of a session in mode 'loop': the round and the time against the budget,
 * the phase of the cycle, each done-criterion with its proof, the judge's last verdict and why the loop stopped.
 * Before the first message it says what the mode does and the budget it will use.
 */
export function LoopDock({
  loop,
  running,
  budget
}: {
  loop?: LoopState
  running: boolean
  budget: LoopBudgetSettings
}): ReactElement {
  const [open, setOpen] = useState(true)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!running || loop?.status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, loop?.status])

  if (!loop) {
    return (
      <div className="loop-dock" role="region" aria-label="Loop Engineering">
        <div className="loop-dock-card is-idle">
          <div className="loop-dock-head is-static">
            <Icon name="refresh" size={14} />
            <strong>Código Loop Engineering</strong>
            <span className="loop-dock-sub">
              até {budget.rounds} voltas ou {budget.minutes} min
            </span>
          </div>
          <p className="loop-dock-intro">
            Descreva a tarefa. O maestro define como provar que terminou, divide o trabalho entre os especialistas e repete
            planejar → fazer → verificar → criticar → julgar até o juiz dar PRONTO com as provas.
          </p>
        </div>
      </div>
    )
  }

  const view = describeLoop(loop, now)
  const phaseIndex = LOOP_PHASES.findIndex((phase) => phase.id === view.phase)
  return (
    <div className="loop-dock" role="region" aria-label="Loop Engineering">
      <div className={`loop-dock-card tone-${view.tone}`}>
        <button type="button" className="loop-dock-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {view.tone === 'running' && running ? <span className="spinner tiny" /> : <Icon name="refresh" size={14} />}
          <strong>Loop Engineering</strong>
          <span className="loop-dock-sub">
            {view.round} · {view.time}
            {view.total ? ` · ${view.met}/${view.total} critérios` : ''}
          </span>
          <span className={`loop-dock-badge tone-${view.tone}`}>{view.status}</span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {open ? (
          <div className="loop-dock-body">
            <ol className="loop-dock-phases" aria-label="Fase da volta">
              {LOOP_PHASES.map((phase, index) => (
                <li
                  key={phase.id}
                  className={index === phaseIndex ? 'is-current' : index < phaseIndex ? 'is-past' : ''}
                  aria-current={index === phaseIndex ? 'step' : undefined}
                >
                  {phase.label}
                </li>
              ))}
            </ol>
            {view.criteria.length ? (
              <ul className="loop-dock-criteria" aria-label="Critérios de pronto">
                {view.criteria.map((criterion) => (
                  <li key={criterion.id} className={`mark-${criterion.mark}`}>
                    <span className="loop-dock-mark" aria-label={criterion.mark === 'met' ? 'cumprido' : criterion.mark === 'failed' ? 'falhou' : 'pendente'}>
                      {criterion.mark === 'met' ? <Icon name="checkCircle" size={13} /> : criterion.mark === 'failed' ? <Icon name="alert" size={13} /> : <span className="loop-dock-ring" />}
                    </span>
                    <span className="loop-dock-ctext">
                      {criterion.text}
                      {criterion.check ? <code>{criterion.check}</code> : <em>prova do juiz</em>}
                      {criterion.proof ? <span className="loop-dock-proof">{criterion.proof}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="loop-dock-note">Definindo os critérios de pronto…</p>
            )}
            {view.agents.length ? (
              <p className="loop-dock-agents">
                Nesta volta:{' '}
                {view.agents.map((agent) => (
                  <span key={agent} className="loop-dock-agent">
                    {agent}
                  </span>
                ))}
              </p>
            ) : null}
            {view.verdict ? <p className="loop-dock-verdict">{view.verdict}</p> : null}
            {view.reason ? <p className={`loop-dock-reason tone-${view.tone}`}>{view.reason}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
