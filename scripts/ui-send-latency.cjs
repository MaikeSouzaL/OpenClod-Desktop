// End-to-end: pressing Enter takes the message at once (box empties, message lands in the session, turn runs).
//
// Background: "o harness trava depois que eu envio a mensagem". Before the first turn of a session the app used to
// copy every page of the project wiki into the AI-Memory sidecar and only then start the turn. That hang is
// pinned by tests/orchestrator-start-turn.test.ts (it fails on the old behaviour). THIS script cannot reproduce the
// slow sidecar of a real, old project (generated pages sync fast), so it guards the rest of the path in the real
// UI with a real model: the text box empties within 1 s and the message is saved within 8 s on a project with
// 80 memory pages.
//
//   node scripts/ui-send-latency.cjs [--pages 80]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const PAGES = Number(e2e.arg('pages', '80'))
const PORT = 9438

function wikiPage(index) {
  const slug = `pagina-de-teste-${String(index).padStart(3, '0')}`
  const now = new Date().toISOString()
  return {
    slug,
    text: [
      '---',
      `title: "Página de teste ${index}"`,
      `slug: ${slug}`,
      'tags: teste, latencia',
      'pinned: false',
      `created: ${now}`,
      `updated: ${now}`,
      'source: agent',
      'memory_type: fact',
      'confidence: observed',
      'status: active',
      '---',
      '',
      `Conteúdo da página ${index}. `.repeat(40)
    ].join('\n')
  }
}

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-latency-' })
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const checks = e2e.makeChecks ? e2e.makeChecks() : null
  const result = { pages: PAGES, checks: {} }
  const check = (name, ok, detail) => {
    result.checks[name] = ok ? 'ok' : `FALHOU${detail ? `: ${detail}` : ''}`
    if (!ok) result.failed = true
  }
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Latência', projectName: 'Projeto latência' })
    // The wiki of that project, filled BEFORE the first message (what a long-lived project looks like).
    const wiki = path.join(ws.profile, 'data', 'memory', 'projects', session.projectId, 'wiki')
    fs.mkdirSync(wiki, { recursive: true })
    for (let i = 1; i <= PAGES; i++) {
      const item = wikiPage(i)
      fs.writeFileSync(path.join(wiki, `${item.slug}.md`), item.text)
    }
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Latência', 'Projeto latência')

    const input = page.locator('textarea[aria-label="Mensagem"]')
    await input.fill('responda só com a palavra ok')
    const t0 = Date.now()
    await input.press('Enter')
    let emptiedAt = null
    let shownAt = null
    while (Date.now() - t0 < 60000 && (emptiedAt === null || shownAt === null)) {
      await page.waitForTimeout(100)
      if (emptiedAt === null && (await input.inputValue()) === '') emptiedAt = Date.now() - t0
      if (shownAt === null) {
        const count = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.messages.length, session.sessionId)
        if (count >= 1) shownAt = Date.now() - t0
      }
    }
    result.emptiedMs = emptiedAt
    result.messageSavedMs = shownAt
    check('campo-esvazia-em-ate-1s', emptiedAt !== null && emptiedAt <= 1000, `${emptiedAt} ms`)
    check('mensagem-entra-na-sessao-em-ate-8s', shownAt !== null && shownAt <= 8000, `${shownAt} ms`)
    const seen = await page.evaluate(() => /responda só com a palavra ok/.test(document.body.innerText))
    check('mensagem-aparece-na-tela', seen)
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: 120000 })
    check('o-turno-termina', true)
    check('sem-erros-de-pagina', app.errors.filter((line) => line.startsWith('pageerror')).length === 0, app.errors.join(' | '))
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
