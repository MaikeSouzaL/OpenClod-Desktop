import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { DevServerCandidate, DevServerDetection } from '../../../shared/api'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'

/** Must match PREVIEW_PARTITION in the main process (will-attach-webview). */
const PARTITION = 'persist:openclod-preview'

/** The subset of Electron's WebviewTag used here (the renderer has no Electron types). */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  closeDevTools(): void
  isDevToolsOpened(): boolean
}

interface BrowserTab {
  id: string
  /** Set once when the webview is created; later navigation goes through loadURL. */
  initialUrl: string | null
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  error?: string
}

let tabCounter = 0
function newTab(url: string | null = null): BrowserTab {
  tabCounter += 1
  return { id: `tab-${tabCounter}`, initialUrl: url, url: url ?? '', title: url ? url : 'Nova aba', loading: Boolean(url), canBack: false, canForward: false }
}

export function normalizeUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text) || text === 'about:blank') return text
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(text) || /^:\d+/.test(text)) {
    return `http://${text.startsWith(':') ? `localhost${text}` : text}`
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`
  return null
}

function TabView({
  tab,
  active,
  onUpdate,
  register
}: {
  tab: BrowserTab & { initialUrl: string }
  active: boolean
  onUpdate(patch: Partial<BrowserTab>): void
  register(element: WebviewElement | null): void
}): ReactElement {
  const ref = useRef<WebviewElement | null>(null)
  const update = useRef(onUpdate)
  update.current = onUpdate

  useEffect(() => {
    const view = ref.current
    if (!view) return
    register(view)
    const sync = (): void => {
      try {
        update.current({ url: view.getURL(), title: view.getTitle() || view.getURL(), canBack: view.canGoBack(), canForward: view.canGoForward() })
      } catch {
        /* not attached yet */
      }
    }
    const onStart = (): void => update.current({ loading: true, error: undefined })
    const onStop = (): void => {
      update.current({ loading: false })
      sync()
    }
    const onFail = (event: Event): void => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean; validatedURL?: string }
      if (detail.isMainFrame === false || detail.errorCode === -3) return
      update.current({ loading: false, error: `${detail.errorDescription ?? 'falha ao carregar'} (${detail.errorCode ?? '?'}) — ${detail.validatedURL ?? ''}` })
    }
    const onTitle = (event: Event): void => update.current({ title: (event as Event & { title?: string }).title ?? '' })
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('page-title-updated', onTitle)
    return () => {
      register(null)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', sync)
      view.removeEventListener('did-navigate-in-page', sync)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('page-title-updated', onTitle)
    }
    // The webview element is created once per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <webview
      ref={(element) => {
        ref.current = element as WebviewElement | null
      }}
      className={`browser-webview ${active ? 'active' : ''}`}
      src={tab.initialUrl}
      partition={PARTITION}
    />
  )
}

function DevServers({
  detection,
  loading,
  starting,
  error,
  onUse,
  onRefresh,
  onBack
}: {
  detection: DevServerDetection | null
  loading: boolean
  starting: string | null
  error: string
  onUse(candidate: DevServerCandidate): void
  onRefresh(): void
  onBack?(): void
}): ReactElement {
  const candidates = detection?.candidates ?? []
  return (
    <div className="browser-start">
      <div className="browser-start-head">
        <Icon name="globe" size={20} />
        <h3>Pré-visualizar o app</h3>
        <p>Digite uma URL acima ou inicie um servidor de desenvolvimento do projeto.</p>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="devserver-list">
        {loading ? <div className="muted pad">Procurando servidores…</div> : null}
        {!loading && !candidates.length ? (
          <div className="panel-muted">Nenhum script de servidor (dev, start, serve, preview) encontrado no package.json.</div>
        ) : null}
        {candidates.map((candidate) => (
          <div key={candidate.name} className={`devserver-card ${detection?.saved === candidate.name ? 'saved' : ''}`}>
            <div className="devserver-info">
              <strong>{candidate.port ? `porta ${candidate.port}` : candidate.name}</strong>
              <code title={candidate.command}>{candidate.command}</code>
              <em>{candidate.source === 'launch.json' ? 'launch.json' : `script "${candidate.name}"`}</em>
            </div>
            <button type="button" className="btn small primary" disabled={Boolean(starting)} onClick={() => onUse(candidate)}>
              {starting === candidate.name ? 'Iniciando…' : 'Usar esta'}
            </button>
          </div>
        ))}
      </div>
      {detection ? (
        <p className="browser-start-note">
          Sua escolha é salva em <code>.openclod/launch.json</code>. O servidor roda numa aba do Terminal desta sessão.
        </p>
      ) : null}
      <div className="browser-start-actions">
        <button type="button" className="btn small ghost" onClick={onRefresh}>
          <Icon name="refresh" size={12} /> Procurar de novo
        </button>
        {onBack ? (
          <button type="button" className="btn small ghost" onClick={onBack}>
            <Icon name="arrowLeft" size={12} /> Voltar à navegação
          </button>
        ) : null}
      </div>
    </div>
  )
}

interface BrowserPaneProps {
  sessionId: string
  root: string
  active: boolean
}

export function BrowserPane({ sessionId, root, active }: BrowserPaneProps): ReactElement {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState(() => tabs[0].id)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [showServers, setShowServers] = useState(false)
  const [detection, setDetection] = useState<DevServerDetection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)
  const [serverError, setServerError] = useState('')
  const views = useRef(new Map<string, WebviewElement>())

  const current = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  useEffect(() => {
    if (!editing) setAddress(current?.url ?? '')
  }, [current?.url, current?.id, editing])

  const detect = useCallback(async (): Promise<void> => {
    setDetecting(true)
    setServerError('')
    try {
      setDetection(await unwrap(window.openclod.preview.detect(root)))
    } catch (err) {
      setServerError(errorMessage(err))
    } finally {
      setDetecting(false)
    }
  }, [root])

  useEffect(() => {
    if (active && !detection && !detecting) void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const patchTab = (tabId: string, patch: Partial<BrowserTab>): void => {
    setTabs((list) => list.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)))
  }

  const navigate = (raw: string, tabId = current.id): void => {
    const url = normalizeUrl(raw)
    if (!url) {
      patchTab(tabId, { error: 'URL inválida. Use http(s)://, localhost:porta ou um domínio.' })
      return
    }
    setShowServers(false)
    const view = views.current.get(tabId)
    const tab = tabs.find((item) => item.id === tabId)
    if (view && tab?.initialUrl) {
      patchTab(tabId, { url, error: undefined })
      void view.loadURL(url).catch(() => undefined)
    } else {
      patchTab(tabId, { initialUrl: url, url, title: url, loading: true, error: undefined })
    }
  }

  const useServer = async (candidate: DevServerCandidate): Promise<void> => {
    setStarting(candidate.name)
    setServerError('')
    try {
      const result = await unwrap(window.openclod.preview.start(root, candidate.name, sessionId))
      await detect()
      if (result.url) navigate(result.url)
      else setServerError('O servidor foi iniciado no Terminal, mas nenhuma URL apareceu em 45 s. Confira a aba do Terminal e digite a URL acima.')
    } catch (err) {
      setServerError(errorMessage(err))
    } finally {
      setStarting(null)
    }
  }

  const addTab = (): void => {
    const tab = newTab()
    setTabs((list) => [...list, tab])
    setActiveId(tab.id)
    setShowServers(false)
  }

  const closeTab = (tabId: string): void => {
    views.current.delete(tabId)
    setTabs((list) => {
      const next = list.filter((tab) => tab.id !== tabId)
      if (!next.length) {
        const fresh = newTab()
        setActiveId(fresh.id)
        return [fresh]
      }
      if (tabId === activeId) setActiveId(next[next.length - 1].id)
      return next
    })
  }

  const view = views.current.get(current.id)
  const startPage = !current.initialUrl || showServers

  return (
    <div className="browser-pane">
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.id} className={`browser-tab ${tab.id === current.id ? 'active' : ''}`}>
            <button type="button" role="tab" aria-selected={tab.id === current.id} onClick={() => setActiveId(tab.id)} title={tab.url || tab.title}>
              {tab.loading ? <span className="spinner tiny" /> : <Icon name="globe" size={11} />}
              <span>{tab.title || 'Nova aba'}</span>
            </button>
            <button type="button" className="browser-tab-close" title="Fechar aba" onClick={() => closeTab(tab.id)}>
              <Icon name="x" size={10} />
            </button>
          </div>
        ))}
        <button type="button" className="icon-btn small" title="Nova aba" onClick={addTab}>
          <Icon name="plus" size={13} />
        </button>
      </div>

      <div className="browser-toolbar">
        <button type="button" className="icon-btn small" title="Voltar" disabled={!current.canBack} onClick={() => view?.goBack()}>
          <Icon name="arrowLeft" size={14} />
        </button>
        <button type="button" className="icon-btn small" title="Avançar" disabled={!current.canForward} onClick={() => view?.goForward()}>
          <Icon name="arrowRight" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn small"
          title={current.loading ? 'Parar' : 'Recarregar'}
          disabled={!view}
          onClick={() => (current.loading ? view?.stop() : view?.reload())}
        >
          <Icon name={current.loading ? 'x' : 'refresh'} size={13} />
        </button>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            setEditing(false)
            navigate(address)
          }}
        >
          <input
            value={address}
            placeholder="Digite uma URL"
            spellCheck={false}
            onFocus={(event) => {
              setEditing(true)
              event.target.select()
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <button type="button" className={`icon-btn small ${showServers ? 'is-active' : ''}`} title="Servidores de desenvolvimento" onClick={() => setShowServers((value) => !value)}>
          <Icon name="play" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn small"
          title="Ferramentas do desenvolvedor"
          disabled={!view}
          onClick={() => (view?.isDevToolsOpened() ? view.closeDevTools() : view?.openDevTools())}
        >
          <Icon name="code" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn small"
          title="Abrir no navegador padrão"
          disabled={!current.url || !/^https?:/i.test(current.url)}
          onClick={() => window.open(current.url, '_blank')}
        >
          <Icon name="external" size={13} />
        </button>
      </div>

      {current.error ? <div className="inline-error">{current.error}</div> : null}

      <div className="browser-stage">
        {tabs.map((tab) =>
          tab.initialUrl ? (
          <TabView
            key={tab.id}
            tab={{ ...tab, initialUrl: tab.initialUrl }}
            active={tab.id === current.id && !startPage}
            onUpdate={(patch) => patchTab(tab.id, patch)}
            register={(element) => {
              if (element) views.current.set(tab.id, element)
              else views.current.delete(tab.id)
            }}
          />
          ) : null
        )}
        {startPage ? (
          <DevServers
            detection={detection}
            loading={detecting}
            starting={starting}
            error={serverError}
            onUse={(candidate) => void useServer(candidate)}
            onRefresh={() => void detect()}
            onBack={current.initialUrl ? () => setShowServers(false) : undefined}
          />
        ) : null}
      </div>
    </div>
  )
}
