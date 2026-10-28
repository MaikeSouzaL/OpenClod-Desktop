import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright'

// ChromeBridge.start() runs taskkill on every native host; never do that to the user's real connection.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = vi.fn((_command: string, _args: unknown, _options: unknown, callback?: (error: null, stdout: string, stderr: string) => void) => {
    callback?.(null, '', '')
    return { on: vi.fn() }
  })
  return { ...actual, execFile }
})

import { ChromeBridge } from '../src/main/chrome/bridge'

/**
 * The real extension, loaded into a real Chrome, talking through the real native host to a ChromeBridge of this
 * test (its own port, token and bridge.json; OPENCLOD_CHROME_BRIDGE_CONFIG keeps the host away from the user's
 * running app). It needs Chrome and the native host registered by "Instalar integração"; otherwise the suite
 * skips instead of failing.
 */
const EXTENSION = path.join(__dirname, '..', 'resources', 'chrome-extension')
const EXTENSION_ID = 'iflajofnlenfolhiemmfbonmiinnookf'
const SESSION = 'ses_integration'
const GROUP = 'Openclod · ses_integ'

const PAGE = `<!doctype html><html><head><title>Página de teste</title></head><body>
<h1>Painel de teste</h1><button id="go" onclick="window.clicked=(window.clicked||0)+1">Confirmar</button>
<p>texto de exemplo</p></body></html>`

function hostIsRegistered(): boolean {
  try {
    const manifest = path.join(process.env.APPDATA || '', 'Openclod Desktop', 'NativeMessagingHosts', 'com.openclod.desktop.json')
    const config = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { path?: string }
    return Boolean(config.path && fs.existsSync(config.path))
  } catch {
    return false
  }
}

