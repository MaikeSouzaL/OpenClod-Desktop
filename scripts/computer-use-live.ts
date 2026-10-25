import fs from 'node:fs'
import path from 'node:path'
import { ComputerLayer } from '../src/core/computer/layer'
import {
  computerActivateTool,
  computerClickTool,
  computerCursorPositionTool,
  computerDragTool,
  computerGetWindowTool,
  computerListAppsTool,
  computerListWindowsTool,
  computerMouseButtonTool,
  computerMouseMoveTool,
  computerKeyTool,
  computerScreenshotTool,
  computerScrollTool,
  computerSecondaryActionTool,
  computerSetValueTool,
  computerSnapshotTool,
  computerTypeTool,
  computerWaitForTool,
  computerWaitTool
} from '../src/core/tools/computer'
import type { ToolContext } from '../src/core/tools/types'

type ToolResultLike = { ok: boolean; text: string; data?: Record<string, unknown>; images?: unknown[] }
type ResultRecord = {
  call: string
  ok: boolean
  expected?: boolean
  text: string
  evidence?: Record<string, unknown>
  images?: number
}

const root = process.cwd()
const outputDir = path.join(root, 'Prints', 'computer-use-2026-10-24')
fs.mkdirSync(outputDir, { recursive: true })
const layer = new ComputerLayer()
layer.configure({ allowControl: true })
const results: ResultRecord[] = []
const context = {
  sessionId: 'computer-use-live',
  cwd: root,
  mode: 'computer',
  policy: {
    mode: 'auto', blockedCommands: [], allowedRoots: [], fullAccess: true,
    allowNetwork: true, allowComputerControl: true, shellTimeoutSec: 300
  },
  signal: AbortSignal.timeout(240_000),
  emit: () => undefined,
  approve: async () => true,
  log: () => undefined,
  services: { computer: layer }
} as unknown as ToolContext

async function invoke(call: string, action: () => Promise<ToolResultLike>, expectedFailure = false): Promise<ResultRecord> {
  try {
    const result = await action()
    const record: ResultRecord = {
      call,
      ok: result.ok,
      ...(expectedFailure ? { expected: true } : {}),
      text: result.text.slice(0, 2_000),
      evidence: result.data,
      images: result.images?.length ?? 0
    }
    results.push(record)
    return record
  } catch (error) {
    const record: ResultRecord = {
      call,
      ok: false,
      ...(expectedFailure ? { expected: true } : {}),
      text: (error as Error).message.slice(0, 2_000)
    }
    results.push(record)
    return record
  }
}

