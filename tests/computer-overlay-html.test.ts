import { describe, expect, it } from 'vitest'
import { DEFAULT_LABEL, MASCOT_MOODS } from '../src/core/computer/mood'
import { MASCOT_EXTRAS, MASCOT_EYES, MASCOT_LOOKS, MASCOT_MOUTHS, overlayHtml } from '../src/main/computer-overlay-html'

describe('computer overlay HTML', () => {
  it('draws the orange frame only, without the mascot, on secondary monitors', () => {
    const html = overlayHtml(false)
    expect(html).toContain('class="frame"')
    expect(html).toContain('#ff7a1a')
    expect(html).not.toContain('class="primary"')
    expect(html).toContain('body.primary .mascot { display: flex; }')
    expect(html).toContain('<body class="paused" data-mood="calm"')
  })

  it('puts one living robot on the primary monitor: pearl head, dark screen, two LED eyes, two ears', () => {
    const html = overlayHtml(true)
    expect(html).toContain('<body class="paused primary" data-mood="calm" data-difficulty="0">')
    expect(html).toContain(DEFAULT_LABEL)
    expect(html).toContain('usando o computador')
    expect(html.match(/class="screen"/g)).toHaveLength(1)
    expect(html.match(/class="led led-[lr]"/g)).toHaveLength(2)
    expect(html.match(/class="eye-wrap"/g)).toHaveLength(2)
    expect(html.match(/class="ear ear-[lr]"/g)).toHaveLength(2)
    expect(html.match(/class="ring"/g)).toHaveLength(2)
    expect(html).toContain('class="mouth"')
    expect(html).toContain('--gaze-x')
    expect(html).toContain('function scheduleBlink')
    expect(html).toContain('function aim')
    expect(html).toContain('requestAnimationFrame')
    expect(html).not.toContain('class="lid"')
  })

  it('blinks by squashing the LED eyes and pauses every animation with the paused class', () => {
    const html = overlayHtml(true)
    expect(html).toContain('.eyes.blink .eye-wrap { transform: scaleY(0.07); }')
    expect(html).toContain('body.paused *, body.paused *::before, body.paused *::after { animation-play-state: paused !important; }')
  })

  it('is self-contained: inline data cursor and one inline script', () => {
    const html = overlayHtml(true)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('window.setAgentCursor')
    expect(html).toContain('prefers-reduced-motion')
  })

  it('exposes setAgentMood and the face controls', () => {
    const html = overlayHtml(true)
    expect(html).toContain('window.setAgentMood')
    expect(html).toContain('window.resumeAgentFace')
    expect(html).toContain('window.pauseAgentFace')
    expect(html).toContain('window.hideAgentCursor')
    expect(html).toContain('.tag-text')
  })

  it('has a look, a body animation and a rule for each of the 14 moods', () => {
    const html = overlayHtml(true)
    expect(MASCOT_MOODS).toHaveLength(14)
    for (const mood of MASCOT_MOODS) {
      const look = MASCOT_LOOKS[mood]
      expect(MASCOT_EYES, mood).toContain(look.eyes)
      expect(MASCOT_MOUTHS, mood).toContain(look.mouth)
      for (const extra of look.extras) expect(MASCOT_EXTRAS, `${mood}/${extra}`).toContain(extra)
      expect(html, mood).toContain(`body[data-mood="${mood}"] {`)
      expect(html, mood).toContain(`@keyframes m-${mood} `)
      expect(html, mood).toContain(`animation: m-${mood} `)
    }
    // The page script carries the same table.
    expect(html).toContain('"calm":{"eyes":"led"')
    expect(html).toContain('"overwhelmed":{"eyes":"spiral"')
  })

  it('draws every eye, mouth and prop variant and shows them by attribute', () => {
    const html = overlayHtml(true)
    for (const eyes of MASCOT_EYES) {
      expect(html).toContain(`class="ev ev-${eyes}"`)
      expect(html).toContain(`.mascot-svg[data-eyes="${eyes}"] .ev-${eyes} { display: inline; }`)
    }
    for (const mouth of MASCOT_MOUTHS.filter((m) => m !== 'none')) {
      expect(html).toContain(`mv mv-${mouth}"`)
    }
    for (const extra of MASCOT_EXTRAS) {
      expect(html).toContain(`.mascot-svg[data-extras~="${extra}"] .x-${extra} { display: inline; }`)
    }
  })

  it('keeps the mouth optional: only happy, relieved and sad have one', () => {
    const withMouth = MASCOT_MOODS.filter((mood) => MASCOT_LOOKS[mood].mouth !== 'none')
    expect([...withMouth].sort()).toEqual(['happy', 'relieved', 'sad'])
  })

  it('tints the frame, halo and pill dot with the difficulty', () => {
    const html = overlayHtml(true)
    for (const level of [1, 2, 3]) expect(html).toContain(`body[data-difficulty="${level}"]`)
    expect(html).toContain('class="frame hot"')
  })
})
