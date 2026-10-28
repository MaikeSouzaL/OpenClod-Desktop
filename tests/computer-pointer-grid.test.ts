import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComputerLayer, pointerGridFor, screenshotToScreen } from '../src/core/computer/layer'
import { computerTools } from '../src/core/tools/computer'

// The Chat with a Qwen3.5 served from Colab "não consegue mover o mouse exatamente sobre o local". Two causes, measured on the
// user's machine (two 1920x1080 monitors side by side, 100% scaling): the Qwen3-VL family points with coordinates relative to
// the image on a 0..1000 grid, which the harness read as image pixels; and both monitors were squeezed into a 1600 px image
// (1 image pixel = 2.4 screen pixels).

describe('the coordinates a model points in', () => {
  it('the Qwen3-VL family and UI-TARS point on a 0..1000 grid', () => {
    for (const model of ['qwen3.5:9b-q8_0', 'qwen3-vl:8b', 'qwen/qwen3-vl-235b-a22b-instruct', 'huihui_ai/qwen3.5-abliterated:9b', 'qwen3.8:27b-q4_K_M', 'Qwen3.6-35B', 'ui-tars-1.5-7b']) {
      expect(pointerGridFor(model), model).toBe(1000)
    }
  })

  it('every other model, Qwen2.5-VL included, keeps image pixels', () => {
    for (const model of ['qwen2.5vl:7b', 'qwen3:8b', 'qwen3-coder:30b', 'claude-opus-5-5', 'gpt-5.1', 'gemma4:12b', 'deepseek-v4-pro', '', undefined]) {
      expect(pointerGridFor(model), String(model)).toBe(0)
    }
  })
})

describe('from the grid to the real screen', () => {
  // Two 1920x1080 monitors (3840x1082) captured at 2560x721: what the new default does on the user's machine.
  const capture = { originX: 0, originY: 0, scale: 2560 / 3840, width: 2560, height: 721, grid: 1000 }

  it('the middle of the image is the middle of the desktop', () => {
    expect(screenshotToScreen({ x: 500, y: 500 }, capture)).toEqual({ x: 1920, y: 541 })
  })

  it('the center of the second monitor is where the model sees it (the old reading sent it near the left edge of the first)', () => {
    const point = screenshotToScreen({ x: 750, y: 500 }, capture)
    expect(point.x).toBeGreaterThan(2870)
    expect(point.x).toBeLessThan(2890)
    const asPixels = screenshotToScreen({ x: 750, y: 500 }, { ...capture, grid: undefined })
    expect(asPixels.x).toBe(1125)
  })

  it('the far corner stays on the screen', () => {
    const point = screenshotToScreen({ x: 1000, y: 1000 }, capture)
    expect(point.x).toBeLessThan(3840)
    expect(point.y).toBeLessThan(1082)
  })

  it('a capture of one monitor keeps its origin', () => {
    const second = { originX: 1920, originY: 2, scale: 1, width: 1920, height: 1080, grid: 1000 }
    expect(screenshotToScreen({ x: 500, y: 500 }, second)).toEqual({ x: 2880, y: 542 })
  })
})

