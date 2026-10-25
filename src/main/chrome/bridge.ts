import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { BrowserStatus } from '../../shared/types.js'
import type { ChromeBrowserBackend, ConsoleEntry, SnapshotResult } from '../../core/browser/layer.js'

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
  private port = 0
  private starting: Promise<void> | null = null

  constructor(private readonly userData: string) {}

  isAttached(): boolean {
    return Boolean(this.lastConnectedAt && Date.now() - this.lastConnectedAt < 20_000)
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
    await fs.promises.writeFile(path.join(dir, 'bridge.json'), `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
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
        const raw = await readBody(request, 2_000_000)
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
      return
    }
    if (message.type === 'heartbeat') {
      this.lastConnectedAt = Date.now()
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
      this.commands.push({ id, type, ...payload })
    })
  }

  async isOpen(sessionId: string): Promise<boolean> {
    if (!this.isAttached()) return false
    return this.command<boolean>('tabs_open', { sessionId })
  }

  async open(input: { url: string; sessionId: string; groupName: string; newTab: boolean }): Promise<void> {
    await this.command('open', input)
  }

  async navigate(input: { url: string; sessionId: string; groupName: string }): Promise<void> {
    await this.command('navigate', input)
  }

  async snapshot(input: { sessionId: string; groupName: string; maxChars: number }): Promise<SnapshotResult> {
    return this.command<SnapshotResult>('snapshot', input)
  }

  async click(input: { sessionId: string; groupName: string; target: Record<string, unknown> }): Promise<string> {
    return this.command<string>('click', input)
  }

  async type(input: { sessionId: string; groupName: string; target: Record<string, unknown>; value: string; submit: boolean }): Promise<void> {
    await this.command('type', input)
  }

  async press(input: { sessionId: string; groupName: string; key: string }): Promise<void> {
    await this.command('press', input)
  }

  async readText(input: { sessionId: string; groupName: string; selector?: string }): Promise<string> {
    return this.command<string>('read_text', input)
  }

  async screenshot(input: { sessionId: string; groupName: string }): Promise<{ base64: string; width: number; height: number }> {
    return this.command('screenshot', input)
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

  async claimTab(input: { tabId?: string; url?: string; sessionId: string; groupName: string }): Promise<string> {
    const tabId = await this.command<number>('claim_tab', input)
    return `chrome_${tabId}`
  }

  async switchTab(input: { id: string; sessionId: string; groupName: string }): Promise<void> {
    await this.command('switch_tab', input)
  }

  async closeTab(input: { id?: string; sessionId: string; groupName: string }): Promise<void> {
    await this.command('close_tab', input)
  }

  consoleEntries(_sessionId: string): ConsoleEntry[] {
    return []
  }

  errors(_sessionId: string): string[] {
    return []
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
