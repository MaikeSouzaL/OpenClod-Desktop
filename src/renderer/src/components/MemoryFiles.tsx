import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { MemoryAddJobInfo, MemoryFileInfo, MemoryStatsInfo } from '../../../shared/api'
import { Icon, type IconName } from './Icons'
import { unwrap } from '../lib/api'
import './memory-files.css'

/** The kinds of file the memory keeps, in the order the screen shows them. */
export const MEMORY_KINDS: Array<{ kind: string; label: string; icon: IconName }> = [
  { kind: 'imagem', label: 'imagens', icon: 'image' },
  { kind: 'pdf', label: 'PDFs', icon: 'file' },
  { kind: 'documento', label: 'documentos', icon: 'file' },
  { kind: 'planilha', label: 'planilhas', icon: 'file' },
  { kind: 'apresentacao', label: 'apresentações', icon: 'file' },
  { kind: 'texto', label: 'textos', icon: 'fileCode' },
  { kind: 'codigo', label: 'código', icon: 'fileCode' },
  { kind: 'audio', label: 'áudios', icon: 'mic' },
  { kind: 'video', label: 'vídeos', icon: 'camera' },
  { kind: 'arquivo', label: 'outros arquivos', icon: 'archive' }
]

/** What the page grid shows: everything, only the wiki pages, or one kind of file. */
export type MemoryFilter = 'tudo' | 'paginas' | string

/** Shown even at zero: whether the memory has pictures, PDFs, documents, sheets, audio and video is what people look for. */
const ALWAYS_SHOWN = new Set(['imagem', 'pdf', 'documento', 'planilha', 'audio', 'video'])

/**
 * Counters of the files in the memory, by kind, with how many of them the agent finds at any time (their text, transcript
 * or description is in the index) and how many lost the file on disk. A click filters the grid by that kind.
 */
