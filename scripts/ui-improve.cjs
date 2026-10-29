// End-to-end check of the "Revisão de melhorias" in the real app, with a REAL model (DeepSeek by default; only
// the key vault is borrowed from the real profile), a THROWAWAY profile and a throwaway project.
//   node scripts/ui-improve.cjs [outDir] [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
//
// - the evidence comes from one real turn with real tools: image_generate (which fails here because no image
//   endpoint is configured: a genuine capability gap) twice, each failure reported by the model with
//   report_limitation, and run_command three times on commands that fail on purpose. The report's counts are
//   checked against what the transcript really contains. The project itself is NAMED after a fake API key and a
//   personal path, so the redaction checks act on real content without asking the model to invent anything
//   (a real model refuses to fabricate a limitation, which is why the old scripted trick was dropped);
// - Phase A (rules only): the default provider is switched to one WITHOUT a credential, so the AI option must be
//   disabled, and the review runs from the automatic rules alone;
// - Phase B (AI path): the DeepSeek provider is pointed at a small local RECORDING PROXY that forwards every
//   request to the real DeepSeek API unchanged (the key travels only in the forwarded headers and is never
//   stored) and can inject faults on demand. It proves the wiring against a real model (tool-less single
//   request, redacted evidence, the model's real analysis saved in the page) and the failure paths a real
//   provider cannot be asked to produce: HTTP 500 (fallback to rules) and a hung answer (cancel).
//   Costs one short DeepSeek analysis (a few thousand tokens) plus the evidence turn.
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'tmp', 'ui-improve'))
const PORT = 9335
const PROXY_PORT = 9393
const TITLE = 'Gerar evidência'
const SECRET = 'sk-ABCDEFGHIJKLMNOP1234'
const USER_PATH = 'C:\\Users\\maike\\segredo'
// The project is named after a fake key and a personal path: both must be redacted before the evidence reaches
// the prompt or the memory page.
const PROJECT = `Projeto ${SECRET} em ${USER_PATH}`
const LIMITATION = 'image_generate indisponível: geração externa de imagens não configurada'
fs.mkdirSync(OUT, { recursive: true })

const EVIDENCE_PROMPT =
  'Este é o teste automatizado da "Revisão de melhorias" do Openclod; siga EXATAMENTE, sem pedir confirmação. ' +
  'Passo 1: carregue image_generate com tool_load e chame image_generate DUAS vezes (duas chamadas separadas, uma de cada vez), as duas com prompt="gráfico de preços", output="grafico.png", width=64 e height=64. ' +
  'Neste ambiente a geração externa de imagens NÃO está configurada, então elas devem falhar. Cada falha é uma limitação real do harness: depois de CADA falha, chame report_limitation ' +
  `(uma chamada por falha, duas no total) com title="${LIMITATION}", goal="Gerar o gráfico de preços", error=a mensagem de erro exata devolvida pela ferramenta, ` +
  'difficulty="Sem endpoint de imagens configurado; a tarefa não pode ser concluída", suggestion="Configurar um provedor de imagens ou oferecer um fallback", severity="blocked". ' +
  'Passo 2: chame run_command TRÊS vezes, uma de cada vez, com estes comandos que falham de propósito (a falha é esperada: NÃO tente corrigir nem repetir): ' +
  '`node -e "process.exit(3)"`, `node -e "process.exit(4)"` e `node -e "process.exit(5)"`, todos com description="Comando que falha de propósito". ' +
  'Depois diga só "terminei".'

// ---- recording / fault-injecting proxy in front of the REAL provider --------------------------------
let proxyMode = 'ok'
let upstreamBase = 'https://api.deepseek.com/v1'
const proxyRequests = []
const proxyAnswers = []
const sockets = new Set()
const proxy = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404)
    res.end()
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    let parsed = {}
    try { parsed = JSON.parse(body.toString('utf8')) } catch {}
    proxyRequests.push({ mode: proxyMode, body: parsed })
    if (proxyMode === 'hang') return // never answers; the client must abort
    if (proxyMode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'falha simulada do servidor', code: 500 } }))
      return
    }
    // Forward to the real API. Headers (including the credential) are only passed through, never stored or logged.
    const target = new URL(upstreamBase.replace(/\/+$/, '') + req.url.replace(/^\/v1/, ''))
    const headers = { ...req.headers, 'accept-encoding': 'identity', 'content-length': String(body.length) }
    delete headers.host
    delete headers.connection
    const upstream = https.request({ hostname: target.hostname, port: target.port || 443, path: target.pathname + target.search, method: 'POST', headers }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      let sse = ''
      upRes.on('data', (chunk) => { sse += chunk.toString('utf8'); res.write(chunk) })
      upRes.on('end', () => {
        res.end()
        let text = ''
        for (const line of sse.split('\n')) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
          try { text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '' } catch {}
        }
        proxyAnswers.push({ status: upRes.statusCode, text })
      })
    })
    upstream.on('error', (error) => {
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `proxy: ${error.message}` } }))
    })
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    upstream.end(body)
  })
})
proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })

