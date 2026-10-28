import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { BrowserStatus } from '../../shared/types.js'
import type {
  BrowserClickResult,
  BrowserCursor,
  ChromeBrowserBackend,
  ConsoleEntry,
  CookieInput,
  CookieList,
  NetworkCapture,
  ScreenshotRequest,
  ScreenshotResult,
  SnapshotResult
} from '../../core/browser/layer.js'
import { compareVersions } from './package.js'

interface ChromeMessage {
  id?: string
  type: string
  [key: string]: unknown
}

interface PendingCommand {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface ChromeConfig {
  version: 1
  port: number
  token: string
}

/**
 * Local native-messaging bridge for the user's existing Chrome.
 *
 * The Chrome extension talks to a small Go native host over stdio. That host
 * exchanges messages with this loopback-only HTTP server. No page data or
 * browser control socket is exposed outside 127.0.0.1, and every request needs
 * a token generated per user profile.
 */
export class ChromeBridge implements ChromeBrowserBackend {
  readonly mode: 'auto' | 'chrome-existing' | 'playwright' = 'auto'
  private server: http.Server | null = null
  private readonly token = crypto.randomBytes(32).toString('hex')
  private readonly commands: ChromeMessage[] = []
  private readonly pending = new Map<string, PendingCommand>()
  private readonly lastSeen = new Map<string, number>()
  private lastConnectedAt = 0
  private browserName = ''
  private extensionVersion = ''
  private port = 0
  private starting: Promise<void> | null = null
  /** Console/network errors the extension last reported per session (the tool reads them synchronously). */
  private readonly consoleCache = new Map<string, { entries: ConsoleEntry[]; errors: string[] }>()
  private stopListener: ((sessionId: string) => void) | null = null
  /** Version of this app, sent back in hello_ack so the popup can tell the user both sides are up to date. */
  appVersion = ''
  /** Version of the extension this app bundles; a Chrome running an older one is told to reload itself (once). */
  expectedExtensionVersion = ''
  private reloadRequestedFor = ''

  constructor(private readonly userData: string) {}

  isAttached(): boolean {
    return Boolean(this.lastConnectedAt && Date.now() - this.lastConnectedAt < 20_000)
  }

  get version(): string {
    return this.extensionVersion
  }

  /** Called when the user presses Stop in Chrome (page button, popup or keyboard shortcut). */
  onStop(listener: (sessionId: string) => void): void {
    this.stopListener = listener
  }

  async status(): Promise<BrowserStatus> {
    if (!this.server) {
      return {
        available: true,
        attached: false,
        mode: this.mode,
        detail: this.isAttached()
          ? 'Extensão do Chrome conectada ao navegador existente.'
          : 'Extensão do Chrome desconectada. Instale a integração em Configurações → Navegador.'
      }
    }
    return {
      available: true,
      attached: this.isAttached(),
      mode: this.mode,
      engine: 'Chrome (extensão)',
      browser: this.browserName || 'Google Chrome',
      extensionVersion: this.extensionVersion || undefined,
      detail: this.isAttached()
        ? `Chrome existente conectado · ponte 127.0.0.1:${this.port}`
        : 'Aguardando a extensão Openclod no Chrome existente.'
    }
  }

