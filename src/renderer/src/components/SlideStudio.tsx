import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Icon } from './Icons'

interface Slide {
  id: string
  title: string
  body: string
  accent: string
  background: string
  x: number
  y: number
  width: number
  height: number
}

interface SlideDocument {
  version: 1
  title: string
  slides: Slide[]
}

function parseDocument(source: string): SlideDocument | null {
  try {
    const parsed = JSON.parse(source) as SlideDocument
    if (parsed?.version !== 1 || !Array.isArray(parsed.slides)) return null
    return parsed
  } catch {
    return null
  }
}

/** Visual editor for .openclod-slides.json. The raw JSON remains the source. */
export function SlideStudio({ source, onChange }: { source: string; onChange(next: string): void }): ReactElement {
  const parsed = useMemo(() => parseDocument(source), [source])
  const [active, setActive] = useState(0)

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
              JSON.stringify(
                {
                  version: 1,
                  title: 'Nova apresentação',
                  slides: [
                    {
                      id: 'slide-1',
                      title: 'Novo slide',
                      body: 'Clique e edite o conteúdo.',
                      accent: '#d8b36e',
                      background: '#17191e',
                      x: 64,
                      y: 92,
                      width: 640,
                      height: 300
                    }
                  ]
                },
                null,
                2
              )
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

  const update = (patch: Partial<Slide>): void => {
    const slides = parsed.slides.map((item, index) => (index === active ? { ...item, ...patch } : item))
    onChange(JSON.stringify({ ...parsed, slides }, null, 2))
  }

  return (
    <div className="slide-studio">
      <aside className="slide-rail">
        {parsed.slides.map((item, index) => (
          <button key={item.id} type="button" className={`slide-thumb ${index === active ? 'active' : ''}`} onClick={() => setActive(index)}>
            <span>{index + 1}</span>
            <strong>{item.title || 'Sem título'}</strong>
          </button>
        ))}
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            const next = {
              ...parsed,
              slides: [
                ...parsed.slides,
                {
                  id: `slide-${Date.now().toString(36)}`,
                  title: 'Novo slide',
                  body: 'Edite este slide.',
                  accent: slide.accent,
                  background: slide.background,
                  x: 64,
                  y: 92,
                  width: 640,
                  height: 300
                }
              ]
            }
            onChange(JSON.stringify(next, null, 2))
            setActive(next.slides.length - 1)
          }}
        >
          <Icon name="plus" size={12} /> Slide
        </button>
      </aside>
      <div className="slide-workspace">
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
        </div>
      </div>
    </div>
  )
}