export function MemoryKindBar({
  counts,
  index,
  filter,
  onFilter
}: {
  counts: Record<string, number>
  index?: MemoryStatsInfo['fileIndex']
  filter: MemoryFilter
  onFilter(next: MemoryFilter): void
}): ReactElement | null {
  const totalOf = (kind: string): number => index?.[kind]?.total ?? counts[kind] ?? 0
  const kinds = MEMORY_KINDS.filter((item) => ALWAYS_SHOWN.has(item.kind) || totalOf(item.kind))
  const total = MEMORY_KINDS.reduce((sum, item) => sum + totalOf(item.kind), 0)
  const indexed = MEMORY_KINDS.reduce((sum, item) => sum + (index?.[item.kind]?.indexed ?? 0), 0)
  return (
    <div className="memory-files-summary">
      <div className="memory-files-head">
        <strong>Arquivos na memória</strong>
        <span className="muted">
          {total
            ? `${total.toLocaleString('pt-BR')} guardado(s) · ${indexed.toLocaleString('pt-BR')} indexado(s): o agente acha pelo texto, pela transcrição ou pela descrição, a qualquer momento`
            : 'Nenhum arquivo guardado ainda: use “Guardar arquivos” ou peça ao agente (memory_file).'}
        </span>
      </div>
      <div className="memory-kinds" role="toolbar" aria-label="Arquivos na memória">
        <button type="button" className={filter === 'tudo' ? 'on' : ''} onClick={() => onFilter('tudo')}>
          Tudo
        </button>
        <button type="button" className={filter === 'paginas' ? 'on' : ''} onClick={() => onFilter('paginas')}>
          <Icon name="file" size={12} /> Páginas
        </button>
        {kinds.map((item) => {
          const count = totalOf(item.kind)
          const entry = index?.[item.kind]
          return (
            <button
              key={item.kind}
              type="button"
              className={`${filter === item.kind ? 'on' : ''}${count ? '' : ' empty'}`}
              disabled={!count}
              onClick={() => onFilter(filter === item.kind ? 'tudo' : item.kind)}
              data-kind={item.kind}
              title={
                entry
                  ? `${entry.total} guardado(s), ${entry.indexed} com texto, transcrição ou descrição no índice${entry.missing ? `, ${entry.missing} sem o arquivo no disco (só o texto ficou)` : ''}`
                  : undefined
              }
            >
              <Icon name={item.icon} size={12} />
              <strong>{count.toLocaleString('pt-BR')}</strong> {item.label}
              {entry && count ? (
                <small className={entry.missing || entry.indexed < entry.total ? 'warn' : ''}>
                  {entry.indexed === entry.total ? 'todos indexados' : `${entry.indexed.toLocaleString('pt-BR')} indexado(s)`}
                  {entry.missing ? ` · ${entry.missing.toLocaleString('pt-BR')} sem arquivo` : ''}
                </small>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A file's thumbnail, fetched when the card scrolls into view. */
export function MemoryThumb({ projectId, slug, large = false }: { projectId: string; slug: string; large?: boolean }): ReactElement {
  const [src, setSrc] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = box.current
    if (!node) return
    let alive = true
    const load = (): void => {
      void unwrap(window.openclod.memory.fileThumb(projectId, slug))
        .then((value) => alive && setSrc(value))
        .catch(() => undefined)
    }
    if (typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        alive = false
      }
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect()
        load()
      }
    })
    observer.observe(node)
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [projectId, slug])
  return (
    <div ref={box} className={`memory-thumb${large ? ' large' : ''}`}>
      {src ? <img src={src} alt="" draggable={false} /> : <Icon name="image" size={large ? 22 : 16} />}
    </div>
  )
}

const human = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`

/** One file of the memory in the grid: its picture, name, kind and the start of its description. */
export function MemoryFileCard({ projectId, file, onOpen }: { projectId: string; file: MemoryFileInfo; onOpen(slug: string): void }): ReactElement {
  const kind = MEMORY_KINDS.find((item) => item.kind === file.kind)
  return (
    <div className="memory-card memory-file-card" data-slug={file.slug} data-kind={file.kind}>
      <button type="button" className="memory-card-open" onClick={() => onOpen(file.slug)}>
        {file.thumb ? (
          <MemoryThumb projectId={projectId} slug={file.slug} />
        ) : (
          <div className="memory-thumb">
            <Icon name={kind?.icon ?? 'file'} size={18} />
          </div>
        )}
        <div className="memory-card-head">
          <strong title={file.name}>{file.name}</strong>
        </div>
        <p>{file.description || (file.kind === 'imagem' ? 'Sem descrição ainda.' : `${file.textChars ? `${file.textChars.toLocaleString('pt-BR')} caracteres de texto` : 'Guardado na memória'}.`)}</p>
        <div className="memory-card-foot">
          <span>{new Date(file.added).toLocaleDateString('pt-BR')}</span>
          <span className="memory-tag">{kind?.label.replace(/s$/, '') ?? file.kind}</span>
          <span className="memory-tag">{file.width && file.height ? `${file.width}×${file.height}` : file.pages ? `${file.pages} pág.` : human(file.bytes)}</span>
          {file.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="memory-tag">
              {tag}
            </span>
          ))}
        </div>
      </button>
    </div>
  )
}

/** The bar shown while files are being saved, and what happened when it ends. */
export function MemoryAddBanner({ job }: { job: MemoryAddJobInfo }): ReactElement {
  const percent = job.total ? Math.round((job.done / job.total) * 100) : 0
  return (
    <div className={`memory-add${job.failed.length && !job.active ? ' warn' : ''}`} role="status">
      {job.active ? (
        <>
          <span>
            Guardando na memória: <strong>{job.done}</strong> de {job.total || '…'} · {job.current}
          </span>
          <div className="memory-add-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
        </>
      ) : (
        <span>
          {job.added} arquivo(s) guardado(s){job.cached ? `, ${job.cached} já estava(m)` : ''}, {job.described} com descrição
          {job.failed.length ? `; ${job.failed.length} não deu (${job.failed.slice(0, 2).join('; ')})` : ''}.
        </span>
      )}
    </div>
  )
}
