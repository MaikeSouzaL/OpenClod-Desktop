import { describe, expect, it } from 'vitest'
import { parseOcrOutput } from '../src/core/media/ocr'

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
})
