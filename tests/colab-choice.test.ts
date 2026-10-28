import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findPython, runPython } from './support/colab-python'

/**
 * The "choose the model" box that step 2 of the Colab notebook shows in the cell output (resources/colab/openclod_llm_server.py,
 * `CHOICE_JS` + `choice_call`). The Colab itself cannot run here, so the box runs in a REAL browser the way the Colab runs it:
 * `display(Javascript(CHOICE_JS))` becomes `page.evaluate(definition)` and `eval_js(call)` becomes `page.evaluate(call)`, which waits
 * for the Promise the call returns. `window.google.colab.output.setIframeHeight` is the only piece of the Colab that is faked.
 * Skipped (not failed) when this computer has no Python or no Chrome/Edge, like the other browser tests.
 * OPENCLOD_COLAB_CHOICE_SHOTS=<folder> also saves a screenshot of each state there.
 */
const MODULE_DIR = path.join(__dirname, '..', 'resources', 'colab')
const SHOTS = process.env.OPENCLOD_COLAB_CHOICE_SHOTS || ''
const python = findPython()

interface ChoiceItem {
  n: number
  texto: string
  detalhe: string
  av: string[]
}
interface ChoiceData {
  segundos: number
  automatico: { texto: string; detalhe: string; av: string[] }
  grupos: Array<{ titulo: string; itens: ChoiceItem[] }>
  avisos: Record<string, string>
}
interface Box {
  definition: string
  call: string
  data: ChoiceData
}

