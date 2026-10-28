// Real models, real app: can ANOTHER model continue a job from the project's memory alone?
//
//   Session A (deepseek-flash) is told the decisions of a small library and asked to do steps 1 and 2 of 3, then stop
//   (a model that "ran out of tokens"). Session B is a NEW session in the same project, on ANOTHER model
//   (deepseek-v4-pro: the only other model this machine has a key for), and says only "Continue de onde paramos."
//   The script then runs hidden tests that need the decisions: the CSV separator and line ending, the money format,
//   the footer line. The decisions exist nowhere in the code A wrote except where they were applied to steps 1 and 2.
//   CONTROL: the same code, the same words to the same model, in a project that has no memory.
//
//   node scripts/ui-handoff.cjs --label new [--root <snapshot folder>] [--model-b deepseek-v4-pro] [--out docs/medicoes]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'build')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'docs', 'medicoes')))
const PORT = Number(e2e.arg('port', '9442'))
const MODEL_A = e2e.arg('model-a', 'deepseek-flash')
const MODEL_B = e2e.arg('model-b', 'deepseek-v4-pro')
const SKIP_CONTROL = process.argv.includes('--no-control')
// A model that never curates the memory: the first session is told not to use any memory tool, so only what the app records by
// itself (turn notes, the continuity capsule) can carry the decisions to the next model.
const LAZY_A = process.argv.includes('--lazy-a')
// Between the first session and the second one the user does other things in the same project: N short, unrelated sessions. A
// memory that only offers "what happened last" loses the unfinished work after a few of them.
const INTERLEAVE = Number(e2e.arg('interleave', '0'))
const DETOURS = [
  'Quanto é 17 vezes 23? Responda só com o número.',
  'Qual é a capital da Austrália? Responda só com o nome.',
  'Escreva uma frase curta sobre o mar.',
  'Traduza "bom dia, tudo bem?" para o inglês.',
  'Dê um sinônimo de "rápido".',
  'Quantos dias tem fevereiro em um ano bissexto? Responda só com o número.',
  'Qual é a raiz quadrada de 144? Responda só com o número.',
  'Diga um fato curioso sobre polvos, em uma frase.'
]
const LAZY_NOTE = '\nImportante: não use nenhuma ferramenta de memória (memory_*) nesta sessão; só código, testes e update_plan.'

const { SPEC, hiddenTests, fileTree } = require('./lib/handoff-fixture.cjs')

async function usage(page, sessionId) {
  return page.evaluate(async (id) => {
    const value = (await window.forja.sessions.get(id)).value
    const calls = value.messages.filter((m) => m.role === 'assistant' && m.usage)
    const tools = value.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_call').map((p) => p.name))
    const last = [...value.messages].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'))
    return {
      calls: calls.length,
      input: calls.reduce((sum, m) => sum + m.usage.input, 0),
      cached: calls.reduce((sum, m) => sum + (m.usage.cachedInput || 0), 0),
      output: calls.reduce((sum, m) => sum + m.usage.output, 0),
      firstInput: calls[0] ? calls[0].usage.input : 0,
      tools,
      usedMemory: tools.filter((name) => /^memory_/.test(name)),
      askedUser: tools.includes('ask_user'),
      models: [...new Set(calls.map((m) => m.model).filter(Boolean))],
      finalText: last ? last.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 400) : '',
      state: value.state
    }
  }, sessionId)
}

