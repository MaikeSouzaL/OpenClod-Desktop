import { useState, type ReactElement, type ReactNode } from 'react'
import type { CapabilityReport, Project } from '../../../shared/types'
import { Icon } from './Icons'
import { ForjaMark } from './Chrome'

interface HomeViewProps {
  project: Project | null
  recentTitle?: string
  capabilities: CapabilityReport | null
  providerLabel: string
  model: string
  hasRealProvider: boolean
  composer: ReactNode
  onAddProject(): void
  onOpenSettings(): void
  onCapabilities(): void
}

export function HomeView({
  project,
  recentTitle,
  capabilities,
  providerLabel,
  model,
  hasRealProvider,
  composer,
  onAddProject,
  onOpenSettings,
  onCapabilities
}: HomeViewProps): ReactElement {
  const [bannerOpen, setBannerOpen] = useState(true)
  const computer = capabilities?.computer.available === true
  const browser = capabilities?.browser.available === true
  const heading = recentTitle?.trim() || project?.name || 'vamos forjar alguma coisa'

  return (
    <div className="home">
      <div className="home-center">
        <h1 className="home-greeting">
          <span className="home-star">
            <ForjaMark size={34} />
          </span>
          <span>
            De volta à ação, <em>{heading}</em>
          </span>
        </h1>

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
            <button type="button" className="banner-btn" onClick={hasRealProvider ? onCapabilities : onOpenSettings}>
              {hasRealProvider ? 'Ver capacidades' : 'Configurar'}
            </button>
            <button type="button" className="banner-close" title="Fechar aviso" onClick={() => setBannerOpen(false)}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ) : null}

        <div className="home-composer">{composer}</div>

        <div className="home-hints">
          <button type="button" className="home-hint" onClick={onAddProject}>
            <Icon name="folderOpen" size={13} />
            {project ? project.name : 'Abrir uma pasta de projeto'}
          </button>
          <span className="home-dot">·</span>
          <button type="button" className="home-hint" onClick={onOpenSettings}>
            <Icon name="settings" size={13} /> Provedores e permissões
          </button>
        </div>
      </div>
    </div>
  )
}
