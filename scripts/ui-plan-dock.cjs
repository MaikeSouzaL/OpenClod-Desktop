// End-to-end dos botões do Plano depois de Parar, no app de verdade (Electron, perfil descartável: o app e o perfil do usuário não
// são tocados). Semeia duas sessões com um plano parado no meio (o app reabre e marca o passo como interrompido) e confere:
//   ▶ na frente do passo que estava rodando: só nele, e o clique manda "Continue a partir do passo: …" e começa o turno;
//   🗑 no cabeçalho: dois cliques (o primeiro arma e desarma sozinho), some o dock e apaga a cápsula de continuidade da
//   sessão no disco, deixando a nota oculta <plano-descartado> no histórico. (A fila esvaziada está em tests/plan-control.)
// Não precisa de modelo: o turno do ▶ pode falhar depois de começar (provedor local sem o modelo), o que conta é o pedido.
//
//   node scripts/ui-plan-dock.cjs [--root <snapshot>] [--out dir] [--label nome]
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'plano')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'plano-dock-2026-10-29')))
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()
const PROJECT = 'Plano E2E'

const shot = async (page, name) => {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

const plan = (active) => [
  { id: 'p1', text: 'Ler o código do módulo', status: 'done', startedAt: Date.now() - 90_000, endedAt: Date.now() - 60_000 },
  { id: 'p2', text: active, status: 'active', startedAt: Date.now() - 60_000 },
  { id: 'p3', text: 'Rodar os testes', status: 'pending' }
]

function capsule(sessionId, title) {
  const now = new Date().toISOString()
  return [
    '---',
    `title: ${JSON.stringify(`Estado: ${title}`)}`,
    `slug: estado-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    'tags: estado, interrompido',
    'pinned: false',
    `created: ${now}`,
    `updated: ${now}`,
    'source: auto',
    'memory_type: pending',
    'confidence: observed',
    'status: active',
    'evidence: []',
    `context: ${JSON.stringify(`sessao:${sessionId}`)}`,
    'conflicts_with: []',
    '---',
    '',
    '**Situação:** interrompido',
    '',
    '## Próximo passo',
    'Publicar a versão',
    ''
  ].join('\n')
}

function stop(app) {
  try { app.browser.close() } catch {}
  try { execFileSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
}

async function main() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-plandock-' })
  const report = { label: LABEL, startedAt: new Date().toISOString() }
  let app = null
  try {
    /* ---- 0. two sessions, then the app closes in the middle of their plans ---- */
    app = await e2e.launch({ port: 9487, ...ws })
    const created = await app.page.evaluate(async ({ folder, name }) => {
      const project = await window.openclod.projects.add(folder, name)
      if (!project.ok) return { error: project.error }
      const make = async (title) => {
        const session = await window.openclod.sessions.create({ projectId: project.value.id, cwd: folder, mode: 'code', surface: 'code', providerId: 'ollama', model: 'modelo-que-nao-existe', title })
        return session.ok ? session.value.id : null
      }
      return { projectId: project.value.id, resume: await make('Retomar migração'), discard: await make('Descartar publicação') }
    }, { folder: ws.project, name: PROJECT })
    if (created.error || !created.resume || !created.discard) throw new Error(created.error || 'sessões não criadas')
    stop(app)
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const sessionFile = (id) => path.join(ws.profile, 'data', 'sessions', `${id}.json`)
    for (const [id, step] of [[created.resume, 'Migrar o banco'], [created.discard, 'Publicar a versão']]) {
      const state = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'))
      state.plan = plan(step)
      state.state = 'tool'
      fs.writeFileSync(sessionFile(id), JSON.stringify(state, null, 2))
    }
    const wiki = path.join(ws.profile, 'data', 'memory', 'projects', created.projectId, 'wiki')
    fs.mkdirSync(wiki, { recursive: true })
    const capsuleFile = path.join(wiki, 'estado-descartar-publicacao.md')
    fs.writeFileSync(capsuleFile, capsule(created.discard, 'Descartar publicacao'))

    app = await e2e.launch({ port: 9487, ...ws })
    const { page } = app

    /* ---- 1. ▶ resumes from the step that stopped ---- */
    await e2e.openSession(page, 'Retomar migração', PROJECT)
    await page.waitForSelector('.plan-dock', { timeout: 20000 })
    const resumeButtons = page.locator('.plan-dock-resume')
    check('o ▶ aparece só na frente do passo que estava rodando', (await resumeButtons.count()) === 1 && /Migrar o banco/.test((await page.locator('.plan-dock-entry.has-resume').textContent()) || ''), await resumeButtons.count())
    check('o passo parado aparece como interrompido', (await page.locator('.plan-dock-item.is-interrupted').count()) === 1)
    check('a lixeira aparece no cabeçalho do plano', (await page.locator('.plan-dock-discard').count()) === 1)
    report.shotStopped = await shot(page, '01-plano-parado')
    await resumeButtons.first().click()
    await page.waitForFunction(() => /Continue a partir do passo: Migrar o banco/.test(document.querySelector('.thread')?.textContent || document.body.textContent || ''), null, { timeout: 20000 })
    check('o ▶ manda "Continue a partir do passo: Migrar o banco" na conversa', true)
    report.shotResumed = await shot(page, '02-retomado')
    const resumed = await page.evaluate((id) => window.openclod.sessions.get(id), created.resume)
    const userTexts = (resumed.value?.messages || []).filter((m) => m.role === 'user' && !m.hidden).map((m) => m.parts.map((p) => p.text || '').join(' '))
    check('a mensagem de retomada foi gravada na sessão como pedido do usuário', userTexts.some((t) => t.includes('Continue a partir do passo: Migrar o banco')), userTexts)
    const hiddenTexts = (resumed.value?.messages || []).filter((m) => m.hidden).map((m) => m.parts.map((p) => p.text || '').join(' '))
    check('o turno recebeu o aviso <retomada> com o passo', hiddenTexts.some((t) => t.includes('<retomada>') && t.includes('Migrar o banco')), hiddenTexts.map((t) => t.slice(0, 80)))

    /* ---- 2. 🗑 discards for good, in two clicks ---- */
    await e2e.openSession(page, 'Descartar publicação', PROJECT)
    await page.waitForSelector('.plan-dock-discard', { timeout: 20000 })
    const discard = page.locator('.plan-dock-discard')
    await discard.click()
    check('o primeiro clique só arma: pede "Descartar de vez?" e nada some', /Descartar de vez\?/.test((await discard.textContent()) || '') && (await page.locator('.plan-dock').count()) === 1 && fs.existsSync(capsuleFile))
    report.shotArmed = await shot(page, '03-lixeira-armada')
    await page.waitForFunction(() => !/Descartar de vez/.test(document.querySelector('.plan-dock-discard')?.textContent || ''), null, { timeout: 8000 })
    check('sem o segundo clique, a lixeira desarma sozinha em alguns segundos', fs.existsSync(capsuleFile))
    await discard.click()
    await discard.click()
    await page.waitForFunction(() => !document.querySelector('.plan-dock'), null, { timeout: 20000 })
    check('o segundo clique descarta: o dock do plano some', true)
    report.shotAfter = await shot(page, '04-descartado')
    const after = JSON.parse(fs.readFileSync(sessionFile(created.discard), 'utf8'))
    const last = after.messages[after.messages.length - 1]
    check('o plano gravado da sessão ficou vazio', Array.isArray(after.plan) && after.plan.length === 0, after.plan)
    check('o histórico ganhou a nota oculta <plano-descartado>', Boolean(last && last.hidden && JSON.stringify(last.parts).includes('<plano-descartado>')))
    check('a cápsula de continuidade da sessão foi apagada do disco', !fs.existsSync(capsuleFile))
    const toast = (await page.textContent('body')) || ''
    check('o app avisa que o plano foi descartado e apagado da memória', /Plano descartado e apagado da memória da sessão/.test(toast))
    // Nothing starts again: no new turn, no message from the user, a while after the discard.
    await page.waitForTimeout(2_500)
    const settled = await page.evaluate((id) => window.openclod.sessions.get(id), created.discard)
    check('depois de descartar nada recomeça (nenhum pedido novo na sessão)', (settled.value?.messages || []).filter((m) => m.role === 'user' && !m.hidden).length === 0 && !(settled.value?.plan || []).length)
  } finally {
    report.errors = ((app && app.errors) || []).filter((line) => line.startsWith('pageerror'))
    if (app) app.cleanup()
  }
  report.checks = checks
  const file = path.join(OUT, `${LABEL}-ui-plan-dock.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, file)}`)
  process.exit(ok() && !report.errors.length ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
