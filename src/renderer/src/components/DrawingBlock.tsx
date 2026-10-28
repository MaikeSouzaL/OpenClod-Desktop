import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
import { drawingFileName, svgDataUri, svgHasIntrinsicSize, type DrawingKind } from '../lib/drawings'

interface DrawingBlockProps {
  kind: DrawingKind
  source: string
  /** Shown in the header, e.g. the file name when the drawing comes from a written file. */
  title?: string
  /** Start on the code tab instead of the picture. */
  startOnCode?: boolean
}

/** `true` when the browser's XML parser accepts the SVG; a broken one is shown as code with a note. */
function svgParses(svg: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return !doc.querySelector('parsererror')
  } catch {
    return false
  }
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function download(name: string, kind: DrawingKind, source: string): void {
  const blob = new Blob([source], { type: kind === 'svg' ? 'image/svg+xml' : 'text/html' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/**
 * What the model drew, shown on screen the way Claude does: the picture first (an SVG as an image, so its
 * own scripts and external loads cannot run; an HTML/canvas page in a sandboxed frame with no network),
 * a Code tab, copy, download and full screen. Animated SVGs (SMIL/CSS) play inside the image.
 */
export function DrawingBlock({ kind, source, title, startOnCode }: DrawingBlockProps): ReactElement {
  const [tab, setTab] = useState<'preview' | 'code'>(startOnCode ? 'code' : 'preview')
  const [dark, setDark] = useState(false)
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)
  const valid = useMemo(() => (kind === 'svg' ? svgParses(source) : true), [kind, source])
  const [broken, setBroken] = useState(false)
  const fileName = useMemo(() => drawingFileName(kind, source), [kind, source])
  const uri = useMemo(() => (kind === 'svg' ? svgDataUri(source) : ''), [kind, source])
  const sized = useMemo(() => (kind === 'svg' ? svgHasIntrinsicSize(source) : true), [kind, source])
  const failed = kind === 'svg' && (!valid || broken)

  useEffect(() => {
    if (!full) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFull(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [full])

  const picture = (big: boolean): ReactElement =>
    kind === 'svg' ? (
      <img
        className={`drawing-img ${sized ? '' : 'unsized'} ${big ? 'big' : ''}`}
        src={uri}
        alt={title ?? 'Desenho SVG'}
        draggable={false}
        onError={() => setBroken(true)}
      />
    ) : (
      <iframe
        className={`drawing-frame ${big ? 'big' : ''}`}
        title={title ?? 'Desenho em HTML'}
        sandbox="allow-scripts"
        srcDoc={source}
      />
    )

  const showing = failed ? 'code' : tab
  return (
    <figure className="drawing-block" data-kind={kind}>
      <figcaption className="drawing-head">
        <span className="drawing-title">
          <Icon name={kind === 'svg' ? 'image' : 'fileCode'} size={13} />
          {title ?? (kind === 'svg' ? 'Desenho SVG' : 'Desenho em HTML')}
        </span>
        <span className="drawing-tabs" role="tablist" aria-label="Exibição">
          <button type="button" role="tab" aria-selected={showing === 'preview'} className={showing === 'preview' ? 'active' : ''} disabled={failed} onClick={() => setTab('preview')}>
            <Icon name="eye" size={12} /> Visualizar
          </button>
          <button type="button" role="tab" aria-selected={showing === 'code'} className={showing === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
            <Icon name="fileCode" size={12} /> Código
          </button>
        </span>
        <span className="drawing-actions">
          {kind === 'svg' && showing === 'preview' ? (
            <button type="button" className="drawing-icon" title={dark ? 'Fundo claro' : 'Fundo escuro'} aria-label="Alternar o fundo" onClick={() => setDark((value) => !value)}>
              <Icon name="gauge" size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className="drawing-icon"
            title="Copiar o código"
            aria-label="Copiar o código"
            onClick={() => void copy(source).then((ok) => {
              if (!ok) return
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })}
          >
            <Icon name={copied ? 'checkCircle' : 'copy'} size={13} />
          </button>
          <button type="button" className="drawing-icon" title={`Baixar ${fileName}`} aria-label="Baixar" onClick={() => download(fileName, kind, source)}>
            <Icon name="download" size={13} />
          </button>
          {showing === 'preview' ? (
            <button type="button" className="drawing-icon" title="Tela cheia" aria-label="Tela cheia" onClick={() => setFull(true)}>
              <Icon name="external" size={13} />
            </button>
          ) : null}
        </span>
      </figcaption>
      {failed ? <div className="drawing-note">Não consegui desenhar este SVG (o XML está inválido ou incompleto). O código está abaixo.</div> : null}
      {showing === 'preview' ? (
        <div className={`drawing-stage ${dark ? 'dark' : ''}`}>{picture(false)}</div>
      ) : (
        <pre className="drawing-code"><code>{source}</code></pre>
      )}
      {full
        ? createPortal(
            <div className="drawing-overlay" role="dialog" aria-modal="true" aria-label="Desenho em tela cheia" onMouseDown={(event) => event.target === event.currentTarget && setFull(false)}>
              <div className={`drawing-overlay-card ${dark ? 'dark' : ''}`}>
                <button type="button" className="drawing-overlay-close" aria-label="Fechar" onClick={() => setFull(false)}>
                  <Icon name="x" size={16} />
                </button>
                {picture(true)}
              </div>
            </div>,
            document.body
          )
        : null}
    </figure>
  )
}
