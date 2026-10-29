import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { LlamaDownloadInfo, LlamaFit, LlamaHubFilesInfo, LlamaHubListInfo, LlamaHubRow } from '../../../shared/llamacpp'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'

const FIT: Record<LlamaFit, { text: string; tone: 'ok' | 'busy' | 'bad' | 'muted' }> = {
  gpu: { text: 'Cabe na GPU', tone: 'ok' },
  misto: { text: 'GPU + RAM (mais lento)', tone: 'busy' },
  cpu: { text: 'Só CPU', tone: 'busy' },
  nao: { text: 'Não cabe', tone: 'bad' }
}

type Filter = 'gpu' | 'roda' | 'todos'

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`
const mib = (value: number): string => `${(value / 1024).toFixed(1)} GB`
const tokens = (count: number): string => (count >= 1024 ? `${Math.round(count / 1024)}k` : String(count))
const PAGE = 60

/**
 * Configurações → Provedores → llama.cpp → Baixar modelos: the most downloaded GGUF models on Hugging Face, each with the
 * quantization that fits this computer's GPU, and the download (SHA-256 checked, resumable) that becomes the next run's model.
 */
export function LlamaCppHub({ onDownloaded }: { onDownloaded(): Promise<void> | void }): ReactElement {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<LlamaHubListInfo | null>(null)
  const [searched, setSearched] = useState<{ query: string; models: LlamaHubRow[] } | null>(null)
  const [filter, setFilter] = useState<Filter>('gpu')
  const [text, setText] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [expanded, setExpanded] = useState('')
  const [files, setFiles] = useState<Record<string, LlamaHubFilesInfo | string>>({})
  const [download, setDownload] = useState<LlamaDownloadInfo | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const finished = useRef('')

  const load = useCallback(async (refresh = false): Promise<void> => {
    try {
      const next = await unwrap(refresh ? window.openclod.app.llamacppHubRefresh() : window.openclod.app.llamacppHubList())
      setList(next)
      setDownload(next.download)
      // A machine without a GPU sees what runs on the CPU.
      if (!next.budget.vramMiB) setFilter((current) => (current === 'gpu' ? 'roda' : current))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    if (open && !list) void load()
  }, [open, list, load])

  // The first fetch of the list runs in the background: poll until it arrives.
  useEffect(() => {
    if (!open || list?.state !== 'carregando') return
    const timer = window.setInterval(() => void load(), 1_500)
    return () => window.clearInterval(timer)
  }, [open, list?.state, load])

  // A download in progress.
  useEffect(() => {
    if (!download?.active) return
    const timer = window.setInterval(async () => {
      try {
        const next = await unwrap(window.openclod.app.llamacppDownloadStatus())
        setDownload(next)
        if (!next.active && next.finished && next.finished !== finished.current) {
          finished.current = next.finished
          setFiles({})
          void load()
          await onDownloaded()
        }
      } catch {
        /* next tick */
      }
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [download?.active, load, onDownloaded])

  const rows = useMemo(() => {
    const source = searched?.models ?? list?.models ?? []
    const needle = text.trim().toLowerCase()
    return source.filter((row) => {
      if (!searched && filter === 'gpu' && row.fit !== 'gpu') return false
      if (!searched && filter === 'roda' && row.fit === 'nao') return false
      return !needle || searched || `${row.repo} ${row.arch}`.toLowerCase().includes(needle)
    })
  }, [list, searched, filter, text])

  const search = async (): Promise<void> => {
    const query = text.trim()
    setBusy('search')
    setError('')
    try {
      const result = await unwrap(window.openclod.app.llamacppHubSearch(query))
      setSearched({ query, models: result.models })
      setShown(PAGE)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  const toggle = async (repo: string): Promise<void> => {
    if (expanded === repo) return setExpanded('')
    setExpanded(repo)
    if (files[repo] && typeof files[repo] !== 'string') return
    try {
      const info = await unwrap(window.openclod.app.llamacppHubFiles(repo))
      setFiles((current) => ({ ...current, [repo]: info }))
    } catch (err) {
      setFiles((current) => ({ ...current, [repo]: errorMessage(err) }))
    }
  }

  const start = async (repo: string, name: string): Promise<void> => {
    setError('')
    try {
      setDownload(await unwrap(window.openclod.app.llamacppDownload(repo, name)))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const cancel = async (): Promise<void> => {
    try {
      setDownload(await unwrap(window.openclod.app.llamacppDownloadCancel()))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const budget = list?.budget
  const percent = download?.total ? Math.min(100, Math.round((download.done / download.total) * 100)) : 0

  return (
    <details className="llama-hub" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="download" size={13} /> Baixar modelos do Hugging Face
      </summary>

      {!list ? (
        <p className="llama-meta">Lendo a lista…</p>
      ) : (
        <div className="llama-hub-body">
          <div className="llama-hub-machine">
            <span>
              {budget?.vramMiB ? (
                <>
                  <strong>{budget.gpu}</strong> · {mib(budget.vramMiB)} de VRAM
                </>
              ) : (
                <strong>Sem GPU que o llama.cpp use</strong>
              )}{' '}
              · {mib(budget?.ramMiB ?? 0)} de RAM · contexto {tokens(list.ctx)}
            </span>
            <button type="button" className="btn small ghost" onClick={() => void load(true)} disabled={list.state === 'carregando'}>
              <Icon name="refresh" size={12} /> {list.state === 'carregando' ? 'Atualizando…' : 'Atualizar lista'}
            </button>
          </div>
          <p className="llama-meta">
            Os mais baixados do Hugging Face em GGUF que este llama.cpp abre. Para cada um, a melhor quantização que cabe na sua GPU com o
            contexto escolhido acima (tamanhos estimados; os exatos aparecem em <em>Ver arquivos</em>).
          </p>

          <div className="llama-hub-tools">
            <input
              type="search"
              value={text}
              placeholder="Filtrar, ou procurar no Hugging Face…"
              onChange={(event) => {
                setText(event.target.value)
                setShown(PAGE)
                if (!event.target.value) setSearched(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && text.trim().length >= 2) void search()
              }}
            />
            <button type="button" className="btn small ghost" onClick={() => void search()} disabled={busy === 'search' || text.trim().length < 2}>
              <Icon name="search" size={12} /> {busy === 'search' ? 'Procurando…' : 'No Hugging Face'}
            </button>
            {!searched ? (
              <span className="llama-hub-filter" role="radiogroup" aria-label="Quais modelos mostrar">
                {(
                  [
                    ['gpu', 'Cabe na GPU'],
                    ['roda', 'Roda aqui'],
                    ['todos', 'Todos']
                  ] as Array<[Filter, string]>
                ).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={filter === value} className={filter === value ? 'on' : undefined} onClick={() => setFilter(value)}>
                    {label}
                  </button>
                ))}
              </span>
            ) : (
              <button type="button" className="btn small subtle" onClick={() => setSearched(null)}>
                Voltar à lista
              </button>
            )}
          </div>

          {download && (download.active || download.error || download.finished) ? (
            <div className={`llama-hub-download${download.error ? ' bad' : ''}`} role="status">
              {download.active ? (
                <>
                  <div className="llama-hub-download-line">
                    <span>
                      Baixando <strong>{download.file || download.name}</strong>
                      {download.total ? ` · ${gigabytes(download.done)} de ${gigabytes(download.total)} (${percent}%)` : ''}
                    </span>
                    <button type="button" className="btn small subtle" onClick={() => void cancel()}>
                      Cancelar
                    </button>
                  </div>
                  <div className="llama-hub-bar">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </>
              ) : download.error ? (
                <span>{download.error}</span>
              ) : (
                <span>
                  Baixado e conferido (SHA-256): <strong>{download.name}</strong>. Ele já é o modelo escolhido acima; clique em Iniciar.
                </span>
              )}
            </div>
          ) : null}

          {list.error ? <p className="llama-meta">{list.error}</p> : null}
          {error ? (
            <div className="llama-problem" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          ) : null}

          {list.state === 'carregando' && !list.models.length ? (
            <p className="llama-meta">Buscando a lista no Hugging Face…</p>
          ) : rows.length ? (
            <ul className="llama-hub-list">
              {rows.slice(0, shown).map((row) => {
                const info = files[row.repo]
                return (
                  <li key={row.repo} className={expanded === row.repo ? 'open' : undefined}>
                    <div className="llama-hub-row">
                      <div className="llama-hub-text">
                        <span className="llama-hub-name" title={row.repo}>
                          {row.name}
                          <span className="llama-meta"> · {row.author}</span>
                        </span>
                        <span className="llama-meta">
                          {row.paramsGuess ? '~' : ''}
                          {row.params}B · {row.arch}
                          {row.moe ? ' · MoE' : ''}
                          {row.context ? ` · treino ${tokens(row.context)}` : ''}
                          {row.vision ? ' · visão' : ''}
                          {row.tools ? ' · ferramentas' : ''}
                          {row.thinking ? ' · raciocínio' : ''}
                          {row.local.length ? ' · baixado' : ''}
                        </span>
                      </div>
                      <span className={`llama-fit ${FIT[row.fit].tone}`} title={`${row.quant} · ${gigabytes(row.bytes)} (estimado)`}>
                        {FIT[row.fit].text} · {row.quant} {gigabytes(row.bytes)}
                      </span>
                      <button type="button" className="btn small ghost" onClick={() => void toggle(row.repo)} aria-expanded={expanded === row.repo}>
                        {expanded === row.repo ? 'Fechar' : 'Ver arquivos'}
                      </button>
                    </div>
                    {expanded === row.repo ? (
                      <div className="llama-hub-files">
                        {!info ? (
                          <span className="llama-meta">Lendo os arquivos do repositório…</span>
                        ) : typeof info === 'string' ? (
                          <span className="llama-meta">{info}</span>
                        ) : (
                          <>
                            {info.gated ? (
                              <span className="llama-meta">
                                Este modelo exige aceitar a licença no Hugging Face antes de baixar.{' '}
                                <a href={info.url} target="_blank" rel="noreferrer">
                                  Abrir a página
                                </a>
                              </span>
                            ) : null}
                            <table>
                              <tbody>
                                {info.files.map((file) => (
                                  <tr key={file.name} className={file.name === info.suggested ? 'suggested' : undefined}>
                                    <td title={file.name}>
                                      {file.quant || file.name}
                                      {file.name === info.suggested ? <em> sugerido</em> : null}
                                    </td>
                                    <td>{gigabytes(file.bytes)}</td>
                                    <td>
                                      <span className={`llama-fit ${FIT[file.fit].tone}`}>{FIT[file.fit].text}</span>
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className={`btn small ${file.name === info.suggested ? 'primary' : 'subtle'}`}
                                        onClick={() => void start(row.repo, file.name)}
                                        disabled={Boolean(download?.active) || info.gated}
                                      >
                                        {file.local ? 'Usar' : 'Baixar e usar'}
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <span className="llama-meta">
                              {info.mmproj ? `Com o projetor de visão ${info.mmproj.name} (${gigabytes(info.mmproj.bytes)}), baixado junto. ` : ''}
                              {row.license ? `Licença: ${row.license}. ` : ''}
                              <a href={info.url} target="_blank" rel="noreferrer">
                                Abrir no Hugging Face
                              </a>
                            </span>
                          </>
                        )}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="llama-meta">
              {searched ? `Nada para "${searched.query}" que este llama.cpp abra.` : 'Nenhum modelo neste filtro. Tente "Roda aqui" ou "Todos".'}
            </p>
          )}
          {rows.length > shown ? (
            <button type="button" className="btn small ghost" onClick={() => setShown((count) => count + PAGE)}>
              Mostrar mais ({rows.length - shown})
            </button>
          ) : null}
        </div>
      )}
    </details>
  )
}
