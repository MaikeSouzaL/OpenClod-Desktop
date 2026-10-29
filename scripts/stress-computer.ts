/**
 * Stress test of "user computer" (Computer Use) against the REAL Windows desktop.
 *
 * It opens its own throwaway Notepad, exercises every computer tool, then hammers the backend: a volume loop, the
 * shared mouse/keyboard input queue under concurrent calls, concurrent reads, latency percentiles and an RSS
 * check. It also asserts the robustness contracts added in 2026-10-27: every element action returns a window
 * image for a vision model, observe_after is on by default (state_changed/settle in the result), and a stale
 * element ref is rejected. Nothing is saved; the Notepad it opened is closed at the end (save declined).
 *
 *   npx tsx scripts/stress-computer.ts            # default: ~30 iterations per loop
 *   STRESS_ITERS=100 npx tsx scripts/stress-computer.ts
 *
 * It MOVES THE REAL MOUSE AND TYPES for a minute or two — do not use the machine while it runs. Needs the
 * open-computer-use backend (resources/bin/open-computer-use.exe or OPENCLOD_OCU). Output: a JSON matrix and a few
 * images in Prints/stress-computer-2026-10-27/, plus a console summary; exit code 1 on any unexpected failure.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ComputerLayer } from '../src/core/computer/layer'
import {
  computerActivateTool,
  computerClickTool,
  computerCursorPositionTool,
  computerDragTool,
  computerGetWindowTool,
  computerKeyTool,
  computerLaunchTool,
  computerListAppsTool,
  computerListWindowsTool,
  computerMouseButtonTool,
  computerMouseMoveTool,
  computerOpenPathTool,
  computerScreenshotTool,
  computerScrollTool,
  computerSecondaryActionTool,
  computerSetValueTool,
  computerSnapshotTool,
  computerTypeTool,
  computerWaitForTool,
  computerWaitForWindowTool,
  computerWaitTool,
  computerWindowAtTool
} from '../src/core/tools/computer'
import type { ToolContext } from '../src/core/tools/types'

type ToolResultLike = { ok: boolean; text: string; data?: Record<string, unknown>; images?: unknown[] }
type Call = { call: string; ok: boolean; expected?: boolean; ms: number; images: number; data?: Record<string, unknown>; text: string }
type Check = { name: string; pass: boolean; detail?: string }

const ITERS = Math.max(5, Math.min(500, Number(process.env.STRESS_ITERS) || 30))
const root = process.cwd()
const outputDir = path.join(root, 'Prints', 'stress-computer-2026-10-27')
fs.mkdirSync(outputDir, { recursive: true })

const layer = new ComputerLayer()
layer.configure({ allowControl: true })
const calls: Call[] = []
const checks: Check[] = []
let savedImages = 0

const context = {
  sessionId: 'stress-computer',
  cwd: root,
  mode: 'computer',
  model: '',
  // A vision model, so the auto-image paths (window image after an action, pointer crops, afterView) run.
  vision: true,
  policy: {
    mode: 'auto', blockedCommands: [], allowedRoots: [], fullAccess: true,
    allowNetwork: true, allowComputerControl: true, shellTimeoutSec: 300
  },
  signal: AbortSignal.timeout(600_000),
  emit: () => undefined,
  approve: async () => true,
  progress: () => undefined,
  log: () => undefined,
  services: { computer: layer }
} as unknown as ToolContext

const check = (name: string, pass: boolean, detail?: string): void => {
  checks.push({ name, pass, ...(detail ? { detail } : {}) })
}

function saveImages(label: string, images: unknown[] | undefined): number {
  const list = (images ?? []) as Array<{ data?: unknown; mediaType?: unknown }>
  let n = 0
  for (const image of list) {
    if (typeof image?.data !== 'string') continue
    if (savedImages >= 12) break // a handful of evidence shots is enough; do not dump hundreds
    const ext = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType === 'image/webp' ? 'webp' : 'png'
    fs.writeFileSync(path.join(outputDir, `${label}${n ? `-${n + 1}` : ''}.${ext}`), Buffer.from(image.data, 'base64'))
    n++
    savedImages++
  }
  return n
}

async function invoke(callName: string, action: () => Promise<ToolResultLike>, expectedFailure = false, save = false): Promise<Call> {
  const started = Date.now()
  try {
    const result = await action()
    const ms = Date.now() - started
    if (save) saveImages(callName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(), result.images)
    const record: Call = { call: callName, ok: result.ok, ...(expectedFailure ? { expected: true } : {}), ms, images: result.images?.length ?? 0, data: result.data, text: String(result.text).slice(0, 600) }
    calls.push(record)
    return record
  } catch (error) {
    const ms = Date.now() - started
    const record: Call = { call: callName, ok: false, ...(expectedFailure ? { expected: true } : {}), ms, images: 0, text: (error as Error).message.slice(0, 600) }
    calls.push(record)
    return record
  }
}

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/** The index of the editable control in Notepad's tree, falling back to 1 (classic Notepad). */
function editableIndex(tree: string): number {
  for (const line of tree.split('\n')) {
    const match = /^\s*(\d+)\s+(edit|document|text|richedit|pane)\b/i.exec(line)
    if (match) return Number(match[1])
  }
  return 1
}

