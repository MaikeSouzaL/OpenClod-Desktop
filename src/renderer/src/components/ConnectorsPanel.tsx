import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ConnectInput } from '../../../shared/mcp-connectors'
import type { CapabilityReport } from '../../../shared/types'
import { Icon } from './Icons'
import { ConnectorCard } from './ConnectorCard'
import { ConnectorDetail } from './ConnectorDetail'
import { CustomConnectorDialog } from './ConnectorForms'
import { useConnectors } from '../lib/useConnectors'
import {
  categoryCounts,
  filterRows,
  isInstalled,
  matchesQuery,
  matchesStatus,
  plural,
  sentence,
  SORT_MODES,
  sortRows,
  statusChip,
  STATUS_FILTERS,
  type ConnectorRow,
  type SortMode,
  type StatusFilter
} from '../lib/connectors'
import './connectors.css'

const PAGE = 60
const COLLAPSED_CATEGORIES = 9

export interface ConnectorsSeed {
  query: string
  nonce: number
}

interface ConnectorsPanelProps {
  capabilities: CapabilityReport | null
  /** A search handed over by another screen ("Explorar conectores" in Plugins). */
  seed?: ConnectorsSeed | null
}

function Skeleton(): ReactElement {
  return (
    <div className="cnx-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="cnx-card cnx-skeleton" key={index}>
          <div className="cnx-card-top">
            <span className="cnx-mono shimmer" />
            <div className="cnx-card-heading">
              <span className="shimmer line w60" />
              <span className="shimmer line w40" />
            </div>
          </div>
          <span className="shimmer line" />
          <span className="shimmer line w80" />
        </div>
      ))}
    </div>
  )
}

