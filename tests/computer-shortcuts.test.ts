import { describe, expect, it } from 'vitest'
import { ComputerLayer } from '../src/core/computer/layer'

/** The backend is stubbed: only the arguments sent to it matter here. */
function layerWithSpy() {
  const layer = new ComputerLayer(null)
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  ;(layer as unknown as { call: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> }).call = async (tool, args) => {
    calls.push({ tool, args })
    return { ok: true, text: 'ok' }
  }
  ;(layer as unknown as { snapshot: () => Promise<{ ok: boolean; text: string }> }).snapshot = async () => ({ ok: false, text: 'sem snapshot' })
  return { layer, calls }
}

describe('computer_press_key routing', () => {
  it('sends shortcuts with modifiers as global input when a window is targeted', async () => {
    const { layer, calls } = layerWithSpy()
    await layer.pressKeyIn({ window: 42 }, 'ctrl+s')
    await layer.pressKeyIn({ app: 'notepad' }, 'Alt+F4')
    expect(calls.map((call) => call.args.input_method)).toEqual(['global', 'global'])
  })

  it('leaves plain keys on the default route and respects an explicit choice', async () => {
    const { layer, calls } = layerWithSpy()
    await layer.pressKeyIn({ window: 42 }, 'Enter')
    await layer.pressKeyIn({ window: 42 }, 'ctrl+s', 'auto')
    expect(calls[0].args.input_method).toBeUndefined()
    expect(calls[1].args.input_method).toBe('auto')
  })
})
