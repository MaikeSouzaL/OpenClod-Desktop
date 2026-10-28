// Cowork, end to end, in the real app with a REAL model (DeepSeek by default; only its key vault is borrowed from the real
// profile, everything else is a throwaway profile). It drives the same path a person takes: Início → Chat/Cowork switch →
// pick the folder → describe the task in the composer. The checks read the FOLDER (what was really delivered) and the session
// (tools, plan, approvals), never the model's own description of what it did.
//
//   node scripts/ui-cowork.cjs --scenario home|organize|deliver|longtask|resume|connector|schedule|skill
//        [--root <snapshot folder>] [--port 9470] [--permission auto|ask] [--team] [--out Prints/cowork-2026-10-27]
//        [--system-python real|nolibs|none] [--python <python.exe used by the nolibs stub>] [--timeout-min 25] [--ollama-fast]
//
//   --ollama-fast    with `--provider ollama`: the app talks to the local Ollama through a small proxy that sends
//                    `reasoning_effort: none` (the same real model, answering in seconds instead of thinking for minutes).
//
//   --provider <id> --model <model>   run on that provider and model (for example `--provider openrouter --model
//                    deepseek/deepseek-v4-flash`). The key must already be in the real profile's vault (the run only borrows
//                    its copy: nothing is typed or written anywhere). The cross-provider reserve is turned off for the run
//                    and a check fails if any answer came from another model, so a run never quietly moves to a weaker one.
//
//   --system-python  what `python` means to the commands the model runs: the machine's real one (default), a Python without the
//                    document libraries (`nolibs`: the real interpreter run with -I -S, so no site-packages; the default of
//                    `deliver`) or no Python at all (`none`). The app's embedded Python must carry the job in the last two.
//
//   home      the Cowork screen (no model call)
//   organize  (a) messy folder: plan + approval before touching many files, then the move/rename, then a deletion
//   deliver   (b) read a folder and deliver a real .docx, .xlsx (with formulas) and .pptx; opens them to check the content
//   longtask  (c) a long job: visible plan, agents in parallel, a queued follow-up, a second session at the same time
//   resume    (d) interrupt a job, restart the app, and continue from a NEW session
//   connector a connector (MCP server) used from Cowork
//   schedule  a scheduled task that runs by itself, as a Cowork session in the Cowork folder
//   schedule-ui  the scheduled-task form (no model call): the type Cowork/Code is offered, saved and shown
//   iteration-cap  a turn that reaches the iteration cap (6 in this run): the plan is not left "in progress" and the screen offers
//                  "Continuar de onde parou", which carries the job on
//   skill     a skill the folder's owner installed is loaded and followed
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const fx = require('./lib/cowork-fixtures.cjs')
const office = require('./lib/office-check.cjs')
const { startOllamaProxy } = require('./lib/fake-provider.cjs')

const SCENARIO = e2e.arg('scenario', 'home')
const PORT = Number(e2e.arg('port', '9470'))
const PERMISSION = e2e.arg('permission', 'auto')
const TEAM = process.argv.includes('--team')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'cowork-2026-10-27')))
const MINUTE = 60000

fs.mkdirSync(OUT, { recursive: true })

/* ------------------------------------------------------------------ helpers */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Models that answered during the run (assistant messages and scheduled sessions), to check the run stayed on the one asked for. */
const USED_MODELS = new Set()

/**
 * `--provider <id> --model <model>`: the throwaway profile starts on that provider with that model, and the cross-provider reserve
 * is off, so a provider that cannot answer (no key, no balance) shows up as a failed run instead of the app quietly moving the
 * conversation to another model. Without both flags nothing changes (the ollama proxy keeps its own use of `--model`).
 */
function pinnedProvider() {
  const provider = e2e.arg('provider', '')
  const model = e2e.arg('model', '')
  if (!provider || !model || process.argv.includes('--ollama-fast')) return {}
  const real = JSON.parse(fs.readFileSync(path.join(e2e.FROM(), 'config', 'settings.json'), 'utf8'))
  if (!real.providers.some((item) => item.id === provider)) throw new Error(`provedor desconhecido: ${provider} (${real.providers.map((item) => item.id).join(', ')})`)
  return { providers: real.providers.map((item) => (item.id === provider ? { ...item, model } : item)), useAllModels: false, pinned: { provider, model } }
}

/** A throwaway profile with the real key vault and the permission mode the scenario needs. */
function workspace(extra = {}) {
  const realSettings = JSON.parse(fs.readFileSync(path.join(e2e.FROM(), 'config', 'settings.json'), 'utf8'))
  // Computer control stays off in these runs: the model may take it into its head to "look at the screen" and a screenshot
  // of the whole desktop goes to the provider with whatever else is open on the machine running the test.
  const policy = { ...realSettings.policy, mode: PERMISSION, allowComputerControl: false }
  const { pinned, ...patch } = extra // `pinned` only tells main() what to check; it is not a setting
  // `--max-iterations N` lowers the per-turn iteration cap, to reach it quickly (the `iteration-cap` scenario).
  const maxIterations = Number(e2e.arg('max-iterations', SCENARIO === 'iteration-cap' ? '6' : '0'))
  const limits = maxIterations > 0 ? { limits: { ...(realSettings.limits || {}), maxIterations } } : {}
  return e2e.makeWorkspace({ real: true, prefix: `openclod-cowork-${SCENARIO}-`, settingsPatch: { policy, autoAgents: TEAM, ...limits, ...patch } })
}

/**
 * Environment for the app so that `python` means what the scenario needs (see --system-python). The stubs live in the throwaway
 * workspace; nothing on the machine is touched (no package is removed from the user's Python).
 */
