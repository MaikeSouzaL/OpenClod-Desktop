import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConnectResult,
  ConnectorState,
  ConnectorTool,
  DirectoryConnector,
  ToolPolicy
} from '../../../shared/mcp-connectors'
import type { McpServerSettings } from '../../../shared/types'
import { unwrap } from './api'
import { buildRows, redirectUriOf, stabilizeRows, type ConnectInputWithApp, type ConnectorRow } from './connectors'

export interface ConnectorsStore {
  /** The directory has been read (or failed). Cards can already be drawn from `rows` before the first state arrives. */
  loaded: boolean
  loadError: string
  rows: ConnectorRow[]
  /** The configured servers with every credential masked (`maskedMcpSettings`): what the edit form starts from. */
  servers: McpServerSettings[]
  /** Login links of connectors waiting for the user (kept so "Abrir de novo" works). */
  authUrls: Record<string, string>
  /** The exact OAuth return URL reported by the main process (when it does), per connector. */
  redirectUris: Record<string, string>
  /** Ids with an action in flight. */
  busy: Record<string, 'connect' | 'disconnect'>
  reloading: boolean
  /** Reads the directory again after a failure. */
  retry(): void
  refresh(): Promise<void>
  connect(id: string, input?: ConnectInputWithApp): Promise<ConnectResult>
  disconnect(id: string): Promise<void>
  reload(): Promise<void>
  loadTools(serverName: string): Promise<ConnectorTool[]>
  setPolicy(serverName: string, tool: string, policy: ToolPolicy): Promise<ConnectorTool[]>
}

/** How often the states are re-read while a login or a connection is in progress (the main process also sends an event). */
const POLL_MS = 1500

/**
 * Directory + live states of the connectors. The directory (about 900 entries) is read once, after the first paint;
 * the states are cheap and are read again on every `settings_changed` event of scope `mcp` and, while something is
 * connecting, every 1.5 s.
 */
export function useConnectors(): ConnectorsStore {
  const [entries, setEntries] = useState<DirectoryConnector[]>([])
  const [states, setStates] = useState<ConnectorState[]>([])
  const [servers, setServers] = useState<McpServerSettings[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [authUrls, setAuthUrls] = useState<Record<string, string>>({})
  const [redirectUris, setRedirectUris] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, 'connect' | 'disconnect'>>({})
  const [reloading, setReloading] = useState(false)
  const alive = useRef(true)
  const sequence = useRef(0)

  const readStates = useCallback(async (): Promise<void> => {
    const ticket = ++sequence.current
    const [nextStates, nextServers] = await Promise.all([
      unwrap(window.forja.app.connectorStates()),
      // Masked: only used to describe the servers the user added by hand.
      unwrap(window.forja.app.maskedMcpSettings()).catch(() => null)
    ])
    if (!alive.current || ticket !== sequence.current) return
    setStates(nextStates)
    if (nextServers) setServers(nextServers)
    // A login that ended (connected, failed, cancelled) no longer needs its link.
    setAuthUrls((current) => {
      const waiting = new Set(nextStates.filter((state) => state.status === 'connecting').map((state) => state.id))
      const keep = Object.entries(current).filter(([id]) => waiting.has(id))
      return keep.length === Object.keys(current).length ? current : Object.fromEntries(keep)
    })
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      await readStates()
    } catch {
      // The next event or poll tries again; a transient failure must not blank the screen.
    }
  }, [readStates])

  const loadDirectory = useCallback(async (): Promise<void> => {
    setLoadError('')
    try {
      const directory = await unwrap(window.forja.app.connectorDirectory())
      if (!alive.current) return
      setEntries(Array.isArray(directory.entries) ? directory.entries : [])
      await readStates()
    } catch (err) {
      if (alive.current) setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setLoaded(true)
    }
  }, [readStates])

  useEffect(() => {
    alive.current = true
    // After the first paint, so the page opens at once even with the whole directory to read.
    const timer = window.setTimeout(() => void loadDirectory(), 0)
    return () => {
      alive.current = false
      window.clearTimeout(timer)
    }
  }, [loadDirectory])

  const retry = useCallback((): void => {
    setLoaded(false)
    void loadDirectory()
  }, [loadDirectory])

  // `settings_changed` (scope mcp): login finished, a server dropped, a policy saved from elsewhere.
  useEffect(() => {
    let pending: number | undefined
    const off = window.forja.events.on((event) => {
      if (event.type !== 'settings_changed' || event.scope !== 'mcp') return
      window.clearTimeout(pending)
      pending = window.setTimeout(() => void refresh(), 120)
    })
    return () => {
      window.clearTimeout(pending)
      off()
    }
  }, [refresh])

  const anyConnecting = useMemo(() => states.some((state) => state.status === 'connecting'), [states])
  useEffect(() => {
    if (!anyConnecting) return
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [anyConnecting, refresh])

  const previousRows = useRef<ConnectorRow[]>([])
  const rows = useMemo(() => {
    const next = stabilizeRows(previousRows.current, buildRows(entries, states, servers))
    previousRows.current = next
    return next
  }, [entries, states, servers])

  const withBusy = useCallback(async <T,>(id: string, action: 'connect' | 'disconnect', run: () => Promise<T>): Promise<T> => {
    setBusy((current) => ({ ...current, [id]: action }))
    try {
      return await run()
    } finally {
      if (alive.current) {
        setBusy((current) => {
          const next = { ...current }
          delete next[id]
          return next
        })
      }
    }
  }, [])

  const connect = useCallback(
    (id: string, input?: ConnectInputWithApp): Promise<ConnectResult> =>
      withBusy(id, 'connect', async () => {
        const result = await unwrap(window.forja.app.connectConnector(id, input))
        if (result.authUrl) setAuthUrls((current) => ({ ...current, [result.state.id]: result.authUrl! }))
        const redirect = redirectUriOf(result) ?? redirectUriOf(result.state)
        if (redirect) setRedirectUris((current) => ({ ...current, [result.state.id]: redirect }))
        await refresh()
        return result
      }),
    [refresh, withBusy]
  )

  const disconnect = useCallback(
    (id: string): Promise<void> =>
      withBusy(id, 'disconnect', async () => {
        await unwrap(window.forja.app.disconnectConnector(id))
        setAuthUrls((current) => {
          const next = { ...current }
          delete next[id]
          return next
        })
        setRedirectUris((current) => {
          const next = { ...current }
          delete next[id]
          return next
        })
        await refresh()
      }),
    [refresh, withBusy]
  )

  const reload = useCallback(async (): Promise<void> => {
    setReloading(true)
    try {
      const next = await unwrap(window.forja.app.reloadMcp())
      if (alive.current) setStates(next)
      await refresh()
    } finally {
      if (alive.current) setReloading(false)
    }
  }, [refresh])

  const loadTools = useCallback((serverName: string): Promise<ConnectorTool[]> => unwrap(window.forja.app.connectorTools(serverName)), [])
  const setPolicy = useCallback(
    (serverName: string, tool: string, policy: ToolPolicy): Promise<ConnectorTool[]> => unwrap(window.forja.app.setToolPolicy(serverName, tool, policy)),
    []
  )

  return { loaded, loadError, rows, servers, authUrls, redirectUris, busy, reloading, retry, refresh, connect, disconnect, reload, loadTools, setPolicy }
}
