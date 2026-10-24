import { BrowserWindow, clipboard, globalShortcut, screen } from 'electron'
import { execFile } from 'node:child_process'
import type { AppSettings } from '../shared/types.js'
import { CH, type DictationState } from '../shared/api.js'

/**
 * Wispr-Flow-style dictation: a global shortcut starts/stops the microphone,
 * a floating pill shows what is being heard, and the final text is inserted
 * into the field the user was typing in.
 *
 * The microphone and Whisper live in the renderer (getUserMedia + the STT
 * bridge); this controller only owns the shortcut, the overlay and insertion.
 */

export interface DictationDeps {
  getSettings(): AppSettings
  sendToRenderer(channel: string, payload: unknown): void
  isOpenclodFocused(): boolean
  polish(text: string): Promise<string>
  log(scope: string, message: unknown): void
}

const OVERLAY_WIDTH = 440
const OVERLAY_HEIGHT = 104
const OVERLAY_HIDE_DELAY_MS = 1200

export class DictationController {
  private readonly deps: DictationDeps
  private overlay: BrowserWindow | null = null
  private shortcut: string | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private lastState: DictationState = { phase: 'idle' }

  constructor(deps: DictationDeps) {
    this.deps = deps
  }

  /** (Re)registers the global shortcut. Safe to call on every settings save. */
  register(shortcut = 'Control+Alt+Space'): void {
    const next = shortcut.trim()
    if (this.shortcut === next) return
    if (this.shortcut) {
      try {
        globalShortcut.unregister(this.shortcut)
      } catch {
        /* already gone */
      }
      this.shortcut = null
    }
    if (!next) return
    try {
      const ok = globalShortcut.register(next, () => this.toggle())
      if (!ok) throw new Error(`o atalho ${next} já está em uso por outro aplicativo`)
      this.shortcut = next
      this.deps.log('dictation', `atalho global registrado: ${next}`)
    } catch (err) {
      this.deps.log('dictation', `não foi possível registrar ${next}: ${(err as Error).message}`)
    }
  }

  currentShortcut(): string | null {
    return this.shortcut
  }

  /** Called by the global shortcut (and by tests/userscripts). */
  toggle(): void {
    this.deps.sendToRenderer(CH.dictationToggle, {})
  }

  /** State comes from the renderer's dictation engine, about 10 times a second. */
  update(state: DictationState): void {
    this.lastState = state
    const overlay = this.showOverlay()
    if (!overlay) return
    const payload = JSON.stringify({
      phase: state.phase,
      level: clamp01(state.level ?? 0),
      text: (state.text ?? '').slice(0, 240),
      error: (state.error ?? '').slice(0, 240)
    })
    overlay.webContents.executeJavaScript(`window.openclodOverlay && window.openclodOverlay(${payload})`).catch(() => undefined)

    if (state.phase === 'idle' || state.phase === 'error') {
      if (this.hideTimer) clearTimeout(this.hideTimer)
      this.hideTimer = setTimeout(() => this.hideOverlay(), state.phase === 'error' ? 3500 : OVERLAY_HIDE_DELAY_MS)
    } else if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }

  /**
   * Inserts the final text. If Openclod is focused (or the user chose "composer"),
   * the renderer puts it at the caret; otherwise it is pasted into the window
   * that had focus, using the clipboard so Unicode survives.
   */
  async insert(raw: string): Promise<boolean> {
    const text = raw.trim()
    if (!text) return false
    const target = this.deps.getSettings().voice?.insert ?? 'focused'

    if (target === 'composer' || this.deps.isOpenclodFocused()) {
      this.deps.sendToRenderer(CH.dictationComposer, { text })
      return true
    }

    return this.pasteToForeground(text)
  }

  /** Optional cleanup pass. A provider failure never loses the dictated text. */
  async polish(text: string): Promise<string> {
    if (!this.deps.getSettings().voice?.polish) return text
    try {
      const polished = await this.deps.polish(text)
      return polished.trim() || text
    } catch (err) {
      this.deps.log('dictation', `polish falhou: ${(err as Error).message}`)
      return text
    }
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    if (this.shortcut) {
      try {
        globalShortcut.unregister(this.shortcut)
      } catch {
        /* already gone */
      }
      this.shortcut = null
    }
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy()
    this.overlay = null
  }

  private async pasteToForeground(text: string): Promise<boolean> {
    const previous = await clipboard.readText()
    await clipboard.writeText(text)
    try {
      await runPowerShell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')")
      // Keep the dictated text on the clipboard briefly, then restore what was there.
      setTimeout(() => {
        void (async () => {
          try {
            if ((await clipboard.readText()) === text) await clipboard.writeText(previous)
          } catch {
            /* clipboard unavailable */
          }
        })()
      }, 1500)
      return true
    } catch (err) {
      this.deps.log('dictation', `não foi possível colar no aplicativo em foco: ${(err as Error).message}`)
      return false
    }
  }

