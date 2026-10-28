// End-to-end: drawings the model makes are SHOWN on screen, the way Claude shows them.
// Uses a REAL model (DeepSeek by default; only the key vault is borrowed from the real profile).
//
//   node scripts/ui-drawings.cjs [--out Prints/desenhos-2026-10-27] [--from "%APPDATA%\Openclod Desktop"]
//
// Turn 1: "draw X in SVG and show it here" -> an <img> picture block (Visualizar / Código tabs, full screen).
// Turn 2: "create desenhos/sol.svg, animated"  -> the written .svg file gets the same picture in its edit card.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'desenhos-2026-10-27')))
const PORT = 9421

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-draw-' })
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { checks: {}, errors: [], turns: [] }
  const check = (name, ok, detail) => {
    result.checks[name] = ok ? 'ok' : `FALHOU${detail ? `: ${detail}` : ''}`
    if (!ok) result.failed = true
  }
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Desenhos', projectName: 'Projeto desenhos' })
    result.provider = `${session.provider}/${session.model}`
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Desenhos', 'Projeto desenhos')

    // ---- Turn 1: inline SVG drawing ----
    await e2e.send(page, 'Desenhe uma casinha simples com telhado vermelho, porta e janela em SVG e mostre o desenho aqui na conversa.')
    const first = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000 })
    result.turns.push({ report: await e2e.turnReport(page, session.sessionId, 0), settled: first })

    const block = page.locator('.drawing-block[data-kind="svg"]').first()
    await block.waitFor({ timeout: 20000 })
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.drawing-block[data-kind="svg"] img.drawing-img')
        return Boolean(img && img.complete && img.naturalWidth > 0)
      },
      null,
      { timeout: 15000 }
    ).then(() => check('svg-desenhado-como-imagem', true), (error) => check('svg-desenhado-como-imagem', false, error.message))
    const size = await page.evaluate(() => {
      const img = document.querySelector('.drawing-block[data-kind="svg"] img.drawing-img')
      return img ? { w: img.naturalWidth, h: img.naturalHeight, shown: img.getBoundingClientRect().width } : null
    })
    check('imagem-com-tamanho-visivel', Boolean(size && size.shown > 40), JSON.stringify(size))
    const rawFence = await page.evaluate(() => /```\s*svg/i.test(document.body.innerText))
    check('cerca-de-codigo-nao-aparece-como-texto', !rawFence)
    await block.scrollIntoViewIfNeeded()
    await block.screenshot({ path: path.join(OUT, '01-casinha-visualizar.png') })

    await block.getByRole('tab', { name: /Código/ }).click()
    const code = await block.locator('.drawing-code').innerText()
    check('aba-codigo-mostra-o-svg', /<svg[\s\S]*<\/svg>/i.test(code), code.slice(0, 80))
    await block.screenshot({ path: path.join(OUT, '02-casinha-codigo.png') })
    await block.getByRole('tab', { name: /Visualizar/ }).click()

    await block.getByRole('button', { name: 'Tela cheia' }).click()
    await page.locator('.drawing-overlay').waitFor({ timeout: 5000 })
    await page.screenshot({ path: path.join(OUT, '03-casinha-tela-cheia.png') })
    await page.keyboard.press('Escape')
    await page.locator('.drawing-overlay').waitFor({ state: 'detached', timeout: 5000 })
    check('tela-cheia-abre-e-fecha-com-esc', true)

    // ---- Turn 2: an animated .svg written to a file ----
    const before = first.count
    await e2e.send(page, 'Crie o arquivo desenhos/sol.svg com um sol amarelo cujos raios giram (animação SVG, sem JavaScript) e diga só "pronto".')
    const second = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000, sinceCount: before })
    result.turns.push({ report: await e2e.turnReport(page, session.sessionId, before), settled: second })

    const file = path.join(ws.project, 'desenhos', 'sol.svg')
    check('arquivo-sol-svg-criado', fs.existsSync(file))
    if (fs.existsSync(file)) {
      const svg = fs.readFileSync(file, 'utf8')
      check('sol-tem-animacao', /<animate|@keyframes/i.test(svg), svg.slice(0, 120))
    }
    // The model may also have saved the house of turn 1 as a file, so pick the card of THIS file.
    const card = page.locator('.edit-card .drawing-block', { hasText: 'sol.svg' }).first()
    await card.waitFor({ timeout: 20000 }).then(() => check('card-de-edicao-mostra-o-desenho', true), (error) => check('card-de-edicao-mostra-o-desenho', false, error.message))
    if (await card.count()) {
      await card.scrollIntoViewIfNeeded()
      await card.screenshot({ path: path.join(OUT, '04-sol-no-card-de-edicao.png') })
    }
    await page.screenshot({ path: path.join(OUT, '05-conversa-completa.png') })
    result.errors = app.errors.filter((line) => line.startsWith('pageerror'))
    check('sem-erros-de-pagina', result.errors.length === 0, result.errors.join(' | '))
  } finally {
    app.cleanup()
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.failed ? 1 : 0)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
