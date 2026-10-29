import { app, BrowserWindow, screen, type Display } from 'electron'
import { ComputerActivityTracker, isOverlayTool } from '../core/computer/activity.js'
import { MascotMoodTracker, type MascotState } from '../core/computer/mood.js'
import type { HarnessEvent } from '../shared/types.js'
import { overlayHtml } from './computer-overlay-html.js'

/** How long the indicator stays after the last computer call of a turn (long enough for the happy/sad ending). */
const LINGER_MS = 3200
/** How often the mascot re-reads the time-based signals (silence, expiring reactions) while visible. */
const MOOD_TICK_MS = 1000

/**
 * Paints the orange desktop border and the top-center mascot while an agent is
 * looking at or controlling the real desktop.
 *
 * One transparent, click-through window is created per monitor. The border is
 * drawn on every screen; the mascot only on the primary one. The windows are
 * marked as protected content so `computer_screenshot` (and any other capture)
 * sees the user's desktop, never the overlay itself.
 */
export class ComputerOverlay {
  private readonly windows = new Map<number, BrowserWindow>()
  private readonly tracker = new ComputerActivityTracker((active) => this.toggle(active), LINGER_MS)
  /** How the mascot feels: derived from the same events, shown through `window.setAgentMood`. */
  private readonly mood = new MascotMoodTracker((state) => this.applyMood(state))
  private moodTimer: ReturnType<typeof setInterval> | null = null
  private signature = ''
  private listening = false
  private disposed = false
  private visible = false
  /** Last point the agent acted on, kept across hide/show cycles. */
  private lastPoint: { x: number; y: number } | null = null
  private lastPointIsDip = true

  /** Enable with OPENCLOD_OVERLAY_CAPTURE=1 to record demos/screenshots of the overlay. */
  private readonly protectFromCapture = process.env.OPENCLOD_OVERLAY_CAPTURE !== '1'

  handle(event: HarnessEvent): void {
    if (this.disposed) return
    try {
      // Before the activity tracker, so the mood is already right when the overlay appears.
      this.mood.handle(event)
    } catch {
      // The mascot's mood is decoration: it must never break the agent turn.
    }
    this.tracker.handle(event)
    if ((event.type === 'tool_end' || event.type === 'tool_progress') && isOverlayTool(event.name)) {
      const point = pointFromData(event.data)
      if (point) {
        const press = event.type === 'tool_end' && /click|mouse_button|drag|type/.test(event.name)
        this.moveCursor(point.point, press, point.dip)
      }
    }
  }

  get active(): boolean {
    return this.tracker.active
  }

  private toggle(active: boolean): void {
    this.visible = active
    if (active) this.show()
    else this.hide()
  }

