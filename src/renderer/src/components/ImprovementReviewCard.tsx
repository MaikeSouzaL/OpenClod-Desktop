import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Project } from '../../../shared/types'
import type { ImprovementStatusInfo } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { relativeTime } from '../lib/format'
import { Icon } from './Icons'

const PERIODS = [
  { days: 7, label: 'Últimos 7 dias' },
  { days: 14, label: 'Últimos 14 dias' },
  { days: 30, label: 'Últimos 30 dias' },
  { days: 90, label: 'Últimos 90 dias' }
]

const STATE_LABEL = { running: 'em andamento', done: 'concluída', error: 'falhou', cancelled: 'cancelada' } as const

interface Props {
  projects: Project[]
  activeProjectId: string | null
  /** Opens the report page in the Memory screen. */
  onOpenMemory(projectId: string, slug: string): void
}

/**
 * Manual trigger, status and weekly switch of the improvement review. The review
 * itself runs in the main process; this card only starts it and follows its state.
 */
export function ImprovementReviewCard({ projects, activeProjectId, onOpenMemory }: Props): ReactElement | null {
  const [projectId, setProjectId] = useState(activeProjectId && projects.some((item) => item.id === activeProjectId) ? activeProjectId : (projects[0]?.id ?? ''))
  const [status, setStatus] = useState<ImprovementStatusInfo | null>(null)
  const [useAi, setUseAi] = useState(true)
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  /** The value the user just picked for the weekly switch, shown until the main process confirms it. */
  const [weeklyPending, setWeeklyPending] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const projectRef = useRef(projectId)
  projectRef.current = projectId

  useEffect(() => {
    if (projects.some((item) => item.id === projectId)) return
    setProjectId(activeProjectId && projects.some((item) => item.id === activeProjectId) ? activeProjectId : (projects[0]?.id ?? ''))
  }, [projects, activeProjectId, projectId])

  const refresh = useCallback(async (): Promise<void> => {
    const id = projectRef.current
    if (!id) {
      setStatus(null)
      return
    }
    try {
      const next = await unwrap(window.forja.improvements.status(id))
      if (projectRef.current === id) setStatus(next)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const running = Boolean(status?.current)
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), running ? 1500 : 8000)
    return () => clearInterval(timer)
  }, [refresh, projectId, running])

  if (!projects.length) return null

  const project = projects.find((item) => item.id === projectId)
  const current = status?.current ?? null
  const mine = current && current.projectId === projectId
  const last = status?.last ?? null
  const ai = status?.aiProvider
  const aiOn = useAi && Boolean(ai)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await unwrap(window.forja.improvements.start(projectId, { useAi: aiOn, days }))
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    try {
      await unwrap(window.forja.improvements.cancel())
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const toggleWeekly = async (enabled: boolean): Promise<void> => {
    setError('')
    setWeeklyPending(enabled)
    try {
      await unwrap(window.forja.improvements.setWeekly(projectId, enabled, { useAi: aiOn }))
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setWeeklyPending(null)
    }
  }

  return (
    <section className="improve-card" aria-label="Revisão de melhorias">
      <header className="improve-head">
        <div>
          <h2><Icon name="sparkles" size={14} /> Revisão de melhorias</h2>
          <p>
            Lê limitações recorrentes, falhas por ferramenta, aprovações recusadas, uso por provedor e a memória do projeto, e gera um relatório com evidências.
            Só sugere: nada é aplicado sozinho.
          </p>
        </div>
        <label className="page-sort">Projeto
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setStatus(null) }} disabled={Boolean(current)}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      </header>

      <div className="improve-controls">
        <label className="check-row" title={ai ? undefined : 'Configure um provedor com credencial em Configurações → Provedores'}>
          <input type="checkbox" checked={aiOn} disabled={!ai || Boolean(current)} onChange={(event) => setUseAi(event.target.checked)} />{' '}
          Analisar com IA
        </label>
        <label className="page-sort">Período
          <select value={days} onChange={(event) => setDays(Number(event.target.value))} disabled={Boolean(current)}>
            {PERIODS.map((item) => <option key={item.days} value={item.days}>{item.label}</option>)}
          </select>
        </label>
        {current ? (
          <button type="button" className="btn small" onClick={() => void cancel()}><Icon name="stop" size={12} /> Cancelar</button>
        ) : (
          <button type="button" className="btn small primary" disabled={busy || !projectId} onClick={() => void run()}>
            <Icon name="search" size={12} /> Revisar melhorias
          </button>
        )}
      </div>
      <p className="improve-privacy">
        {ai
          ? aiOn
            ? `A análise por IA envia as evidências (já sem chaves e caminhos pessoais) para ${ai.label} · ${ai.model}.`
            : 'Sem IA: o relatório sai só das regras automáticas e nada deixa o computador.'
          : 'Nenhum provedor com credencial: o relatório sai só das regras automáticas e nada deixa o computador.'}
      </p>

      {current ? (
        <div className="improve-progress" role="status">
          <span className="spinner" aria-hidden="true" />
          {mine ? '' : `${current.projectName || 'Outro projeto'}: `}{current.step ?? 'Trabalhando'}…
        </div>
      ) : null}
      {error ? <div className="inline-error">{error}</div> : null}

      {last ? (
        <div className={`improve-last state-${last.state}`}>
          <div className="improve-last-head">
            <strong>Última revisão de {project?.name ?? last.projectName}</strong>
            <span className="badge">{STATE_LABEL[last.state]}</span>
            <span className="badge">{last.trigger === 'schedule' ? 'agendada' : 'manual'}</span>
            <span className={`badge ${last.usedAi ? 'on' : ''}`}>{last.usedAi ? `IA · ${last.model ?? ''}` : 'só regras'}</span>
            <small>{relativeTime(last.finishedAt ?? last.startedAt)} · {last.periodDays} dias</small>
          </div>
          {last.summary ? <p>{last.summary}</p> : null}
          {last.note ? <p className="muted">{last.note}</p> : null}
          {last.error ? <p className="inline-error">{last.error}</p> : null}
          {last.slug ? (
            <button type="button" className="btn tiny ghost" onClick={() => onOpenMemory(last.projectId, last.slug!)}>Abrir relatório na Memória</button>
          ) : null}
        </div>
      ) : (
        <p className="muted improve-empty">Nenhuma revisão feita ainda neste projeto.</p>
      )}

      <label className="check-row improve-weekly">
        <input type="checkbox" checked={weeklyPending ?? Boolean(status?.weekly.enabled)} disabled={!projectId || !status || weeklyPending !== null} onChange={(event) => void toggleWeekly(event.target.checked)} />{' '}
        Toda semana em Agendados (segunda, 09:00)
        {status?.weekly.enabled && status.weekly.nextRunAt
          ? ` · próxima ${new Date(status.weekly.nextRunAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
          : ''}
      </label>
    </section>
  )
}
