// What the smaller floor costs when a model DOES need a tool that is no longer sent in every request. Real model, real app.
// Four fresh sessions, each asking for something only a deferred tool does:
//   mcp-state   mcp_servers      the state of the MCP servers
//   handoff     memory_handoff   a hand-off for the next session
//   skills      list_skills      searching the skill catalogue
//   agents      list_agents      searching the agent catalogue
// For each one: the sequence of tool calls, whether the target tool ran, how many model calls it took and the tokens of
// each call as the PROVIDER counted them (input, and how much of it came from the prompt cache).
//
//   node scripts/ui-deferred-tools.cjs --label after --root <snapshot folder> [--only handoff,skills] [--out docs/medicoes]
// Run it on the build from before the change too (--root <old snapshot>) to see what the same ask cost when the tool was in every request.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'build')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'docs', 'medicoes')))
const PORT = Number(e2e.arg('port', '9461'))
const TIMEOUT_MS = Number(e2e.arg('timeout', '240')) * 1000
const ONLY = e2e.arg('only', '')
  ? e2e
      .arg('only', '')
      .split(',')
      .map((name) => name.trim())
  : []

const SCENARIOS = [
  { name: 'mcp-state', target: 'mcp_servers', prompt: 'Chame a ferramenta mcp_servers e me diga em uma frase quantos servidores MCP aparecem.' },
  {
    name: 'handoff',
    target: 'memory_handoff',
    prompt: 'Registre um handoff de memória para a próxima sessão: resumo "piso de tokens medido", próximo passo "rodar a suíte de testes". Depois me diga o id do handoff.'
  },
  { name: 'skills', target: 'list_skills', prompt: 'Consulte o catálogo de skills instaladas com a busca "pdf" e me diga os nomes das que casam (ou que nenhuma casa).' },
  { name: 'agents', target: 'list_agents', prompt: 'Consulte o catálogo de agentes com a busca "segurança" e me diga o nome de um agente que revise segurança.' }
]

function usageCalls(messages) {
  const list = []
  for (const message of messages) {
    const usage = message.usage
    if (message.role === 'assistant' && usage && typeof usage.input === 'number' && usage.input > 0) {
      list.push({ input: usage.input, cached: usage.cachedInput || 0, output: usage.output || 0 })
    }
  }
  return list
}

async function runScenario(page, ws, scenario, index) {
  const title = `Sob demanda ${index + 1}: ${scenario.name}`
  const session = await e2e.newSession(page, { folder: ws.project, title, projectName: 'Projeto sob demanda' })
  await page.reload()
  await page.waitForSelector('.app-shell')
  await e2e.openSession(page, title, 'Projeto sob demanda')
  const started = Date.now()
  await e2e.send(page, scenario.prompt)
  let timedOut = false
  try {
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: TIMEOUT_MS })
  } catch {
    // A model that never finishes is a result (it got lost), not a reason to throw away the other scenarios.
    timedOut = true
    await page.evaluate((id) => window.forja.sessions.abort(id), session.sessionId).catch(() => undefined)
    await page.waitForTimeout(3000)
  }
  const report = await e2e.turnReport(page, session.sessionId, 0)
  const activity = await e2e.toolActivity(page, session.sessionId, 0)
  const messages = await page.evaluate(async (id) => (await window.forja.sessions.get(id)).value.messages, session.sessionId)
  const calls = usageCalls(messages)
  const input = calls.reduce((sum, call) => sum + call.input, 0)
  const cached = calls.reduce((sum, call) => sum + call.cached, 0)
  const refused = activity.results.filter((result) => /não está carregada|não disponível/.test(result.text)).map((result) => ({ name: result.name, text: result.text.slice(0, 160) }))
  const targetResults = activity.results.filter((result) => result.name === scenario.target)
  const ran = targetResults.find((result) => result.ok) || targetResults[0]
  const outcome = {
    name: scenario.name,
    target: scenario.target,
    sequence: activity.calls.map((call) => call.name),
    targetRan: targetResults.length > 0,
    targetOk: targetResults.some((result) => result.ok),
    targetText: ran ? ran.text.slice(0, 200) : '',
    usedToolLoad: activity.calls.some((call) => call.name === 'tool_load'),
    usedToolSearch: activity.calls.some((call) => call.name === 'tool_search'),
    refusedFirst: refused.length > 0,
    refused,
    modelCalls: calls.length,
    inputTokens: input,
    cachedTokens: cached,
    uncachedTokens: input - cached,
    perCall: calls,
    ms: Date.now() - started,
    timedOut,
    final: report.finalText.slice(0, 240),
    failure: calls.length ? undefined : await e2e.failureOf(page, session.sessionId),
    model: await e2e.checkModel(page, session)
  }
  console.log(
    `${scenario.name}: ${outcome.sequence.join(' > ') || '(sem ferramentas)'} | ${outcome.modelCalls} chamadas, ${input} tokens de entrada (${cached} em cache) | alvo ${outcome.targetOk ? 'OK' : outcome.targetRan ? 'FALHOU' : 'NÃO RODOU'}${timedOut ? ` | NÃO TERMINOU em ${Math.round(TIMEOUT_MS / 1000)} s (abortado)` : ''}`
  )
  return outcome
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-deferred-' })
  fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Projeto de teste\n\nResponda em português, de forma curta.\n')
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { label: LABEL, root: process.argv.includes('--root') ? e2e.arg('root') : 'working-tree', startedAt: new Date().toISOString(), scenarios: [] }
  try {
    const chosen = SCENARIOS.filter((scenario) => !ONLY.length || ONLY.includes(scenario.name))
    for (const [index, scenario] of chosen.entries()) result.scenarios.push(await runScenario(page, ws, scenario, index))
    result.errors = app.errors.filter((line) => line.startsWith('pageerror'))
  } finally {
    app.cleanup()
  }
  const total = (key) => result.scenarios.reduce((sum, scenario) => sum + scenario[key], 0)
  const switched = result.scenarios.find((scenario) => !scenario.model.ok)
  if (switched) {
    // The session moved to another model (the reserve, a manual switch): the numbers are not those of the model asked for.
    console.error(`o modelo trocou durante o cenário ${switched.name} (${switched.model.expected.providerId}/${switched.model.expected.model} → ${switched.model.actual.providerId}/${switched.model.actual.model}). Nada foi gravado.`)
    process.exit(3)
  }
  result.model = `${result.scenarios[0]?.model.actual.providerId}/${result.scenarios[0]?.model.actual.model}`
  if (!total('modelCalls')) {
    // The model never answered (no credit, quota, rate limit): an empty run is not a result, and must not replace a real one.
    console.error(`o modelo não respondeu em nenhum cenário — ${result.scenarios[0]?.failure ?? 'sem causa registrada'}. Nada foi gravado.`)
    process.exit(3)
  }
  result.totals = { modelCalls: total('modelCalls'), inputTokens: total('inputTokens'), uncachedTokens: total('uncachedTokens'), allTargetsOk: result.scenarios.every((scenario) => scenario.targetOk) }
  const file = path.join(OUT, `sob-demanda-${LABEL}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ label: LABEL, totals: result.totals }, null, 2))
  console.log('gravado em', file)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
