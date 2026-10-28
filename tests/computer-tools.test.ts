import { describe, expect, it } from 'vitest'
import { computerTools } from '../src/core/tools/computer'
import { toolsForMode } from '../src/core/security/permissions'
import { ComputerLayer, limitSnapshotText, MAX_SNAPSHOT_CHARS } from '../src/core/computer/layer'

describe('Computer Use tool surface', () => {
  it('exposes app/window discovery, cursor, capture and all input actions', () => {
    const names = new Set(computerTools.map((tool) => tool.name))
    for (const expected of [
      'computer_list_apps',
      'computer_list_windows',
      'computer_window_at',
      'computer_get_window',
      'computer_cursor_position',
      'computer_snapshot',
      'computer_screenshot',
      'computer_click',
      'computer_mouse_move',
      'computer_mouse_button',
      'computer_scroll',
      'computer_drag',
      'computer_set_value',
      'computer_type_text',
      'computer_press_key',
      'computer_secondary_action',
      'computer_launch',
      'computer_open_path',
      'computer_activate',
      'computer_wait',
      'computer_wait_for',
      'computer_wait_for_window'
    ]) {
      expect(names.has(expected), expected).toBe(true)
    }
  })

  it('keeps discovery read-only while exposing input in computer mode', () => {
    const computerMode = new Set(toolsForMode('computer'))
    expect(computerMode.has('computer_list_apps')).toBe(true)
    expect(computerMode.has('computer_get_window')).toBe(true)
    expect(computerMode.has('computer_cursor_position')).toBe(true)
    expect(computerMode.has('computer_drag')).toBe(true)
    expect(computerMode.has('computer_launch')).toBe(true)
  })

  it('rejects a global input choice without a real target', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_click')!
    const result = await tool.execute(
      { x: 10, y: 10, input_method: 'global' },
      {
        sessionId: 'test',
        policy: { allowComputerControl: true },
        services: { computer: { available: true, configure() {} } }
      } as never
    )
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/window/i)
  })

  it('reports the screen point that the overlay should follow', async () => {
    const click = computerTools.find((item) => item.name === 'computer_click')!
    const calls: Array<{ x: number; y: number }> = []
    const fakeLayer = {
      available: true,
      configure() {},
      screenPointFor(point: { x: number; y: number }) {
        return point
      },
      async clickAt(point: { x: number; y: number }) {
        calls.push(point)
        return { code: 0, stdout: '', stderr: '', screen: { x: 410, y: 305 } }
      }
    }
    const result = await click.execute(
      { x: 10, y: 10 },
      {
        sessionId: 'test',
        policy: { allowComputerControl: true },
        services: { computer: fakeLayer }
      } as never
    )
    expect(calls).toEqual([{ x: 10, y: 10 }])
    expect(result.data).toMatchObject({ screen: { x: 410, y: 305 } })
  })

  it('waits for a window by title and returns its id', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_wait_for_window')!
    const result = await tool.execute(
      { title: 'teste', timeout_s: 2 },
      {
        sessionId: 'test',
        signal: new AbortController().signal,
        policy: { allowComputerControl: true },
        services: {
          computer: {
            available: true,
            configure() {},
            async listWindows() {
              return { ok: true, text: '[{"id":1247336,"app":"explorer","title":"teste"}]' }
            },
            async wait() {}
          }
        }
      } as never
    )
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ id: 1247336, title: 'teste' })
  })

  it('rejects a missing path instead of opening a random app', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_open_path')!
    const result = await tool.execute(
      { path: 'C:\\definitely\\missing\\openclod-test' },
      {
        sessionId: 'test',
        policy: { allowComputerControl: true },
        services: { computer: { available: true, configure() {} } }
      } as never
    )
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/não encontrado/)
  })

  it('declares screenshot scale and annotates windows for vision-less models', async () => {
    const tool = computerTools.find((item) => item.name === 'computer_screenshot')!
    const result = await tool.execute(
      { annotate: true },
      {
        sessionId: 'test',
        vision: false,
        policy: { allowComputerControl: true },
        services: {
          computer: {
            available: true,
            configure() {},
            async captureScreen() {
              return {
                image: { type: 'image', mediaType: 'image/png', data: 'x' },
                width: 1600,
                height: 900,
                originalWidth: 3840,
                path: 'shot.png',
                capture: { originX: 0, originY: 0, scale: 1600 / 3840, width: 1600, height: 900 }
              }
            },
            async listWindows() {
              return { ok: true, text: '[{"id":1,"app":"explorer","title":"teste"}]' }
            }
          }
        }
      } as never
    )
    expect(result.text).toContain('Escala')
    expect(result.text).toContain('Janelas abertas')
    expect(result.data).toMatchObject({ physicalWidth: 3840, physicalHeight: 2160, scale: 1600 / 3840 })
  })

  it('bounds oversized accessibility trees and marks the truncation', () => {
    const oversized = Array.from({ length: 7000 }, (_, index) => `\t${index} button botão ${index}`).join('\n')
    const limited = limitSnapshotText(oversized)
    expect(limited.truncated).toBe(true)
    expect(limited.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS)
    expect(limited.text).toContain('[snapshot truncado')
  })

  it('rejects an element ref from a snapshot other than the current one', async () => {
    const layer = new ComputerLayer(null)
    const internals = layer as unknown as {
      snapshotRefs: Map<string, { target: string; indexes: Set<number> }>
      currentSnapshotByTarget: Map<string, string>
    }
    internals.snapshotRefs.set('snap_old', { target: 'window:7', indexes: new Set([1]) })
    internals.currentSnapshotByTarget.set('window:7', 'snap_new')
    expect(layer.resolveSnapshotRef({ window: 7 }, 'snap_old', 'e1').error).toMatch(/element_stale/)
    expect(layer.resolveSnapshotRef({ window: 7 }, 'snap_new', 'e1').error).toMatch(/element_stale/)
  })
})
