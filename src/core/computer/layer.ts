import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ComputerStatus, ImagePart, ToolResult } from '../../shared/types.js'
import { McpClient } from '../mcp/client.js'
import { bundledBinary } from '../util/resources.js'
import { waitForQuiet, type SettleResult } from './settle.js'

export interface OcuResult {
  code: number
  stdout: string
  stderr: string
}

/** A window reference as open-computer-use expects it: `{window: {id}}`. */
export interface Target {
  app?: string
  window?: number
}

export type InputMethod = 'auto' | 'global'
export type ClickMethod = 'auto' | 'accessibility' | 'app_post' | 'global'

export const MAX_SNAPSHOT_CHARS = 80_000

/** Truncates an accessibility tree without cutting the last line in half. */
export function limitSnapshotText(text: string, maxChars = MAX_SNAPSHOT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const marker = `\n…[snapshot truncado em ${maxChars} de ${text.length} caracteres; use um alvo mais específico]`
  const available = Math.max(0, maxChars - marker.length)
  const prefix = text.slice(0, available)
  const lineBreak = prefix.lastIndexOf('\n')
  return { text: `${lineBreak > available * 0.8 ? prefix.slice(0, lineBreak) : prefix}${marker}`, truncated: true }
}

export interface CaptureInfo {
  /** Top-left of the virtual desktop in screen coordinates (can be negative). */
  originX: number
  originY: number
  /** Screenshot pixels per screen pixel (≤ 1 when downscaled). */
  scale: number
  width: number
  height: number
  /**
   * When set (1000), the model points with coordinates relative to the image, 0..grid on each axis, instead of image pixels:
   * that is how the Qwen3-VL family (Qwen3.5/3.6/3.8 included) and UI-TARS are trained to answer "where is X".
   */
  grid?: number
}

/**
 * The coordinate system a model answers in when it points at a screenshot. Qwen3-VL moved from the absolute pixels of
 * Qwen2.5-VL to coordinates relative to the image on a 0..1000 grid, and the Qwen3.5+ models inherit it; UI-TARS does the same.
 * Read as pixels, those numbers land far from the target (or outside the image), which is what the Chat showed with a Qwen3.5
 * served from Colab. Every other model keeps image pixels.
 */
export function pointerGridFor(model?: string): number {
  const name = (model ?? '').toLowerCase()
  if (/qwen-?3(\.\d+)?[-_:/ ]?vl|qwen-?3\.[5-9]|ui-?tars/.test(name)) return 1000
  return 0
}

const OCU_RELATIVE = 'npm/node_modules/@opensymph/open-computer-use/dist/windows/amd64/open-computer-use.exe'

/** Where the helper binary was found; the order below is the resolution order. */
export type OcuSource = 'explicit' | 'env' | 'bundled' | 'npm' | 'path'

function isFile(candidate: string | undefined): candidate is string {
  if (!candidate) return false
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Locates the open-computer-use helper. Order:
 *  1. the explicit constructor path (`null` disables the backend);
 *  2. env `FORJA_OCU` (legacy aliases `FORJA_OCU_BIN`, `OCU_BIN` count as the same step);
 *  3. the copy bundled with the app, `resources/bin/open-computer-use.exe`;
 *  4. last resort, a copy installed by the user: the npm global package, then PATH.
 */
export function resolveOcu(explicit?: string | null): { path: string; source: OcuSource } | null {
  if (explicit === null) return null
  if (isFile(explicit)) return { path: explicit, source: 'explicit' }

  for (const name of ['FORJA_OCU', 'FORJA_OCU_BIN', 'OCU_BIN']) {
    const value = process.env[name]
    if (isFile(value)) return { path: value, source: 'env' }
  }

  const bundled = bundledBinary('open-computer-use')
  if (bundled) return { path: bundled, source: 'bundled' }

  const npmGlobal = [
    process.env.APPDATA ? path.join(process.env.APPDATA, OCU_RELATIVE) : undefined,
    process.platform === 'win32' ? path.join(os.homedir(), 'AppData/Roaming', OCU_RELATIVE) : undefined
  ].find(isFile)
  if (npmGlobal) return { path: npmGlobal, source: 'npm' }

  const exe = process.platform === 'win32' ? 'open-computer-use.exe' : 'open-computer-use'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, exe)
    if (isFile(candidate)) return { path: candidate, source: 'path' }
  }
  return null
}
const CONTROL_ENV = {
  OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOREGROUND_INPUT: '1',
  OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH: '1',
  OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS: '1'
}
const NO_STATE = /No (app|window) state is available/i
/** Backend tools that only look (they never move the shared mouse/keyboard), so they skip the input queue. */
const READ_ONLY_TOOL = /^(list_|get_|screenshot|capture|cursor_)/
/** Failures that mean "try again" rather than "it will not work": flaky UIA, a busy or restarting backend. */
const TRANSIENT = /timeout|timed out|not ready|is busy|temporar|unavailable|ECONN|EPIPE|socket|closed|reset|restart/i
/** The backend PROCESS died (it can crash under rapid input): a dead process means the call did not run, so it is
 * always safe to restart and retry once — even an input tool, which never double-fires because nothing happened. */
