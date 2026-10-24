import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { Project } from '../../../shared/types'
import type { MemoryPageContent, MemoryPageInfo, MemoryStatsInfo } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { Icon } from './Icons'
import { Markdown } from './Markdown'

interface MemoryPageProps {
  projects: Project[]
  activeProjectId: string | null
  onSelectProject(project: Project): void
  onAddProject(): void
  onOpenSettings(): void
}

/** Per-project long-term memory: the markdown wiki every model and agent shares. */
export function MemoryPage({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onOpenSettings
}: MemoryPageProps): ReactElement {
  const initial = projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null
  const [projectId, setProjectId] = useState<string | null>(initial?.id ?? null)
  const [pages, setPages] = useState<MemoryPageInfo[]>([])
  const [stats, setStats] = useState<MemoryStatsInfo | null>(null)
  const [selected, setSelected] = useState<MemoryPageContent | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const project = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projects, projectId]
  )

  useEffect(() => {
    if (projectId && projects.some((item) => item.id === projectId)) return
    const next = projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null
    setProjectId(next?.id ?? null)
  }, [activeProjectId, projectId, projects])

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setPages([])
      setStats(null)
      setSelected(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      const [list, status] = await Promise.all([
        unwrap(window.forja.memory.list(projectId)),
        unwrap(window.forja.memory.status(projectId))
      ])
      setPages(list)
      setStats(status)
      setSelected((current) => (current && list.some((page) => page.slug === current.slug) ? current : null))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const openPage = async (slug: string): Promise<void> => {
    if (!projectId) return
    try {
      const content = await unwrap(window.forja.memory.read(projectId, slug))
      setSelected(content)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const removePage = async (slug: string): Promise<void> => {
    if (!projectId || !window.confirm('Apagar esta página da memória do projeto? Não pode ser desfeito.')) return
    try {
      await unwrap(window.forja.memory.delete(projectId, slug))
      setSelected(null)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pages
    return pages.filter(
      (page) =>
        page.title.toLowerCase().includes(q) ||
        page.summary.toLowerCase().includes(q) ||
        page.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  }, [pages, query])

  return (
    <div className="page memory-page">
      <header className="page-head memory-head">
        <div>
          <h1>AI-Memory</h1>
          <p className="page-sub">
            A memória de longo prazo deste projeto. Cada modelo e cada agente lê e grava na mesma wiki, para que nada
            se perca quando você troca de IA.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost small" onClick={() => void load()} disabled={!project || loading}>
            <Icon name="refresh" size={13} /> Atualizar
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => projectId && void window.forja.memory.open(projectId)}
            disabled={!project}
          >
            <Icon name="folderOpen" size={13} /> Abrir pasta
          </button>
          <button type="button" className="btn small" onClick={onOpenSettings}>
            <Icon name="settings" size={13} /> Configurar
          </button>
        </div>
      </header>

      {projects.length ? (
        <div className="memory-projects">
          {projects.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`memory-project ${item.id === projectId ? 'active' : ''}`}
              onClick={() => {
                setProjectId(item.id)
                setSelected(null)
                onSelectProject(item)
              }}
              title={item.path}
            >
              <Icon name="folder" size={13} />
              {item.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="page-empty">
          <Icon name="archive" size={28} />
          <p>Nenhum projeto ainda. A memória é criada por projeto.</p>
          <button type="button" className="btn primary" onClick={onAddProject}>
            <Icon name="plus" size={13} /> Abrir uma pasta
          </button>
        </div>
      )}

      {error ? <div className="inline-error">{error}</div> : null}

      {project ? (
        <>
          <div className="memory-stats">
            <div className="memory-stat">
              <span className="memory-stat-value">{stats?.pages ?? pages.length}</span>
              <span className="memory-stat-label">páginas</span>
            </div>
            <div className="memory-stat">
              <span className="memory-stat-value">{stats?.pinned ?? 0}</span>
              <span className="memory-stat-label">fixadas</span>
            </div>
            <div className="memory-stat">
              <span className="memory-stat-value">{stats?.openHandoffs ?? 0}</span>
              <span className="memory-stat-label">handoffs abertos</span>
            </div>
            <div className="memory-stat path">
              <span className="memory-stat-value small">{project.name}</span>
              <span className="memory-stat-label">{project.path}</span>
            </div>
          </div>

          {selected ? (
            <div className="memory-detail">
              <div className="memory-detail-head">
                <button type="button" className="btn ghost small" onClick={() => setSelected(null)}>
                  <Icon name="arrowLeft" size={13} /> Voltar
                </button>
                <div className="memory-detail-tags">
                  {selected.tags.map((tag) => (
                    <span key={tag} className="badge">
                      {tag}
                    </span>
                  ))}
                  {selected.pinned ? (
                    <span className="badge on">
                      <Icon name="bookmark" size={11} /> fixada
                    </span>
                  ) : null}
                </div>
                <button type="button" className="btn ghost small danger" onClick={() => void removePage(selected.slug)}>
                  <Icon name="trash" size={13} /> Apagar
                </button>
              </div>
              <article className="memory-detail-body">
                <h2>{selected.title}</h2>
                <Markdown text={selected.body} />
              </article>
            </div>
          ) : (
            <>
              <div className="page-tools">
                <div className="page-search">
                  <Icon name="search" size={14} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Procurar na memória do projeto"
                    spellCheck={false}
                  />
                </div>
                <span className="page-tools-spacer" />
                <span className="muted">{filtered.length} página(s)</span>
              </div>

              {loading && !pages.length ? <div className="page-empty compact">Carregando memória…</div> : null}
              {!loading && !filtered.length ? (
                <div className="page-empty">
                  <Icon name="archive" size={28} />
                  <p>
                    {pages.length
                      ? 'Nenhuma página corresponde à busca.'
                      : 'A memória deste projeto ainda está vazia. Peça ao agente para salvar uma descoberta ou um handoff; ele grava aqui automaticamente.'}
                  </p>
                </div>
              ) : (
                <div className="memory-grid">
                  {filtered.map((page) => (
                    <button
                      key={page.slug}
                      type="button"
                      className="memory-card"
                      onClick={() => void openPage(page.slug)}
                    >
                      <div className="memory-card-head">
                        <Icon name={page.pinned ? 'bookmark' : 'file'} size={14} />
                        <strong>{page.title}</strong>
                      </div>
                      <p>{page.summary || 'Sem resumo.'}</p>
                      <div className="memory-card-foot">
                        <span>{new Date(page.updated).toLocaleDateString('pt-BR')}</span>
                        {page.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="memory-tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  )
}