async function runSession(page, { folder, title, projectName, model, prompt }) {
  const session = await e2e.newSession(page, { folder, title, projectName })
  if (model) await page.evaluate(async ({ id, model }) => { await window.forja.sessions.setModel(id, 'deepseek', model) }, { id: session.sessionId, model })
  await page.reload()
  await page.waitForSelector('.app-shell')
  await e2e.openSession(page, title, projectName)
  // The user is not going to pass the context again: when a model asks, it is told to use what the project and the memory
  // have (and the question is recorded, because having to ask is part of the result).
  await page.evaluate(() => {
    if (window.__handoffAsked) return
    window.__handoffAsked = []
    window.forja.events.on((event) => {
      if (event.type !== 'question_request') return
      window.__handoffAsked.push(event.request.questions.map((question) => question.question).join(' | '))
      void window.forja.questions.answer(
        event.request.id,
        event.request.questions.map((question) => ({
          header: question.header,
          answers: ['Não vou repassar o contexto: continue de onde paramos com o que o projeto e a memória tiverem.']
        }))
      )
    })
  })
  const started = Date.now()
  await e2e.send(page, prompt)
  let timedOut = false
  try {
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: 480000 })
  } catch {
    timedOut = true
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  const asked = await page.evaluate(() => window.__handoffAsked.splice(0))
  return { session, seconds, timedOut, asked, ...(await usage(page, session.sessionId)) }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-handoff-' })
  const control = path.join(ws.work, 'projeto-controle')
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { label: LABEL, startedAt: new Date().toISOString(), modelA: MODEL_A, modelB: MODEL_B, lazyA: LAZY_A, interleave: INTERLEAVE }
  try {
    // A: decisions + steps 1 and 2.
    result.sessionA = await runSession(page, { folder: ws.project, title: 'Sessao A', projectName: 'Relatorio', model: MODEL_A, prompt: SPEC + (LAZY_A ? LAZY_NOTE : '') })
    result.afterA = { files: fileTree(ws.project), hidden: hiddenTests(ws.project) }
    console.log('A pronto:', JSON.stringify({ seconds: result.sessionA.seconds, calls: result.sessionA.calls, tools: result.sessionA.tools.length, hidden: result.afterA.hidden }))
    // The same code in a folder the memory knows nothing about (the control).
    if (!SKIP_CONTROL) fs.cpSync(ws.project, control, { recursive: true })

    result.detours = []
    for (let index = 0; index < INTERLEAVE; index++) {
      const detour = await runSession(page, { folder: ws.project, title: `Outro assunto ${index + 1}`, projectName: 'Relatorio', model: MODEL_A, prompt: DETOURS[index % DETOURS.length] })
      result.detours.push({ seconds: detour.seconds, calls: detour.calls, input: detour.input, timedOut: detour.timedOut })
    }
    if (INTERLEAVE) console.log(`${INTERLEAVE} sessões de outros assuntos feitas`)

    // B: a new session, another model, one sentence.
    result.sessionB = await runSession(page, { folder: ws.project, title: 'Sessao B', projectName: 'Relatorio', model: MODEL_B, prompt: 'Continue de onde paramos.' })
    result.afterB = { files: fileTree(ws.project), hidden: hiddenTests(ws.project) }
    console.log('B pronto:', JSON.stringify({ seconds: result.sessionB.seconds, calls: result.sessionB.calls, input: result.sessionB.input, memoryTools: result.sessionB.usedMemory, hidden: result.afterB.hidden }))

    if (!SKIP_CONTROL) {
      result.sessionControl = await runSession(page, { folder: control, title: 'Controle sem memoria', projectName: 'Relatorio (controle)', model: MODEL_B, prompt: 'Continue de onde paramos.' })
      result.afterControl = { files: fileTree(control), hidden: hiddenTests(control) }
      console.log('Controle pronto:', JSON.stringify({ seconds: result.sessionControl.seconds, calls: result.sessionControl.calls, input: result.sessionControl.input, askedUser: result.sessionControl.askedUser, hidden: result.afterControl.hidden }))
    }
    result.errors = app.errors.filter((line) => line.startsWith('pageerror'))
  } finally {
    app.cleanup()
  }
  const file = path.join(OUT, `handoff-${LABEL}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  const passed = (hidden) => Object.values(hidden || {}).filter(Boolean).length
  const total = (hidden) => Object.keys(hidden || {}).length || 4
  console.log(
    JSON.stringify(
      {
        label: LABEL,
        comMemoria: { testes: `${passed(result.afterB.hidden)}/${total(result.afterB.hidden)}`, chamadas: result.sessionB.calls, entrada: result.sessionB.input, ferramentasDeMemoria: result.sessionB.usedMemory, perguntasAoUsuario: result.sessionB.asked.length, passosEntregues: result.afterB.hidden },
        semMemoria: result.sessionControl ? { testes: `${passed(result.afterControl.hidden)}/${total(result.afterControl.hidden)}`, chamadas: result.sessionControl.calls, entrada: result.sessionControl.input, perguntasAoUsuario: result.sessionControl.asked.length, passosEntregues: result.afterControl.hidden } : null
      },
      null,
      2
    )
  )
  console.log('gravado em', file)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
