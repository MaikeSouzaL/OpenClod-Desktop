import { useState, type ReactElement, type ReactNode } from 'react'
import type { CapabilityReport, Project, SessionSummary } from '../../../shared/types'
import { relativeTime } from '../lib/format'
import { Icon } from './Icons'

interface CoworkViewProps {
  projects: Project[]
  project: Project | null
  capabilities: CapabilityReport | null
  providerLabel: string
  model: string
  hasRealProvider: boolean
  composer: ReactNode
  recent?: SessionSummary[]
  onAddProject(): void
  onPickProject(project: Project): void
  onOpenSession?(sessionId: string): void
  onSuggestion(text: string): void
  onOpenSettings(): void
}

const SUGGESTIONS: Array<{ icon: 'folder' | 'file' | 'globe' | 'diff'; title: string; text: string; prompt: string }> = [
  {
    icon: 'folder',
    title: 'Arrumar uma pasta',
    text: 'Classifique, renomeie e resuma o que existe no diretório.',
    prompt: 'Analise a pasta do projeto, proponha uma organização de arquivos e execute depois da minha aprovação.'
  },
  {
    icon: 'file',
    title: 'Transformar documentos',
    text: 'Leia os arquivos e produza um relatório em Markdown.',
    prompt: 'Leia os documentos desta pasta e gere um relatório em Markdown com os pontos principais e pendências.'
  },
  {
    icon: 'globe',
    title: 'Pesquisar e consolidar',
    text: 'Navegue na web e junte os resultados em um arquivo.',
    prompt: 'Pesquise na web as informações mais recentes sobre o tema do projeto e consolide em um arquivo de resumo.'
  },
  {
    icon: 'diff',
    title: 'Revisar antes de entregar',
    text: 'Encontre problemas no código e proponha correções.',
    prompt: 'Revise o código do projeto em busca de bugs e riscos, explique cada achado e prepare as correções.'
  }
]

export function CoworkView({
  projects,
  project,
  capabilities,
  providerLabel,
  model,
  hasRealProvider,
  composer,
  recent = [],
  onAddProject,
  onPickProject,
  onOpenSession,
  onSuggestion,
  onOpenSettings
}: CoworkViewProps): ReactElement {
  const [bannerOpen, setBannerOpen] = useState(true)
  const computer = capabilities?.computer.available === true
  const browser = capabilities?.browser.available === true

  return (
    <div className="home cowork-home">
      <div className="home-center cowork-center">
        <div className="cowork-kicker">
          <Icon name="briefcase" size={13} /> Cowork
        </div>

        <h1 className="home-greeting cowork-greeting">
          <span>O que vamos</span>
          <em>realizar hoje?</em>
        </h1>

        <p className="cowork-sub">
          O Openclod assume uma pasta e trabalha nela: lê arquivos, roda comandos, navega e reporta cada passo. Tudo que
          for sensível passa pela sua aprovação.
        </p>

        {bannerOpen ? (
          <div className={`home-banner ${hasRealProvider ? '' : 'warn'}`}>
            <span className="banner-icon">
              <Icon name={hasRealProvider ? 'info' : 'alert'} size={16} />
            </span>
            <span className="banner-text">
              {hasRealProvider ? (
                <>
                  <strong>{providerLabel}</strong> · {model || 'modelo'} · Computer Use{' '}
                  {computer ? 'pronto' : 'indisponível'} · navegador {browser ? 'pronto' : 'indisponível'}
                </>
              ) : (
                <>Nenhum provedor real configurado. O modo Scripted não é um modelo real.</>
              )}
            </span>
            <button type="button" className="banner-btn" onClick={hasRealProvider ? undefined : onOpenSettings}>
              {hasRealProvider ? 'Cowork em prévia' : 'Configurar'}
            </button>
            <button type="button" className="banner-close" title="Fechar aviso" onClick={() => setBannerOpen(false)}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ) : null}

        <div className="cowork-folder">
          <span className="cowork-folder-icon">
            <Icon name={project ? 'folder' : 'folderOpen'} size={18} />
          </span>
          <span className="cowork-folder-text">
            <span className="cowork-folder-label">Pasta de trabalho</span>
            <span className="cowork-folder-name">{project ? project.name : 'Nenhuma pasta escolhida'}</span>
          </span>
          <button type="button" className="btn small subtle" onClick={onAddProject}>
            {project ? 'Trocar pasta' : 'Escolher pasta'}
          </button>
        </div>

        {projects.length > 1 ? (
          <div className="cowork-projects">
            {projects.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`cowork-project ${item.id === project?.id ? 'active' : ''}`}
                onClick={() => onPickProject(item)}
                title={item.path}
              >
                <Icon name="folder" size={12} /> {item.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="cowork-composer">{composer}</div>

        {recent.length ? (
          <div className="cowork-recent">
            <div className="cowork-recent-head">
              <span>Em andamento</span>
              <button type="button" className="link-btn" onClick={() => onOpenSession?.(recent[0].meta.id)}>
                Continuar
              </button>
            </div>
            {recent.slice(0, 4).map((session) => (
              <button
                key={session.meta.id}
                type="button"
                className="cowork-recent-row"
                onClick={() => onOpenSession?.(session.meta.id)}
              >
                <span className="cowork-recent-dot" />
                <span className="cowork-recent-title">{session.meta.title}</span>
                <span className="cowork-recent-time">{relativeTime(session.meta.updatedAt)}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="cowork-suggestions">
          {SUGGESTIONS.map((item) => (
            <button key={item.title} type="button" className="cowork-card" onClick={() => onSuggestion(item.prompt)}>
              <span className="cowork-card-icon">
                <Icon name={item.icon} size={15} />
              </span>
              <span className="cowork-card-body">
                <strong>{item.title}</strong>
                <span>{item.text}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="cowork-note">
          O Cowork usa o mesmo harness, as mesmas permissões e a mesma auditoria do Code. Ele pode abrir qualquer
          pasta do computador, navegar e instalar conectores MCP quando a tarefa precisar.
        </p>
      </div>
    </div>
  )
}
