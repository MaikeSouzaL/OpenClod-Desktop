import type { ReactElement } from 'react'
import { ProviderLogo } from './ProviderLogo'
import './providers.css'

export interface ProviderTileProps {
  id: string
  label: string
  model: string
  /** O que aparece no canto: "pronto", "local", "sem chave" ou o motivo da falha. */
  status: string
  tone: 'ok' | 'idle' | 'bad'
  modelCount?: number
  usage?: { text: string; title: string }
  isDefault: boolean
  onSelect(): void
}

/** Um provedor na grade de Configurações → Provedores. */
export function ProviderTile({ id, label, model, status, tone, modelCount, usage, isDefault, onSelect }: ProviderTileProps): ReactElement {
  const left = [isDefault ? 'padrão' : '', modelCount ? `${modelCount} modelos` : ''].filter(Boolean).join(' · ')
  return (
    // `provider-tile` fica como gancho dos testes e das telas que já o conhecem; o visual é todo de `pv-tile`.
    <button type="button" className={`provider-tile pv-tile${isDefault ? ' is-default' : ''}`} onClick={onSelect}>
      <span className="pv-tile-top">
        <ProviderLogo id={id} label={label} size={36} />
        <span className="pv-status" data-tone={tone}>
          {status}
        </span>
      </span>
      <span className="pv-tile-body">
        <span className="pv-tile-name">{label}</span>
        <span className="pv-tile-model">{model}</span>
      </span>
      {left || usage ? (
        <span className="pv-tile-foot">
          <span>{left}</span>
          {usage ? <span title={usage.title}>{usage.text}</span> : null}
        </span>
      ) : null}
    </button>
  )
}
