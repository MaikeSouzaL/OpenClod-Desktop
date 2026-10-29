import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type {
  AppSettings,
  CapabilityReport,
  ContextBreakdown,
  FileChange,
  MCPStatus,
  PermissionMode,
  SessionState
} from '../../../shared/types'
import type { GitStatusInfo, ScreenshotResult } from '../../../shared/api'
import { Icon, type IconName } from './Icons'
import { MenuPopover, type MenuItem, type PanelTab } from './Chrome'
import { TerminalPane } from './TerminalPane'
import { BrowserPane } from './BrowserPane'
import { FilesPane } from './FilesPane'
import { ChangesPane } from './ChangesPane'
import { ErrorBoundary } from './ErrorBoundary'
import { TasksPanel } from './TasksPanel'
import { PlanStepDetail } from './PlanStepDetail'
import type { ActivityState } from '../lib/activity'
import {
  MODE_LABELS,
  formatTokens,
  lastRequestTokens,
  levelLabel,
  relativeTime,
  shortPath
} from '../lib/format'
import { errorMessage, unwrap } from '../lib/api'
import type { LogEntry } from '../lib/types'
import { useConnectors, type ConnectorsStore } from '../lib/useConnectors'
import { detailPlan, isInstalled, plural, type ConnectorRow } from '../lib/connectors'
import { AUTO_COMPACT_RATIO, billableTokens } from '../../../shared/limits'
import { protectionsFor } from '../lib/protections'
import './session-protections.css'

const PLAN_ICON: Record<string, IconName> = {
  pending: 'clock',
  active: 'refresh',
  done: 'check',
  blocked: 'alert'
}

const TAB_TITLES: Record<PanelTab, string> = {
  context: 'Sessão',
  plan: 'Plano',
  files: 'Arquivos',
  changes: 'Alterações',
  terminal: 'Terminal',
  browser: 'Navegador',
  activity: 'Auditoria',
  captures: 'Capturas',
  tasks: 'Tarefas em segundo plano'
}

// Same names as the composer. Typed by every mode: the panel once had no `unrestricted` key and showed "Perguntar"
// for the mode that never asks.
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  readonly: 'Somente leitura',
  ask: 'Perguntar',
  'accept-edits': 'Aceitar edições',
  auto: 'Automático',
  unrestricted: 'Ignorar permissões'
}

export interface PanelLayout {
  side: 'left' | 'right'
  maximized: boolean
  width: number
}

export const PANEL_MIN_WIDTH = 280
export const PANEL_MAX_WIDTH = 1400

interface SessionPanelProps {
  session: SessionState | null
  changes: FileChange[]
  logs: LogEntry[]
  capabilities: CapabilityReport | null
  settings: AppSettings | null
  tab: PanelTab | null
  /** Plan step selected from the dock; the plan tab opens focused on it. */
  planFocus: string | null
  onPlanFocus(itemId: string | null): void
  /** Work the agent is doing (commands, other agents) for the tasks tab. */
  work: ActivityState
  onWorkChange(next: ActivityState): void
  onStopTurn(): void
  layout: PanelLayout
  onLayout(layout: PanelLayout): void
  onClose(): void
  onClearLogs(): void
  onTab(tab: PanelTab): void
  onCompact(): Promise<void>
  onReveal(path: string): void
  /** Opens Personalização → Conectores (a connector that needs a credential is fixed there). */
  onOpenConnectors(): void
}

/** Panes with live state (pty, webview, open editors) stay mounted once visited. */
const PERSISTENT: PanelTab[] = ['terminal', 'browser', 'files']

