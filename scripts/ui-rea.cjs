// REA Engineering na janela real, com modelo real, REA embutido (resources/rea) e perfil descartável:
//   1. a opção "REA Engineering" aparece no menu + → Modo do agente e muda o modo da sessão;
//   2. um pedido de verdade: o modelo analisa com as ferramentas rea_* um app JavaScript/Electron de teste e um executável
//      do Windows (where.exe, copiado do System32) e responde citando a evidência do REA;
//   3. o resultado é conferido por fora: as chamadas rea_* deram certo e a resposta fala da função e do canal IPC que existem
//      no app de teste e de uma DLL que o where.exe importa de verdade;
//   4. uma ação que altera o sistema (anexar o Frida a um processo node de teste aberto pelo roteiro) pede aprovação humana
//      mesmo no modo Ignorar permissões; o roteiro nega e confere que o Frida não rodou.
//
//   node scripts/ui-rea.cjs --root <snapshot> --provider opencode-go --model deepseek-v4.1-flash [--out Prints/rea-engineering-<data>]
//        [--timeout 900]
//
// Os alvos são feitos aqui (app de teste) ou vêm do próprio Windows: nenhum dado do usuário.
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { arg, makeWorkspace, launch, newSession, openSession, send, toolActivity, failureOf, checkModel, makeChecks, outDir, PROVIDER } = require('./lib/e2e.cjs')

const OUT = outDir(path.join(__dirname, '..', 'Prints', `rea-engineering-${new Date().toISOString().slice(0, 10)}`))
const TIMEOUT_S = Number(arg('timeout', '900'))
const TITLE = 'REA E2E'