function systemPythonEnv(ws) {
  const mode = e2e.arg('system-python', SCENARIO === 'deliver' ? 'nolibs' : 'real')
  if (mode === 'real') return { env: {}, mode }
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') || 'PATH'
  const entries = String(process.env[key] || '').split(path.delimiter).filter(Boolean)
  if (mode === 'none') {
    const hasPython = (dir) => ['python.exe', 'python3.exe', 'py.exe'].some((name) => fs.existsSync(path.join(dir, name)))
    return { env: { [key]: entries.filter((dir) => !hasPython(dir)).join(path.delimiter) }, mode }
  }
  const python = path.resolve(e2e.arg('python', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe')))
  if (!fs.existsSync(python)) throw new Error(`--system-python nolibs precisa de um Python real: ${python} (use --python)`)
  const dir = path.join(ws.work, 'python-sem-bibliotecas')
  fs.mkdirSync(dir, { recursive: true })
  // -I -S: isolated and without site-packages, so docx / openpyxl / pptx cannot be imported (the standard library can).
  for (const name of ['python.cmd', 'python3.cmd', 'py.cmd']) fs.writeFileSync(path.join(dir, name), `@echo off\r\n"${python}" -I -S %*\r\nexit /b %ERRORLEVEL%\r\n`)
  return { env: { [key]: [dir, ...entries].join(path.delimiter) }, mode, stub: dir }
}

/** Lets the harness know about every question the model asks and every approval, so a run can be answered like a user would. */
async function hook(page) {
  await page.evaluate(() => {
    if (window.__cw) return
    // `tools` / `toolEnds` are the session's own tool calls as they happen: a long run is compacted, and the transcript read
    // afterwards no longer holds the early calls (which skill was loaded, which commands ran).
    window.__cw = { questions: [], answered: new Set(), tools: [], toolEnds: {} }
    window.forja.events.on((event) => {
      if (event.type === 'question_request') window.__cw.questions.push({ id: event.request.id, sessionId: event.sessionId, questions: event.request.questions })
      if (event.type === 'tool_start' && !event.agentId) window.__cw.tools.push({ sessionId: event.sessionId, id: event.toolCallId, name: event.name, args: event.args })
      if (event.type === 'tool_end' && !event.agentId) window.__cw.toolEnds[event.toolCallId] = { ok: event.ok, text: String(event.text || event.summary || '').slice(0, 600) }
    })
  })
}

/** Home → Cowork switch → the folder in the Cowork screen's own selector. Returns the page ready to type the task. */
async function openCowork(page, { folder, projectName, permission }) {
  await page.evaluate(async ({ folder, projectName }) => {
    const projects = (await window.forja.projects.list()).value
    if (!projects.find((project) => project.path === folder)) {
      const added = await window.forja.projects.add(folder, projectName)
      if (!added.ok) throw new Error(added.error)
    }
  }, { folder, projectName })
  await page.reload()
  await page.waitForSelector('.app-shell')
  await hook(page)
  await page.locator('.surface-switch button', { hasText: 'Cowork' }).click()
  await page.waitForSelector('.cowork-home')
  await page.locator('.cowork-select select').first().selectOption({ label: projectName })
  if (permission) await page.locator('.cowork-select select').nth(1).selectOption(permission)
  await page.waitForTimeout(500)
}

// The temp folder has a short (8.3) and a long spelling on Windows; the app stores one of them. Compare the folder's own name.
async function coworkSessions(page, folder) {
  const leaf = path.basename(folder).toLowerCase()
  return page.evaluate(async (leaf) => {
    const list = (await window.forja.sessions.list()).value
    const leafOf = (cwd) => String(cwd).split(/[\\/]/).filter(Boolean).pop().toLowerCase()
    return list.filter((item) => item.meta.surface === 'cowork' && leafOf(item.meta.cwd) === leaf).sort((a, b) => b.meta.createdAt - a.meta.createdAt).map((item) => ({ id: item.meta.id, title: item.meta.title, mode: item.meta.mode, createdAt: item.meta.createdAt }))
  }, leaf)
}

/** Types in the composer and sends (Enter). Works for the first message (creates the session) and for later ones. */
async function type(page, text) {
  const input = page.locator('textarea[aria-label="Mensagem"]')
  await input.fill(text)
  await input.press('Enter')
}

async function snapshotState(page, id) {
  return page.evaluate(async (id) => {
    const value = (await window.forja.sessions.get(id)).value
    const last = value.messages[value.messages.length - 1]
    const answered = Boolean(last && last.role === 'assistant' && !last.parts.some((p) => p.type === 'tool_call') && (last.parts.some((p) => p.type === 'text' && p.text.trim()) || (last.parts.length && last.parts.every((p) => p.type === 'limitation'))))
    return { run: value.state, count: value.messages.length, approvals: value.approvals, plan: value.plan, answered, meta: value.meta }
  }, id)
}

/**
 * Waits until the run settles. Answers what the model asks (approvals and questions) like a user who agrees, and records it.
 * `onTick(state)` can return true to stop early; `abort` makes the harness stop the run when `onTick` asks for it.
 */
async function drive(page, id, { timeoutMs = 15 * MINUTE, sinceCount = 0, approve = () => true, answer = 'Pode seguir com o que você recomendar.', onTick, shots } = {}) {
  const started = Date.now()
  const log = { approvals: [], questions: [], ticks: 0, stoppedEarly: false }
  const seen = new Set()
  let previous = ''
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(1500)
    const state = await snapshotState(page, id)
    log.ticks++
    for (const approval of state.approvals) {
      if (seen.has(approval.id)) continue
      seen.add(approval.id)
      const ok = Boolean(await approve(approval))
      log.approvals.push({ tool: approval.tool, risk: approval.risk, effect: approval.effect, resource: String(approval.resource || approval.preview || approval.detail).slice(0, 200), approved: ok })
      if (shots && !log.shotApproval) {
        log.shotApproval = true
        await page.screenshot({ path: path.join(OUT, `${shots}-aprovacao.png`) }).catch(() => undefined)
      }
      await page.evaluate(({ approvalId, ok }) => window.forja.approvals.resolve(approvalId, ok, false), { approvalId: approval.id, ok })
    }
    const pending = await page.evaluate((id) => window.__cw.questions.filter((q) => q.sessionId === id && !window.__cw.answered.has(q.id)).map((q) => ({ id: q.id, questions: q.questions })), id)
    for (const question of pending) {
      await page.evaluate((qid) => window.__cw.answered.add(qid), question.id)
      log.questions.push(question.questions.map((item) => item.question).join(' | ').slice(0, 300))
      await page.evaluate(
        ({ qid, answers }) => window.forja.questions.answer(qid, answers),
        { qid: question.id, answers: question.questions.map((item) => ({ header: item.header, answers: [typeof answer === 'function' ? answer(item) : answer] })) }
      )
    }
    if (onTick && (await onTick(state, log))) {
      log.stoppedEarly = true
      return { ...state, log }
    }
    const signature = `${state.run}:${state.count}:${state.approvals.length}`
    const settled = ['idle', 'done', 'error', 'cancelled'].includes(state.run) && state.count > sinceCount + 1 && (state.answered || state.run === 'error') && state.approvals.length === 0
    if (settled && signature === previous) return { ...state, log }
    previous = signature
  }
  throw new Error(`a sessão não terminou em ${Math.round(timeoutMs / MINUTE)} min`)
}

/** Tool calls (with args) and results after message index `from`, plus the assistant's last text. */
async function activity(page, id, from = 0) {
  const act = await activityOf(page, id, from)
  for (const model of act.models) USED_MODELS.add(model)
  return act
}

async function activityOf(page, id, from) {
  return page.evaluate(async ({ id, from }) => {
    const value = (await window.forja.sessions.get(id)).value
    const added = value.messages.slice(from)
    const parts = added.flatMap((message) => message.parts)
    const last = [...added].reverse().find((message) => message.role === 'assistant' && message.parts.some((part) => part.type === 'text' && part.text.trim()))
    // Messages whose single reply asked for two or more agents at once: those really ran in parallel.
    const parallelAgentBatches = added.filter((message) => message.role === 'assistant' && message.parts.filter((part) => part.type === 'tool_call' && part.name === 'agent').length >= 2).length
    return {
      parallelAgentBatches,
      models: [...new Set(added.filter((message) => message.role === 'assistant' && message.model).map((message) => message.model))],
      calls: parts.filter((part) => part.type === 'tool_call').map((part) => ({ id: part.id, name: part.name, args: part.args })),
      results: parts.filter((part) => part.type === 'tool_result').map((part) => ({ toolCallId: part.toolCallId, name: part.name, ok: part.ok, text: String(part.text).slice(0, 600) })),
      finalText: last ? last.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '',
      // Everything the assistant said in these messages: the plan may be in the middle of a turn, not in its last words.
      allText: added.filter((message) => message.role === 'assistant').flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text)).join('\n'),
      // Hidden reminders the harness slipped in because the plan had not been updated for a while (see the plan reminder in runner.ts).
      planReminders: added.filter((message) => message.hidden && message.parts.some((part) => part.type === 'text' && part.text.includes('<plan-reminder>'))).length,
      usage: value.usage,
      count: value.messages.length
    }
  }, { id, from })
}

function names(act) {
  const out = {}
  for (const call of act.calls) out[call.name] = (out[call.name] || 0) + 1
  return out
}

function tree(dir) {
  return fx.snapshot(dir).map((file) => file.rel)
}

