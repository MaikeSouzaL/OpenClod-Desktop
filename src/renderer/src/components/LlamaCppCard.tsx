import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { LlamaCppProfile, LlamaCppStatusInfo, LlamaLocalModel, LlamaServerState } from '../../../shared/llamacpp'
import { Icon } from './Icons'
import { LlamaCppBuilds } from './LlamaCppBuilds'
import { LlamaCppHub } from './LlamaCppHub'
import { LlamaCppOptions } from './LlamaCppOptions'
import { ProviderLogo } from './ProviderLogo'
import { errorMessage, unwrap } from '../lib/api'
import './llamacpp-card.css'

const STATE: Record<LlamaServerState, { text: string; tone: 'ok' | 'busy' | 'bad' | 'muted' }> = {
  parado: { text: 'Parado', tone: 'muted' },
  iniciando: { text: 'Carregando o modelo…', tone: 'busy' },
  pronto: { text: 'Pronto', tone: 'ok' },
  erro: { text: 'Erro', tone: 'bad' }
}

/** The harness prompt base is ~9k tokens: 8k is only for chat, 32k is the default. */
const CONTEXTS = [8_192, 16_384, 32_768, 65_536, 131_072]

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`
const tokens = (count: number): string => (count >= 1024 ? `${Math.round(count / 1024)}k` : String(count))

type Busy = '' | 'pick' | 'save' | 'start' | 'stop' | 'folder' | 'profile'

/**
 * Configurações → Provedores → llama.cpp (local): picks a GGUF, starts llama.cpp's own server on this computer and shows it
 * running. While it is up it is the `llamacpp` provider in the model picker; no Ollama has to be installed or running.
 */
export function LlamaCppCard({ onChanged }: { onChanged(): Promise<void> | void }): ReactElement {
  const [status, setStatus] = useState<LlamaCppStatusInfo | null>(null)
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const logSeq = useRef(0)
  const lastState = useRef('')
  const [models, setModels] = useState<LlamaLocalModel[] | null>(null)
  /** The inline form of the profile bar: a new name or a rename. */
  const [naming, setNaming] = useState<{ kind: 'create' | 'rename'; text: string } | null>(null)
  const [searching, setSearching] = useState(false)

  const search = useCallback(async (): Promise<void> => {
    setSearching(true)
    try {
      setModels(await unwrap(window.openclod.app.llamacppModels()))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    void search()
  }, [search])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await unwrap(window.openclod.app.llamacppStatus())
      setStatus(next)
      // Ready, stopped or crashed: the provider list changed, so the tiles and the model picker reload.
      if (lastState.current && lastState.current !== next.state) await onChanged()
      lastState.current = next.state
    } catch {
      /* the next poll tries again */
    }
  }, [onChanged])

  const state = status?.state ?? 'parado'
  // Fast while the model loads, slow otherwise.
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), state === 'iniciando' ? 1_000 : 5_000)
    return () => window.clearInterval(timer)
  }, [refresh, state])

  // The server log, only while its panel is open.
  useEffect(() => {
    if (!logOpen) return
    let alive = true
    const read = async (): Promise<void> => {
      try {
        const next = await unwrap(window.openclod.app.llamacppLog(logSeq.current))
        if (!alive) return
        if (next.lines.length) setLog((current) => [...current, ...next.lines].slice(-400))
        logSeq.current = next.seq
      } catch {
        /* next tick */
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), 1_500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [logOpen])

  const act = async (kind: Busy, run: () => Promise<LlamaCppStatusInfo | null>): Promise<void> => {
    setBusy(kind)
    setError('')
    try {
      const next = await run()
      if (next) setStatus(next)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  const pick = (): Promise<void> =>
    act('pick', async () => {
      const model = await unwrap(window.openclod.app.llamacppPickModel())
      return model ? unwrap(window.openclod.app.llamacppSetProfile({ model: model.path })) : null
    })
  const save = (patch: Partial<LlamaCppProfile>): Promise<void> => act('save', () => unwrap(window.openclod.app.llamacppSetProfile(patch)))
  const addFolder = (): Promise<void> =>
    act('folder', async () => {
      const folder = await unwrap(window.openclod.app.llamacppPickFolder())
      if (!folder || !status) return null
      const next = await unwrap(window.openclod.app.llamacppSetProfile({ folders: [...status.profile.folders, folder] }))
      void search()
      return next
    })
  const removeFolder = (folder: string): Promise<void> =>
    act('folder', async () => {
      if (!status) return null
      const next = await unwrap(window.openclod.app.llamacppSetProfile({ folders: status.profile.folders.filter((item) => item !== folder) }))
      void search()
      return next
    })
  const profileAction = (action: { kind: 'select' | 'create' | 'rename' | 'delete'; name: string; to?: string }): Promise<void> =>
    act('profile', async () => {
      const next = await unwrap(window.openclod.app.llamacppProfileAction(action))
      setNaming(null)
      return next
    })
  const start = (): Promise<void> => act('start', () => unwrap(window.openclod.app.llamacppStart()))
  const stop = (): Promise<void> => act('stop', () => unwrap(window.openclod.app.llamacppStop()))

  const running = state === 'iniciando' || state === 'pronto'
  const chip = STATE[state]
  const model = status?.model
  const problem = error || (state === 'erro' ? status?.error : '') || ''
  const contexts = status && !CONTEXTS.includes(status.profile.ctxSize) ? [...CONTEXTS, status.profile.ctxSize].sort((a, b) => a - b) : CONTEXTS

  return (
    <section className="llama-card" aria-label="llama.cpp (local)" data-state={state}>
      <header className="llama-head">
        <ProviderLogo id="llamacpp" label="llama.cpp" size={40} />
        <div className="llama-title">
          <strong>llama.cpp (local)</strong>
          <span>O motor do llama.cpp roda neste computador: sem Ollama, sem nuvem, com a sua GPU.</span>
        </div>
        {status?.available ? <span className={`llama-status ${chip.tone}`}>{chip.text}</span> : null}
      </header>

      {!status ? (
        <p className="llama-meta">Lendo o estado do llama.cpp…</p>
      ) : !status.available ? (
        <div className="llama-problem" role="alert">
          <Icon name="alert" size={14} />
          <span>{status.reason}</span>
        </div>
      ) : (
        <>
          <div className="llama-profiles" aria-label="Perfis do llama.cpp">
            <span className="llama-meta">Perfil</span>
            {naming ? (
              <form
                className="llama-profile-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void profileAction(
                    naming.kind === 'create' ? { kind: 'create', name: naming.text } : { kind: 'rename', name: status.activeProfile, to: naming.text }
                  )
                }}
              >
                <input
                  autoFocus
                  value={naming.text}
                  maxLength={40}
                  placeholder={naming.kind === 'create' ? 'Nome do novo perfil' : 'Novo nome'}
                  onChange={(event) => setNaming({ ...naming, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setNaming(null)
                  }}
                />
                <button type="submit" className="btn small primary" disabled={!naming.text.trim() || Boolean(busy)}>
                  {naming.kind === 'create' ? 'Criar' : 'Renomear'}
                </button>
                <button type="button" className="btn small subtle" onClick={() => setNaming(null)}>
                  Cancelar
                </button>
              </form>
            ) : (
              <>
                <select
                  value={status.activeProfile}
                  onChange={(event) => void profileAction({ kind: 'select', name: event.target.value })}
                  disabled={Boolean(busy)}
                  title="Cada perfil guarda um modelo, o contexto e as opções do servidor"
                >
                  {status.profiles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn small ghost" onClick={() => setNaming({ kind: 'create', text: '' })} disabled={Boolean(busy)} title="Cria um perfil copiando o atual">
                  <Icon name="plus" size={12} /> Novo
                </button>
                <button type="button" className="btn small ghost" onClick={() => setNaming({ kind: 'rename', text: status.activeProfile })} disabled={Boolean(busy)}>
                  <Icon name="pencil" size={12} /> Renomear
                </button>
                {status.profiles.length > 1 ? (
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => void profileAction({ kind: 'delete', name: status.activeProfile })}
                    disabled={Boolean(busy)}
                    aria-label={`Apagar o perfil ${status.activeProfile}`}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                ) : null}
              </>
            )}
          </div>

          <p className="llama-lead">
            Escolha um modelo <strong>.gguf</strong> e clique em <em>Iniciar</em>. O Openclod sobe o servidor do llama.cpp ({status.build?.label}) só
            neste computador (127.0.0.1), protegido por uma chave, e ele aparece no seletor de modelo como <strong>llama.cpp (local)</strong>. Os
            modelos que o Ollama já baixou servem direto, sem o Ollama rodando.
          </p>

          <div className="llama-model">
            {model ? (
              <>
                <div className="llama-model-name">
                  <Icon name="cpu" size={14} />
                  <span title={model.name}>{model.name}</span>
                </div>
                <div className="llama-model-path" title={model.path}>
                  {model.path}
                </div>
                <div className="llama-tags">
                  {model.sizeLabel ? <span>{model.sizeLabel}</span> : null}
                  {model.quant ? <span>{model.quant}</span> : null}
                  <span>{gigabytes(model.bytes)}</span>
                  {model.context ? <span>treino {tokens(model.context)}</span> : null}
                  <span>{model.tools ? 'ferramentas' : 'sem ferramentas'}</span>
                  {model.thinking ? <span>raciocínio</span> : null}
                  {status.profile.mmproj ?? model.mmproj ? <span>visão</span> : null}
                </div>
              </>
            ) : (
              <span className="llama-meta">Nenhum modelo escolhido ainda.</span>
            )}
          </div>

          <div className="llama-found" aria-label="Modelos neste computador">
            <div className="llama-found-head">
              <strong>Modelos neste computador</strong>
              {models ? <span className="llama-meta">{models.length}</span> : null}
              <span className="llama-found-tools">
                <button type="button" className="btn small ghost" onClick={() => void search()} disabled={searching} title="Procurar de novo">
                  <Icon name="refresh" size={12} /> {searching ? 'Procurando…' : 'Procurar'}
                </button>
                <button type="button" className="btn small ghost llama-add-folder" onClick={() => void addFolder()} disabled={Boolean(busy)}>
                  <Icon name="plus" size={12} /> Pasta
                </button>
                <button type="button" className="btn small ghost llama-pick" onClick={() => void pick()} disabled={Boolean(busy) || running}>
                  <Icon name="folderOpen" size={12} /> {busy === 'pick' ? 'Lendo…' : 'Arquivo .gguf'}
                </button>
              </span>
            </div>
            {models === null ? (
              <span className="llama-meta">Procurando modelos…</span>
            ) : models.length ? (
              <ul className="llama-found-list">
                {models.map((item) => {
                  const current = item.path === status.profile.model
                  return (
                    <li key={item.path} className={current ? 'current' : undefined}>
                      <div className="llama-found-text">
                        <span className="llama-found-name" title={item.path}>
                          {item.name}
                        </span>
                        <span className="llama-meta">
                          {item.source} · {gigabytes(item.bytes)}
                          {item.mmproj ? ' · visão' : ''}
                        </span>
                      </div>
                      {current ? (
                        <span className="llama-found-current">Em uso</span>
                      ) : (
                        <button type="button" className="btn small subtle llama-use" onClick={() => void save({ model: item.path })} disabled={Boolean(busy) || running}>
                          Usar
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <span className="llama-meta">
                Nenhum .gguf encontrado. O Openclod procura nos modelos do Ollama, do LM Studio, no cache do Hugging Face e do llama.cpp, em ~/models,
                em Downloads e nas pastas que você adicionar.
              </span>
            )}
            {status.profile.folders.length ? (
              <div className="llama-folders">
                {status.profile.folders.map((folder) => (
                  <span key={folder} className="llama-folder" title={folder}>
                    <Icon name="folder" size={11} />
                    <span>{folder}</span>
                    <button type="button" aria-label={`Tirar ${folder} da busca`} onClick={() => void removeFolder(folder)} disabled={Boolean(busy)}>
                      <Icon name="x" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <LlamaCppHub
            onDownloaded={async () => {
              await refresh()
              await search()
            }}
          />

          <LlamaCppOptions status={status} onSaved={setStatus} />

          <LlamaCppBuilds
            status={status}
            onChanged={async (next) => {
              if (next) setStatus(next)
              else await refresh()
            }}
          />

          <div className="llama-fields">
            <label title="Tokens que cada pedido pode usar. O Openclod precisa de 32k ou mais para trabalhar como agente.">
              Contexto
              <select value={status.profile.ctxSize} onChange={(event) => void save({ ctxSize: Number(event.target.value) })} disabled={Boolean(busy) || running}>
                {contexts.map((value) => (
                  <option key={value} value={value}>
                    {tokens(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input type="checkbox" checked={status.profile.autostart} onChange={(event) => void save({ autostart: event.target.checked })} disabled={Boolean(busy)} />
              Iniciar com o Openclod
            </label>
          </div>

          {state === 'pronto' ? (
            <dl className="llama-specs">
              <div>
                <dt>Endereço</dt>
                <dd>127.0.0.1:{status.port}</dd>
              </div>
              <div>
                <dt>Contexto aberto</dt>
                <dd>{status.nCtx ? tokens(status.nCtx) : '—'}</dd>
              </div>
              <div>
                <dt>Camadas na GPU</dt>
                <dd>{status.offload || (status.device ? '—' : 'só CPU')}</dd>
              </div>
              {status.device ? (
                <div>
                  <dt>Placa</dt>
                  <dd title={status.device}>
                    {status.device}
                    {status.deviceMiB ? ` · ${gigabytes(status.deviceMiB * 1_048_576)} de VRAM` : ''}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Velocidade</dt>
                <dd>{status.speed.gen ? `${status.speed.gen} tok/s` : 'na 1ª resposta'}</dd>
              </div>
              <div>
                <dt>Imagens</dt>
                <dd>{status.vision ? 'lê imagens' : 'só texto'}</dd>
              </div>
            </dl>
          ) : null}

          {problem ? (
            <div className="llama-problem" role="alert">
              <Icon name="alert" size={14} />
              <span>{problem}</span>
            </div>
          ) : null}

          <div className="llama-actions">
            {running ? (
              <button type="button" className="btn small subtle llama-stop" onClick={() => void stop()} disabled={busy === 'stop'}>
                <Icon name="stop" size={12} /> {busy === 'stop' ? 'Parando…' : 'Parar'}
              </button>
            ) : (
              <button type="button" className="btn small primary llama-start" onClick={() => void start()} disabled={!model || Boolean(busy)}>
                <Icon name="play" size={12} /> {busy === 'start' ? 'Iniciando…' : 'Iniciar'}
              </button>
            )}
            {status.build ? <span className="llama-meta">{status.build.label}{status.serverBuild ? ` · ${status.serverBuild}` : ''}</span> : null}
          </div>

          <details className="llama-log" onToggle={(event) => setLogOpen(event.currentTarget.open)}>
            <summary>Log do servidor</summary>
            <pre>{log.length ? log.join('\n') : 'Sem linhas ainda.'}</pre>
          </details>
        </>
      )}
    </section>
  )
}
