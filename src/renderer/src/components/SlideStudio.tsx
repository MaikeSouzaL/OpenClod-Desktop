import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Icon } from './Icons'
import {
  createSlideDocument,
  duplicateSlide,
  moveSlide,
  newSlide,
  parseSlideDocument,
  removeSlide,
  updateSlide,
  type Slide,
  type SlideDocument
} from '../../../core/artifacts/slides'

/** Visual editor for .openclod-slides.json. The raw JSON remains the source. */
export function SlideStudio({ source, onChange }: { source: string; onChange(next: string): void }): ReactElement {
  const parsed = useMemo(() => parseSlideDocument(source), [source])
  const [active, setActive] = useState(0)
  const [presenting, setPresenting] = useState(false)

  if (!parsed) {
    return (
      <div className="slide-editor-empty">
        <Icon name="image" size={26} />
        <h3>Rascunho de apresentação</h3>
        <p>Use um arquivo .openclod-slides.json para editar slides visualmente.</p>
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            onChange(
              JSON.stringify(createSlideDocument(), null, 2)
            )
          }
        >
          <Icon name="plus" size={13} /> Criar apresentação
        </button>
      </div>
    )
  }

  const slide = parsed.slides[Math.max(0, Math.min(active, parsed.slides.length - 1))]
  if (!slide) return <div className="slide-editor-empty">Apresentação sem slides.</div>

  const commit = (document: SlideDocument, nextActive = active): void => {
    onChange(JSON.stringify(document, null, 2))
    setActive(Math.max(0, Math.min(nextActive, document.slides.length - 1)))
  }
  const update = (patch: Partial<Slide>): void => commit(updateSlide(parsed, active, patch))

  return (
    <div className="slide-studio">
      <aside className="slide-rail">
        <div className="slide-rail-heading">Slides</div>
        {parsed.slides.map((item, index) => (
          <button key={item.id} type="button" className={`slide-thumb ${index === active ? 'active' : ''}`} onClick={() => setActive(index)}>
            <span>{index + 1}</span>
            <strong>{item.title || 'Sem título'}</strong>
          </button>
        ))}
        <div className="slide-rail-actions">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              const added = { ...newSlide(parsed.slides.length + 1), accent: slide.accent, background: slide.background }
              commit({ ...parsed, slides: [...parsed.slides, added] }, parsed.slides.length)
            }}
          ><Icon name="plus" size={12} /> Slide</button>
          <button type="button" className="icon-btn small" title="Duplicar slide" onClick={() => {
            const result = duplicateSlide(parsed, active)
            commit(result.document, result.index)
          }}><Icon name="copy" size={12} /></button>
          <button type="button" className="icon-btn small" title="Mover para cima" disabled={active === 0} onClick={() => {
            const result = moveSlide(parsed, active, -1)
            commit(result.document, result.index)
          }}><Icon name="arrowUp" size={12} /></button>
          <button type="button" className="icon-btn small" title="Mover para baixo" disabled={active === parsed.slides.length - 1} onClick={() => {
            const result = moveSlide(parsed, active, 1)
            commit(result.document, result.index)
          }}><Icon name="chevronDown" size={12} /></button>
          <button type="button" className="icon-btn small danger" title="Excluir slide" disabled={parsed.slides.length <= 1} onClick={() => {
            const result = removeSlide(parsed, active)
            commit(result.document, result.index)
          }}><Icon name="trash" size={12} /></button>
        </div>
      </aside>
      <div className="slide-workspace">
        <div className="slide-stage-head">
          <input aria-label="Título da apresentação" value={parsed.title} onChange={(event) => commit({ ...parsed, title: event.target.value })} />
          <span>{active + 1} / {parsed.slides.length}</span>
          <button type="button" className="btn ghost small" onClick={() => setPresenting(true)}><Icon name="play" size={12} /> Apresentar</button>
        </div>
        <div className="slide-canvas" style={{ background: slide.background }}>
          <div
            className="slide-object"
            style={{
              left: `${(slide.x / 960) * 100}%`,
              top: `${(slide.y / 540) * 100}%`,
              width: `${(slide.width / 960) * 100}%`,
              height: `${(slide.height / 540) * 100}%`,
              ['--slide-accent' as string]: slide.accent
            } as CSSProperties}
          >
            <input value={slide.title} onChange={(event) => update({ title: event.target.value })} aria-label="Título do slide" />
            <textarea value={slide.body} onChange={(event) => update({ body: event.target.value })} aria-label="Corpo do slide" />
          </div>
        </div>
        <div className="slide-inspector">
          <label>
            Cor de destaque
            <input type="color" value={slide.accent} onChange={(event) => update({ accent: event.target.value })} />
          </label>
          <label>
            Fundo
            <input type="color" value={slide.background} onChange={(event) => update({ background: event.target.value })} />
          </label>
          <label>
            X
            <input type="range" min={0} max={900} value={slide.x} onChange={(event) => update({ x: Number(event.target.value) })} />
          </label>
          <label>
            Y
            <input type="range" min={0} max={500} value={slide.y} onChange={(event) => update({ y: Number(event.target.value) })} />
          </label>
          <label>
            Largura
            <input type="range" min={120} max={900} value={slide.width} onChange={(event) => update({ width: Number(event.target.value) })} />
          </label>
          <label>
            Altura
            <input type="range" min={100} max={520} value={slide.height} onChange={(event) => update({ height: Number(event.target.value) })} />
          </label>
        </div>
      </div>
      {presenting ? (
        <div
          className="slide-presentation"
          role="dialog"
          aria-modal="true"
          aria-label={parsed.title}
          tabIndex={0}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape') setPresenting(false)
            if (event.key === 'ArrowRight' || event.key === ' ') setActive((current) => Math.min(parsed.slides.length - 1, current + 1))
            if (event.key === 'ArrowLeft') setActive((current) => Math.max(0, current - 1))
          }}
        >
          <div className="slide-presentation-canvas" style={{ background: slide.background }}>
            <div className="slide-presentation-object" style={{
              left: `${(slide.x / 960) * 100}%`, top: `${(slide.y / 540) * 100}%`,
              width: `${(slide.width / 960) * 100}%`, height: `${(slide.height / 540) * 100}%`,
              ['--slide-accent' as string]: slide.accent
            } as CSSProperties}>
              <h1>{slide.title}</h1><p>{slide.body}</p>
            </div>
          </div>
          <div className="slide-presentation-nav">
            <button type="button" onClick={() => setActive((current) => Math.max(0, current - 1))}>←</button>
            <span>{active + 1} / {parsed.slides.length}</span>
            <button type="button" onClick={() => setActive((current) => Math.min(parsed.slides.length - 1, current + 1))}>→</button>
            <button type="button" onClick={() => setPresenting(false)}>Fechar</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
