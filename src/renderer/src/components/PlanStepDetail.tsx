import { useEffect, useState, type ReactElement } from 'react'
import type { PlanItem, PlanStepActivity } from '../../../shared/types'
import { formatDuration, type ActivityEntry } from '../lib/activity'
import { Icon } from './Icons'

const STATUS_LABEL: Record<PlanItem['status'], string> = {
  pending: 'pendente',
  active: 'em andamento',
  done: 'concluído',
  blocked: 'bloqueado'
}

interface Row {
  id: string
  kind: PlanStepActivity['kind']
  title: string
  detail?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  output?: string
  exitCode?: number
}

function rowsOf(item: PlanItem, live: ActivityEntry[]): Row[] {
  const history: Row[] = (item.activity ?? []).map((entry) => ({ ...entry, status: entry.status }))
  const seen = new Set(history.map((entry) => entry.id))
  const running: Row[] =
    item.status === 'active'
      ? live
          .filter((entry) => entry.status === 'running' && !seen.has(entry.id))
          .map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            detail: entry.detail,
            status: entry.status,
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            output: entry.output,
            exitCode: entry.exitCode
          }))
      : []
  return [...history, ...running].slice(-14)
}

function tail(text: string, lines: number): string {
  const rows = text.replace(/\r/g, '').split('\n').filter((line) => line.trim())
  return rows.slice(-lines).join('\n').slice(-900)
}

function elapsed(row: Row, now: number): string {
  const end = row.status === 'running' ? now : (row.endedAt ?? row.startedAt)
  return formatDuration(Math.max(0, end - row.startedAt))
}

/** The right-panel detail for one plan step: history + what is running now. */
export function PlanStepDetail({
  item,
  live = [],
  running
}: {
  item: PlanItem
  live?: ActivityEntry[]
  running: boolean
}): ReactElement {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!running || item.status !== 'active' || item.interrupted) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, item.status, item.interrupted])

  const total = item.startedAt
    ? Math.max(0, (item.endedAt ?? (item.status === 'active' && !item.interrupted ? now : item.startedAt)) - item.startedAt)
    : 0
  const rows = rowsOf(item, live)
  const saved = item.activity?.length ?? 0

  return (
    <section className="plan-step">
      <div className="plan-step-head">
        <div className="plan-step-heading">
          <span className="plan-step-kicker">Passo do plano</span>
          <h3>{item.text}</h3>
        </div>
        <span className={`plan-step-badge status-${item.status} ${item.interrupted ? 'is-interrupted' : ''}`}>
          {item.interrupted ? 'interrompido' : STATUS_LABEL[item.status]}
        </span>
      </div>

      <div className="plan-step-meta">
        {total > 0 ? <span>{formatDuration(total)}</span> : null}
        {saved ? <span>{saved} ação{saved > 1 ? 'ões' : ''} salva{saved > 1 ? 's' : ''}</span> : null}
        {item.status === 'active' && running && !item.interrupted ? <span className="plan-step-live">ao vivo</span> : null}
      </div>

      {item.interrupted ? (
        <p className="plan-step-note">
          O app foi fechado com este passo em andamento. O agente deve reabri-lo e continuar daqui antes de avançar.
        </p>
      ) : null}

      {rows.length ? (
        <div className="plan-step-actions">
          {rows.map((row) => (
            <div key={row.id} className={`plan-activity status-${row.status}`}>
              <span className="plan-activity-icon">
                <Icon name={row.kind === 'command' ? 'terminal' : row.kind === 'agent' ? 'bot' : 'hammer'} size={12} />
              </span>
              <div className="plan-activity-body">
                <div className="plan-activity-line">
                  <span className="plan-activity-title" title={row.detail || row.title}>
                    {row.title}
                  </span>
                  <span className="plan-activity-meta">
                    {elapsed(row, now)}
                    {row.status === 'failed' ? ' · falhou' : ''}
                    {row.status === 'running' ? ' · executando' : ''}
                  </span>
                </div>
                {row.output ? <pre className="plan-activity-output">{tail(row.output, 4)}</pre> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="plan-activity-empty">
          {item.status === 'pending'
            ? 'Ainda não iniciado.'
            : item.interrupted
              ? 'O agente ainda não retomou este passo.'
              : item.status === 'active'
                ? 'Nenhuma ferramenta registrada neste passo ainda.'
                : 'Sem atividade registrada para este passo (planos antigos não tinham este registro).'}
        </p>
      )}
    </section>
  )
}