function findFiles(dir, pattern, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(full, pattern, found)
    else if (pattern.test(entry.name)) found.push(full)
  }
  return found
}

/** The saved model analysis has the same fence stripped as the product does before saving. */
const unfence = (text) => {
  const out = text.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(out)
  return fenced ? fenced[1].trim() : out
}

async function main() {
  await new Promise((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-ui-improve-' })
  fs.writeFileSync(path.join(ws.project, 'README.md'), '# Projeto\n')
  // OPENCLOD_IMAGE_BASE_URL is forced empty: image_generate must fail here (the genuine limitation the model reports).
  const app = await e2e.launch({ port: PORT, ...ws, env: { OPENCLOD_IMAGE_BASE_URL: '' } })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const results = { checks, turn: undefined, usage: undefined, errors: [] }
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
  const goto = async (...labels) => {
    for (const label of labels) {
      const item = page.locator('.side-label', { hasText: label }).first()
      if (await item.count()) {
        await item.click()
        await page.waitForTimeout(500)
        return
      }
    }
    throw new Error(`item de menu não encontrado: ${labels.join('/')}`)
  }
  const status = (id) => page.evaluate(async (projectId) => (await window.openclod.improvements.status(projectId)).value, id)
  const reviewPages = () => findFiles(ws.profile, /^revisao-melhorias-\d{4}-\d{2}-\d{2}\.md$/)
  try {
    // ---- evidence: one real turn with real tools -------------------------------------------------
    const session = await e2e.newSession(page, { folder: ws.project, title: TITLE, projectName: PROJECT })
    const projectId = session.projectId
    results.model = `${session.provider}/${session.model}`
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, TITLE, PROJECT)
    const started = Date.now()
    await e2e.send(page, EVIDENCE_PROMPT)
    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 300000 })
    results.turn = { seconds: Math.round((Date.now() - started) / 1000), run: settled.run }
    await page.waitForTimeout(1500)
    const activity = await e2e.toolActivity(page, session.sessionId)
    const limitationCalls = activity.calls.filter((call) => call.name === 'report_limitation')
    const runCalls = activity.calls.filter((call) => call.name === 'run_command')
    const runFailures = activity.results.filter((item) => item.name === 'run_command' && !item.ok)
    const imageCalls = activity.calls.filter((call) => call.name === 'image_generate')
    const imageFailures = activity.results.filter((item) => item.name === 'image_generate' && !item.ok)
    results.expected = { limitations: limitationCalls.length, imageGenerate: imageCalls.length, imageFailures: imageFailures.length, runCommand: runCalls.length, runFailures: runFailures.length }
    const turnInfo = await e2e.turnReport(page, session.sessionId, 0)
    results.evidenceTurn = { calls: turnInfo.calls, finalText: turnInfo.finalText.slice(0, 600) }
    check('turno-de-evidencia-terminou-sem-erro', settled.run !== 'error', settled.run)
    check('modelo-seguiu-o-roteiro (image_generate 2x falhando, report_limitation 2x, run_command 3x falhando)', imageFailures.length === 2 && limitationCalls.length === 2 && runCalls.length === 3 && runFailures.length === 3, results.expected)
    check('limitacoes-registradas-com-o-titulo-combinado', limitationCalls.length > 0 && limitationCalls.every((call) => call.args && call.args.title === LIMITATION), limitationCalls.map((call) => call.args && call.args.title))
    const registered = (await page.evaluate(async () => (await window.openclod.projects.list()).value)).find((item) => item.id === projectId)
    check('projeto-registrado-com-segredo-e-caminho-no-nome (origem da redacao)', Boolean(registered && registered.name.includes(SECRET) && registered.name.includes('maike')), registered && registered.name)
    await shot('00-evidencia-gerada')

    // ---- Phase A: rules only (the default provider has no credential => no AI available) ----------
    const noKey = await page.evaluate(async () => {
      const settings = (await window.openclod.app.settings()).value
      const caps = (await window.openclod.app.capabilities()).value
      const target = settings.providers.find((item) => caps.providers.find((cap) => cap.id === item.id)?.configured === false)
      if (!target) return { error: 'todos os provedores têm credencial neste perfil' }
      await window.openclod.app.updateSettings({ defaultProviderId: target.id })
      return { id: target.id }
    })
    check('provedor-sem-credencial-escolhido-como-padrao', !noKey.error, noKey)
    await page.reload()
    await page.waitForSelector('.app-shell')
    await goto('Atividades')
    await page.waitForSelector('.improve-card', { timeout: 10000 })
    const aiCheckbox = page.locator('.improve-controls input[type=checkbox]').first()
    await page.waitForFunction(() => document.querySelector('.improve-controls input[type=checkbox]')?.disabled === true, null, { timeout: 15000 }).catch(() => undefined)
    check('card visible, AI disabled without a credential', (await aiCheckbox.isDisabled()) && (await page.locator('.improve-privacy').innerText()).includes('nada deixa o computador'), await page.locator('.improve-privacy').innerText())
    await shot('01-card-sem-ia')

    await page.locator('button', { hasText: 'Revisar melhorias' }).click()
    await page.waitForFunction(() => document.querySelector('.improve-last .badge')?.textContent?.includes('concluída'), null, { timeout: 30000 })
    const lastA = await status(projectId)
    check('rules-only review finished with findings', lastA.last?.state === 'done' && lastA.last.usedAi === false && lastA.last.findings >= 2, { findings: lastA.last?.findings, summary: lastA.last?.summary })
    const files = reviewPages()
    const pageFile = files[0]
    const body = pageFile ? fs.readFileSync(pageFile, 'utf8') : ''
    check('memory page written as a wiki file', Boolean(pageFile) && body.includes('**Nada foi aplicado.**') && body.includes(LIMITATION), pageFile ? path.basename(pageFile) : 'ausente')
    const limitationRow = body.split('\n').find((line) => line.startsWith(`| ${LIMITATION} |`)) ?? ''
    check('limitation counted as many times as the model reported it', limitationRow.startsWith(`| ${LIMITATION} | ${results.expected.limitations} |`) && body.includes(`Limitações relatadas: ${results.expected.limitations}`), limitationRow)
    const toolRow = body.split('\n').find((line) => line.startsWith('| run_command |')) ?? ''
    check('failing commands counted as the transcript shows (calls and failures)', toolRow.startsWith(`| run_command | ${results.expected.runCommand} | ${results.expected.runFailures} |`), toolRow)
    const imageRow = body.split('\n').find((line) => line.startsWith('| image_generate |')) ?? ''
    check('failing image_generate counted as the transcript shows', imageRow.startsWith(`| image_generate | ${results.expected.imageGenerate} | ${results.expected.imageFailures} |`), imageRow)
    check('tool failure finding present', body.includes('Ferramenta com muitas falhas: run_command'))
    check('no secret or user path leaked into the page', !body.includes(SECRET) && !body.includes('maike'))
    check('...and the redaction really acted on the project name', body.includes('[REDACTED_API_KEY]') && body.includes('<USER_HOME>'), (body.split('\n').find((line) => line.includes('projeto ')) || '').slice(0, 200))
    await shot('02-revisao-concluida')

    // Activity note + opening the report in Memory
    await page.waitForTimeout(2800)
    const noteTitle = await page.locator('.activity-card', { hasText: 'Revisão de melhorias:' }).first().locator('strong').innerText().catch(() => '')
    check('Activity has the review note', noteTitle.startsWith('Revisão de melhorias:'), noteTitle)
    // Observation (not a check): the note's detail is built from the raw project name.
    const noteText = await page.locator('.activity-card', { hasText: 'Revisão de melhorias:' }).first().innerText().catch(() => '')
    results.observations = { activityNoteShowsRawProjectName: noteText.includes(SECRET) || noteText.includes('maike'), activityNote: noteText.replace(/\s+/g, ' ').slice(0, 300) }
    await page.locator('.activity-card', { hasText: 'Revisão de melhorias:' }).first().locator('button', { hasText: 'Abrir na Memória' }).click()
    await page.waitForSelector('.memory-detail-body', { timeout: 10000 })
    const memoryText = await page.locator('.memory-detail-body').innerText()
    check('"Abrir na Memória" opens the report page', memoryText.includes('Nada foi aplicado'))
    await shot('03-memoria-relatorio')

    // ---- Weekly switch creates a real scheduled task -------------------------------------------
    await goto('Atividades')
    await page.waitForSelector('.improve-card')
    await page.locator('.improve-weekly input[type=checkbox]').click()
    await page.waitForFunction(async (id) => (await window.openclod.improvements.status(id)).value.weekly.enabled, projectId, { timeout: 10000 })
    const tasks = await page.evaluate(async () => (await window.openclod.schedules.list()).value)
    const weekly = tasks.find((task) => task.action === 'improvement-review')
    check('weekly task exists with the built-in action', weekly && weekly.enabled && weekly.schedule.kind === 'weekly' && weekly.actionOptions?.useAi === false, weekly && { name: weekly.name, schedule: weekly.schedule, options: weekly.actionOptions })
    await goto('Agendados', 'Rotinas')
    await page.waitForSelector('.task-row', { timeout: 10000 })
    const row = await page.locator('.task-row', { hasText: 'Revisão semanal de melhorias' }).first().innerText()
    // The badge is rendered uppercase by CSS, so innerText comes back as "INTERNA".
    check('Agendados lists it as an internal task', /interna/i.test(row), row.replace(/\s+/g, ' '))
    await shot('04-agendados')

    const before = lastA.history.length
    await page.evaluate(async (taskId) => window.openclod.schedules.runNow(taskId), weekly.id)
    await page.waitForFunction(
      async ({ id, count }) => {
        const current = (await window.openclod.improvements.status(id)).value
        return !current.current && current.history.length > count
      },
      { id: projectId, count: before },
      { timeout: 30000 }
    )
    const afterRun = await status(projectId)
    const taskAfter = (await page.evaluate(async () => (await window.openclod.schedules.list()).value)).find((task) => task.id === weekly.id)
    check('scheduler "run now" executed the review (trigger=schedule)', afterRun.last.trigger === 'schedule' && afterRun.last.state === 'done' && taskAfter.lastStatus === 'ok', { trigger: afterRun.last.trigger, lastStatus: taskAfter.lastStatus })
    await page.evaluate(async (id) => window.openclod.improvements.setWeekly(id, false), projectId)
    const paused = (await page.evaluate(async () => (await window.openclod.schedules.list()).value)).find((task) => task.id === weekly.id)
    check('turning the switch off pauses the task', paused && paused.enabled === false)

    // ---- Phase B: AI path through the recording proxy to the REAL provider ----------------------
    const realProvider = await page.evaluate(async ({ port, providerId }) => {
      const settings = (await window.openclod.app.settings()).value
      const target = settings.providers.find((item) => item.id === providerId)
      if (!target) return { error: `provedor ${providerId} não existe` }
      const providers = settings.providers.map((item) => (item.id === providerId ? { ...item, baseUrl: `http://127.0.0.1:${port}/v1` } : item))
      await window.openclod.app.updateSettings({ providers, defaultProviderId: providerId })
      return { label: target.label, model: target.model, upstream: target.baseUrl }
    }, { port: PROXY_PORT, providerId: session.provider })
    check('provedor-real-apontado-para-o-proxy-gravador', !realProvider.error, realProvider.error ?? { label: realProvider.label, model: realProvider.model })
    if (realProvider.upstream) upstreamBase = realProvider.upstream
    await page.reload()
    await page.waitForSelector('.app-shell')
    await goto('Atividades')
    await page.waitForSelector('.improve-card')
    const aiBox = page.locator('.improve-controls input[type=checkbox]').first()
    await page.waitForFunction(() => !document.querySelector('.improve-controls input[type=checkbox]')?.disabled, null, { timeout: 15000 })
    check('AI option enabled and the privacy line names the provider', (await aiBox.isChecked()) && (await page.locator('.improve-privacy').innerText()).includes(realProvider.label), await page.locator('.improve-privacy').innerText())
    await shot('05-card-com-ia')

    proxyMode = 'ok'
    await page.locator('button', { hasText: 'Revisar melhorias' }).click()
    await page.waitForFunction(() => document.querySelector('.improve-last .badge')?.textContent?.includes('concluída') && document.querySelector('.improve-last')?.textContent?.includes('IA ·'), null, { timeout: 120000 })
    const reqA = proxyRequests.find((request) => request.mode === 'ok')?.body ?? {}
    const sent = JSON.stringify(reqA)
    check('exactly one model call, without tools', proxyRequests.filter((request) => request.mode === 'ok').length === 1 && !(reqA.tools && reqA.tools.length), { calls: proxyRequests.length, tools: reqA.tools?.length ?? 0 })
    check('the real provider answered 200 with text', proxyAnswers.length === 1 && proxyAnswers[0].status === 200 && proxyAnswers[0].text.trim().length > 40, proxyAnswers.map((answer) => ({ status: answer.status, chars: answer.text.length })))
    check('system prompt is the read-only analyst; evidence inside data markers', sent.includes('no tools') && sent.includes('<<<RELATORIO') && sent.includes('RELATORIO>>>'))
    check('evidence sent to the model has no secret or user path', !sent.includes(SECRET) && !sent.includes('maike') && sent.includes('[REDACTED_API_KEY]'))
    const bodyAi = fs.readFileSync(reviewPages()[0], 'utf8')
    const modelFirstLine = unfence(proxyAnswers[0]?.text ?? '').split('\n').find((line) => line.trim().length > 8)?.trim() ?? ''
    check('page carries the real model analysis plus the counted evidence', bodyAi.includes('## Análise') && modelFirstLine.length > 0 && bodyAi.includes(modelFirstLine) && bodyAi.includes('## Achados (regras automáticas)'), { firstLine: modelFirstLine.slice(0, 80) })
    check('analysis section carries no secret or user path', !bodyAi.includes(SECRET) && !bodyAi.includes('maike'))
    await shot('06-revisao-com-ia')

    // fallback when the model fails
    proxyMode = 'error'
    await page.locator('button', { hasText: 'Revisar melhorias' }).click()
    await page.waitForFunction(() => document.querySelector('.improve-last')?.textContent?.includes('só regras') && document.querySelector('.improve-last')?.textContent?.includes('A análise por IA falhou'), null, { timeout: 60000 })
    const bodyFallback = fs.readFileSync(reviewPages()[0], 'utf8')
    check('model failure falls back to the rules-only report and says why', !bodyFallback.includes('## Análise') && bodyFallback.includes('A análise por IA falhou'))

    // cancel while the analyst is "thinking"
    proxyMode = 'hang'
    const historyBefore = (await status(projectId)).history.length
    await page.locator('button', { hasText: 'Revisar melhorias' }).click()
    await page.waitForSelector('.improve-progress', { timeout: 10000 })
    const progress = await page.locator('.improve-progress').innerText()
    await shot('07-analisando')
    await page.locator('button', { hasText: 'Cancelar' }).first().click()
    await page.waitForFunction(() => !document.querySelector('.improve-progress') && document.querySelector('.improve-last .badge')?.textContent?.includes('cancelada'), null, { timeout: 15000 })
    const afterCancel = await status(projectId)
    check('cancel stops the run, shows progress while running and keeps the previous page', progress.includes('O analista') && afterCancel.last.state === 'cancelled' && afterCancel.history.length === historyBefore + 1 && fs.readFileSync(reviewPages()[0], 'utf8') === bodyFallback, progress)

    // a second start while one is running is refused
    proxyMode = 'hang'
    const first = await page.evaluate(async (id) => window.openclod.improvements.start(id, { useAi: true }), projectId)
    const second = await page.evaluate(async (id) => window.openclod.improvements.start(id, { useAi: true }), projectId)
    check('second concurrent start is refused', first.ok && !second.ok && String(second.error).includes('em andamento'), second.error)
    await page.evaluate(async () => window.openclod.improvements.cancel())
    await page.waitForFunction(async (id) => !(await window.openclod.improvements.status(id)).value.current, projectId, { timeout: 10000 })
    proxyMode = 'ok'

    results.usage = await e2e.usageOf(page, session.sessionId)
    results.proxyCalls = proxyRequests.map((request) => request.mode)
    results.errors = errors
    check('no console or page errors', errors.length === 0, errors.slice(0, 5))
    results.ok = ok()
    const failed = Object.values(checks).filter((value) => value !== 'ok')
    console.log(`\n${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} verificações passaram`)
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(results, null, 2))
  } finally {
    for (const socket of sockets) socket.destroy()
    try { proxy.close() } catch {}
    app.cleanup()
  }
  process.exit(results.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  try { proxy.close() } catch {}
  process.exit(2)
})