/** The box exactly as the module builds it for a 16 GB T4 (hostile = markup in every text the box shows). */
function loadBox(seconds = 120, hostile = false): Box {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(MODULE_DIR)})`,
    'import openclod_llm_server as oc',
    'seconds, hostile = int(sys.argv[1]), sys.argv[2] == "1"',
    'listing = oc.build_listing(oc.usable_gib(15360, 14913))',
    'plan = oc.plan_for(15360, free_mib=14913)',
    'data = oc.choice_data(listing, plan, seconds=seconds)',
    'if hostile:',
    '    evil = \'<img src=x onerror="window.__pwned = 1"><b id=intruso>x</b>\'',
    '    first = data["grupos"][0]["itens"][0]',
    '    first["texto"] += " " + evil',
    '    first["detalhe"] += " " + evil',
    '    data["automatico"]["texto"] += " " + evil',
    '    data["automatico"]["detalhe"] += " " + evil',
    '    data["grupos"][0]["titulo"] += " " + evil',
    '    data["avisos"]["curto"] = evil',
    '    first["av"] = ["curto"]',
    'print(json.dumps({"definition": oc.CHOICE_JS, "data": data, "call": oc.choice_call(data)}, ensure_ascii=False))'
  ].join('\n')
  const result = runPython(['-c', code, String(seconds), hostile ? '1' : '0'])
  if (result.status !== 0) throw new Error(`python falhou: ${result.stderr}`)
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as Box
}

let browser: Browser | null = null

beforeAll(async () => {
  if (!python) return
  for (const options of [{ channel: 'chrome' as const }, { channel: 'msedge' as const }, {}]) {
    try {
      browser = await chromium.launch({ headless: true, ...options })
      break
    } catch {
      browser = null
    }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

/** A fresh page with a fake Colab, the definition loaded (as `display(Javascript(...))` does) and the call running (as `eval_js` does). */
async function openBox(box: Box, options: { fakeClock?: boolean } = {}): Promise<{ page: Page; reply: Promise<string> }> {
  const page = await browser!.newPage({ viewport: { width: 900, height: 760 } })
  if (options.fakeClock) await page.clock.install()
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:8px"></body></html>')
  await page.evaluate('window.google = { colab: { output: { setIframeHeight: (height, force) => { (window.__alturas = window.__alturas || []).push([height, force]) } } } }')
  await page.evaluate(box.definition)
  const reply = page.evaluate(box.call) as Promise<string>
  // A test that never answers the box leaves this Promise pending when it closes the page: that is not an unhandled error.
  reply.catch(() => undefined)
  await page.waitForSelector('[data-openclod="escolha-do-modelo"]')
  return { page, reply }
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function value<T>(page: Page, expression: string): Promise<T> {
  return (await page.evaluate(expression)) as T
}

const part = (name: string): string => `[data-parte=${name}]`
const BOTH_OFF = "document.querySelector('select').disabled && document.querySelector('button').disabled"

describe('the script itself', () => {
  it.skipIf(!python)('is one definition and one call that both compile, and the definition does not use anything risky', () => {
    const box = loadBox()
    expect(() => new vm.Script(box.definition)).not.toThrow()
    // `eval_js` evaluates an expression: the call has to be one (wrapping it in parentheses compiles only if it is).
    expect(() => new vm.Script(`(${box.call})`)).not.toThrow()
    expect(box.call.startsWith('window.openclodEscolher(')).toBe(true)
    expect(box.definition).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|fetch\(|XMLHttpRequest|localStorage|cookie/)
  })
})

describe('the box in a real browser', () => {
  it.skipIf(!python)('shows the automatic model selected, every model of the list in groups, a button and the countdown', async (ctx) => {
    if (!browser) return ctx.skip()
    const box = loadBox()
    const { page } = await openBox(box)
    try {
      const view = await value<{ size: number; selected: string; first: string; groups: string[]; options: number; button: string; countdown: string; heights: number; overflow: number }>(
        page,
        `(() => {
          const select = document.querySelector('select')
          return {
            size: select.size,
            selected: select.value,
            first: select.options[0].textContent,
            groups: [...select.querySelectorAll('optgroup')].map((g) => g.label),
            options: select.options.length,
            button: document.querySelector('button').textContent,
            countdown: document.querySelector('${part('contagem')}').textContent,
            heights: (window.__alturas || []).length,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
          }
        })()`
      )
      const items = box.data.grupos.flatMap((group) => group.itens)
      expect(view.selected).toBe('0')
      expect(view.first).toBe(box.data.automatico.texto)
      expect(view.first).toMatch(/^Automático \(recomendado\): Qwen3\.5 9B · Q8_0 · ctx 64k/)
      expect(view.options).toBe(items.length + 1)
      expect(view.groups).toEqual(box.data.grupos.map((group) => `${group.titulo} (${group.itens.length})`))
      expect(view.size).toBeGreaterThan(1)
      expect(view.size).toBeLessThanOrEqual(12)
      expect(view.button).toBe('Usar este modelo')
      expect(view.countdown).toMatch(/^Sem escolha, segue com o automático em (2:00|1:59|1:58)$/)
      expect(view.heights).toBeGreaterThan(0)
      expect(view.overflow).toBe(0)
      await shot(page, 'escolha-1-caixa-aberta')
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('shows the details and the warnings of the model that is selected (no tools, uncensored) and clears them for the automatic', async (ctx) => {
    if (!browser) return ctx.skip()
    const box = loadBox()
    const { page } = await openBox(box)
    try {
      const items = box.data.grupos.flatMap((group) => group.itens)
      const uncensored = items.find((item) => item.av.includes('sem-censura') && item.av.includes('ferramentas'))!
      const plain = items.find((item) => item.av.length === 0)!
      const warnings = async (): Promise<string[]> => value<string[]>(page, `[...document.querySelectorAll('${part('avisos')} > div')].map((d) => d.textContent)`)
      const detail = async (): Promise<string> => (await page.locator(part('detalhe')).textContent()) ?? ''
      await page.selectOption('select', String(uncensored.n))
      expect(await warnings()).toEqual(uncensored.av.map((key) => box.data.avisos[key]))
      expect(await detail()).toBe(uncensored.detalhe)
      expect((await warnings()).join(' ')).toContain('por sua conta')
      expect((await warnings()).join(' ')).toContain('só consegue conversar')
      await shot(page, 'escolha-2-aviso-sem-censura')
      await page.selectOption('select', String(plain.n))
      expect(await warnings()).toEqual([])
      expect(await detail()).toBe(plain.detalhe)
      await page.selectOption('select', '0')
      expect(await warnings()).toEqual([])
      expect(await detail()).toBe(box.data.automatico.detalhe)
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('answers with the number of the model the user picked when the button is clicked, and then switches itself off', async (ctx) => {
    if (!browser) return ctx.skip()
    const box = loadBox()
    const { page, reply } = await openBox(box)
    try {
      const item = box.data.grupos.flatMap((group) => group.itens).find((candidate) => candidate.texto.includes('Qwen3.5 4B · Q8_0'))!
      await page.selectOption('select', String(item.n))
      await page.click('button')
      expect(JSON.parse(await reply)).toEqual({ quem: 'usuario', numero: item.n })
      expect(await value<boolean>(page, BOTH_OFF)).toBe(true)
      expect(await page.locator(part('estado')).textContent()).toBe(`Escolhido: ${item.texto}. O notebook continua (acompanhe a saída desta célula).`)
      expect(await page.locator(part('contagem')).textContent()).toBe('')
      expect(await value<string>(page, `document.querySelector('${part('trilha')}').style.display`)).toBe('none')
      await shot(page, 'escolha-3-escolhido')
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('answers 0 (the automatic) when the user just clicks the button, and a second click changes nothing', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, reply } = await openBox(loadBox())
    try {
      await page.click('button')
      expect(JSON.parse(await reply)).toEqual({ quem: 'usuario', numero: 0 })
      await page.evaluate("document.querySelector('button').click()")
      expect(await page.locator(part('estado')).textContent()).toMatch(/^Escolhido: Automático/)
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('counts down and, when the time is up, answers "tempo" by itself (the notebook then goes on with the automatic)', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, reply } = await openBox(loadBox(120), { fakeClock: true })
    try {
      await page.clock.runFor(30_000)
      expect(await page.locator(part('contagem')).textContent()).toMatch(/^Sem escolha, segue com o automático em 1:(30|29|28)$/)
      const width = Number.parseFloat(await value<string>(page, `document.querySelector('${part('barra')}').style.width`))
      expect(width).toBeGreaterThan(73)
      expect(width).toBeLessThan(76)
      await shot(page, 'escolha-4-contagem')
      await page.clock.fastForward(100_000)
      expect(JSON.parse(await reply)).toEqual({ quem: 'tempo', numero: 0 })
      expect(await page.locator(part('estado')).textContent()).toBe('Tempo esgotado: o notebook seguiu com o automático.')
      expect(await value<boolean>(page, BOTH_OFF)).toBe(true)
      await shot(page, 'escolha-5-tempo-esgotado')
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('a click that comes after the time is up changes nothing', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, reply } = await openBox(loadBox(5), { fakeClock: true })
    try {
      await page.clock.fastForward(6_000)
      expect(JSON.parse(await reply).quem).toBe('tempo')
      await page.evaluate("document.querySelector('select').disabled = false; document.querySelector('button').disabled = false; document.querySelector('button').click()")
      expect(await page.locator(part('estado')).textContent()).toBe('Tempo esgotado: o notebook seguiu com o automático.')
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('is switched off from Python when the notebook stops waiting (cancelar), and says why', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, reply } = await openBox(loadBox())
    try {
      await page.evaluate("window.openclodEscolher && window.openclodEscolher.cancelar('O notebook parou de esperar por esta escolha.')")
      expect(JSON.parse(await reply)).toEqual({ quem: 'cancelado', numero: 0 })
      expect(await page.locator(part('estado')).textContent()).toBe('O notebook parou de esperar por esta escolha.')
      expect(await value<boolean>(page, BOTH_OFF)).toBe(true)
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('never turns text from the data into markup or code', async (ctx) => {
    if (!browser) return ctx.skip()
    const box = loadBox(120, true)
    const { page, reply } = await openBox(box)
    try {
      await page.selectOption('select', String(box.data.grupos[0].itens[0].n))
      const view = await value<{ images: number; intruder: boolean; pwned: unknown; option: string; label: string; detail: string; warning: string }>(
        page,
        `(() => {
          const select = document.querySelector('select')
          return {
            images: document.querySelectorAll('img').length,
            intruder: !!document.getElementById('intruso'),
            pwned: window.__pwned === undefined ? null : window.__pwned,
            option: select.options[select.selectedIndex].textContent,
            label: select.querySelector('optgroup').label,
            detail: document.querySelector('${part('detalhe')}').textContent,
            warning: document.querySelector('${part('avisos')}').textContent
          }
        })()`
      )
      expect(view.images).toBe(0)
      expect(view.intruder).toBe(false)
      expect(view.pwned).toBeNull()
      expect(view.option).toContain('<img src=x onerror=')
      expect(view.label).toContain('<img src=x onerror=')
      expect(view.detail).toContain('<b id=intruso>x</b>')
      expect(view.warning).toContain('<img src=x onerror=')
      await page.click('button')
      expect(JSON.parse(await reply).quem).toBe('usuario')
    } finally {
      await page.close()
    }
  })

  it.skipIf(!python)('defining the function draws nothing, so reloading a saved notebook leaves no dead box behind', async (ctx) => {
    if (!browser) return ctx.skip()
    const box = loadBox()
    const page = await browser.newPage()
    try {
      await page.setContent('<!doctype html><html><body></body></html>')
      await page.evaluate(box.definition)
      expect(await value<number>(page, 'document.body.children.length')).toBe(0)
      expect(await value<string>(page, 'typeof window.openclodEscolher')).toBe('function')
    } finally {
      await page.close()
    }
  })
})
