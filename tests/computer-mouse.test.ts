import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComputerLayer, normalizeKeyChord } from '../src/core/computer/layer'
import { makeTempDir, removeTempDir } from './helpers'

describe('computer mouse layer', () => {
  let dir: string
  let layer: ComputerLayer
  let calls: string[]

  beforeEach(async () => {
    dir = await makeTempDir('openclod-mouse-')
    layer = new ComputerLayer(null)
    calls = []
    // The real layer spawns the helper binary; the test replaces only the two
    // OS-facing calls, keeping coordinate conversion and validation intact.
    ;(layer as unknown as { input: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }).input = async (args) => {
      calls.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    ;(layer as unknown as { cursorPosition: () => Promise<{ x: number; y: number }> }).cursorPosition = async () => ({ x: 200, y: 120 })
    // Pretend a 1600x900 screenshot of a 3200x1800 desktop was just taken.
    ;(layer as unknown as { lastCapture: unknown }).lastCapture = {
      originX: 0,
      originY: 0,
      scale: 0.5,
      width: 1600,
      height: 400
    }
  })

  afterEach(async () => {
    await layer.close()
    await removeTempDir(dir)
  })

  it('moves the pointer using screenshot coordinates and reads the real position back', async () => {
    const result = await layer.moveMouse({ x: 100, y: 60 })
    expect(result.screen).toEqual({ x: 200, y: 120 })
    expect(result.actual).toEqual({ x: 200, y: 120 })
    expect(calls[0]).toBe('move 200 120')
  })

  it('presses and releases any mouse button at a converted point', async () => {
    await layer.mouseButton('down', 'right', { x: 50, y: 40 })
    await layer.mouseButton('up', 'right')
    expect(calls[0]).toBe('mouse_down --button right --x 100 --y 80')
    expect(calls[1]).toBe('mouse_up --button right')
  })

  it('drags with the chosen button', async () => {
    await layer.drag({ x: 10, y: 20 }, { x: 30, y: 40 }, 'screenshot', 'middle')
    expect(calls[0]).toBe('drag 20 40 60 80 --button middle')
  })

  it('scrolls over a point when one is given', async () => {
    await layer.scroll('down', 5, { x: 80, y: 90 })
    expect(calls[0]).toBe('scroll down --amount 5 --x 160 --y 180')
  })

  it('refuses coordinates outside the last screenshot instead of letting Windows clamp them', async () => {
    await expect(layer.moveMouse({ x: 900, y: 520 })).rejects.toThrow(/fora da última captura 1600x400/)
    expect(calls).toHaveLength(0)
  })

  it('normalizes model key aliases to the backend chord syntax', async () => {
    expect(normalizeKeyChord('Control_L+End')).toBe('ctrl+End')
    expect(normalizeKeyChord('Ctrl_L+Shift_L+s')).toBe('ctrl+shift+s')
    expect(normalizeKeyChord('Page_Up')).toBe('Page_Up')
    expect(normalizeKeyChord('Enter')).toBe('Return')
  })

  it('passes input_method to background and foreground key actions', async () => {
    await layer.pressKey('Control_L+End')
    expect(calls[0]).toBe('key ctrl+End')
  })
})
