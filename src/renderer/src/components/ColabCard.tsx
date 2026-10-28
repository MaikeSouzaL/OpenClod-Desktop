import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ProviderConfig } from '../../../shared/types'
import type { ColabInspectResult, ColabPrepareInfo, ColabPreview, ColabStatusInfo } from '../../../shared/api'
import { Icon } from './Icons'
import { ProviderLogo } from './ProviderLogo'
import { errorMessage, unwrap } from '../lib/api'
import './providers.css'

const FAQ_URL = 'https://research.google.com/colaboratory/faq.html'
const TERMS_URL = 'https://research.google.com/colaboratory/tos_v6.html'

interface ColabCardProps {
  /** The Colab provider as saved (not the draft being edited), if there is one. */
  provider: ProviderConfig | undefined
  /** Settings and the model picker are reloaded after connecting or disconnecting. */
  onChanged(): Promise<void>
  /** Opens the provider's own card (model, context window...). */
  onOpenProvider(id: string): void
}

const STATE_LABEL: Record<ColabStatusInfo['state'], { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  conectado: { text: 'conectado', tone: 'ok' },
  caiu: { text: 'caiu', tone: 'bad' },
  chave: { text: 'chave recusada', tone: 'warn' },
  erro: { text: 'com problema', tone: 'warn' },
  'nao-conectado': { text: 'não conectado', tone: 'idle' }
}

function ago(timestamp?: number): string {
  if (!timestamp) return ''
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'agora há pouco'
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `há ${hours} h` : `há ${Math.round(hours / 24)} dias`
}

function tokens(count: number): string {
  return `${count.toLocaleString('pt-BR')} tokens`
}

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function hostNote(kind: ColabPreview['hostKind']): { text: string; tone: 'ok' | 'warn' } {
  if (kind === 'trycloudflare') return { text: 'túnel do Colab', tone: 'ok' }
  if (kind === 'loopback') return { text: 'este computador (teste)', tone: 'warn' }
  return { text: 'endereço fora do padrão', tone: 'warn' }
}