  private show(): void {
    if (this.disposed || !app.isReady()) return
    this.bindDisplayEvents()
    this.ensureWindows()
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.showInactive()
    }
    // The pointer is part of the indicator: it must be visible for the whole
    // turn, even before the first coordinate-bearing action.
    this.restoreCursor()
    this.startMoodClock()
    this.refreshMood()
  }

  /** Re-reads the time-based mood signals once a second while the overlay is visible. */
  private startMoodClock(): void {
    if (this.moodTimer || this.disposed) return
    this.moodTimer = setInterval(() => {
      try {
        this.mood.tick()
      } catch {
        // Never let a decorative timer throw into the main process.
      }
    }, MOOD_TICK_MS)
    this.moodTimer.unref?.()
  }

  private stopMoodClock(): void {
    if (!this.moodTimer) return
    clearInterval(this.moodTimer)
    this.moodTimer = null
  }

  /** Expires stale reactions, then paints the current mood on every window. */
  private refreshMood(): void {
    try {
      this.mood.tick()
    } catch {
      // see startMoodClock
    }
    this.applyMood(this.mood.state)
  }

  private applyMood(state: MascotState): void {
    if (this.disposed) return
    const script = `window.setAgentMood?.(${JSON.stringify(state)})`
    for (const win of this.windows.values()) {
      if (win.isDestroyed()) continue
      void win.webContents.executeJavaScript(script).catch(() => undefined)
    }
  }

  /** Shows the cursor at the last known point, or at the primary screen center. */
  private restoreCursor(): void {
    if (!this.visible || this.disposed) return
    let point = this.lastPoint
    let dip = this.lastPointIsDip
    if (!point) {
      const display = screen.getPrimaryDisplay()
      point = {
        x: display.bounds.x + display.bounds.width / 2,
        y: display.bounds.y + display.bounds.height / 2
      }
      dip = true
    }
    this.moveCursor(point, false, dip)
  }

  /** Places the agent pointer on the monitor that contains a screen point. */
  private moveCursor(point: { x: number; y: number }, press = false, alreadyDip = false): void {
    if (!this.visible || this.disposed) return
    this.lastPoint = point
    this.lastPointIsDip = alreadyDip
    this.ensureWindows()
    // Computer Use reports physical screen pixels; the Chrome extension
    // reports window bounds already in DIP. Electron windows use DIP.
    const dip = alreadyDip
      ? point
      : (() => {
          try {
            return screen.screenToDipPoint(point)
          } catch {
            return point
          }
        })()
    const displays = screen.getAllDisplays()
    const target = displays.find(
      (display) =>
        dip.x >= display.bounds.x &&
        dip.y >= display.bounds.y &&
        dip.x < display.bounds.x + display.bounds.width &&
        dip.y < display.bounds.y + display.bounds.height
    )
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue
      const display = displays.find((item) => item.id === id)
      if (!display) continue
      const script =
        target?.id === id
          ? `window.setAgentCursor(${dip.x - display.bounds.x}, ${dip.y - display.bounds.y}, ${press})`
          : 'window.hideAgentCursor?.()'
      void win.webContents.executeJavaScript(script).catch(() => undefined)
    }
  }

  private hide(): void {
    this.stopMoodClock()
    for (const win of this.windows.values()) {
      if (win.isDestroyed()) continue
      void win.webContents.executeJavaScript('window.pauseAgentFace?.()').catch(() => undefined)
      win.hide()
    }
  }

  /** Recreates the windows when monitors are added, removed or repositioned. */
  private ensureWindows(): void {
    const displays = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    const signature = displays
      .map((display) => `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}`)
      .join('|')
      .concat(`|primary:${primaryId}`)

    const alive = [...this.windows.values()].every((win) => !win.isDestroyed())
    if (this.signature === signature && alive && this.windows.size === displays.length) return

    this.disposeWindows()
    this.signature = signature
    for (const display of displays) {
      const win = this.createWindow(display, display.id === primaryId)
      if (win) this.windows.set(display.id, win)
    }
  }

  private createWindow(display: Display, primary: boolean): BrowserWindow | null {
    try {
      const { x, y, width, height } = display.bounds
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setIgnoreMouseEvents(true, { forward: true })
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setFocusable(false)
      if (this.protectFromCapture) win.setContentProtection(true)
      win.on('closed', () => {
        if (this.windows.get(display.id) === win) this.windows.delete(display.id)
      })
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(primary))}`)
      win.webContents.once('did-finish-load', () => {
        if (!this.visible || win.isDestroyed()) return
        win.showInactive()
        this.restoreCursor()
        // A window created mid-turn starts as `calm`: give it the current mood.
        void win.webContents
          .executeJavaScript(`window.setAgentMood?.(${JSON.stringify(this.mood.state)})`)
          .catch(() => undefined)
      })
      win.once('ready-to-show', () => {
        if (this.visible && !win.isDestroyed()) win.showInactive()
      })
      if (this.visible) win.showInactive()
      return win
    } catch {
      // An overlay failing to start must never break the agent turn.
      return null
    }
  }

  private bindDisplayEvents(): void {
    if (this.listening) return
    this.listening = true
    screen.on('display-added', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    screen.on('display-metrics-changed', this.onDisplaysChanged)
  }

  private readonly onDisplaysChanged = (): void => {
    if (this.disposed) return
    this.signature = ''
    if (!this.visible) return
    this.ensureWindows()
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.showInactive()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.visible = false
    this.tracker.dispose()
    this.stopMoodClock()
    this.mood.dispose()
    if (this.listening) {
      screen.removeListener('display-added', this.onDisplaysChanged)
      screen.removeListener('display-removed', this.onDisplaysChanged)
      screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
      this.listening = false
    }
    this.disposeWindows()
  }

  private disposeWindows(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.windows.clear()
    this.signature = ''
  }
}

function asPoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null
  const point = value as { x?: unknown; y?: unknown }
  const x = Number(point.x)
  const y = Number(point.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/** Tool results use different keys for coordinate actions and element actions. */
function pointFromData(
  data: Record<string, unknown> | undefined
): { point: { x: number; y: number }; dip: boolean } | null {
  if (!data) return null
  const dip = asPoint(data.cursor_dip)
  if (dip) return { point: dip, dip: true }
  const physical =
    asPoint(data.screen) ??
    asPoint(data.cursor) ??
    asPoint(data.to) ??
    asPoint(data.from) ??
    asPoint(data.actual) ??
    asPoint(data)
  return physical ? { point: physical, dip: false } : null
}
