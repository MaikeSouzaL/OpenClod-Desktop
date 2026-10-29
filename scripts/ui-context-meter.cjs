// The Contexto panel shows what the next request REALLY carries (measured by the session's runner), not fixed numbers.
//
//   node scripts/ui-context-meter.cjs [--root <snapshot folder>] [--out Prints/contexto-2026-10-27]
//
// 1. before the first turn the panel says it is an estimate;
// 2. after a turn (real model) the rows are the measured ones (system prompt, tool schemas, memory...), the IPC answer is
//    consistent with what the provider reported for the last request, and the old fixed figures are gone.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'contexto-2026-10-27')))
const PORT = Number(e2e.arg('port', '9444'))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-meter-' })
  fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Projeto de teste\n\n' + '- Regra do projeto: responda sempre em português.\n'.repeat(30))
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { checks: {} }
  const check = (name, ok, detail) => {
    result.checks[name] = ok ? 'ok' : `FALHOU${detail ? `: ${detail}` : ''}`
    if (!ok) result.failed = true
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` -> ${String(detail).slice(0, 200)}` : ''}`)
  }
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Medidor', projectName: 'Projeto medidor' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Medidor', 'Projeto medidor')

    const panelText = () => page.evaluate(() => (document.querySelector('.context-top')?.closest('.panel-card')?.textContent ?? '').replace(/\s+/g, ' '))
    await page.locator('button[aria-label="Painel lateral da sessão"]').click()
    await page.waitForSelector('.context-top', { timeout: 15000 })
    const before = await panelText()
    check('antes do primeiro turno o painel diz que é estimativa', /estimativa/.test(before), before.slice(0, 160))
    check('sem turno, a medição ainda não existe', (await page.evaluate(async (id) => (await window.openclod.sessions.contextBreakdown(id)).value, session.sessionId)) === null)

    await e2e.send(page, 'ola')
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: 180000 })
    await page.waitForFunction(() => !/estimativa/.test(document.querySelector('.context-top')?.closest('.panel-card')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => undefined)
    const after = await panelText()
    check('depois do turno o painel mostra a medição, sem o aviso de estimativa', !/estimativa/.test(after), after.slice(0, 200))
    for (const label of ['Instruções do sistema', 'Instruções do projeto (CLAUDE.md)', 'Skills (índice)', 'Ferramentas (schemas)']) {
      check(`a linha "${label}" aparece`, after.includes(label))
    }

    const measured = await page.evaluate(async (id) => (await window.openclod.sessions.contextBreakdown(id)).value, session.sessionId)
    const by = Object.fromEntries((measured?.items ?? []).map((item) => [item.id, item.tokens]))
    result.measured = measured
    check('o sistema real passa de 1 500 tokens (o número fixo antigo era 1 100)', by.system > 1500, by.system)
    check('os schemas das ferramentas são contados (o painel antigo não os mostrava)', by.tools > 2000, by.tools)
    check('as instruções do projeto são o tamanho do CLAUDE.md', by.instructions > 300 && by.instructions < 1200, by.instructions)
    const usage = await e2e.usageOf(page, session.sessionId)
    const reported = measured.lastRequest || 0
    check('o total medido está perto do que o provedor cobrou na última chamada (±25%)', reported > 0 && Math.abs(measured.total - reported) / reported < 0.25, `medido ${measured.total} · provedor ${reported}`)
    result.usage = usage
    await page.screenshot({ path: path.join(OUT, '01-painel-contexto-medido.png') })
    check('sem erros de página', app.errors.filter((line) => line.startsWith('pageerror')).length === 0, app.errors.join(' | '))
  } finally {
    app.cleanup()
  }
  fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(result, null, 2))
  process.exit(result.failed ? 1 : 0)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
