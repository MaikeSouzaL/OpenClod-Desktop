import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import sharp, { type OverlayOptions } from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MASCOT_MOODS, type MascotMood, type MascotState } from '../src/core/computer/mood'
import { MASCOT_EXTRAS, MASCOT_LOOKS, overlayHtml } from '../src/main/computer-overlay-html'

/**
 * The mascot drawn by a real browser: every mood must render without errors
 * and look different from the others. With MASCOT_SHEET=1 the captures and a
 * contact sheet are written to Prints/mascote-2026-10-27/ for human review.
 */
const SHEET = process.env.MASCOT_SHEET === '1'
const OUT = path.join(__dirname, '..', 'Prints', 'mascote-2026-10-27')
const BACKDROP = '#1b1612'
const VIEWPORT = { width: 480, height: 230 }
const CLIP = { x: 70, y: 0, width: 340, height: 196 }
const SCALE = 2

/** Labels the tracker really produces, so the pill is rendered with realistic text. */
const STATES: Record<MascotMood, MascotState> = {
  calm: { mood: 'calm', difficulty: 0, label: 'Openclod está usando o computador' },
  working: { mood: 'working', difficulty: 0, label: 'Openclod está usando o computador' },
  thinking: { mood: 'thinking', difficulty: 0, label: 'Pensando no próximo passo' },
  curious: { mood: 'curious', difficulty: 0, label: 'Openclod está usando o computador' },
  waiting: { mood: 'waiting', difficulty: 1, label: 'Esperando "computer_click" há 25 s' },
  sleepy: { mood: 'sleepy', difficulty: 1, label: 'Pensando há 1 min 10 s…' },
  confused: { mood: 'confused', difficulty: 1, label: 'Algo não saiu como esperado' },
  struggling: { mood: 'struggling', difficulty: 2, label: 'Tentando de novo: 2 falhas seguidas' },
  overwhelmed: { mood: 'overwhelmed', difficulty: 3, label: 'Está difícil: 4 falhas seguidas' },
  worried: { mood: 'worried', difficulty: 1, label: 'Contexto quase cheio: compactando' },
  asking: { mood: 'asking', difficulty: 0, label: 'Esperando sua resposta' },
  relieved: { mood: 'relieved', difficulty: 0, label: 'Resolvido!' },
  happy: { mood: 'happy', difficulty: 0, label: 'Consegui, mesmo com as dificuldades!' },
  sad: { mood: 'sad', difficulty: 2, label: 'Não consegui concluir' }
}

let browser: Browser | null = null
let still: BrowserContext
let moving: BrowserContext
let stillPage: Page
const errors: string[] = []
const shots = new Map<string, Buffer>()

