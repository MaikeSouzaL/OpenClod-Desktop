import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * The Chrome extension injects `openclodPageTool` into the user's page. Here the very same source runs in a
 * real browser against a fixture page, so the click/type/press/snapshot behaviour is verified without
 * needing the extension to be loaded into the user's Chrome.
 */
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'resources', 'chrome-extension', 'page-tool.js'), 'utf8')

const FIXTURE = `<!doctype html><html><head><title>Fixture</title></head><body>
<h1>Painel</h1>
<p>Texto longo que também contém a palavra Enviar e Entrar, só para enganar buscas por textContent.</p>
<a href="/relatorio" onclick="event.preventDefault();window.linkClicked=1">Enviar relatório</a>
<button id="send" onclick="window.sent=(window.sent||0)+1">Enviar</button>
<div id="card" onclick="window.card=1" style="cursor:pointer">Abrir cartão especial</div>
<button id="hidden" style="display:none" onclick="window.hiddenClicked=1">Enviar</button>
<form id="f" onsubmit="event.preventDefault(); window.submitted=(document.getElementById('q').value)">
  <label for="q">Buscar produto</label><input id="q" name="q" placeholder="digite aqui">
  <label>E-mail <input id="mail" type="email"></label>
  <select id="uf" aria-label="Estado"><option value="SP">São Paulo</option><option value="RJ">Rio de Janeiro</option></select>
  <label><input id="ok" type="checkbox"> Aceito os termos</label>
  <button type="submit" id="go">Pesquisar</button>
</form>
<textarea aria-label="Observação"></textarea>
<div id="rich" contenteditable="true" aria-label="Editor"></div>
<script>
  // A controlled input in the React style: it only trusts changes announced through the native setter.
  const q = document.getElementById('q'); window.typedEvents = 0
  q.addEventListener('input', () => { window.typedEvents++ })
</script>
</body></html>`

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
  await page.setContent(FIXTURE)
  await page.addScriptTag({ content: SOURCE })
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

const tool = (action: string, payload: Record<string, unknown>) =>
  page.evaluate(([a, p]) => (globalThis as unknown as { openclodPageTool: (a: string, p: unknown) => unknown }).openclodPageTool(a as string, p), [action, payload] as const)

const read = <T>(expression: string): Promise<T> => page.evaluate(expression) as Promise<T>

describe('openclodPageTool in a real browser', () => {
  it('clicks the button whose name matches best, not <html>', async (ctx) => {
    if (!browser) return ctx.skip()
    const result = (await tool('click', { name: 'Enviar' })) as { chosen: { tag: string; role: string }; matches: number }
    expect(result.chosen).toMatchObject({ tag: 'button', role: 'button' })
    expect(await read<number>('window.sent')).toBe(1)
    expect(await read<unknown>('window.hiddenClicked')).toBeUndefined()
  })

  it('narrows by role, and exact names beat partial ones', async (ctx) => {
    if (!browser) return ctx.skip()
    const link = (await tool('click', { role: 'link', name: 'Enviar' })) as { chosen: { tag: string; name: string } }
    expect(link.chosen).toMatchObject({ tag: 'a', name: 'Enviar relatório' })
  })

  it('clicks something that is clickable but not marked interactive, by its own text', async (ctx) => {
    if (!browser) return ctx.skip()
    await tool('click', { text: 'cartão especial' })
    expect(await read<number>('window.card')).toBe(1)
  })

  it('reports a missing element instead of clicking something else', async (ctx) => {
    if (!browser) return ctx.skip()
    await expect(tool('click', { name: 'Botão que não existe' })).rejects.toThrow(/não encontrado/)
  })

  it('types by label, fires input events, and submits the real form', async (ctx) => {
    if (!browser) return ctx.skip()
    const result = (await tool('type', { name: 'Buscar produto', value: 'cadeira gamer', submit: true })) as { submitted: boolean; chosen: { role: string } }
    expect(result).toMatchObject({ submitted: true, chosen: { role: 'textbox' } })
    expect(await read<string>('document.getElementById("q").value')).toBe('cadeira gamer')
    expect(await read<number>('window.typedEvents')).toBeGreaterThan(0)
    expect(await read<string>('window.submitted')).toBe('cadeira gamer')
  })

  it('fills selects, checkboxes, textareas and contenteditable areas', async (ctx) => {
    if (!browser) return ctx.skip()
    await tool('type', { name: 'Estado', value: 'Rio de Janeiro' })
    expect(await read<string>('document.getElementById("uf").value')).toBe('RJ')
    await tool('type', { name: 'Aceito os termos', value: 'true' })
    expect(await read<boolean>('document.getElementById("ok").checked')).toBe(true)
    await tool('type', { name: 'Observação', value: 'linha 1' })
    expect(await read<string>('document.querySelector("textarea").value')).toBe('linha 1')
    await tool('type', { name: 'Editor', value: 'texto rico' })
    expect(await read<string>('document.getElementById("rich").textContent')).toBe('texto rico')
    await tool('type', { name: 'E-mail', value: 'a@b.co' })
    expect(await read<string>('document.getElementById("mail").value')).toBe('a@b.co')
  })

  it('Enter inside a form field submits it; Tab moves focus', async (ctx) => {
    if (!browser) return ctx.skip()
    await page.evaluate('window.submitted = null; document.getElementById("q").focus()')
    await tool('press', { key: 'Enter' })
    expect(await read<string>('window.submitted')).toBe('cadeira gamer')
    await page.evaluate('document.getElementById("q").focus()')
    const moved = (await tool('press', { key: 'Tab' })) as { focused: { tag: string } | null }
    expect(moved.focused).not.toBeNull()
    expect(await read<string>('document.activeElement.id')).not.toBe('q')
  })

  it('snapshot lists interactive elements with roles, names and link targets, and skips hidden ones', async (ctx) => {
    if (!browser) return ctx.skip()
    const text = (await tool('snapshot', { maxChars: 8000 })) as string
    expect(text).toContain('Elementos (')
    expect(text).toMatch(/- button "Enviar"/)
    expect(text).toMatch(/- link "Enviar relatório" → \S*\/relatorio/)
    expect(text).toMatch(/- textbox "Buscar produto"/)
    expect(text).toMatch(/- heading "Painel"/)
    expect(text).toContain('Texto da página:')
    expect((text.match(/button "Enviar"/g) ?? []).length).toBe(1)
  })
})
