// Loop Engineering na janela real, com modelo real e perfil descartável:
//   1. a opção "Código Loop Engineering" aparece no menu + → Modo do agente e muda o modo da sessão;
//   2. o painel do loop explica o modo antes do pedido;
//   3. um pedido de verdade (corrigir uma função e criar um CLI com testes) roda em voltas: critérios com comando,
//      especialistas chamados com `agent`, o juiz (loop-judge) e o veredito, até o harness aceitar PRONTO;
//   4. o resultado é conferido por fora (node --test e o CLI rodados por este script, não pelo modelo);
//   5. Configurações → Harness mostra o orçamento do loop.
//
//   node scripts/ui-loop.cjs --root <snapshot> --provider opencode-go --model deepseek-v4.1-flash [--out Prints/loop-engineering-<data>]
//        [--rounds 6] [--minutes 40] [--timeout 2400]
//
// Só o provedor escolhido fica no perfil descartável: os especialistas com `model: best` (o juiz, o app-prover) vão para
// o mesmo modelo, e uma conta sem saldo de outro provedor não decide o resultado.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { arg, makeWorkspace, launch, newSession, openSession, send, toolActivity, failureOf, checkModel, makeChecks, outDir, PROVIDER } = require('./lib/e2e.cjs')

const OUT = outDir(path.join(__dirname, '..', 'Prints', `loop-engineering-${new Date().toISOString().slice(0, 10)}`))
const ROUNDS = Number(arg('rounds', '6'))
const MINUTES = Number(arg('minutes', '40'))
const TIMEOUT_S = Number(arg('timeout', '2400'))
const TITLE = 'Loop E2E'

const TASK = [
  'Neste projeto a função soma (soma.js) está errada e os testes falham.',
  'Corrija a soma e crie um CLI cli.js: `node cli.js 2 3` deve imprimir 5, e `node cli.js` sem os dois números deve imprimir uma mensagem de uso e sair com código 1.',
  'Acrescente testes para o CLI no mesmo estilo (node:test). Trabalhe em voltas até o juiz provar que está tudo pronto.'
].join(' ')

/** A tiny project with a real bug and a real test suite (node:test, no dependencies). */
function writeFixture(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'calculadora', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2))
  fs.writeFileSync(path.join(dir, 'soma.js'), "// Soma dois números.\nmodule.exports = function soma(a, b) {\n  return a - b\n}\n")
  fs.writeFileSync(
    path.join(dir, 'soma.test.js'),
    "const test = require('node:test')\nconst assert = require('node:assert')\nconst soma = require('./soma')\n\ntest('soma dois positivos', () => {\n  assert.strictEqual(soma(2, 3), 5)\n})\n\ntest('soma com negativo', () => {\n  assert.strictEqual(soma(-1, 4), 3)\n})\n"
  )
}

