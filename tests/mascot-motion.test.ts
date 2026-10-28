import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { overlayHtml } from '../src/main/computer-overlay-html'

/**
 * "O mascote não está animado": the baseline moods used to move 1-2 px on a ~100 px mascot, which looks frozen.
 * This measures how far the head and the ears really travel in a real browser, so a too-timid animation fails.
 */
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
  page = await browser.newPage({ viewport: { width: 700, height: 400 } })
  await page.setContent(overlayHtml(true))
  await page.evaluate('window.resumeAgentFace()')
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

/** Largest change in position or size of an element's box over `ms`, in CSS px. */
async function travel(selector: string, ms: number): Promise<number> {
  return page.evaluate(
    async ({ selector, ms }) => {
      const doc = (globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null } }).document
      const raf = (globalThis as unknown as { requestAnimationFrame(cb: () => void): number }).requestAnimationFrame
      const clock = (globalThis as unknown as { performance: { now(): number } }).performance
      let lo: number[] | null = null
      let hi: number[] | null = null
      const start = clock.now()
      while (clock.now() - start < ms) {
        const box = doc.querySelector(selector)?.getBoundingClientRect()
        if (box) {
          const v = [box.x, box.y, box.width, box.height]
          lo = lo ? lo.map((n, i) => Math.min(n, v[i])) : v
          hi = hi ? hi.map((n, i) => Math.max(n, v[i])) : v
        }
        await new Promise<void>((resolve) => raf(() => resolve()))
      }
      return lo && hi ? Math.max(...hi.map((n, i) => n - lo![i])) : 0
    },
    { selector, ms }
  )
}

async function setMood(mood: string): Promise<void> {
  await page.evaluate(`window.setAgentMood({ mood: ${JSON.stringify(mood)}, difficulty: 0, label: ${JSON.stringify(mood)} })`)
  await page.waitForTimeout(300)
}

describe('mascot motion is big enough to see', () => {
  it.each([
    ['calm', 3800, 7],
    ['working', 2600, 12],
    ['thinking', 3400, 12],
    ['curious', 2800, 12]
  ])('%s: the head travels at least %i ms / %i px', async (mood, ms, minPx) => {
    if (!browser) return
    await setMood(mood)
    const head = await travel('.head', ms)
    expect(head, `${mood}: cabeça`).toBeGreaterThanOrEqual(minPx)
    // the ears move too, not only the head
    expect(await travel('.ear-l', 1500), `${mood}: orelha`).toBeGreaterThanOrEqual(3)
  }, 30_000)

  it('stands perfectly still while paused (hidden overlay costs nothing)', async () => {
    if (!browser) return
    await setMood('working')
    await page.evaluate('window.pauseAgentFace()')
    await page.waitForTimeout(300)
    expect(await travel('.head', 1200)).toBeLessThan(0.5)
    await page.evaluate('window.resumeAgentFace()')
  }, 30_000)
})
