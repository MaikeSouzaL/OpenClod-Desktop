import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import type { ConnectorState, ConnectorTool, ToolPolicy } from '../../../shared/mcp-connectors'
import { Icon } from './Icons'
import { ConnectorIcon } from './ConnectorIcon'
import { CredentialForm, type CredentialSubmit } from './ConnectorForms'
import { errorMessage } from '../lib/api'
import type { ConnectorsStore } from '../lib/useConnectors'
import {
  authBadges,
  authExplanation,
  categoryLabel,
  cleanNotes,
  credentialFields,
  credentialValues,
  detailPlan,
  filterTools,
  formatDay,
  groupTools,
  isOpenableLink,
  needsEndpoint,
  needsOAuthApp,
  overallPolicy,
  plural,
  policyCounts,
  POLICY_OPTIONS,
  probeSummary,
  redirectUriOf,
  statusChip,
  toolBadge,
  type ConnectInputWithApp,
  type ConnectorRow
} from '../lib/connectors'

type Store = Pick<ConnectorsStore, 'authUrls' | 'redirectUris' | 'busy' | 'connect' | 'disconnect' | 'reload' | 'reloading' | 'loadTools' | 'setPolicy'>

interface ConnectorDetailProps {
  row: ConnectorRow
  store: Store
  /** The element that opened the detail, to give the focus back on close. */
  trigger: HTMLElement | null
  onClose(): void
  onAnnounce(text: string): void
  /** Opens the edit form of a connector the user added by hand (command, arguments, address, headers, start time). */
  onEdit?(): void
}

/** `host/path` of a documentation link, shortened with an ellipsis instead of cut in the middle of a word. */
function docsLabel(link: string): string {
  const text = link.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  return text.length > 58 ? `${text.slice(0, 57)}…` : text
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const done = document.execCommand('copy')
      area.remove()
      return done
    } catch {
      return false
    }
  }
}