async function newPage(context: BrowserContext, freezeAnimations: boolean): Promise<Page> {
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`console.${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  await page.setContent(overlayHtml(true))
  await page.addStyleTag({
    content: `html, body { background: ${BACKDROP} !important; }${freezeAnimations ? ' *, *::before, *::after { animation: none !important; transition: none !important; }' : ''}`
  })
  return page
}

/** The tests run under Node typings (no DOM), so page code goes in as strings. */
const ev = <T>(page: Page, expression: string): Promise<T> => page.evaluate(expression) as Promise<T>
const setMood = (page: Page, state: unknown) => page.evaluate(`window.setAgentMood(${JSON.stringify(state)})`)
const bodyData = (page: Page, key: 'mood' | 'difficulty') => ev<string>(page, `document.body.dataset.${key}`)
const snap = (page: Page) => page.screenshot({ clip: CLIP, type: 'png' })
const sha = (buf: Buffer) => createHash('sha1').update(buf).digest('hex')

async function pixels(buf: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Number of pixels that differ visibly (more than 24 in some channel). */
async function diffPixels(a: Buffer, b: Buffer): Promise<number> {
  const [pa, pb] = await Promise.all([pixels(a), pixels(b)])
  expect([pa.width, pa.height]).toEqual([pb.width, pb.height])
  let count = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(pa.data[i] - pb.data[i]),
      Math.abs(pa.data[i + 1] - pb.data[i + 1]),
      Math.abs(pa.data[i + 2] - pb.data[i + 2])
    )
    if (delta > 24) count++
  }
  return count
}

function save(name: string, buf: Buffer): void {
  if (!SHEET) return
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf)
}

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
  // Static poses: reduced motion shows the expression of each mood with every prop in place.
  still = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, reducedMotion: 'reduce' })
  // Real motion, to prove the mascot moves.
  moving = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
  stillPage = await newPage(still, false)
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

describe('mascot render (real browser)', () => {
  it('draws every one of the 14 moods without errors and exposes the mood in the page', async (ctx) => {
    if (!browser) return ctx.skip()
    for (const mood of MASCOT_MOODS) {
      const state = STATES[mood]
      await setMood(stillPage, state)
      await stillPage.waitForTimeout(40)
      expect(await bodyData(stillPage, 'mood')).toBe(mood)
      expect(await bodyData(stillPage, 'difficulty')).toBe(String(state.difficulty))
      expect((await stillPage.locator('.tag-text').textContent())?.trim()).toBe(state.label)
      expect(await stillPage.locator('.mascot-svg').getAttribute('data-eyes')).toBe(MASCOT_LOOKS[mood].eyes)
      expect(await stillPage.locator('.mascot-svg').getAttribute('data-mouth')).toBe(MASCOT_LOOKS[mood].mouth)
      const box = await stillPage.locator('.mascot-svg').boundingBox()
      expect(box && box.width).toBeGreaterThan(150)
      const shot = await snap(stillPage)
      shots.set(mood, shot)
      save(mood, shot)
    }
    expect(errors).toEqual([])
    expect(shots.size).toBe(14)
  }, 90_000)

  it('shows the props of each mood (and hides the others)', async (ctx) => {
    if (!browser) return ctx.skip()
    const visible = () =>
      ev<string[]>(
        stillPage,
        `${JSON.stringify(MASCOT_EXTRAS)}.filter((kind) => {
          const el = document.querySelector('.x-' + kind)
          return !!el && getComputedStyle(el).display !== 'none'
        })`
      )
    for (const mood of MASCOT_MOODS) {
      await setMood(stillPage, STATES[mood])
      const shown = (await visible()).filter((kind) => kind !== 'glitch')
      expect([...shown].sort()).toEqual([...MASCOT_LOOKS[mood].extras].filter((kind) => kind !== 'glitch').sort())
    }
  })

  it('draws visibly different faces for different moods', async (ctx) => {
    if (!browser) return ctx.skip()
    if (shots.size < 14) {
      for (const mood of MASCOT_MOODS) {
        await setMood(stillPage, STATES[mood])
        shots.set(mood, await snap(stillPage))
      }
    }
    // No two moods render the exact same image.
    const hashes = new Set([...shots.values()].map(sha))
    expect(hashes.size).toBe(14)
    // The headline pairs differ in a lot of pixels.
    const pairs: Array<[MascotMood, MascotMood]> = [
      ['calm', 'happy'], ['calm', 'sad'], ['calm', 'overwhelmed'], ['calm', 'sleepy'], ['happy', 'sad'],
      ['happy', 'overwhelmed'], ['sad', 'overwhelmed'], ['sleepy', 'overwhelmed'], ['sleepy', 'happy'], ['sleepy', 'sad']
    ]
    for (const [a, b] of pairs) {
      expect(await diffPixels(shots.get(a)!, shots.get(b)!), `${a} x ${b}`).toBeGreaterThan(1500)
    }
    // And every pair of moods is told apart by something, not just a hair.
    const moods = [...MASCOT_MOODS]
    for (let i = 0; i < moods.length; i++) {
      for (let j = i + 1; j < moods.length; j++) {
        expect(await diffPixels(shots.get(moods[i])!, shots.get(moods[j])!), `${moods[i]} x ${moods[j]}`).toBeGreaterThan(250)
      }
    }
  }, 90_000)

  it('ignores an unknown mood and keeps the last valid one', async (ctx) => {
    if (!browser) return ctx.skip()
    await setMood(stillPage, STATES.happy)
    await setMood(stillPage, { mood: 'nope' as MascotMood, difficulty: 1, label: 'x' })
    expect(await bodyData(stillPage, 'mood')).toBe('happy')
    expect(errors).toEqual([])
  })

  it('moves: struggling, happy and overwhelmed change from frame to frame', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await newPage(moving, false)
    for (const mood of ['struggling', 'happy', 'overwhelmed', 'working'] as const) {
      await setMood(page, STATES[mood])
      await page.evaluate('window.resumeAgentFace()')
      const frames: Buffer[] = []
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(mood === 'struggling' ? 61 : 230)
        frames.push(await snap(page))
        save(`anim-${mood}-${i + 1}`, frames[i])
      }
      expect(new Set(frames.map(sha)).size, `${mood}: frames`).toBeGreaterThanOrEqual(3)
      expect(await diffPixels(frames[0], frames[2]), `${mood}: pixels`).toBeGreaterThan(40)
    }
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('stays still while paused and respects reduced motion', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await newPage(moving, false) // paused until resumeAgentFace()
    await setMood(page, STATES.struggling)
    // Transitions (the frame fades in over 0.9 s) and the one-shot pop run even while paused: let them end.
    await page.waitForTimeout(700)
    await page.evaluate('Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => null)))')
    await page.waitForTimeout(300)
    const a = await snap(page)
    await page.waitForTimeout(250)
    const b = await snap(page)
    expect(sha(a)).toBe(sha(b))
    await page.close()

    const calm = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, reducedMotion: 'reduce' })
    const reduced = await newPage(calm, false)
    await setMood(reduced, STATES.overwhelmed)
    await reduced.evaluate('window.resumeAgentFace()')
    const c = await snap(reduced)
    await reduced.waitForTimeout(250)
    const d = await snap(reduced)
    expect(sha(c)).toBe(sha(d))
    expect(await bodyData(reduced, 'mood')).toBe('overwhelmed')
    await calm.close()
  }, 30_000)

  it('happy bursts into star eyes and then settles into ^ ^', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await newPage(moving, true)
    await setMood(page, STATES.happy)
    expect(await page.locator('.mascot-svg').getAttribute('data-eyes')).toBe('star')
    const burst = await snap(page)
    save('happy-estrela', burst)
    shots.set('happy-estrela', burst)
    await page.waitForTimeout(1250)
    expect(await page.locator('.mascot-svg').getAttribute('data-eyes')).toBe('happy')
    const settled = await snap(page)
    save('happy-olhos-felizes', settled)
    shots.set('happy-olhos-felizes', settled)
    expect(await diffPixels(burst, settled)).toBeGreaterThan(300)
    await page.close()
  }, 30_000)

  it('writes the contact sheet (MASCOT_SHEET=1)', async (ctx) => {
    if (!browser || !SHEET) return ctx.skip()
    fs.mkdirSync(OUT, { recursive: true })
    const names: string[] = [...MASCOT_MOODS, 'happy-estrela']
    const cellW = 460
    const cellH = Math.round((cellW * CLIP.height) / CLIP.width)
    const caption = 40
    const cols = 5
    const rows = Math.ceil(names.length / cols)
    const width = cols * cellW
    const height = rows * (cellH + caption)
    const composites: OverlayOptions[] = []
    for (const [i, name] of names.entries()) {
      const buf = shots.get(name)
      expect(buf, name).toBeTruthy()
      const left = (i % cols) * cellW
      const top = Math.floor(i / cols) * (cellH + caption)
      composites.push({ input: await sharp(buf!).resize(cellW, cellH).png().toBuffer(), left, top })
      const label = name === 'happy-estrela' ? 'happy (olhos de estrela, 1s)' : name
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${caption}"><text x="${cellW / 2}" y="27" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600" fill="#ffd9b8">${label}</text></svg>`
      composites.push({ input: Buffer.from(svg), left, top: top + cellH })
    }
    const sheet = await sharp({ create: { width, height, channels: 3, background: BACKDROP } })
      .composite(composites)
      .png()
      .toBuffer()
    fs.writeFileSync(path.join(OUT, 'humores.png'), sheet)
    expect(fs.statSync(path.join(OUT, 'humores.png')).size).toBeGreaterThan(20_000)
  }, 60_000)
})
