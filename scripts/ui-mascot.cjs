// End-to-end: the desktop mascot follows what the agent is REALLY going through.
// Real model (DeepSeek by default). The overlay windows of the app are real BrowserWindows; their pages show up
// in the same CDP connection, so the script samples `body[data-mood]` and the label while the agent works.
//
//   node scripts/ui-mascot.cjs [--out Prints/mascote-2026-10-27]
//
// Turn 1: the model opens a real page with browser_open  -> a working/curious mood while it runs, "happy" at the end.
// Turn 2: three URLs that cannot exist, one after another -> consecutive failures: confused, then struggling.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'mascote-2026-10-27')))
const PORT = 9423

/** The primary overlay page (the one that has the mascot), or null while the overlay was never shown. */
async function overlayState(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!page.url().startsWith('data:text/html')) continue
      const state = await page
        .evaluate(() => {
          if (!document.body.classList.contains('primary')) return null
          return {
            mood: document.body.dataset.mood || 'calm',
            difficulty: document.body.dataset.difficulty || '0',
            label: document.querySelector('.tag-text')?.textContent?.trim() || ''
          }
        })
        .catch(() => null)
      if (state) return { ...state, page }
    }
  }
  return null
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-mascot-' })
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { checks: {}, observed: [], labels: {} }
  const check = (name, ok, detail) => {
    result.checks[name] = ok ? 'ok' : `FALHOU${detail ? `: ${detail}` : ''}`
    if (!ok) result.failed = true
  }

  // Samples the mascot every 250 ms in the background for the whole run.
  const seen = new Map() // mood -> first label shown with it
  let sampling = true
  let lastShot = ''
  const sampler = (async () => {
    while (sampling) {
      const state = await overlayState(app.browser)
      if (state) {
        if (!seen.has(state.mood)) {
          seen.set(state.mood, state.label)
          result.observed.push({ at: Date.now(), mood: state.mood, label: state.label })
          if (['struggling', 'confused', 'happy', 'overwhelmed'].includes(state.mood) && lastShot !== state.mood) {
            lastShot = state.mood
            // The overlay window covers a whole monitor; capture only the mascot (face + label).
            await state.page
              .locator('.mascot')
              .screenshot({ path: path.join(OUT, `app-real-${state.mood}.png`), omitBackground: true })
              .catch(() => undefined)
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()

  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Mascote', projectName: 'Projeto mascote' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Mascote', 'Projeto mascote')

    // ---- Turn 1: a real page opens, the turn succeeds ----
    await e2e.send(page, 'Use a ferramenta browser_open para abrir https://example.com e me diga o título da página.')
    const first = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000 })
    await new Promise((resolve) => setTimeout(resolve, 4200)) // the happy reaction lingers ~3 s after the turn
    check('overlay-apareceu', seen.size > 0, 'nenhuma janela de overlay encontrada')
    check('humor-de-trabalho-durante-o-turno', ['working', 'curious', 'thinking'].some((mood) => seen.has(mood)), [...seen.keys()].join(','))
    check('comemora-ao-terminar-o-turno', seen.has('happy'), [...seen.keys()].join(','))

    // ---- Turn 2: consecutive failures ----
    const before = first.count
    await e2e.send(
      page,
      'Chame browser_open, uma de cada vez e sem pular nenhuma, para estas três URLs e relate o resultado de cada uma: ' +
        'https://nao-existe-openclod-1.invalid/ , depois https://nao-existe-openclod-2.invalid/ , depois https://nao-existe-openclod-3.invalid/'
    )
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: 300000, sinceCount: before })
    await new Promise((resolve) => setTimeout(resolve, 4200))
    const report = await e2e.turnReport(page, session.sessionId, before)
    const failed = report.results.filter((item) => item.name === 'browser_open' && item.ok === false).length
    result.failedOpens = failed
    // With real model + real network the number of failures is what it is: judge the mascot by it.
    if (failed >= 2) check('dificuldade-aparece-apos-falhas-seguidas', seen.has('struggling') || seen.has('overwhelmed'), `${failed} falhas, humores: ${[...seen.keys()].join(',')}`)
    else if (failed === 1) check('dificuldade-aparece-apos-uma-falha', seen.has('confused'), `humores: ${[...seen.keys()].join(',')}`)
    else check('o-modelo-tentou-abrir-urls-invalidas', false, `browser_open com falha: ${failed}`)
    check('rotulo-explica-a-dificuldade', [...seen.entries()].some(([mood, label]) => ['confused', 'struggling', 'overwhelmed'].includes(mood) && /falha|difícil|esperado/i.test(label)), JSON.stringify([...seen.entries()]))
    result.labels = Object.fromEntries(seen)
    check('sem-erros-de-pagina', app.errors.filter((line) => line.startsWith('pageerror')).length === 0, app.errors.join(' | '))
  } finally {
    sampling = false
    await sampler.catch(() => undefined)
    app.cleanup()
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.failed ? 1 : 0)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