describe('the layer with a grid capture', () => {
  let layer: ComputerLayer
  let calls: string[]

  beforeEach(() => {
    layer = new ComputerLayer(null)
    calls = []
    ;(layer as unknown as { input: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }).input = async (args) => {
      calls.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    ;(layer as unknown as { cursorPosition: () => Promise<{ x: number; y: number }> }).cursorPosition = async () => ({ x: 1920, y: 541 })
    ;(layer as unknown as { lastCapture: unknown }).lastCapture = { originX: 0, originY: 0, scale: 2560 / 3840, width: 2560, height: 721, grid: 1000 }
  })

  afterEach(async () => {
    await layer.close()
  })

  it('moves and clicks at the converted point', async () => {
    await layer.moveMouse({ x: 500, y: 500 })
    await layer.clickAt({ x: 250, y: 500 })
    expect(calls[0]).toBe('move 1920 541')
    expect(calls[1]).toBe('click --x 960 --y 541 --count 1')
  })

  it('accepts the whole grid (a Qwen point of 900 used to be refused as "outside the 1600x451 capture" or land elsewhere)', async () => {
    await expect(layer.moveMouse({ x: 900, y: 900 })).resolves.toBeTruthy()
  })

  it('refuses a point outside the grid and says which grid', async () => {
    await expect(layer.moveMouse({ x: 1001, y: 10 })).rejects.toThrow(/fora da grade da última captura \(0 a 1000/)
    expect(calls).toHaveLength(0)
  })
})

function fakeCapture(capture: Record<string, unknown>) {
  return {
    available: true,
    configure() {},
    seen: [] as unknown[],
    async captureScreen(maxWidth: number, options: { monitor?: number }) {
      this.seen.push({ maxWidth, options })
      return {
        shown: options.monitor ?? 1,
        image: { type: 'image', mediaType: 'image/png', data: 'x' },
        width: 2560,
        height: 721,
        originalWidth: 3840,
        path: 'shot.png',
        capture: { originX: 0, originY: 0, scale: 2560 / 3840, width: 2560, height: 721, ...capture },
        monitors: [
          { index: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true },
          { index: 2, x: 1920, y: 2, width: 1920, height: 1080, primary: false }
        ]
      }
    }
  }
}

describe('computer_screenshot tells the model how to point', () => {
  const tool = computerTools.find((item) => item.name === 'computer_screenshot')!

  it('a Qwen3.5 is told to point 0..1000 on the image, and the capture is taken with that grid', async () => {
    const computer = fakeCapture({ grid: 1000 })
    const result = await tool.execute({}, { sessionId: 't', vision: true, model: 'qwen3.5:9b-q8_0', policy: { allowComputerControl: true }, services: { computer } } as never)
    expect(result.text).toContain('RELATIVOS a esta imagem, de 0 a 1000')
    expect(computer.seen[0]).toEqual({ maxWidth: 0, options: { grid: 1000, monitor: undefined } })
    expect(result.data).toMatchObject({ grid: 1000 })
  })

  it('any other model is told to use image pixels', async () => {
    const computer = fakeCapture({})
    const result = await tool.execute({}, { sessionId: 't', vision: true, model: 'claude-opus-5-5', policy: { allowComputerControl: true }, services: { computer } } as never)
    expect(result.text).toContain('Use x,y em pixels desta imagem (2560x721)')
    expect(computer.seen[0]).toEqual({ maxWidth: 0, options: { grid: 0, monitor: undefined } })
  })

  it('shows one monitor at a time, the primary first, and says how to look at the other', async () => {
    const computer = fakeCapture({})
    const result = await tool.execute({}, { sessionId: 't', vision: true, model: 'm', policy: { allowComputerControl: true }, services: { computer } } as never)
    expect(computer.seen[0]).toEqual({ maxWidth: 0, options: { grid: 0, monitor: undefined } })
    expect(result.text).toContain('do monitor 1 (principal)')
    expect(result.text).toContain('Monitores: 1 = 1920x1080 em 0,0 (principal); 2 = 1920x1080 em 1920,2')
    expect(result.text).toContain('Esta imagem mostra só o monitor 1. Se o que você precisa não estiver nela, capture monitor=2')
    expect(result.text).toContain('se o usuário disser em qual tela fazer, use essa')
  })

  it('captures the monitor that was asked for, or all of them with monitor=0', async () => {
    const computer = fakeCapture({})
    const second = await tool.execute({ monitor: 2 }, { sessionId: 't', vision: true, model: 'm', policy: { allowComputerControl: true }, services: { computer } } as never)
    expect(computer.seen[0]).toEqual({ maxWidth: 0, options: { grid: 0, monitor: 2 } })
    expect(second.text).toContain('do monitor 2')
    expect(second.text).toContain('capture monitor=1')
    const all = await tool.execute({ monitor: 0 }, { sessionId: 't', vision: true, model: 'm', policy: { allowComputerControl: true }, services: { computer } } as never)
    expect(all.text).toContain('de todos os monitores juntos')
    expect(all.text).toContain('Para ver um com mais detalhe, use monitor=N')
  })
})

describe('after pointing, the model sees where the pointer stopped', () => {
  function layerWithLook(look: boolean) {
    const layer = new ComputerLayer(null)
    const internals = layer as unknown as Record<string, unknown>
    internals.input = async () => ({ code: 0, stdout: '', stderr: '' })
    internals.cursorPosition = async () => ({ x: 1920, y: 541 })
    internals.lastCapture = { originX: 0, originY: 0, scale: 2560 / 3840, width: 2560, height: 721, grid: 1000 }
    internals.captureAround = async (point: { x: number; y: number }) =>
      look ? { type: 'image', mediaType: 'image/png', data: 'crop', label: `ponteiro em ${point.x},${point.y}` } : null
    Object.defineProperty(layer, 'available', { get: () => true })
    return layer
  }

  it('computer_mouse_move returns a crop around the real pointer with the cross on it', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_mouse_move')!
    const result = await tool.execute({ x: 500, y: 500 }, { sessionId: 't', vision: true, model: 'qwen3.5:9b', policy: { allowComputerControl: true }, services: { computer: layerWithLook(true) } } as never)
    expect(result.ok).toBe(true)
    expect(result.images?.[0]).toMatchObject({ data: 'crop', label: 'ponteiro em 1920,541' })
    expect(result.text).toContain('cruz vermelha')
  })

  it('a click by coordinates also shows where it landed', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_click')!
    const result = await tool.execute({ x: 500, y: 500 }, { sessionId: 't', vision: true, model: 'qwen3.5:9b', policy: { allowComputerControl: true }, services: { computer: layerWithLook(true) } } as never)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('tela (1920, 541)')
    expect(result.images?.length).toBe(1)
  })

  it('a model without vision gets no image', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_mouse_move')!
    const result = await tool.execute({ x: 500, y: 500 }, { sessionId: 't', vision: false, model: 'm', policy: { allowComputerControl: true }, services: { computer: layerWithLook(true) } } as never)
    expect(result.images).toBeUndefined()
  })
})
