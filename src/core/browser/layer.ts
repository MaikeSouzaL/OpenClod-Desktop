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
  private page: Page | null = null
  private consoleLog: ConsoleEntry[] = []
  private networkErrors: string[] = []
  private headed = false
  lastError: string | null = null

  get isOpen(): boolean {
    return Boolean(this.page && !this.page.isClosed())
  }

  async status(): Promise<BrowserStatus> {
    try {
      // Resolving the module is enough to know the dependency is installed.
      await this.load()
      return {
        available: true,
        detail: this.isOpen ? `navegador aberto: ${this.page?.url() ?? ''}` : 'Playwright disponível',
        engine: this.browser ? 'chromium' : undefined
      }
    } catch (err) {
      return { available: false, detail: (err as Error).message }
    }
  }

  private async load(): Promise<PlaywrightModule> {
    if (!this.pw) this.pw = await import('playwright')
    return this.pw
  }

  async open(url: string, headed = false): Promise<void> {
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
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage()
      this.page.setDefaultTimeout(15_000)
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('nenhuma página aberta; use browser_open primeiro')
    return this.page
  }

  async navigate(url: string): Promise<void> {
    await this.requirePage().goto(url, { waitUntil: 'domcontentloaded' })
  }

  async snapshot(maxChars = 18_000): Promise<SnapshotResult> {
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
    await this.requirePage().keyboard.press(key)
  }

  async readText(selector?: string): Promise<string> {
    const page = this.requirePage()
    const text = selector
      ? await page.locator(selector).first().innerText()
      : await page.locator('body').innerText()
    return text.slice(0, 25_000)
  }

  async screenshot(): Promise<{ base64: string; width: number; height: number }> {
    const page = this.requirePage()
    const buffer = await page.screenshot({ type: 'png', fullPage: false })
    const size = page.viewportSize() ?? { width: 1440, height: 900 }
    return { base64: buffer.toString('base64'), width: size.width, height: size.height }
  }

  async waitFor(selector: string, timeoutMs = 15_000): Promise<void> {
    await this.requirePage().locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
  }

  consoleEntries(): ConsoleEntry[] {
    return [...this.consoleLog]
  }

  errors(): string[] {
    return [...this.networkErrors]
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
    this.page = null
    this.context = null
    this.browser = null
    this.consoleLog = []
    this.networkErrors = []
  }
}