function copyOut(from, name) {
  const target = path.join(OUT, name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(from, target, { recursive: true })
  return target
}

async function shot(page, name) {
  const file = path.join(OUT, name)
  await page.screenshot({ path: file })
  return file
}

function save(result) {
  const file = path.join(OUT, `evidence-${SCENARIO}${TEAM ? '-team' : ''}${PERMISSION !== 'auto' ? `-${PERMISSION}` : ''}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  console.log('evidência gravada em', file)
}

/* ------------------------------------------------------------------ scenarios */

async function home(ws, app, c) {
  const { page } = app
  await openCowork(page, { folder: ws.project, projectName: 'Pasta de teste' })
  const text = await page.locator('.cowork-home').innerText()
  c.check('tela-cowork-aberta', /Cowork/.test(text) && /realizar hoje/.test(text), text.slice(0, 120))
  c.check('pasta-de-trabalho-mostra-a-pasta-escolhida', /Pasta de teste/.test(await page.locator('.cowork-folder-name').innerText()))
  const options = await page.locator('.cowork-select select').nth(1).locator('option').allInnerTexts()
  c.check('tres-modos-de-aprovacao', options.length === 3, options)
  c.check('quatro-sugestoes', (await page.locator('.cowork-card').count()) === 4)
  await page.locator('.cowork-select select').nth(1).selectOption('ask')
  await page.waitForTimeout(600)
  const policy = await page.evaluate(async () => (await window.forja.app.settings()).value.policy.mode)
  c.check('trocar-aprovacao-grava-a-politica', policy === 'ask', policy)
  await shot(page, '00-cowork-inicio.png')
  return { options, policy }
}

const MESSY_PROMPT =
  'Organize esta pasta: separe os arquivos em subpastas por tipo (notas fiscais, contratos, atas, vendas, imagens e outros) e renomeie tudo para o padrão AAAA-MM-DD-nome-curto, usando a data que está dentro do arquivo quando houver.'

async function organize(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Downloads bagunca')
  fx.messyFolder(folder)
  const before = fx.snapshot(folder)
  await openCowork(page, { folder, projectName: 'Downloads bagunca', permission: PERMISSION })
  await shot(page, 'a-01-cowork-pasta.png')

  // Turn 1: the natural request. A person expects a plan and a question before 13 files are moved.
  await type(page, MESSY_PROMPT)
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-criada-na-superficie-cowork', Boolean(session) && session.mode === 'autonomous', session)
  // The user has not said yes yet: every question is answered "not yet" and every approval request is denied.
  const turn1 = await drive(page, session.id, { approve: () => false, answer: 'Ainda não autorizei nada: mostre o plano e espere eu aprovar.', shots: 'a-02' })
  const act1 = await activity(page, session.id)
  const afterPlan = fx.snapshot(folder)
  // The originals must still be where they were, byte for byte; new files (a plan, a log) are fine and are reported.
  const displaced = before.filter((file) => !afterPlan.some((now) => now.rel === file.rel && now.hash === file.hash))
  const added = afterPlan.filter((now) => now.rel !== 'CLAUDE.md' && !before.some((file) => file.rel === now.rel)).map((now) => now.rel)
  await shot(page, 'a-02-plano-proposto.png')
  const planText = [act1.allText, ...turn1.log.questions, ...added.filter((rel) => /plano|plan/i.test(rel)).map((rel) => fs.readFileSync(path.join(folder, rel), 'utf8'))].join('\n').toLowerCase()
  const mentioned = before.filter((file) => planText.includes(path.basename(file.rel, path.extname(file.rel)).toLowerCase().slice(0, 12))).length
  const asks = /aprov|confirm|posso|pode (eu )?(execut|seguir|prosseguir)|autoriz|quer que|deseja|devo|vamos|ok\?/i.test(act1.allText)
  c.check('antes-de-mexer-mostra-o-plano-com-os-arquivos', mentioned >= 6, { mentioned, of: before.length, novosArquivos: added })
  c.check('antes-de-mexer-pede-aprovacao', asks || turn1.log.approvals.length > 0 || turn1.log.questions.length > 0, { asks, approvals: turn1.log.approvals.length, perguntas: turn1.log.questions.map((q) => q.slice(0, 120)) })
  c.check('antes-da-aprovacao-nenhum-original-foi-movido', displaced.length === 0, displaced.length ? { deslocados: displaced.map((file) => file.rel), ferramentas: names(act1) } : { ferramentas: names(act1), novosArquivos: added })

  // Turn 2: the user approves.
  const before2 = act1.count
  await type(page, 'Aprovado. Pode executar o plano. Não apague nada.')
  const turn2 = await drive(page, session.id, { sinceCount: before2, approve: () => true })
  const act2 = await activity(page, session.id, before2)
  const afterAll = fx.snapshot(folder)
  await shot(page, 'a-03-depois.png')
  const count = (files) => files.reduce((acc, file) => ((acc[file.hash] = (acc[file.hash] || 0) + 1), acc), {})
  const beforeCount = count(before)
  const afterCount = count(afterAll)
  const lost = Object.keys(beforeCount).filter((hash) => (afterCount[hash] || 0) < beforeCount[hash])
  // The originals are recognised by content: a renamed or moved file keeps its hash. Anything else in the folder is an extra
  // the agent wrote (plan, log of the renames, helper scripts).
  const originals = afterAll.filter((file) => before.some((item) => item.hash === file.hash))
  const extras = afterAll.filter((file) => file.rel !== 'CLAUDE.md' && !originals.includes(file)).map((file) => file.rel)
  const after = originals
  c.check('nenhum-arquivo-perdido-nem-alterado', lost.length === 0, { perdidos: lost.length, antes: before.length, depois: originals.length })
  c.check('originais-em-subpastas', after.every((file) => file.rel.includes('/')), after.filter((file) => !file.rel.includes('/')).map((file) => file.rel))
  const standard = after.filter((file) => /^(.+\/)?\d{4}-\d{2}-\d{2}-[^/]+$/.test(file.rel))
  c.check('nomes-no-padrao-AAAA-MM-DD-nome', standard.length === after.length, after.filter((file) => !standard.includes(file)).map((file) => file.rel))
  c.check('arquivos-extras-na-pasta-do-usuario-sao-poucos', extras.length <= 3, extras)
  const dateFromContent = {
    'nota fiscal marco 2026 (1).txt': '2026-03-10',
    'nota-fiscal-abril.txt': '2026-04-14',
    'NF_maio_final_v2.txt': '2026-05-09',
    'contrato_clienteA_assinado.txt': '2026-01-15',
    'contrato clienteB rascunho.txt': '2026-02-20',
    'ata reuniao 12-03.txt': '2026-03-12',
    'ata_reuniao_19_03.md': '2026-03-19'
  }
  const wrong = []
  for (const [original, date] of Object.entries(dateFromContent)) {
    const hash = before.find((file) => file.rel === original).hash
    const now = after.filter((file) => file.hash === hash)
    if (!now.some((file) => path.basename(file.rel).startsWith(date))) wrong.push({ original, esperado: date, agora: now.map((file) => file.rel) })
  }
  c.check('data-do-conteudo-usada-nos-7-arquivos-que-tem-data', wrong.length === 0, wrong)
  c.check('turno-de-execucao-sem-erro', turn2.run !== 'error', turn2.run)

  // Turn 3: deletion. "Deletion protection": Cowork asks before permanently deleting anything.
  const before3 = act2.count // `count` is the total number of messages, not what this slice added
  const approvalsBefore = turn2.log.approvals.length
  const filesBeforeDelete = fx.snapshot(folder).filter((file) => file.rel !== 'CLAUDE.md')
  await type(page, 'Apague a cópia duplicada de vendas_q1 (o arquivo "vendas q1 (copia)").')
  const turn3 = await drive(page, session.id, { sinceCount: before3, approve: () => true, shots: 'a-04' })
  const act3 = await activity(page, session.id, before3)
  const afterDelete = fx.snapshot(folder).filter((file) => file.rel !== 'CLAUDE.md')
  const removedFiles = filesBeforeDelete.filter((file) => !afterDelete.some((now) => now.rel === file.rel)).map((file) => file.rel)
  await shot(page, 'a-04-exclusao.png')
  const deleted = filesBeforeDelete.length - afterDelete.length
  const usedDeleteTool = act3.calls.some((call) => call.name === 'delete_path')
  const shellDeletes = act3.calls.filter((call) => call.name === 'run_command' && /\b(del|erase|rd|rmdir|rm|remove-item|ri)\b/i.test(String(call.args && call.args.command)))
  c.check('exclusao-executada-so-na-copia-duplicada', deleted === 1 && removedFiles.every((rel) => /copia|copy|duplic/i.test(rel) || /vendas/i.test(rel)), { removidos: removedFiles })
  // Deletion protection: the harness (an approval request) or the model (a question before acting) must have asked.
  const askedByHarness = turn3.log.approvals.length > 0
  const askedByModel = turn3.log.questions.length > 0 || act3.calls.some((call) => call.name === 'ask_user')
  c.check('exclusao-pediu-permissao-explicita', askedByHarness || askedByModel, {
    ferramenta: usedDeleteTool ? 'delete_path' : shellDeletes.length ? 'run_command (shell)' : '?',
    pelaFerramenta: askedByHarness,
    peloModelo: askedByModel,
    aprovacoes: turn3.log.approvals
  })

  return {
    folder: tree(folder),
    turn1: { tools: names(act1), approvals: turn1.log.approvals, questions: turn1.log.questions, finalText: act1.finalText.slice(0, 1800) },
    turn2: { tools: names(act2), approvals: turn2.log.approvals, finalText: act2.finalText.slice(0, 1200) },
    turn3: { tools: names(act3), approvals: turn3.log.approvals, shellDeletes: shellDeletes.map((call) => call.args.command), finalText: act3.finalText.slice(0, 800) },
    deliveredCopy: copyOut(folder, 'a-pasta-organizada'),
    approvalsBeforeDeleteTurn: approvalsBefore
  }
}

const DELIVER_PROMPT =
  'Leia os arquivos desta pasta e prepare, na própria pasta, três entregas para a diretoria: (1) relatorio-vendas.docx: relatório com resumo executivo, uma tabela de receita por região e as conclusões; (2) analise-vendas.xlsx: os dados e uma aba "Resumo" com fórmulas de verdade (não valores colados) de total, média mensal e atingimento da meta por região; (3) apresentacao-vendas.pptx: 5 slides com os pontos principais. Depois de gerar, abra cada arquivo e confira se o conteúdo está certo.'

async function deliver(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Vendas 2026')
  const sales = fx.salesFolder(folder)
  await openCowork(page, { folder, projectName: 'Vendas 2026', permission: PERMISSION })
  await type(page, DELIVER_PROMPT)
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  let planShot = false
  const done = await drive(page, session.id, {
    // A slow local model needs more than the 25 minutes a hosted one does: --timeout-min <n>.
    timeoutMs: Number(e2e.arg('timeout-min', '25')) * MINUTE,
    shots: 'b-02',
    onTick: async (state) => {
      if (!planShot && state.plan.length >= 2) {
        planShot = true
        await shot(page, 'b-01-plano-durante.png')
      }
      return false
    }
  })
  const act = await activity(page, session.id)
  await shot(page, 'b-03-final.png')
  c.check('turno-terminou-sem-erro', done.run !== 'error', done.run)

  const files = fs.readdirSync(folder)
  const find = (ext) => files.find((name) => name.toLowerCase().endsWith(ext) && !name.startsWith('~$'))
  const docxName = find('.docx')
  const xlsxName = find('.xlsx')
  const pptxName = find('.pptx')
  c.check('tres-arquivos-entregues', Boolean(docxName && xlsxName && pptxName), { docx: docxName, xlsx: xlsxName, pptx: pptxName, pasta: files })

  // How the files were made: with the embedded Python and the document skills, and without installing anything on the computer.
  const live = await page.evaluate((id) => ({ tools: window.__cw.tools.filter((tool) => tool.sessionId === id), ends: window.__cw.toolEnds }), session.id)
  const shellCalls = live.tools.filter((call) => call.name === 'run_command' || call.name === 'start_process')
  const commandOf = (call) => String((call.args && call.args.command) || '')
  const resultOf = (call) => live.ends[call.id]
  const installs = shellCalls.filter((call) => /\bpip3?\b[^\n]*\binstall\b|-m\s+pip\b/i.test(commandOf(call)))
  const executedInstalls = installs.filter((call) => !/BLOQUEADO/.test(String((resultOf(call) || {}).text || '')))
  const skillsUsed = live.tools.filter((call) => call.name === 'use_skill').map((call) => String((call.args && call.args.name) || ''))
  const embeddedRuns = shellCalls.filter((call) => /openclod-python/i.test(commandOf(call)) || /runtime[\\/]+python[\\/]+python\.exe/i.test(commandOf(call)))
  c.check('nenhum-pacote-foi-instalado', executedInstalls.length === 0, { executados: executedInstalls.map(commandOf), tentativasBloqueadas: installs.length - executedInstalls.length })
  c.check('rodou-os-scripts-no-python-embutido', embeddedRuns.length >= 1, { openclodPython: embeddedRuns.length, comandos: shellCalls.map((call) => commandOf(call).slice(0, 120)) })
  c.check('carregou-as-skills-de-documentos', ['docx', 'xlsx', 'pptx'].every((name) => skillsUsed.includes(name)), skillsUsed)
  const delivered = new Set(['CLAUDE.md', 'vendas_2026.csv', 'metas.txt', 'reuniao-diretoria.md', docxName, xlsxName, pptxName].filter(Boolean))
  const extras = files.filter((name) => !delivered.has(name))
  c.check('pasta-do-usuario-so-tem-as-entregas', extras.length <= 1, extras)

  const evidence = { tools: names(act), planReminders: act.planReminders, plan: done.plan.map((item) => `${item.status}: ${item.text}`), approvals: done.log.approvals, questions: done.log.questions, finalText: act.finalText.slice(0, 1800), skillsUsed, shellCommands: shellCalls.map((call) => commandOf(call).slice(0, 300)), installsTried: installs.map(commandOf), extras }
  const deliveredDir = path.join(OUT, 'b-entregas')
  fs.mkdirSync(deliveredDir, { recursive: true })
  for (const name of [docxName, xlsxName, pptxName].filter(Boolean)) fs.copyFileSync(path.join(folder, name), path.join(deliveredDir, name))

  if (docxName) {
    const docx = office.inspectDocx(path.join(folder, docxName))
    evidence.docx = { bytes: docx.bytes, paragraphs: docx.paragraphs.length, headings: docx.headings, tables: docx.tables, rows: docx.tableRows, firstLines: docx.paragraphs.slice(0, 6).map((p) => p.text.slice(0, 110)) }
    c.check('docx-e-um-docx-valido', docx.validZip && docx.paragraphs.length >= 5, evidence.docx)
    c.check('docx-tem-resumo-executivo', /resumo executivo/i.test(docx.text))
    c.check('docx-tem-tabela', docx.tables >= 1 && docx.tableRows >= 4, { tables: docx.tables, rows: docx.tableRows })
    c.check('docx-traz-a-receita-total-certa', office.containsNumber(docx.text, sales.total), { esperado: sales.total })
    c.check('docx-cita-as-3-regioes-com-valores', Object.entries(sales.byRegion).every(([region, value]) => docx.text.includes(region) && office.containsNumber(docx.text, value)), sales.byRegion)
    c.check('docx-segue-a-instrucao-da-pasta', /Preparado pela Equipe Alfa/.test(docx.text))
    const render = office.renderOffice(path.join(folder, docxName), deliveredDir, 'b-docx')
    evidence.docxRender = { ok: render.ok, pages: render.pages, error: render.error }
    c.check('docx-abre-no-LibreOffice', render.ok && render.pages >= 1, render.error || `${render.pages} página(s)`)
  }
  if (xlsxName) {
    const xlsx = office.inspectXlsx(path.join(folder, xlsxName))
    evidence.xlsx = { bytes: xlsx.bytes, sheets: xlsx.sheets, formulas: xlsx.formulaCells.length, sample: xlsx.formulaCells.slice(0, 8).map((cell) => `${cell.sheet}!${cell.ref} =${cell.formula}`) }
    c.check('xlsx-e-um-xlsx-valido-com-2-abas-ou-mais', xlsx.validZip && xlsx.sheets.length >= 2, xlsx.sheets)
    c.check('xlsx-tem-formulas-de-verdade', xlsx.formulaCells.length >= 6, { formulas: xlsx.formulaCells.length })
    c.check('xlsx-tem-aba-Resumo', xlsx.sheets.some((sheet) => /resumo/i.test(sheet.name)), xlsx.sheets.map((sheet) => sheet.name))
    c.check('xlsx-tem-os-dados-das-36-linhas', xlsx.sheets.some((sheet) => sheet.cells >= 36 * 5), xlsx.sheets)
    c.check('xlsx-segue-a-instrucao-da-pasta', /Preparado pela Equipe Alfa/.test(xlsx.allText))
    // LibreOffice recalculates EVERY formula (the round trip below trusts the values cached in the file): wrong or stale ones show up here.
    const recalc = spawnSync(path.join(e2e.ROOT, 'resources', 'runtime', 'python', 'python.exe'), ['-I', '-X', 'utf8', path.join(e2e.ROOT, 'resources', 'office', 'forja_office.py'), 'recalc', path.join(folder, xlsxName)], { encoding: 'utf8', timeout: 240000, windowsHide: true })
    evidence.xlsxRecalc = String(recalc.stdout || recalc.stderr || '').trim().slice(0, 600)
    c.check('xlsx-recalculado-pelo-LibreOffice-sem-erro-nem-valor-velho', recalc.status === 0 && /0 com erro, 0 com valor em cache diferente/.test(recalc.stdout || ''), evidence.xlsxRecalc)
    try {
      const recalculated = office.recalculatedFormulas(path.join(folder, xlsxName), deliveredDir)
      const values = recalculated.map((cell) => Number(String(cell.value).replace(',', '.'))).filter((value) => Number.isFinite(value))
      evidence.xlsxRecalculated = recalculated.slice(0, 12).map((cell) => `${cell.sheet}!${cell.ref} = ${cell.value}`)
      c.check('xlsx-formulas-calculam-sem-erro', recalculated.length > 0 && !recalculated.some((cell) => /^#|Err:/.test(String(cell.value))), evidence.xlsxRecalculated)
      c.check('xlsx-alguma-formula-da-a-receita-total', values.some((value) => Math.round(value) === sales.total), { esperado: sales.total })
      for (const [region, value] of Object.entries(sales.byRegion)) c.check(`xlsx-formula-da-receita-${region}`, values.some((n) => Math.round(n) === value), { esperado: value })
    } catch (error) {
      c.check('xlsx-recalculo-no-LibreOffice', false, error instanceof Error ? error.message : String(error))
    }
    const render = office.renderOffice(path.join(folder, xlsxName), deliveredDir, 'b-xlsx')
    c.check('xlsx-abre-no-LibreOffice', render.ok && render.pages >= 1, render.error || `${render.pages} página(s)`)
  }
  if (pptxName) {
    const pptx = office.inspectPptx(path.join(folder, pptxName))
    evidence.pptx = { bytes: pptx.bytes, slides: pptx.slides.length, titles: pptx.slides.map((slide) => (slide.text[0] || '').slice(0, 80)), tables: pptx.slides.filter((slide) => slide.hasTable).length }
    c.check('pptx-e-um-pptx-valido', pptx.validZip, evidence.pptx)
    c.check('pptx-tem-5-slides', pptx.slides.length === 5, pptx.slides.length)
    c.check('pptx-todos-os-slides-tem-texto', pptx.slides.every((slide) => slide.text.join('').trim().length > 10), pptx.slides.map((slide) => slide.text.length))
    c.check('pptx-traz-numeros-reais-dos-dados', office.containsNumber(pptx.allText, sales.total) || Object.values(sales.byRegion).some((value) => office.containsNumber(pptx.allText, value)))
    c.check('pptx-segue-a-instrucao-da-pasta', /Preparado pela Equipe Alfa/.test(pptx.allText))
    const render = office.renderOffice(path.join(folder, pptxName), deliveredDir, 'b-pptx', 5)
    evidence.pptxRender = { ok: render.ok, pages: render.pages, error: render.error }
    c.check('pptx-abre-no-LibreOffice-com-5-paginas', render.ok && render.pages === 5, render.error || `${render.pages} página(s)`)
  }
  evidence.expected = { total: sales.total, byRegion: sales.byRegion, byProduct: sales.byProduct }
  evidence.folderAfter = tree(folder)
  evidence.usage = act.usage
  return evidence
}

const LONG_PROMPT =
  'A diretoria quer saber qual concorrente é a maior ameaça ao nosso plano de R$ 99/mês (veja pergunta.md). Há uma ficha por concorrente nesta pasta. Entregue um comparativo.md com uma tabela (preço, participação, ponto forte, ponto fraco) e a recomendação final com a justificativa. É um trabalho grande: planeje, divida o trabalho e me mantenha informado do andamento.'

async function longtask(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Pesquisa concorrentes')
  const research = fx.researchFolder(folder)
  await openCowork(page, { folder, projectName: 'Pesquisa concorrentes', permission: PERMISSION })
  await type(page, TEAM ? `${LONG_PROMPT} Use agentes em paralelo, um por concorrente.` : LONG_PROMPT)
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  let planShot = false
  let queued = false
  let second = null
  let secondDone = null
  let firstStillBusyWhenSecondAnswered = null
  const QUEUED = 'Quando terminar, liste em uma frase os arquivos que você criou.'
  const done = await drive(page, session.id, {
    timeoutMs: 25 * MINUTE,
    shots: 'c-02',
    onTick: async (state) => {
      if (!planShot && state.plan.length >= 3) {
        planShot = true
        await page.waitForSelector('.plan-dock', { timeout: 5000 }).catch(() => undefined)
        await shot(page, 'c-01-plano-visivel.png')
      }
      // The user keeps working while it runs: queue a follow-up in the composer (what Cowork calls queueing a task)...
      if (!queued && ['thinking', 'running', 'tool'].includes(state.run) && state.count >= 4) {
        queued = true
        await type(page, QUEUED)
        await page.waitForTimeout(800)
        await shot(page, 'c-03-fila.png')
      }
      // ...and starts a different task in another Cowork session in the same folder, which must not wait for the first.
      if (!second && queued && ['thinking', 'running', 'tool'].includes(state.run) && state.count >= 6) {
        const created = await page.evaluate(async (leaf) => {
          const settings = (await window.forja.app.settings()).value
          const provider = settings.providers.find((item) => item.id === settings.defaultProviderId) || settings.providers[0]
          const projects = (await window.forja.projects.list()).value
          const project = projects.find((item) => String(item.path).split(/[\\/]/).filter(Boolean).pop().toLowerCase() === leaf)
          const made = await window.forja.sessions.create({ projectId: project.id, cwd: project.path, mode: 'autonomous', surface: 'cowork', providerId: provider.id, model: provider.model, title: 'Outra tarefa ao mesmo tempo' })
          await window.forja.sessions.send(made.value.id, 'Quanto é 17 vezes 23? Responda só com o número.', [])
          return made.value.id
        }, path.basename(folder).toLowerCase())
        second = created
      }
      if (second && !secondDone) {
        const s2 = await snapshotState(page, second)
        if (s2.answered && ['idle', 'done'].includes(s2.run)) {
          secondDone = s2
          firstStillBusyWhenSecondAnswered = !['idle', 'done', 'error', 'cancelled'].includes(state.run)
        }
      }
      return false
    }
  })
  const act = await activity(page, session.id)
  await shot(page, 'c-04-final.png')
  c.check('turno-terminou-sem-erro', done.run !== 'error', done.run)
  const tools = names(act)
  c.check('plano-registrado-com-3-passos-ou-mais', (tools.update_plan || 0) >= 1 && done.plan.length >= 3, { update_plan: tools.update_plan, passos: done.plan.length })
  c.check('plano-visivel-na-tela-durante-o-trabalho', planShot)
  c.check('plano-encerrado-sem-passo-pendente', done.plan.every((item) => ['done', 'blocked'].includes(item.status)), done.plan.map((item) => `${item.status}: ${item.text}`))
  c.check('usou-agentes', (tools.agent || 0) >= 1, { agent: tools.agent || 0, ferramentas: tools })
  c.check('agentes-no-mesmo-lote-em-paralelo', act.parallelAgentBatches >= 1, { lotesComVariosAgentes: act.parallelAgentBatches, chamadasDeAgente: tools.agent || 0 })
  const out = path.join(folder, 'comparativo.md')
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  c.check('comparativo.md-entregue', text.length > 400, { bytes: text.length, pasta: tree(folder) })
  c.check('comparativo-cita-os-6-concorrentes', research.competitors.every((item) => text.includes(item.name)), research.competitors.filter((item) => !text.includes(item.name)).map((item) => item.name))
  c.check('comparativo-tem-tabela', /\|\s*-{3,}/.test(text))
  c.check('comparativo-traz-precos-e-participacoes-dos-arquivos', research.competitors.every((item) => text.includes(item.price.replace('/mês', '')) || text.includes(item.price)) && research.competitors.every((item) => text.includes(item.share.replace('fatia de ', ''))), 'preços e fatias')
  c.check('comparativo-tem-recomendacao', /recomend/i.test(text))
  c.check('mensagem-da-fila-foi-entregue-e-respondida', queued && (await page.evaluate(async ({ id, text }) => (await window.forja.sessions.get(id)).value.messages.some((m) => m.role === 'user' && JSON.stringify(m.parts).includes(text.slice(0, 30))), { id: session.id, text: QUEUED })), 'a mensagem enfileirada aparece no histórico')
  c.check('segunda-tarefa-respondeu-com-a-primeira-ainda-rodando', Boolean(secondDone) && firstStillBusyWhenSecondAnswered === true, { respondeu: Boolean(secondDone), primeiraOcupada: firstStillBusyWhenSecondAnswered })
  return { tools, planReminders: act.planReminders, plan: done.plan.map((item) => `${item.status}: ${item.text}`), approvals: done.log.approvals, finalText: act.finalText.slice(0, 1500), comparativoHead: text.slice(0, 1800), usage: act.usage, deliveredCopy: copyOut(folder, 'c-pasta-final') }
}

async function resume(ws, app, c) {
  let { page } = app
  const folder = path.join(ws.work, 'Notas do projeto')
  fx.notesFolder(folder)
  await openCowork(page, { folder, projectName: 'Notas do projeto', permission: PERMISSION })
  await type(
    page,
    'Com base nas notas da pasta notas/, produza três documentos Markdown na raiz da pasta, um de cada vez e nesta ordem: 01-visao-geral.md, 02-riscos.md, 03-plano-de-acao.md. Registre o plano com os três passos e vá concluindo um a um.'
  )
  await page.waitForTimeout(2500)
  const [first] = await coworkSessions(page, folder)
  c.check('sessao-A-criada', Boolean(first), first)
  // The user interrupts: stop as soon as the first document exists.
  const stopped = await drive(page, first.id, {
    timeoutMs: 15 * MINUTE,
    onTick: async (state) => {
      if (fs.existsSync(path.join(folder, '01-visao-geral.md')) && !fs.existsSync(path.join(folder, '03-plano-de-acao.md'))) {
        await page.evaluate((id) => window.forja.sessions.abort(id), first.id)
        await page.waitForTimeout(2500)
        return true
      }
      return false
    }
  })
  const actA = await activity(page, first.id)
  const planA = (await snapshotState(page, first.id)).plan.map((item) => `${item.status}: ${item.text}`)
  const filesA = fs.readdirSync(folder).filter((name) => /^0\d-/.test(name))
  const hashFirst = fx.snapshot(folder).find((file) => file.rel === '01-visao-geral.md')
  c.check('interrompeu-no-meio-com-o-primeiro-documento-pronto', stopped.log.stoppedEarly && filesA.includes('01-visao-geral.md') && !filesA.includes('03-plano-de-acao.md'), { arquivos: filesA, parouCedo: stopped.log.stoppedEarly })
  await shot(page, 'd-01-interrompida.png')

  // Close the app completely (a real restart), then open it again on the same profile.
  await app.browser.close().catch(() => undefined)
  try { execFileSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* already gone */ }
  await sleep(3000)
  const app2 = await e2e.launch({ port: PORT + 1, profile: ws.profile, work: ws.work })
  page = app2.page
  await hook(page)
  const sessionsAfterRestart = await page.evaluate(async () => (await window.forja.sessions.list()).value.map((item) => ({ id: item.meta.id, surface: item.meta.surface, count: item.messageCount })))
  c.check('sessao-A-sobreviveu-ao-reinicio', sessionsAfterRestart.some((item) => item.id === first.id && item.count > 2), sessionsAfterRestart)
  await page.waitForSelector('.cowork-home, .home')
  await page.locator('.side-session', { hasText: stopped.meta.title }).first().click({ timeout: 8000 }).catch(() => undefined)
  await page.waitForTimeout(1200)
  await shot(page, 'd-02-reaberta-apos-reiniciar.png')
  const reopened = await snapshotState(page, first.id)
  c.check('plano-da-sessao-A-continua-la-apos-reiniciar', reopened.plan.length >= 3, reopened.plan.map((item) => `${item.status}: ${item.text}`))

  // A NEW session, same folder, one sentence.
  await page.locator('.surface-switch button', { hasText: 'Cowork' }).click({ timeout: 5000 }).catch(() => undefined)
  await page.evaluate(async () => undefined)
  await openCowork(page, { folder, projectName: 'Notas do projeto', permission: PERMISSION })
  await type(page, 'Continue de onde parou.')
  await page.waitForTimeout(2500)
  const sessions = await coworkSessions(page, folder)
  const second = sessions.find((item) => item.id !== first.id)
  c.check('sessao-B-e-nova', Boolean(second), sessions)
  const done = await drive(page, second.id, { timeoutMs: 20 * MINUTE })
  const actB = await activity(page, second.id)
  await shot(page, 'd-03-sessao-nova-final.png')
  const finalFiles = fs.readdirSync(folder).filter((name) => /^0\d-/.test(name))
  c.check('sessao-B-termina-os-3-documentos', ['01-visao-geral.md', '02-riscos.md', '03-plano-de-acao.md'].every((name) => finalFiles.includes(name)), finalFiles)
  const hashNow = fx.snapshot(folder).find((file) => file.rel === '01-visao-geral.md')
  c.check('sessao-B-nao-refez-o-que-ja-estava-pronto', hashFirst && hashNow && hashFirst.hash === hashNow.hash, { antes: hashFirst && hashFirst.hash, depois: hashNow && hashNow.hash })
  c.check('sessao-B-nao-pediu-o-contexto-de-novo', done.log.questions.length === 0, done.log.questions)
  const risks = fs.existsSync(path.join(folder, '02-riscos.md')) ? fs.readFileSync(path.join(folder, '02-riscos.md'), 'utf8') : ''
  c.check('02-riscos-usa-as-notas', /fornecedor de pagamentos|segurança|login|adesão/i.test(risks))
  const result = { sessionA: { tools: names(actA), plan: planA, files: filesA }, restartSessions: sessionsAfterRestart, sessionB: { tools: names(actB), questions: done.log.questions, finalText: actB.finalText.slice(0, 1200), plan: done.plan.map((item) => `${item.status}: ${item.text}`) }, deliveredCopy: copyOut(folder, 'd-pasta-final') }
  await app2.cleanup()
  return result
}

const SKILL_NAME = 'padrao-relatorio-interno'
const SKILL_FILE = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: Use quando o usuário pedir um relatório, resumo executivo ou documento para a diretoria. Define o formato obrigatório de relatórios da empresa.',
  '---',
  '# Padrão de relatório interno',
  'Todo relatório da empresa tem exatamente estas quatro seções, nesta ordem, cada uma como título de nível 2: Contexto, Achados, Riscos, Próximos passos.',
  'Cada achado começa com o símbolo ▶ no início da linha.',
  'A última linha do arquivo é, literalmente: Selo de qualidade: ZETA-7',
  ''
].join('\n')

/** A skill the owner installed (profile `skills/`): the agent must find it by its description, load it and follow it. */
async function skill(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Relatorios internos')
  fx.write(folder, 'vendas.csv', 'mes,receita\n2026-01,10200\n2026-02,11800\n2026-03,13150\n')
  await openCowork(page, { folder, projectName: 'Relatorios internos', permission: PERMISSION })
  await type(page, 'Escreva em relatorio.md um relatório curto sobre as vendas do trimestre (os dados estão em vendas.csv) para a diretoria.')
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  const done = await drive(page, session.id, { timeoutMs: 12 * MINUTE })
  const act = await activity(page, session.id)
  await shot(page, 'g-01-skill.png')
  const used = act.calls.filter((call) => call.name === 'use_skill')
  c.check('carregou-a-skill-com-use_skill', used.some((call) => JSON.stringify(call.args).includes(SKILL_NAME)), { chamadas: used.map((call) => call.args), ferramentas: names(act) })
  const out = path.join(folder, 'relatorio.md')
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  c.check('relatorio.md-entregue', text.length > 100, { bytes: text.length, pasta: tree(folder) })
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim())
  c.check('quatro-secoes-na-ordem-da-skill', JSON.stringify(headings.slice(0, 4).map((h) => h.toLowerCase())) === JSON.stringify(['contexto', 'achados', 'riscos', 'próximos passos']), headings)
  c.check('achados-comecam-com-o-simbolo-da-skill', (text.match(/^\s*(?:[-*]\s*)?▶/gm) || []).length >= 2)
  c.check('ultima-linha-e-o-selo-da-skill', text.trim().split(/\r?\n/).pop().trim() === 'Selo de qualidade: ZETA-7', text.trim().split(/\r?\n/).pop())
  return { tools: names(act), headings, finalText: act.finalText.slice(0, 600), plan: done.plan.map((item) => `${item.status}: ${item.text}`) }
}
skill.prepare = (ws) => fx.write(path.join(ws.profile, 'skills', SKILL_NAME), 'SKILL.md', SKILL_FILE)

/** A connector from the directory (public MCP server, no login) used by a Cowork task that must deliver a file with its data. */
async function connector(ws, app, c) {
  const { page } = app
  const CONNECTOR = e2e.arg('connector', 'microsoft-learn')
  const folder = path.join(ws.work, 'Pesquisa docs')
  fs.mkdirSync(folder, { recursive: true })
  const connected = await page.evaluate(async (id) => {
    const r = await window.forja.app.connectConnector(id)
    return { ok: r.ok, error: r.error, state: r.value && r.value.state }
  }, CONNECTOR)
  c.check('conector-conecta-pelo-diretorio', connected.ok && connected.state && connected.state.status === 'connected', JSON.stringify(connected).slice(0, 240))
  const serverName = connected.state && connected.state.serverName
  const tools = serverName ? (await page.evaluate(async (name) => (await window.forja.app.connectorTools(name)).value, serverName)) || [] : []
  c.check('conector-lista-ferramentas', tools.length > 0, `${tools.length} ferramentas`)
  await openCowork(page, { folder, projectName: 'Pesquisa docs', permission: PERMISSION })
  await type(page, `Use o conector "${CONNECTOR}" para pesquisar como funciona o gerenciamento do ciclo de vida do Azure Blob Storage e salve em resumo-blob.md um resumo de até 6 linhas, com o título e o endereço (URL) da página principal que você usou. Use o conector, não a internet em geral.`)
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  const done = await drive(page, session.id, { timeoutMs: 12 * MINUTE })
  const act = await activity(page, session.id)
  await shot(page, 'e-01-conector.png')
  const direct = act.results.filter((item) => item.name && item.name.startsWith(`mcp__${serverName}__`))
  c.check('modelo-usou-a-ferramenta-do-conector', direct.length > 0, { ferramentas: names(act) })
  c.check('chamada-ao-conector-deu-certo', direct.some((item) => item.ok), direct.map((item) => `${item.name}: ${item.ok}`))
  const out = path.join(folder, 'resumo-blob.md')
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  c.check('resumo-entregue-na-pasta', text.length > 80, { bytes: text.length, pasta: tree(folder) })
  c.check('resumo-cita-a-url-do-conector', /learn\.microsoft\.com/i.test(text))
  await page.evaluate(async (id) => window.forja.app.disconnectConnector(id), CONNECTOR)
  return { connected, tools: tools.slice(0, 6).map((tool) => tool.name), ferramentas: names(act), approvals: done.log.approvals, resumo: text.slice(0, 700), finalText: act.finalText.slice(0, 500) }
}

/** A scheduled task that fires by itself, plus "run now", working in the Cowork folder. */
async function schedule(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Relatorios agendados')
  fx.write(folder, 'dados.txt', 'Vendas de hoje: 12 pedidos (R$ 3.480,00)\nVendas de ontem: 9 pedidos (R$ 2.610,00)\n')
  await openCowork(page, { folder, projectName: 'Relatorios agendados', permission: PERMISSION })
  const projectId = await page.evaluate(async () => (await window.forja.projects.list()).value[0].id)
  const soon = new Date(Date.now() + 50_000).toISOString()
  const created = await page.evaluate(async ({ projectId, soon }) => {
    const once = await window.forja.schedules.create({ name: 'Resumo diário (automático)', prompt: 'Leia dados.txt e grave em resumo-agendado.md uma frase com o total de pedidos de hoje e de ontem.', projectId, surface: 'cowork', schedule: { kind: 'once', at: soon } })
    const manual = await window.forja.schedules.create({ name: 'Resumo sob demanda', prompt: 'Leia dados.txt e grave em resumo-manual.md uma frase com o valor de hoje em reais.', projectId, surface: 'cowork', schedule: { kind: 'daily', time: '03:00' } })
    return { once: once.ok ? once.value : { error: once.error }, manual: manual.ok ? manual.value : { error: manual.error } }
  }, { projectId, soon })
  c.check('agendamentos-criados', Boolean(created.once.id && created.manual.id), created)
  await page.locator('nav.side-nav .side-row', { hasText: 'Agendados' }).click()
  await page.waitForTimeout(1200)
  const pageText = await page.locator('body').innerText()
  c.check('tela-Agendados-lista-as-duas-tarefas', /Resumo diário \(automático\)/.test(pageText) && /Resumo sob demanda/.test(pageText))
  await shot(page, 'f-01-agendados.png')
  // Run now: the same prompt, on demand.
  const ran = await page.evaluate(async (id) => (await window.forja.schedules.runNow(id)).ok, created.manual.id)
  c.check('executar-agora-aceito', ran)
  // Wait for both: the manual run and the automatic one (the scheduler looks every ~30 s).
  const started = Date.now()
  let tasks = []
  while (Date.now() - started < 8 * MINUTE) {
    await page.waitForTimeout(5000)
    tasks = await page.evaluate(async () => (await window.forja.schedules.list()).value)
    const once = tasks.find((task) => task.id === created.once.id)
    const manual = tasks.find((task) => task.id === created.manual.id)
    if (once && once.lastStatus === 'ok' && manual && manual.lastStatus === 'ok') break
  }
  const once = tasks.find((task) => task.id === created.once.id) || {}
  const manual = tasks.find((task) => task.id === created.manual.id) || {}
  c.check('tarefa-automatica-rodou-sozinha-no-horario', once.lastStatus === 'ok' && (once.runHistory || []).some((run) => run.trigger === 'schedule'), { status: once.lastStatus, historico: (once.runHistory || []).map((run) => `${run.trigger}:${run.status}`) })
  c.check('executar-agora-rodou', manual.lastStatus === 'ok' && (manual.runHistory || []).some((run) => run.trigger === 'manual'), { status: manual.lastStatus })
  const autoFile = path.join(folder, 'resumo-agendado.md')
  const manualFile = path.join(folder, 'resumo-manual.md')
  c.check('arquivo-da-tarefa-automatica', fs.existsSync(autoFile) && /12/.test(fs.readFileSync(autoFile, 'utf8')) && /9/.test(fs.readFileSync(autoFile, 'utf8')), fs.existsSync(autoFile) ? fs.readFileSync(autoFile, 'utf8').slice(0, 200) : 'não existe')
  c.check('arquivo-da-tarefa-manual', fs.existsSync(manualFile) && /3\.?480/.test(fs.readFileSync(manualFile, 'utf8')), fs.existsSync(manualFile) ? fs.readFileSync(manualFile, 'utf8').slice(0, 200) : 'não existe')
  const sessions = await page.evaluate(async (ids) => (await window.forja.sessions.list()).value.filter((item) => ids.includes(item.meta.id)).map((item) => ({ title: item.meta.title, surface: item.meta.surface, mode: item.meta.mode, model: item.meta.model })), [once.lastSessionId, manual.lastSessionId].filter(Boolean))
  for (const item of sessions) if (item.model) USED_MODELS.add(item.model)
  c.check('sessao-agendada-aparece-no-Cowork', sessions.length > 0 && sessions.every((item) => item.surface === 'cowork' && item.mode === 'autonomous'), sessions)
  await shot(page, 'f-02-agendados-depois.png')
  return { once, manual, sessions, files: tree(folder) }
}

/** A web task: the agent opens a site in its browser, reads it and delivers a file (Cowork's "browser actions"). */
async function browser(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Pesquisa web')
  fs.mkdirSync(folder, { recursive: true })
  await openCowork(page, { folder, projectName: 'Pesquisa web', permission: PERMISSION })
  await type(page, 'Abra https://example.com no navegador, leia a página e salve em site.md o título principal e a primeira frase da página, entre aspas, como estão escritos.')
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  const done = await drive(page, session.id, { timeoutMs: 12 * MINUTE })
  const act = await activity(page, session.id)
  await shot(page, 'h-01-navegador.png')
  const opened = act.results.filter((item) => /^browser_/.test(item.name || ''))
  c.check('usou-o-navegador-do-app', opened.length > 0 && opened.some((item) => item.ok), { ferramentas: names(act) })
  const out = path.join(folder, 'site.md')
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  c.check('site.md-entregue', text.length > 20, { bytes: text.length, pasta: tree(folder) })
  c.check('site.md-traz-o-titulo-real-da-pagina', /Example Domain/.test(text), text.slice(0, 160))
  c.check('site.md-traz-a-primeira-frase-real', /documentation examples/i.test(text), text.slice(0, 240))
  return { tools: names(act), approvals: done.log.approvals, site: text.slice(0, 400), finalText: act.finalText.slice(0, 500) }
}

/** Steering: the user changes their mind in the middle of the work (type, then "send now") and the agent changes course. */
async function steer(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Redirecionar')
  fs.mkdirSync(folder, { recursive: true })
  await openCowork(page, { folder, projectName: 'Redirecionar', permission: PERMISSION })
  await type(page, 'Crie, um por vez e nesta ordem, os arquivos a.txt, b.txt, c.txt, d.txt, e.txt e f.txt na pasta, cada um contendo só a letra do nome em maiúscula. Antes de cada arquivo, rode o comando `ping -n 6 127.0.0.1 > nul` (uma espera de uns 5 segundos) e só então grave o arquivo.')
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  let steered = false
  let steeredAt = []
  const done = await drive(page, session.id, {
    timeoutMs: 15 * MINUTE,
    onTick: async () => {
      if (!steered && fs.existsSync(path.join(folder, 'a.txt'))) {
        steered = true
        steeredAt = fs.readdirSync(folder).filter((name) => /^[a-f]\.txt$/.test(name))
        await type(page, 'Mudei de ideia: não crie mais nenhuma letra. Crie só o arquivo parei.txt com o texto ok e encerre.')
        await page.waitForTimeout(700)
        await shot(page, 'i-01-redirecionando.png')
        await page.locator('.queue-send').first().click()
      }
      return false
    }
  })
  const act = await activity(page, session.id)
  await shot(page, 'i-02-redirecionado.png')
  const files = fs.readdirSync(folder)
  const letters = files.filter((name) => /^[a-f]\.txt$/.test(name))
  c.check('o-agente-foi-redirecionado-no-meio-do-trabalho', steered, { letrasQuandoRedirecionou: steeredAt })
  c.check('parei.txt-criado-com-ok', files.includes('parei.txt') && /ok/i.test(fs.readFileSync(path.join(folder, 'parei.txt'), 'utf8')), files)
  c.check('parou-de-criar-letras-depois-do-pedido', letters.length < 6, { letras: letters })
  c.check('turno-terminou-sem-erro', done.run !== 'error', done.run)
  return { steeredAt, letters, files, tools: names(act), finalText: act.finalText.slice(0, 500) }
}

/** What the person sees when they open what Cowork delivered, from the session's Files pane (no model call). */
async function preview(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Entregas')
  fs.mkdirSync(folder, { recursive: true })
  const source = path.join(OUT, 'b-entregas')
  const delivered = ['relatorio-vendas.docx', 'analise-vendas.xlsx', 'apresentacao-vendas.pptx', 'relatorio-vendas.pdf'].filter((name) => fs.existsSync(path.join(source, name)))
  for (const name of delivered) fs.copyFileSync(path.join(source, name), path.join(folder, name))
  fx.write(folder, 'notas.md', '# Notas\n\nTexto simples para comparar.\n')
  c.check('arquivos-de-exemplo-copiados', delivered.length === 4, delivered)
  await openCowork(page, { folder, projectName: 'Entregas', permission: PERMISSION })
  const sessionId = await page.evaluate(async (leaf) => {
    const settings = (await window.forja.app.settings()).value
    const provider = settings.providers.find((item) => item.id === settings.defaultProviderId) || settings.providers[0]
    const project = (await window.forja.projects.list()).value.find((item) => String(item.path).split(/[\\/]/).filter(Boolean).pop().toLowerCase() === leaf)
    const made = await window.forja.sessions.create({ projectId: project.id, cwd: project.path, mode: 'autonomous', surface: 'cowork', providerId: provider.id, model: provider.model, title: 'Ver entregas' })
    return made.value.id
  }, path.basename(folder).toLowerCase())
  await page.reload()
  await page.waitForSelector('.app-shell')
  await page.locator('.side-session', { hasText: 'Ver entregas' }).first().click()
  await page.waitForTimeout(800)
  await page.locator('.tb-actions [aria-label="Arquivos"]').click()
  await page.waitForTimeout(1200)
  const shown = {}
  const only = e2e.arg('file', '')
  for (const name of [...delivered, 'notas.md'].filter((item) => !only || item === only)) {
    console.log('abrindo no painel:', name)
    await page.getByText(name, { exact: true }).first().click({ timeout: 8000 }).catch(() => undefined)
    await page.waitForTimeout(1200)
    const body = await page.locator('.files-pane2').innerText().catch(() => '')
    const editor = await page.locator('.cm-content').first().innerText().catch(() => '')
    shown[name] = { editor: editor.replace(/\s+/g, ' ').slice(0, 160), hasImage: (await page.locator('.files-pane2 img, .files-pane2 canvas, .files-pane2 iframe, .files-pane2 embed').count()) > 0, notice: /binário|não é possível|não suporta|unsupported/i.test(body) }
    await shot(page, `j-${name.replace(/[^\w]+/g, '-')}.png`)
  }
  const readable = (name) => /Relat[óo]rio|Resumo|Receita|Vendas/i.test(shown[name] && shown[name].editor)
  c.check('texto-simples-abre-no-painel', /Notas|Texto simples/.test(shown['notas.md'] && shown['notas.md'].editor), shown['notas.md'])
  c.check('docx-mostra-o-conteudo-legivel', readable('relatorio-vendas.docx'), shown['relatorio-vendas.docx'])
  c.check('xlsx-mostra-o-conteudo-legivel', readable('analise-vendas.xlsx'), shown['analise-vendas.xlsx'])
  c.check('pptx-mostra-o-conteudo-legivel', readable('apresentacao-vendas.pptx'), shown['apresentacao-vendas.pptx'])
  c.check('pdf-mostra-o-conteudo-legivel', Boolean(shown['relatorio-vendas.pdf'] && (shown['relatorio-vendas.pdf'].hasImage || readable('relatorio-vendas.pdf'))), shown['relatorio-vendas.pdf'])
  return { sessionId, shown }
}

/** The scheduled-task form, with no model call: a new task starts as Cowork work, the type is saved, shown and editable. */
async function scheduleUi(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Agendadas UI')
  fs.mkdirSync(folder, { recursive: true })
  await openCowork(page, { folder, projectName: 'Agendadas UI' }) // registers the project
  await page.locator('nav.side-nav .side-row', { hasText: 'Agendados' }).click()
  await page.waitForSelector('.page-head')
  const typeSelect = () => page.locator('.task-form label', { hasText: 'Tipo de sessão' }).locator('select')
  const list = () => page.evaluate(async () => (await window.forja.schedules.list()).value)

  // A blank new task.
  await page.getByRole('button', { name: /Nova tarefa/ }).click()
  await page.getByText('Configurar manualmente').click()
  await page.waitForSelector('.task-form')
  c.check('tipo-de-sessao-comeca-em-Cowork', (await typeSelect().inputValue()) === 'cowork')
  const options = await typeSelect().locator('option').allInnerTexts()
  c.check('tipo-de-sessao-oferece-Cowork-e-Code', options.length === 2 && /^Cowork/.test(options[0]) && /^Code/.test(options[1]), options)
  await page.locator('.task-form input').first().fill('Resumo da pasta (formulário)')
  await page.locator('.task-form textarea').fill('Resuma os arquivos novos da pasta.')
  await shot(page, 'k-01-nova-tarefa-cowork.png')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.waitForTimeout(1500)
  let tasks = await list()
  c.check('tarefa-nova-salva-como-Cowork', tasks.length === 1 && tasks[0].surface === 'cowork', tasks.map((task) => ({ name: task.name, surface: task.surface })))
  const rowText = await page.locator('.task-row').first().innerText()
  c.check('lista-mostra-o-tipo-Cowork', /Cowork/.test(rowText), rowText.replace(/\s+/g, ' '))
  await shot(page, 'k-02-lista-com-tipo.png')

  // The Cowork template and a developer template.
  await page.getByRole('button', { name: /Nova tarefa/ }).click()
  await page.getByText('Organizar os arquivos novos da pasta').click()
  await page.waitForSelector('.task-form')
  c.check('modelo-de-pasta-abre-como-Cowork', (await typeSelect().inputValue()) === 'cowork')
  await page.getByRole('button', { name: 'Cancelar' }).click()
  await page.getByRole('button', { name: /Nova tarefa/ }).click()
  await page.getByText('Rodar os testes').click()
  await page.waitForSelector('.task-form')
  c.check('modelo-de-codigo-abre-como-Code', (await typeSelect().inputValue()) === 'code')
  await page.getByRole('button', { name: 'Cancelar' }).click()

  // Edit: Cowork → Code.
  await page.locator('.task-row .side-mini').first().click()
  await page.getByText('Editar', { exact: true }).click()
  await page.waitForSelector('.task-form')
  c.check('editar-mostra-o-tipo-salvo', (await typeSelect().inputValue()) === 'cowork')
  await typeSelect().selectOption('code')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.waitForTimeout(1500)
  tasks = await list()
  c.check('editar-troca-o-tipo-para-Code', tasks.length === 1 && tasks[0].surface === 'code', tasks.map((task) => task.surface))
  c.check('lista-mostra-Code-depois-de-editar', /Code/.test(await page.locator('.task-row').first().innerText()))

  // A task saved before the field existed (no `surface`) opens the form as Code and keeps running as Code.
  const legacy = await page.evaluate(async () => {
    const projectId = (await window.forja.projects.list()).value[0].id
    const made = await window.forja.schedules.create({ name: 'Antiga sem tipo', prompt: 'x', projectId, schedule: { kind: 'daily', time: '09:00' } })
    return made.ok ? made.value : null
  })
  c.check('tarefa-sem-tipo-continua-sem-tipo', Boolean(legacy) && legacy.surface === undefined, legacy && legacy.surface)
  return { tasks: (await list()).map((task) => ({ name: task.name, surface: task.surface })) }
}

/**
 * A turn that reaches the iteration cap (lowered to 6 for this run): the plan must not stay "in progress", the screen offers
 * "Continuar de onde parou", and clicking it carries the job on from where it stopped until the work is done.
 */
async function iterationCap(ws, app, c) {
  const { page } = app
  const folder = path.join(ws.work, 'Limite de iteracoes')
  fs.mkdirSync(folder, { recursive: true })
  await openCowork(page, { folder, projectName: 'Limite de iteracoes', permission: PERMISSION })
  await type(page, 'Crie, um por vez e em ordem, os arquivos nota-01.txt até nota-10.txt na pasta, cada um contendo apenas o número do arquivo por extenso. Use uma chamada de ferramenta por arquivo e registre os passos no plano.')
  await page.waitForTimeout(2500)
  const [session] = await coworkSessions(page, folder)
  c.check('sessao-cowork', Boolean(session), session)
  const notes = () => fs.readdirSync(folder).filter((name) => /^nota-\d\d\.txt$/.test(name)).length
  let state = await drive(page, session.id, { timeoutMs: 12 * MINUTE })
  const cap = await page.waitForSelector('.budget-dock', { timeout: 15000 }).then(() => true, () => false)
  const dockText = cap ? await page.locator('.budget-dock').innerText() : ''
  c.check('cartao-de-limite-de-iteracoes-aparece', cap && /Limite de iterações do turno atingido/.test(dockText) && /\d+ de \d+ iterações/.test(dockText), dockText.replace(/\s+/g, ' ').slice(0, 200))
  c.check('cartao-oferece-continuar-de-onde-parou', /Continuar de onde parou/.test(dockText))
  await shot(page, 'l-01-limite-de-iteracoes.png')
  const planAtCap = (await snapshotState(page, session.id)).plan
  c.check('plano-nao-fica-em-andamento-no-limite', planAtCap.length > 0 && !planAtCap.some((item) => item.status === 'active'), planAtCap.map((item) => `${item.status}: ${item.text}`))
  const before = notes()
  c.check('o-turno-parou-antes-de-terminar-o-trabalho', before > 0 && before < 10, { arquivos: before })

  // Continue (as many times as the cap needs): every click picks the job up from where it stopped.
  let clicks = 0
  while (notes() < 10 && clicks < 6) {
    clicks++
    const count = state.count
    await page.locator('.budget-dock button', { hasText: 'Continuar de onde parou' }).click({ timeout: 8000 }).catch(() => undefined)
    state = await drive(page, session.id, { timeoutMs: 12 * MINUTE, sinceCount: count })
    await page.waitForTimeout(800)
  }
  await shot(page, 'l-02-depois-de-continuar.png')
  const act = await activity(page, session.id)
  c.check('continuar-leva-o-trabalho-ate-o-fim', notes() === 10, { arquivos: notes(), cliques: clicks })
  c.check('plano-termina-sem-passo-aberto', state.plan.length > 0 && state.plan.every((item) => ['done', 'blocked'].includes(item.status)), state.plan.map((item) => `${item.status}: ${item.text}`))
  return { limite: MAX_ITERATIONS_USED(), cliques: clicks, arquivos: notes(), planReminders: act.planReminders, plan: state.plan.map((item) => `${item.status}: ${item.text}`), tools: names(act) }
}
const MAX_ITERATIONS_USED = () => Number(e2e.arg('max-iterations', '6'))

/* ------------------------------------------------------------------ main */

const SCENARIOS = { home, organize, deliver, longtask, resume, skill, connector, schedule, 'schedule-ui': scheduleUi, 'iteration-cap': iterationCap, browser, steer, preview }

async function main() {
  const run = SCENARIOS[SCENARIO]
  if (!run) throw new Error(`cenário desconhecido: ${SCENARIO} (${Object.keys(SCENARIOS).join(', ')})`)
  const proxy = process.argv.includes('--ollama-fast') ? await startOllamaProxy() : null
  let proxied = {}
  if (proxy) {
    const real = JSON.parse(fs.readFileSync(path.join(e2e.FROM(), 'config', 'settings.json'), 'utf8'))
    proxied = { providers: real.providers.map((item) => (item.id === 'ollama' ? { ...item, baseUrl: proxy.baseUrl, model: e2e.arg('model', item.model) } : item)) }
  }
  const pinned = pinnedProvider()
  const ws = workspace({ ...proxied, ...pinned })
  if (run.prepare) run.prepare(ws)
  const python = systemPythonEnv(ws)
  const app = await e2e.launch({ port: PORT, ...ws, env: python.env })
  const c = e2e.makeChecks()
  const result = { scenario: SCENARIO, permission: PERMISSION, team: TEAM, systemPython: python.mode, startedAt: new Date().toISOString(), root: process.argv.includes('--root') ? e2e.arg('root') : 'working tree' }
  const started = Date.now()
  try {
    result.detail = await run(ws, app, c)
  } catch (error) {
    result.crash = error instanceof Error ? error.stack || error.message : String(error)
    c.check('cenario-rodou-ate-o-fim', false, result.crash.split('\n')[0])
    await shot(app.page, `${SCENARIO}-erro.png`).catch(() => undefined)
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000)
    // A run asked for one model must have been answered by that model only (the reserve is off, but say so if it ever is not).
    result.modelsUsed = [...USED_MODELS]
    if (pinned.pinned && !['home', 'schedule-ui', 'preview'].includes(SCENARIO)) {
      const { provider, model } = pinned.pinned
      c.check('so-o-modelo-pedido-respondeu', result.modelsUsed.length > 0 && result.modelsUsed.every((used) => used === model), { pedido: `${provider}/${model}`, responderam: result.modelsUsed })
    }
    result.checks = c.checks
    result.errors = app.errors.slice(0, 8)
    result.ok = c.ok()
    save(result)
    app.cleanup()
    if (proxy) void proxy.close().catch(() => undefined) // not awaited: process.exit follows and open sockets would hold the close
  }
  const failed = Object.entries(c.checks).filter(([, value]) => value !== 'ok')
  console.log(`\n${SCENARIO}: ${Object.keys(c.checks).length - failed.length}/${Object.keys(c.checks).length} checagens ok em ${result.seconds}s`)
  for (const [name, value] of failed) console.log(`  ${name}: ${value}`)
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
