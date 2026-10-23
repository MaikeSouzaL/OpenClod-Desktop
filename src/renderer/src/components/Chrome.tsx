import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { Icon, type IconName } from './Icons'

export type PanelTab = 'context' | 'plan' | 'files' | 'changes' | 'terminal' | 'browser' | 'activity' | 'captures' | 'tasks'

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

export function ForjaMark({ size = 20, className = '' }: { size?: number; className?: string }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`forja-mark ${className}`}
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 2.6v5.2M12 16.2v5.2M2.6 12h5.2M16.2 12h5.2" />
        <path d="m5.3 5.3 3.7 3.7M15 15l3.7 3.7M18.7 5.3 15 9M9 15l-3.7 3.7" />
      </g>
      <circle cx="12" cy="12" r="1.9" fill="currentColor" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

interface IconButtonProps {
  icon: IconName
  label: string
  active?: boolean
  disabled?: boolean
  size?: number
  className?: string
  onClick?(): void
}

export function IconButton({
  icon,
  label,
  active = false,
  disabled = false,
  size = 17,
  className = '',
  onClick
}: IconButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Popover menu                                                        */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  id: string
  label?: string
  icon?: IconName
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  checked?: boolean
  /** Non-interactive section label rendered above the item. */
  heading?: string
  onSelect?(): void
}

interface MenuPopoverProps {
  items: MenuItem[]
  onClose(): void
  align?: 'left' | 'right'
  className?: string
  header?: ReactNode
}

export function MenuPopover({ items, onClose, align = 'left', className = '', header }: MenuPopoverProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={ref} className={`menu-popover align-${align} ${className}`} role="menu">
      {header}
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="menu-sep" />
        ) : (
          <div key={item.id}>
            {item.heading ? <div className="menu-heading">{item.heading}</div> : null}
            <button
              type="button"
              role="menuitem"
              className={`menu-item ${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                onClose()
                item.onSelect?.()
              }}
            >
              <span className="menu-icon">{item.icon ? <Icon name={item.icon} size={15} /> : null}</span>
              <span className="menu-label">{item.label}</span>
              {item.checked ? <Icon name="check" size={13} className="menu-check" /> : null}
              {item.shortcut ? <kbd className="menu-shortcut">{item.shortcut}</kbd> : null}
            </button>
          </div>
        )
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Titlebar (navigation + session header + window controls)            */
/* ------------------------------------------------------------------ */

interface TitlebarProps {
  home: boolean
  sidebarOpen: boolean
  canBack: boolean
  canForward: boolean
  maximized: boolean
  title: string
  panelTab: PanelTab | null
  panelAvailable: boolean
  menuOpen: boolean
  titleMenuOpen: boolean
  optionsOpen: boolean
  onMenu(): void
  onToggleSidebar(): void
  onBack(): void
  onForward(): void
  onTitle(): void
  onPanel(tab: PanelTab): void
  onOptions(): void
  onMinimize(): void
  onMaximize(): void
  onClose(): void
}

const SESSION_ACTIONS: Array<{ id: PanelTab; icon: IconName; label: string }> = [
  { id: 'terminal', icon: 'terminal', label: 'Terminal' },
  { id: 'changes', icon: 'diff', label: 'Alterações' },
  { id: 'browser', icon: 'globe', label: 'Navegador' },
  { id: 'files', icon: 'folder', label: 'Arquivos' }
]

export function Titlebar({
  home,
  sidebarOpen,
  canBack,
  canForward,
  maximized,
  title,
  panelTab,
  panelAvailable,
  menuOpen,
  titleMenuOpen,
  optionsOpen,
  onMenu,
  onToggleSidebar,
  onBack,
  onForward,
  onTitle,
  onPanel,
  onOptions,
  onMinimize,
  onMaximize,
  onClose
}: TitlebarProps): ReactElement {
  return (
    <header className="titlebar">
      <div className="tb-left">
        <IconButton icon="menu" label="Menu" active={menuOpen} onClick={onMenu} />
        <IconButton
          icon="panelLeft"
          label={sidebarOpen ? 'Ocultar barra lateral' : 'Mostrar barra lateral'}
          active={sidebarOpen}
          onClick={onToggleSidebar}
        />
        <IconButton icon="arrowLeft" label="Voltar" disabled={!canBack} onClick={onBack} />
        <IconButton icon="arrowRight" label="Avançar" disabled={!canForward} onClick={onForward} />
      </div>

      <div className="tb-main">
        {home ? (
          <span className="tb-brand">
            <ForjaMark size={14} />
            <span>Forja</span>
          </span>
        ) : (
          <button
            type="button"
            className={`chat-title ${titleMenuOpen ? 'open' : ''}`}
            onClick={onTitle}
            title="Opções da sessão"
          >
            <span>{title}</span>
            <Icon name="chevronDown" size={13} />
          </button>
        )}
      </div>

      {!home ? (
        <div className="tb-actions">
          <IconButton
            icon="panelRight"
            label="Painel lateral da sessão"
            active={panelTab === 'context'}
            disabled={!panelAvailable}
            onClick={() => onPanel('context')}
          />
          {SESSION_ACTIONS.map((action) => (
            <IconButton
              key={action.id}
              icon={action.icon}
              label={action.label}
              active={panelTab === action.id}
              disabled={!panelAvailable}
              onClick={() => onPanel(action.id)}
            />
          ))}
          <IconButton icon="more" label="Ver opções" active={optionsOpen} onClick={onOptions} />
        </div>
      ) : null}

      <div className="tb-window">
        <button type="button" className="win-btn" title="Minimizar" onClick={onMinimize}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5h8" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button type="button" className="win-btn" title={maximized ? 'Restaurar' : 'Maximizar'} onClick={onMaximize}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
            {maximized ? (
              <>
                <rect x="1.5" y="3" width="5.5" height="5.5" />
                <path d="M3.5 3V1.5h5v5H7" />
              </>
            ) : (
              <rect x="1.5" y="1.5" width="7" height="7" />
            )}
          </svg>
        </button>
        <button type="button" className="win-btn close" title="Fechar" onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m1 1 8 8M9 1 1 9" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  )
}