async function main(): Promise<void> {
try {
  const apps = await invoke('computer_list_apps', () => computerListAppsTool.execute({}, context))
  if (!apps.ok) throw new Error(`list_apps falhou: ${apps.text}`)

  const windows = await invoke('computer_list_windows', () => computerListWindowsTool.execute({}, context))
  const list = JSON.parse(windows.text) as Array<{ app: string; id: number; title?: string }>
  const target = list.find((item) => item.app === 'notepad')
  if (!target) throw new Error('Abra uma janela do Bloco de Notas antes do teste.')

  await invoke('computer_get_window', () => computerGetWindowTool.execute({ window: target.id, app: target.app }, context))
  await invoke('computer_activate', () => computerActivateTool.execute({ window: target.id }, context))
  await invoke('computer_cursor_position', () => computerCursorPositionTool.execute({}, context))

  const snapshot = await invoke('computer_snapshot screenshot', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
  )
  const snapshotData = snapshot.evidence as { screenshot_id?: string } | undefined
  if (!snapshotData?.screenshot_id) throw new Error('snapshot não retornou screenshot_id')

  await invoke('computer_set_value', () =>
    computerSetValueTool.execute({
      window: target.id, element_index: 1,
      value: 'Openclod Computer Use LIVE\nUnicode áéíóú\nBackground input\nCoordinate input\nFinal state'
    }, context)
  )
  await invoke('computer_click element', () => computerClickTool.execute({ window: target.id, element_index: 1 }, context))
  await invoke('computer_type_text', () => computerTypeTool.execute({ window: target.id, text: ' TYPE' }, context))
  await invoke('computer_press_key normalized', () =>
    computerKeyTool.execute({ window: target.id, key: 'Control_L+End' }, context)
  )
  await invoke('computer_type_text after key', () =>
    computerTypeTool.execute({ window: target.id, text: ' KEY-END' }, context)
  )
  const state = await invoke('computer_snapshot after keyboard', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: false }, context)
  )
  fs.writeFileSync(path.join(outputDir, 'agent-path-keyboard-state.txt'), state.text, 'utf8')

  await invoke('computer_snapshot before scroll', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
  )
  await invoke('computer_scroll window', () =>
    computerScrollTool.execute({ window: target.id, x: 400, y: 220, scroll_y: 450 }, context)
  )
  await invoke('computer_snapshot after scroll', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
  )
  await invoke('computer_click coordinate', () =>
    computerClickTool.execute({ window: target.id, x: 300, y: 220 }, context)
  )
  await invoke('computer_type_text coordinate', () =>
    computerTypeTool.execute({ window: target.id, text: ' COORD' }, context)
  )
  await invoke('computer_snapshot before drag', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
  )
  await invoke('computer_drag window', () =>
    computerDragTool.execute({ window: target.id, from_x: 500, from_y: 20, to_x: 620, to_y: 20 }, context)
  )
  await invoke('computer_snapshot after drag', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
  )
  await invoke('computer_click accessibility method (known backend limitation)', () =>
    computerClickTool.execute({
      window: target.id,
      element_index: 1,
      click_method: 'accessibility'
    }, context)
  , true)
  await invoke('computer_click double', () =>
    computerClickTool.execute({ window: target.id, element_index: 1, double: true }, context)
  )
  await invoke('computer_click right', () =>
    computerClickTool.execute({ window: target.id, element_index: 1, button: 'right' }, context)
  )
  await invoke('computer_snapshot after right click', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: false }, context)
  )
  await invoke('computer_scroll global after reobserve (known backend limitation)', async () => {
    await computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
    return computerScrollTool.execute({ window: target.id, x: 400, y: 220, scroll_y: 240, input_method: 'global' }, context)
  }, true)
  await invoke('computer_snapshot after global scroll', () =>
    computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
  )
  await invoke('computer_drag global after reobserve', async () => {
    await computerSnapshotTool.execute({ window: target.id, include_screenshot: true }, context)
    return computerDragTool.execute({
      window: target.id,
      from_x: 500, from_y: 20, to_x: 560, to_y: 20,
      input_method: 'global'
    }, context)
  })

  await invoke('computer_press_key global', () =>
    computerKeyTool.execute({ window: target.id, key: 'ctrl+End', input_method: 'global' }, context)
  )
  await invoke('computer_type_text global', () =>
    computerTypeTool.execute({ window: target.id, text: ' GLOBAL', input_method: 'global' }, context)
  )
  await invoke('computer_wait', () => computerWaitTool.execute({ seconds: 0.2 }, context))
  await invoke('computer_wait_for', () =>
    computerWaitForTool.execute({ window: target.id, contains: 'Final state', timeout_s: 3 }, context)
  )

  await invoke('computer_screenshot desktop', () => computerScreenshotTool.execute({ max_width: 1600 }, context))
  await invoke('computer_mouse_move', () => computerMouseMoveTool.execute({ x: 400, y: 220 }, context))
  await invoke('computer_mouse_button down', () => computerMouseButtonTool.execute({ action: 'down' }, context))
  await invoke('computer_mouse_button up', () => computerMouseButtonTool.execute({ action: 'up' }, context))
  await invoke('computer_drag desktop', () =>
    computerDragTool.execute({ from_x: 300, from_y: 220, to_x: 420, to_y: 220 }, context)
  )
  await invoke('global without target refused', () =>
    computerClickTool.execute({ x: 300, y: 220, input_method: 'global' }, context), true
  )
  await invoke('secondary Scroll refused by backend', () =>
    computerSecondaryActionTool.execute({ window: target.id, element_index: 1, action: 'Scroll' }, context), true
  )
  await invoke('computer_snapshot app legacy', () =>
    computerSnapshotTool.execute({ app: 'notepad' }, context)
  )
  await invoke('stale window rejected', () =>
    computerSnapshotTool.execute({ window: 1 }, context), true
  )
} finally {
  const summary = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    backend: layer.status(),
    total: results.length,
    passes: results.filter((item) => item.ok && !item.expected).length,
    expectedFailures: results.filter((item) => !item.ok && item.expected).length,
    unexpectedFailures: results.filter((item) => !item.ok && !item.expected),
    results
  }
  fs.writeFileSync(path.join(outputDir, 'computer-use-matrix.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await layer.close()
}

console.log(path.join(outputDir, 'computer-use-matrix.json'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
