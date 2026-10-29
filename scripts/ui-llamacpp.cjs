// End-to-end of the embedded llama.cpp in the real app (Configurações → Provedores → llama.cpp (local)), with a real model
// and the real GPU: find the models already on this computer, pick one, start the bundled llama-server, read what it
// reports (layers on the GPU, the card), change a server option and see it in the command line, create a profile, open
// the Hugging Face list (what fits this GPU) and Versões (the CUDA the driver runs), stop it — and then a conversation on
// "llama.cpp (local)" that starts the server by itself and answers.
//
// Throwaway profile; the model is the one Ollama already downloaded (read in place, Ollama does not need to run). Needs
// the bundled server (node scripts/embed-llamacpp.mjs) and internet for the Hugging Face list.
//
//   node scripts/ui-llamacpp.cjs [--root <snapshot>] [--model qwen3.5:4b] [--out dir]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'llamacpp-2026-10-29')))
const MODEL = e2e.arg('model', 'qwen3.5:4b')
const PORT = 9471
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const shot = async (page, name, locator) => {
  const file = path.join(OUT, `${name}.png`)
  if (locator) await locator.screenshot({ path: file })
  else await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

const status = (page) => page.evaluate(async () => (await window.openclod.app.llamacppStatus()).value)

async function waitState(page, wanted, timeoutMs = 8 * 60_000) {
  const started = Date.now()
  for (;;) {
    const now = await status(page)
    if (wanted.includes(now.state)) return now
    if (Date.now() - started > timeoutMs) return now
    await page.waitForTimeout(500)
  }
}

async function openSection(page, title) {
  const section = page.locator('.llama-card details', { has: page.locator('summary', { hasText: title }) }).first()
  if (!(await section.evaluate((node) => node.open))) await section.locator('summary').first().click()
  return section
}

async function main() {
  const ws = e2e.makeWorkspace({ prefix: 'openclod-llama-' })
  const app = await e2e.launch({ port: PORT, ...ws })
  const report = { startedAt: new Date().toISOString(), model: MODEL }
  // A reload of the window (the renderer or the GPU process died) would silently drop the dialog: say it when it happens.
  const reloads = []
  app.page.on('framenavigated', (frame) => frame === app.page.mainFrame() && reloads.push(new Date().toISOString()))
  app.page.on('crash', () => reloads.push('crash'))
  try {
    const { page } = app
    await page.keyboard.press('Control+,')
    await page.waitForSelector('.provider-grid', { timeout: 15000 })
    const card = page.locator('.llama-card')
    await card.waitFor({ timeout: 15000 })
    check('o cartão do llama.cpp aparece em Provedores, com a versão embutida', (await card.textContent()).includes('Vulkan · b11972'))

    // 1. Models already on this computer.
    await page.waitForSelector('.llama-found-list li', { timeout: 30000 })
    const found = await card.locator('.llama-found-list li').allTextContents()
    const row = card.locator('.llama-found-list li', { hasText: MODEL }).first()
    check(`acha os modelos deste computador (o ${MODEL} do Ollama, com visão)`, (await row.count()) > 0 && /Ollama/.test(await row.textContent()) && /visão/.test(await row.textContent()), found.slice(0, 5))
    await row.locator('.llama-use').click()
    await page.waitForFunction((name) => document.querySelector('.llama-model-name')?.textContent?.includes(name), MODEL, { timeout: 15000 })
    const model = await status(page)
    check('escolher o modelo traz o nome, o apelido e o projetor de visão', model.model?.name === MODEL && model.profile.alias === MODEL.replace(':', '-') && Boolean(model.profile.mmproj), {
      name: model.model?.name,
      alias: model.profile.alias,
      mmproj: Boolean(model.profile.mmproj),
      tools: model.model?.tools
    })
    report.cardChosen = await shot(page, '01-modelo-escolhido', card)

    // 2. Start the bundled server.
    const startedAt = Date.now()
    await card.locator('.llama-start').click()
    const ready = await waitState(page, ['pronto', 'erro'])
    report.loadSeconds = Math.round((Date.now() - startedAt) / 100) / 10
    check('Iniciar sobe o llama-server e ele fica Pronto', ready.state === 'pronto', `${ready.state} em ${report.loadSeconds} s ${ready.error ?? ''}`)
    await page.waitForSelector('.llama-specs', { timeout: 15000 })
    const specs = await card.locator('.llama-specs').textContent()
    check('o cartão mostra camadas na GPU, a placa e o contexto aberto', /\d+\/\d+/.test(specs) && /RTX|GPU|Radeon|Arc/i.test(specs), specs)
    const providers = await page.evaluate(async () => (await window.openclod.app.settings()).value.providers.filter((item) => item.id === 'llamacpp'))
    check('virou o provedor "llama.cpp (local)" em 127.0.0.1, com visão', providers.length === 1 && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(providers[0].baseUrl) && providers[0].supportsVision, providers[0])
    report.cardReady = await shot(page, '02-pronto', card)

    // 3. Server options: read from the build's --help.
    const options = await openSection(page, 'Opções do servidor')
    await options.locator('.llama-option-groups').waitFor({ timeout: 20000 })
    const groups = await options.locator('.llama-option-group > summary').allTextContents()
    check('Opções do servidor lista os grupos da ajuda do llama-server', groups.length >= 8, groups.slice(0, 6))
    await options.locator('.llama-search').fill('flash')
    await options.locator('#llama-opt-flash-attn').selectOption('on')
    await options.getByRole('button', { name: 'Salvar opções' }).click()
    await page.waitForFunction(() => /--flash-attn on/.test(document.querySelector('.llama-command pre')?.textContent ?? ''), null, { timeout: 15000 })
    const line = await options.locator('.llama-command pre').textContent()
    check('salvar uma opção muda a linha de comando do próximo início (sem a chave)', /--flash-attn on/.test(line) && /--host 127\.0\.0\.1/.test(line) && !/api-key|LLAMA_API_KEY/i.test(line), line.slice(-160))
    await options.locator('.llama-search').fill('')
    report.options = await shot(page, '03-opcoes', options)
    await options.locator('summary').first().click()

    // 4. Profiles.
    await card.locator('.llama-profiles').getByRole('button', { name: 'Novo' }).click()
    await card.locator('.llama-profile-form input').fill('Rápido')
    await card.locator('.llama-profile-form').getByRole('button', { name: 'Criar' }).click()
    await page.waitForFunction(() => document.querySelector('.llama-profiles select')?.value === 'Rápido', null, { timeout: 10000 })
    const profiles = await status(page)
    check('Novo perfil copia o atual e fica ativo', profiles.activeProfile === 'Rápido' && profiles.profiles.length === 2 && profiles.profile.model === model.profile.model, profiles.profiles)
    await card.locator('.llama-profiles select').selectOption('Padrão')
    await page.waitForFunction(() => document.querySelector('.llama-profiles select')?.value === 'Padrão', null, { timeout: 10000 })

    // 5. Hugging Face list for this GPU.
    const hub = await openSection(page, 'Baixar modelos do Hugging Face')
    await hub.locator('.llama-hub-list li').first().waitFor({ timeout: 90000 })
    const machine = await hub.locator('.llama-hub-machine').textContent()
    const fits = await hub.locator('.llama-hub-list li .llama-fit').allTextContents()
    check('Baixar mostra a placa e os modelos que cabem nela', /VRAM/.test(machine) && fits.length > 10 && fits.every((text) => text.startsWith('Cabe na GPU')), { machine, rows: fits.length, first: fits[0] })
    await hub.locator('.llama-hub-list li').first().getByRole('button', { name: 'Ver arquivos' }).click()
    await hub.locator('.llama-hub-files table tr').first().waitFor({ timeout: 30000 })
    const files = await hub.locator('.llama-hub-files tr').count()
    const suggested = await hub.locator('.llama-hub-files tr.suggested').textContent().catch(() => '')
    check('Ver arquivos traz os arquivos reais do repositório, com o sugerido', files > 1 && /sugerido/.test(suggested), { files, suggested })
    report.hub = await shot(page, '04-baixar', hub)
    await hub.locator('summary').first().click()

    // 6. Versões.
    const builds = await openSection(page, 'Versões do llama.cpp')
    await builds.locator('.llama-kinds').waitFor({ timeout: 30000 })
    const buildText = await builds.textContent()
    check('Versões mostra a versão embutida em uso e as do GitHub para esta placa', /embutida/.test(buildText) && /Em uso/.test(buildText) && /CUDA/.test(buildText), buildText.slice(0, 220))
    report.builds = await shot(page, '05-versoes', builds)
    await builds.locator('summary').first().click()

    // 7. Stop, then a conversation on it starts the server by itself.
    await card.locator('.llama-stop').click()
    const stopped = await waitState(page, ['parado', 'erro'], 30000)
    check('Parar desliga o servidor', stopped.state === 'parado', stopped.state)
    await page.keyboard.press('Escape')
    const session = await e2e.newSession(page, { folder: ws.project, title: 'llama local', projectName: 'Llama E2E', mode: 'code', providerId: 'llamacpp' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'llama local', 'Llama E2E')
    const asked = Date.now()
    await e2e.send(page, 'Responda apenas com a palavra FUNCIONOU, sem usar ferramentas.')
    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 8 * 60_000 })
    const turn = await e2e.turnReport(page, session.sessionId)
    const after = await status(page)
    report.chatSeconds = Math.round((Date.now() - asked) / 100) / 10
    check('uma conversa no llama.cpp com o servidor parado liga o servidor sozinha', after.state === 'pronto', after.state)
    check('e o modelo local responde', /FUNCIONOU/i.test(turn.finalText), `${settled.run} em ${report.chatSeconds} s: "${turn.finalText.slice(0, 120)}"`)
    const meta = await e2e.checkModel(page, session)
    check('a conversa ficou no llama.cpp (não caiu para outro provedor)', meta.actual.providerId === 'llamacpp', meta.actual)
    report.chat = await shot(page, '06-conversa')
    check('sem erros no console da tela', app.errors.length === 0, app.errors.slice(0, 3))
  } catch (err) {
    check('sem exceção', false, err.stack || String(err))
    try {
      report.failure = await shot(app.page, 'falha')
    } catch {}
  } finally {
    report.reloads = reloads
    // The app's own log (llama-server lines, renderer/GPU process gone) goes with the report.
    try {
      fs.copyFileSync(path.join(ws.profile, 'logs', 'main.log'), path.join(OUT, 'main.log'))
    } catch {}
    report.checks = checks
    fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(report, null, 2))
    app.cleanup()
    const values = Object.values(checks)
    console.log(`\n${values.filter((value) => value === 'ok').length}/${values.length} OK · ${path.relative(e2e.ROOT, OUT)}`)
    process.exitCode = ok() ? 0 : 1
  }
}

void main()
