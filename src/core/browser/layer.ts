import type { BrowserStatus } from '../../shared/types.js'

export interface ConsoleEntry {
  type: string
  text: string
  ts: number
}

export interface SnapshotResult {
  url: string
  title: string
  tree: string
}

/** Implemented by the Chrome native-messaging bridge in the main process. */
export interface ChromeBrowserBackend {
  readonly mode: 'auto' | 'chrome-existing' | 'playwright'
  isAttached(): boolean
  status(): Promise<BrowserStatus>
  isOpen(sessionId: string): Promise<boolean>
  open(input: { url: string; sessionId: string; groupName: string; newTab: boolean }): Promise<void>
  navigate(input: { url: string; sessionId: string; groupName: string }): Promise<void>
  snapshot(input: { sessionId: string; groupName: string; maxChars: number }): Promise<SnapshotResult>
  click(input: { sessionId: string; groupName: string; target: { selector?: string; role?: string; name?: string; text?: string } }): Promise<string>
  type(input: { sessionId: string; groupName: string; target: { selector?: string; role?: string; name?: string; text?: string }; value: string; submit: boolean }): Promise<void>
  press(input: { sessionId: string; groupName: string; key: string }): Promise<void>
  readText(input: { sessionId: string; groupName: string; selector?: string }): Promise<string>
  screenshot(input: { sessionId: string; groupName: string }): Promise<{ base64: string; width: number; height: number }>
  waitFor(input: { sessionId: string; groupName: string; selector: string; timeoutMs: number }): Promise<void>
  tabsList(input: { sessionId: string; groupName: string }): Promise<Array<{ id: string; title: string; url: string; active: boolean }>>
  newTab(input: { url?: string; sessionId: string; groupName: string }): Promise<string>
  /** Adds a user-opened tab to this session's group without creating one. */
  claimTab?(input: { tabId?: string; url?: string; sessionId: string; groupName: string }): Promise<string>
  switchTab(input: { id: string; sessionId: string; groupName: string }): Promise<void>
  closeTab(input: { id?: string; sessionId: string; groupName: string }): Promise<void>
  consoleEntries(sessionId: string): ConsoleEntry[]
  errors(sessionId: string): string[]
}

export interface BrowserLayerOptions {
  sessionId?: string
  chrome?: ChromeBrowserBackend
  mode?: 'auto' | 'chrome-existing' | 'playwright'
  groupBySession?: boolean
}

type PlaywrightModule = typeof import('playwright')
type Browser = import('playwright').Browser
type BrowserContext = import('playwright').BrowserContext
type Page = import('playwright').Page

/**
 * Thin wrapper around Playwright that keeps one browser/context/page per
 * session. It prefers an installed Chrome/Edge channel so that no 300 MB
 * browser download is required.
 */
export class BrowserLayer {
  private pw: PlaywrightModule | null = null
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  /** Every open tab, keyed by a stable id (`tab_1`, `tab_2`, ...). */
  private tabs = new Map<string, Page>()
  private activeTab = ''
  private tabSeq = 0
  private consoleLog: ConsoleEntry[] = []
  private networkErrors: string[] = []
  private headed = false
  private chromeHasTabs = false
  private readonly sessionId: string
  private readonly chrome?: ChromeBrowserBackend
  private readonly mode: 'auto' | 'chrome-existing' | 'playwright'
  private readonly groupBySession: boolean
  lastError: string | null = null

  constructor(options: BrowserLayerOptions = {}) {
    this.sessionId = options.sessionId ?? 'session'
    this.chrome = options.chrome
    this.mode = options.mode ?? 'playwright'
    this.groupBySession = options.groupBySession !== false
  }

  private get groupName(): string {
    return this.groupBySession ? `Openclod · ${this.sessionId.slice(0, 8)}` : 'Openclod'
  }

  private chromeBackend(): ChromeBrowserBackend | null {
    if (this.mode === 'playwright' || !this.chrome?.isAttached()) return null
    return this.chrome
  }

  private requireChromeIfRequested(): ChromeBrowserBackend | null {
    const chrome = this.chromeBackend()
    if (!chrome && this.mode === 'chrome-existing') {
      throw new Error('Chrome existente não conectado. Instale a extensão do Openclod e abra a ponte em Configurações → Navegador.')
    }
    return chrome
  }

  private activePage(): Page | null {
    const page = this.tabs.get(this.activeTab)
    return page && !page.isClosed() ? page : null
  }

  get isOpen(): boolean {
    return this.chromeHasTabs || Boolean(this.activePage())
  }

  async status(): Promise<BrowserStatus> {
    try {
      if (this.chrome?.isAttached()) {
        this.chromeHasTabs = await this.chrome.isOpen(this.sessionId)
        return await this.chrome.status()
      }
      if (this.mode === 'chrome-existing') {
        return {
          available: false,
          mode: this.mode,
          attached: false,
          detail: 'Chrome existente não conectado. Instale a extensão do Openclod.'
        }
      }
      // Resolving the module is enough to know the dependency is installed.
      await this.load()
      const page = this.activePage()
      return {
        available: true,
        detail: page
          ? `navegador aberto: ${page.url()} (${this.tabs.size} aba${this.tabs.size === 1 ? '' : 's'})`
          : 'Playwright disponível',
        engine: this.browser ? 'chromium' : undefined,
        mode: this.mode,
        attached: false
      }
    } catch (err) {
      return { available: false, detail: (err as Error).message }
    }
  }