function PolicySelect({
  value,
  onChange,
  label,
  disabled,
  mixed
}: {
  value: ToolPolicy | 'mixed'
  onChange(policy: ToolPolicy): void
  label: string
  disabled?: boolean
  mixed?: boolean
}): ReactElement {
  return (
    <label className={`cnx-policy policy-${value}`}>
      <span className="cnx-policy-dot" aria-hidden="true" />
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as ToolPolicy)}>
        {mixed ? (
          <option value="mixed" disabled>
            Misto
          </option>
        ) : null}
        {POLICY_OPTIONS.map((option) => (
          <option key={option.id} value={option.id} title={option.help}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The exact return URL the user must register in their own OAuth app, with a copy button. */
function RedirectUriBox({ uri, onAnnounce }: { uri: string | undefined; onAnnounce(text: string): void }): ReactElement {
  const [copied, setCopied] = useState(false)
  if (!uri) {
    return <p className="cnx-muted">A URL de retorno exata aparece aqui assim que você tentar conectar. Cadastre-a no seu aplicativo antes de entrar.</p>
  }
  return (
    <div className="cnx-redirect">
      <span>Cadastre exatamente esta URL de retorno no seu aplicativo:</span>
      <div className="cnx-redirect-row">
        <code data-testid="redirect-uri">{uri}</code>
        <button
          type="button"
          className="btn small subtle"
          onClick={() => {
            void copyText(uri).then((ok) => {
              setCopied(ok)
              onAnnounce(ok ? 'URL de retorno copiada.' : 'Não foi possível copiar a URL de retorno.')
              window.setTimeout(() => setCopied(false), 2200)
            })
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copiada' : 'Copiar'}
        </button>
      </div>
    </div>
  )
}

function ToolsSection({ row, store, onAnnounce }: { row: ConnectorRow; store: Store; onAnnounce(text: string): void }): ReactElement {
  const serverName = row.state.serverName ?? row.id
  const [tools, setTools] = useState<ConnectorTool[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const { loadTools, setPolicy } = store

  useEffect(() => {
    let cancelled = false
    setError('')
    loadTools(serverName)
      .then((list) => !cancelled && setTools(list))
      .catch((err: unknown) => {
        if (cancelled) return
        setTools([])
        setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [serverName, row.state.toolCount, loadTools])

  const change = async (tool: string, policy: ToolPolicy): Promise<void> => {
    const before = tools
    setPending(true)
    setError('')
    setTools((current) => current && current.map((item) => (tool === '*' || item.name === tool ? { ...item, policy } : item)))
    try {
      const next = await setPolicy(serverName, tool, policy)
      setTools(next)
      const what = tool === '*' ? 'todas as ferramentas' : tool
      onAnnounce(`Permissão de ${what}: ${POLICY_OPTIONS.find((option) => option.id === policy)?.label ?? policy}.`)
    } catch (err) {
      setTools(before)
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  const shown = useMemo(() => filterTools(tools ?? [], query), [tools, query])
  const groups = useMemo(() => groupTools(shown), [shown])
  const counts = useMemo(() => policyCounts(tools ?? []), [tools])
  const overall = overallPolicy(tools ?? [])

  if (tools === null) {
    return (
      <section className="cnx-section" aria-busy="true">
        <h3>Ferramentas</h3>
        <p className="cnx-muted">Carregando ferramentas…</p>
      </section>
    )
  }

  return (
    <section className="cnx-section" aria-label="Ferramentas e permissões">
      <h3>
        Ferramentas <span className="cnx-count">{tools.length}</span>
      </h3>
      {error ? (
        <div className="cnx-callout tone-bad" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
      {!tools.length ? (
        <p className="cnx-muted">Este conector não expõe ferramentas agora. Use “Recarregar” se ele acabou de conectar.</p>
      ) : (
        <>
          <p className="cnx-muted">
            {counts.allow} sempre permitida{counts.allow === 1 ? '' : 's'} · {counts.ask} perguntam · {counts.deny} bloqueada{counts.deny === 1 ? '' : 's'}. Ferramentas bloqueadas ficam invisíveis para o agente.
          </p>
          <div className="cnx-tools-all">
            <div>
              <strong>Todas as ferramentas</strong>
              <span className="cnx-muted">Aplica a mesma permissão a todas de uma vez.</span>
            </div>
            <PolicySelect value={overall} mixed={overall === 'mixed'} label="Permissão de todas as ferramentas" disabled={pending} onChange={(policy) => void change('*', policy)} />
          </div>
          {tools.length > 6 ? (
            <div className="cnx-search small">
              <Icon name="search" size={13} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Procurar ferramenta" aria-label="Procurar ferramenta" spellCheck={false} />
            </div>
          ) : null}
          {!shown.length ? <p className="cnx-muted">Nenhuma ferramenta corresponde a “{query}”.</p> : null}
          {groups.map((group) => (
            <div className="cnx-tool-group" key={group.kind}>
              {groups.length > 1 ? (
                <h4>
                  {group.label} <span className="cnx-count">{group.tools.length}</span>
                </h4>
              ) : null}
              <ul className="cnx-tool-list">
                {group.tools.map((tool) => {
                  const badge = toolBadge(tool)
                  return (
                    <li className="cnx-tool" key={tool.name} data-tool={tool.name}>
                      <div className="cnx-tool-main">
                        <div className="cnx-tool-name">
                          <code>{tool.name}</code>
                          {badge ? <span className={`cnx-pill tone-${badge.tone}`}>{badge.label}</span> : null}
                        </div>
                        {tool.description ? <p>{tool.description}</p> : null}
                      </div>
                      <PolicySelect value={tool.policy} label={`Permissão de ${tool.name}`} disabled={pending} onChange={(policy) => void change(tool.name, policy)} />
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

/** Why the last attempt did not connect, from the result of `connectConnector`. */
function outcomeOf(state: ConnectorState): ConnectorState | null {
  return state.status === 'needs-auth' || state.status === 'error' ? state : null
}

export function ConnectorDetail({ row, store, trigger, onClose, onAnnounce, onEdit }: ConnectorDetailProps): ReactElement {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const [outcome, setOutcome] = useState<ConnectorState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [copied, setCopied] = useState(false)
  /** The user chose to bring their own OAuth app (services that refuse Openclod's automatic registration). */
  const [ownApp, setOwnApp] = useState(false)

  const state = row.state
  const authUrl = store.authUrls[row.id]
  const plan = detailPlan(row, Boolean(authUrl))
  const chip = statusChip(state)
  const busyAction = store.busy[row.id]
  const busy = Boolean(busyAction)
  const fields = credentialFields(row.entry)
  const askUrl = needsEndpoint(row.entry)
  const probe = probeSummary(row.entry?.probe, row.auth)
  const oauthApp = needsOAuthApp(row)
  const redirectUri = redirectUriOf(state) ?? store.redirectUris[row.id]
  const notes = cleanNotes(row.entry?.notes)
  const hint = state.hint ?? outcome?.hint
  const problem = state.status === 'error' || state.status === 'needs-auth' ? state : outcome
  const unavailableCustom = row.custom && state.status === 'needs-auth'
  // About 47 directory services advertise OAuth but refuse Openclod's automatic client registration: the error says
  // so, and then the form for the user's own OAuth app opens by itself (otherwise it stays one click away).
  const registrationRefused = /registro din[aâ]mico|client[ _]?id|aplicativo oauth/i.test(
    `${state.detail ?? ''} ${state.lastError ?? ''} ${state.hint ?? ''} ${outcome?.hint ?? ''} ${outcome?.lastError ?? ''}`
  )
  const offerOwnApp = row.auth === 'oauth' && !row.custom && plan.oneClick
  const showOwnApp = ownApp || registrationRefused

  // Focus: into the dialog on open, back to the card on close; Tab stays inside.
  useEffect(() => {
    const previous = trigger ?? (document.activeElement as HTMLElement | null)
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [trigger])

  useEffect(() => {
    if (state.status === 'connected') {
      setOutcome(null)
      setError('')
    }
  }, [state.status])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (confirmRemove) setConfirmRemove(false)
      else onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const connect = (submit?: CredentialSubmit): Promise<void> =>
    run(async () => {
      setOutcome(null)
      const values = submit ? credentialValues(row.entry, submit.credentials) : {}
      const input: ConnectInputWithApp | undefined =
        submit && (Object.keys(values).length || submit.url || submit.oauthClient)
          ? {
              ...(Object.keys(values).length ? { credentials: values } : {}),
              ...(submit.url ? { custom: { name: row.name, url: submit.url, transport: row.transport === 'sse' ? ('sse' as const) : ('http' as const) } } : {}),
              ...(submit.oauthClient ? { oauthClient: submit.oauthClient } : {})
            }
          : undefined
      const result = await store.connect(row.id, input)
      const bad = outcomeOf(result.state)
      if (bad && result.state.status !== 'connecting') setOutcome(bad)
    })

  const reconnect = (): Promise<void> =>
    run(async () => {
      // A custom connector has no directory entry to rebuild from, and one with credentials would lose them: restart instead.
      if (row.custom || fields.length || askUrl || oauthApp) await store.reload()
      else await store.connect(row.id)
    })

  const disconnect = (): Promise<void> =>
    run(async () => {
      await store.disconnect(row.id)
      setConfirmRemove(false)
      setOutcome(null)
      setNotice('Conector desconectado. O login e os segredos guardados foram removidos.')
      onAnnounce(`${row.name} desconectado.`)
    })

  const openLogin = (): void => {
    if (isOpenableLink(authUrl)) window.open(authUrl, '_blank')
  }

  const copyLogin = async (): Promise<void> => {
    if (!isOpenableLink(authUrl)) return
    const ok = await copyText(authUrl)
    setCopied(ok)
    onAnnounce(ok ? 'Link de login copiado.' : 'Não foi possível copiar o link.')
    window.setTimeout(() => setCopied(false), 2200)
  }

  const oauthLike = row.auth === 'oauth' || row.auth === 'oauth-static'
  const oneClickLabel = oauthLike ? (state.status === 'not-installed' ? 'Conectar com sua conta' : 'Entrar de novo com sua conta') : row.auth === 'unknown' ? (state.status === 'not-installed' ? 'Tentar conectar' : 'Tentar de novo') : state.status === 'not-installed' ? 'Conectar' : 'Tentar de novo'
  const expires = state.tokenExpiresAt && state.tokenExpiresAt > Date.now() ? formatDay(state.tokenExpiresAt) : null

  return (
    <div className="cnx-backdrop cnx-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={dialogRef} className="cnx-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} data-connector-detail={row.id}>
        <header className="cnx-drawer-head">
          <ConnectorIcon row={row} size={46} />
          <div className="cnx-drawer-title">
            <h2 id={titleId}>{row.name}</h2>
            <div className="cnx-badges">
              {row.custom ? null : <span className="cnx-pill tone-muted">{categoryLabel(row.category)}</span>}
              {authBadges(row).map((badge) => (
                <span key={badge.label} className={`cnx-pill tone-${badge.tone}`} title={badge.title}>
                  {badge.label}
                </span>
              ))}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar detalhes" data-autofocus>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="cnx-drawer-body">
          <p className="cnx-lead">{row.description || 'Sem descrição.'}</p>

          {chip ? (
            <div className={`cnx-statusbar tone-${chip.tone}`}>
              <span className={`cnx-dot ${state.status === 'connecting' ? 'pulse' : ''}`} aria-hidden="true" />
              <strong>{chip.label}</strong>
              {state.connectedAs ? <span>· conta {state.connectedAs}</span> : null}
              {expires ? <span>· login válido até {expires}</span> : null}
            </div>
          ) : null}

          {problem && (hint || problem.lastError || problem.detail) ? (
            <div className={`cnx-callout ${problem.status === 'error' ? 'tone-bad' : 'tone-warn'}`} role="alert">
              <Icon name={problem.status === 'error' ? 'alert' : 'info'} size={15} />
              <div>
                <strong>{problem.status === 'error' ? 'Não foi possível conectar' : (problem.detail ?? 'Precisa entrar')}</strong>
                {hint ? <p>{hint}</p> : null}
                {(problem.status === 'error' ? (problem.lastError ?? problem.detail) : problem.lastError !== problem.detail ? problem.lastError : undefined) ? (
                  <p className="cnx-tech">Detalhe técnico: {problem.status === 'error' ? (problem.lastError ?? problem.detail) : problem.lastError}</p>
                ) : null}
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="cnx-callout tone-bad" role="alert">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div className="cnx-callout tone-ok" role="status">
              <Icon name="check" size={15} />
              <span>{notice}</span>
            </div>
          ) : null}
          {unavailableCustom ? (
            <p className="cnx-muted">Para entrar de novo em um conector personalizado, desconecte e adicione-o outra vez.</p>
          ) : null}

          {plan.waiting ? (
            <section className="cnx-section cnx-waiting" aria-label="Aguardando login">
              <div className="cnx-waiting-head">
                <span className="cnx-spinner" aria-hidden="true" />
                <div>
                  <strong>Aguardando você entrar…</strong>
                  <p className="cnx-muted">Conclua o login na janela do navegador que se abriu. Esta tela atualiza sozinha quando terminar.</p>
                </div>
              </div>
              {isOpenableLink(authUrl) ? (
                <>
                  <code className="cnx-authurl" title={authUrl}>
                    {authUrl}
                  </code>
                  <div className="cnx-actions">
                    <button type="button" className="btn small subtle" onClick={openLogin}>
                      <Icon name="external" size={12} /> Abrir de novo
                    </button>
                    <button type="button" className="btn small subtle" onClick={() => void copyLogin()}>
                      <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Link copiado' : 'Copiar link'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="cnx-muted">O link de login não está mais disponível aqui. Cancele e tente de novo para abrir outro.</p>
              )}
              {oauthApp && redirectUri ? <RedirectUriBox uri={redirectUri} onAnnounce={onAnnounce} /> : null}
              <div className="cnx-actions">
                <button type="button" className="btn small ghost" onClick={() => void disconnect()} disabled={busy}>
                  Cancelar
                </button>
              </div>
            </section>
          ) : null}

          {plan.form ? (
            <section className="cnx-section" aria-label="Conectar">
              <h3>{state.status === 'not-installed' ? 'Conectar' : 'Informar a credencial de novo'}</h3>
              <p className="cnx-muted">{authExplanation(row)}</p>
              {oauthApp ? <RedirectUriBox uri={redirectUri} onAnnounce={onAnnounce} /> : null}
              <CredentialForm
                key={`${row.id}-${state.status}`}
                fields={fields}
                oauthApp={oauthApp}
                askUrl={askUrl}
                submitLabel={oauthLike ? 'Conectar com sua conta' : 'Conectar'}
                busy={busyAction === 'connect'}
                error=""
                onSubmit={(value) => void connect(value)}
              />
            </section>
          ) : null}

          {plan.oneClick ? (
            <section className="cnx-section" aria-label="Conectar">
              <h3>{state.status === 'not-installed' ? 'Conectar' : 'Entrar'}</h3>
              <p className="cnx-muted">{authExplanation(row)}</p>
              <div className="cnx-actions">
                <button type="button" className="btn primary" onClick={() => void connect()} disabled={busy} data-testid="connect-one-click">
                  {busyAction === 'connect' ? 'Conectando…' : oneClickLabel}
                </button>
              </div>
            </section>
          ) : null}

          {offerOwnApp ? (
            <section className="cnx-section" aria-label="Aplicativo OAuth próprio">
              {showOwnApp ? (
                <>
                  <h3>Usar meu próprio aplicativo OAuth</h3>
                  <p className="cnx-muted">
                    {registrationRefused
                      ? 'Este serviço recusou o cadastro automático do Openclod. '
                      : 'Alguns serviços só aceitam aplicativos cadastrados por você. '}
                    Crie um aplicativo OAuth no painel de desenvolvedor do serviço, cadastre exatamente a URL de retorno abaixo e informe o Client ID (e o Secret, se houver).
                  </p>
                  <RedirectUriBox uri={redirectUri} onAnnounce={onAnnounce} />
                  <CredentialForm
                    key={`${row.id}-own-${state.status}`}
                    fields={[]}
                    oauthApp
                    askUrl={false}
                    submitLabel="Conectar com meu aplicativo"
                    busy={busyAction === 'connect'}
                    error=""
                    onSubmit={(value) => void connect(value)}
                  />
                </>
              ) : (
                <button type="button" className="btn small ghost" onClick={() => setOwnApp(true)} data-testid="own-oauth-app">
                  Usar meu próprio aplicativo OAuth (avançado)
                </button>
              )}
            </section>
          ) : null}

          {plan.removable && !plan.waiting ? (
            <section className="cnx-section" aria-label="Gerenciar conexão">
              <h3>Conexão</h3>
              {confirmRemove ? (
                <div className="cnx-callout tone-warn" role="alertdialog" aria-label="Confirmar desconexão">
                  <Icon name="alert" size={15} />
                  <div>
                    <strong>Desconectar {row.name}?</strong>
                    <p>Isto remove o conector, revoga o login quando o serviço permite e apaga do cofre os tokens e segredos guardados. Para usar de novo, será preciso conectar outra vez.</p>
                    <div className="cnx-actions">
                      <button type="button" className="btn small ghost" onClick={() => setConfirmRemove(false)}>
                        Cancelar
                      </button>
                      <button type="button" className="btn small danger" onClick={() => void disconnect()} disabled={busy} data-autofocus>
                        {busyAction === 'disconnect' ? 'Desconectando…' : 'Desconectar e apagar segredos'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="cnx-actions">
                  <button type="button" className="btn small subtle" onClick={() => void reconnect()} disabled={busy || store.reloading} title="Reinicia a conexão com este conector">
                    <Icon name="rotate" size={12} /> Reconectar
                  </button>
                  <button type="button" className="btn small subtle" onClick={() => void run(store.reload)} disabled={busy || store.reloading} title="Reinicia os conectores e lê as ferramentas de novo">
                    <Icon name="refresh" size={12} /> {store.reloading ? 'Recarregando…' : 'Recarregar'}
                  </button>
                  {row.custom && onEdit ? (
                    <button type="button" className="btn small subtle" onClick={onEdit} disabled={busy} title="Muda o endereço ou o programa, os argumentos, as variáveis e o tempo de partida" data-testid="edit-connector">
                      <Icon name="pencil" size={12} /> Editar
                    </button>
                  ) : null}
                  <button type="button" className="btn small ghost cnx-danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
                    <Icon name="trash" size={12} /> Desconectar
                  </button>
                </div>
              )}
            </section>
          ) : null}

          {plan.tools ? <ToolsSection row={row} store={store} onAnnounce={onAnnounce} /> : null}

          <section className="cnx-section" aria-label="Sobre este conector">
            <h3>Sobre</h3>
            <dl className="cnx-facts">
              {row.endpoint ? (
                <>
                  <dt>Endereço</dt>
                  <dd>
                    <code>{row.endpoint}</code>
                  </dd>
                </>
              ) : row.entry?.command ? (
                <>
                  <dt>Comando</dt>
                  <dd>
                    <code>{[row.entry.command, ...(row.entry.args ?? [])].join(' ').slice(0, 200)}</code>
                  </dd>
                </>
              ) : null}
              <dt>Transporte</dt>
              <dd>{row.transport === 'stdio' ? 'Local (stdio)' : row.transport === 'sse' ? 'Remoto (SSE)' : 'Remoto (HTTP)'}</dd>
              <dt>Autenticação</dt>
              <dd>{authExplanation(row)}</dd>
              {probe ? (
                <>
                  <dt>Verificação</dt>
                  <dd className={`cnx-probe tone-${probe.tone}`}>
                    <span className="cnx-dot" aria-hidden="true" /> {probe.text}
                  </dd>
                </>
              ) : row.entry && !row.custom && row.kind === 'remote' ? (
                <>
                  <dt>Verificação</dt>
                  <dd className="cnx-muted">Ainda não verificado.</dd>
                </>
              ) : null}
              {notes ? (
                <>
                  <dt>Observações</dt>
                  <dd>{notes}</dd>
                </>
              ) : null}
              {row.entry?.docs && /^https?:\/\//i.test(row.entry.docs) ? (
                <>
                  <dt>Documentação</dt>
                  <dd>
                    <a href={row.entry.docs} target="_blank" rel="noreferrer">
                      {docsLabel(row.entry.docs)}
                    </a>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          {!plan.tools && row.entry?.tools?.length ? (
            <section className="cnx-section" aria-label="Ferramentas que o conector oferece">
              <h3>
                Ferramentas <span className="cnx-count">{row.entry.toolCount ?? row.entry.tools.length}</span>
              </h3>
              <p className="cnx-muted">
                Prévia do que ele oferece{row.entry.toolCount && row.entry.toolCount > row.entry.tools.length ? ` (${row.entry.tools.length} de ${plural(row.entry.toolCount, 'ferramenta', 'ferramentas')})` : ''}. Depois de conectar você escolhe a permissão de cada uma.
              </p>
              <div className="cnx-chips">
                {row.entry.tools.slice(0, 24).map((tool) => (
                  <code key={tool}>{tool}</code>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