export function SessionPanel({
  session,
  changes,
  logs,
  capabilities,
  settings,
  tab,
  planFocus,
  onPlanFocus,
  work,
  onWorkChange,
  onStopTurn,
  layout,
  onLayout,
  onClose,
  onClearLogs,
  onTab,
  onCompact,
  onReveal,
  onOpenConnectors
}: SessionPanelProps): ReactElement | null {
  const [visited, setVisited] = useState<PanelTab[]>([])
  const [layoutMenu, setLayoutMenu] = useState(false)
  const sessionId = session?.meta.id

  useEffect(() => {
    setVisited([])
  }, [sessionId])

  useEffect(() => {
    if (tab && PERSISTENT.includes(tab)) setVisited((list) => (list.includes(tab) ? list : [...list, tab]))
  }, [tab, sessionId])

  if (!session) return null
  const open = tab !== null

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (layout.maximized) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = layout.width
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      const delta = layout.side === 'right' ? startX - moveEvent.clientX : moveEvent.clientX - startX
      const width = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, startWidth + delta))
      onLayout({ ...layout, width })
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const layoutItems: MenuItem[] = [
    {
      id: 'max',
      label: layout.maximized ? 'Restaurar tamanho' : 'Maximizar painel',
      icon: layout.maximized ? 'minus' : 'square',
      onSelect: () => onLayout({ ...layout, maximized: !layout.maximized })
    },
    { id: 'sep', separator: true },
    { id: 'left', heading: 'Mover', label: 'Para a esquerda', icon: 'panelLeft', checked: layout.side === 'left', onSelect: () => onLayout({ ...layout, side: 'left' }) },
    { id: 'right', label: 'Para a direita', icon: 'panelRight', checked: layout.side === 'right', onSelect: () => onLayout({ ...layout, side: 'right' }) },
    { id: 'sep2', separator: true },
    { id: 'tasks', label: 'Tarefas em segundo plano', icon: 'logs', checked: tab === 'tasks', onSelect: () => onTab('tasks') },
    { id: 'activity', label: 'Auditoria', icon: 'shield', checked: tab === 'activity', onSelect: () => onTab('activity') },
    { id: 'captures', label: 'Capturas de tela', icon: 'camera', checked: tab === 'captures', onSelect: () => onTab('captures') },
    { id: 'plan', label: 'Plano', icon: 'list', checked: tab === 'plan', onSelect: () => onTab('plan') }
  ]

  return (
    <aside
      className={`panel side-${layout.side} ${layout.maximized ? 'maximized' : ''} ${open ? '' : 'is-hidden'} tab-${tab ?? 'none'}`}
      style={layout.maximized ? undefined : { width: layout.width, flexBasis: layout.width }}
      aria-label="Painel lateral da sessão"
      aria-hidden={!open}
    >
      {!layout.maximized ? <div className="panel-resizer" onPointerDown={startResize} title="Arraste para redimensionar" /> : null}
      <header className="panel-head">
        <h2>{tab ? TAB_TITLES[tab] : ''}</h2>
        <span className="panel-head-actions">
          {tab === 'context' ? (
            <button type="button" className="icon-btn small" onClick={() => onTab('changes')} title="Alterações">
              <Icon name="diff" size={14} />
            </button>
          ) : null}
          <span className="inline-anchor">
            <button type="button" className={`icon-btn small ${layoutMenu ? 'is-active' : ''}`} onClick={() => setLayoutMenu((value) => !value)} title="Layout do painel">
              <Icon name="more" size={14} />
            </button>
            {layoutMenu ? <MenuPopover items={layoutItems} align="right" onClose={() => setLayoutMenu(false)} /> : null}
          </span>
          <button
            type="button"
            className="icon-btn small"
            onClick={() => onLayout({ ...layout, maximized: !layout.maximized })}
            title={layout.maximized ? 'Restaurar' : 'Maximizar'}
          >
            <Icon name={layout.maximized ? 'minus' : 'square'} size={13} />
          </button>
          <button type="button" className="icon-btn" onClick={onClose} title="Fechar painel">
            <Icon name="x" size={15} />
          </button>
        </span>
      </header>

      <div className={`panel-body ${tab && PERSISTENT.includes(tab) ? 'flush' : ''} ${tab === 'changes' ? 'flush' : ''}`}>
        <ErrorBoundary label="este painel" resetKey={`${session.meta.id}:${tab ?? ''}`}>
        {tab === 'context' ? (
          <ContextPane
            session={session}
            changes={changes}
            capabilities={capabilities}
            settings={settings}
            onTab={onTab}
            onCompact={onCompact}
            onReveal={onReveal}
            onOpenConnectors={onOpenConnectors}
          />
        ) : null}
        {tab === 'plan' ? (
          <PlanPane
            session={session}
            activity={work}
            focusId={planFocus}
            onFocus={onPlanFocus}
            running={['thinking', 'streaming', 'tool', 'waiting_approval'].includes(session.state)}
          />
        ) : null}
        {tab === 'changes' ? <ChangesPane sessionId={session.meta.id} root={session.meta.cwd} changes={changes} onReveal={onReveal} /> : null}
        {tab === 'tasks' ? <TasksPanel sessionId={session.meta.id} activity={work} onClear={onWorkChange} onStopTurn={onStopTurn} /> : null}
        {tab === 'activity' ? <ActivityPane logs={logs} onClear={onClearLogs} /> : null}
        {tab === 'captures' ? <CapturesPane /> : null}
        </ErrorBoundary>
        {visited.includes('terminal') ? (
          <div className={`pane-keep ${tab === 'terminal' ? '' : 'is-hidden'}`}>
            <ErrorBoundary label="o terminal" resetKey={session.meta.id}>
              <TerminalPane key={session.meta.id} sessionId={session.meta.id} cwd={session.meta.cwd} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visited.includes('browser') ? (
          <div className={`pane-keep ${tab === 'browser' ? '' : 'is-hidden'}`}>
            <ErrorBoundary label="o navegador" resetKey={session.meta.id}>
              <BrowserPane key={session.meta.id} sessionId={session.meta.id} root={session.meta.cwd} active={tab === 'browser'} />
            </ErrorBoundary>
          </div>
        ) : null}
        {visited.includes('files') ? (
          <div className={`pane-keep ${tab === 'files' ? '' : 'is-hidden'}`}>
            <ErrorBoundary label="os arquivos" resetKey={session.meta.id}>
              <FilesPane key={session.meta.id} root={session.meta.cwd} active={tab === 'files'} onReveal={onReveal} />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function contextBreakdown(session: SessionState): Array<{ id: string; label: string; tokens: number }> {
  let messages = 0
  let tools = 0
  let calls = 0
  let images = 0
  for (const message of session.messages) {
    if (message.hidden) continue
    for (const part of message.parts) {
      if (part.type === 'text') messages += approxTokens(part.text)
      else if (part.type === 'tool_result') tools += approxTokens(part.text)
      else if (part.type === 'tool_call') calls += approxTokens(JSON.stringify(part.args ?? {}))
      else if (part.type === 'image') images += 850
    }
  }
  return [
    { id: 'messages', label: 'Mensagens', tokens: messages },
    { id: 'images', label: 'Imagens', tokens: images },
    { id: 'tools', label: 'Ferramentas', tokens: tools },
    { id: 'mcp', label: 'Chamadas', tokens: calls },
    { id: 'system', label: 'Instruções do sistema', tokens: 1100 },
    { id: 'skills', label: 'Skills', tokens: 320 },
    { id: 'plan', label: 'Plano', tokens: approxTokens(JSON.stringify(session.plan)) }
  ]
}

/** Connectors listed before "Mostrar mais"; the ones that need attention always come first. */
const VISIBLE_CONNECTORS = 5

/** Problems first, as in Claude Code's panel: a connector that needs a login or failed is the one the user acts on. */
const CONNECTOR_RANK: Record<string, number> = { 'needs-auth': 0, error: 1, connecting: 2, connected: 3, disabled: 4 }

interface ConnectorAction {
  label: 'Autenticar' | 'Reconectar'
  run(): Promise<unknown> | void
}

/**
 * The button of a connector row, with the decision the connector detail makes (detailPlan): a login or a reconnect one click
 * can do goes straight to `connect`; one that needs a credential typed again opens Personalização → Conectores; a server
 * added by hand cannot be rebuilt from the directory, so reconnecting it restarts the MCP servers.
 */
function connectorAction(row: ConnectorRow, store: ConnectorsStore, openConnectors: () => void): ConnectorAction | null {
  const status = row.state.status
  if (status !== 'needs-auth' && status !== 'error') return null
  const label = status === 'needs-auth' ? 'Autenticar' : 'Reconectar'
  if (row.custom) return status === 'error' ? { label, run: () => store.reload() } : { label, run: openConnectors }
  return detailPlan(row, Boolean(store.authUrls[row.id])).oneClick ? { label, run: () => store.connect(row.id) } : { label, run: openConnectors }
}

/** What a healthy connector says on the right: tools, resources and prompts (live counts when the server reports them). */
function connectorSummary(row: ConnectorRow, live: MCPStatus | undefined): string {
  const status = row.state.status
  if (status === 'connecting') return 'Conectando…'
  if (status === 'disabled') return 'Desativado'
  const tools = live?.tools.length ?? row.state.toolCount ?? 0
  const parts = [tools ? plural(tools, 'ferramenta', 'ferramentas') : 'Conectado']
  if (live?.resources.length) parts.push(plural(live.resources.length, 'recurso', 'recursos'))
  if (live?.prompts.length) parts.push(plural(live.prompts.length, 'prompt', 'prompts'))
  return parts.join(' · ')
}

function ContextPane({
  session,
  changes,
  capabilities,
  settings,
  onTab,
  onCompact,
  onReveal,
  onOpenConnectors
}: {
  session: SessionState
  changes: FileChange[]
  capabilities: CapabilityReport | null
  settings: AppSettings | null
  onTab(tab: PanelTab): void
  onCompact(): Promise<void>
  onReveal(path: string): void
  onOpenConnectors(): void
}): ReactElement {
  const [compacting, setCompacting] = useState(false)
  const [compactNote, setCompactNote] = useState('')
  // What the next request really carries, measured by the session's runner. A session that had no turn since the app
  // opened has no runner, so the pane shows its own rough estimate and says so.
  const [measured, setMeasured] = useState<ContextBreakdown | null>(null)
  useEffect(() => {
    let current = true
    void window.openclod.sessions
      .contextBreakdown(session.meta.id)
      .then((result) => {
        if (current) setMeasured(result.ok ? result.value : null)
      })
      .catch(() => {
        if (current) setMeasured(null)
      })
    return () => {
      current = false
    }
  }, [session.meta.id, session.messages.length, session.state, session.meta.model])
  // Same states and actions as Personalização → Conectores (login, reconnect, polling while a login is open).
  const connectors = useConnectors()
  const [showAllConnectors, setShowAllConnectors] = useState(false)
  const [connectorNote, setConnectorNote] = useState('')
  // Branch and working-tree diff, read again when the agent changes files or a turn ends.
  const [git, setGit] = useState<GitStatusInfo | null>(null)
  useEffect(() => {
    let current = true
    void window.openclod.git
      .status(session.meta.cwd)
      .then((result) => {
        if (current) setGit(result.ok && result.value.isRepo ? result.value : null)
      })
      .catch(() => {
        if (current) setGit(null)
      })
    return () => {
      current = false
    }
  }, [session.meta.cwd, changes.length, session.state])
  const done = session.plan.filter((item) => item.status === 'done').length
  const provider = settings?.providers.find((item) => item.id === session.meta.providerId)
  const contextWindow = provider?.contextWindow ?? 0
  const breakdown = measured?.items ?? contextBreakdown(session)
  const estimated = breakdown.reduce((total, row) => total + row.tokens, 0)
  const used = Math.max(lastRequestTokens(session), estimated)
  const ratio = contextWindow ? Math.min(100, Math.round((used / contextWindow) * 100)) : 0
  const mcp = capabilities?.mcp ?? []
  const busy = ['thinking', 'streaming', 'tool', 'waiting_approval'].includes(session.state)
  const sessionTokens = billableTokens(session.usage)
  // The runner compacts on its own at AUTO_COMPACT_RATIO of the window: what is above it is the reserve the summary needs
  // (the buffer), what is between the request and it is the room left. Shares are of the window, so the rows add up to 100%.
  const autoCompactAt = contextWindow * AUTO_COMPACT_RATIO
  const buffer = contextWindow ? contextWindow - autoCompactAt : 0
  const free = contextWindow ? Math.max(0, autoCompactAt - used) : 0
  const share = (tokens: number): number => {
    const base = contextWindow || used
    return base ? Math.round((tokens / base) * 1000) / 10 : 0
  }
  const width = (tokens: number): string => `${contextWindow ? (tokens / contextWindow) * 100 : used ? (tokens / used) * 100 : 0}%`

  const mcpByName = new Map(mcp.map((server) => [server.name, server]))
  const installedConnectors = connectors.rows
    .filter(isInstalled)
    .sort((a, b) => (CONNECTOR_RANK[a.state.status] ?? 9) - (CONNECTOR_RANK[b.state.status] ?? 9) || a.name.localeCompare(b.name, 'pt-BR'))
  const shownConnectors = showAllConnectors ? installedConnectors : installedConnectors.slice(0, VISIBLE_CONNECTORS)
  const runConnectorAction = async (row: ConnectorRow, action: ConnectorAction): Promise<void> => {
    setConnectorNote('')
    try {
      await action.run()
    } catch (err) {
      setConnectorNote(`${row.name}: ${errorMessage(err)}`)
    }
  }

  const gitAdded = git ? git.files.reduce((sum, file) => sum + (file.additions ?? 0), 0) : 0
  const gitRemoved = git ? git.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : 0
  const tracking = git
    ? [git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : ''].filter(Boolean).join(' ') || (git.upstream ? 'em dia' : 'sem upstream')
    : ''

  const compact = async (): Promise<void> => {
    setCompacting(true)
    setCompactNote('')
    try {
      await onCompact()
      setCompactNote('Contexto compactado.')
    } catch (err) {
      setCompactNote(errorMessage(err))
    } finally {
      setCompacting(false)
      setTimeout(() => setCompactNote(''), 4000)
    }
  }

  return (
    <div className="panel-stack">
      <section className="panel-card">
        <div className="panel-card-head">
          <Icon name="folder" size={14} />
          <span>Ambiente</span>
          <button type="button" className="panel-card-action" title="Abrir pasta no Explorer" onClick={() => onReveal(session.meta.cwd)}>
            <Icon name="external" size={12} />
          </button>
        </div>
        <div className="env-list">
          <button type="button" className="env-row" onClick={() => onReveal(session.meta.cwd)} title={session.meta.cwd}>
            <Icon name="folder" size={13} />
            <span>{session.meta.cwd.split(/[\\/]/).pop() || session.meta.cwd}</span>
            <em>{shortPath(session.meta.cwd, 24)}</em>
          </button>
          {git?.branch ? (
            <div className="env-row" title={git.upstream ? `${git.branch} → ${git.upstream}` : `${git.branch} (sem upstream)`}>
              <Icon name="gitBranch" size={13} />
              <span>{git.branch}</span>
              <em>{tracking}</em>
            </div>
          ) : null}
          <div className="env-row">
            <Icon name="code" size={13} />
            <span>{MODE_LABELS[session.meta.mode]}</span>
            <em>{PERMISSION_LABELS[settings?.policy.mode ?? 'ask']}</em>
          </div>
          <div className="env-row">
            <Icon name="cpu" size={13} />
            <span>{provider?.label ?? session.meta.providerId}</span>
            <em title={session.meta.model}>{session.meta.model}</em>
          </div>
          <div className="env-row" title="Tokens de entrada não cacheados + saída acumulados nesta sessão">
            <Icon name="gauge" size={13} />
            <span>Consumo</span>
            <em
              title={`${formatTokens(session.usage?.input ?? 0)} entrada · ${formatTokens(session.usage?.cachedInput ?? 0)} cache · ${formatTokens(session.usage?.output ?? 0)} saída`}
            >
              {formatTokens(sessionTokens)} tokens
              {session.usage?.costUsd ? ` · US$ ${session.usage.costUsd.toFixed(2)}` : ''}
            </em>
          </div>
          <div className="env-row">
            <Icon name="clock" size={13} />
            <span>Início</span>
            <em>{new Date(session.meta.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</em>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-head">
          <Icon name="gauge" size={14} />
          <span>Contexto</span>
        </div>
        <div className="context-top">
          <strong>{ratio}% usado</strong>
          <span>
            {formatTokens(used)} / {contextWindow ? formatTokens(contextWindow) : '—'}
          </span>
        </div>
        <div className="context-bar" title={measured ? `${formatTokens(used)} tokens (medido no prompt, nas ferramentas e no histórico)` : `${formatTokens(used)} tokens estimados`}>
          {/* Widths are of the context window, not of the used total: an 8%-used session fills 8% of the track. */}
          {breakdown.map((row) =>
            share(row.tokens) > 0.2 ? <span key={row.id} className={`seg seg-${row.id}`} style={{ width: width(row.tokens) }} /> : null
          )}
          {free ? <span className="seg seg-free" style={{ width: width(free) }} /> : null}
          {buffer ? <span className="seg seg-buffer" style={{ width: width(buffer) }} title="Reserva acima do auto-compact" /> : null}
        </div>
        <ul className="context-rows">
          {breakdown.map((row) => (
            <li key={row.id}>
              <span className={`seg-chip seg-${row.id}`} />
              <span className="ctx-label">{row.label}</span>
              <span className="ctx-tokens">{formatTokens(row.tokens)}</span>
              <span className="ctx-pct">{share(row.tokens)}%</span>
            </li>
          ))}
          {contextWindow ? (
            <>
              <li title={`O histórico é compactado sozinho quando o pedido passa de ${Math.round(AUTO_COMPACT_RATIO * 100)}% da janela`}>
                <span className="seg-chip seg-buffer" />
                <span className="ctx-label">Buffer de auto-compact</span>
                <span className="ctx-tokens">{formatTokens(buffer)}</span>
                <span className="ctx-pct">{share(buffer)}%</span>
              </li>
              <li>
                <span className="seg-chip seg-free" />
                <span className="ctx-label">Espaço livre</span>
                <span className="ctx-tokens">{formatTokens(free)}</span>
                <span className="ctx-pct">{share(free)}%</span>
              </li>
            </>
          ) : null}
        </ul>
        {mcp.length ? (
          <div className="context-counts">
            <span>Ferramentas MCP</span>
            <em>{mcp.reduce((sum, server) => sum + server.tools.length, 0)}</em>
          </div>
        ) : null}
        <div className="context-foot">
          <span>
            {!contextWindow
              ? 'janela do modelo desconhecida'
              : used >= autoCompactAt
                ? 'auto-compact no próximo pedido'
                : `${formatTokens(free)} até o auto-compact`}
            {measured ? '' : ' · estimativa (ainda sem turno nesta sessão)'}
          </span>
          <button type="button" className="btn tiny" onClick={() => void compact()} disabled={compacting || busy}>
            {compacting ? 'Compactando…' : 'Compactar sessão'}
          </button>
        </div>
        {compactNote ? <div className="panel-note">{compactNote}</div> : null}
      </section>

      <section className="panel-card">
        <div className="panel-card-head">
          <Icon name="plug" size={14} />
          <span>Conectores</span>
          <button type="button" className="panel-card-action" title="Gerenciar conectores" onClick={onOpenConnectors}>
            <Icon name="external" size={12} />
          </button>
        </div>
        <ul className="connector-list">
          <li>
            <span className={`dot ${capabilities?.computer.available ? 'on' : 'off'}`} />
            <span>Computer Use</span>
            <em>{capabilities?.computer.available ? capabilities.computer.backend : 'indisponível'}</em>
          </li>
          <li>
            <span className={`dot ${capabilities?.browser.available ? 'on' : 'off'}`} />
            <span>Navegador</span>
            <em>{capabilities?.browser.available ? capabilities.browser.engine ?? 'pronto' : 'indisponível'}</em>
          </li>
          {connectors.loaded && installedConnectors.length ? (
            shownConnectors.map((row) => {
              const action = connectorAction(row, connectors, onOpenConnectors)
              const status = row.state.status
              const working = Boolean(connectors.busy[row.id]) || (row.custom && connectors.reloading)
              return (
                <li key={row.id} title={row.state.lastError ?? row.state.hint ?? row.state.detail ?? row.name}>
                  <span className={`dot ${status === 'connected' ? 'on' : status === 'needs-auth' || status === 'connecting' ? 'idle' : 'off'}`} />
                  <span>{row.name}</span>
                  {action ? (
                    <button type="button" className="connector-action" disabled={working} onClick={() => void runConnectorAction(row, action)}>
                      {working ? 'Aguarde…' : action.label}
                    </button>
                  ) : (
                    <em>{connectorSummary(row, mcpByName.get(row.state.serverName ?? row.name))}</em>
                  )}
                </li>
              )
            })
          ) : mcp.length ? (
            // Until the connector states arrive, the live MCP list keeps the card informative.
            mcp.map((server) => (
              <li key={server.name} title={server.error ?? server.name}>
                <span className={`dot ${server.state === 'ready' ? 'on' : server.state === 'error' ? 'off' : 'idle'}`} />
                <span>{server.name}</span>
                <em>{server.state === 'ready' ? (server.tools.length ? plural(server.tools.length, 'ferramenta', 'ferramentas') : 'pronto') : server.state}</em>
              </li>
            ))
          ) : (
            <li>
              <span className="dot idle" />
              <span>MCP</span>
              <em>nenhum servidor</em>
            </li>
          )}
        </ul>
        {installedConnectors.length > VISIBLE_CONNECTORS ? (
          <button type="button" className="connector-more" onClick={() => setShowAllConnectors((value) => !value)}>
            <Icon name={showAllConnectors ? 'chevronDown' : 'chevronRight'} size={12} />
            {showAllConnectors ? 'Mostrar menos' : `Mostrar mais (${installedConnectors.length - VISIBLE_CONNECTORS})`}
          </button>
        ) : null}
        {connectorNote ? <div className="panel-note">{connectorNote}</div> : null}
      </section>

      <section className="panel-card">
        <div className="panel-card-head">
          <Icon name="diff" size={14} />
          <span>Alterações</span>
        </div>
        {git?.files.length ? (
          <button type="button" className="diff-total" onClick={() => onTab('changes')} title="Diferença da árvore de trabalho do git (o que ainda não foi commitado)">
            <em className="plus">+{gitAdded.toLocaleString('pt-BR')}</em>
            <em className="minus">−{gitRemoved.toLocaleString('pt-BR')}</em>
            <span>{plural(git.files.length, 'arquivo', 'arquivos')}</span>
          </button>
        ) : null}
        {changes.length ? (
          <ul className="output-list">
            {changes.slice(0, 5).map((change) => (
              <li key={change.path}>
                <button type="button" onClick={() => onTab('changes')} title={change.path}>
                  <Icon name="fileCode" size={13} />
                  <span>{change.path.split(/[\\/]/).pop()}</span>
                  <em className="plus">+{change.additions}</em>
                  <em className="minus">-{change.deletions}</em>
                </button>
              </li>
            ))}
          </ul>
        ) : git?.files.length ? null : (
          <p className="panel-muted">Arquivos criados ou alterados aparecem aqui.</p>
        )}
        <div className="context-foot">
          <span>{session.plan.length ? `${done}/${session.plan.length} do plano` : 'sem plano ativo'}</span>
          <button type="button" className="btn tiny" onClick={() => onTab('changes')} disabled={!changes.length && !git?.files.length}>
            Ver alterações
          </button>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-head">
          <Icon name="shield" size={14} />
          <span>Proteções</span>
        </div>
        {settings?.policy.mode === 'unrestricted' ? (
          <p className="shield-warning">
            <Icon name="alert" size={12} /> Ignorar permissões: o harness não bloqueia nem pede confirmação.
          </p>
        ) : null}
        <ul className="shield-list">
          {protectionsFor(settings?.policy).map((item) => (
            <li key={item.text} className={item.on ? undefined : 'is-off'}>
              <Icon name={item.on ? 'check' : 'alert'} size={12} /> {item.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

function PlanPane({
  session,
  activity,
  focusId,
  onFocus,
  running
}: {
  session: SessionState
  activity: ActivityState
  focusId: string | null
  onFocus(itemId: string | null): void
  running: boolean
}): ReactElement {
  if (!session.plan.length) {
    return (
      <div className="panel-empty">
        <Icon name="list" size={22} />
        <p>Nenhum plano registrado. Em tarefas com vários passos o agente usa <code>update_plan</code>.</p>
      </div>
    )
  }
  const selected =
    session.plan.find((item) => item.id === focusId) ??
    session.plan.find((item) => item.status === 'active') ??
    session.plan[0]

  return (
    <div className="plan-pane">
      <ol className="plan-list">
        {session.plan.map((item) => {
          const saved = item.activity?.length ?? 0
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`plan-item status-${item.status} ${item.id === selected.id ? 'is-selected' : ''} ${item.interrupted ? 'is-interrupted' : ''}`}
                onClick={() => onFocus(item.id)}
                aria-pressed={item.id === selected.id}
              >
                <span className={`plan-icon ${item.status === 'active' && running && !item.interrupted ? 'spin' : ''}`}>
                  <Icon name={item.interrupted ? 'alert' : (PLAN_ICON[item.status] ?? 'clock')} size={14} />
                </span>
                <span className="plan-item-body">
                  <span className="plan-item-text">{item.text}</span>
                  <span className="plan-item-meta">
                    {item.interrupted ? 'interrompido' : item.status}
                    {saved ? ` · ${saved} ação${saved > 1 ? 'ões' : ''}` : ''}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <PlanStepDetail item={selected} live={activity} running={running} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Activity (audit log)                                                */
/* ------------------------------------------------------------------ */

function ActivityPane({ logs, onClear }: { logs: LogEntry[]; onClear(): void }): ReactElement {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...logs].reverse()
    return q ? list.filter((entry) => entry.text.toLowerCase().includes(q)) : list
  }, [logs, query])

  return (
    <div className="logs-pane">
      <div className="pane-toolbar">
        <span className="pane-path">{logs.length} evento(s)</span>
        <button type="button" className="icon-btn small" onClick={onClear} title="Limpar">
          <Icon name="trash" size={13} />
        </button>
      </div>
      <div className="panel-search">
        <Icon name="search" size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar eventos" spellCheck={false} />
      </div>
      {!logs.length ? (
        <div className="panel-empty">
          <Icon name="shield" size={22} />
          <p>Decisões de permissão, bloqueios, avisos e uso de ferramentas aparecem aqui.</p>
        </div>
      ) : null}
      <div className="log-list">
        {filtered.map((entry) => (
          <div key={entry.id} className={`log-entry level-${entry.level}`}>
            <span className="log-time">{new Date(entry.ts).toLocaleTimeString('pt-BR')}</span>
            <span className="log-level">{levelLabel(entry.level)}</span>
            <span className="log-text">{entry.text}</span>
          </div>
        ))}
      </div>
      {logs.length && !filtered.length ? <div className="muted pad">Nenhum evento corresponde ao filtro.</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Captures                                                            */
/* ------------------------------------------------------------------ */

function CapturesPane(): ReactElement {
  const [shot, setShot] = useState<(ScreenshotResult & { at: number }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const capture = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await unwrap(window.openclod.files.screenshot())
      setShot({ ...result, at: Date.now() })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screens-pane">
      <div className="pane-toolbar">
        <span className="pane-path">Tela real do Windows</span>
        <button type="button" className="btn small primary" onClick={() => void capture()} disabled={loading}>
          <Icon name="camera" size={13} /> {loading ? 'Capturando…' : 'Capturar'}
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {shot ? (
        <div className="shot-wrap">
          <img src={`data:image/png;base64,${shot.image}`} alt="captura da tela" />
          <div className="shot-meta">
            {shot.width}×{shot.height} · {new Date(shot.at).toLocaleTimeString('pt-BR')} · {relativeTime(shot.at)}
          </div>
        </div>
      ) : (
        <div className="panel-empty">
          <Icon name="camera" size={22} />
          <p>Capture para conferir visualmente o estado do desktop. A imagem é reduzida antes de ir para o modelo.</p>
        </div>
      )}
    </div>
  )
}
