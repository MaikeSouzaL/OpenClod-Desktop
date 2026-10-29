import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { LlamaBuildDownloadInfo, LlamaCppStatusInfo, LlamaMachineInfo } from '../../../shared/llamacpp'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'

const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`

/**
 * Configurações → Provedores → llama.cpp → Versões: the Vulkan build that ships with the app (any GPU) and the official
 * builds from GitHub — CUDA is the fastest on NVIDIA when the driver accepts it. Each download is checked against the
 * SHA-256 GitHub publishes; the build in use changes on the next start.
 */
export function LlamaCppBuilds({ status, onChanged }: { status: LlamaCppStatusInfo; onChanged(next?: LlamaCppStatusInfo): Promise<void> | void }): ReactElement {
  const [open, setOpen] = useState(false)
  const [machine, setMachine] = useState<LlamaMachineInfo | null>(null)
  const [download, setDownload] = useState<LlamaBuildDownloadInfo | null>(null)
  const [error, setError] = useState('')
  const finished = useRef('')

  const loadMachine = useCallback(async (): Promise<void> => {
    try {
      setMachine(await unwrap(window.openclod.app.llamacppMachine()))
      setDownload(await unwrap(window.openclod.app.llamacppBuildStatus()))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    if (open && !machine) void loadMachine()
  }, [open, machine, loadMachine])

  useEffect(() => {
    if (!download?.active) return
    const timer = window.setInterval(async () => {
      try {
        const next = await unwrap(window.openclod.app.llamacppBuildStatus())
        setDownload(next)
        if (!next.active && next.finished && next.finished !== finished.current) {
          finished.current = next.finished
          // The build just installed is the one the next start runs.
          await onChanged(await unwrap(window.openclod.app.llamacppBuildSelect(next.finished)))
        }
      } catch {
        /* next tick */
      }
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [download?.active, onChanged])

  const run = async (call: () => Promise<LlamaCppStatusInfo>): Promise<void> => {
    setError('')
    try {
      await onChanged(await call())
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const install = async (kind: string): Promise<void> => {
    setError('')
    try {
      setDownload(await unwrap(window.openclod.app.llamacppBuildInstall(kind, 'newest')))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const running = status.state === 'iniciando' || status.state === 'pronto'
  const percent = download?.total ? Math.min(100, Math.round((download.done / download.total) * 100)) : 0
  const nvidia = machine?.gpus[0]

  return (
    <details className="llama-section" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="cpu" size={13} /> Versões do llama.cpp
        <span className="llama-count">{status.build?.label}</span>
      </summary>
      <div className="llama-section-body">
        {!machine ? (
          <p className="llama-meta">Lendo a placa de vídeo…</p>
        ) : nvidia ? (
          <p className="llama-meta">
            <strong>{nvidia.name}</strong> · driver {machine.driver ?? '?'} · aceita CUDA até {machine.cudaMax ?? '?'}. Sugerida:{' '}
            <strong>{machine.kinds.find((kind) => kind.kind === machine.suggested)?.label}</strong>.
          </p>
        ) : (
          <p className="llama-meta">Nenhuma placa NVIDIA: a versão Vulkan (embutida) roda em AMD, Intel e na CPU.</p>
        )}

        <ul className="llama-builds">
          {status.builds.map((build) => {
            const current = build.id === status.build?.id
            return (
              <li key={build.id} className={current ? 'current' : undefined}>
                <span>
                  <strong>{build.label}</strong>
                  <span className="llama-meta">{build.bundled ? ' · embutida' : ' · baixada'}</span>
                </span>
                {current ? (
                  <span className="llama-found-current">Em uso{running ? '' : ' no próximo início'}</span>
                ) : (
                  <span className="llama-actions">
                    <button type="button" className="btn small subtle" onClick={() => void run(() => unwrap(window.openclod.app.llamacppBuildSelect(build.id)))}>
                      Usar
                    </button>
                    {!build.bundled ? (
                      <button type="button" className="btn small ghost" aria-label={`Remover ${build.label}`} onClick={() => void run(() => unwrap(window.openclod.app.llamacppBuildRemove(build.id)))}>
                        <Icon name="trash" size={12} />
                      </button>
                    ) : null}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        {running ? <p className="llama-meta">A troca de versão vale quando o servidor iniciar de novo.</p> : null}

        {machine ? (
          <div className="llama-kinds">
            {machine.kinds
              .filter((kind) => kind.kind !== 'vulkan')
              .map((kind) => (
                <div key={kind.kind} className={`llama-kind${kind.kind === machine.suggested ? ' suggested' : ''}`}>
                  <span>
                    <strong>{kind.label}</strong>
                    {kind.kind === machine.suggested ? <em> sugerida</em> : null}
                    <span className="llama-meta"> · {kind.note}</span>
                  </span>
                  <button type="button" className="btn small ghost" onClick={() => void install(kind.kind)} disabled={Boolean(download?.active) || !kind.runs} title={kind.runs ? undefined : 'O driver desta máquina não roda esta versão.'}>
                    <Icon name="download" size={12} /> {kind.runs ? 'Baixar a mais nova' : 'Não roda aqui'}
                  </button>
                </div>
              ))}
          </div>
        ) : null}

        {download && (download.active || download.error) ? (
          <div className={`llama-hub-download${download.error ? ' bad' : ''}`} role="status">
            {download.active ? (
              <>
                <div className="llama-hub-download-line">
                  <span>
                    {download.id}: <strong>{download.file}</strong>
                    {download.total ? ` · ${megabytes(download.done)} de ${megabytes(download.total)} (${percent}%)` : ''}
                  </span>
                  <button type="button" className="btn small subtle" onClick={() => void unwrap(window.openclod.app.llamacppBuildCancel()).then(setDownload)}>
                    Cancelar
                  </button>
                </div>
                <div className="llama-hub-bar">
                  <span style={{ width: `${percent}%` }} />
                </div>
              </>
            ) : (
              <span>{download.error}</span>
            )}
          </div>
        ) : null}
        {error ? (
          <div className="llama-problem" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </details>
  )
}