  private async load(): Promise<PlaywrightModule> {
    if (!this.pw) this.pw = await import('playwright')
    return this.pw
  }

  /** Ensures the browser and a page exist; `newTab` forces a fresh tab. */
  async open(url: string, headed = false, newTab = false): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      await chrome.open({ url, sessionId: this.sessionId, groupName: this.groupName, newTab })
      this.chromeHasTabs = true
      return
    }
    const pw = await this.load()
    if (this.browser && this.headed !== headed) await this.close()
    if (!this.browser) {
      const attempts: Array<() => Promise<Browser>> = [
        () => pw.chromium.launch({ channel: 'chrome', headless: !headed }),
        () => pw.chromium.launch({ channel: 'msedge', headless: !headed }),
        () => pw.chromium.launch({ headless: !headed })
      ]
      let lastErr: unknown
      for (const attempt of attempts) {
        try {
          this.browser = await attempt()
          break
        } catch (err) {
          lastErr = err
        }
      }
      if (!this.browser) {
        throw new Error(
          `não foi possível iniciar o Chromium. Instale o Chrome/Edge ou execute "npx playwright install chromium". Detalhe: ${(lastErr as Error)?.message ?? 'desconhecido'}`
        )
      }
      this.headed = headed
      this.context = await this.browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'pt-BR',
        ignoreHTTPSErrors: false
      })
      this.context.on('console', (msg) => {
        this.consoleLog.push({ type: msg.type(), text: msg.text(), ts: Date.now() })
        if (this.consoleLog.length > 300) this.consoleLog.shift()
      })
      this.context.on('weberror', (err) => {
        this.networkErrors.push(`pageerror: ${err.error().message}`)
      })
      this.context.on('response', (res) => {
        if (res.status() >= 400) this.networkErrors.push(`HTTP ${res.status()} ${res.url()}`)
      })
      this.context.on('requestfailed', (req) => {
        this.networkErrors.push(`FALHA ${req.url()} · ${req.failure()?.errorText ?? ''}`)
      })
    }
    if (!this.context) throw new Error('contexto do navegador indisponível')
    const current = this.activePage()
    if (!newTab && current) {
      await current.goto(url, { waitUntil: 'domcontentloaded' })
      return
    }
    const page = await this.createPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  private async createPage(): Promise<Page> {
    if (!this.context) throw new Error('contexto do navegador indisponível')
    const page = await this.context.newPage()
    const id = `tab_${++this.tabSeq}`
    this.tabs.set(id, page)
    this.activeTab = id
    page.setDefaultTimeout(15_000)
    page.on('close', () => {
      this.tabs.delete(id)
      if (this.activeTab === id) this.activeTab = [...this.tabs.keys()][0] ?? ''
    })
    return page
  }

  /** Opens a new tab (empty when url is omitted) and makes it active. */
  async newTab(url?: string): Promise<string> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      const id = await chrome.newTab({ url, sessionId: this.sessionId, groupName: this.groupName })
      this.chromeHasTabs = true
      return id
    }
    await this.load()
    if (!this.context) {
      // Reuse open() to perform the full browser bootstrap, then add a tab.
      await this.open(url ?? 'about:blank')
      return this.activeTab
    }
    const page = await this.createPage()
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' })
    return this.activeTab
  }

  /** Uses an existing Chrome tab for this session and groups it, without a second browser. */
  async claimTab(input: { tabId?: string; url?: string } = {}): Promise<string> {
    const chrome = this.requireChromeIfRequested()
    if (!chrome?.claimTab) throw new Error('vincular aba existente exige o Chrome conectado')
    if (!input.tabId?.trim() && !input.url?.trim()) throw new Error('informe tab_id ou url da aba existente')
    const id = await chrome.claimTab({
      ...(input.tabId?.trim() ? { tabId: input.tabId.trim() } : {}),
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      sessionId: this.sessionId,
      groupName: this.groupName
    })
    this.chromeHasTabs = true
    return id
  }

  async tabsList(): Promise<Array<{ id: string; title: string; url: string; active: boolean }>> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      const tabs = await chrome.tabsList({ sessionId: this.sessionId, groupName: this.groupName })
      this.chromeHasTabs = tabs.length > 0
      return tabs
    }
    const entries = [...this.tabs.entries()]
    return Promise.all(
      entries.map(async ([id, page]) => ({
        id,
        title: page.isClosed() ? '(fechada)' : await page.title().catch(() => ''),
        url: page.isClosed() ? '' : page.url(),
        active: id === this.activeTab
      }))
    )
  }

  async switchTab(id: string): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      await chrome.switchTab({ id, sessionId: this.sessionId, groupName: this.groupName })
      this.chromeHasTabs = true
      return
    }
    const page = this.tabs.get(id)
    if (!page || page.isClosed()) throw new Error(`aba não encontrada: ${id}`)
    this.activeTab = id
    await page.bringToFront().catch(() => undefined)
  }

  async closeTab(id?: string): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      await chrome.closeTab({ id, sessionId: this.sessionId, groupName: this.groupName })
      this.chromeHasTabs = (await chrome.tabsList({ sessionId: this.sessionId, groupName: this.groupName })).length > 0
      return
    }
    const target = id ?? this.activeTab
    const page = this.tabs.get(target)
    if (!page) throw new Error(`aba não encontrada: ${target}`)
    await page.close().catch(() => undefined)
    this.tabs.delete(target)
    if (this.activeTab === target) this.activeTab = [...this.tabs.keys()][0] ?? ''
  }

  private requirePage(): Page {
    const page = this.activePage()
    if (!page) throw new Error('nenhuma página aberta; use browser_open primeiro')
    return page
  }

  async navigate(url: string): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      await chrome.navigate({ url, sessionId: this.sessionId, groupName: this.groupName })
      this.chromeHasTabs = true
      return
    }
    await this.requirePage().goto(url, { waitUntil: 'domcontentloaded' })
  }

  async snapshot(maxChars = 18_000): Promise<SnapshotResult> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.snapshot({ sessionId: this.sessionId, groupName: this.groupName, maxChars })
    }
    const page = this.requirePage()
    let tree = ''
    try {
      tree = await page.locator('body').ariaSnapshot({ timeout: 8000 })
    } catch {
      tree = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')
    }
    if (tree.length > maxChars) tree = `${tree.slice(0, maxChars)}\n…[snapshot truncado]`
    return { url: page.url(), title: await page.title(), tree }
  }

  async click(target: { selector?: string; role?: string; name?: string; text?: string }): Promise<string> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.click({ sessionId: this.sessionId, groupName: this.groupName, target })
    }
    const page = this.requirePage()
    const locator = this.locate(target)
    await locator.first().click({ timeout: 15_000 })
    await page.waitForTimeout(250)
    return page.url()
  }

  async type(
    target: { selector?: string; role?: string; name?: string; text?: string },
    value: string,
    submit = false
  ): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      await chrome.type({ sessionId: this.sessionId, groupName: this.groupName, target, value, submit })
      return
    }
    const page = this.requirePage()
    const locator = this.locate(target)
    await locator.first().click({ timeout: 15_000 })
    await locator.first().fill(value, { timeout: 15_000 })
    if (submit) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
    }
  }

  async press(key: string): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      await chrome.press({ sessionId: this.sessionId, groupName: this.groupName, key })
      return
    }
    await this.requirePage().keyboard.press(key)
  }

  async readText(selector?: string): Promise<string> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.readText({ sessionId: this.sessionId, groupName: this.groupName, selector })
    }
    const page = this.requirePage()
    const text = selector
      ? await page.locator(selector).first().innerText()
      : await page.locator('body').innerText()
    return text.slice(0, 25_000)
  }

  async screenshot(): Promise<{ base64: string; width: number; height: number }> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.screenshot({ sessionId: this.sessionId, groupName: this.groupName })
    }
    const page = this.requirePage()
    const buffer = await page.screenshot({ type: 'png', fullPage: false })
    const size = page.viewportSize() ?? { width: 1440, height: 900 }
    return { base64: buffer.toString('base64'), width: size.width, height: size.height }
  }

  async waitFor(selector: string, timeoutMs = 15_000): Promise<void> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      await chrome.waitFor({ sessionId: this.sessionId, groupName: this.groupName, selector, timeoutMs })
      return
    }
    await this.requirePage().locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
  }

  consoleEntries(): ConsoleEntry[] {
    return this.chromeBackend()?.consoleEntries(this.sessionId) ?? [...this.consoleLog]
  }

  errors(): string[] {
    return this.chromeBackend()?.errors(this.sessionId) ?? [...this.networkErrors]
  }

  /** Elements are located semantically first, falling back to CSS/text. */
  private locate(target: { selector?: string; role?: string; name?: string; text?: string }) {
    const page = this.requirePage()
    if (target.selector) return page.locator(target.selector)
    if (target.role) {
      const role = target.role as Parameters<Page['getByRole']>[0]
      return page.getByRole(role, target.name ? { name: target.name, exact: false } : undefined)
    }
    if (target.text) return page.getByText(target.text, { exact: false })
    if (target.name) return page.getByText(target.name, { exact: false })
    throw new Error('informe selector, role+name ou text para localizar o elemento')
  }

  async close(): Promise<void> {
    // The native bridge controls tabs in the user's own Chrome. Closing an
    // Openclod session leaves those tabs visible for review.
    this.chromeHasTabs = false
    try {
      await this.context?.close()
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close()
    } catch {
      /* ignore */
    }
    this.tabs.clear()
    this.activeTab = ''
    this.context = null
    this.browser = null
    this.consoleLog = []
    this.networkErrors = []
  }
}