async function main(): Promise<number> {
  const status = layer.status()
  if (!status.available) {
    console.log(`PULADO: Computer Use indisponível nesta máquina — ${status.detail}`)
    return 0
  }
  const rssBefore = process.memoryUsage().rss

  /* ---------------- 1. abre o alvo (launch + wait_for_window) ---------------- */
  await invoke('computer_launch notepad', () => computerLaunchTool.execute({ app: 'notepad' }, context))
  const appeared = await invoke('computer_wait_for_window notepad', () => computerWaitForWindowTool.execute({ app: 'notepad', timeout_s: 15 }, context))
  const launched = appeared.ok ? (appeared.data as { id?: number } | undefined)?.id : undefined
  let target = typeof launched === 'number' ? launched : undefined
  if (target === undefined) {
    const windows = await invoke('computer_list_windows (fallback)', () => computerListWindowsTool.execute({}, context))
    try {
      const list = JSON.parse(windows.text) as Array<{ app: string; id: number }>
      target = list.find((item) => /notepad/i.test(item.app))?.id
    } catch {
      /* non-JSON */
    }
  }
  check('o Bloco de Notas abriu e foi encontrado (launch + wait_for_window)', target !== undefined, target === undefined ? 'nenhuma janela do notepad' : `janela ${target}`)
  if (target === undefined) return 1

  /* ---------------- 2. cobertura: cada ferramenta ao menos uma vez ---------------- */
  await invoke('computer_list_apps', () => computerListAppsTool.execute({}, context))
  await invoke('computer_list_windows', () => computerListWindowsTool.execute({}, context))
  await invoke('computer_get_window', () => computerGetWindowTool.execute({ window: target, app: 'notepad' }, context))
  await invoke('computer_activate', () => computerActivateTool.execute({ window: target }, context))
  await invoke('computer_cursor_position', () => computerCursorPositionTool.execute({}, context))

  // A janela recém-aberta pode não ter desenhado ainda: espera e, se a 1ª captura vier sem imagem, tenta de novo.
  await invoke('computer_wait (janela renderizar)', () => computerWaitTool.execute({ seconds: 0.8 }, context))
  let firstSnap = await invoke('computer_snapshot + screenshot', () => computerSnapshotTool.execute({ window: target, include_screenshot: true }, context), false, true)
  if (firstSnap.ok && firstSnap.images === 0) {
    await invoke('computer_wait (tenta imagem de novo)', () => computerWaitTool.execute({ seconds: 0.8 }, context))
    firstSnap = await invoke('computer_snapshot + screenshot (retry)', () => computerSnapshotTool.execute({ window: target, include_screenshot: true }, context), false, true)
  }
  const snapId = (firstSnap.data as { snapshot_id?: string } | undefined)?.snapshot_id
  check('computer_snapshot devolve árvore, snapshot_id e imagem', firstSnap.ok && Boolean(snapId) && firstSnap.images >= 1, `snapshot_id=${snapId} imagens=${firstSnap.images}`)
  const edit = editableIndex(firstSnap.text)

  await invoke('computer_window_at', () => computerWindowAtTool.execute({ x: 300, y: 220 }, context))
  await invoke('computer_set_value', () => computerSetValueTool.execute({ window: target, element_index: edit, value: 'Openclod stress — linha 1\náéíóú çñü — unicode\n' }, context))

  // The robustness contract: an element action returns a window image AND observe-after data by default.
  const elementClick = await invoke('computer_click element (contrato de visão/observe)', () => computerClickTool.execute({ window: target, element_index: edit }, context), false, true)
  check('ação de elemento devolve imagem da janela (modelo com visão)', elementClick.images >= 1, `imagens=${elementClick.images}`)
  check('observe_after ligado por padrão: o resultado traz state_changed', elementClick.data ? 'state_changed' in elementClick.data : false, JSON.stringify({ state_changed: elementClick.data?.state_changed, settle_ms: elementClick.data?.settle_ms }))

  await invoke('computer_type_text (elemento)', () => computerTypeTool.execute({ window: target, element_index: edit, text: 'TYPE-ELEM ' }, context))
  await invoke('computer_press_key ctrl+End', () => computerKeyTool.execute({ window: target, key: 'ctrl+End' }, context))
  await invoke('computer_type_text (janela em foco)', () => computerTypeTool.execute({ window: target, text: 'TYPE-FOCUS ' }, context))
  await invoke('computer_scroll (janela)', () => computerScrollTool.execute({ window: target, x: 300, y: 220, scroll_y: 240 }, context), false, true)
  await invoke('computer_drag (janela)', () => computerDragTool.execute({ window: target, from_x: 60, from_y: 120, to_x: 260, to_y: 120 }, context))
  await invoke('computer_secondary_action (falha esperada do backend)', () => computerSecondaryActionTool.execute({ window: target, element_index: edit, action: 'Scroll' }, context), true)
  await invoke('computer_screenshot desktop', () => computerScreenshotTool.execute({ max_width: 1400 }, context), false, true)
  await invoke('computer_mouse_move', () => computerMouseMoveTool.execute({ x: 320, y: 240 }, context), false, true)
  await invoke('computer_mouse_button down', () => computerMouseButtonTool.execute({ action: 'down' }, context))
  await invoke('computer_mouse_button up', () => computerMouseButtonTool.execute({ action: 'up' }, context))
  await invoke('computer_wait', () => computerWaitTool.execute({ seconds: 0.2 }, context))
  await invoke('computer_wait_for (texto na árvore)', () => computerWaitForTool.execute({ window: target, contains: 'TYPE-ELEM', timeout_s: 4 }, context))

  /* ---------------- 3. contratos de robustez ---------------- */
  // Stale ref: take a snapshot, change the tree, then try to use the old snapshot's ref.
  const s1 = await invoke('computer_snapshot (para ref velha)', () => computerSnapshotTool.execute({ window: target }, context))
  const s1Id = (s1.data as { snapshot_id?: string } | undefined)?.snapshot_id
  await invoke('computer_type_text (muda a árvore)', () => computerTypeTool.execute({ window: target, text: 'MUDOU ' }, context))
  await invoke('computer_snapshot (nova geração)', () => computerSnapshotTool.execute({ window: target }, context))
  const stale = await invoke('ref de snapshot velho é recusada', () => computerClickTool.execute({ window: target, ref: `e${edit}`, snapshot_id: s1Id }, context), true)
  check('ref de um snapshot antigo é rejeitada (element_stale)', !stale.ok && /stale/i.test(stale.text), stale.text.slice(0, 120))

  // Global click without a target is refused (not verifiable).
  const noTarget = await invoke('clique global sem alvo é recusado', () => computerClickTool.execute({ x: 300, y: 220, input_method: 'global' }, context), true)
  check('clique global sem alvo é recusado', !noTarget.ok, noTarget.text.slice(0, 120))

  // A window id that does not exist is rejected.
  const badWindow = await invoke('janela inexistente é recusada', () => computerSnapshotTool.execute({ window: 999_999_999 }, context), true)
  check('snapshot de janela inexistente é recusado', !badWindow.ok, badWindow.text.slice(0, 120))

  /* ---------------- 4. fila de input sob concorrência ---------------- */
  // Foco garantido no editor antes de digitar, senão o texto pode ir para outra janela.
  await invoke('computer_activate (foco no notepad)', () => computerActivateTool.execute({ window: target }, context))
  await invoke('computer_click editor (foco)', () => computerClickTool.execute({ window: target, element_index: edit }, context))
  // Clear the editor, then fire several type_text AT ONCE: the shared keyboard is serialized by the input queue,
  // so every token must land intact (no interleaving/corruption), not be lost.
  await invoke('limpa o editor (ctrl+a)', () => computerKeyTool.execute({ window: target, key: 'ctrl+a' }, context))
  await invoke('limpa o editor (Delete)', () => computerKeyTool.execute({ window: target, key: 'Delete' }, context))
  // Tokens alfanuméricos (o caminho de digitação não emite < >); digitados no próprio elemento para não depender do foco.
  const tokens = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
  const concurrentStart = Date.now()
  const concurrent = await Promise.all(tokens.map((token) => invoke(`type concorrente ${token}`, () => computerTypeTool.execute({ window: target, element_index: edit, text: `${token} `, observe_after: false }, context))))
  const concurrentMs = Date.now() - concurrentStart
  check('typing concorrente: todas as chamadas terminaram ok', concurrent.every((item) => item.ok), `${concurrent.filter((i) => i.ok).length}/${concurrent.length} ok em ${concurrentMs}ms`)
  await invoke('computer_wait (deixa assentar)', () => computerWaitTool.execute({ seconds: 0.4 }, context))
  const afterConcurrent = await invoke('computer_snapshot (confere os tokens)', () => computerSnapshotTool.execute({ window: target }, context))
  const missing = tokens.filter((token) => !afterConcurrent.text.includes(token))
  check('a fila de input não corrompeu/perdeu nada: todos os tokens aparecem inteiros', missing.length === 0, missing.length ? `faltaram: ${missing.join(', ')}` : 'todos presentes')

  // Concurrent READS skip the queue and must all succeed with valid ids.
  const reads = await Promise.all(Array.from({ length: 10 }, (_unused, index) => invoke(`snapshot concorrente ${index}`, () => computerSnapshotTool.execute({ window: target }, context))))
  const readIds = new Set(reads.map((item) => (item.data as { snapshot_id?: string } | undefined)?.snapshot_id).filter(Boolean))
  check('10 leituras concorrentes: todas ok com snapshot_id', reads.every((item) => item.ok) && readIds.size === reads.length, `${reads.filter((i) => i.ok).length}/10 ok, ${readIds.size} ids distintos`)

  /* ---------------- 5. volume ---------------- */
  const loopFailures: string[] = []
  for (let index = 0; index < ITERS; index++) {
    const typed = await invoke(`loop type #${index}`, () => computerTypeTool.execute({ window: target, element_index: edit, text: `L${index} `, observe_after: false }, context))
    if (!typed.ok) loopFailures.push(`type#${index}: ${typed.text.slice(0, 80)}`)
    const snap = await invoke(`loop snapshot #${index}`, () => computerSnapshotTool.execute({ window: target }, context))
    if (!snap.ok) loopFailures.push(`snap#${index}: ${snap.text.slice(0, 80)}`)
  }
  check(`loop de volume (${ITERS}×: digitar + snapshot) sem falha`, loopFailures.length === 0, loopFailures.slice(0, 5).join(' | '))

  const shotFailures: string[] = []
  for (let index = 0; index < Math.min(ITERS, 20); index++) {
    const shot = await invoke(`loop screenshot #${index}`, () => computerScreenshotTool.execute({ max_width: 1200 }, context))
    if (!shot.ok || !shot.images) shotFailures.push(`shot#${index}`)
  }
  check(`capturas repetidas (${Math.min(ITERS, 20)}×) sempre retornam imagem`, shotFailures.length === 0, shotFailures.join(', '))

  /* ---------------- 6. computer_open_path (por último: o Explorer do Win11 abre em aba e rouba foco) ---------------- */
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-stress-'))
  const opened = await invoke('computer_open_path (pasta temporária)', () => computerOpenPathTool.execute({ path: tempDir }, context))
  check('computer_open_path abre a pasta sem derrubar o processo', opened.ok, opened.text.slice(0, 100))
  await invoke('computer_wait (Explorer abrir)', () => computerWaitTool.execute({ seconds: 0.6 }, context))
  try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* Explorer pode estar segurando a pasta */ }

  /* ---------------- 7. encerra o alvo (sem salvar) ---------------- */
  await invoke('fecha o notepad (alt+F4)', () => computerKeyTool.execute({ window: target, key: 'alt+F4', input_method: 'global' }, context))
  await invoke('computer_wait (diálogo de salvar)', () => computerWaitTool.execute({ seconds: 0.6 }, context))
  // Windows 11 Notepad: "Não salvar" responds to 'n'. Best-effort; a lingering window is not a test failure.
  await invoke('recusa salvar (n)', () => computerKeyTool.execute({ key: 'n' }, context))

  const rssAfter = process.memoryUsage().rss
  const inputCalls = calls.filter((item) => /type|click|press|scroll|drag|mouse|set_value/.test(item.call))
  const summary = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    backend: status,
    iterations: ITERS,
    totalCalls: calls.length,
    unexpectedFailures: calls.filter((item) => !item.ok && !item.expected).map((item) => ({ call: item.call, text: item.text })),
    expectedFailures: calls.filter((item) => !item.ok && item.expected).length,
    latencyMs: {
      input_p50: percentile(inputCalls.map((item) => item.ms), 50),
      input_p95: percentile(inputCalls.map((item) => item.ms), 95),
      input_max: Math.max(0, ...inputCalls.map((item) => item.ms)),
      snapshot_p95: percentile(calls.filter((item) => /snapshot/.test(item.call)).map((item) => item.ms), 95),
      screenshot_p95: percentile(calls.filter((item) => /screenshot/.test(item.call)).map((item) => item.ms), 95)
    },
    rssMB: { before: Math.round(rssBefore / 1e6), after: Math.round(rssAfter / 1e6), delta: Math.round((rssAfter - rssBefore) / 1e6) },
    checks,
    calls
  }
  fs.writeFileSync(path.join(outputDir, 'stress-computer-matrix.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  const failedChecks = checks.filter((item) => !item.pass)
  const unexpected = summary.unexpectedFailures.length
  console.log(`\n===== teste de estresse do Computer Use =====`)
  console.log(`chamadas: ${calls.length} · falhas inesperadas: ${unexpected} · falhas esperadas: ${summary.expectedFailures}`)
  console.log(`latência input p50/p95/max: ${summary.latencyMs.input_p50}/${summary.latencyMs.input_p95}/${summary.latencyMs.input_max} ms · snapshot p95 ${summary.latencyMs.snapshot_p95} ms · screenshot p95 ${summary.latencyMs.screenshot_p95} ms`)
  console.log(`RSS: ${summary.rssMB.before} → ${summary.rssMB.after} MB (Δ ${summary.rssMB.delta})`)
  console.log(`\nverificações (${checks.length - failedChecks.length}/${checks.length} ok):`)
  for (const item of checks) console.log(`  ${item.pass ? 'ok   ' : 'FALHOU'} ${item.name}${item.detail ? ` -> ${item.detail}` : ''}`)
  if (unexpected) {
    console.log(`\nfalhas inesperadas:`)
    for (const item of summary.unexpectedFailures.slice(0, 20)) console.log(`  ${item.call}: ${item.text.slice(0, 160)}`)
  }
  console.log(`\nmatriz: ${path.relative(root, path.join(outputDir, 'stress-computer-matrix.json'))}`)
  return failedChecks.length === 0 && unexpected === 0 ? 0 : 1
}

main()
  .then(async (code) => {
    await layer.close().catch(() => undefined)
    process.exit(code)
  })
  .catch(async (error) => {
    console.error('ERRO no teste de estresse:', error)
    await layer.close().catch(() => undefined)
    process.exit(2)
  })
