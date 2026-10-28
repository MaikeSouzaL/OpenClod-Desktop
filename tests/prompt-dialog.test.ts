import fs from 'node:fs'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** The renderer's promptText() (replacement for the window.prompt() Electron lacks) exercised in a real browser. */
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'prompt.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'PromptLib',
  write: false
}).outputFiles[0].text

let browser: Browser | null = null
let page: Page

beforeAll(async () => {
  for (const options of [{ channel: 'chrome' as const }, { channel: 'msedge' as const }, {}]) {
    try {
      browser = await chromium.launch({ headless: true, ...options })
      break
    } catch {
      browser = null
    }
  }
  if (!browser) return
  page = await browser.newPage()
  await page.setContent('<button id="before">antes</button>')
  await page.addScriptTag({ content: bundle })
  // The real stylesheet (the overlay is position: fixed, so "click outside" needs it).
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')
  await page.addStyleTag({ content: `:root{--bg:#fff;--border:#ccc;--elevated:#fff;--text:#111;--text-2:#555;--shadow:none}${css.slice(css.indexOf('/* In-app replacement for window.prompt()'))}` })
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

const open = (options: Record<string, unknown>) => page.evaluate((o) => {
  const lib = (globalThis as unknown as { PromptLib: { promptText: (o: unknown) => Promise<string | null> } }).PromptLib
  ;(globalThis as unknown as { pending: Promise<string | null> }).pending = lib.promptText(o)
}, options)
const result = () => page.evaluate(() => (globalThis as unknown as { pending: Promise<string | null> }).pending)

describe('promptText', () => {
  it('shows an accessible dialog with the field focused and resolves with what was typed (Enter)', async (ctx) => {
    if (!browser) return ctx.skip()
    await page.focus('#before')
    await open({ title: 'Conectar Stripe', label: 'Informe STRIPE_KEY', initial: 'abc' })
    expect(await page.locator('[role=dialog]').getAttribute('aria-label')).toBe('Conectar Stripe')
    expect(await page.evaluate(() => (globalThis as unknown as { document: { activeElement?: { className?: string } } }).document.activeElement?.className)).toBe('prompt-input')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('valor-novo')
    await page.keyboard.press('Enter')
    expect(await result()).toBe('valor-novo')
    expect(await page.locator('.prompt-overlay').count()).toBe(0)
    expect(await page.evaluate(() => (globalThis as unknown as { document: { activeElement?: { id?: string } } }).document.activeElement?.id)).toBe('before')
  })

  it('resolves null on Escape, on Cancel and on a click outside', async (ctx) => {
    if (!browser) return ctx.skip()
    await open({ title: 'A' })
    await page.keyboard.press('Escape')
    expect(await result()).toBeNull()
    await open({ title: 'B' })
    await page.getByRole('button', { name: 'Cancelar' }).click()
    expect(await result()).toBeNull()
    await open({ title: 'C' })
    await page.mouse.click(5, 5)
    expect(await result()).toBeNull()
  })

  it('hides secrets while typing and returns an empty string when confirmed empty', async (ctx) => {
    if (!browser) return ctx.skip()
    await open({ title: 'Token', secret: true, confirmLabel: 'Conectar' })
    expect(await page.locator('.prompt-input').getAttribute('type')).toBe('password')
    await page.getByRole('button', { name: 'Conectar' }).click()
    expect(await result()).toBe('')
  })
})
