import { describe, expect, it } from 'vitest'
import {
  createSlideDocument,
  duplicateSlide,
  moveSlide,
  newSlide,
  parseSlideDocument,
  removeSlide,
  slidesToHtml,
  updateSlide,
  type SlideDocument
} from '../src/core/artifacts/slides'

function documentWith(count: number): SlideDocument {
  const base = newSlide()
  return {
    version: 1,
    title: 'Teste',
    slides: Array.from({ length: count }, (_, index) => ({ ...base, id: `s${index}`, title: `Slide ${index}` }))
  }
}

describe('slide documents', () => {
  it('creates a valid initial document and parses it back', () => {
    const document = createSlideDocument()
    const parsed = parseSlideDocument(JSON.stringify(document))
    expect(parsed).toMatchObject({ version: 1, title: 'Nova apresentação' })
    expect(parsed?.slides).toHaveLength(1)
    expect(parsed?.slides[0]).toMatchObject({ width: 640, height: 300 })
  })

  it('rejects malformed documents and normalizes damaged fields', () => {
    expect(parseSlideDocument('{')).toBeNull()
    expect(parseSlideDocument(JSON.stringify({ version: 2, slides: [] }))).toBeNull()
    const parsed = parseSlideDocument(JSON.stringify({
      version: 1,
      title: 42,
      slides: [{ title: 'A', accent: 'red', background: 3, x: -50, y: 9999, width: 5000, height: 1 }]
    }))
    expect(parsed?.title).toBe('Apresentação')
    expect(parsed?.slides[0]).toMatchObject({
      title: 'A',
      accent: '#d8b36e',
      background: '#17191e',
      x: 0,
      y: 500,
      width: 960,
      height: 40
    })
  })

  it('updates, duplicates, moves and removes slides without changing the selected invalid item', () => {
    const document = documentWith(3)
    const updated = updateSlide(document, 1, { title: 'Editado', id: 'ignored' })
    expect(updated.slides[1]).toMatchObject({ id: 's1', title: 'Editado' })

    const duplicate = duplicateSlide(document, 0)
    expect(duplicate.document.slides.map((slide) => slide.title)).toEqual(['Slide 0', 'Slide 0 (cópia)', 'Slide 1', 'Slide 2'])
    expect(duplicate.index).toBe(1)

    const moved = moveSlide(document, 0, 1)
    expect(moved.document.slides.map((slide) => slide.id)).toEqual(['s1', 's0', 's2'])
    expect(moved.index).toBe(1)

    const removed = removeSlide(document, 1)
    expect(removed.document.slides.map((slide) => slide.id)).toEqual(['s0', 's2'])
    expect(removed.index).toBe(1)
    expect(removeSlide({ ...document, slides: [document.slides[0]] }, 0).document.slides).toHaveLength(1)
  })

  it('exports a standalone deck and escapes all user text', () => {
    const document = documentWith(2)
    document.title = '<script>alert(1)</script>'
    document.slides[0].title = '<img src=x onerror=alert(2)>'
    document.slides[0].body = 'linha 1\nlinha 2 & fim'
    const html = slidesToHtml(document)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
    expect(html).toContain('linha 1<br>linha 2 &amp; fim')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('1 / 2')
  })
})
