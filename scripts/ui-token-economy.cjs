// Real model, real app: how many tokens does a conversation really cost, and how much of the input comes from the
// provider's prompt cache? Three turns on a project with some code in it:
//   T1 reads the files (the history grows to tens of thousands of tokens)
//   T2 asks for a plan (update_plan) and executes step 1
//   T3 is a short follow-up question
// Every model call is classified by where it sits:
//   first      = first call after a user message (a new turn)
//   afterPlan  = the call right after update_plan ran
//   other      = the rest (same prompt prefix as the call before)
// A prompt that keeps its prefix stable between turns and across plan updates shows a high cached share in all three.
// Also measures the BASE cost: the very first call of a brand-new session that only says "ola".
//
//   node scripts/ui-token-economy.cjs --label baseline [--root <snapshot folder>] [--out docs/medicoes]
// Compare two builds: snapshot each (scripts/snapshot-app.cjs) and run this with --root for both.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'build')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'docs', 'medicoes')))
const PORT = Number(e2e.arg('port', '9441'))
const SAMPLE_FILES = [
  'src/core/memory/project.ts',
  'src/core/memory/tools.ts',
  'src/core/memory/graph.ts',
  'src/core/memory/store.ts',
  'src/core/agent/context.ts',
  'src/core/agent/compaction.ts',
  'src/core/tools/lazy.ts',
  'src/core/skills/library.ts'
]

function seedProject(dir) {
  for (const file of SAMPLE_FILES) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(e2e.ROOT, file), target)
  }
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Projeto de teste\n\nBiblioteca de memória e contexto de agentes. Responda em português.\n')
}

function calls(messages) {
  const list = []
  let expectFirst = false
  let planJustRan = false
  let turn = -1
  for (const message of messages) {
    const parts = message.parts || []
    if (message.role === 'user' && !message.hidden && parts.some((part) => part.type === 'text' && part.text)) {
      expectFirst = true
      turn++
      continue
    }
    if (message.role !== 'assistant') continue
    const usage = message.usage
    if (usage && typeof usage.input === 'number' && usage.input > 0) {
      list.push({
        turn,
        position: expectFirst ? 'first' : planJustRan ? 'afterPlan' : 'other',
        input: usage.input,
        cached: usage.cachedInput || 0,
        output: usage.output || 0
      })
    }
    expectFirst = false
    planJustRan = parts.some((part) => part.type === 'tool_call' && part.name === 'update_plan')
  }
  return list
}

function stat(list) {
  if (!list.length) return { calls: 0 }
  const input = list.reduce((sum, item) => sum + item.input, 0)
  const cached = list.reduce((sum, item) => sum + item.cached, 0)
  return {
    calls: list.length,
    meanInput: Math.round(input / list.length),
    meanUncached: Math.round((input - cached) / list.length),
    cachedShare: Math.round((100 * cached) / input),
    uncachedTotal: input - cached
  }
}

async function runTurn(page, sessionId, text, before) {
  const started = Date.now()
  await e2e.send(page, text)
  const settled = await e2e.waitSettled(page, sessionId, { timeoutMs: 420000, sinceCount: before })
  const report = await e2e.turnReport(page, sessionId, before)
  return { ms: Date.now() - started, count: settled.count, tools: report.calls, run: report.run, final: report.finalText.slice(0, 160) }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-tokens-' })
  seedProject(ws.project)
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { label: LABEL, root: process.argv.includes('--root') ? e2e.arg('root') : 'working-tree', startedAt: new Date().toISOString(), turns: [] }
  try {
    // BASE: a brand-new session that only greets. Its first call is system prompt + tool schemas + one word.
    const hello = await e2e.newSession(page, { folder: ws.project, title: 'Base', projectName: 'Projeto tokens' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Base', 'Projeto tokens')
    await e2e.send(page, 'ola')
    await e2e.waitSettled(page, hello.sessionId, { timeoutMs: 180000 })
    const helloMessages = await page.evaluate(async (id) => (await window.forja.sessions.get(id)).value.messages, hello.sessionId)
    const helloCalls = calls(helloMessages)
    result.baseInputTokens = helloCalls[0] ? helloCalls[0].input : null
    result.baseCalls = helloCalls.length

    // The three-turn conversation.
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Conversa', projectName: 'Projeto tokens' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Conversa', 'Projeto tokens')
    let count = 0
    const prompts = [
      'Leia cada arquivo da pasta src com read_file (todos, um por um) e me diga em 3 linhas o que o projeto faz.',
      'Monte um plano de 3 passos com update_plan e execute os três: (1) conte as linhas de cada arquivo da pasta src, (2) anote qual é o maior, (3) anote qual é o menor. Marque cada passo como concluído ao terminar.',
      'Qual era o arquivo com mais linhas? Responda em uma frase, sem usar ferramentas.'
    ]
    for (const prompt of prompts) {
      const turn = await runTurn(page, session.sessionId, prompt, count)
      count = turn.count
      result.turns.push(turn)
      console.log(`turno ${result.turns.length}: ${Math.round(turn.ms / 1000)} s, ferramentas: ${turn.tools.join(',') || '(nenhuma)'}`)
    }
    const messages = await page.evaluate(async (id) => (await window.forja.sessions.get(id)).value.messages, session.sessionId)
    const all = calls(messages)
    result.calls = all
    result.byPosition = { first: stat(all.filter((c) => c.position === 'first')), afterPlan: stat(all.filter((c) => c.position === 'afterPlan')), other: stat(all.filter((c) => c.position === 'other')) }
    result.total = stat(all)
    result.byTurn = [0, 1, 2].map((turn) => ({ turn: turn + 1, ...stat(all.filter((c) => c.turn === turn)) }))
    result.firstCallOfTurn = all.filter((c) => c.position === 'first').map((c) => ({ turn: c.turn + 1, input: c.input, cached: c.cached, cachedShare: Math.round((100 * c.cached) / c.input) }))
    result.errors = app.errors.filter((line) => line.startsWith('pageerror'))
    for (const probe of [hello, session]) {
      const model = await e2e.checkModel(page, probe)
      if (!model.ok) {
        // The session moved to another model (the reserve, a manual switch): the numbers are not those of the model asked for.
        console.error(`o modelo trocou durante a execução (${model.expected.providerId}/${model.expected.model} → ${model.actual.providerId}/${model.actual.model}). Nada foi gravado.`)
        process.exitCode = 3
        return
      }
      result.model = `${model.actual.providerId}/${model.actual.model}`
    }
    if (!all.length || !result.baseInputTokens) {
      // The model never answered (no credit, quota, rate limit): an empty run is not a result, and must not replace a real one.
      console.error(`o modelo não respondeu (${all.length} chamadas medidas, base ${result.baseInputTokens}) — ${await e2e.failureOf(page, session.sessionId)}. Nada foi gravado.`)
      process.exitCode = 3
      return
    }
  } finally {
    app.cleanup()
  }
  const file = path.join(OUT, `tokens-${LABEL}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ label: result.label, base: result.baseInputTokens, byPosition: result.byPosition, total: result.total, firstCallOfTurn: result.firstCallOfTurn }, null, 2))
  console.log('gravado em', file)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
