import type { CSSProperties, ReactElement } from 'react'
import { PROVIDER_MARKS } from '../lib/provider-logos'
import { providerInitials } from '../lib/provider-initials'
import './providers.css'

/**
 * A marca do provedor num quadrado neutro. O desenho vem embutido no app (nunca é baixado) e usa a cor oficial quando a marca
 * é colorida e a cor do texto do tema nas demais. Sem marca (Anthropic, provedores que o usuário criou): as iniciais, também em
 * tom neutro.
 */
export function ProviderLogo({ id, label, size = 36 }: { id: string; label: string; size?: number }): ReactElement {
  const mark = PROVIDER_MARKS[id]
  const style = { '--pv-size': `${size}px`, ...(mark?.color ? { '--pv-logo': mark.color } : {}) } as CSSProperties
  return (
    <span className="pv-logo" data-logo={mark ? 'mark' : 'initials'} data-provider={id} style={style} aria-hidden="true">
      {mark ? (
        <svg viewBox={mark.viewBox} focusable="false">
          <path d={mark.path} fillRule={mark.fillRule} clipRule={mark.fillRule} />
        </svg>
      ) : (
        <span className="pv-initials">{providerInitials(label)}</span>
      )}
    </span>
  )
}
