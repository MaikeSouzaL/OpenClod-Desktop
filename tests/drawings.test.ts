import { describe, expect, it } from 'vitest'
import { drawingFileName, ensureSvgNamespace, isDrawableHtml, looksLikeSvg, splitDrawings, svgDataUri, svgHasIntrinsicSize } from '../src/renderer/src/lib/drawings'

const SVG = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

describe('splitDrawings', () => {
  it('turns a closed ```svg fence into a drawing between two pieces of prose', () => {
    const parts = splitDrawings(`Aqui está:\n\n\`\`\`svg\n${SVG}\n\`\`\`\n\nPronto.`)
    expect(parts.map((part) => part.type)).toEqual(['md', 'drawing', 'md'])
    expect(parts[1]).toMatchObject({ type: 'drawing', kind: 'svg', source: SVG, ordinal: 0 })
    expect(parts[0]).toMatchObject({ type: 'md', text: expect.stringContaining('Aqui está') })
  })

  it('keeps a fence that is still streaming as plain text until it closes', () => {
    const open = splitDrawings(`Desenhando\n\n\`\`\`svg\n<svg viewBox="0 0 10 10"><circle`)
    expect(open.every((part) => part.type === 'md')).toBe(true)
    const closed = splitDrawings(`Desenhando\n\n\`\`\`svg\n${SVG}\n\`\`\``)
    expect(closed.some((part) => part.type === 'drawing')).toBe(true)
  })

  it('recognises svg in xml or untagged fences and in bare text, and html pages and canvases', () => {
    expect(splitDrawings(`\`\`\`xml\n${SVG}\n\`\`\``)[0]).toMatchObject({ type: 'drawing', kind: 'svg' })
    expect(splitDrawings(`\`\`\`\n${SVG}\n\`\`\``)[0]).toMatchObject({ type: 'drawing', kind: 'svg' })
    expect(splitDrawings(`Veja:\n${SVG}\nfim`).map((part) => part.type)).toEqual(['md', 'drawing', 'md'])
    expect(splitDrawings('```html\n<!doctype html><canvas id="c"></canvas><script>1</script>\n```')[0]).toMatchObject({ type: 'drawing', kind: 'html' })
  })

  it('leaves ordinary code and markup snippets alone', () => {
    expect(splitDrawings('```html\n<div class="card">oi</div>\n```').every((part) => part.type === 'md')).toBe(true)
    expect(splitDrawings('```ts\nconst a = "<svg></svg>"\n```').every((part) => part.type === 'md')).toBe(true)
    expect(splitDrawings('Use a tag `<svg>` para vetores.').every((part) => part.type === 'md')).toBe(true)
    expect(splitDrawings('```svg\n<path d="M0 0"/>\n```').every((part) => part.type === 'md')).toBe(true)
  })

  it('numbers several drawings in order and handles longer fences', () => {
    const parts = splitDrawings(`\`\`\`\`svg\n${SVG}\n\`\`\`\`\ntexto\n\`\`\`svg\n${SVG}\n\`\`\``)
    expect(parts.filter((part) => part.type === 'drawing').map((part) => (part.type === 'drawing' ? part.ordinal : -1))).toEqual([0, 1])
  })
})

describe('svg helpers', () => {
  it('adds the namespace an <img> needs and builds a data URI', () => {
    expect(ensureSvgNamespace(SVG)).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(ensureSvgNamespace('<svg xmlns="http://www.w3.org/2000/svg"></svg>').match(/xmlns/g)).toHaveLength(1)
    const uri = svgDataUri(SVG)
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(uri.split(',')[1])).toContain('<circle')
  })

  it('knows whether the picture sizes itself', () => {
    expect(svgHasIntrinsicSize('<svg width="120" height="80"></svg>')).toBe(true)
    expect(svgHasIntrinsicSize('<svg viewBox="0 0 10 10"></svg>')).toBe(false)
  })

  it('names downloads after the title and tells svg from markup', () => {
    expect(drawingFileName('svg', '<svg><title>Lupa de Busca</title></svg>')).toBe('lupa-de-busca.svg')
    expect(drawingFileName('html', '<canvas></canvas>')).toBe('desenho.html')
    expect(looksLikeSvg(SVG)).toBe(true)
    expect(looksLikeSvg('<svg>sem fim')).toBe(false)
    expect(isDrawableHtml('<p>texto</p>')).toBe(false)
  })
})
