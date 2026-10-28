import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserLayer } from '../src/core/browser/layer'

/** Runs the Playwright path of the browser tools against a throwaway local site (skipped when no Chromium/Chrome/Edge exists). */
let server: http.Server
let base = ''
let layer: BrowserLayer
let available = true

beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/popup') {
      response.end('<title>Segunda aba</title><h1>Você está na segunda aba</h1>')
      return
    }
    response.end(`<title>Início</title>
      <a href="/popup" target="_blank">Abrir em nova aba</a>
      <button>Salvar</button><button>Salvar</button>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  layer = new BrowserLayer({ sessionId: 'ses_live_browser', mode: 'playwright' })
  try {
    await layer.open(`${base}/`)
  } catch {
    available = false
  }
}, 90_000)

afterAll(async () => {
  await layer?.close().catch(() => undefined)
  server?.close()
})

describe('browser tools (Playwright path)', () => {
  it('follows a link that opens a new tab and says so', async (ctx) => {
    if (!available) return ctx.skip()
    const clicked = await layer.click({ role: 'link', name: 'Abrir em nova aba' })
    expect(clicked.openedTab).toBeTruthy()
    expect(clicked.url).toBe(`${base}/popup`)
    const snapshot = await layer.snapshot(2000)
    expect(snapshot.tree).toContain('Você está na segunda aba')
    const tabs = await layer.tabsList()
    expect(tabs.length).toBe(2)
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1)
  }, 30_000)

  it('tells the model when several elements match instead of silently picking the first', async (ctx) => {
    if (!available) return ctx.skip()
    await layer.navigate(`${base}/`)
    const clicked = await layer.click({ role: 'button', name: 'Salvar' })
    expect(clicked.matches).toBe(2)
  }, 30_000)
})
