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
  /** Approximate page point in DIP, so the desktop cursor shows where the agent is reading. */
  cursor?: BrowserCursor
}

/** A screen point in DIP (Electron/Chrome window coordinates). */
export interface BrowserCursor {
  x: number
  y: number
}

export interface BrowserClickResult {
  url: string
  cursor?: BrowserCursor
  /** How many elements matched the target equally well (the first one was clicked). */
  matches?: number
  /** The click opened another tab/window, which is now the active one. */
  openedTab?: string
}

/**
 * What a capture of the page should look like. The automatic view after each action asks for a JPEG no wider
 * than `maxWidth` (a full HD PNG is megabytes and thousands of tokens); `browser_screenshot` keeps the PNG.
 */
export interface ScreenshotOptions {
  format?: 'png' | 'jpeg'
  /** JPEG quality, 30-95. */
  quality?: number
  /** Scale the capture down to this width in pixels (0 = as captured). */
  maxWidth?: number
}

export interface ScreenshotRequest extends ScreenshotOptions {
  sessionId: string
  groupName: string
}

export interface ScreenshotResult {
  base64: string
  width: number
  height: number
  /** image/png unless a JPEG was asked for (older extension builds only answered PNG). */
  mediaType?: 'image/png' | 'image/jpeg' | 'image/webp'
  url?: string
  title?: string
  cursor?: BrowserCursor
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
  click(input: { sessionId: string; groupName: string; target: { selector?: string; role?: string; name?: string; text?: string } }): Promise<BrowserClickResult>
  type(input: { sessionId: string; groupName: string; target: { selector?: string; role?: string; name?: string; text?: string }; value: string; submit: boolean }): Promise<{ cursor?: BrowserCursor }>
  press(input: { sessionId: string; groupName: string; key: string }): Promise<void>
  readText(input: { sessionId: string; groupName: string; selector?: string; html?: boolean; maxChars?: number }): Promise<string>
  screenshot(input: ScreenshotRequest): Promise<ScreenshotResult>
  waitFor(input: { sessionId: string; groupName: string; selector: string; timeoutMs: number }): Promise<void>
  tabsList(input: { sessionId: string; groupName: string }): Promise<Array<{ id: string; title: string; url: string; active: boolean }>>
  newTab(input: { url?: string; sessionId: string; groupName: string }): Promise<string>
  /** Adds a user-opened tab to this session's group without creating one. */
  claimTab?(input: {
    tabId?: string
    url?: string
    /** Adopt the tab in focus in the last focused Chrome window. */
    active?: boolean
    /** Adopt the only tab whose URL contains this fragment. */
    urlContains?: string
    sessionId: string
    groupName: string
  }): Promise<string>
  switchTab(input: { id: string; sessionId: string; groupName: string }): Promise<void>
  closeTab(input: { id?: string; sessionId: string; groupName: string }): Promise<void>
  consoleEntries(sessionId: string): ConsoleEntry[]
  errors(sessionId: string): string[]
  /** Fetches what the page logged since the last call; the sync readers above then return it. */
  refreshConsole?(input: { sessionId: string; groupName: string }): Promise<void>
  network?(input: { sessionId: string; groupName: string; clear?: boolean }): Promise<NetworkCapture>
  cookiesGet?(input: { sessionId: string; groupName: string; name?: string }): Promise<CookieList>
  cookiesSet?(input: { sessionId: string; groupName: string; cookie: CookieInput }): Promise<{ ok: boolean; name: string; domain?: string }>
  cookiesRemove?(input: { sessionId: string; groupName: string; name: string; url?: string }): Promise<{ ok: boolean; name: string }>
}

/** A page request the agent can inspect (method, URL, status, timing and the capped request/response bodies). */
export interface NetworkRequest {
  method: string
  url: string
  status: number
  type?: string
  ms?: number
  reqBody?: string
  resBody?: string
  fromCache?: boolean
  error?: string
  ts?: number
}

export interface NetworkCapture {
  installed: boolean
  /** fetch/XHR captured in the page, with request/response bodies. */
  requests: NetworkRequest[]
  /** Every request of the tab (navigation, resources) from the extension's webRequest log — metadata, no bodies. */
  all?: NetworkRequest[]
}

export interface BrowserCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
  session?: boolean
  expires?: number | null
}