/** A small Electron-like app: the search feature lives in src/search.js and is exposed over IPC as notes:search. */
function writeJsApp(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-notes', version: '1.2.3', main: 'main.js' }, null, 2))
  fs.writeFileSync(
    path.join(dir, 'main.js'),
    [
      "const { app, BrowserWindow, ipcMain } = require('electron')",
      "const { searchNotes } = require('./src/search')",
      "ipcMain.handle('notes:search', async (_event, query) => searchNotes(query))",
      "app.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: __dirname + '/preload.js' } }).loadFile('index.html'))",
      ''
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(dir, 'src', 'search.js'),
    [
      'const NOTES = [{ id: 1, title: "Compras", body: "pão e café" }, { id: 2, title: "Ideias", body: "busca rápida" }]',
      'function normalize(text) { return text.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase() }',
      'function searchNotes(query) {',
      '  const wanted = normalize(String(query))',
      '  return NOTES.filter((note) => normalize(note.title + " " + note.body).includes(wanted)).map((note) => note.id)',
      '}',
      'module.exports = { searchNotes, normalize }',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(dir, 'preload.js'), "require('electron').contextBridge.exposeInMainWorld('notes', { search: (q) => require('electron').ipcRenderer.invoke('notes:search', q) })\n")
}

/** Keeps only the provider under test, in the unrestricted permission mode (the risky REA tools must ask anyway). */
function narrowProfile(profile) {
  const file = path.join(profile, 'config', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  settings.providers = settings.providers.filter((provider) => provider.id === PROVIDER())
  if (!settings.providers.length) throw new Error(`provedor ${PROVIDER()} não existe no perfil de origem`)
  settings.defaultProviderId = PROVIDER()
  // The user's own mode ("Ignorar permissões"): the strongest case, where only a tool marked "always ask" still asks.
  settings.policy = { ...settings.policy, mode: 'unrestricted' }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
}

async function state(page, sessionId) {
  return page.evaluate(async (id) => {
    const value = (await window.openclod.sessions.get(id)).value
    const last = value.messages[value.messages.length - 1]
    const answered = Boolean(last && last.role === 'assistant' && !last.parts.some((p) => p.type === 'tool_call') && last.parts.some((p) => p.type === 'text' && p.text.trim()))
    return { run: value.state, count: value.messages.length, answered, mode: value.meta.mode, approvals: value.approvals.map((a) => ({ id: a.id, tool: a.tool, risk: a.risk, title: a.title })) }
  }, sessionId)
}

/** Waits for the turn to settle; approvals for `deny` tools (or all, with denyAll) are refused, and recorded, as they appear. */
async function runTurn(page, sessionId, { deny = [], denyAll = false, seen = [], onApproval } = {}) {
  const started = Date.now()
  let previous = ''
  while (Date.now() - started < TIMEOUT_S * 1000) {
    await page.waitForTimeout(2000)
    const current = await state(page, sessionId)
    for (const approval of current.approvals) {
      if (seen.some((item) => item.id === approval.id)) continue
      seen.push(approval)
      if (onApproval) await onApproval(approval)
      const refuse = denyAll || deny.some((name) => approval.tool === name)
      await page.evaluate(({ id, ok }) => window.openclod.approvals.resolve(id, ok, false, ok ? undefined : 'negado pelo roteiro E2E'), { id: approval.id, ok: !refuse })
    }
    const signature = `${current.run}:${current.count}`
    const settled = ['idle', 'done', 'error', 'cancelled'].includes(current.run) && (current.answered || current.run === 'error') && !current.approvals.length
    if (settled && signature === previous) return current
    previous = signature
  }
  throw new Error(`o turno não terminou em ${TIMEOUT_S}s`)
}

async function finalText(page, sessionId, from) {
  // Every assistant text of the turn: the answer may be followed by the self-review of the diff ("o arquivo temporário
  // foi removido"), which is the last message but not the answer.
  return page.evaluate(async ({ id, from }) => {
    const value = (await window.openclod.sessions.get(id)).value
    return value.messages
      .slice(from)
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text))
      .join('\n')
  }, { id: sessionId, from })
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = makeWorkspace({ real: true, prefix: 'openclod-rea-' })
  narrowProfile(ws.profile)
  const jsApp = path.join(ws.project, 'demo-notes')
  writeJsApp(jsApp)
  const exe = path.join(ws.project, 'where.exe')
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), exe)
  // A harmless process of our own for the runtime step: Frida may only touch it after a human says yes.
  const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })

  const { check, checks, ok } = makeChecks()
  const app = await launch({ port: 9437, profile: ws.profile, work: ws.work })
  const { page, errors } = app
  const report = { provider: PROVIDER(), model: arg('model', ''), targets: { jsApp, exe } }
  const shot = (name) => page.screenshot({ path: path.join(OUT, name), timeout: 60000 }).catch(() => undefined)
  const started = Date.now()
  try {
    const session = await newSession(page, { folder: ws.project, title: TITLE, projectName: 'Engenharia reversa', mode: 'code', providerId: PROVIDER() })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await openSession(page, TITLE, 'Engenharia reversa')

    // 1. The option in the composer's mode menu.
    await page.locator('button[title="Adicionar arquivo ou imagem"]').click()
    const option = page.locator('.attach-menu [role="menuitem"]', { hasText: 'REA Engineering' })
    check('opção "REA Engineering" no menu Modo do agente', (await option.count()) === 1)
    await option.hover()
    await shot('01-menu-modo-do-agente.png')
    await option.click()
    await page.waitForTimeout(600)
    const before = await state(page, session.sessionId)
    check('a sessão passa para o modo rea', before.mode === 'rea', before.mode)

    // 2. A real analysis.
    const task = [
      `Use o REA para analisar o app JavaScript/Electron em ${jsApp}: qual função implementa a busca de notas e por qual canal IPC ela é chamada?`,
      `Depois abra o executável ${exe} e diga três DLLs que ele importa.`,
      'Cite os ids de evidência (ev_...) que sustentam cada resposta.'
    ].join(' ')
    await send(page, task)
    await page.waitForTimeout(4000)
    await shot('02-analise-em-andamento.png')
    const first = await runTurn(page, session.sessionId)
    await shot('03-analise-concluida.png')
    report.firstSeconds = Math.round((Date.now() - started) / 1000)
    if (first.run === 'error') report.failure = await failureOf(page, session.sessionId)
    check('o turno de análise terminou com resposta do modelo', first.run !== 'error', report.failure)

    const activity = await toolActivity(page, session.sessionId)
    const reaCalls = activity.calls.filter((call) => call.name.startsWith('rea_'))
    const reaResults = activity.results.filter((result) => result.name.startsWith('rea_'))
    report.reaCalls = reaCalls.map((call) => call.name)
    report.reaResults = reaResults.map((result) => ({ name: result.name, ok: result.ok, chars: result.text.length }))
    const okResult = (pattern) => reaResults.some((result) => pattern.test(result.name) && result.ok)
    check('o modelo usou ferramentas do REA', reaCalls.length > 0, report.reaCalls)
    check('análise do app JavaScript pelo REA deu certo', okResult(/rea_analyze_javascript_application|rea_analyze_web_bundle|rea_inspect_artifact/), report.reaResults)
    check('análise do executável pelo REA deu certo', okResult(/rea_inspect_pe_imports|rea_open_binary|rea_binary_overview/) && reaResults.some((r) => r.ok && /where\.exe/.test(r.text)), report.reaResults)
    check('o resultado do REA chega marcado como dado do alvo', reaResults.some((r) => r.text.includes('[Resultado do REA')))
    // A result too long for the context is spilled whole by the runner: no cut made by the MCP client inside it.
    check('nenhum resultado do REA foi cortado pelo cliente MCP', !reaResults.some((r) => /caracteres omitidos: a saída tinha/.test(r.text)), report.reaResults)

    const answer = await finalText(page, session.sessionId, 0)
    report.answer = answer.slice(0, 3000)
    check('a resposta aponta a função searchNotes', /searchNotes/.test(answer), answer.slice(0, 300))
    check('a resposta aponta o canal notes:search', /notes:search/.test(answer), answer.slice(0, 300))
    check('a resposta cita DLL importada de verdade', /kernel32|msvcrt|api-ms-win|ntdll|advapi32|user32/i.test(answer), answer.slice(0, 300))
    check('a resposta cita evidência do REA', /ev_[0-9a-f]{8,}/.test(answer), answer.slice(0, 300))
    const model = await checkModel(page, session)
    check('a sessão terminou no modelo escolhido', model.ok, model)

    // 4. Touching a running process asks a human, even in the unrestricted mode; the script refuses every request.
    const count = first.count
    const seen = []
    await send(
      page,
      `Agora quero observar em execução: use rea_start_frida_session com mode "attach", device_id "local" e pid ${target.pid} (um processo node de teste que eu abri). Não use outra ferramenta para isso; eu decido na aprovação.`
    )
    const fridaTool = /^rea_(start_frida_session|instrument_with_frida|load_frida_script|resume_frida_session)$/
    const second = await runTurn(page, session.sessionId, {
      denyAll: true,
      seen,
      onApproval: async (approval) => {
        if (fridaTool.test(approval.tool)) await shot('04-aprovacao-frida.png')
      }
    })
    report.approvals = seen
    const asked = seen.find((approval) => fridaTool.test(approval.tool))
    check('anexar o Frida a um processo pede aprovação humana mesmo em Ignorar permissões', Boolean(asked), seen)
    check('a aprovação é de risco destrutivo', asked?.risk === 'destructive', asked)
    const after = await toolActivity(page, session.sessionId, count)
    const fridaResults = after.results.filter((result) => fridaTool.test(result.name))
    report.fridaResults = fridaResults.map((result) => ({ name: result.name, ok: result.ok, text: result.text.slice(0, 300) }))
    check('negado, o Frida não rodou', fridaResults.length > 0 && fridaResults.every((result) => result.ok === false), report.fridaResults)
    check('o processo de teste continua vivo e intocado', target.exitCode === null && !target.killed)
    check('o segundo turno terminou', second.run !== 'error', await failureOf(page, session.sessionId))
    await shot('05-depois-da-negacao.png')

    check('sem erros no console da janela', errors.length === 0, errors.slice(0, 3))
  } catch (err) {
    check('o roteiro rodou até o fim', false, err.message)
    await shot('erro.png')
  } finally {
    report.checks = checks
    report.seconds = Math.round((Date.now() - started) / 1000)
    fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(report, null, 2))
    console.log(`\n${ok() ? 'PASSOU' : 'FALHOU'} · ${Object.values(checks).filter((value) => value === 'ok').length}/${Object.keys(checks).length} checagens · ${report.seconds}s · ${OUT}`)
    try {
      target.kill()
    } catch {}
    app.cleanup()
    process.exit(ok() ? 0 : 1)
  }
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
