// End-to-end: a REAL connector from the directory, connected through the app, used by a REAL model.
//
//   node scripts/ui-mcp-agent.cjs [--connector microsoft-learn] [--out Prints/conectores-2026-10-27]
//
// 1. connectConnector(<id>) from the directory (a public MCP server that needs no login) -> "Conectado" with tools;
// 2. the Conectores screen shows it under "Conectados";
// 3. DeepSeek uses ITS tool as a first-class tool (mcp__<server>__<tool>, not the old indirect mcp_call) and answers
//    from the result;
// 4. the user blocks the tool in the connector -> the next turn cannot call it.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const CONNECTOR = e2e.arg('connector', 'microsoft-learn')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'conectores-2026-10-27')))
const PORT = 9439

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-mcp-agent-' })
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { connector: CONNECTOR, checks: {}, turns: [] }
  const check = (name, ok, detail) => {
    result.checks[name] = ok ? 'ok' : `FALHOU${detail ? `: ${detail}` : ''}`
    if (!ok) result.failed = true
  }
  try {
    // 1. connect from the directory
    const connected = await page.evaluate(async (id) => {
      const started = performance.now()
      const r = await window.openclod.app.connectConnector(id)
      return { ok: r.ok, error: r.error, state: r.value && r.value.state, ms: Math.round(performance.now() - started) }
    }, CONNECTOR)
    result.connect = connected
    check('conecta-pelo-diretorio', connected.ok && connected.state && connected.state.status === 'connected', JSON.stringify(connected).slice(0, 300))
    const serverName = connected.state && connected.state.serverName
    const tools = serverName ? await page.evaluate(async (name) => (await window.openclod.app.connectorTools(name)).value, serverName) : []
    result.tools = (tools || []).map((tool) => `${tool.name}:${tool.policy}`)
    check('lista-ferramentas-reais', Array.isArray(tools) && tools.length > 0, `${(tools || []).length} ferramentas`)
    if (!tools || !tools.length) throw new Error('sem ferramentas: não dá para seguir')

    // 2. the Conectores screen
    await page.locator('nav.side-nav .side-row', { hasText: 'Personalização' }).click()
    await page.getByRole('tab', { name: /Conectores/ }).click()
    await page.waitForSelector('.cnx-card, [data-connector-id]', { timeout: 15000 })
    // The card carries the directory's display name ("Microsoft Learn"), not the technical server name.
    const displayName = await page.evaluate(async (id) => {
      const entries = (await window.openclod.app.connectorDirectory()).value
      const list = Array.isArray(entries) ? entries : entries && entries.entries
      const found = (list || []).find((entry) => entry.id === id)
      return found ? found.name : id
    }, CONNECTOR)
    // The screen loads the states after it mounts: wait for the card instead of reading it once. textContent, not
    // innerText: the cards use content-visibility, which innerText does not report for off-screen ones.
    const connectedSection = await page
      .waitForFunction(
        (name) => {
          const body = document.body.textContent || ''
          return body.includes('Conectados') && body.includes(name) && /Conectado\s*·\s*\d+\s*ferramenta/.test(body)
        },
        displayName,
        { timeout: 15000 }
      )
      .then(() => true, () => false)
    check('tela-mostra-o-conector-conectado', connectedSection, displayName)
    await page.screenshot({ path: path.join(OUT, '18-conector-real-conectado.png') })

    // 3. a real turn that must use the tool as a first-class tool
    const readOnly = tools.find((tool) => tool.readOnly) || tools[0]
    const session = await e2e.newSession(page, { folder: ws.project, title: 'MCP real', projectName: 'Projeto MCP real' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'MCP real', 'Projeto MCP real')
    await e2e.send(page, `Use o conector "${CONNECTOR}" (ferramenta ${readOnly.name}) para buscar a documentação sobre "Azure Blob Storage lifecycle management" e me diga o título do primeiro resultado. Use a ferramenta do conector, não a internet em geral.`)
    const first = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000 })
    const report = await e2e.turnReport(page, session.sessionId, 0)
    result.turns.push({ calls: report.calls, results: report.results.map((item) => ({ name: item.name, ok: item.ok, text: item.text.slice(0, 120) })), finalText: report.finalText.slice(0, 300) })
    const direct = report.results.filter((item) => item.name && item.name.startsWith(`mcp__${serverName}__`))
    check('modelo-chamou-a-ferramenta-de-primeira-classe', direct.length > 0, JSON.stringify(report.calls))
    check('chamada-da-ferramenta-deu-certo', direct.some((item) => item.ok), JSON.stringify(direct).slice(0, 300))
    check('modelo-nao-usou-o-caminho-indireto-mcp_call', !report.calls.includes('mcp_call'), JSON.stringify(report.calls))
    check('modelo-respondeu-com-base-no-resultado', report.finalText.trim().length > 20, report.finalText.slice(0, 100))

    // 4. block the tool: the next turn must not be able to call it
    const blocked = await page.evaluate(async ({ name, tool }) => (await window.openclod.app.setToolPolicy(name, tool, 'deny')).ok, { name: serverName, tool: readOnly.name })
    check('bloqueio-gravado', blocked)
    const before = first.count
    await e2e.send(page, `Agora use de novo a ferramenta ${readOnly.name} do conector para buscar "Azure Functions triggers". Se não puder, diga exatamente que não consegue usá-la.`)
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000, sinceCount: before })
    const second = await e2e.turnReport(page, session.sessionId, before)
    result.turns.push({ calls: second.calls, results: second.results.map((item) => ({ name: item.name, ok: item.ok, text: item.text.slice(0, 140) })), finalText: second.finalText.slice(0, 300) })
    // Neither the direct tool NOR the old indirect route (mcp_call) may get around the block.
    const usedBlocked = second.results.filter((item) => item.ok && item.name && (item.name.startsWith(`mcp__${serverName}__${readOnly.name}`) || (item.name === 'mcp_call' && /microsoft_docs_search/.test(item.text) && !/negad|bloquead|deny|não permit/i.test(item.text))))
    check('ferramenta-bloqueada-nao-roda', usedBlocked.length === 0, JSON.stringify(second.results).slice(0, 400))
    const indirect = second.results.filter((item) => item.name === 'mcp_call')
    check('caminho-indireto-tambem-recusa', indirect.every((item) => !item.ok), JSON.stringify(indirect).slice(0, 300))
    await page.screenshot({ path: path.join(OUT, '19-conversa-com-conector-bloqueado.png') })

    // 5. clean up: disconnect
    const gone = await page.evaluate(async (id) => (await window.openclod.app.disconnectConnector(id)).ok, CONNECTOR)
    check('desconecta', gone)
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