/** Keeps only the provider under test in the throwaway profile, with the loop budget of this run. */
function narrowProfile(profile) {
  const file = path.join(profile, 'config', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  settings.providers = settings.providers.filter((provider) => provider.id === PROVIDER())
  if (!settings.providers.length) throw new Error(`provedor ${PROVIDER()} não existe no perfil de origem`)
  settings.defaultProviderId = PROVIDER()
  settings.loopBudget = { rounds: ROUNDS, minutes: MINUTES }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
}

async function snapshot(page, sessionId) {
  return page.evaluate(async (id) => {
    const value = (await window.openclod.sessions.get(id)).value
    const last = value.messages[value.messages.length - 1]
    const answered = Boolean(last && last.role === 'assistant' && !last.parts.some((p) => p.type === 'tool_call') && last.parts.some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'limitation'))
    return { run: value.state, count: value.messages.length, answered, loop: value.loop ?? null, mode: value.meta.mode }
  }, sessionId)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = makeWorkspace({ real: true, prefix: 'openclod-loop-' })
  narrowProfile(ws.profile)
  writeFixture(ws.project)
  const { check, checks, ok } = makeChecks()
  const app = await launch({ port: 9433, profile: ws.profile, work: ws.work })
  const { page, errors } = app
  const report = { provider: PROVIDER(), model: arg('model', ''), task: TASK, budget: { rounds: ROUNDS, minutes: MINUTES }, slowShots: [] }
  // A print waits for the next frame of the window; one that takes long is recorded (and retried once), not taken as a failure
  // of the loop. A window that never paints again fails the run.
  const shot = async (name) => {
    const begin = Date.now()
    try {
      await page.screenshot({ path: path.join(OUT, name), timeout: 60000 })
    } catch {
      await page.screenshot({ path: path.join(OUT, name), timeout: 60000 })
    }
    const ms = Date.now() - begin
    if (ms > 5000) report.slowShots.push({ name, ms })
  }
  const started = Date.now()
  try {
    const session = await newSession(page, { folder: ws.project, title: TITLE, projectName: 'Calculadora', mode: 'code', providerId: PROVIDER() })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await openSession(page, TITLE, 'Calculadora')

    // 1. The option in the composer's mode menu.
    await page.locator('button[title="Adicionar arquivo ou imagem"]').click()
    const option = page.locator('.attach-menu [role="menuitem"]', { hasText: 'Código Loop Engineering' })
    check('opção "Código Loop Engineering" no menu Modo do agente', (await option.count()) === 1)
    await option.hover()
    await shot('01-menu-modo-do-agente.png')
    await option.click()
    await page.waitForTimeout(600)
    const before = await snapshot(page, session.sessionId)
    check('a sessão passa para o modo loop', before.mode === 'loop', before.mode)

    // 2. The dock explains the mode before the first message.
    const idle = page.locator('.loop-dock .loop-dock-card.is-idle')
    check('painel do loop aparece antes do pedido', await idle.isVisible(), await page.locator('.loop-dock').innerText().catch(() => ''))
    check('o painel mostra o orçamento', (await idle.innerText()).includes(`até ${ROUNDS} voltas ou ${MINUTES} min`))
    await shot('02-painel-antes-do-pedido.png')

    // 3. The real task, in rounds.
    await send(page, TASK)
    const shots = new Set()
    let previous = ''
    let final = null
    while (Date.now() - started < TIMEOUT_S * 1000) {
      await page.waitForTimeout(3000)
      const state = await snapshot(page, session.sessionId)
      const loop = state.loop
      if (loop?.criteria?.length && !shots.has('criterios')) {
        shots.add('criterios')
        await shot('03-criterios-definidos.png')
      }
      if (loop && ['verificar', 'criticar', 'julgar'].includes(loop.phase) && !shots.has(`fase-${loop.round}`)) {
        shots.add(`fase-${loop.round}`)
        await shot(`04-volta-${loop.round}-${loop.phase}.png`)
      }
      const signature = `${state.run}:${state.count}:${loop?.status}`
      const settled = ['idle', 'done', 'error', 'cancelled'].includes(state.run) && state.answered && loop?.status !== 'running'
      if (settled && signature === previous) {
        final = state
        break
      }
      previous = signature
    }
    report.seconds = Math.round((Date.now() - started) / 1000)
    if (!final) throw new Error(`o loop não terminou em ${TIMEOUT_S}s`)
    await page.waitForTimeout(800)
    await shot('05-loop-concluido.png')

    const loop = final.loop
    report.loop = loop
    if (final.run === 'error') report.failure = await failureOf(page, session.sessionId)
    const activity = await toolActivity(page, session.sessionId)
    const agents = activity.calls.filter((call) => call.name === 'agent').map((call) => call.args?.agent)
    const loopCalls = activity.calls.filter((call) => call.name === 'loop').map((call) => call.args?.action)
    report.agents = agents
    report.loopCalls = loopCalls
    report.toolCalls = activity.calls.length

    check('o turno terminou com resposta do modelo', final.run !== 'error', report.failure)
    const model = await checkModel(page, session)
    check('a sessão terminou no modelo escolhido', model.ok, model)
    check('critérios de pronto definidos pela ferramenta loop', loopCalls.includes('define') && (loop?.criteria?.length ?? 0) > 0, loopCalls)
    check('ao menos um critério tem comando que o harness roda', (loop?.criteria ?? []).some((criterion) => criterion.check), loop?.criteria)
    check('especialistas chamados com agent (além do juiz)', agents.some((name) => name && name !== 'loop-judge'), agents)
    check('o juiz loop-judge foi chamado', agents.includes('loop-judge'), agents)
    // The request asks for new tests: they are written by the tester, not by whoever wrote the code.
    check('o tester escreveu os testes novos', agents.includes('tester'), agents)
    check('o veredito foi registrado com loop action=verdict', loopCalls.includes('verdict'), loopCalls)
    check('o loop terminou PRONTO', loop?.status === 'done', { status: loop?.status, reason: loop?.reason })
    check('todos os critérios provados', (loop?.criteria ?? []).every((criterion) => criterion.status === 'met'), (loop?.criteria ?? []).map((c) => `${c.id}:${c.status}`))
    check('o último veredito é PRONTO', loop?.verdicts?.at(-1)?.decision === 'done', loop?.verdicts)

    // 4. Independent proof, run by this script in the project folder.
    const tests = spawnSync('node', ['--test'], { cwd: ws.project, encoding: 'utf8', timeout: 120000 })
    report.independentTests = { status: tests.status, tail: `${tests.stdout}${tests.stderr}`.split(/\r?\n/).filter(Boolean).slice(-8) }
    check('prova independente: node --test passa', tests.status === 0, report.independentTests.tail.join(' | '))
    const sum = spawnSync('node', ['cli.js', '2', '3'], { cwd: ws.project, encoding: 'utf8', timeout: 30000 })
    check('prova independente: node cli.js 2 3 imprime 5', sum.status === 0 && sum.stdout.trim() === '5', { status: sum.status, out: sum.stdout.trim(), err: sum.stderr.trim().slice(0, 200) })
    const usage = spawnSync('node', ['cli.js'], { cwd: ws.project, encoding: 'utf8', timeout: 30000 })
    check('prova independente: node cli.js sem números sai com código 1', usage.status === 1, { status: usage.status, out: `${usage.stdout}${usage.stderr}`.trim().slice(0, 200) })
    report.files = fs.readdirSync(ws.project).filter((name) => !name.startsWith('.'))

    const badge = await page.locator('.loop-dock-badge').innerText().catch(() => '')
    check('o painel mostra Concluído', badge === 'Concluído', badge)

    // 5. The budget in Configurações → Harness.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav button', { hasText: 'Harness' }).click()
    const heading = page.locator('h3', { hasText: 'Loop Engineering' })
    await heading.scrollIntoViewIfNeeded()
    const rounds = await page.locator('label.field', { hasText: 'Voltas por pedido' }).locator('input').inputValue()
    check('Configurações → Harness mostra o orçamento do loop', rounds === String(ROUNDS), rounds)
    await shot('06-configuracoes-harness.png')
    await page.keyboard.press('Escape')

    check('sem erros no console da janela', errors.length === 0, errors.slice(0, 3))
  } catch (err) {
    check('o roteiro rodou até o fim', false, err.message)
    await shot('erro.png').catch(() => undefined)
  } finally {
    report.checks = checks
    report.seconds = report.seconds ?? Math.round((Date.now() - started) / 1000)
    fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(report, null, 2))
    console.log(`\n${ok() ? 'PASSOU' : 'FALHOU'} · ${Object.values(checks).filter((value) => value === 'ok').length}/${Object.keys(checks).length} checagens · ${report.seconds}s · ${OUT}`)
    app.cleanup()
    process.exit(ok() ? 0 : 1)
  }
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
