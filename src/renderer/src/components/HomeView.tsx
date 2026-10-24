import { useState, type ReactElement, type ReactNode } from 'react'
import type { CapabilityReport, Project } from '../../../shared/types'
import { Icon } from './Icons'
import { OpenclodMark } from './Chrome'

interface HomeViewProps {
  project: Project | null
  recentTitle?: string
  capabilities: CapabilityReport | null
  providerLabel: string
  model: string
  hasRealProvider: boolean
  profileName?: string
  composer: ReactNode
  onAddProject(): void
  onOpenSettings(): void
  onCapabilities(): void
  onOpenMemory?(): void
}

export function HomeView({
  project,
  recentTitle,
  capabilities,
  providerLabel,
  model,
  hasRealProvider,
  profileName,
  composer,
  onAddProject,
  onOpenSettings,
  onCapabilities,
  onOpenMemory
}: HomeViewProps): ReactElement {
  const [bannerOpen, setBannerOpen] = useState(true)
  const computer = capabilities?.computer.available === true
  const browser = capabilities?.browser.available === true
  const hour = new Date().getHours()
  const greeting =
    hour < 5 ? 'coruja noturna' : hour < 12 ? 'bom dia' : hour < 18 ? 'boa tarde' : 'boa noite'
  const name = profileName?.trim() || greeting

  return (
    <div className="home">
      <div className="home-center">
        <h1 className="home-greeting">
          <span className="home-star">
            <OpenclodMark size={34} />
          </span>
          <span>
            Olá, <em>{name}</em>
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
          <button type="button" className="home-hint" onClick={onOpenSettings}>
            <Icon name="settings" size={13} /> Provedores e permissões
          </button>
          <span className="home-dot">·</span>
          <button type="button" className="home-hint" onClick={onOpenMemory}>
            <Icon name="archive" size={13} /> Memória do projeto
          </button>
        </div>
      </div>
    </div>
  )
}