/** Settings → Provedores → "Google Colab (GPU)": the button, the connection code, and the state of the link. */
export function ColabCard({ provider, onChanged, onOpenProvider }: ColabCardProps): ReactElement {
  const [status, setStatus] = useState<ColabStatusInfo | null>(null)
  const [prepared, setPrepared] = useState<ColabPrepareInfo | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [code, setCode] = useState('')
  const [inspected, setInspected] = useState<ColabInspectResult | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [pasting, setPasting] = useState(false)
  // The code holds the access key: it is shown as dots until the user asks to see it (screenshots, shoulder surfing).
  const [reveal, setReveal] = useState(false)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [testing, setTesting] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const limitsRef = useRef<HTMLDetailsElement>(null)
  const lastState = useRef<string>('')

  const connected = Boolean(provider)

  const refresh = useCallback(
    async (fresh: boolean): Promise<void> => {
      try {
        const next = await unwrap(window.forja.app.colabStatus(fresh))
        setStatus(next)
        // The reserve learned something (a dead server is skipped): let the tiles and the reserve list show it.
        if (lastState.current && lastState.current !== next.state) await onChanged()
        lastState.current = next.state
      } catch {
        /* the next poll tries again */
      }
    },
    [onChanged]
  )

  useEffect(() => {
    if (!connected) {
      setStatus(null)
      lastState.current = ''
      return
    }
    void refresh(false)
    const timer = window.setInterval(() => void refresh(false), 20_000)
    return () => window.clearInterval(timer)
  }, [connected, refresh])

  const prepare = async (): Promise<void> => {
    setPreparing(true)
    setPrepareError('')
    try {
      setPrepared(await unwrap(window.forja.app.colabPrepare()))
    } catch (err) {
      setPrepareError(`Não consegui preparar o notebook: ${errorMessage(err)}`)
    } finally {
      setPreparing(false)
    }
  }

  const revealNotebook = async (): Promise<void> => {
    try {
      const shown = await unwrap(window.forja.app.colabRevealNotebook())
      if (!shown) setPrepareError('O arquivo do notebook não está mais na pasta: clique em “Abrir o Google Colab” de novo.')
    } catch (err) {
      setPrepareError(`Não consegui mostrar a pasta: ${errorMessage(err)}`)
    }
  }

  // O método garantido de levar o notebook ao Colab: copiar o caminho e colar em "Fazer upload → Procurar".
  const copyPath = async (): Promise<void> => {
    if (!prepared) return
    try {
      await navigator.clipboard.writeText(prepared.path)
      setCopiedPath(true)
      window.setTimeout(() => setCopiedPath(false), 2000)
    } catch {
      // O caminho continua visível no card para o usuário copiar à mão.
      setCopiedPath(false)
    }
  }

  const inspect = async (value: string): Promise<void> => {
    setConnectError('')
    if (!value.trim()) {
      setInspected(null)
      return
    }
    try {
      setInspected(await unwrap(window.forja.app.colabInspect(value)))
    } catch (err) {
      setInspected({ ok: false, error: errorMessage(err) })
    }
  }

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setConnectError('')
    try {
      const result = await unwrap(window.forja.app.colabConnect(code))
      if (!result.ok) {
        setConnectError(result.error ?? 'Não consegui conectar.')
        if (result.status) setStatus(result.status)
        return
      }
      setCode('')
      setInspected(null)
      setPasting(false)
      setStatus(result.status ?? null)
      lastState.current = result.status?.state ?? ''
      await onChanged()
    } catch (err) {
      setConnectError(errorMessage(err))
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!confirmingRemoval) {
      setConfirmingRemoval(true)
      window.setTimeout(() => setConfirmingRemoval(false), 5000)
      return
    }
    setConfirmingRemoval(false)
    try {
      setStatus(await unwrap(window.forja.app.colabDisconnect()))
      lastState.current = ''
      await onChanged()
    } catch (err) {
      setConnectError(errorMessage(err))
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    await refresh(true)
    setTesting(false)
  }

  const openLimits = (): void => {
    setLimitsOpen(true)
    window.requestAnimationFrame(() => limitsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  const showPaste = !connected || pasting || status?.state === 'caiu' || status?.state === 'chave'
  const state = status ? STATE_LABEL[status.state] : null
  const preview = inspected && inspected.ok ? inspected.preview : null

  return (
    <section className="colab-card" aria-label="Google Colab (GPU)" data-state={status?.state ?? 'nao-conectado'}>
      <header className="colab-head">
        <ProviderLogo id="colab" label="Google Colab" size={40} />
        <div className="colab-title">
          <strong>Google Colab (GPU)</strong>
          <span>Uma GPU na nuvem como provedor, com visão e ferramentas.</span>
        </div>
        {state ? <span className={`colab-status ${state.tone}`}>{state.text}</span> : null}
      </header>

      <p className="colab-lead">
        O Openclod prepara um notebook que, com um clique em <em>Executar tudo</em>, mostra os modelos abertos que cabem na GPU do Colab,
        deixa você escolher um (sem escolha, segue com o melhor), instala, baixa, sobe um servidor protegido por chave e mostra um{' '}
        <strong>código de conexão</strong>. Colado aqui, ele vira um provedor comum: aparece no seletor de modelo e entra na reserva
        automática (se o Colab cair, o Openclod segue no próximo da lista).
      </p>

      <div className="colab-warning" role="note">
        <Icon name="info" size={14} />
        <p>
          O Google pode encerrar a sessão <strong>sem aviso</strong>, e a GPU gratuita (T4) não é garantida.{' '}
          <button type="button" className="colab-link" onClick={openLimits}>
            Limites e termos do Colab
          </button>
        </p>
      </div>

      {connected && provider ? (
        <div className="colab-summary">
          <div className="colab-host" title={provider.colab?.host ?? provider.baseUrl}>
            {provider.colab?.host ?? provider.baseUrl}
          </div>
          <dl className="colab-specs">
            <div>
              <dt>Modelo</dt>
              <dd title={provider.model}>{provider.model}</dd>
            </div>
            <div>
              <dt>GPU</dt>
              <dd title={provider.colab?.gpu}>{provider.colab?.gpu || 'GPU não informada'}</dd>
            </div>
            <div>
              <dt>Contexto</dt>
              <dd>{tokens(provider.contextWindow)}</dd>
            </div>
            <div>
              <dt>Imagens</dt>
              <dd>{provider.supportsVision ? 'lê imagens' : 'só texto'}</dd>
            </div>
          </dl>
          <span className="colab-meta">
            {provider.colab?.verified ? 'notebook original' : 'notebook modificado ou de outra versão'} v{provider.colab?.notebookVersion ?? '?'}
            {provider.colab?.connectedAt ? ` · conectado ${ago(provider.colab.connectedAt)}` : ''}
            {status?.latencyMs !== undefined && status.state === 'conectado' ? ` · resposta em ${status.latencyMs} ms` : ''}
          </span>
          <div className="colab-actions">
            <button type="button" className="btn small subtle colab-test" onClick={() => void test()} disabled={testing}>
              <Icon name="refresh" size={12} /> {testing ? 'Testando…' : 'Testar agora'}
            </button>
            <button type="button" className="btn small ghost colab-reconnect" onClick={() => setPasting((current) => !current)}>
              Colar código novo
            </button>
            <button type="button" className="btn small ghost" onClick={() => onOpenProvider(provider.id)}>
              Ajustes do provedor
            </button>
            <button type="button" className={`btn small ${confirmingRemoval ? 'danger' : 'ghost'} colab-disconnect`} onClick={() => void disconnect()}>
              <Icon name="trash" size={12} /> {confirmingRemoval ? 'Confirmar: desconectar' : 'Desconectar'}
            </button>
          </div>
        </div>
      ) : null}

      {status && status.state !== 'conectado' && status.state !== 'nao-conectado' ? (
        <div className="colab-alert colab-problem" role="status">
          <Icon name="alert" size={14} />
          <span>{status.detail}</span>
        </div>
      ) : null}

      <div className="colab-open-row">
        <button type="button" className="btn small primary colab-open" onClick={() => void prepare()} disabled={preparing}>
          <Icon name="globe" size={12} /> {preparing ? 'Preparando…' : connected ? 'Abrir o Google Colab de novo' : 'Abrir o Google Colab'}
        </button>
        <p className="colab-help">Grava o notebook numa pasta sua, abre o Colab no navegador e copia o caminho do arquivo. Nada é publicado em seu nome.</p>
      </div>
      {prepareError ? (
        <div className="colab-alert" role="alert">
          <Icon name="alert" size={14} />
          <span>{prepareError}</span>
        </div>
      ) : null}

      {prepared ? (
        <div className="colab-steps">
          <div className="colab-file-row">
            <div
              className="colab-file"
              role="group"
              aria-label={`Arquivo ${prepared.fileName}`}
              title="Você pode arrastar este arquivo para o Colab (opcional) ou usar “Copiar caminho” e colar no upload"
              draggable
              onDragStart={(event) => {
                // Arrastar para dentro do Colab é opcional e instável (app→navegador); o jeito garantido é o caminho colado.
                event.preventDefault()
                window.forja.app.colabStartDrag()
              }}
            >
              <span className="colab-file-icon" aria-hidden>
                <Icon name="fileCode" size={18} />
              </span>
              <span className="colab-file-text">
                <span className="colab-file-name">{prepared.fileName}</span>
                <small>
                  {fileSize(prepared.sizeBytes)} · versão {prepared.version} · com o servidor do Openclod dentro (legível na 3ª célula)
                </small>
                <small className="colab-file-path">{prepared.path}</small>
              </span>
              <span className="colab-file-grab">Arraste (opcional)</span>
            </div>
            <div className="colab-actions">
              <button type="button" className="btn small primary colab-copy-path" onClick={() => void copyPath()}>
                <Icon name="fileCode" size={12} /> {copiedPath ? 'Caminho copiado!' : 'Copiar caminho'}
              </button>
              <button type="button" className="btn small subtle colab-reveal-file" onClick={() => void revealNotebook()}>
                <Icon name="folderOpen" size={12} /> Mostrar na pasta
              </button>
            </div>
          </div>
          <p className="colab-file-hint">
            Jeito garantido: o caminho já está copiado. No Colab, <strong>Arquivo → Fazer upload de notebook → Procurar → colar (Ctrl+V) → Abrir</strong>. Arrastar o arquivo também funciona em alguns navegadores, mas pode falhar — se falhar, use o caminho colado.
          </p>
          <ol>
            {prepared.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {!prepared.opened.colab ? (
            <div className="colab-alert" data-tone="warn">
              <Icon name="alert" size={14} />
              <span>Não consegui abrir o navegador: acesse colab.research.google.com.</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {showPaste ? (
        <div className="colab-paste">
          <div className="colab-label">
            <span>
              Código de conexão<small>o que o notebook mostra no fim</small>
            </span>
            <button type="button" className="btn tiny ghost colab-reveal" onClick={() => setReveal((current) => !current)}>
              <Icon name="eye" size={12} /> {reveal ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
          <textarea
            className={`colab-code${reveal ? '' : ' is-masked'}`}
            aria-label="Código de conexão"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder="OCLC1.…"
            value={code}
            onChange={(event) => {
              setCode(event.target.value)
              void inspect(event.target.value)
            }}
          />
          {inspected && !inspected.ok ? (
            <div className="colab-alert colab-code-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{inspected.error}</span>
            </div>
          ) : null}

          {preview ? (
            <div className="colab-preview" role="group" aria-label="Confira antes de conectar">
              <strong>Confira antes de conectar</strong>
              <dl>
                <dt>Servidor</dt>
                <dd>
                  <code>{preview.host}</code> <span className={`colab-tag ${hostNote(preview.hostKind).tone}`}>{hostNote(preview.hostKind).text}</span>
                </dd>
                <dt>Modelo</dt>
                <dd>{preview.model}</dd>
                <dt>GPU</dt>
                <dd>{preview.gpu || 'não informada'}</dd>
                <dt>Imagens</dt>
                <dd>{preview.vision ? 'sim, o modelo lê imagens' : 'não: outro modelo descreverá as imagens (relé de visão)'}</dd>
                <dt>Ferramentas</dt>
                <dd>{preview.tools ? 'sim' : 'não: o Openclod não poderá usá-lo como agente'}</dd>
                <dt>Contexto</dt>
                <dd>{tokens(preview.contextWindow)}</dd>
                <dt>Notebook</dt>
                <dd>
                  v{preview.notebookVersion}
                  {preview.engine ? ` · ${preview.engine}` : ''} ·{' '}
                  <span className={`colab-tag ${preview.verified ? 'ok' : 'warn'}`}>{preview.verified ? 'original' : 'não confere'}</span>
                  {preview.createdAt ? ` · gerado ${ago(preview.createdAt)}` : ''}
                </dd>
              </dl>
              {preview.warnings.map((warning) => (
                <div key={warning} className="colab-alert" data-tone="warn">
                  <Icon name="alert" size={14} />
                  <span>{warning}</span>
                </div>
              ))}
              <p className="colab-help">
                As conversas e os arquivos que o agente ler passarão por este servidor. Conecte só se foi você mesmo que rodou o notebook.
                {preview.replacesExisting ? ' O endereço e a chave do Colab já conectado serão substituídos.' : ''}
              </p>
              <div className="colab-actions">
                <button type="button" className="btn small primary colab-connect" onClick={() => void connect()} disabled={connecting}>
                  <Icon name="check" size={12} /> {connecting ? 'Conectando…' : 'Conectar'}
                </button>
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    setCode('')
                    setInspected(null)
                    setConnectError('')
                  }}
                  disabled={connecting}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
          {connectError ? (
            <div className="colab-alert colab-connect-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{connectError}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="colab-limits" ref={limitsRef} open={limitsOpen} onToggle={(event) => setLimitsOpen(event.currentTarget.open)}>
        <summary>Limites e termos do Colab (leia antes de depender disto)</summary>
        <ul>
          <li>
            As regras do Colab proíbem, <strong>em todos os planos</strong>, "serviços web não relacionados à computação interativa" e
            "conectar a proxies remotos"; no plano gratuito proíbem também usar o Colab principalmente por uma interface web em vez do
            notebook. Um servidor de LLM acessado de fora por um túnel pode se enquadrar nisso:{' '}
            <strong>o Google pode encerrar a sessão sem aviso</strong>. Um plano pago com saldo positivo remove as restrições do plano
            gratuito, mas não as gerais.
          </li>
          <li>A GPU gratuita (T4) não é garantida; a sessão cai por ociosidade e dura no máximo cerca de 12 h (24 h no Pro+). O endereço do túnel muda a cada execução.</li>
          <li>Use só para você: os termos também proíbem dar acesso ao Colab a terceiros. Não compartilhe o código de conexão (ele contém a chave).</li>
          <li>
            Precisa de estabilidade? Use uma GPU alugada em um serviço que permita servir modelos (confira os termos dele): o mesmo
            arquivo do notebook roda em qualquer Linux com GPU NVIDIA e gera o mesmo código.
          </li>
        </ul>
        <p>
          <a href={FAQ_URL} target="_blank" rel="noreferrer">
            FAQ do Colab
          </a>{' '}
          ·{' '}
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            Termos de uso
          </a>
        </p>
      </details>
    </section>
  )
}
