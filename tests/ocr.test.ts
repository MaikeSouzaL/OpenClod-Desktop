import { describe, expect, it } from 'vitest'
import {
  OCR_MAX_DIMENSION,
  OCR_TILES,
  OCR_TILES_FINE,
  groupLines,
  mergeTileWords,
  parseOcrOutput,
  tileGrid,
  type OcrTile,
  type OcrWord
} from '../src/core/media/ocr'

describe('Windows OCR parser', () => {
  it('preserves line text and word coordinates', () => {
    const result = parseOcrOutput(JSON.stringify({
      text: 'Openclod memória',
      lines: [{ text: 'Openclod memória', words: [
        { text: 'Openclod', x: 10.5, y: 20, width: 80, height: 18 },
        { text: 'memória', x: 95, y: 20, width: 70, height: 18 }
      ] }]
    }), 'sample.png')
    expect(result.source).toBe('sample.png')
    expect(result.text).toBe('Openclod memória')
    expect(result.lines[0].words[1]).toEqual({ text: 'memória', x: 95, y: 20, width: 70, height: 18 })
  })

  it('returns an empty result for malformed OCR output', () => {
    expect(parseOcrOutput('not json', 'x.png')).toEqual({ source: 'x.png', text: '', lines: [] })
  })

  it('reads a one-line image, which Windows PowerShell 5.1 writes as an object instead of an array', () => {
    const result = parseOcrOutput(JSON.stringify({ text: 'Total', lines: { text: 'Total', words: { text: 'Total', x: 1, y: 2, width: 3, height: 4 } } }))
    expect(result.lines).toEqual([{ text: 'Total', words: [{ text: 'Total', x: 1, y: 2, width: 3, height: 4 }] }])
  })
})

/** The cuts a page goes through: every block must stay under the engine's limit once enlarged, and cover the page. */
describe('OCR blocks', () => {
  const covers = (tiles: OcrTile[], width: number, height: number): boolean => {
    for (let y = 0; y < height; y += 97) {
      for (let x = 0; x < width; x += 97) {
        if (!tiles.some((tile) => x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height)) return false
      }
    }
    return true
  }

  it('reads an A4 page as ONE enlarged block: no boundary that could cut a word', () => {
    const tiles = tileGrid(1700, 2405)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({ x: 0, y: 0, width: 1700, height: 2405, inner: { left: false, top: false, right: false, bottom: false } })
  })

  it('stacks a scrolling screenshot taller than the limit into blocks the engine still reads', () => {
    const width = 1778
    const height = 11_000 // past OCR_MAX_DIMENSION: one pass reads nothing, without an error
    const tiles = tileGrid(width, height)
    expect(tiles.length).toBeGreaterThan(1)
    for (const tile of tiles) expect(Math.max(tile.width, tile.height) * OCR_TILES.scale).toBeLessThan(OCR_MAX_DIMENSION)
    expect(covers(tiles, width, height)).toBe(true)
    // Neighbours overlap, so a line on a cut is whole in one of them.
    const [first, second] = tiles
    expect(first.y + first.height - second.y).toBeGreaterThanOrEqual(OCR_TILES.overlap - 1)
    expect(first.inner).toEqual({ left: false, top: false, right: false, bottom: true })
    expect(second.inner.top).toBe(true)
  })

  it('splits evenly (no sliver block at the edge) and the fine grid still covers everything', () => {
    const tiles = tileGrid(1650, 1650, OCR_TILES_FINE)
    const widths = tiles.filter((tile) => tile.row === 0).map((tile) => tile.width)
    expect(Math.min(...widths)).toBeGreaterThan(400)
    expect(covers(tiles, 1650, 1650)).toBe(true)
  })

  it('puts the words of a block back in page pixels', () => {
    const tile: OcrTile = { col: 0, row: 1, x: 0, y: 3_000, width: 1_000, height: 1_000, inner: { left: false, top: true, right: false, bottom: false } }
    const result = mergeTileWords([{ tile, words: [{ text: 'Pedidos', x: 200, y: 400, width: 140, height: 40 }] }], 2)
    expect(result.lines[0].words[0]).toEqual({ text: 'Pedidos', x: 100, y: 3_200, width: 70, height: 20 })
  })

  it('a word cut by a block boundary comes out once and whole (not "performanc Formance")', () => {
    // Two blocks side by side overlapping on page x 500..700; "performance" spans page x 505..765 (boxes below are 2x).
    const left: OcrTile = { col: 0, row: 0, x: 0, y: 0, width: 700, height: 200, inner: { left: false, top: false, right: true, bottom: false } }
    const right: OcrTile = { col: 1, row: 0, x: 500, y: 0, width: 700, height: 200, inner: { left: true, top: false, right: false, bottom: false } }
    const result = mergeTileWords([
      // the left block sees "Relatório de" whole and "performanc", cut by its right side at x 700
      { tile: left, words: [
        { text: 'Relatório', x: 600, y: 200, width: 300, height: 50 },
        { text: 'de', x: 920, y: 200, width: 60, height: 50 },
        { text: 'performanc', x: 1_010, y: 200, width: 390, height: 50 }
      ] },
      // the right block sees the whole word, just inside its left side
      { tile: right, words: [{ text: 'performance', x: 10, y: 200, width: 520, height: 50 }] }
    ], 2)
    expect(result.text).toBe('Relatório de performance')
  })

  it('a word read whole by two overlapping blocks is kept once', () => {
    const top: OcrTile = { col: 0, row: 0, x: 0, y: 0, width: 600, height: 600, inner: { left: false, top: false, right: false, bottom: true } }
    const bottom: OcrTile = { col: 0, row: 1, x: 0, y: 400, width: 600, height: 600, inner: { left: false, top: true, right: false, bottom: false } }
    const result = mergeTileWords([
      { tile: top, words: [{ text: 'Clientes', x: 200, y: 1_000, width: 240, height: 50 }] },
      { tile: bottom, words: [{ text: 'Clientes', x: 200, y: 200, width: 240, height: 50 }] }
    ], 2)
    expect(result.lines.map((line) => line.text)).toEqual(['Clientes'])
  })

  it('groups lines top to bottom, words left to right, and keeps two columns apart', () => {
    const word = (text: string, x: number, y: number, width = 60): OcrWord => ({ text, x, y, width, height: 20 })
    const lines = groupLines([
      word('estoque', 760, 101),
      word('B:', 720, 100, 30),
      word('Coluna', 640, 100, 70),
      word('vendas', 200, 99),
      word('A:', 160, 100, 30),
      word('Coluna', 80, 100, 70),
      word('Relatório', 80, 40, 120)
    ])
    expect(lines.map((line) => line.text)).toEqual(['Relatório', 'Coluna A: vendas   Coluna B: estoque'])
  })
})
