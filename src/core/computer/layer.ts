import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ComputerStatus, ImagePart, ToolResult } from '../../shared/types.js'
import { McpClient } from '../mcp/client.js'
import { bundledBinary } from '../util/resources.js'

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

export interface CaptureInfo {
  /** Top-left of the virtual desktop in screen coordinates (can be negative). */
  originX: number
  originY: number
  /** Screenshot pixels per screen pixel (≤ 1 when downscaled). */
  scale: number
  width: number
  height: number
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

/** Converts a point from the last screenshot's pixel space to screen coordinates. */
export function screenshotToScreen(point: { x: number; y: number }, capture: CaptureInfo | null): { x: number; y: number } {
  if (!capture || capture.scale <= 0) return point
  return {
    x: Math.round(capture.originX + point.x / capture.scale),
    y: Math.round(capture.originY + point.y / capture.scale)
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
  /** Last successful snapshot, used to verify that an action changed the UI. */
  private lastSnapshot: { id: string; target: string; signature: string } | null = null

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

  /** Calls one open-computer-use tool; `isError` becomes `ok: false`. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 90_000): Promise<ToolResult> {
    const client = await this.backend()
    try {
      return await client.callTool(tool, args, timeoutMs)
    } catch (err) {
      return { ok: false, text: `open-computer-use/${tool}: ${(err as Error).message}` }
    }
  }

  /**
   * Element actions need a snapshot in the backend process. If the backend
   * restarted (or the agent skipped the snapshot), take one and retry once.
   */
  private async elementAction(tool: string, target: Target, args: Record<string, unknown>): Promise<ToolResult> {
    const full = { ...targetArgs(target), ...args }
    const targetKey = targetSignature(target)
    const before = this.lastSnapshot?.target === targetKey ? this.lastSnapshot.signature : null
    const first = await this.call(tool, full)
    if (first.ok || !NO_STATE.test(first.text)) {
      if (!first.ok) return first
      // Formal post-action verification: every element action leaves a fresh
      // accessibility snapshot and reports whether the UI actually changed.
      const snap = await this.snapshot(target, false)
      if (snap.ok) {
        const after = this.lastSnapshot
        return {
          ...first,
          text: `${first.text}\n[verificação: ${before == null ? 'sem linha de base' : before === after?.signature ? 'estado não mudou' : 'estado mudou'} · snapshot ${after?.id}]`,
          data: {
            ...(typeof first.data === 'object' && first.data ? (first.data as Record<string, unknown>) : {}),
            snapshot_id: after?.id,
            generation: this.generation,
            state_changed: before == null ? null : before !== after?.signature
          }
        }
      }
      return first
    }
    const snap = await this.snapshot(target, false)
    if (!snap.ok) return first
    return this.call(tool, full)
  }

  async listWindows(): Promise<ToolResult> {
    return this.call('list_windows', {})
  }

  async listApps(): Promise<ToolResult> {
    return this.call('list_apps', {})
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
    if (result.ok) {
      this.generation++
      const id = `snap_${this.generation.toString(36)}_${Date.now().toString(36)}`
      this.lastSnapshot = { id, target: targetSignature(target), signature: signatureOf(result.text) }
      return {
        ...result,
        data: {
          ...(typeof result.data === 'object' && result.data ? (result.data as Record<string, unknown>) : {}),
          snapshot_id: id,
          generation: this.generation
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

  /** Click at window-relative coordinates of the window's own screenshot. */
  async clickInWindow(window: number, x: number, y: number, clickCount = 1, button?: 'left' | 'right' | 'middle'): Promise<ToolResult> {
    return this.elementAction('click', { window }, {
      x,
      y,
      ...(clickCount > 1 ? { click_count: clickCount } : {}),
      ...(button ? { mouse_button: button } : {})
    })
  }

  async setValue(target: Target, elementIndex: number, value: string): Promise<ToolResult> {
    return this.elementAction('set_value', target, { element_index: elementIndex, value })
  }

  async secondaryAction(target: Target, elementIndex: number, action: string): Promise<ToolResult> {
    return this.elementAction('perform_secondary_action', target, { element_index: elementIndex, action })
  }

  /** Types into the focused element of a target window (focus it first with a click). */
  async typeIn(target: Target, text: string): Promise<ToolResult> {
    return this.elementAction('type_text', target, { text })
  }

  async pressKeyIn(target: Target, key: string): Promise<ToolResult> {
    return this.elementAction('press_key', target, { key })
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
    return this.run(['input', ...args], timeoutMs, { OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOREGROUND_INPUT: '1' })
  }

  /** Converts a point from the last screenshot's pixel space to screen coordinates. */
  private toScreen(point: { x: number; y: number }, space: 'screenshot' | 'screen'): { x: number; y: number } {
    if (space === 'screen') return point
    const capture = this.lastCapture
    if (capture) {
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
  ): Promise<OcuResult> {
    const a = this.toScreen(from, space)
    const b = this.toScreen(to, space)
    return this.input(['drag', String(a.x), String(a.y), String(b.x), String(b.y), '--button', button], 45_000)
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 3, point?: { x: number; y: number }): Promise<OcuResult> {
    const args = ['scroll', direction, '--amount', String(amount)]
    if (point) {
      const screen = this.toScreen(point, 'screenshot')
      args.push('--x', String(screen.x), '--y', String(screen.y))
    }
    return this.input(args)
  }

  async typeText(text: string): Promise<OcuResult> {
    return this.input(['type', text], 60_000)
  }

  async pressKey(chord: string): Promise<OcuResult> {
    return this.input(['key', chord])
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
  async captureScreen(maxWidth = 1600): Promise<{ image: ImagePart; width: number; height: number; path: string; originalWidth: number; capture: CaptureInfo }> {
    if (process.platform !== 'win32') throw new Error('captura nativa implementada para Windows')
    const dir = path.join(os.tmpdir(), 'forja-shots')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, `shot-${Date.now()}.png`)
    const escaped = file.replace(/'/g, "''")
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
      `$max=${maxWidth}`,
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
      'Write-Output "$($b.X),$($b.Y),$($b.Width),$($b.Height)"'
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
    const [originX, originY, screenWidth] = result.stdout.trim().split(',').map(Number)
    const dims = pngSize(buffer)
    const capture: CaptureInfo = {
      originX: originX || 0,
      originY: originY || 0,
      scale: screenWidth ? dims.width / screenWidth : 1,
      width: dims.width,
      height: dims.height
    }
    this.lastCapture = capture
    return {
      image: { type: 'image', mediaType: 'image/png', data: buffer.toString('base64'), label: `tela ${dims.width}x${dims.height}` },
      width: dims.width,
      height: dims.height,
      originalWidth: screenWidth || dims.width,
      path: file,
      capture
    }
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