  private showOverlay(): BrowserWindow | null {
    try {
      if (this.overlay && !this.overlay.isDestroyed()) {
        if (!this.overlay.isVisible()) this.overlay.showInactive()
        return this.overlay
      }
      const display = screen.getPrimaryDisplay()
      const x = Math.round(display.workArea.x + (display.workArea.width - OVERLAY_WIDTH) / 2)
      const y = Math.round(display.workArea.y + display.workArea.height - OVERLAY_HEIGHT - 44)
      const overlay = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        x,
        y,
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
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })
      overlay.setAlwaysOnTop(true, 'screen-saver')
      overlay.setIgnoreMouseEvents(true, { forward: true })
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`)
      overlay.once('ready-to-show', () => overlay.showInactive())
      overlay.on('closed', () => {
        if (this.overlay === overlay) this.overlay = null
      })
      this.overlay = overlay
      overlay.showInactive()
      overlay.webContents.executeJavaScript(
        `window.openclodOverlay && window.openclodOverlay(${JSON.stringify(this.lastState)})`
      ).catch(() => undefined)
      return overlay
    } catch (err) {
      this.deps.log('dictation', `overlay indisponível: ${(err as Error).message}`)
      return null
    }
  }

  private hideOverlay(): void {
    this.hideTimer = null
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.hide()
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 8000 },
      (error) => (error ? reject(error) : resolve())
    )
  })
}

/** Self-contained pill; no bundled assets so it also works in a packaged asar. */
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  body { display: grid; place-items: center; font-family: "Segoe UI", system-ui, sans-serif; }
  .pill {
    width: 416px; min-height: 78px; display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-radius: 22px; box-sizing: border-box;
    background: rgba(24, 24, 27, 0.92); color: #f4f4f5;
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 18px 60px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06);
    backdrop-filter: blur(18px);
  }
  .dot { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto;
    background: radial-gradient(circle at 35% 30%, #fb923c, #ea580c); box-shadow: 0 0 0 6px rgba(234,88,12,0.14); }
  .dot svg { width: 18px; height: 18px; fill: #fff; }
  .body { min-width: 0; flex: 1; }
  .status { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #a1a1aa; margin-bottom: 5px; }
  .text { font-size: 13.5px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f4f4f5; }
  .text.empty { color: #71717a; }
  .bars { display: flex; align-items: center; gap: 3px; height: 26px; flex: 0 0 auto; }
  .bars i { width: 3px; height: 4px; border-radius: 2px; background: #fb923c; opacity: .55; transition: height .08s linear, opacity .1s; }
  body.phase-listening .bars i { opacity: .95; }
  body.phase-loading .dot { animation: pulse 1.1s ease-in-out infinite; }
  body.phase-processing .dot { animation: pulse .8s ease-in-out infinite; }
  body.phase-error .dot { background: #ef4444; box-shadow: 0 0 0 6px rgba(239,68,68,.15); }
  body.phase-error .text { color: #fca5a5; }
  @keyframes pulse { 50% { transform: scale(.86); opacity: .7; } }
</style>
</head>
<body class="phase-idle">
  <div class="pill">
    <div class="dot"><svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg></div>
    <div class="body">
      <div class="status" id="status">Pronto</div>
      <div class="text empty" id="text">Segure o atalho e fale…</div>
    </div>
    <div class="bars" id="bars"></div>
  </div>
  <script>
    const bars = document.getElementById('bars')
    const levels = []
    for (let i = 0; i < 7; i++) { const b = document.createElement('i'); bars.appendChild(b); levels.push(b) }
    const status = document.getElementById('status')
    const text = document.getElementById('text')
    const labels = { idle: 'Pronto', loading: 'Carregando modelo', listening: 'Ouvindo', processing: 'Inserindo', error: 'Erro' }
    window.openclodOverlay = function (state) {
      const phase = state && state.phase ? state.phase : 'idle'
      document.body.className = 'phase-' + phase
      status.textContent = labels[phase] || 'Pronto'
      const value = (state && state.text) || (phase === 'listening' ? 'Fale normalmente…' : phase === 'error' ? (state.error || 'Falha no microfone') : 'Segure o atalho e fale…')
      text.textContent = value
      text.classList.toggle('empty', !state || !state.text)
      const level = state && typeof state.level === 'number' ? state.level : 0
      levels.forEach((bar, i) => {
        const wave = Math.sin((i + 1) * 1.7 + Date.now() / 180) * 0.5 + 0.5
        const h = phase === 'listening' ? 4 + Math.round((level * 0.75 + wave * 0.25) * 20) : 4
        bar.style.height = h + 'px'
      })
    }
  </script>
</body>
</html>`
