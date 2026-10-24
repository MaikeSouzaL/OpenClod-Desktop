import { describe, expect, it } from 'vitest'
import { overlayHtml } from '../src/main/computer-overlay-html'

describe('computer overlay HTML', () => {
  it('draws the orange frame only, without the mascot, on secondary monitors', () => {
    const html = overlayHtml(false)
    expect(html).toContain('class="frame"')
    expect(html).toContain('#ff7a1a')
    expect(html).not.toContain('class="primary"')
    expect(html).toContain('body.primary .mascot { display: flex; }')
  })

  it('puts the mascot on the primary monitor with blinking eyes looking down', () => {
    const html = overlayHtml(true)
    expect(html).toContain('<body class="primary">')
    expect(html).toContain('Openclod está usando o computador')
    expect(html.match(/class="eye"/g)).toHaveLength(2)
    expect(html).toContain('class="lid"')
    expect(html).toContain('@keyframes blink')
    expect(html).toContain('top: 8px')
    expect(html).toContain('@keyframes type-left')
  })

  it('is self-contained: no external images, fonts or scripts', () => {
    const html = overlayHtml(true)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('prefers-reduced-motion')
  })
})
