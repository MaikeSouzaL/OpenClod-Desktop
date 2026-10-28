// End-to-end of "I added a provider and saved it: is it available to select?". It follows what the user did with OpenRouter, step by
// step, in the real app: Configurações → Provedores → OpenRouter → paste the key → Salvar chave → Detectar modelos → Salvar alterações
// → open the model menu of the composer, with NO restart in between.
//
// The OpenRouter card is pointed at a local made-up server that answers like OpenRouter's /models (40 models, some read images), and
// the key typed is a made-up test value (the run uses a throwaway profile; nothing touches the user's app or vault).
//
//   node scripts/ui-provider-add.cjs [--root <snapshot>] [--label depois] [--out dir]
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const { startFakeProvider } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'depois')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'reserva-2026-10-27')))
const PORT = 9451
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const readSettings = (ws) => JSON.parse(fs.readFileSync(path.join(ws.profile, 'config', 'settings.json'), 'utf8'))
const shot = async (page, name) => {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

async function openModelMenu(page) {
  await page.locator('.model-btn:has(.model-short)').first().click()
  await page.waitForSelector('.model-menu', { timeout: 10000 })
}

async function menuState(page, query) {
  if (query !== undefined) {
    await page.locator('.menu-search').fill(query)
    await page.waitForTimeout(300)
  }
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('.model-menu [role="menuitem"], .model-menu .menu-item')]
    const text = items.map((node) => (node.textContent || '').trim())
    const headings = [...document.querySelectorAll('.model-menu .menu-heading')].map((node) => (node.textContent || '').trim())
    return { text, headings, count: items.length }
  })
}

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-add-' })
  const fake = await startFakeProvider()
  let app = await e2e.launch({ port: PORT, ...ws })
  const report = { label: LABEL, startedAt: new Date().toISOString() }
  try {
    const { page } = app
    const before = await page.evaluate(async () => {
      const settings = (await window.forja.app.settings()).value
      const caps = (await window.forja.app.capabilities()).value
      const card = settings.providers.find((item) => item.id === 'openrouter')
      return { exists: Boolean(card), ref: (card?.apiKeyRef || '').split(':')[0], models: (card?.models || []).length, configured: caps.providers.find((item) => item.id === 'openrouter')?.configured }
    })
    check('antes: o OpenRouter está na lista de provedores, sem chave (como no perfil do usuário)', before.exists && before.configured === false, before)

    // A session to look at the composer of (default provider), then the same steps the user did.
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Provedor novo', projectName: 'Provedor novo' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Provedor novo', 'Provedor novo')

    await page.keyboard.press('Control+,')
    await page.waitForSelector('.provider-grid', { timeout: 15000 })
    await page.locator('.provider-tile', { hasText: 'OpenRouter' }).first().click()
    await page.waitForSelector('.provider-card')
    check('o cartão do OpenRouter diz "sem chave" antes de salvar a chave', (await page.locator('.provider-card .badge.ok').count()) === 0)

    // Base URL -> the made-up server (so "Detectar modelos" answers like OpenRouter), then the key.
    const baseUrl = page.locator('.provider-card label.field', { hasText: 'Base URL' }).locator('input')
    await baseUrl.fill(fake.baseUrl)
    await page.locator('.key-row input[type="password"]').fill('chave-de-teste-local-sem-valor')
    await page.getByRole('button', { name: 'Salvar chave' }).click()
    await page.waitForSelector('.provider-card .badge.ok', { timeout: 15000 })
    const keyNote = (await page.locator('.provider-card .field-note').first().textContent()) || ''
    check('Salvar chave: a tela confirma e o selo "credencial ok" aparece na hora', /chave salva/i.test(keyNote), keyNote)
    const afterKey = readSettings(ws)
    const orProvider = afterKey.providers.find((item) => item.id === 'openrouter')
    check('Salvar chave: o settings.json guarda só a referência ao cofre (secret:openrouter), nunca a chave', orProvider.apiKeyRef === 'secret:openrouter' && !JSON.stringify(afterKey).includes('chave-de-teste-local'), orProvider.apiKeyRef)
    check('Salvar chave: o cofre foi gravado (secrets.bin existe e mudou)', fs.statSync(path.join(ws.profile, 'config', 'secrets.bin')).size > 0)

    await page.getByRole('button', { name: 'Detectar modelos' }).click()
    await page.waitForFunction(() => /modelo\(s\) detectado\(s\)/.test(document.querySelector('.provider-card')?.textContent || ''), null, { timeout: 30000 })
    const detectNote = (await page.locator('.provider-card .field-note.good').textContent()) || ''
    check('Detectar modelos: lista os modelos do servidor e diz "Salve para aplicar"', /40 modelo\(s\) detectado\(s\)/.test(detectNote) && /Salve para aplicar/.test(detectNote), detectNote)
    const notSaved = readSettings(ws).providers.find((item) => item.id === 'openrouter')
    check('Detectar modelos ainda NÃO grava: o settings.json segue sem os modelos até "Salvar alterações"', (notSaved.models || []).length < 40, (notSaved.models || []).length)
    report.shotDetect = await shot(page, 'provedor-detectar-modelos')

    // The draft must survive an unrelated refresh of settings while the dialog is open (a connector starting, the last model).
    await page.evaluate(() => window.forja.app.rememberModel('deepseek', 'deepseek-flash'))
    await page.waitForTimeout(500)
    const stillDetected = await page.evaluate(() => /modelo\(s\) detectado\(s\)/.test(document.querySelector('.provider-card')?.textContent || ''))
    check('o que foi detectado não some se outra coisa das configurações é atualizada com a janela aberta', stillDetected)

    await page.getByRole('button', { name: 'Salvar alterações' }).click()
    // The "Configurações salvas." line lasts 2.5 s: look at the file (what really matters) and at the dialog's error, if any.
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((readSettings(ws).providers.find((item) => item.id === 'openrouter')?.models || []).length === 40) break
      await page.waitForTimeout(250)
    }
    const dialogError = await page.locator('.inline-error').first().textContent({ timeout: 500 }).catch(() => '')
    if (dialogError) console.log('erro no diálogo:', dialogError)
    const saved = readSettings(ws).providers.find((item) => item.id === 'openrouter')
    check('Salvar alterações: grava os 40 modelos e quais leem imagens', (saved.models || []).length === 40 && (saved.visionModels || []).length === 10, { models: (saved.models || []).length, vision: (saved.visionModels || []).length })
    check('Salvar alterações: grava o endereço e a referência ao cofre', saved.baseUrl === fake.baseUrl && saved.apiKeyRef === 'secret:openrouter', { ref: saved.apiKeyRef })
    await page.locator('button.btn.ghost', { hasText: /^Fechar$/ }).click()

    // The composer (no restart): the new provider and its models are there to select.
    await openModelMenu(page)
    const all = await menuState(page, 'fake/')
    check('seletor de modelo: o provedor novo aparece com os modelos detectados, sem reiniciar o app', all.text.filter((entry) => entry.startsWith('fake/')).length === 40 && all.headings.some((heading) => /OpenRouter/.test(heading)), { count: all.count, headings: all.headings })
    report.shotMenu = await shot(page, 'provedor-seletor-de-modelo')
    const noKey = await menuState(page, '')
    check('seletor de modelo: provedor sem chave aparece como "sem chave — configurar", sem modelos que falhariam', noKey.text.some((entry) => /Anthropic.*sem chave/.test(entry)) && !noKey.text.some((entry) => /^claude-sonnet/.test(entry)), noKey.text.filter((entry) => /sem chave/.test(entry)))

    await menuState(page, 'modelo-01')
    await page.locator('.model-menu', { hasText: 'fake/modelo-01' }).locator('text=fake/modelo-01').first().click()
    await page.waitForTimeout(600)
    const picked = await page.evaluate(async (id) => ({ ui: document.querySelector('.model-btn .model-short')?.textContent?.trim(), meta: (await window.forja.sessions.get(id)).value.meta }), session.sessionId)
    check('escolher o modelo novo no seletor muda a sessão (e o compositor mostra)', picked.ui === 'fake/modelo-01' && picked.meta.providerId === 'openrouter' && picked.meta.model === 'fake/modelo-01', picked)

    // "Nova conversa": the Home composer has the same list.
    await page.locator('.mode-switch button', { hasText: 'Chat' }).click().catch(() => undefined)
    await page.waitForTimeout(800)
    const home = await page.locator('.model-btn:has(.model-short)').count()
    if (home) {
      await page.locator('.model-btn:has(.model-short)').first().click()
      await page.waitForSelector('.model-menu')
      const homeMenu = await menuState(page, 'fake/')
      check('nova conversa: o seletor da tela inicial também lista o provedor novo', homeMenu.text.filter((entry) => entry.startsWith('fake/')).length === 40, homeMenu.count)
      await page.keyboard.press('Escape')
    } else {
      check('nova conversa: o seletor da tela inicial também lista o provedor novo', false, 'sem seletor na tela inicial')
    }

    // Closing and opening the app again: still there.
    try { execFileSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2500))
    app = await e2e.launch({ port: PORT + 1, ...ws })
    const again = await app.page.evaluate(async () => {
      const settings = (await window.forja.app.settings()).value
      const caps = (await window.forja.app.capabilities()).value
      const card = settings.providers.find((item) => item.id === 'openrouter')
      return { models: (card.models || []).length, configured: caps.providers.find((item) => item.id === 'openrouter')?.configured, ref: card.apiKeyRef }
    })
    check('depois de fechar e abrir o app: provedor, chave (cofre) e modelos continuam', again.models === 40 && again.configured === true && again.ref === 'secret:openrouter', again)
  } finally {
    report.errors = (app.errors || []).filter((line) => line.startsWith('pageerror'))
    app.cleanup()
    await fake.close().catch(() => undefined)
  }
  report.checks = checks
  const file = path.join(OUT, `${LABEL}-provedor-novo.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, file)}`)
  process.exit(ok() ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