const BACKEND_DOWN = /encerr|exited|exit code|c[óo]digo \d|not running|no longer running|process (exited|closed|killed)|server (closed|stopped|exited)/i

/**
 * Normalize common model-provided key aliases to the Windows runtime's
 * canonical xdotool-style chord. Without this, `Control_L+End` is accepted by
 * validation but the main key fails to resolve in the background message path.
 */
export function normalizeKeyChord(chord: string): string {
  const aliases: Record<string, string> = {
    ctrl: 'ctrl',
    ctrl_l: 'ctrl',
    ctrl_r: 'ctrl',
    control: 'ctrl',
    control_l: 'ctrl',
    control_r: 'ctrl',
    shift_l: 'shift',
    shift_r: 'shift',
    alt_l: 'alt',
    alt_r: 'alt',
    return: 'Return',
    enter: 'Return',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'BackSpace',
    back_space: 'BackSpace',
    page_up: 'Page_Up',
    prior: 'Page_Up',
    page_down: 'Page_Down',
    next: 'Page_Down',
    end: 'End',
    home: 'Home',
    delete: 'Delete',
    del: 'Delete'
  }
  return chord
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => aliases[part.toLowerCase()] ?? part)
    .join('+')
}

/** Converts a point from the last screenshot's pixel space to screen coordinates. */
export function screenshotToScreen(point: { x: number; y: number }, capture: CaptureInfo | null): { x: number; y: number } {
  if (!capture || capture.scale <= 0) return point
  // Relative coordinates (0..grid) become image pixels first; the last pixel row/column is the edge, not one past it.
  const image = capture.grid
    ? {
        x: Math.min(capture.width - 1, (point.x / capture.grid) * capture.width),
        y: Math.min(capture.height - 1, (point.y / capture.grid) * capture.height)
      }
    : point
  return {
    x: Math.round(capture.originX + image.x / capture.scale),
    y: Math.round(capture.originY + image.y / capture.scale)
  }
}

function targetArgs(target: Target): Record<string, unknown> {
  if (target.window != null) return { window: { id: target.window, ...(target.app ? { app: target.app } : {}) } }
  if (target.app) return { app: target.app }
  return {}
}

/**
 * Windows computer-use backend.
 *
 * Perception order (as required by the project brief):
 *  1. UI Automation tree / element indices (open-computer-use, MIT).
 *  2. Win32 window handles and window-relative screenshots (same backend).
 *  3. Full-desktop screenshot + vision (native GDI capture, downscaled).
 *  4. Raw coordinates via SendInput, converted from screenshot space.
 *
 * open-computer-use keeps UI snapshots in memory, so element actions only
 * work inside the process that took the snapshot. The layer therefore keeps
 * one long-lived `open-computer-use mcp` process instead of spawning per call.
 */
export class ComputerLayer {
  private readonly ocuPath: string | null
  private readonly ocuSource: OcuSource | null
  readonly platform = process.platform
  private session: McpClient | null = null
  private sessionControl = false
  private starting: Promise<McpClient> | null = null
  private lastCapture: CaptureInfo | null = null
  private allowControl = false
  /** Incremented on every successful accessibility snapshot. */
  private generation = 0
  /** Latest backend screenshot id per window, used to reject stale coordinates. */
  private readonly windowScreenshots = new Map<number, string>()
  /** Last successful snapshot, used to verify that an action changed the UI. */
  private lastSnapshot: { id: string; target: string; signature: string } | null = null
  /** Element references are valid only for the snapshot that produced them. */
  private readonly snapshotRefs = new Map<string, { target: string; indexes: Set<number> }>()
  private readonly snapshotFrames = new Map<string, Map<number, { x: number; y: number; width: number; height: number }>>()
  private currentSnapshotByTarget = new Map<string, string>()

  constructor(ocuPath?: string | null) {
    const found = resolveOcu(ocuPath)
    this.ocuPath = found?.path ?? null
    this.ocuSource = found?.source ?? null
  }

  get available(): boolean {
    return this.platform === 'win32' && Boolean(this.ocuPath)
  }

  /** Input flags are fixed when the backend starts; the policy decides them. */
  configure(options: { allowControl: boolean }): void {
    this.allowControl = options.allowControl
  }

  get capture(): CaptureInfo | null {
    return this.lastCapture
  }

  status(): ComputerStatus {
    if (this.platform !== 'win32') {
      return { available: false, backend: 'none', detail: 'Computer Use nativo implementado para Windows', platform: this.platform }
    }
    if (!this.ocuPath) {
      return {
        available: false,
        backend: 'native',
        detail:
          'open-computer-use não encontrado (esperado em resources/bin/open-computer-use.exe; rode "npm run embed:bin" ou defina FORJA_OCU). Captura de tela nativa continua disponível.',
        platform: this.platform
      }
    }
    return {
      available: true,
      backend: 'open-computer-use',
      detail: `UI Automation + Win32 + captura nativa · ${this.ocuPath} (${this.ocuSource})`,
      platform: this.platform
    }
  }