async function until<T>(check: () => Promise<T | false | undefined> | T | false | undefined, timeoutMs: number, what: string): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`tempo esgotado esperando: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

let ready = false
let work = ''
let context: BrowserContext | null = null
let worker: Worker
let bridge: ChromeBridge
const stopped: string[] = []

beforeAll(async () => {
  if (process.platform !== 'win32' || !hostIsRegistered()) return
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-ext-it-'))
  bridge = new ChromeBridge(path.join(work, 'app'))
  bridge.appVersion = '0.0.0-test'
  bridge.onStop((sessionId) => stopped.push(sessionId))
  await bridge.start()
  const config = path.join(work, 'app', 'chrome-bridge', 'bridge.json')
  for (const options of [{ channel: 'chrome' as const }, { channel: 'msedge' as const }]) {
    try {
      context = await chromium.launchPersistentContext(path.join(work, 'chrome'), {
        ...options,
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        // Branded Chrome no longer honours --load-extension; the supported route is CDP Extensions.loadUnpacked.
        args: ['--enable-unsafe-extension-debugging'],
        env: { ...process.env, OPENCLOD_CHROME_BRIDGE_CONFIG: config } as Record<string, string>
      })
      break
    } catch {
      context = null
    }
  }
  if (!context) return
  await context.route('https://example.test/**', (route) => {
    const url = route.request().url()
    if (url.endsWith('/missing')) return route.fulfill({ status: 404, body: 'nada' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
  })
  const browser = context.browser()
  if (!browser) return
  const waiting = context.waitForEvent('serviceworker', { timeout: 20_000 })
  const session = await browser.newBrowserCDPSession()
  await session.send('Extensions.loadUnpacked' as never, { path: EXTENSION } as never)
  worker = context.serviceWorkers()[0] ?? (await waiting)
  ready = true
}, 90_000)

afterAll(async () => {
  await context?.close().catch(() => undefined)
  await bridge?.stop()
  if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}, 60_000)

describe('Openclod Chrome extension in a real browser', () => {
  it('loads with the id the native host allows and reaches the app through the native host', async (ctx) => {
    if (!ready) return ctx.skip()
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID)
    await until(() => bridge.isAttached(), 20_000, 'extensão conectada à ponte')
    expect(bridge.version).toBe(JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8')).version)
    // The ack travels app → host → extension on the next poll.
    await until(() => worker.evaluate('appAlive()'), 20_000, 'hello_ack recebido pela extensão')
  }, 60_000)

  it('shows the connection in the popup and the badge', async (ctx) => {
    if (!ready) return ctx.skip()
    const popup = await context!.newPage()
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`)
    await until(async () => (await popup.locator('#status-title').textContent()) === 'Conectado ao Openclod', 10_000, 'popup mostra "Conectado"')
    expect(await popup.locator('#version').textContent()).toContain('v0.2')
    expect(await popup.locator('#stop').isDisabled()).toBe(true)
    expect(await popup.locator('#tabs-empty').isVisible()).toBe(true)
    const badge = await worker.evaluate('chrome.action.getBadgeText({})')
    expect(badge).toBe('')
    await popup.close()
  }, 30_000)

  it('opens a grouped tab for the session and marks it with the Openclod indicator', async (ctx) => {
    if (!ready) return ctx.skip()
    await bridge.open({ url: 'https://example.test/', sessionId: SESSION, groupName: GROUP, newTab: false })
    const page = await until(() => context!.pages().find((candidate) => candidate.url().startsWith('https://example.test/')), 15_000, 'aba aberta')
    await page.waitForLoadState('load')
    const groups = await worker.evaluate(`chrome.tabGroups.query({ title: ${JSON.stringify(GROUP)} })`)
    expect(groups).toHaveLength(1)
    await until(() => page.evaluate("Boolean(document.getElementById('openclod-agent-indicator'))"), 10_000, 'indicador na página')
    // Closed shadow root: the page cannot read the UI, and the agent's own snapshots never include it.
    const snapshot = await bridge.snapshot({ sessionId: SESSION, groupName: GROUP, maxChars: 6000 })
    expect(snapshot.tree).toContain('Confirmar')
    expect(snapshot.tree).not.toMatch(/controlando|Parar/)
    expect(await worker.evaluate('chrome.action.getBadgeText({})')).toBe('1')
  }, 60_000)

  it('reports the page console and failed requests to browser_console', async (ctx) => {
    if (!ready) return ctx.skip()
    const page = context!.pages().find((candidate) => candidate.url().startsWith('https://example.test/')) as Page
    await bridge.click({ sessionId: SESSION, groupName: GROUP, target: { role: 'button', name: 'Confirmar' } }) // re-installs the hook
    await page.evaluate(() => {
      console.error('falha-de-teste', { codigo: 7 })
      return fetch('/missing').catch(() => undefined)
    })
    await bridge.refreshConsole({ sessionId: SESSION, groupName: GROUP })
    expect(bridge.consoleEntries(SESSION).some((entry) => entry.type === 'error' && entry.text.includes('falha-de-teste') && entry.text.includes('7'))).toBe(true)
    expect(bridge.errors(SESSION).some((line) => line.startsWith('404 GET') && line.endsWith('/missing'))).toBe(true)
    expect(await page.evaluate('window.clicked')).toBe(1)
  }, 60_000)

  it('keeps the indicator out of screenshots', async (ctx) => {
    if (!ready) return ctx.skip()
    const shot = await bridge.screenshot({ sessionId: SESSION, groupName: GROUP })
    expect(shot.base64.length).toBeGreaterThan(1000)
    const page = context!.pages().find((candidate) => candidate.url().startsWith('https://example.test/')) as Page
    // concealed only for the capture, back afterwards
    expect(await page.evaluate("document.getElementById('openclod-agent-indicator')?.style.visibility")).toBe('visible')
  }, 60_000)

  it('stops the agent from the Stop button in the page, and refuses the next command', async (ctx) => {
    if (!ready) return ctx.skip()
    const page = context!.pages().find((candidate) => candidate.url().startsWith('https://example.test/')) as Page
    await page.bringToFront()
    const size = page.viewportSize() ?? ((await page.evaluate('({ width: innerWidth, height: innerHeight })')) as { width: number; height: number })
    const y = size.height - 36
    // The pill sits bottom-centre; find the button by sweeping the right half of it.
    for (let x = Math.round(size.width / 2); x < size.width / 2 + 260 && stopped.length === 0; x += 8) {
      await page.mouse.click(x, y)
    }
    await until(() => stopped.length > 0, 10_000, 'pedido de parada chegou ao app')
    expect(stopped).toContain(SESSION)
    await until(() => page.evaluate("!document.getElementById('openclod-agent-indicator')"), 5_000, 'indicador removido')
    await expect(bridge.click({ sessionId: SESSION, groupName: GROUP, target: { role: 'button', name: 'Confirmar' } })).rejects.toThrow(/Parar/)
    expect(await page.evaluate('window.clicked')).toBe(1) // the refused click never ran
  }, 60_000)
})