export interface CookieList {
  url: string
  count: number
  cookies: BrowserCookie[]
}

export interface CookieInput {
  name: string
  value?: string
  url?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
  expires?: number
}

export interface BrowserLayerOptions {
  sessionId?: string
  chrome?: ChromeBrowserBackend
  mode?: 'auto' | 'chrome-existing' | 'playwright'
  /**
   * In "chrome-existing" mode, open an isolated Chromium of our own when the extension is not connected
   * instead of failing every browser tool. Default true; the model is told it is not the user's Chrome.
   */
  fallbackToManaged?: boolean
  groupBySession?: boolean
}

/**
 * The cleaned HTML for `browser_read html=true` in the isolated Chromium; the same rules as `openclodReadHtml` in
 * the Chrome extension (resources/chrome-extension/background.js): no scripts, styles, SVG drawings, comments or
 * event handlers, long attributes cut, and never the value of a password or hidden field.
 */
const READ_HTML_JS = `function (selector, maxChars) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return '(nenhum elemento casa com ' + selector + ')'
  const clone = root.cloneNode(true)
  const live = root.querySelectorAll('input, textarea, select')
  clone.querySelectorAll('input, textarea, select').forEach((field, index) => {
    const source = live[index]
    const type = (field.getAttribute('type') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') { field.removeAttribute('value'); return }
    if (source && 'value' in source && source.value) field.setAttribute('value', String(source.value).slice(0, 200))
    if (source && (source.type === 'checkbox' || source.type === 'radio') && source.checked) field.setAttribute('checked', '')
  })
  for (const node of clone.querySelectorAll('script, style, noscript, template, link, meta')) node.remove()
  for (const svg of clone.querySelectorAll('svg')) svg.replaceChildren()
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT)
  const comments = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  for (const comment of comments) comment.remove()
  for (const el of clone.querySelectorAll('*')) {
    for (const attribute of [...el.attributes]) {
      const name = attribute.name
      if (name === 'style' || name.startsWith('on') || (name.startsWith('data-') && !/^data-(test|testid|qa|cy|target|action)/.test(name))) el.removeAttribute(name)
      else if (attribute.value.length > 160) el.setAttribute(name, attribute.value.slice(0, 160) + '…')
    }
  }
  const html = clone.outerHTML.replace(/\\n\\s*\\n+/g, '\\n').replace(/[ \\t]{2,}/g, ' ')
  const limit = Number(maxChars) || 30000
  return html.length > limit ? html.slice(0, limit) + '\\n…[HTML truncado: use selector para ler só uma parte]' : html
}`

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
  /** Recent requests captured in the isolated-Chromium path (the Chrome extension keeps its own in the page). */
  private networkLog: NetworkRequest[] = []
  private headed = false
  private chromeHasTabs = false
  private readonly sessionId: string
  private readonly chrome?: ChromeBrowserBackend
  private readonly mode: 'auto' | 'chrome-existing' | 'playwright'
  private readonly groupBySession: boolean
  private readonly fallbackToManaged: boolean
  private usingFallback = false
  lastError: string | null = null

  constructor(options: BrowserLayerOptions = {}) {
    this.sessionId = options.sessionId ?? 'session'
    this.chrome = options.chrome
    this.mode = options.mode ?? 'playwright'
    this.groupBySession = options.groupBySession !== false
    this.fallbackToManaged = options.fallbackToManaged !== false
  }

  /**
   * Set while "chrome-existing" is configured but the extension is not connected and an isolated Chromium
   * is being used instead. Tools put it in front of the model so it knows there are no logins/tabs of the user.
   */
  get fallbackNote(): string | null {
    return this.usingFallback
      ? 'Aviso: a extensão do Chrome não está conectada; este é um Chromium próprio e isolado do Openclod (sem os logins nem as abas do usuário). Para usar o Chrome dele, conecte a extensão em Configurações → Navegador.'
      : null
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
      if (this.fallbackToManaged) {
        this.usingFallback = true
        return null
      }
      throw new Error(
        'Chrome existente não conectado. Instale a extensão do Openclod e abra a ponte em Configurações → Navegador ' +
          '(ou ative "abrir um Chromium isolado quando a extensão não estiver conectada").'
      )
    }
    if (chrome) this.usingFallback = false
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
      if (this.mode === 'chrome-existing' && !this.fallbackToManaged) {
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
      // Tabs the page itself opens (target=_blank, window.open, OAuth popups) become tracked tabs and the active one.
      this.context.on('page', (opened) => {
        if (this.creatingPage || [...this.tabs.values()].includes(opened)) return
        this.registerPage(opened)
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
        const req = res.request()
        this.networkLog.push({ method: req.method(), url: res.url(), status: res.status(), type: req.resourceType(), ts: Date.now() })
        if (this.networkLog.length > 200) this.networkLog.shift()
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

  private creatingPage = false

  private async createPage(): Promise<Page> {
    if (!this.context) throw new Error('contexto do navegador indisponível')
    this.creatingPage = true
    try {
      return this.registerPage(await this.context.newPage())
    } finally {
      this.creatingPage = false
    }
  }

  private registerPage(page: Page): Page {
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
  async claimTab(
    input: { tabId?: string; url?: string; active?: boolean; urlContains?: string } = {}
  ): Promise<string> {
    const chrome = this.requireChromeIfRequested()
    if (!chrome?.claimTab) throw new Error('vincular aba existente exige o Chrome conectado')
    if (!input.tabId?.trim() && !input.url?.trim() && !input.active && !input.urlContains?.trim()) {
      throw new Error('informe tab_id, url, url_contains ou active=true para escolher a aba')
    }
    const id = await chrome.claimTab({
      ...(input.tabId?.trim() ? { tabId: input.tabId.trim() } : {}),
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      ...(input.urlContains?.trim() ? { urlContains: input.urlContains.trim() } : {}),
      ...(input.active ? { active: true } : {}),
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

  async click(target: { selector?: string; role?: string; name?: string; text?: string }): Promise<BrowserClickResult> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.click({ sessionId: this.sessionId, groupName: this.groupName, target })
    }
    const page = this.requirePage()
    const locator = this.locate(target)
    const matches = await locator.count().catch(() => 1)
    const before = this.activeTab
    await locator.first().click({ timeout: 15_000 })
    // A click may navigate (a link or a form submit): wait for the new page to settle, the same parity the
    // extension path has, so the snapshot after the click reads the resulting page and not the old one.
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
    await page.waitForTimeout(250)
    // A link with target=_blank or window.open() creates a tab: follow it, as a person would.
    const opened = this.activeTab !== before ? this.activeTab : undefined
    const now = this.activePage() ?? page
    return { url: now.url(), matches, ...(opened ? { openedTab: opened } : {}) }
  }

  async type(
    target: { selector?: string; role?: string; name?: string; text?: string },
    value: string,
    submit = false
  ): Promise<{ cursor?: BrowserCursor }> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.type({ sessionId: this.sessionId, groupName: this.groupName, target, value, submit })
    }
    const page = this.requirePage()
    const locator = this.locate(target)
    await locator.first().click({ timeout: 15_000 })
    await locator.first().fill(value, { timeout: 15_000 })
    if (submit) {
      await page.keyboard.press('Enter')
      // Enter in a form submits and navigates: wait for the new page like the click path.
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(400)
    }
    return {}
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

  /** Visible text, or with `html` the cleaned HTML (tags, ids, classes, ARIA and form attributes). */
  async readText(selector?: string, options: { html?: boolean; maxChars?: number } = {}): Promise<string> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      return chrome.readText({
        sessionId: this.sessionId,
        groupName: this.groupName,
        ...(selector ? { selector } : {}),
        ...(options.html ? { html: true } : {}),
        ...(options.maxChars ? { maxChars: options.maxChars } : {})
      })
    }
    const page = this.requirePage()
    if (options.html) {
      return page.evaluate(`(${READ_HTML_JS})(${JSON.stringify(selector ?? '')}, ${Number(options.maxChars) || 30_000})`) as Promise<string>
    }
    const text = selector
      ? await page.locator(selector).first().innerText()
      : await page.locator('body').innerText()
    return text.slice(0, options.maxChars ?? 25_000)
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const chrome = this.requireChromeIfRequested()
    if (chrome) {
      this.chromeHasTabs = true
      const shot = await chrome.screenshot({ sessionId: this.sessionId, groupName: this.groupName, ...options })
      return { ...shot, mediaType: shot.mediaType ?? 'image/png' }
    }
    const page = this.requirePage()
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
    const jpeg = options.format === 'jpeg'
    const size = page.viewportSize() ?? { width: 1440, height: 900 }
    // The isolated Chromium's viewport is already 1440 px wide: one image pixel per CSS pixel is small enough,
    // so `maxWidth` only matters for the user's Chrome (a 4K screen).
    const buffer = await page.screenshot({
      type: jpeg ? 'jpeg' : 'png',
      ...(jpeg ? { quality: Math.max(30, Math.min(95, options.quality ?? 70)) } : {}),
      scale: 'css',
      fullPage: false
    })
    return {
      base64: buffer.toString('base64'),
      width: size.width,
      height: size.height,
      mediaType: jpeg ? 'image/jpeg' : 'image/png',
      url: page.url(),
      title: await page.title().catch(() => '')
    }
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

  /** With the user's Chrome the page's console is read on demand through the extension. */
  async collectConsole(): Promise<void> {
    const chrome = this.chromeBackend()
    if (!chrome?.refreshConsole) return
    await chrome.refreshConsole({ sessionId: this.sessionId, groupName: this.groupName }).catch(() => undefined)
  }

  consoleEntries(): ConsoleEntry[] {
    return this.chromeBackend()?.consoleEntries(this.sessionId) ?? [...this.consoleLog]
  }

  errors(): string[] {
    return this.chromeBackend()?.errors(this.sessionId) ?? [...this.networkErrors]
  }

  /** Recent requests of the page (method, URL, status, timing and, in the user's Chrome, the bodies). */
  async network(clear = false): Promise<NetworkCapture> {
    const chrome = this.chromeBackend()
    if (chrome?.network) return chrome.network({ sessionId: this.sessionId, groupName: this.groupName, clear })
    const requests = [...this.networkLog]
    if (clear) this.networkLog = []
    return { installed: Boolean(this.context), requests }
  }

  async cookiesGet(name?: string): Promise<CookieList> {
    const chrome = this.chromeBackend()
    if (chrome?.cookiesGet) return chrome.cookiesGet({ sessionId: this.sessionId, groupName: this.groupName, ...(name ? { name } : {}) })
    const page = this.requirePage()
    const url = page.url()
    const cookies = await this.context!.cookies(url)
    const list = (name ? cookies.filter((cookie) => cookie.name === name) : cookies).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: String(cookie.sameSite),
      session: cookie.expires === -1,
      expires: cookie.expires === -1 ? null : Math.round(cookie.expires)
    }))
    return { url, count: list.length, cookies: list }
  }

  async cookiesSet(cookie: CookieInput): Promise<{ ok: boolean; name: string; domain?: string }> {
    const chrome = this.chromeBackend()
    if (chrome?.cookiesSet) return chrome.cookiesSet({ sessionId: this.sessionId, groupName: this.groupName, cookie })
    const page = this.requirePage()
    const url = cookie.url || page.url()
    await this.context!.addCookies([
      {
        name: cookie.name,
        value: cookie.value ?? '',
        url,
        ...(cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.path ? { path: cookie.path } : {}),
        ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
        ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
        ...(cookie.sameSite ? { sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None' } : {}),
        ...(cookie.expires ? { expires: cookie.expires } : {})
      }
    ])
    return { ok: true, name: cookie.name, domain: cookie.domain }
  }

  async cookiesRemove(name: string, url?: string): Promise<{ ok: boolean; name: string }> {
    const chrome = this.chromeBackend()
    if (chrome?.cookiesRemove) return chrome.cookiesRemove({ sessionId: this.sessionId, groupName: this.groupName, name, ...(url ? { url } : {}) })
    const page = this.requirePage()
    const target = url || page.url()
    // Playwright has no single-cookie delete: keep every cookie of the context except this one for this URL.
    const host = (() => {
      try {
        return new URL(target).hostname
      } catch {
        return ''
      }
    })()
    const all = await this.context!.cookies()
    await this.context!.clearCookies()
    await this.context!.addCookies(
      all
        .filter((cookie) => !(cookie.name === name && (!host || cookie.domain.replace(/^\./, '') === host || host.endsWith(cookie.domain.replace(/^\./, '')))))
        .map((cookie) => ({ ...cookie, sameSite: cookie.sameSite }))
    )
    return { ok: true, name }
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
