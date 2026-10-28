// End-to-end regression check for behaviours found by the 2026-10-27 audit, with a REAL model
// (DeepSeek by default; only the key vault is borrowed from the real profile) on a throwaway profile:
//   1. the window opens quickly even when a configured MCP server never answers its handshake (a hanging stdio
//      server stands in for the user's real ones, which the sanitized profile does not start);
//   2. changing model/effort while a turn runs does not cancel the turn;
//   3. an approval still waiting survives switching to another session and back;
//   4. the artifact studio preview is not squeezed to the gallery thumbnail's 110 px;
//   5. a project slash command (.claude/commands/revisar.md) shows in the menu and expands on send.
// Three short real turns (one per session). Checks are structural: tool calls/results, files on disk, the
// expanded user message and the DOM; never the model's wording.
//
//   node scripts/ui-session-flows.cjs [outDir] [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'tmp', 'ui-session-flows'))
const PORT = 9396
const PROJECT = 'Projeto de fluxos'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const markerName = `openclod-mcp-pendurado-${process.pid}.txt`
  const ws = e2e.makeWorkspace({
    real: true,
    prefix: 'openclod-flows-',
    settingsPatch: {
      // A stdio MCP server that starts (and leaves a marker file proving it) but never answers initialize; a 60 s
      // handshake budget makes a start-up that waits for it impossible to miss against the 20 s window threshold.
      mcpServers: [{
        name: 'mcp-pendurado',
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(process.argv[1],String(Date.now()));setInterval(()=>{},1000)`, path.join(os.tmpdir(), markerName)],
        enabled: true,
        startTimeoutMs: 60000
      }]
    }
  })
  const marker = path.join(os.tmpdir(), markerName)
  fs.rmSync(marker, { force: true })
  fs.writeFileSync(path.join(ws.project, 'README.md'), '# Projeto\n')
  fs.mkdirSync(path.join(ws.project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(ws.project, 'src', 'a.ts'), 'export const soma = (a: number, b: number) => a + b\n')
  fs.mkdirSync(path.join(ws.project, '.claude', 'commands'), { recursive: true })
  fs.writeFileSync(
    path.join(ws.project, '.claude', 'commands', 'revisar.md'),
    '---\ndescription: Revisa um arquivo\nargument-hint: <arquivo>\n---\nRevise $ARGUMENTS e liste os problemas.\n'
  )

  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const results = { checks, windowReadyMs: app.windowReadyMs, turns: {}, usage: {}, errors: [] }
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
  try {
    check('janela-abre-em-menos-de-20s-com-mcp-pendurado', app.windowReadyMs < 20000, `${app.windowReadyMs} ms`)
    // The window must not wait for the server, but the server must really have been started (else the check above is empty).
    for (let i = 0; i < 80 && !fs.existsSync(marker); i++) await page.waitForTimeout(250)
    check('servidor-mcp-pendurado-foi-iniciado-pelo-app', fs.existsSync(marker), fs.existsSync(marker) ? 'marcador gravado' : 'o app não iniciou o servidor MCP configurado')

    const make = (title) => e2e.newSession(page, { folder: ws.project, title, projectName: PROJECT })
    const sessionB = await make('Sessão B')
    const sessionA = await make('Sessão A')
    const sessionX = await make('Sessão X')
    results.model = `${sessionB.provider}/${sessionB.model}`
    await page.reload()
    await page.waitForSelector('.app-shell')
    await page.locator('.mode-switch button', { hasText: 'Code' }).click()
    await page.waitForTimeout(500)

    const sessionState = (id) =>
      page.evaluate(async (sessionId) => {
        const value = (await window.forja.sessions.get(sessionId)).value
        return { run: value.state, approvals: value.approvals.length, effort: value.meta.effort }
      }, id)

    // --- 2. change model/effort while the slow command runs
    await e2e.openSession(page, 'Sessão B', PROJECT)
    const startedB = Date.now()
    await e2e.send(page, 'Chame run_command uma única vez, com command exatamente igual a: node -e "setTimeout(()=>{},5000)" e description="Comando lento". Quando ele terminar, diga só "terminei devagar".')
    let live = null
    for (let i = 0; i < 360; i++) {
      await page.waitForTimeout(250)
      live = await sessionState(sessionB.sessionId)
      if (live.run === 'tool') break
    }
    check('turno-B-chegou-a-executar-a-ferramenta', live.run === 'tool', live.run)
    const change = await page.evaluate(async ({ id, provider, model }) => {
      const a = await window.forja.sessions.setModel(id, provider, model)
      const b = await window.forja.sessions.setEffort(id, 'low')
      return { model: a.ok, effort: b.ok, modelError: a.ok ? undefined : a.error, effortError: b.ok ? undefined : b.error }
    }, { id: sessionB.sessionId, provider: sessionB.provider, model: sessionB.model })
    results.changeAccepted = change
    check('troca-de-modelo-e-esforco-aceita-durante-o-turno', change.model && change.effort, change)
    const settledB = await e2e.waitSettled(page, sessionB.sessionId, { timeoutMs: 240000 })
    results.turns.B = { seconds: Math.round((Date.now() - startedB) / 1000), run: settledB.run }
    const afterB = await sessionState(sessionB.sessionId)
    const activityB = await e2e.toolActivity(page, sessionB.sessionId)
    const slow = activityB.results.find((item) => item.name === 'run_command')
    check('turno-sobreviveu-a-troca', afterB.run !== 'cancelled' && settledB.run !== 'error' && Boolean(slow && slow.ok), { run: afterB.run, tool: slow && { ok: slow.ok, text: slow.text.slice(0, 160) } })
    check('esforco-aplicado', afterB.effort === 'low', afterB.effort)
    await shot('01-troca-durante-turno')

    // --- 3. approval survives a session switch
    await page.evaluate(async () => {
      const settings = (await window.forja.app.settings()).value
      await window.forja.app.updateSettings({ policy: { ...settings.policy, mode: 'ask', fullAccess: false } })
    })
    await page.waitForTimeout(500)
    await e2e.openSession(page, 'Sessão A', PROJECT)
    const startedA = Date.now()
    await e2e.send(page, 'Use write_file para criar o arquivo a.txt com o conteúdo exato "aprovado" seguido de uma quebra de linha. Não use outras ferramentas. Depois diga só "ok escrevi a.txt".')
    await page.waitForSelector('.approval-dock .approval', { timeout: 120000 })
    const approvalShown = await page.locator('.approval-dock .approval').count()
    await e2e.openSession(page, 'Sessão X', PROJECT)
    const approvalElsewhere = await page.locator('.approval-dock .approval').count()
    await e2e.openSession(page, 'Sessão A', PROJECT)
    const approvalBack = await page.locator('.approval-dock .approval').count()
    check('aprovacao-aparece-uma-vez', approvalShown === 1, approvalShown)
    check('aprovacao-some-na-outra-sessao', approvalElsewhere === 0, approvalElsewhere)
    check('aprovacao-volta-ao-retornar', approvalBack === 1, approvalBack)
    check('arquivo-nao-existe-antes-de-aprovar', !fs.existsSync(path.join(ws.project, 'a.txt')))
    await shot('02-aprovacao-voltou')
    await page.locator('.approval-actions .btn.primary').first().click()
    const settledA = await e2e.waitSettled(page, sessionA.sessionId, { timeoutMs: 240000 })
    results.turns.A = { seconds: Math.round((Date.now() - startedA) / 1000), run: settledA.run }
    const activityA = await e2e.toolActivity(page, sessionA.sessionId)
    const wrote = activityA.calls.find((item) => item.name === 'write_file')
    check('modelo-chamou-write_file-a.txt', Boolean(wrote && wrote.args && wrote.args.path === 'a.txt'), wrote && wrote.args)
    check('arquivo-a.txt-escrito-apos-aprovar', fs.existsSync(path.join(ws.project, 'a.txt')) && /^aprovado\s*$/.test(fs.readFileSync(path.join(ws.project, 'a.txt'), 'utf8')), fs.existsSync(path.join(ws.project, 'a.txt')) ? fs.readFileSync(path.join(ws.project, 'a.txt'), 'utf8') : 'ausente')

    // --- 5. a custom slash command (.claude/commands/revisar.md) appears in the menu and expands on send
    await page.evaluate(async () => {
      const settings = (await window.forja.app.settings()).value
      await window.forja.app.updateSettings({ policy: { ...settings.policy, mode: 'unrestricted' } })
    })
    await e2e.openSession(page, 'Sessão X', PROJECT)
    const startedX = Date.now()
    const composer = page.locator('textarea[aria-label="Mensagem"]')
    await composer.fill('/rev')
    await page.waitForSelector('.slash-menu', { timeout: 10000 })
    const slashMenu = await page.locator('.slash-menu').innerText()
    await page.locator('.slash-row', { hasText: '/revisar' }).first().click()
    const textAfterPick = await composer.inputValue()
    await composer.press('End')
    await composer.type('src/a.ts')
    await composer.press('Enter')
    const settledX = await e2e.waitSettled(page, sessionX.sessionId, { timeoutMs: 240000 })
    results.turns.X = { seconds: Math.round((Date.now() - startedX) / 1000), run: settledX.run }
    const customCommandSent = await page.evaluate(async (id) => {
      const value = (await window.forja.sessions.get(id)).value
      const sent = [...value.messages].reverse().find((m) => m.role === 'user' && !m.hidden)
      return sent ? sent.parts.filter((p) => p.type === 'text').map((p) => p.text).join('') : ''
    }, sessionX.sessionId)
    check('menu-lista-comandos-do-projeto', /comandos do projeto/i.test(slashMenu), slashMenu.slice(0, 200))
    check('escolher-insere-/revisar', textAfterPick.trim() === '/revisar', textAfterPick)
    check('comando-expande-ao-enviar', customCommandSent === 'Revise src/a.ts e liste os problemas.', customCommandSent)
    check('modelo-respondeu-ao-comando-expandido', settledX.run !== 'error', settledX.run)
    await shot('03-comando-personalizado')

    // --- 4. artifact studio preview is not the 110px thumbnail
    results.previewCss = await page.evaluate(() => {
      const host = document.createElement('div')
      host.innerHTML = '<div class="artifact-studio-body"><div class="artifact-preview" id="studio-preview">x</div></div><div class="artifact-card"><div class="artifact-preview" id="card-preview">x</div></div>'
      document.body.appendChild(host)
      const read = (id) => {
        const style = getComputedStyle(document.getElementById(id))
        return { height: style.height, display: style.display }
      }
      const out = { studio: read('studio-preview'), card: read('card-preview') }
      host.remove()
      return out
    })
    check('previa-do-estudio-nao-tem-110px', results.previewCss.studio.height !== '110px', results.previewCss.studio)
    check('miniatura-da-galeria-tem-110px', results.previewCss.card.height === '110px', results.previewCss.card)

    for (const [key, id] of [['B', sessionB.sessionId], ['A', sessionA.sessionId], ['X', sessionX.sessionId]]) results.usage[key] = await e2e.usageOf(page, id)
    results.errors = errors
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    results.ok = ok()
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  } finally {
    app.cleanup()
    fs.rmSync(marker, { force: true })
  }
  process.exit(results.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
