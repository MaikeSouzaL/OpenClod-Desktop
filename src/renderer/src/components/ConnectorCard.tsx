import { memo, type ReactElement } from 'react'
import { Icon } from './Icons'
import { ConnectorIcon } from './ConnectorIcon'
import { authBadges, primaryActionLabel, statusChip, type ConnectorRow } from '../lib/connectors'

interface ConnectorCardProps {
  row: ConnectorRow
  busy: boolean
  onOpen(row: ConnectorRow, trigger: HTMLElement | null): void
}

/** One app of the directory: logo, name, two lines of description, authentication seals, status and the main button. */
function ConnectorCardBase({ row, busy, onOpen }: ConnectorCardProps): ReactElement {
  const chip = statusChip(row.state)
  const badges = authBadges(row)
  const installed = row.state.status !== 'not-installed'
  return (
    <article
      className={`cnx-card ${installed ? `is-${row.state.status}` : ''}`}
      data-connector-id={row.id}
      data-status={row.state.status}
      onClick={(event) => {
        // The whole card opens the detail with the mouse; the buttons inside do it for the keyboard.
        if ((event.target as HTMLElement).closest('button')) return
        onOpen(row, event.currentTarget.querySelector<HTMLElement>('.cnx-card-title'))
      }}
    >
      <div className="cnx-card-top">
        <ConnectorIcon row={row} />
        <div className="cnx-card-heading">
          <button type="button" className="cnx-card-title" onClick={(event) => onOpen(row, event.currentTarget)} title={row.name}>
            {row.name}
          </button>
          <div className="cnx-badges">
            {badges.map((badge) => (
              <span key={badge.label} className={`cnx-pill tone-${badge.tone}`} title={badge.title}>
                {badge.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="cnx-card-desc">{row.description || 'Sem descrição.'}</p>
      <div className="cnx-card-foot">
        {chip ? (
          <span className={`cnx-status tone-${row.state.status === 'connecting' ? 'busy' : chip.tone}`}>
            <span className={`cnx-dot ${row.state.status === 'connecting' ? 'pulse' : ''}`} aria-hidden="true" />
            {chip.label}
          </span>
        ) : (
          <span className="cnx-status tone-muted">{row.toolCount ? `${row.toolCount} ferramentas` : ''}</span>
        )}
        <button
          type="button"
          className={`btn small ${installed ? 'subtle' : 'ghost'} cnx-card-action`}
          disabled={busy}
          onClick={(event) => onOpen(row, event.currentTarget)}
          aria-label={`${primaryActionLabel(row)} ${row.name}`}
        >
          {installed ? <Icon name="sliders" size={12} /> : <Icon name="plus" size={12} />} {busy ? 'Aguarde…' : primaryActionLabel(row)}
        </button>
      </div>
    </article>
  )
}

export const ConnectorCard = memo(ConnectorCardBase, (prev, next) => prev.row === next.row && prev.busy === next.busy)
