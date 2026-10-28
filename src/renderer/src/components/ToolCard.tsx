import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ToolResultPart } from '../../../shared/types'
import { Icon, type IconName } from './Icons'
import { basename, toolFamily, toolLabel } from '../lib/format'
import { formatDuration } from '../lib/activity'
import type { LiveTool } from '../lib/types'

const FAMILY_ICON: Record<string, IconName> = {
  computer: 'monitor',
  browser: 'globe',
  git: 'gitBranch',
  mcp: 'plug',
  shell: 'terminal',
  file: 'file',
  search: 'search',
  web: 'globe',
  agent: 'bot',
  default: 'hammer'
}

function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const value = args as Record<string, unknown>
  if (typeof value.command === 'string') return value.command
  if (typeof value.path === 'string') return value.path
  if (typeof value.url === 'string') return value.url
  if (typeof value.query === 'string') return value.query
  if (typeof value.app === 'string') {
    return typeof value.element_index === 'number' ? `${value.app} · elemento ${value.element_index}` : value.app
  }
  if (typeof value.label === 'string') return value.label
  if (typeof value.selector === 'string') return value.selector
  if (typeof value.prompt === 'string') return value.prompt.slice(0, 80)
  if (typeof value.text === 'string') return value.text.slice(0, 80)
  if (typeof value.pattern === 'string') return value.pattern
  const keys = Object.keys(value)
  return keys.length ? keys.map((key) => `${key}=${String(value[key]).slice(0, 40)}`).join(' · ') : ''
}

interface ToolCardProps {
  name: string
  args: unknown
  result?: ToolResultPart
  live?: LiveTool
}

export function ToolCard({ name, args, result, live }: ToolCardProps): ReactElement {
  const failed = live?.ok === false || result?.ok === false
  const running = live?.running ?? false
  const [open, setOpen] = useState(failed)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const openedForProgress = useRef(false)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  // The first live chunk opens the card once, so a long command shows its
  // output without forcing the user to expand it. Collapsing is respected.
  useEffect(() => {
    if (!running || !live?.progress || openedForProgress.current) return
    openedForProgress.current = true
    setOpen(true)
  }, [running, live?.progress])

  const family = toolFamily(name)
  const icon = FAMILY_ICON[family] ?? FAMILY_ICON.default
  const summary = live?.summary ?? result?.detail ?? summarizeArgs(name, args)
  const text = running ? (live?.text ?? result?.text ?? '') : (result?.text ?? live?.text ?? '')
  const images = result?.images ?? []
  const files = live?.files ?? []
  const data = useMemo(() => live?.data ?? {}, [live?.data])
  const elapsedMs = running && live?.startedAt ? now - live.startedAt : 0
  const sinceOutputMs = running ? now - (live?.updatedAt ?? live?.startedAt ?? now) : 0

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return (
    <div className={`tool-card ${failed ? 'failed' : ''} ${running ? 'running' : ''} family-${family}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-icon ${running ? 'spin' : ''}`}>
          <Icon name={running ? 'refresh' : icon} size={14} />
        </span>
        <span className="tool-name">{toolLabel(name)}</span>
        <span className="tool-summary" title={summary}>
          {summary}
        </span>
        {running ? (
          <span
            className="tool-live-time"
            title={sinceOutputMs > 5000 ? `Sem saída há ${formatDuration(sinceOutputMs)}` : 'Executando'}
          >
            {formatDuration(elapsedMs)}
            {sinceOutputMs > 5000 ? ' · sem saída' : ''}
          </span>
        ) : null}
        <span className={`tool-state ${failed ? 'bad' : running ? 'busy' : result ? 'good' : ''}`}>
          {failed ? <Icon name="alert" size={13} /> : result && !running ? <Icon name="check" size={13} /> : null}
        </span>
        <Icon name="chevron" size={13} className={`tool-chevron ${open ? 'open' : ''}`} />
      </button>

      {open ? (
        <div className="tool-body">
          {running ? (
            <>
              <div className="tool-section-label row">
                <span>Saída ao vivo</span>
                <span className="tool-live-meta">
                  {formatDuration(elapsedMs)}
                  {sinceOutputMs > 5000 ? ` · sem saída há ${formatDuration(sinceOutputMs)}` : ''}
                </span>
              </div>
              <pre className="tool-pre result live">{text || '(aguardando saída...)'}</pre>
            </>
          ) : null}
          <div className="tool-section-label">Argumentos</div>
          <pre className="tool-pre">{JSON.stringify(args ?? {}, null, 2)}</pre>
          {text && !running ? (
            <>
              <div className="tool-section-label row">
                <span>Resultado</span>
                <button type="button" className="link-btn" onClick={copy}>
                  <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'copiado' : 'copiar'}
                </button>
              </div>
              <pre className="tool-pre result">{text}</pre>
            </>
          ) : null}
          {images.length ? (
            <div className="tool-images">
              {images.map((image, index) => (
                <img
                  key={index}
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={image.label ?? 'captura'}
                  className="tool-shot"
                />
              ))}
            </div>
          ) : null}
          {files.length ? (
            <div className="tool-files">
              {files.slice(0, 12).map((file) => (
                <span key={file} className="chip" title={file}>
                  <Icon name="file" size={11} /> {basename(file)}
                </span>
              ))}
            </div>
          ) : null}
          {typeof data.exitCode === 'number' ? (
            <div className={`tool-exit ${data.exitCode === 0 ? 'good' : 'bad'}`}>exit code {data.exitCode}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
