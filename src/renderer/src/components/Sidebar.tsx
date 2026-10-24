import { useMemo, useState, type ReactElement } from 'react'
import type { Project, SessionSummary, SessionSurface } from '../../../shared/types'
import { Icon } from './Icons'
import { OpenclodMark, MenuPopover, type MenuItem } from './Chrome'
import { relativeTime } from '../lib/format'

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export type SidebarMode = SessionSurface
export type SidebarPage = 'projects' | 'memory' | 'artifacts' | 'scheduled' | 'dispatch' | 'design' | 'customize' | 'more'

const PAGES: Array<{ id: SidebarPage; label: string; icon: 'folder' | 'archive' | 'image' | 'clock' | 'terminal' | 'sparkles' | 'sliders' | 'more' }> = [
  { id: 'projects', label: 'Projetos', icon: 'folder' },
  { id: 'memory', label: 'Memória', icon: 'archive' },
  { id: 'artifacts', label: 'Artefatos', icon: 'image' },
  { id: 'scheduled', label: 'Agendados', icon: 'clock' },
  { id: 'dispatch', label: 'Dispatch', icon: 'terminal' },
  { id: 'design', label: 'Design', icon: 'sparkles' },
  { id: 'customize', label: 'Personalização', icon: 'sliders' },
  { id: 'more', label: 'Mais', icon: 'more' }
]

interface SidebarProps {
  mode: SidebarMode
  page: SidebarPage | null
  projects: Project[]
  sessions: SessionSummary[]
  /** Sessions with a turn running right now. */
  busy: Set<string>
  activeProjectId: string | null
  activeSessionId: string | null
  version: string
  onMode(mode: SidebarMode): void
  onPage(page: SidebarPage): void
  onSelectProject(project: Project): void
  onSelectSession(sessionId: string): void
  onNewSession(project: Project): void
  onAddProject(): void
  onRemoveProject(project: Project): void
  onDeleteSession(sessionId: string): void
  onRenameSession(sessionId: string, title: string): void
  onArchiveSession(sessionId: string, archived: boolean): void
  onExportSession(sessionId: string): void
  onImportSession(): void
  onOpenSettings(): void
  onOpenMenu(): void
}

const MODES: Array<{ id: SidebarMode; label: string; icon: 'home' | 'code' }> = [
  { id: 'chat', label: 'Início', icon: 'home' },
  { id: 'code', label: 'Code', icon: 'code' }
]

