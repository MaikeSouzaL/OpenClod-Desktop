import { useState, type CSSProperties, type ReactElement } from 'react'
import { connectorIconView } from '../lib/connector-icons'
import { monogram, monogramHue, rowSeed, type ConnectorRow } from '../lib/connectors'

type IconRow = Pick<ConnectorRow, 'id' | 'name' | 'entry' | 'custom' | 'endpoint'>

/** The initials in a square whose colour never changes for the same name: what shows when a connector has no logo. */
export function Monogram({ row, size = 40 }: { row: Pick<ConnectorRow, 'name' | 'entry'>; size?: number }): ReactElement {
  const hue = monogramHue(rowSeed(row))
  return (
    <span
      className="cnx-mono"
      aria-hidden="true"
      data-logo="initials"
      style={{ ['--h' as string]: hue, width: size, height: size, fontSize: Math.round(size * 0.38) } as CSSProperties}
    >
      {monogram(row.name)}
    </span>
  )
}

/**
 * The logo of a connector: the image that ships inside the app (never fetched from a third party), in a fixed square
 * with rounded corners. No image for it, or it fails to load: the initials, as before.
 */
export function ConnectorIcon({ row, size = 40 }: { row: IconRow; size?: number }): ReactElement {
  const [failed, setFailed] = useState<string | null>(null)
  const view = connectorIconView(row, failed)
  if (view.kind === 'initials') return <Monogram row={row} size={size} />
  return (
    <span className="cnx-logo" aria-hidden="true" data-logo="image" style={{ width: size, height: size }}>
      <img src={view.src} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(view.src)} />
    </span>
  )
}