  private async backend(): Promise<McpClient> {
    if (!this.ocuPath) throw new Error('open-computer-use não instalado')
    const wantControl = this.allowControl
    if (this.session?.state === 'ready' && this.sessionControl === wantControl) return this.session
    if (this.starting) return this.starting
    this.starting = (async () => {
      await this.session?.stop()
      const client = new McpClient({
        name: 'open-computer-use',
        command: this.ocuPath!,
        args: ['mcp'],
        env: wantControl ? CONTROL_ENV : {}
      })
      await client.start(30_000)
      this.session = client
      this.sessionControl = wantControl
      return client
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * One real mouse and keyboard exist, shared by every session and sub-agent of the app. Anything that
   * moves them runs one at a time, in call order; reads (listing, screenshots) are not delayed.
   */
  private inputQueue: Promise<unknown> = Promise.resolve()

  private serializeInput<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.inputQueue.then(work, work)
    this.inputQueue = turn.catch(() => undefined)
    return turn
  }

  /** Calls one open-computer-use tool; `isError` becomes `ok: false`. The client is fetched inside `run` so a
   * restart (after a crash) is picked up on the retry. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 90_000): Promise<ToolResult> {
    const run = async (): Promise<ToolResult> => {
      try {
        const client = await this.backend()
        return await client.callTool(tool, args, timeoutMs)
      } catch (err) {
        return { ok: false, text: `open-computer-use/${tool}: ${(err as Error).message}` }
      }
    }
    // The backend process can crash under rapid input. A dead process means THIS call did not run, so restarting
    // it and retrying once is safe for every tool (no double-click): element snapshots are gone with the old
    // process, and elementAction then re-snapshots. This keeps a crash from breaking a long desktop task.
    const recoverFromCrash = async (first: ToolResult): Promise<ToolResult> => {
      if (first.ok || !BACKEND_DOWN.test(first.text)) return first
      await this.session?.stop().catch(() => undefined)
      this.session = null
      await this.wait(0.3)
      return run()
    }
    // Reads never move the mouse/keyboard, so they are also safe to retry once on a transient (non-crash) flake.
    if (READ_ONLY_TOOL.test(tool)) {
      const first = await run()
      if (first.ok) return first
      if (BACKEND_DOWN.test(first.text)) return recoverFromCrash(first)
      if (TRANSIENT.test(first.text)) {
        await this.wait(0.3)
        return run()
      }
      return first
    }
    // Input tools are serialized (one shared mouse/keyboard) and retried only on a backend crash, never on a
    // plain "it failed" (which might mean the action already happened).
    return this.serializeInput(async () => recoverFromCrash(await run()))
  }

  /**
   * Element actions need a snapshot in the backend process. If the backend
   * restarted (or the agent skipped the snapshot), take one and retry once.
   */
  /** Center of an element in the snapshot that produced its index, when UIA exposes bounds. */
  private elementCenter(target: Target, index: number): { x: number; y: number } | null {
    const snapshotId = this.currentSnapshotByTarget.get(targetSignature(target))
    const frame = snapshotId ? this.snapshotFrames.get(snapshotId)?.get(index) : undefined
    if (!frame) return null
    return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
  }

  /** Screen point for the overlay cursor, before an element action runs. */
  cursorForElement(target: Target, index: number): { x: number; y: number } | null {
    return this.elementCenter(target, index)
  }

  /** Converts a screenshot point to screen coordinates without touching the real mouse. */
  screenPointFor(point: { x: number; y: number }, space: 'screenshot' | 'screen' = 'screenshot'): { x: number; y: number } | null {
    try {
      return this.toScreen(point, space)
    } catch {
      return null
    }
  }

  /**
   * Takes snapshots until the UI stops changing, so post-action verification
   * does not read a transition frame. Algorithm adapted from munim-computer-use.
   */
  private async snapshotSettled(target: Target, baseline: string | null): Promise<{ result: ToolResult; settled: SettleResult }> {
    let last: ToolResult | null = null
    const settled = await waitForQuiet(async () => {
      const snap = await this.snapshot(target, false)
      last = snap
      return snap.ok ? (this.lastSnapshot?.signature ?? '') : `error:${snap.text.slice(0, 120)}`
    }, baseline)
    return { result: last ?? (await this.snapshot(target, false)), settled }
  }

  private async elementAction(
    tool: string,
    target: Target,
    args: Record<string, unknown>,
    observeAfter = false,
    withImage = false
  ): Promise<ToolResult> {
    const full = { ...targetArgs(target), ...args }
    const targetKey = targetSignature(target)
    const before = this.lastSnapshot?.target === targetKey ? this.lastSnapshot.signature : null
    const elementIndex = typeof args.element_index === 'number' ? args.element_index : undefined
    const center = elementIndex !== undefined ? this.elementCenter(target, elementIndex) : null
    const withCenter = (result: ToolResult): ToolResult =>
      center
        ? {
            ...result,
            data: {
              ...(typeof result.data === 'object' && result.data ? (result.data as Record<string, unknown>) : {}),
              screen: center
            }
          }
        : result
    // A window image can only come from a window target; an app-only target has no single window to capture.
    const wantImage = withImage && target.window != null
    const verdict = (after: { id: string; signature: string } | null): string =>
      before == null ? 'sem linha de base' : before === after?.signature ? 'estado não mudou' : 'estado mudou'
    const first = await this.call(tool, full)
    if (first.ok || !NO_STATE.test(first.text)) {
      if (!first.ok) return withCenter(first)
      if (observeAfter) {
        // Wait for the UI to settle, then leave a fresh snapshot (and, for vision models, a window image) in
        // the same result so the model can confirm the action without a second tool call.
        const { settled } = await this.snapshotSettled(target, before)
        const snap = wantImage ? await this.snapshot(target, true) : await this.snapshot(target, false)
        if (snap.ok) {
          const after = this.lastSnapshot
          return withCenter({
            ...first,
            text: `${first.text}\n[verificação: ${verdict(after)} · snapshot ${after?.id} · settle ${settled.elapsedMs}ms${settled.timedOut ? ' (timeout)' : ''}${wantImage && snap.images?.length ? ' · imagem da janela anexada' : ''}]`,
            ...(snap.images?.length ? { images: snap.images } : {}),
            data: {
              ...(typeof first.data === 'object' && first.data ? (first.data as Record<string, unknown>) : {}),
              snapshot_id: after?.id,
              generation: this.generation,
              state_changed: before == null ? null : before !== after?.signature,
              settle_ms: settled.elapsedMs,
              settle_reacted: settled.reacted,
              settle_timed_out: settled.timedOut
            }
          })
        }
        return withCenter(first)
      }
      // No settle: one post-action snapshot (with the window image for vision models).
      const snap = await this.snapshot(target, wantImage)
      if (snap.ok) {
        const after = this.lastSnapshot
        return withCenter({
          ...first,
          text: `${first.text}\n[verificação: ${verdict(after)} · snapshot ${after?.id}${wantImage && snap.images?.length ? ' · imagem da janela anexada' : ''}]`,
          ...(snap.images?.length ? { images: snap.images } : {}),
          data: {
            ...(typeof first.data === 'object' && first.data ? (first.data as Record<string, unknown>) : {}),
            snapshot_id: after?.id,
            generation: this.generation,
            state_changed: before == null ? null : before !== after?.signature
          }
        })
      }
      return withCenter(first)
    }
    const snap = await this.snapshot(target, false)
    if (!snap.ok) return withCenter(first)
    return withCenter(await this.call(tool, full))
  }

  async listWindows(): Promise<ToolResult> {
    return this.call('list_windows', {})
  }

  async listApps(): Promise<ToolResult> {
    return this.call('list_apps', {})
  }

  /** Rehydrates a previously returned window id; never construct window handles. */
  async getWindow(id: number, app?: string): Promise<ToolResult> {
    return this.call('get_window', { window: { id, ...(app ? { app } : {}) } }, 30_000)
  }

  /** UI Automation tree (with element indices) of an app or a window. */
  async snapshot(target: Target, includeScreenshot = false): Promise<ToolResult> {
    let result =
      target.window != null
        ? await this.call('get_window_state', {
            ...targetArgs(target),
            include_text: true,
            ...(includeScreenshot ? { include_screenshot: true } : {})
          })
        : target.app
          ? await this.call('get_app_state', { app: target.app })
          : ({ ok: false, text: 'informe app ou window' } as ToolResult)
    if (!includeScreenshot && result.images) result = { ...result, images: undefined }
    let screenshotId: string | undefined
    if (result.ok) {
      this.generation++
      const id = `snap_${this.generation.toString(36)}_${Date.now().toString(36)}`
      const targetKey = targetSignature(target)
      const limited = limitSnapshotText(result.text)
      const indexes = new Set<number>()
      const frames = new Map<number, { x: number; y: number; width: number; height: number }>()
      for (const line of result.text.split('\n')) {
        const index = /^\s*(\d+)\s/.exec(line)?.[1]
        if (index !== undefined) indexes.add(Number(index))
        const frame = /^\s*(\d+)\s.*?Frame:\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+),\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/.exec(line)
        if (frame) {
          frames.set(Number(frame[1]), {
            x: Number(frame[2]),
            y: Number(frame[3]),
            width: Number(frame[4]),
            height: Number(frame[5])
          })
        }
      }
      this.snapshotRefs.set(id, { target: targetKey, indexes })
      this.snapshotFrames.set(id, frames)
      this.currentSnapshotByTarget.set(targetKey, id)
      this.lastSnapshot = { id, target: targetKey, signature: signatureOf(result.text) }
      if (includeScreenshot && target.window != null && result.images?.length) {
        screenshotId = /"id"\s*:\s*"(shot-\d+-\d+)"/.exec(result.text)?.[1]
        if (screenshotId) this.windowScreenshots.set(target.window, screenshotId)
        else this.windowScreenshots.delete(target.window)
      }
      return {
        ...result,
        text: limited.text,
        data: {
          ...(typeof result.data === 'object' && result.data ? (result.data as Record<string, unknown>) : {}),
          snapshot_id: id,
          generation: this.generation,
          truncated: limited.truncated,
          ...(screenshotId ? { screenshot_id: screenshotId } : {})
        }
      }
    }
    return result
  }

  async clickElement(target: Target, elementIndex: number, clickCount = 1, button?: 'left' | 'right' | 'middle'): Promise<ToolResult> {
    return this.elementAction('click', target, {
      element_index: elementIndex,
      ...(clickCount > 1 ? { click_count: clickCount } : {}),
      ...(button ? { mouse_button: button } : {})
    })
  }

  async clickElementWithOptions(
    target: Target,
    elementIndex: number,
    clickCount = 1,
    button?: 'left' | 'right' | 'middle',
    inputMethod?: InputMethod,
    clickMethod?: ClickMethod,
    observeAfter = false,
    withImage = false
  ): Promise<ToolResult> {
    return this.elementAction(
      'click',
      target,
      {
        element_index: elementIndex,
        ...(clickCount > 1 ? { click_count: clickCount } : {}),
        ...(button ? { mouse_button: button } : {}),
        ...(inputMethod ? { input_method: inputMethod } : {}),
        ...(clickMethod ? { click_method: clickMethod } : {})
      },
      observeAfter,
      withImage
    )
  }

  /** Resolves a snapshot-bound ref and rejects stale snapshots before any input. */
  resolveSnapshotRef(target: Target, snapshotId: string | undefined, ref: string): { index?: number; error?: string } {
    const match = /^e?(\d+)$/i.exec(ref.trim())
    if (!match || !snapshotId) return { error: 'informe ref no formato e12 junto com snapshot_id' }
    const targetKey = targetSignature(target)
    const snapshot = this.snapshotRefs.get(snapshotId)
    if (!snapshot || snapshot.target !== targetKey) {
      return { error: 'element_stale: snapshot desconhecido ou de outro alvo; tire um novo computer_snapshot' }
    }
    if (this.currentSnapshotByTarget.get(targetKey) !== snapshotId) {
      return { error: 'element_stale: snapshot antigo; tire um novo computer_snapshot e use a nova ref' }
    }
    const index = Number(match[1])
    if (!snapshot.indexes.has(index)) return { error: `element_stale: ref e${index} não existe no snapshot ${snapshotId}` }
    return { index }
  }

  /** Click at window-relative coordinates of the window's own screenshot. */
  async clickInWindow(window: number, x: number, y: number, clickCount = 1, button?: 'left' | 'right' | 'middle'): Promise<ToolResult> {
    return this.elementAction('click', { window }, {
      x,
      y,
      ...(clickCount > 1 ? { click_count: clickCount } : {}),
      ...(button ? { mouse_button: button } : {})
    })
  }

  async clickInWindowWithOptions(
    window: number,
    x: number,
    y: number,
    clickCount = 1,
    button?: 'left' | 'right' | 'middle',
    inputMethod?: InputMethod,
    clickMethod?: ClickMethod,
    observeAfter = false,
    withImage = false
  ): Promise<ToolResult> {
    const screenshotId = this.windowScreenshots.get(window)
    return this.elementAction(
      'click',
      { window },
      {
        x,
        y,
        ...(clickCount > 1 ? { click_count: clickCount } : {}),
        ...(button ? { mouse_button: button } : {}),
        ...(inputMethod ? { input_method: inputMethod } : {}),
        ...(clickMethod ? { click_method: clickMethod } : {}),
        ...(screenshotId ? { screenshotId } : {})
      },
      observeAfter,
      withImage
    )
  }

  async setValue(target: Target, elementIndex: number, value: string, observeAfter = false, withImage = false): Promise<ToolResult> {
    return this.elementAction('set_value', target, { element_index: elementIndex, value }, observeAfter, withImage)
  }

  async setValueWithOptions(
    target: Target,
    elementIndex: number,
    value: string,
    inputMethod?: InputMethod,
    observeAfter = false
  ): Promise<ToolResult> {
    return this.elementAction(
      'set_value',
      target,
      {
        element_index: elementIndex,
        value,
        ...(inputMethod ? { input_method: inputMethod } : {})
      },
      observeAfter
    )
  }

  async secondaryAction(
    target: Target,
    elementIndex: number,
    action: string,
    inputMethod?: InputMethod,
    observeAfter = false,
    withImage = false
  ): Promise<ToolResult> {
    return this.elementAction(
      'perform_secondary_action',
      target,
      {
        element_index: elementIndex,
        action,
        ...(inputMethod ? { input_method: inputMethod } : {})
      },
      observeAfter,
      withImage
    )
  }

  /** Types into the focused element of a target window (focus it first with a click). */
  async typeIn(target: Target, text: string, inputMethod?: InputMethod, observeAfter = false, withImage = false): Promise<ToolResult> {
    return this.elementAction(
      'type_text',
      target,
      { text, ...(inputMethod ? { input_method: inputMethod } : {}) },
      observeAfter,
      withImage
    )
  }

  async pressKeyIn(target: Target, key: string, inputMethod?: InputMethod): Promise<ToolResult> {
    // Shortcuts (Ctrl+S, Alt+F4...) only trigger when the key events come through the real input queue of the
    // focused window; the default "post to the window" route is ignored by the accelerator tables of classic
    // apps (checked with Notepad: the file was not saved until the chord was sent as global input).
    const shortcut = /(^|\+)(ctrl|control|alt|win|windows|cmd|command|meta|super)(\+|$)/i.test(key)
    const method = inputMethod ?? (shortcut && (target.window != null || target.app) ? 'global' : undefined)
    return this.elementAction('press_key', target, {
      key: normalizeKeyChord(key),
      ...(method ? { input_method: method } : {})
    })
  }

  /** Window-relative scroll with the backend's screenshot/bounds gate. */
  async scrollInWindow(
    window: number,
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    screenshotId?: string,
    inputMethod?: InputMethod
  ): Promise<ToolResult> {
    const binding = screenshotId ?? this.windowScreenshots.get(window)
    return this.call('scroll', {
      window: { id: window },
      x,
      y,
      scrollX: deltaX,
      scrollY: deltaY,
      ...(binding ? { screenshotId: binding } : {}),
      ...(inputMethod ? { input_method: inputMethod } : {})
    })
  }

  /** Window-relative drag with the backend's screenshot/bounds gate. */
  async dragInWindow(
    window: number,
    from: { x: number; y: number },
    to: { x: number; y: number },
    screenshotId?: string,
    inputMethod?: InputMethod
  ): Promise<ToolResult> {
    const binding = screenshotId ?? this.windowScreenshots.get(window)
    return this.call('drag', {
      window: { id: window },
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
      ...(binding ? { screenshotId: binding } : {}),
      ...(inputMethod ? { input_method: inputMethod } : {})
    }, 45_000)
  }

  async launchApp(app: string): Promise<ToolResult> {
    return this.call('launch_app', { app }, 45_000)
  }

  async activateWindow(window: number): Promise<ToolResult> {
    return this.call('activate_window', { window: { id: window } }, 30_000)
  }

  /* ----------------------- global input (CLI) ----------------------- */

  private run(args: string[], timeoutMs = 60_000, extraEnv: Record<string, string> = {}): Promise<OcuResult> {
    if (!this.ocuPath) {
      return Promise.resolve({ code: -1, stdout: '', stderr: 'open-computer-use não instalado' })
    }
    return new Promise((resolve) => {
      const child = spawn(this.ocuPath!, args, {
        windowsHide: true,
        env: { ...process.env, ...extraEnv }
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        resolve({ code: -2, stdout, stderr: `${stderr}\n(timeout)` })
      }, timeoutMs)
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  private input(args: string[], timeoutMs = 30_000): Promise<OcuResult> {
    return this.serializeInput(() => this.run(['input', ...args], timeoutMs, { OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOREGROUND_INPUT: '1' }))
  }

  /** Converts a point from the last screenshot's pixel space to screen coordinates. */
  private toScreen(point: { x: number; y: number }, space: 'screenshot' | 'screen'): { x: number; y: number } {
    if (space === 'screen') return point
    const capture = this.lastCapture
    if (capture?.grid) {
      if (point.x < 0 || point.y < 0 || point.x > capture.grid || point.y > capture.grid) {
        throw new Error(
          `coordenada (${point.x}, ${point.y}) fora da grade da última captura (0 a ${capture.grid} em cada eixo); ` +
            'use computer_screenshot e aponte com coordenadas relativas à imagem'
        )
      }
    } else if (capture) {
      if (point.x < 0 || point.y < 0 || point.x >= capture.width || point.y >= capture.height) {
        throw new Error(
          `coordenada (${point.x}, ${point.y}) fora da última captura ${capture.width}x${capture.height}; ` +
            'use computer_screenshot e escolha um ponto dentro da imagem'
        )
      }
    }
    return screenshotToScreen(point, capture)
  }

  /** Clicks a point given in screenshot pixels (default) or raw screen pixels. */
  async clickAt(point: { x: number; y: number }, count = 1, space: 'screenshot' | 'screen' = 'screenshot'): Promise<OcuResult & { screen: { x: number; y: number } }> {
    const screen = this.toScreen(point, space)
    const result = await this.input(['click', '--x', String(screen.x), '--y', String(screen.y), '--count', String(count)])
    return { ...result, screen }
  }

  /** Moves the real pointer without clicking. Coordinates follow the last screenshot by default. */
  async moveMouse(point: { x: number; y: number }, space: 'screenshot' | 'screen' = 'screenshot'): Promise<OcuResult & { screen: { x: number; y: number }; actual: { x: number; y: number } | null }> {
    const screen = this.toScreen(point, space)
    const result = await this.input(['move', String(screen.x), String(screen.y)])
    const actual = await this.cursorPosition()
    return { ...result, screen, actual }
  }

  /** Presses or releases a mouse button, optionally at a point (for drags and context menus). */
  async mouseButton(
    action: 'down' | 'up',
    button: 'left' | 'right' | 'middle' = 'left',
    point?: { x: number; y: number },
    space: 'screenshot' | 'screen' = 'screenshot'
  ): Promise<OcuResult & { screen?: { x: number; y: number } }> {
    const args = [`mouse_${action}`, '--button', button]
    let screen: { x: number; y: number } | undefined
    if (point) {
      screen = this.toScreen(point, space)
      args.push('--x', String(screen.x), '--y', String(screen.y))
    }
    const result = await this.input(args)
    return { ...result, screen }
  }

  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    space: 'screenshot' | 'screen' = 'screenshot',
    button: 'left' | 'right' | 'middle' = 'left'
  ): Promise<OcuResult & { from: { x: number; y: number }; to: { x: number; y: number } }> {
    const a = this.toScreen(from, space)
    const b = this.toScreen(to, space)
    const result = await this.input(['drag', String(a.x), String(a.y), String(b.x), String(b.y), '--button', button], 45_000)
    return { ...result, from: a, to: b }
  }

  async scroll(
    direction: 'up' | 'down' | 'left' | 'right',
    amount = 3,
    point?: { x: number; y: number }
  ): Promise<OcuResult & { screen?: { x: number; y: number } }> {
    const args = ['scroll', direction, '--amount', String(amount)]
    let screen: { x: number; y: number } | undefined
    if (point) {
      screen = this.toScreen(point, 'screenshot')
      args.push('--x', String(screen.x), '--y', String(screen.y))
    }
    const result = await this.input(args)
    return { ...result, screen }
  }

  async typeText(text: string): Promise<OcuResult> {
    return this.input(['type', text], 60_000)
  }

  async pressKey(chord: string): Promise<OcuResult> {
    return this.input(['key', normalizeKeyChord(chord)])
  }

  async wait(seconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.round(seconds * 1000)))
  }

  async cursorPosition(): Promise<{ x: number; y: number } | null> {
    const result = await this.run(['cursor-position'], 15_000)
    try {
      const parsed = JSON.parse(result.stdout) as { x?: number; y?: number; position?: { x: number; y: number } }
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return { x: parsed.x, y: parsed.y }
      if (parsed.position) return parsed.position
      return null
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    await this.session?.stop()
    this.session = null
  }

  /**
   * Native GDI capture, downscaled to keep vision tokens sane. Uses the full
   * virtual desktop so multi-monitor setups are covered, and remembers the
   * origin/scale so later clicks can be converted back to screen coordinates.
   */
  async captureScreen(
    maxWidth = 0,
    options: { grid?: number; monitor?: number } = {}
  ): Promise<{
    image: ImagePart
    width: number
    height: number
    path: string
    originalWidth: number
    capture: CaptureInfo
    monitors: Array<{ index: number; x: number; y: number; width: number; height: number; primary: boolean }>
    /** Which monitor the image shows (1, 2…), or 0 when it shows all of them side by side. */
    shown: number
  }> {
    if (process.platform !== 'win32') throw new Error('captura nativa implementada para Windows')
    const dir = path.join(os.tmpdir(), 'forja-shots')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, `shot-${Date.now()}.png`)
    const escaped = file.replace(/'/g, "''")
    // One monitor at a time, the primary one unless another is asked for (0 = all of them side by side). Two 1920 monitors
    // squeezed into one 1600 px image made every image pixel 2.4 screen pixels, and small targets were missed.
    const monitor = options.monitor === undefined ? -1 : Math.max(0, Math.floor(options.monitor))
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$all=[System.Windows.Forms.Screen]::AllScreens',
      `$pick=${monitor}`,
      '$b=$null; $shown=0',
      // One element: the statements are joined with "; ", and PowerShell does not accept "; elseif".
      'if ($pick -eq 0) { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen } ' +
        'elseif ($pick -ge 1 -and $pick -le $all.Length) { $b=$all[$pick-1].Bounds; $shown=$pick } ' +
        'else { $i=0; foreach ($s in $all) { $i++; if ($s.Primary -and -not $b) { $b=$s.Bounds; $shown=$i } } }',
      'if (-not $b) { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $shown=0 }',
      `$max=${Math.max(0, Math.floor(maxWidth))}`,
      'if ($max -le 0) { if ($shown -eq 0) { $max=[Math]::Min(2560, 1600 * $all.Length) } else { $max=1600 } }',
      '$scale=[Math]::Min(1.0, $max / [double]$b.Width)',
      '$w=[int][Math]::Round($b.Width * $scale); $h=[int][Math]::Round($b.Height * $scale)',
      '$src=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
      '$g=[System.Drawing.Graphics]::FromImage($src)',
      '$g.CopyFromScreen($b.X,$b.Y,0,0,(New-Object System.Drawing.Size $b.Width,$b.Height))',
      '$dst=New-Object System.Drawing.Bitmap $w,$h',
      '$g2=[System.Drawing.Graphics]::FromImage($dst)',
      '$g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '$g2.DrawImage($src,0,0,$w,$h)',
      `$dst.Save('${escaped}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose(); $g2.Dispose(); $src.Dispose(); $dst.Dispose()',
      'Write-Output "$($b.X),$($b.Y),$($b.Width),$($b.Height)"',
      'Write-Output "shown,$shown"',
      '$i=0; foreach ($s in $all) { $i++; Write-Output "monitor,$i,$($s.Bounds.X),$($s.Bounds.Y),$($s.Bounds.Width),$($s.Bounds.Height),$($s.Primary)" }'
    ].join('; ')

    const result = await new Promise<OcuResult>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })

    if (result.code !== 0 || !fs.existsSync(file)) {
      throw new Error(`captura de tela falhou: ${result.stderr.slice(0, 400)}`)
    }
    const buffer = await fs.promises.readFile(file)
    const lines = result.stdout.trim().split(/\r?\n/)
    const [originX, originY, screenWidth] = (lines.find((line) => !/^(monitor|shown),/.test(line)) ?? '').split(',').map(Number)
    const shown = Number((lines.find((line) => line.startsWith('shown,')) ?? 'shown,0').split(',')[1]) || 0
    const monitors = lines
      .filter((line) => line.startsWith('monitor,'))
      .map((line) => {
        const [, index, x, y, width, height, primary] = line.split(',')
        return { index: Number(index), x: Number(x), y: Number(y), width: Number(width), height: Number(height), primary: /true/i.test(primary) }
      })
    const dims = pngSize(buffer)
    const capture: CaptureInfo = {
      originX: originX || 0,
      originY: originY || 0,
      scale: screenWidth ? dims.width / screenWidth : 1,
      width: dims.width,
      height: dims.height,
      ...(options.grid ? { grid: options.grid } : {})
    }
    this.lastCapture = capture
    return {
      image: { type: 'image', mediaType: 'image/png', data: buffer.toString('base64'), label: `tela ${dims.width}x${dims.height}` },
      width: dims.width,
      height: dims.height,
      originalWidth: screenWidth || dims.width,
      path: file,
      capture,
      monitors,
      shown
    }
  }

  /**
   * A 1:1 crop of the real screen around a point, with a red cross on it: what the model looks at to check that the pointer
   * really stopped on the target before it clicks (GDI captures leave the Windows cursor out, so the cross stands in for it).
   */
  async captureAround(point: { x: number; y: number }, half = 110): Promise<ImagePart | null> {
    if (process.platform !== 'win32') return null
    const dir = path.join(os.tmpdir(), 'forja-shots')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, `pointer-${Date.now()}.png`)
    const size = half * 2
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      `$bmp=New-Object System.Drawing.Bitmap ${size},${size}`,
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      `$g.CopyFromScreen(${Math.round(point.x) - half},${Math.round(point.y) - half},0,0,(New-Object System.Drawing.Size ${size},${size}))`,
      '$pen=New-Object System.Drawing.Pen ([System.Drawing.Color]::Red),2',
      `$g.DrawLine($pen,${half},0,${half},${half - 6}); $g.DrawLine($pen,${half},${half + 6},${half},${size})`,
      `$g.DrawLine($pen,0,${half},${half - 6},${half}); $g.DrawLine($pen,${half + 6},${half},${size},${half})`,
      `$g.DrawEllipse($pen,${half - 6},${half - 6},12,12)`,
      `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$pen.Dispose(); $g.Dispose(); $bmp.Dispose()'
    ].join('; ')
    const code = await new Promise<number>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
      child.on('error', () => resolve(-1))
      child.on('close', (exit) => resolve(exit ?? -1))
    })
    if (code !== 0 || !fs.existsSync(file)) return null
    const buffer = await fs.promises.readFile(file)
    return { type: 'image', mediaType: 'image/png', data: buffer.toString('base64'), label: `ponteiro em ${Math.round(point.x)},${Math.round(point.y)}` }
  }
}

/** Reads PNG dimensions from the IHDR chunk without an image library. */
export function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function targetSignature(target: Target): string {
  return target.window != null ? `window:${target.window}` : `app:${target.app ?? ''}`
}

/** Stable, cheap fingerprint of an accessibility tree (FNV-1a). */
function signatureOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length.toString(36)}:${(hash >>> 0).toString(36)}`
}
