import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import type { Project } from '../../../shared/types'
import type { MemoryPageContent, MemoryPageInfo, MemoryStatsInfo } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { Icon } from './Icons'
import { Markdown } from './Markdown'
import { MemoryGraph } from './MemoryGraph'
import { EMPTY_SELECTION, deletionText, masterState, prune, selectAll, selectRange, toggle, type Selection } from '../lib/memory-selection'
import './memory-select.css'

function memorySlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Turns Obsidian-style [[links]] into in-app links without touching the markdown source. */
function memoryBody(body: string): string {
  return body.replace(
    /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
    (_, target: string, label: string | undefined) =>
      `[${label ?? target}](#memory/${encodeURIComponent(target.trim())})`
  )
}

interface MemoryPageProps {
  projects: Project[]
  activeProjectId: string | null
  onSelectProject(project: Project): void
  onAddProject(): void
  onOpenSettings(): void
  /** Incremented by the project menu when the user asks for the graph. */
  graphRequest?: number
  /** Another screen asked to open one page (for example an improvement review report). */
  openRequest?: { id: number; projectId: string; slug: string } | null
  onOpenHandled?(): void
}

/** Per-project long-term memory: the markdown wiki every model and agent shares. */
export function MemoryPage({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onOpenSettings,
  graphRequest = 0,
  openRequest = null,
  onOpenHandled
}: MemoryPageProps): ReactElement {
  const initial = projects.find((project) => project.id === openRequest?.projectId) ?? projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null
  const [projectId, setProjectId] = useState<string | null>(initial?.id ?? null)
  const [pages, setPages] = useState<MemoryPageInfo[]>([])
  const [stats, setStats] = useState<MemoryStatsInfo | null>(null)
  const [selected, setSelected] = useState<MemoryPageContent | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [aiStatus, setAiStatus] = useState<{ available: boolean; running: boolean; port?: number; error?: string } | null>(null)
  const [recallText, setRecallText] = useState('')
  const [recalling, setRecalling] = useState(false)
  const [view, setView] = useState<'pages' | 'graph'>('pages')
  // Marked cards (to delete several pages at once). The first click on "Apagar" only asks; the second one deletes.
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [confirmingBulk, setConfirmingBulk] = useState(false)
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)

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
      const [list, status, ai] = await Promise.all([
        unwrap(window.forja.memory.list(projectId)),
        unwrap(window.forja.memory.status(projectId)),
        window.forja.memory.aiStatus().catch(() => null)
      ])
      setPages(list)
      setStats(status)
      setAiStatus(ai?.ok ? ai.value : null)
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

  useEffect(() => {
    if (!graphRequest) return
    setView('graph')
  }, [graphRequest])

  const openPage = async (slug: string, forProject = projectId): Promise<void> => {
    if (!forProject) return
    try {
      const content = await unwrap(window.forja.memory.read(forProject, slug))
      setSelected(content)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  useEffect(() => {
    if (!openRequest) return
    // The project is already the initial state on a fresh mount; switch it when the screen was open.
    if (projects.some((item) => item.id === openRequest.projectId)) setProjectId(openRequest.projectId)
    setView('pages')
    void openPage(openRequest.slug, openRequest.projectId).finally(() => onOpenHandled?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.id])

  const recall = async (): Promise<void> => {
    if (!projectId || !query.trim()) return
    setRecalling(true)
    setError('')
    try {
      const result = await unwrap(window.forja.memory.recall(projectId, query.trim(), 10))
      setRecallText(result.text || 'Nada encontrado no índice deste projeto.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRecalling(false)
    }
  }

  const onMemoryBodyClick = (event: MouseEvent<HTMLDivElement>): void => {
    const anchor = (event.target as HTMLElement).closest('a')
    const href = anchor?.getAttribute('href') ?? ''
    if (!href.startsWith('#memory/')) return
    event.preventDefault()
    const target = decodeURIComponent(href.slice('#memory/'.length))
    void openPage(memorySlug(target))
  }

  const removePage = async (slug: string): Promise<void> => {    if (!projectId || !window.confirm('Apagar esta página da memória do projeto? Não pode ser desfeito.')) return
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

  const selectedPages = useMemo(() => filtered.filter((page) => selection.slugs.has(page.slug)), [filtered, selection])
  const master = masterState(selectedPages.length, filtered.length)

  // What is marked is exactly what is on screen: a search, a deleted page or another project drops the marks that left the list.
  useEffect(() => {
    setSelection((current) => prune(current, filtered.map((page) => page.slug)))
  }, [filtered])

  useEffect(() => {
    setSelection(EMPTY_SELECTION)
    setConfirmingBulk(false)
  }, [projectId])

  useEffect(() => {
    if (!selection.slugs.size) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || bulk) return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && target.getAttribute('type') !== 'checkbox') return
      setSelection(EMPTY_SELECTION)
      setConfirmingBulk(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection.slugs.size, bulk])

  const onCheck = (event: MouseEvent<HTMLInputElement>, slug: string): void => {
    setConfirmingBulk(false)
    setSelection((current) => (event.shiftKey ? selectRange(current, filtered.map((page) => page.slug), slug) : toggle(current, slug)))
  }

  const clearSelection = (): void => {
    setSelection(EMPTY_SELECTION)
    setConfirmingBulk(false)
  }

  const deleteSelected = async (): Promise<void> => {
    if (!projectId || !selectedPages.length || bulk) return
    if (!confirmingBulk) {
      setConfirmingBulk(true)
      window.setTimeout(() => setConfirmingBulk(false), 6000)
      return
    }
    setConfirmingBulk(false)
    const targets = selectedPages
    setError('')
    setBulk({ done: 0, total: targets.length })
    const failed: string[] = []
    for (const [index, page] of targets.entries()) {
      try {
        if (!(await unwrap(window.forja.memory.delete(projectId, page.slug)))) failed.push(page.title)
      } catch {
        failed.push(page.title)
      }
      setBulk({ done: index + 1, total: targets.length })
    }
    setBulk(null)
    setSelection(EMPTY_SELECTION)
    await load()
    const gone = targets.length - failed.length
    setNotice(
      failed.length
        ? `${gone} página(s) apagada(s); ${failed.length} não foi(ram) apagada(s): ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : `${gone} página(s) apagada(s).`
    )
    window.setTimeout(() => setNotice(''), 8000)
  }

  return (
    <div className="page memory-page">
      <header className="page-head memory-head">
        <div>
          <h1>AI-Memory</h1>
          <p className="page-sub">
            A memória de longo prazo deste projeto. Cada modelo e cada agente lê e grava na mesma wiki, para que nada
            se perca quando você troca de IA.
          </p>
          {aiStatus ? (
            <p className="page-sub">
              {aiStatus.running
                ? `Índice AI-Memory ativo na porta ${aiStatus.port} — busca full-text, entidades e links.`
                : aiStatus.available
                  ? 'AI-Memory disponível; o índice inicia no primeiro uso.'
                  : 'AI-Memory indisponível; a wiki nativa continua funcionando.'}
            </p>
          ) : null}
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
          <button
            type="button"
            className="btn ghost small"
            disabled={!projectId}
            onClick={async () => {
              if (!projectId) return
              try {
                const saved = await unwrap(window.forja.memory.exportMarkdown(projectId))
                if (saved) setNotice(`Memória exportada para ${saved}`)
              } catch (err) {
                setError(errorMessage(err))
              }
            }}
          >
            <Icon name="download" size={13} /> Exportar
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={!projectId}
            onClick={async () => {
              if (!projectId) return
              try {
                const count = await unwrap(window.forja.memory.importMarkdown(projectId))
                setNotice(count ? `${count} página(s) importada(s).` : 'Nenhum arquivo .md encontrado.')
                await load()
              } catch (err) {
                setError(errorMessage(err))
              }
            }}
          >
            <Icon name="archive" size={13} /> Importar
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={!projectId}
            onClick={async () => {
              if (!projectId) return
              try {
                const count = await unwrap(window.forja.memory.importZip(projectId))
                setNotice(count ? `${count} página(s) importada(s) do ZIP.` : 'Nenhum arquivo .md encontrado no ZIP.')
                await load()
              } catch (err) {
                setError(errorMessage(err))
              }
            }}
          >
            <Icon name="archive" size={13} /> Importar ZIP
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
      {notice ? <div className="panel-note">{notice}</div> : null}

      {project ? (
        <>
          <div className="memory-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'pages'}
              className={view === 'pages' ? 'active' : ''}
              onClick={() => setView('pages')}
            >
              <Icon name="file" size={13} /> Páginas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'graph'}
              className={view === 'graph' ? 'active' : ''}
              onClick={() => setView('graph')}
            >
              <Icon name="share" size={13} /> Grafo
            </button>
          </div>

          {view === 'graph' ? (
            <MemoryGraph project={project} />
          ) : (
            <>
          <div className="memory-stats">
            <div className="memory-stat">
              <span className="memory-stat-value">{pages.length}</span>
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
            <div className="memory-stat">
              <span className="memory-stat-value">{stats?.indexed ?? 0}</span>
              <span className="memory-stat-label">no índice AI-Memory</span>
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
                <div onClick={onMemoryBodyClick}>
                  <Markdown text={memoryBody(selected.body)} />
                </div>
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
                <button type="button" className="btn ghost small" onClick={() => void recall()} disabled={!query.trim() || recalling}>
                  <Icon name="search" size={13} /> {recalling ? 'Buscando…' : 'Buscar no índice'}
                </button>
                <span className="muted">{filtered.length} página(s)</span>
              </div>

              {recallText ? (
                <div className="memory-detail">
                  <div className="memory-detail-head">
                    <strong>Resultado do índice AI-Memory</strong>
                    <button type="button" className="btn ghost small" onClick={() => setRecallText('')}>
                      Fechar
                    </button>
                  </div>
                  <article className="memory-detail-body">
                    <Markdown text={recallText} />
                  </article>
                </div>
              ) : null}

              {filtered.length ? (
                <div className={`memory-bulk${selectedPages.length ? ' has-selection' : ''}`} role="toolbar" aria-label="Seleção de páginas">
                  <label className="memory-bulk-master" title={master === 'all' ? 'Desmarcar todas' : 'Selecionar todas as páginas da lista'}>
                    <input
                      type="checkbox"
                      checked={master === 'all'}
                      ref={(node) => {
                        if (node) node.indeterminate = master === 'some'
                      }}
                      onChange={() => {
                        setConfirmingBulk(false)
                        setSelection(master === 'all' ? EMPTY_SELECTION : selectAll(filtered.map((page) => page.slug)))
                      }}
                      aria-label="Selecionar todas as páginas da lista"
                    />
                    <span className="memory-check-box" data-state={master} aria-hidden>
                      <Icon name={master === 'some' ? 'minus' : 'check'} size={12} />
                    </span>
                    {selectedPages.length ? (
                      <span className="memory-bulk-count" aria-live="polite">
                        {selectedPages.length} selecionada(s)
                      </span>
                    ) : (
                      <span>Selecionar todas</span>
                    )}
                  </label>
                  <span className="memory-bulk-spacer" />
                  {selectedPages.length ? (
                    <>
                      <button type="button" className="btn ghost small" onClick={clearSelection} disabled={Boolean(bulk)}>
                        Limpar seleção
                      </button>
                      <button
                        type="button"
                        className={`btn small memory-bulk-delete ${confirmingBulk ? 'danger' : 'ghost danger'}`}
                        onClick={() => void deleteSelected()}
                        disabled={Boolean(bulk)}
                      >
                        <Icon name="trash" size={13} />{' '}
                        {bulk
                          ? `Apagando ${bulk.done}/${bulk.total}…`
                          : confirmingBulk
                            ? deletionText(selectedPages.length, selectedPages.filter((page) => page.pinned).length).confirm
                            : deletionText(selectedPages.length, 0).button}
                      </button>
                    </>
                  ) : (
                    <span className="muted">Marque as páginas que quer apagar. Shift+clique marca uma faixa.</span>
                  )}
                </div>
              ) : null}

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
                  {filtered.map((page) => {
                    const marked = selection.slugs.has(page.slug)
                    return (
                      <div key={page.slug} className={`memory-card${marked ? ' is-selected' : ''}`} data-slug={page.slug}>
                        <button type="button" className="memory-card-open" onClick={() => void openPage(page.slug)}>
                          <div className="memory-card-head">
                            <Icon name={page.pinned ? 'bookmark' : 'file'} size={14} />
                            <strong>{page.title}</strong>
                          </div>
                          <p>{page.summary || 'Sem resumo.'}</p>
                          <div className="memory-card-foot">
                            <span>{new Date(page.updated).toLocaleDateString('pt-BR')}</span>
                            {page.source === 'ai-memory' ? <span className="memory-tag">índice</span> : null}
                            {page.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="memory-tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                        </button>
                        <label className="memory-check" title={marked ? 'Desmarcar' : 'Marcar para apagar (Shift+clique marca uma faixa)'}>
                          <input
                            type="checkbox"
                            checked={marked}
                            onChange={() => undefined}
                            onClick={(event) => onCheck(event, page.slug)}
                            aria-label={`Selecionar a página ${page.title}`}
                          />
                          <span className="memory-check-box" aria-hidden>
                            <Icon name="check" size={12} />
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
            </>
          )}
        </>
      ) : null}
    </div>
  )
}
