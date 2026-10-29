// End-to-end of "files in the project memory" in the real app (throwaway profile): Memória → Guardar pasta saves pictures
// (described by a model that reads images, the text read by OCR), a Markdown document and a spreadsheet; the counters by
// kind, the cards with thumbnails, the file page with its picture, the search by what is IN the picture, the AI-Memory
// index; then a picture pasted in a conversation lands in the memory too, linked to that turn.
//
// The describing model is the embedded llama.cpp running qwen3.5:4b (the GGUF Ollama already downloaded, read in place):
// no cloud, no key. Needs the bundled llama-server (node scripts/embed-llamacpp.mjs).
//
//   node scripts/ui-memory-files.cjs [--root <snapshot>] [--model qwen3.5:4b] [--out dir]
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'memoria-arquivos-2026-10-29')))
const MODEL = e2e.arg('model', 'qwen3.5:4b')
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const shot = async (page, name, locator) => {
  const file = path.join(OUT, `${name}.png`)
  if (locator) await locator.screenshot({ path: file })
  else await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

/** A picture with big readable text (what OCR must read and the search must find). */
async function textPicture(file, lines, background) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520"><rect width="100%" height="100%" fill="${background}"/>${lines
    .map((line, index) => `<text x="60" y="${150 + index * 120}" font-family="Arial" font-size="72" font-weight="bold" fill="#111">${line}</text>`)
    .join('')}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(file)
}

