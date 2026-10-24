import { app, BrowserWindow, screen, type Display } from 'electron'
import { ComputerActivityTracker } from '../core/computer/activity.js'
import type { HarnessEvent } from '../shared/types.js'
import { overlayHtml } from './computer-overlay-html.js'

/** How long the indicator stays after the last computer call of a turn. */
const LINGER_MS = 2500

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
  private signature = ''
  private listening = false
  private disposed = false
  private visible = false

  /** Enable with FORJA_OVERLAY_CAPTURE=1 to record demos/screenshots of the overlay. */
  private readonly protectFromCapture = process.env.FORJA_OVERLAY_CAPTURE !== '1'

  handle(event: HarnessEvent): void {
    if (this.disposed) return
    this.tracker.handle(event)
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
      if (win.isDestroyed()) continue
      win.showInactive()
    }
  }

  private hide(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.hide()
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
