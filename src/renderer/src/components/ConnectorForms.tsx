import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { ConnectInput, ConnectorCredential } from '../../../shared/mcp-connectors'
import type { McpServerSettings } from '../../../shared/types'
import { Icon } from './Icons'
import {
  customInput,
  draftFromServer,
  hasErrors,
  isSecretField,
  isSecretVariable,
  START_TIMEOUT_RANGE,
  validateCustom,
  validateUrl,
  type CustomDraft,
  type CustomErrors
} from '../lib/connectors'

/** A password-style field with a show/hide button; the value never leaves this component except through onChange. */
export function SecretInput({
  value,
  onChange,
  label,
  describedBy,
  invalid,
  placeholder,
  id
}: {
  value: string
  onChange(value: string): void
  label: string
  describedBy?: string
  invalid?: boolean
  placeholder?: string
  id?: string
}): ReactElement {
  const [shown, setShown] = useState(false)
  return (
    <span className="cnx-secret">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={id ? undefined : label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
      <button
        type="button"
        className="cnx-secret-toggle"
        onClick={() => setShown((current) => !current)}
        aria-label={shown ? `Ocultar ${label}` : `Mostrar ${label}`}
        aria-pressed={shown}
        title={shown ? 'Ocultar' : 'Mostrar'}
      >
        <Icon name="eye" size={14} />
      </button>
    </span>
  )
}

export interface CredentialSubmit {
  credentials: Record<string, string>
  /** The server address, when the directory has none. */
  url?: string
  /** The user's own OAuth app (services that do not accept dynamic registration). */
  oauthClient?: { clientId: string; clientSecret?: string }
}

const OAUTH_ID = '__oauth_client_id'
const OAUTH_SECRET = '__oauth_client_secret'
const OAUTH_FIELDS: ConnectorCredential[] = [
  { key: OAUTH_ID, label: 'Client ID', where: 'env', required: true, secret: false, help: 'Está na página do aplicativo que você criou no painel de desenvolvedor do serviço.' },
  { key: OAUTH_SECRET, label: 'Client Secret', where: 'env', secret: true, help: 'Deixe em branco se o serviço não gerou um segredo para o seu aplicativo.' }
]

/** Form generated from the `credentials` of a directory entry (and the server URL when the directory has none). */
export function CredentialForm({
  fields: credentialFields,
  oauthApp = false,
  askUrl,
  submitLabel,
  busy,
  error,
  onSubmit
}: {
  fields: ConnectorCredential[]
  /** Ask for the Client ID / Client Secret of the user's own OAuth app first. */
  oauthApp?: boolean
  askUrl: boolean
  submitLabel: string
  busy: boolean
  error: string
  onSubmit(value: CredentialSubmit): void
}): ReactElement {
  const base = useId()
  const fields = oauthApp ? [...OAUTH_FIELDS, ...credentialFields] : credentialFields
  const [values, setValues] = useState<Record<string, string>>({})
  const [url, setUrl] = useState('')
  const [touched, setTouched] = useState(false)

  const problems: Record<string, string> = {}
  for (const field of fields) {
    if (field.required && !(values[field.key] ?? '').trim()) problems[field.key] = 'Campo obrigatório.'
  }
  const urlProblem = askUrl ? validateUrl(url) : null
  const invalid = Object.keys(problems).length > 0 || Boolean(urlProblem)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setTouched(true)
    if (invalid) return
    const { [OAUTH_ID]: clientId, [OAUTH_SECRET]: clientSecret, ...credentials } = values
    onSubmit({
      credentials,
      ...(askUrl ? { url: url.trim() } : {}),
      ...(oauthApp && clientId?.trim() ? { oauthClient: { clientId: clientId.trim(), ...(clientSecret?.trim() ? { clientSecret: clientSecret.trim() } : {}) } } : {})
    })
  }

  return (
    <form className="cnx-form" onSubmit={submit} noValidate aria-label="Credenciais do conector">
      {askUrl ? (
        <div className="cnx-field">
          <label htmlFor={`${base}-url`}>
            URL do servidor MCP <em>obrigatório</em>
          </label>
          <input
            id={`${base}-url`}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mcp.exemplo.com/mcp"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={touched && urlProblem ? true : undefined}
            aria-describedby={`${base}-url-help`}
          />
          <small id={`${base}-url-help`} className={touched && urlProblem ? 'is-bad' : ''}>
            {touched && urlProblem ? urlProblem : 'Este serviço não publica um endereço público. Peça a URL do servidor MCP a ele.'}
          </small>
        </div>
      ) : null}
      {fields.map((field) => {
        const secret = isSecretField(field)
        const inputId = `${base}-${field.key}`
        const helpId = `${inputId}-help`
        const bad = touched && problems[field.key]
        const help = bad ? problems[field.key] : (field.help ?? (secret ? 'Fica guardado no cofre do sistema.' : ''))
        return (
          <div className="cnx-field" key={field.key}>
            <label htmlFor={inputId}>
              {field.label || field.key} {field.required ? <em>obrigatório</em> : <em className="opt">opcional</em>}
            </label>
            {secret ? (
              <SecretInput id={inputId} value={values[field.key] ?? ''} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} label={field.label || field.key} describedBy={help ? helpId : undefined} invalid={Boolean(bad)} placeholder={field.example} />
            ) : (
              <input
                id={inputId}
                value={values[field.key] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                placeholder={field.example}
                spellCheck={false}
                autoComplete="off"
                aria-describedby={help ? helpId : undefined}
                aria-invalid={bad ? true : undefined}
              />
            )}
            {help ? (
              <small id={helpId} className={bad ? 'is-bad' : ''}>
                {help}
              </small>
            ) : null}
          </div>
        )
      })}
      {error ? (
        <div className="cnx-callout tone-bad" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="cnx-form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Conectando…' : submitLabel}
        </button>
        <span className="cnx-note">
          <Icon name="shield" size={12} /> Segredos vão para o cofre do sistema.
        </span>
      </div>
    </form>
  )
}

const EMPTY_DRAFT: CustomDraft = { name: '', mode: 'remote', url: '', transport: 'http', headers: [], command: '', args: '', env: [], cwd: '', startTimeout: '' }

type Pair = { name: string; value: string }

/** A list of name/value rows (headers, environment variables). A credential's value is hidden while typed. */
function PairRows({
  legend,
  pairs,
  onChange,
  namePlaceholder,
  valuePlaceholder,
  secretFor,
  max,
  addLabel,
  labels,
  error,
  help
}: {
  legend: string
  pairs: Pair[]
  onChange(pairs: Pair[]): void
  namePlaceholder: string
  valuePlaceholder: string
  secretFor(name: string): boolean
  max: number
  addLabel: string
  labels: { name(n: number): string; value(n: number): string; remove(n: number): string }
  error?: string
  help: string
}): ReactElement {
  const set = (index: number, patch: Partial<Pair>): void => onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...patch } : pair)))
  return (
    <fieldset className="cnx-headers">
      <legend>{legend}</legend>
      {pairs.map((pair, index) => (
        <div className="cnx-header-row" key={index}>
          <input aria-label={labels.name(index + 1)} value={pair.name} onChange={(event) => set(index, { name: event.target.value })} placeholder={namePlaceholder} spellCheck={false} autoComplete="off" />
          {secretFor(pair.name) ? (
            <SecretInput value={pair.value} onChange={(value) => set(index, { value })} label={labels.value(index + 1)} placeholder={valuePlaceholder} />
          ) : (
            <input aria-label={labels.value(index + 1)} value={pair.value} onChange={(event) => set(index, { value: event.target.value })} placeholder={valuePlaceholder} spellCheck={false} autoComplete="off" />
          )}
          <button type="button" className="icon-btn" aria-label={labels.remove(index + 1)} onClick={() => onChange(pairs.filter((_, at) => at !== index))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {error ? <small className="is-bad">{error}</small> : <small>{help}</small>}
      <button type="button" className="btn small ghost" onClick={() => onChange([...pairs, { name: '', value: '' }])} disabled={pairs.length >= max}>
        <Icon name="plus" size={12} /> {addLabel}
      </button>
    </fieldset>
  )
}

/**
 * Modal to add a connector by hand, or to edit one: a remote server (address) or a program on this computer
 * (command, arguments, variables, folder). When editing, `initial` is the server as `maskedMcpSettings` returns it, so
 * credentials come back masked and, left as they are, keep the value in the vault.
 */
export function CustomConnectorDialog({
  existingNames,
  initial,
  onCancel,
  onSubmit
}: {
  /** Names already in use (the one being edited is not in the list). */
  existingNames: string[]
  initial?: McpServerSettings
  onCancel(): void
  onSubmit(input: NonNullable<ConnectInput['custom']>): Promise<void>
}): ReactElement {
  const base = useId()
  const editing = Boolean(initial)
  const [draft, setDraft] = useState<CustomDraft>(() => (initial ? draftFromServer(initial) : EMPTY_DRAFT))
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const local = draft.mode === 'local'
  const errors: CustomErrors = validateCustom(draft, existingNames)
  const shown = (key: keyof CustomErrors): string | undefined => (touched ? errors[key] : undefined)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onCancel])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setTouched(true)
    if (hasErrors(errors)) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(customInput(draft))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const advancedOpen = Boolean((draft.startTimeout ?? '').trim()) || Boolean(errors.startTimeout && touched)

  return (
    <div className="cnx-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <div ref={dialogRef} className="cnx-dialog" role="dialog" aria-modal="true" aria-labelledby={`${base}-title`}>
        <header className="cnx-dialog-head">
          <h2 id={`${base}-title`}>{editing ? `Editar ${draft.name}` : 'Adicionar conector personalizado'}</h2>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Fechar" disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <form className="cnx-form" onSubmit={(event) => void submit(event)} noValidate>
          {editing ? null : (
            <fieldset className="cnx-kind" role="radiogroup" aria-label="Tipo de conector">
              <label className={!local ? 'is-on' : ''}>
                <input type="radio" name={`${base}-kind`} checked={!local} onChange={() => setDraft({ ...draft, mode: 'remote' })} />
                <span>
                  <strong>Endereço na internet</strong>
                  <small>Um servidor MCP remoto, com URL.</small>
                </span>
              </label>
              <label className={local ? 'is-on' : ''}>
                <input type="radio" name={`${base}-kind`} checked={local} onChange={() => setDraft({ ...draft, mode: 'local' })} data-testid="kind-local" />
                <span>
                  <strong>Programa neste computador</strong>
                  <small>Um comando que inicia o servidor, como npx, uvx ou node.</small>
                </span>
              </label>
            </fieldset>
          )}
          <p className="cnx-note-block">
            {local
              ? 'Aponte para um programa MCP que roda neste computador. '
              : 'Aponte para um servidor MCP remoto. '}
            Suas ferramentas aparecem para o agente como <code>mcp__nome__ferramenta</code> e passam pela política de permissões.
          </p>
          <div className="cnx-field">
            <label htmlFor={`${base}-name`}>Nome</label>
            <input
              id={`${base}-name`}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="meu-servidor"
              maxLength={60}
              spellCheck={false}
              readOnly={editing}
              aria-invalid={shown('name') ? true : undefined}
              aria-describedby={`${base}-name-help`}
              data-autofocus={editing ? undefined : ''}
            />
            <small id={`${base}-name-help`} className={shown('name') ? 'is-bad' : ''}>
              {shown('name') ?? (editing ? 'O nome não muda. Para usar outro, desconecte e adicione de novo.' : 'Letras, números, hífen e sublinhado.')}
            </small>
          </div>

          {local ? (
            <>
              <div className="cnx-callout tone-warn">
                <Icon name="shield" size={14} />
                <span>Este programa vai rodar no seu computador, com as suas permissões, sempre que o Openclod abrir. Adicione só o que você conhece e confia.</span>
              </div>
              <div className="cnx-field">
                <label htmlFor={`${base}-command`}>Programa</label>
                <input
                  id={`${base}-command`}
                  value={draft.command ?? ''}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  placeholder="npx"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={shown('command') ? true : undefined}
                  aria-describedby={`${base}-command-help`}
                  data-autofocus={editing ? '' : undefined}
                />
                <small id={`${base}-command-help`} className={shown('command') ? 'is-bad' : ''}>
                  {shown('command') ?? 'O nome do programa (npx, uvx, node, python) ou o caminho completo de um .exe.'}
                </small>
              </div>
              <div className="cnx-field">
                <label htmlFor={`${base}-args`}>
                  Argumentos <em className="opt">opcional</em>
                </label>
                <textarea
                  id={`${base}-args`}
                  value={draft.args ?? ''}
                  onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\voce\\Documentos'}
                  rows={4}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={shown('args') ? true : undefined}
                  aria-describedby={`${base}-args-help`}
                />
                <small id={`${base}-args-help`} className={shown('args') ? 'is-bad' : ''}>
                  {shown('args') ?? 'Um por linha, sem aspas: cada linha é um argumento.'}
                </small>
              </div>
              <PairRows
                legend="Variáveis de ambiente (opcional)"
                pairs={draft.env ?? []}
                onChange={(env) => setDraft({ ...draft, env })}
                namePlaceholder="NOME"
                valuePlaceholder="valor"
                secretFor={isSecretVariable}
                max={60}
                addLabel="Adicionar variável"
                labels={{ name: (n) => `Nome da variável ${n}`, value: (n) => `valor da variável ${n}`, remove: (n) => `Remover variável ${n}` }}
                error={shown('env')}
                help="Chaves, tokens e senhas ficam no cofre do sistema."
              />
              <div className="cnx-field">
                <label htmlFor={`${base}-cwd`}>
                  Pasta de trabalho <em className="opt">opcional</em>
                </label>
                <input
                  id={`${base}-cwd`}
                  value={draft.cwd ?? ''}
                  onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                  placeholder="C:\projetos\meu-servidor"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={shown('cwd') ? true : undefined}
                  aria-describedby={`${base}-cwd-help`}
                />
                <small id={`${base}-cwd-help`} className={shown('cwd') ? 'is-bad' : ''}>
                  {shown('cwd') ?? 'Onde o programa começa. Deixe em branco se não precisar.'}
                </small>
              </div>
            </>
          ) : (
            <>
              <div className="cnx-field">
                <label htmlFor={`${base}-url`}>URL do servidor</label>
                <input
                  id={`${base}-url`}
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  placeholder="https://mcp.exemplo.com/mcp"
                  spellCheck={false}
                  aria-invalid={shown('url') ? true : undefined}
                  aria-describedby={`${base}-url-help`}
                  data-autofocus={editing ? '' : undefined}
                />
                <small id={`${base}-url-help`} className={shown('url') ? 'is-bad' : ''}>
                  {shown('url') ?? 'Use https://. Só endereços deste computador podem usar http://.'}
                </small>
              </div>
              <div className="cnx-field">
                <label htmlFor={`${base}-transport`}>Transporte</label>
                <select id={`${base}-transport`} value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value === 'sse' ? 'sse' : 'http' })}>
                  <option value="http">HTTP em fluxo (padrão)</option>
                  <option value="sse">SSE (legado)</option>
                </select>
              </div>
              <PairRows
                legend="Cabeçalhos de autenticação (opcional)"
                pairs={draft.headers}
                onChange={(headers) => setDraft({ ...draft, headers })}
                namePlaceholder="Authorization"
                valuePlaceholder="Bearer …"
                secretFor={() => true}
                max={10}
                addLabel="Adicionar cabeçalho"
                labels={{ name: (n) => `Nome do cabeçalho ${n}`, value: (n) => `valor do cabeçalho ${n}`, remove: (n) => `Remover cabeçalho ${n}` }}
                error={shown('headers')}
                help="Os valores vão para o cofre do sistema."
              />
            </>
          )}

          <details className="cnx-advanced" open={advancedOpen || undefined}>
            <summary>Avançado</summary>
            <div className="cnx-advanced-body">
              <div className="cnx-field">
                <label htmlFor={`${base}-start`}>
                  Tempo de partida, em segundos <em className="opt">opcional</em>
                </label>
                <input
                  id={`${base}-start`}
                  type="number"
                  inputMode="numeric"
                  min={START_TIMEOUT_RANGE.min}
                  max={START_TIMEOUT_RANGE.max}
                  value={draft.startTimeout ?? ''}
                  onChange={(event) => setDraft({ ...draft, startTimeout: event.target.value })}
                  placeholder={String(START_TIMEOUT_RANGE.fallback)}
                  aria-invalid={shown('startTimeout') ? true : undefined}
                  aria-describedby={`${base}-start-help`}
                />
                <small id={`${base}-start-help`} className={shown('startTimeout') ? 'is-bad' : ''}>
                  {shown('startTimeout') ?? `Quanto o servidor pode levar para responder ao conectar. Em branco: ${START_TIMEOUT_RANGE.fallback} s. Programas que baixam pacotes na primeira vez (npx, uvx) podem precisar de mais.`}
                </small>
              </div>
            </div>
          </details>

          {error ? (
            <div className="cnx-callout tone-bad" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="cnx-form-actions end">
            <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? (editing ? 'Salvando…' : 'Conectando…') : editing ? 'Salvar e reconectar' : 'Adicionar e conectar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