export function Sidebar({
  mode,
  page,
  projects,
  sessions,
  busy,
  activeProjectId,
  activeSessionId,
  version,
  onMode,
  onPage,
  onSelectProject,
  onSelectSession,
  onNewSession,
  onAddProject,
  onRemoveProject,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
  onExportSession,
  onImportSession,
  onOpenSettings,
  onOpenMenu
}: SidebarProps): ReactElement {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [oldestFirst, setOldestFirst] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [userMenu, setUserMenu] = useState<{ x: number; y: number } | null>(null)

  const live = useMemo(() => sessions.filter((session) => !session.meta.archived), [sessions])
  const archived = useMemo(() => sessions.filter((session) => session.meta.archived), [sessions])
  // Cowork lives inside Início now: the sidebar only has Início and Code.
  const navMode: 'chat' | 'code' = mode === 'code' ? 'code' : 'chat'

  const visibleSessions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return live
    return live.filter(
      (session) =>
        session.meta.title.toLowerCase().includes(q) || session.preview.toLowerCase().includes(q)
    )
  }, [live, query])

  const sessionsFor = (project: Project): SessionSummary[] =>
    visibleSessions
      .filter((session) => normalize(session.meta.cwd) === normalize(project.path))
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)

  const recent = useMemo(
    () =>
      [...visibleSessions]
        .sort((a, b) => (oldestFirst ? a.meta.updatedAt - b.meta.updatedAt : b.meta.updatedAt - a.meta.updatedAt))
        .slice(0, 60),
    [visibleSessions, oldestFirst]
  )

  const commitRename = (): void => {
    if (renaming && draft.trim()) onRenameSession(renaming, draft.trim())
    setRenaming(null)
  }

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]

  const openMenu = (event: React.MouseEvent, sessionId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ id: sessionId, x: event.clientX, y: event.clientY })
  }

  const menuSession = menu ? sessions.find((item) => item.meta.id === menu.id) : null
  const menuItems: MenuItem[] = menuSession
    ? [
        {
          id: 'rename',
          label: 'Renomear',
          icon: 'pencil',
          onSelect: () => {
            setRenaming(menuSession.meta.id)
            setDraft(menuSession.meta.title)
          }
        },
        {
          id: 'archive',
          label: menuSession.meta.archived ? 'Desarquivar' : 'Arquivar',
          icon: 'archive',
          onSelect: () => onArchiveSession(menuSession.meta.id, !menuSession.meta.archived)
        },
        { id: 'export', label: 'Exportar JSON', icon: 'download', onSelect: () => onExportSession(menuSession.meta.id) },
        { id: 'sep', separator: true },
        {
          id: 'delete',
          label: 'Apagar sessão',
          icon: 'trash',
          danger: true,
          onSelect: () => {
            if (window.confirm(`Apagar a sessão "${menuSession.meta.title}"?`)) onDeleteSession(menuSession.meta.id)
          }
        }
      ]
    : []

  const projectSession = projectMenu ? projects.find((item) => item.id === projectMenu.id) : null
  const projectItems: MenuItem[] = projectSession
    ? [
        {
          id: 'new',
          label: 'Nova sessão',
          icon: 'plus',
          onSelect: () => onNewSession(projectSession)
        },
        { id: 'sep', separator: true },
        {
          id: 'remove',
          label: 'Remover da lista',
          icon: 'x',
          danger: true,
          onSelect: () => {
            if (window.confirm(`Remover "${projectSession.name}" da lista? As sessões continuam no disco.`)) {
              onRemoveProject(projectSession)
            }
          }
        }
      ]
    : []

  const userItems: MenuItem[] = [
    { id: 'open', label: 'Abrir pasta de projeto…', icon: 'folderOpen', onSelect: onAddProject },
    { id: 'import', label: 'Importar sessão…', icon: 'download', onSelect: onImportSession },
    { id: 'sep', separator: true },
    { id: 'archived', label: `Arquivadas (${archived.length})`, icon: 'archive', checked: showArchived, onSelect: () => setShowArchived((value) => !value) },
    { id: 'sep2', separator: true },
    { id: 'settings', label: 'Configurações', icon: 'settings', shortcut: 'Ctrl+,', onSelect: onOpenSettings }
  ]

  const sessionRow = (session: SessionSummary): ReactElement => (
    <div
      key={session.meta.id}
      className={`side-session ${session.meta.id === activeSessionId ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelectSession(session.meta.id)}
      onContextMenu={(event) => openMenu(event, session.meta.id)}
      onDoubleClick={() => {
        setRenaming(session.meta.id)
        setDraft(session.meta.title)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelectSession(session.meta.id)
      }}
      title={session.meta.title}
    >
      {renaming === session.meta.id ? (
        <input
          className="side-rename"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') setRenaming(null)
          }}
        />
      ) : (
        <>
          <span className="side-session-title">{session.meta.title}</span>
          {session.meta.archived ? <Icon name="archive" size={11} className="side-session-mark" /> : null}
          {busy.has(session.meta.id) ? <span className="side-busy" title="Trabalhando" aria-label="Trabalhando" /> : null}
          <span className="side-session-time">{relativeTime(session.meta.updatedAt)}</span>
          <button
            type="button"
            className="side-mini hover-only"
            title="Mais opções"
            onClick={(event) => openMenu(event, session.meta.id)}
          >
            <Icon name="more" size={13} />
          </button>
        </>
      )}
    </div>
  )

  const projectRow = (project: Project): ReactElement => {
    const list = sessionsFor(project)
    const isActive = project.id === activeProjectId
    const isOpen = isActive ? collapsed[project.id] !== true : expanded[project.id] === true
    return (
      <section key={project.id} className={`side-project ${isActive ? 'is-active' : ''}`}>
        <div
          className="side-project-row"
          onContextMenu={(event) => {
            event.preventDefault()
            setProjectMenu({ id: project.id, x: event.clientX, y: event.clientY })
          }}
        >
          <button
            type="button"
            className="side-project-name"
            aria-expanded={isOpen}
            onClick={() => {
              onSelectProject(project)
              if (isActive) setCollapsed((current) => ({ ...current, [project.id]: isOpen }))
              else setExpanded((current) => ({ ...current, [project.id]: true }))
            }}
            title={project.path}
          >
            <span>{project.name}</span>
            {list.length ? <span className="side-count">{list.length}</span> : null}
          </button>
          {isOpen ? <Icon name="chevronDown" size={11} className="side-project-caret" /> : null}
          <button
            type="button"
            className="side-mini side-project-add"
            title="Nova sessão neste projeto"
            onClick={(event) => {
              event.stopPropagation()
              onNewSession(project)
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>

        {isOpen ? (
          <div className="side-sessions">
            {!list.length ? <div className="side-none">Nenhuma sessão ainda</div> : null}
            {list.map((item) => sessionRow(item))}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="mode-switch" role="tablist" aria-label="Área de trabalho">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={navMode === item.id}
              className={navMode === item.id ? 'active' : ''}
              onClick={() => onMode(item.id)}
              title={item.label}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="side-row side-row-strong"
          onClick={() => {
            if (activeProject) onNewSession(activeProject)
            else onAddProject()
          }}
          title={
            activeProject
              ? `${navMode === 'chat' ? 'Nova conversa' : 'Nova sessão'} em ${activeProject.name}`
              : 'Abrir uma pasta de projeto'
          }
        >
          <span className="side-leading">
            <Icon name="plus" size={16} />
          </span>
          <span className="side-label">Criar</span>
        </button>
        <nav className="side-nav" aria-label="Páginas">
          {PAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`side-row ${page === item.id ? 'active' : ''}`}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => onPage(item.id)}
            >
              <span className="side-leading">
                <Icon name={item.icon} size={15} />
              </span>
              <span className="side-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="sidebar-scroll">
        {searching ? (
          <div className="side-search">
            <Icon name="search" size={14} />
            <input
              autoFocus
              value={query}
              placeholder="Pesquisar"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearching(false)
                  setQuery('')
                }
              }}
            />
            <button
              type="button"
              className="side-mini"
              onClick={() => {
                setSearching(false)
                setQuery('')
              }}
              title="Fechar pesquisa"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ) : null}

        {navMode === 'chat' ? (
          <>
            <div className="side-section-head">
              <span>Conversas e tarefas</span>
              <span className="side-section-actions">
                <button type="button" className="side-mini" title="Pesquisar" onClick={() => setSearching(true)}>
                  <Icon name="search" size={13} />
                </button>
                <button
                  type="button"
                  className="side-mini"
                  title={oldestFirst ? 'Mais recentes primeiro' : 'Mais antigas primeiro'}
                  onClick={() => setOldestFirst((value) => !value)}
                >
                  <Icon name="filter" size={13} />
                </button>
              </span>
            </div>
            <div className="side-recent">
              {recent.length ? (
                recent.map((session) => sessionRow(session))
              ) : (
                <div className="side-none">Nenhuma conversa ainda</div>
              )}
            </div>
          </>
        ) : (
          <>
            {!projects.length ? (
              <button type="button" className="side-empty" onClick={onAddProject}>
                <Icon name="folderOpen" size={18} />
                <span>Adicionar uma pasta de projeto</span>
              </button>
            ) : null}

            {projects.map((project) => projectRow(project))}
          </>
        )}

        {archived.length ? (
          <div className="side-archived">
            <button type="button" className="side-archived-toggle" onClick={() => setShowArchived((value) => !value)}>
              <Icon name={showArchived ? 'chevronDown' : 'chevronRight'} size={12} /> Arquivadas ({archived.length})
            </button>
            {showArchived ? archived.map((session) => sessionRow(session)) : null}
          </div>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="side-user"
          onClick={(event) => setUserMenu({ x: event.clientX, y: event.clientY })}
          title="Conta e preferências"
        >
          <span className="side-avatar">
            <OpenclodMark size={15} />
          </span>
          <span className="side-user-name">Openclod Desktop</span>
          <span className="side-version">v{version}</span>
          <Icon name="chevronDown" size={12} className="side-user-chevron" />
        </button>
        <div className="side-foot-actions">
          <button type="button" className="side-mini" onClick={onOpenSettings} title="Configurações (Ctrl+,)">
            <Icon name="sliders" size={14} />
          </button>
          <button type="button" className="side-mini" onClick={() => setSearching(true)} title="Pesquisar">
            <Icon name="search" size={14} />
          </button>
          <button type="button" className="side-mini" onClick={onOpenMenu} title="Menu do aplicativo">
            <Icon name="more" size={14} />
          </button>
        </div>
      </div>

      {menu ? (
        <div className="context-anchor" style={{ left: menu.x, top: menu.y }}>
          <MenuPopover items={menuItems} onClose={() => setMenu(null)} />
        </div>
      ) : null}

      {projectMenu ? (
        <div className="context-anchor" style={{ left: projectMenu.x, top: projectMenu.y }}>
          <MenuPopover items={projectItems} onClose={() => setProjectMenu(null)} />
        </div>
      ) : null}

      {userMenu ? (
        <div className="context-anchor" style={{ left: userMenu.x, top: userMenu.y - 190 }}>
          <MenuPopover items={userItems} onClose={() => setUserMenu(null)} />
        </div>
      ) : null}
    </aside>
  )
}
