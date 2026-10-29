import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ActivityItem, ActivitySeverity } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { relativeTime } from '../lib/format'
import type { Project } from '../../../shared/types'
import { Icon } from './Icons'
import { ImprovementReviewCard } from './ImprovementReviewCard'

const TYPE_LABELS: Record<string, string> = {
  session: 'Sessão', turn: 'Tarefa', tool: 'Ferramenta', agent: 'Agente',
  approval: 'Aprovação', notice: 'Aviso', audit: 'Auditoria', settings: 'Configuração',
  limitation: 'Limitação', budget: 'Orçamento', review: 'Revisão'
}

interface ActivityPageProps {
  projects: Project[]
  activeProjectId: string | null
  onOpenSession(sessionId: string): void
  onOpenMemory(projectId: string, slug: string): void
}

export function ActivityPage({ projects, activeProjectId, onOpenSession, onOpenMemory }: ActivityPageProps): ReactElement {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [severity, setSeverity] = useState<'' | ActivitySeverity>('')
  const [archived, setArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setItems(await unwrap(window.openclod.app.activity({ query, type: type || undefined, severity: severity || undefined, archived, limit: 500 })))
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [query, type, severity, archived])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2500)
    return () => clearInterval(timer)
  }, [refresh])

  const unread = items.filter((item) => !item.read && !item.archived).length
  const actionable = items.filter((item) => item.actionRequired && !item.archived).length

  return (
    <div className="page activity-page">
      <header className="page-head">
        <div>
          <h1>Centro de atividades</h1>
          <p>{unread} não lida(s) · {actionable} ação(ões) necessária(s)</p>
        </div>
        <div className="activity-head-actions">
          <button type="button" className="btn ghost small" onClick={() => void refresh()}><Icon name="refresh" size={12} /> Atualizar</button>
          <button type="button" className="btn ghost small" onClick={async () => { await unwrap(window.openclod.app.clearActivity(true)); await refresh() }}>Limpar arquivadas</button>
        </div>
      </header>
      <ImprovementReviewCard projects={projects} activeProjectId={activeProjectId} onOpenMemory={onOpenMemory} />
      <div className="page-tools activity-filters">
        <label className="page-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar atividades" spellCheck={false} />
        </label>
        <label className="page-sort">Tipo
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">Todos</option>
            {Object.entries(TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="page-sort">Severidade
          <select value={severity} onChange={(event) => setSeverity(event.target.value as '' | ActivitySeverity)}>
            <option value="">Todas</option><option value="error">Erro</option><option value="warning">Aviso</option><option value="success">Sucesso</option><option value="info">Informação</option>
          </select>
        </label>
        <button type="button" className={`btn ghost small ${archived ? 'is-active' : ''}`} onClick={() => setArchived((value) => !value)}>
          <Icon name="archive" size={12} /> {archived ? 'Ver ativas' : 'Ver arquivadas'}
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {loading ? <div className="page-empty compact">Carregando atividades…</div> : null}
      {!loading && !items.length ? <div className="page-empty"><Icon name="bell" size={24} /><p>Nenhuma atividade neste filtro.</p></div> : null}
      <div className="activity-list">
        {items.map((item) => (
          <article key={item.id} className={`activity-card severity-${item.severity} ${item.read ? 'is-read' : ''}`}>
            <span className="activity-severity" title={item.severity} />
            <div className="activity-copy">
              <div className="activity-title-line">
                <span className="activity-type">{TYPE_LABELS[item.type] ?? item.type}</span>
                <strong>{item.title}</strong>
                {item.count > 1 ? <span className="badge">×{item.count}</span> : null}
                {item.actionRequired ? <span className="badge on">ação necessária</span> : null}
              </div>
              <p>{item.detail}</p>
              <small>{relativeTime(item.updatedAt)}{item.sessionId ? ` · ${item.sessionId}` : ''}</small>
            </div>
            <div className="activity-actions">
              {item.sessionId ? <button type="button" className="btn tiny ghost" onClick={() => onOpenSession(item.sessionId!)}>Abrir</button> : null}
              {item.actionable === 'memory' && typeof item.metadata?.projectId === 'string' && typeof item.metadata?.slug === 'string' ? (
                <button type="button" className="btn tiny ghost" onClick={() => onOpenMemory(item.metadata!.projectId as string, item.metadata!.slug as string)}>Abrir na Memória</button>
              ) : null}
              <button type="button" className="icon-btn small" title={item.read ? 'Marcar como não lida' : 'Marcar como lida'} onClick={async () => { await unwrap(window.openclod.app.setActivityRead(item.id, !item.read)); await refresh() }}>
                <Icon name={item.read ? 'bell' : 'check'} size={12} />
              </button>
              <button type="button" className="icon-btn small" title={item.archived ? 'Desarquivar' : 'Arquivar'} onClick={async () => { await unwrap(window.openclod.app.archiveActivity(item.id, !item.archived)); await refresh() }}>
                <Icon name="archive" size={12} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
