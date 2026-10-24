import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserLayer } from '../src/core/browser/layer'

/**
 * Fake Playwright with just enough surface for BrowserLayer. Keeping the double
 * in the test (instead of launching Chromium) makes the tab bookkeeping fast and
 * deterministic; real browsing is covered by the E2E scripts.
 */
const fake = vi.hoisted(() => {
  const state = {
    launches: [] as Array<{ channel?: string }>,
    pages: [] as FakePage[],
    contextClosed: false,
    browserClosed: false
  }

  class FakePage {
    private currentUrl = 'about:blank'
    private closed = false
    private readonly closeHandlers: Array<() => void> = []

    isClosed(): boolean {
      return this.closed
    }

    url(): string {
      return this.currentUrl
    }

    async title(): Promise<string> {
      return `título ${this.currentUrl}`
    }

    async goto(url: string): Promise<void> {
      this.currentUrl = url
    }

    setDefaultTimeout(): void {
      /* no-op */
    }

    on(event: string, handler: () => void): void {
      if (event === 'close') this.closeHandlers.push(handler)
    }

    async close(): Promise<void> {
      this.closed = true
      for (const handler of this.closeHandlers) handler()
    }

    async bringToFront(): Promise<void> {
      /* no-op */
    }

    locator(): Record<string, unknown> {
      const api = {
        first: () => api,
        ariaSnapshot: async () => {
          throw new Error('sem snapshot no dublê')
        },
        innerText: async () => `texto de ${this.currentUrl}`
      }
      return api
    }
  }

  const context = {
    newPage: async () => {
      const page = new FakePage()
      state.pages.push(page)
      return page
    },
    on: () => undefined,
    close: async () => {
      state.contextClosed = true
      for (const page of state.pages) await page.close()
    }
  }

  const browser = {
    newContext: async () => context,
    close: async () => {
      state.browserClosed = true
    }
  }

  return {
    state,
    FakePage,
    launch: async (options: { channel?: string } = {}) => {
      state.launches.push(options)
      return browser
    }
  }
})

vi.mock('playwright', () => ({
  chromium: { launch: fake.launch }
}))

describe('BrowserLayer tabs', () => {
  beforeEach(() => {
    fake.state.launches = []
    fake.state.pages = []
    fake.state.contextClosed = false
    fake.state.browserClosed = false
    vi.clearAllMocks()
  })

  it('opens the first page as tab_1 and gives every new tab its own page', async () => {
    const layer = new BrowserLayer()

    expect(await layer.newTab('https://example.test/a')).toBe('tab_1')
    expect(await layer.newTab('https://example.test/b')).toBe('tab_2')

    const tabs = await layer.tabsList()
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toMatchObject({
      id: 'tab_1',
      url: 'https://example.test/a',
      active: false
    })
    expect(tabs[1]).toMatchObject({
      id: 'tab_2',
      url: 'https://example.test/b',
      active: true
    })
    expect(fake.state.pages).toHaveLength(2)
    // Prefers an installed Chrome channel before falling back to bundled chromium.
    expect(fake.state.launches[0]).toMatchObject({ channel: 'chrome' })
  })

  it('switches the active tab, navigates it and closes a specific tab', async () => {
    const layer = new BrowserLayer()
    await layer.newTab('https://example.test/a')
    await layer.newTab('https://example.test/b')

    await layer.switchTab('tab_1')
    expect((await layer.tabsList()).find((tab) => tab.active)?.id).toBe('tab_1')
    await layer.navigate('https://example.test/c')
    expect(await layer.snapshot()).toMatchObject({ url: 'https://example.test/c' })

    await layer.closeTab('tab_2')
    const tabs = await layer.tabsList()
    expect(tabs.map((tab) => tab.id)).toEqual(['tab_1'])
    expect(tabs[0].active).toBe(true)
  })

  it('reuses the active tab for open() unless new_tab is requested', async () => {
    const layer = new BrowserLayer()
    await layer.open('https://example.test/a')
    await layer.open('https://example.test/b')
    expect(await layer.tabsList()).toHaveLength(1)

    await layer.open('https://example.test/c', false, true)
    const tabs = await layer.tabsList()
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({ url: 'https://example.test/c', active: true })
  })

  it('activates another tab when the current one is closed by the page itself', async () => {
    const layer = new BrowserLayer()
    await layer.newTab('https://example.test/a')
    await layer.newTab('https://example.test/b')

    await fake.state.pages[1].close()
    const tabs = await layer.tabsList()
    expect(tabs.map((tab) => tab.id)).toEqual(['tab_1'])
    expect(tabs[0].active).toBe(true)
    expect(layer.isOpen).toBe(true)
  })

  it('closes the last tab cleanly and refuses to navigate without a page', async () => {
    const layer = new BrowserLayer()
    await layer.newTab('https://example.test/a')

    await layer.closeTab()
    expect(await layer.tabsList()).toEqual([])
    expect(layer.isOpen).toBe(false)
    await expect(layer.navigate('https://example.test/b')).rejects.toThrow(/nenhuma página/i)
  })

  it('reports the number of open tabs in the status detail', async () => {
    const layer = new BrowserLayer()
    await layer.newTab('https://example.test/a')
    await layer.newTab('https://example.test/b')

    const status = await layer.status()
    expect(status.available).toBe(true)
    expect(status.detail).toContain('2 abas')
    expect(status.engine).toBe('chromium')
  })
})