  async start(): Promise<void> {
    if (this.server) return
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<void> {
    this.server = http.createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        this.port = (server.address() as AddressInfo).port
        resolve()
      })
    })
    const dir = path.join(this.userData, 'chrome-bridge')
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    const config: ChromeConfig = { version: 1, port: this.port, token: this.token }
    const target = path.join(dir, 'bridge.json')
    const temp = `${target}.${process.pid}.tmp`
    // Atomic replace: the native host must never read a half-written file.
    await fs.promises.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(temp, target)
    // A host from a previous app run keeps the old port forever. Kill it so
    // Chrome reconnects and spawns a host that reads the new bridge.json.
    await this.killStaleHosts()
  }

  private async killStaleHosts(): Promise<void> {
    if (process.platform !== 'win32') return
    await new Promise<void>((resolve) => {
      execFile(
        'taskkill',
        ['/IM', 'openclod-chrome-host.exe', '/F'],
        { windowsHide: true },
        () => resolve()
      )
    })
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('ponte do Chrome encerrada'))
    }
    this.pending.clear()
    this.commands.length = 0
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = url.searchParams.get('path') || url.pathname.replace(/^\//, '')
    if (route !== 'health' && url.searchParams.get('token') !== this.token) {
      response.writeHead(403).end('forbidden')
      return
    }
    if (route === 'health') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    if (route === 'from-extension' && request.method === 'POST') {
      try {
        // A screenshot is the biggest message (a full HD PNG passes 2 MB once in base64).
        const raw = await readBody(request, 16_000_000)
        this.receive(JSON.parse(raw) as ChromeMessage)
        response.writeHead(204).end()
      } catch (err) {
        response.writeHead(400).end((err as Error).message)
      }
      return
    }
    if (route === 'to-extension' && request.method === 'GET') {
      const timeout = Math.min(30_000, Math.max(5_000, Number(url.searchParams.get('wait_ms')) || 20_000))
      const messages = await this.takeCommands(timeout)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(messages))
      return
    }
    response.writeHead(404).end('not found')
  }

  private receive(message: ChromeMessage): void {
    if (message.type === 'hello') {
      this.lastConnectedAt = Date.now()
      this.browserName = typeof message.browser === 'string' ? message.browser.slice(0, 80) : 'Google Chrome'
      this.extensionVersion = typeof message.version === 'string' ? message.version.slice(0, 24) : ''
      this.acknowledge()
      this.reloadIfOutdated()
      return
    }
    if (message.type === 'heartbeat') {
      this.lastConnectedAt = Date.now()
      this.acknowledge()
      return
    }
    if (message.type === 'stop') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId.slice(0, 120) : ''
      if (sessionId) {
        try {
          this.stopListener?.(sessionId)
        } catch {
          /* a failing listener must not break the bridge */
        }
      }
      return
    }
    if (message.type !== 'result' || !message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(String(message.error).slice(0, 1_000)))
    else pending.resolve(message.result)
  }

  /**
   * Lets the extension know the app is alive (it shows "connected" in its popup and badge). Only one is ever
   * queued: if the host is not polling, acknowledgements must not pile up.
   */
  private acknowledge(): void {
    const index = this.commands.findIndex((item) => item.type === 'hello_ack')
    if (index >= 0) this.commands.splice(index, 1)
    this.commands.push({ type: 'hello_ack', appVersion: this.appVersion })
  }

  /**
   * When Chrome is running an older extension than the app bundles, ask it to reload itself from disk once (the
   * stable copy is refreshed on app start). Older builds without the `reload` handler simply ignore it, so the
   * user reloads that one transition by hand; every update after that is automatic.
   */
  private reloadIfOutdated(): void {
    const expected = this.expectedExtensionVersion
    if (!expected || !this.extensionVersion) return
    if (compareVersions(this.extensionVersion, expected) >= 0) return
    if (this.reloadRequestedFor === this.extensionVersion) return
    this.reloadRequestedFor = this.extensionVersion
    this.commands.push({ id: crypto.randomUUID(), type: 'reload' })
  }

  private takeCommands(timeoutMs: number): Promise<ChromeMessage[]> {
    if (this.commands.length) return Promise.resolve(this.commands.splice(0))
    return new Promise((resolve) => {
      const started = Date.now()
      const poll = (): void => {
        if (this.commands.length) {
          resolve(this.commands.splice(0))
          return
        }
        if (Date.now() - started >= timeoutMs) {
          resolve([])
          return
        }
        setTimeout(poll, 150)
      }
      poll()
    })
  }

  private command<T>(type: string, payload: Record<string, unknown>, timeoutMs = 25_000): Promise<T> {
    if (!this.isAttached()) {
      return Promise.reject(new Error('a extensão Openclod não está conectada ao Chrome'))
    }
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`o Chrome não respondeu à ação ${type} em ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      // The command id goes last: a payload field called `id` (a tab id) must never replace it, or the answer
      // comes back under another id and the action "times out".
      this.commands.push({ ...payload, id, type })
    })
  }

  async isOpen(sessionId: string): Promise<boolean> {
    if (!this.isAttached()) return false
    return this.command<boolean>('tabs_open', { sessionId })
  }

  // Opening, navigating and clicking wait in Chrome until the new page has loaded (up to ~15 s).
  async open(input: { url: string; sessionId: string; groupName: string; newTab: boolean }): Promise<void> {
    await this.command('open', input, 35_000)
  }

  async navigate(input: { url: string; sessionId: string; groupName: string }): Promise<void> {
    await this.command('navigate', input, 35_000)
  }

  async snapshot(input: { sessionId: string; groupName: string; maxChars: number }): Promise<SnapshotResult> {
    return this.command<SnapshotResult>('snapshot', input)
  }

  async click(input: { sessionId: string; groupName: string; target: Record<string, unknown> }): Promise<BrowserClickResult> {
    // Older extension builds returned only the URL string.
    const result = await this.command<string | BrowserClickResult>('click', input, 35_000)
    return typeof result === 'string' ? { url: result } : result
  }

  async type(input: {
    sessionId: string
    groupName: string
    target: Record<string, unknown>
    value: string
    submit: boolean
  }): Promise<{ cursor?: BrowserCursor }> {
    const result = await this.command<{ cursor?: BrowserCursor } | undefined>('type', input, 35_000)
    return result ?? {}
  }

  async press(input: { sessionId: string; groupName: string; key: string }): Promise<void> {
    await this.command('press', input, 35_000)
  }

  async readText(input: { sessionId: string; groupName: string; selector?: string; html?: boolean; maxChars?: number }): Promise<string> {
    return this.command<string>('read_text', input)
  }

  async screenshot(input: ScreenshotRequest): Promise<ScreenshotResult> {
    const result = await this.command<ScreenshotResult>('screenshot', { ...input })
    // Builds before 0.2.1 answered only PNG without saying so.
    return { ...result, mediaType: result.mediaType ?? 'image/png' }
  }

  async waitFor(input: { sessionId: string; groupName: string; selector: string; timeoutMs: number }): Promise<void> {
    await this.command('wait_for', input, input.timeoutMs + 5_000)
  }

  async tabsList(input: { sessionId: string; groupName: string }): Promise<Array<{ id: string; title: string; url: string; active: boolean }>> {
    return this.command('tabs_list', input)
  }

  async newTab(input: { url?: string; sessionId: string; groupName: string }): Promise<string> {
    return this.command<string>('new_tab', input)
  }

  async claimTab(input: {
    tabId?: string
    url?: string
    active?: boolean
    urlContains?: string
    sessionId: string
    groupName: string
  }): Promise<string> {
    const tabId = await this.command<number>('claim_tab', input)
    return `chrome_${tabId}`
  }

  async switchTab(input: { id: string; sessionId: string; groupName: string }): Promise<void> {
    await this.command('switch_tab', { tab: input.id, sessionId: input.sessionId, groupName: input.groupName })
  }

  async closeTab(input: { id?: string; sessionId: string; groupName: string }): Promise<void> {
    await this.command('close_tab', { ...(input.id ? { tab: input.id } : {}), sessionId: input.sessionId, groupName: input.groupName })
  }

  /** Pulls (and clears) what the page logged since the agent took the tab. */
  async refreshConsole(input: { sessionId: string; groupName: string }): Promise<void> {
    const result = await this.command<{ installed?: boolean; entries?: ConsoleEntry[]; errors?: string[] } | undefined>('console', input)
    const previous = this.consoleCache.get(input.sessionId)
    const entries = [...(previous?.entries ?? []), ...(result?.entries ?? [])].slice(-200)
    const errors = [...(previous?.errors ?? []), ...(result?.errors ?? [])].slice(-200)
    this.consoleCache.set(input.sessionId, { entries, errors })
  }

  consoleEntries(sessionId: string): ConsoleEntry[] {
    return [...(this.consoleCache.get(sessionId)?.entries ?? [])]
  }

  errors(sessionId: string): string[] {
    return [...(this.consoleCache.get(sessionId)?.errors ?? [])]
  }

  async network(input: { sessionId: string; groupName: string; clear?: boolean }): Promise<NetworkCapture> {
    const result = await this.command<NetworkCapture | undefined>('network', input)
    return result ?? { installed: false, requests: [] }
  }

  async cookiesGet(input: { sessionId: string; groupName: string; name?: string }): Promise<CookieList> {
    return this.command<CookieList>('cookies_get', input)
  }

  async cookiesSet(input: { sessionId: string; groupName: string; cookie: CookieInput }): Promise<{ ok: boolean; name: string; domain?: string }> {
    return this.command('cookies_set', input)
  }

  async cookiesRemove(input: { sessionId: string; groupName: string; name: string; url?: string }): Promise<{ ok: boolean; name: string }> {
    return this.command('cookies_remove', input)
  }
}

function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('mensagem grande demais'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