export function ConnectorsPanel({ capabilities, seed }: ConnectorsPanelProps): ReactElement {
  const store = useConnectors()
  const { rows } = store
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortMode>('popular')
  const [visible, setVisible] = useState(PAGE)
  const [allCategories, setAllCategories] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  /** The connector added by hand whose configuration is being edited (its server name). */
  const [editing, setEditing] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const triggerRef = useRef<HTMLElement | null>(null)
  const deferredQuery = useDeferredValue(query)

  useEffect(() => {
    if (!seed) return
    setQuery(seed.query)
    setCategory('all')
    setStatus('all')
  }, [seed])

  useEffect(() => {
    setVisible(PAGE)
  }, [deferredQuery, category, status, sort])

  const filters = useMemo(() => ({ query: deferredQuery, category, status }), [deferredQuery, category, status])
  const filtered = useMemo(() => sortRows(filterRows(rows, filters), sort, deferredQuery), [rows, filters, sort, deferredQuery])
  const installed = useMemo(() => filtered.filter(isInstalled), [filtered])
  const available = useMemo(() => filtered.filter((row) => !isInstalled(row)), [filtered])
  const categories = useMemo(() => categoryCounts(rows, { query: deferredQuery, status }), [rows, deferredQuery, status])
  const statusCounts = useMemo(() => {
    const out: Record<StatusFilter, number> = { all: 0, connected: 0, available: 0, 'needs-login': 0 }
    for (const row of rows) {
      if ((category !== 'all' && row.category !== category) || !matchesQuery(row, deferredQuery)) continue
      for (const option of STATUS_FILTERS) if (matchesStatus(row, option.id)) out[option.id] += 1
    }
    return out
  }, [rows, category, deferredQuery])

  const totalForCategories = categories.reduce((sum, item) => sum + item.count, 0)
  const shownCategories = useMemo(() => {
    if (allCategories || categories.length <= COLLAPSED_CATEGORIES) return categories
    const head = categories.slice(0, COLLAPSED_CATEGORIES)
    const selected = categories.find((item) => item.category === category)
    return selected && !head.includes(selected) ? [...head, selected] : head
  }, [categories, allCategories, category])

  const needAttention = installed.filter((row) => row.state.status !== 'connected').length
  const selected = selectedId ? rows.find((row) => row.id === selectedId) : undefined
  useEffect(() => {
    // The connector was removed from under the detail (disconnect of a custom one): close it.
    if (selectedId && store.loaded && !selected) setSelectedId(null)
  }, [selectedId, selected, store.loaded])

  // Status changes (a login that finished in the browser, a server that dropped) are read out to screen readers.
  const previousStatus = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (!store.loaded) return
    const next = new Map(rows.filter(isInstalled).map((row) => [row.id, row.state.status]))
    const before = previousStatus.current
    previousStatus.current = next
    if (!before) return
    for (const row of rows) {
      const now = next.get(row.id)
      if (now && before.get(row.id) !== now) {
        const chip = statusChip(row.state)
        if (chip) setAnnounce(`${row.name}: ${chip.label}.`)
      } else if (!now && before.has(row.id)) {
        setAnnounce(`${row.name} desconectado.`)
      }
    }
  }, [rows, store.loaded])

  useEffect(() => {
    if (!store.loaded) return
    const timer = window.setTimeout(() => {
      setAnnounce(filtered.length ? `${plural(filtered.length, 'conector encontrado', 'conectores encontrados')}.` : 'Nenhum conector encontrado.')
    }, 500)
    return () => window.clearTimeout(timer)
  }, [filtered.length, store.loaded])

  const open = useCallback((row: ConnectorRow, trigger: HTMLElement | null) => {
    triggerRef.current = trigger
    setSelectedId(row.id)
  }, [])

  const close = useCallback(() => setSelectedId(null), [])

  const clearFilters = (): void => {
    setQuery('')
    setCategory('all')
    setStatus('all')
  }
  const filtering = Boolean(query.trim()) || category !== 'all' || status !== 'all'

  const addCustom = async (custom: NonNullable<ConnectInput['custom']>): Promise<void> => {
    const result = await store.connect('custom', { custom })
    // A first connection that could not even start leaves nothing installed (no server name): the dialog shows why.
    // A server that was saved but cannot connect (HTTP 500, wrong address) is a connector with an error: open its detail.
    if (result.state.status === 'error' && !result.state.serverName) {
      throw new Error([sentence(result.state.lastError ?? result.state.detail) || 'Não foi possível conectar.', sentence(result.state.hint)].filter(Boolean).join(' '))
    }
    setCustomOpen(false)
    triggerRef.current = null
    setSelectedId(result.state.id)
  }

  /** Saves the edit of a connector added by hand: same name, new configuration; its detail stays open under the form. */
  const saveEdit = async (custom: NonNullable<ConnectInput['custom']>): Promise<void> => {
    const result = await store.connect(editing ?? custom.name, { custom, update: true })
    setEditing(null)
    setAnnounce(`${custom.name}: configuração salva.`)
    setSelectedId(result.state.id)
  }

  const native = [
    { id: 'computer', icon: 'monitor' as const, name: 'Computer Use', on: Boolean(capabilities?.computer.available), detail: capabilities?.computer.available ? `via ${capabilities.computer.backend}` : 'indisponível' },
    { id: 'browser', icon: 'globe' as const, name: 'Navegador do agente', on: Boolean(capabilities?.browser.available), detail: capabilities?.browser.available ? `via ${capabilities.browser.engine ?? 'Playwright'}` : 'indisponível' }
  ]
  const existingNames = rows.filter((row) => row.state.serverName).map((row) => row.state.serverName as string)
  const editedServer = editing ? store.servers.find((server) => server.name === editing) : undefined
  const shownAvailable = available.slice(0, visible)
  const remaining = available.length - shownAvailable.length

  return (
    <div className="cnx" data-testid="connectors-panel">
      <div className="cnx-sr" role="status" aria-live="polite">
        {announce}
      </div>
      <p className="page-lead">
        Conecte o Openclod aos seus aplicativos e serviços. Cada ferramenta que um conector oferece passa pela política de permissões: você escolhe o que roda sozinho, o que pede aprovação e o que fica bloqueado.
      </p>

      <div className="cnx-toolbar">
        <div className="cnx-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Procurar por nome, descrição ou ferramenta"
            aria-label="Procurar conectores"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="icon-btn small" onClick={() => setQuery('')} aria-label="Limpar busca">
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>
        <label className="page-sort">
          Ordenar
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="Ordenar conectores">
            {SORT_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn subtle" onClick={() => void store.reload().catch(() => undefined)} disabled={store.reloading} title="Reinicia os conectores e lê as ferramentas de novo">
          <Icon name="refresh" size={13} /> {store.reloading ? 'Recarregando…' : 'Recarregar'}
        </button>
        <button type="button" className="btn primary" onClick={() => setCustomOpen(true)}>
          <Icon name="plus" size={13} /> Conector personalizado
        </button>
      </div>

      <div className="cnx-segmented" role="group" aria-label="Filtrar por situação">
        {STATUS_FILTERS.map((option) => (
          <button key={option.id} type="button" aria-pressed={status === option.id} className={status === option.id ? 'active' : ''} onClick={() => setStatus(option.id)}>
            {option.label}
            <span className="cnx-count">{statusCounts[option.id]}</span>
          </button>
        ))}
      </div>

      {categories.length ? (
        <div className="cnx-chips-row" role="group" aria-label="Categorias">
          <button type="button" className={`cnx-chip ${category === 'all' ? 'active' : ''}`} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
            Todas <span>{totalForCategories}</span>
          </button>
          {shownCategories.map((item) => (
            <button key={item.category} type="button" className={`cnx-chip ${category === item.category ? 'active' : ''}`} aria-pressed={category === item.category} onClick={() => setCategory(item.category)}>
              {item.label} <span>{item.count}</span>
            </button>
          ))}
          {categories.length > COLLAPSED_CATEGORIES ? (
            <button type="button" className="cnx-chip more" onClick={() => setAllCategories((current) => !current)} aria-expanded={allCategories}>
              {allCategories ? 'Mostrar menos' : `Ver todas (${categories.length})`}
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="cnx-native">
        <span>Já incluídos no Openclod:</span>
        {native.map((item) => (
          <span key={item.id} className="cnx-native-item">
            <span className="cnx-native-glyph" aria-hidden="true">
              <Icon name={item.icon} size={12} />
            </span>
            <span className={`cnx-dot ${item.on ? 'tone-ok' : 'tone-muted'}`} aria-hidden="true" /> {item.name} <em>{item.detail}</em>
          </span>
        ))}
      </p>

      {store.loadError ? (
        <div className="cnx-callout tone-bad" role="alert">
          <Icon name="alert" size={15} />
          <div>
            <strong>Não foi possível ler o diretório de conectores.</strong>
            <p>{store.loadError}</p>
            <button type="button" className="btn small subtle" onClick={store.retry}>
              <Icon name="refresh" size={12} /> Tentar de novo
            </button>
          </div>
        </div>
      ) : null}

      {!store.loaded ? (
        <Skeleton />
      ) : (
        <>
          {installed.length ? (
            <section className="cnx-block" aria-labelledby="cnx-installed-title">
              <h2 id="cnx-installed-title">
                Conectados <span className="cnx-count">{installed.length}</span>
                {needAttention ? <small>{needAttention === 1 ? '1 precisa de atenção' : `${needAttention} precisam de atenção`}</small> : null}
              </h2>
              <div className="cnx-grid" data-testid="connectors-installed">
                {installed.map((row) => (
                  <ConnectorCard key={row.id} row={row} busy={Boolean(store.busy[row.id])} onOpen={open} />
                ))}
              </div>
            </section>
          ) : null}

          {available.length ? (
            <section className="cnx-block" aria-labelledby="cnx-directory-title">
              <h2 id="cnx-directory-title">
                Diretório <span className="cnx-count" data-testid="directory-count">{available.length}</span>
              </h2>
              <div className="cnx-grid" data-testid="connectors-directory">
                {shownAvailable.map((row) => (
                  <ConnectorCard key={row.id} row={row} busy={Boolean(store.busy[row.id])} onOpen={open} />
                ))}
              </div>
              {remaining > 0 ? (
                <div className="cnx-more">
                  <button type="button" className="btn subtle" onClick={() => setVisible((current) => current + PAGE)}>
                    Mostrar mais {Math.min(PAGE, remaining)} <span className="cnx-muted">({remaining} restantes)</span>
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {!installed.length && !available.length ? (
            <div className="page-empty compact cnx-empty" data-testid="connectors-empty">
              <Icon name="plug" size={26} />
              {rows.length ? (
                <>
                  <p>
                    {query.trim() ? `Nenhum conector encontrado para “${query.trim()}”.` : status === 'needs-login' ? 'Nenhum conector precisa de login agora.' : status === 'connected' ? 'Você ainda não conectou nenhum conector.' : 'Nenhum conector corresponde aos filtros.'}
                  </p>
                  {filtering ? (
                    <button type="button" className="btn small subtle" onClick={clearFilters}>
                      Limpar filtros
                    </button>
                  ) : null}
                  {query.trim() ? (
                    <button type="button" className="btn small ghost" onClick={() => setCustomOpen(true)}>
                      <Icon name="plus" size={12} /> Adicionar um servidor MCP por endereço ou programa
                    </button>
                  ) : null}
                </>
              ) : (
                <p>O diretório está vazio. Você ainda pode adicionar um conector personalizado.</p>
              )}
            </div>
          ) : null}
        </>
      )}

      {selected ? (
        <ConnectorDetail
          key={selected.id}
          row={selected}
          store={store}
          trigger={triggerRef.current}
          onClose={close}
          onAnnounce={setAnnounce}
          onEdit={selected.custom && selected.state.serverName ? () => setEditing(selected.state.serverName ?? null) : undefined}
        />
      ) : null}
      {customOpen ? <CustomConnectorDialog existingNames={existingNames} onCancel={() => setCustomOpen(false)} onSubmit={addCustom} /> : null}
      {editing && editedServer ? (
        <CustomConnectorDialog
          key={`edit-${editing}`}
          existingNames={existingNames.filter((name) => name !== editing)}
          initial={editedServer}
          onCancel={() => setEditing(null)}
          onSubmit={saveEdit}
        />
      ) : null}
    </div>
  )
}
