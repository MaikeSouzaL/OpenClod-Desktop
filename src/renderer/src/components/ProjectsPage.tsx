import { useMemo, useState, type ReactElement } from 'react'
import type { Project, SessionSummary } from '../../../shared/types'
import { Icon } from './Icons'
import { MenuPopover, type MenuItem } from './Chrome'
import { relativeTime, shortPath } from '../lib/format'

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

interface ProjectsPageProps {
  projects: Project[]
  sessions: SessionSummary[]
  onOpen(project: Project): void
  onNewSession(project: Project): void
  onAdd(): void
  onReveal(path: string): void
  onRemove(project: Project): void
  onDelete(project: Project): void
}

export function ProjectsPage({ projects, sessions, onOpen, onNewSession, onAdd, onReveal, onRemove, onDelete }: ProjectsPageProps): ReactElement {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'recent' | 'name'>('recent')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  const stats = useMemo(() => {
    const map = new Map<string, { count: number; last: number }>()
    for (const project of projects) {
      const own = sessions.filter((session) => normalize(session.meta.cwd) === normalize(project.path))
      map.set(project.id, {
        count: own.length,
        last: Math.max(project.lastOpenedAt, ...own.map((session) => session.meta.updatedAt))
      })
    }
    return map
  }, [projects, sessions])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? projects.filter((project) => project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q)) : projects
    return [...filtered].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : (stats.get(b.id)?.last ?? 0) - (stats.get(a.id)?.last ?? 0)
    )
  }, [projects, query, sort, stats])

  const menuProject = menu ? projects.find((project) => project.id === menu.id) : null
  const items: MenuItem[] = menuProject
    ? [
        { id: 'new', label: 'Nova sessão', icon: 'plus', onSelect: () => onNewSession(menuProject) },
        { id: 'reveal', label: 'Abrir no Explorer', icon: 'external', onSelect: () => onReveal(menuProject.path) },
        { id: 'sep', separator: true },
        {
          id: 'remove',
          label: 'Remover da lista',
          icon: 'x',
          danger: true,
          onSelect: () => {
            if (window.confirm(`Remover "${menuProject.name}" da lista? Os arquivos e as sessões continuam no disco.`)) onRemove(menuProject)
          }
        },
        {
          id: 'delete',
          label: 'Excluir projeto e memória',
          icon: 'trash',
          danger: true,
          onSelect: () => {
            if (
              window.confirm(
                `Excluir "${menuProject.name}" permanentemente?\n\nSessões, memória nativa e índice AI-Memory serão apagados. Os arquivos da pasta do projeto não são tocados.`
              )
            ) {
              onDelete(menuProject)
            }
          }
        }
      ]
    : []

  return (
    <div className="page">
      <header className="page-head">
        <h1>Projetos</h1>
        <button type="button" className="btn primary" onClick={onAdd}>
          <Icon name="plus" size={14} /> Novo projeto
        </button>
      </header>
      <div className="page-tools">
        <div className="page-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar projetos" spellCheck={false} />
        </div>
        <label className="page-sort">
          Ordenar por
          <select value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'name')}>
            <option value="recent">Atividade recente</option>
            <option value="name">Nome</option>
          </select>
        </label>
      </div>
      {!projects.length ? (
        <div className="page-empty">
          <Icon name="folderOpen" size={26} />
          <p>Nenhum projeto ainda. Um projeto é uma pasta do seu computador onde o agente trabalha.</p>
          <button type="button" className="btn primary" onClick={onAdd}>
            Abrir pasta de projeto
          </button>
        </div>
      ) : !list.length ? (
        <div className="page-empty">
          <p>Nenhum projeto corresponde à pesquisa.</p>
        </div>
      ) : (
        <div className="project-grid">
          {list.map((project) => {
            const info = stats.get(project.id)
            return (
              <div
                key={project.id}
                className="project-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(project)}
                onKeyDown={(event) => event.key === 'Enter' && onOpen(project)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ id: project.id, x: event.clientX, y: event.clientY })
                }}
              >
                <div className="project-card-head">
                  <Icon name="folder" size={15} />
                  <strong>{project.name}</strong>
                  <button
                    type="button"
                    className="side-mini"
                    title="Mais opções"
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenu({ id: project.id, x: event.clientX, y: event.clientY })
                    }}
                  >
                    <Icon name="more" size={13} />
                  </button>
                </div>
                <code title={project.path}>{shortPath(project.path, 48)}</code>
                <div className="project-card-foot">
                  <span>{info?.count ? `${info.count} sessão(ões)` : 'sem sessões'}</span>
                  <span>atualizado {relativeTime(info?.last ?? project.lastOpenedAt)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {menu ? (
        <div className="context-anchor" style={{ left: menu.x, top: menu.y }}>
          <MenuPopover items={items} onClose={() => setMenu(null)} />
        </div>
      ) : null}
    </div>
  )
}