async function main() {
  const ws = e2e.makeWorkspace({ prefix: 'openclod-memfiles-' })
  const folder = path.join(ws.project, 'vault-urmobo')
  fs.mkdirSync(path.join(folder, 'imagens'), { recursive: true })
  await textPicture(path.join(folder, 'imagens', 'tela-pedido.png'), ['PEDIDO 4821', 'FATURAMENTO 29/10'], '#ffffff')
  await textPicture(path.join(folder, 'imagens', 'tela-parceiro.png'), ['CADASTRO PARCEIRO', 'CNPJ OBRIGATORIO'], '#e8f0ff')
  fs.writeFileSync(path.join(folder, 'regras.md'), '# Regras do pedido\n\nO campo data de faturamento só aparece depois da aprovação do gestor.\n')
  fs.writeFileSync(path.join(folder, 'pedidos.csv'), 'pedido,cliente,valor\n4821,Rosa,1200\n4822,Augusto,900\n')
  const pasted = path.join(ws.work, 'colada.png')
  await textPicture(pasted, ['BOTAO SALVAR', 'DESABILITADO'], '#fff4e0')

  const app = await e2e.launch({ port: 9487, ...ws, env: { OPENCLOD_E2E_MEMORY_PICK: folder } })
  const report = { startedAt: new Date().toISOString(), model: MODEL }
  try {
    const { page } = app
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Memória com arquivos', projectName: 'Urmobo E2E', mode: 'code' })
    const projectId = session.projectId

    // The describing model: llama.cpp (local) with a model that reads images.
    const llama = await page.evaluate(async (name) => {
      const models = (await window.openclod.app.llamacppModels()).value
      const model = models.find((item) => item.name === name)
      if (!model) return { error: `modelo ${name} não encontrado`, found: models.map((item) => item.name) }
      await window.openclod.app.llamacppSetProfile({ model: model.path })
      await window.openclod.app.llamacppStart()
      for (let i = 0; i < 600; i++) {
        const status = (await window.openclod.app.llamacppStatus()).value
        if (status.state === 'pronto' || status.state === 'erro') return { state: status.state, error: status.error, vision: status.vision }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return { state: 'timeout' }
    }, MODEL)
    check('o modelo local que lê imagens está pronto (llama.cpp)', llama.state === 'pronto' && llama.vision, llama)

    await page.reload()
    await page.waitForSelector('.app-shell')
    await page.locator('.side-nav button', { hasText: 'Memória' }).click()
    await page.waitForSelector('.memory-page', { timeout: 20000 })
    await page.locator('.memory-project', { hasText: 'Urmobo E2E' }).click()
    await page.waitForSelector('.memory-add-folder', { timeout: 10000 })

    // 1. Guardar pasta (with its subfolders).
    const startedAt = Date.now()
    await page.locator('.memory-add-folder').click()
    await page.waitForSelector('.memory-add', { timeout: 10000 })
    report.banner = await shot(page, '01-guardando', page.locator('.memory-add'))
    const job = await page.evaluate(async (id) => {
      for (let i = 0; i < 1200; i++) {
        const value = (await window.openclod.memory.addStatus(id)).value
        if (value && !value.active) return value
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return null
    }, projectId)
    report.saveSeconds = Math.round((Date.now() - startedAt) / 100) / 10
    check('Guardar pasta guarda os 4 arquivos (com as subpastas)', job && job.added === 4 && job.failed.length === 0, { ...job, seconds: report.saveSeconds })
    check('as 2 imagens saem descritas pelo modelo que enxerga', job && job.described >= 2, job && job.described)

    const files = await page.evaluate(async (id) => (await window.openclod.memory.files(id)).value, projectId)
    const pedido = files.find((file) => file.name === 'tela-pedido.png')
    check('cada arquivo tem o seu tipo, a imagem tem miniatura e descrição', Boolean(pedido?.thumb && pedido.description) && files.some((file) => file.kind === 'texto') && files.some((file) => file.kind === 'planilha'), files.map((file) => `${file.kind}:${file.name}:${file.describedBy ?? ''}`))
    report.description = pedido?.description?.slice(0, 400)
    const pedidoPage = await page.evaluate(async ({ id, slug }) => (await window.openclod.memory.read(id, slug)).value, { id: projectId, slug: pedido?.slug })
    check('a página da imagem traz o texto lido nela (OCR) e a ficha', /4821/.test(pedidoPage?.body ?? '') && /SHA-256/.test(pedidoPage?.body ?? ''), (pedidoPage?.body ?? '').slice(0, 300))

    // 2. The screen: counters by kind, cards with thumbnails, the file page.
    await page.locator('.memory-page button', { hasText: 'Atualizar' }).click()
    await page.waitForSelector('.memory-kinds button[data-kind="imagem"]', { timeout: 15000 })
    const kinds = await page.locator('.memory-kinds').textContent()
    check('a Memória conta os arquivos por tipo (imagens, textos, planilhas)', /2\s*imagens/.test(kinds) && /1\s*textos/.test(kinds) && /1\s*planilhas/.test(kinds), kinds)
    report.counters = await shot(page, '02-contagens', page.locator('.memory-stats'))
    await page.locator('.memory-kinds button[data-kind="imagem"]').click()
    await page.waitForFunction(() => document.querySelectorAll('.memory-file-card .memory-thumb img[src^="data:image/jpeg"]').length >= 2, null, { timeout: 15000 })
    check('o filtro "imagens" mostra os 2 cards com a miniatura', (await page.locator('.memory-file-card').count()) === 2)
    report.cards = await shot(page, '03-imagens')
    await page.locator('.memory-file-card', { hasText: 'tela-pedido.png' }).locator('.memory-card-open').click()
    await page.waitForSelector('.memory-detail .memory-thumb.large img', { timeout: 15000 })
    const detail = await page.locator('.memory-detail').textContent()
    check('a página do arquivo mostra a imagem, a descrição e o botão de abrir', /Abrir o arquivo/.test(detail) && /Descrição/.test(detail), detail.slice(0, 200))
    report.detail = await shot(page, '04-pagina-da-imagem')
    await page.locator('.memory-detail-head button', { hasText: 'Voltar' }).click()

    // 3. Found by what is in the picture.
    await page.locator('.memory-kinds button', { hasText: 'Tudo' }).click()
    await page.locator('.page-search input').fill('4821')
    await page.waitForTimeout(500)
    const hits = await page.locator('.memory-card').allTextContents()
    check('procurar "4821" acha a imagem pelo texto que há nela', hits.some((text) => /tela-pedido\.png/.test(text)), hits.map((text) => text.slice(0, 60)))
    await page.locator('.page-search input').fill('')

    // 4. The long-term index gets them.
    const indexed = await page.evaluate(async (id) => {
      for (let i = 0; i < 60; i++) {
        const stats = (await window.openclod.memory.status(id)).value
        if ((stats.indexed ?? 0) >= 4) return stats
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return (await window.openclod.memory.status(id)).value
    }, projectId)
    check('as páginas dos arquivos entram no índice AI-Memory (número real, não a lista "recentes")', (indexed.indexed ?? 0) >= 4, { indexed: indexed.indexed, pages: indexed.pages, sync: indexed.indexSync, aiRunning: indexed.aiRunning })

    // 5. A picture pasted in a conversation on the local model goes to the memory, linked to that turn.
    const chat = await e2e.newSession(page, { folder: ws.project, title: 'Conversa com imagem', projectName: 'Urmobo E2E', mode: 'code', providerId: 'llamacpp' })
    const data = fs.readFileSync(pasted).toString('base64')
    await page.evaluate(
      async ({ id, data }) => window.openclod.sessions.send(id, 'Olhe este print do botão e responda só OK, sem usar ferramentas.', [{ type: 'image', mediaType: 'image/png', data }]),
      { id: chat.sessionId, data }
    )
    await e2e.waitSettled(page, chat.sessionId, { timeoutMs: 6 * 60_000 })
    const kept = await page.evaluate(async (id) => {
      for (let i = 0; i < 120; i++) {
        const list = (await window.openclod.memory.files(id)).value
        const found = list.find((file) => /imagem da conversa/.test(file.name))
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return null
    }, projectId)
    check('a imagem colada na conversa vira arquivo da memória, ligado ao turno e à sessão', Boolean(kept && kept.links.length >= 2), kept && { name: kept.name, links: kept.links, describedBy: kept.describedBy })
    check('sem erros no console da tela', app.errors.length === 0, app.errors.slice(0, 3))
  } catch (err) {
    check('sem exceção', false, err.stack || String(err))
    try {
      report.failure = await shot(app.page, 'falha')
    } catch {}
  } finally {
    report.checks = checks
    try {
      fs.copyFileSync(path.join(ws.profile, 'logs', 'main.log'), path.join(OUT, 'main.log'))
    } catch {}
    fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(report, null, 2))
    app.cleanup()
    const values = Object.values(checks)
    console.log(`\n${values.filter((value) => value === 'ok').length}/${values.length} OK · ${path.relative(e2e.ROOT, OUT)}`)
    process.exitCode = ok() ? 0 : 1
  }
}

void main()
