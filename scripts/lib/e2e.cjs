// Shared helpers for the end-to-end scripts. The app has no scripted/fake model any more: every script that
// needs a model turn uses a REAL provider (DeepSeek by default), borrowing only its key vault from an
// existing profile. Scripts that only exercise the UI create a session on the first configured provider
// and never call a model.
//
//   node scripts/ui-<name>.cjs [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..', '..')
// The app under test. By default the working tree; `--root <dir>` / OPENCLOD_APP_ROOT point to a frozen copy made
// by scripts/snapshot-app.cjs, so a rebuild of `out/` (or the user's own app restarting) cannot break a long run,
// and two builds can be compared on the same scenario.
const APP_ROOT = (() => {
  const index = process.argv.indexOf('--root')
  return path.resolve(index > 0 ? process.argv[index + 1] : process.env.OPENCLOD_APP_ROOT || ROOT)
})()

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : fallback
}

const FROM = () => arg('from', path.join(process.env.APPDATA || '', 'Openclod Desktop'))
const PROVIDER = () => arg('provider', 'deepseek')

/**
 * A throwaway profile. With `real: true` it receives the key vault and a SANITIZED copy of the settings
 * (no MCP servers, hooks or self-repair) from `--from`; nothing is written back to the source.
 */
function makeWorkspace({ real = false, prefix = 'openclod-e2e-', settingsPatch } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const profile = path.join(work, 'profile')
  const project = path.join(work, 'projeto')
  fs.mkdirSync(path.join(profile, 'config'), { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  if (real) {
    const from = FROM()
    for (const file of [['Local State'], ['config', 'secrets.bin']]) {
      const source = path.join(from, ...file)
      if (!fs.existsSync(source)) throw new Error(`perfil de origem sem ${file.join('/')}: ${from} (use --from)`)
      fs.copyFileSync(source, path.join(profile, ...file))
    }
    const settings = JSON.parse(fs.readFileSync(path.join(from, 'config', 'settings.json'), 'utf8'))
    settings.mcpServers = []
    settings.hooks = {}
    settings.importClaudeSettings = false
    settings.defaultProviderId = PROVIDER()
    // `--model <name>`: another model of the same provider (e.g. `--provider ollama --model qwen3.5:4b`); only the throwaway copy changes.
    const model = arg('model', '')
    const chosen = settings.providers.find((item) => item.id === PROVIDER())
    if (model && chosen) chosen.model = model
    delete settings.lastModel
    if (settings.selfRepair) settings.selfRepair.enabled = false
    settings.claudeCatalogImported = true
    // A measurement belongs to the model it was asked for: with the reserve on, a quota or auth error moves the session to
    // another provider (DeepSeek → Ollama → a local 4B model) and the numbers come from a model nobody chose.
    settings.useAllModels = false
    if (settingsPatch) Object.assign(settings, settingsPatch)
    fs.writeFileSync(path.join(profile, 'config', 'settings.json'), JSON.stringify(settings, null, 2))
  }
  return { work, profile, project }
}

/**
 * The debugging port the run asked for, or a free one when somebody else (another E2E run, another session) is on it. Without
 * this the script connects to THAT app, and creates its project and session in an app that is not the one under test.
 */
function freePort(preferred) {
  const net = require('node:net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => {
      const any = net.createServer()
      any.listen(0, '127.0.0.1', () => {
        const { port } = any.address()
        any.close(() => resolve(port))
      })
    })
    server.listen(preferred, '127.0.0.1', () => server.close(() => resolve(preferred)))
  })
}

/** Starts Electron on a throwaway profile and returns the page plus a cleanup. */
async function launch({ port: wanted, profile, work, env = {}, viewport = { width: 1440, height: 900 } }) {
  const port = await freePort(wanted)
  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
  // OPENCLOD_E2E_LOG=<file>: keep what the app prints (stdout/stderr and Electron's own log) for diagnosing a run that dies.
  const logFile = process.env.OPENCLOD_E2E_LOG
  const logFd = logFile ? fs.openSync(logFile, 'a') : null
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: APP_ROOT,
    env: { ...process.env, ...env, ...(logFd !== null ? { ELECTRON_ENABLE_LOGGING: '1' } : {}) },
    stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
    windowsHide: false
  })
  const started = Date.now()
  let browser = null
  const cleanup = () => {
    try { browser?.close() } catch {}
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }) } catch {}
  }
  process.on('exit', cleanup)
  for (let attempt = 0; attempt < 80 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  if (!browser) throw new Error('o Electron não abriu a porta de depuração')
  let page = null
  for (let attempt = 0; attempt < 240 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'))
    if (!page) await new Promise((r) => setTimeout(r, 250))
  }
  if (!page) throw new Error('janela do app não apareceu')
  const errors = []
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`))
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  await page.setViewportSize(viewport)
  await page.waitForSelector('.app-shell', { timeout: 30000 })
  return { child, browser, page, errors, cleanup, windowReadyMs: Date.now() - started }
}

/** Registers the project and opens a session on a real provider; returns its id. */
async function newSession(page, { folder, title, projectName = 'Projeto E2E', mode = 'code', providerId }) {
  const created = await page.evaluate(async ({ folder, title, projectName, mode, providerId }) => {
    const settings = (await window.openclod.app.settings()).value
    const provider =
      settings.providers.find((item) => item.id === (providerId || settings.defaultProviderId)) || settings.providers[0]
    if (!provider) return { error: 'nenhum provedor configurado' }
    const projects = (await window.openclod.projects.list()).value
    let project = projects.find((item) => item.path === folder)
    if (!project) {
      const added = await window.openclod.projects.add(folder, projectName)
      if (!added.ok) return { error: added.error }
      project = added.value
    }
    const session = await window.openclod.sessions.create({ projectId: project.id, cwd: project.path, mode, surface: 'code', providerId: provider.id, model: provider.model, title })
    return session.ok ? { sessionId: session.value.id, projectId: project.id, provider: provider.id, model: provider.model } : { error: session.error }
  }, { folder, title, projectName, mode, providerId })
  if (created.error) throw new Error(created.error)
  return created
}

/** Reloads, switches to Code and opens the session row by title. */
async function openSession(page, title, projectName = 'Projeto E2E') {
  await page.locator('.mode-switch button', { hasText: 'Code' }).click().catch(() => undefined)
  await page.waitForTimeout(300)
  const row = page.locator('.side-session', { hasText: title }).first()
  if (!(await row.count())) await page.locator('.side-project-name', { hasText: projectName }).first().click()
  await page.locator('.side-session', { hasText: title }).first().click()
  await page.waitForTimeout(500)
}

/** Types into the real composer and sends. */
async function send(page, text) {
  const input = page.locator('textarea[aria-label="Mensagem"]')
  await input.fill(text)
  await input.press('Enter')
}

/** Waits until the run settles with a final assistant answer; returns the live session snapshot. */
async function waitSettled(page, sessionId, { timeoutMs = 300000, sinceCount = 0 } = {}) {
  const started = Date.now()
  let previous = ''
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(2000)
    const state = await page.evaluate(async (id) => {
      const value = (await window.openclod.sessions.get(id)).value
      const last = value.messages[value.messages.length - 1]
      // A turn that blocked a plan step ends with the harness's own limitation card, which has no text: still an answer.
      const answered = Boolean(last && last.role === 'assistant' && !last.parts.some((p) => p.type === 'tool_call') && (last.parts.some((p) => p.type === 'text' && p.text.trim()) || (last.parts.length && last.parts.every((p) => p.type === 'limitation'))))
      return { run: value.state, count: value.messages.length, approvals: value.approvals.length, answered }
    }, sessionId)
    const signature = `${state.run}:${state.count}`
    // A run that ends in `error` has no final answer: still settled, so the caller can report it instead of timing out.
    const settled = ['idle', 'done', 'error', 'cancelled'].includes(state.run) && state.count > sinceCount + 1 && (state.answered || state.run === 'error')
    if (settled && signature === previous) return state
    previous = signature
  }
  throw new Error(`a sessão não terminou em ${Math.round(timeoutMs / 1000)}s`)
}

/** Tool names and failures used by the model, plus its last answer, after message index `from`. */
async function turnReport(page, sessionId, from = 0) {
  return page.evaluate(async ({ id, from }) => {
    const value = (await window.openclod.sessions.get(id)).value
    const added = value.messages.slice(from)
    const calls = added.flatMap((m) => m.parts.filter((p) => p.type === 'tool_call').map((p) => p.name))
    const results = added.flatMap((m) => m.parts.filter((p) => p.type === 'tool_result').map((p) => ({ name: p.name, ok: p.ok, text: String(p.text).slice(0, 240) })))
    const last = [...added].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'))
    return { run: value.state, calls, results, finalText: last ? last.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '', count: value.messages.length, usage: value.usage }
  }, { id: sessionId, from })
}

/** Every tool call (with its args) and tool result (full text) after message index `from`; for structural checks. */
async function toolActivity(page, sessionId, from = 0) {
  return page.evaluate(async ({ id, from }) => {
    const value = (await window.openclod.sessions.get(id)).value
    const added = value.messages.slice(from)
    const parts = added.flatMap((m) => m.parts)
    return {
      calls: parts.filter((p) => p.type === 'tool_call').map((p) => ({ id: p.id, name: p.name, args: p.args })),
      results: parts.filter((p) => p.type === 'tool_result').map((p) => ({ toolCallId: p.toolCallId, name: p.name, ok: p.ok, text: String(p.text), summary: p.detail ? String(p.detail) : '' }))
    }
  }, { id: sessionId, from })
}

/**
 * Why a turn ended without an answer from the model: the error of the harness's own limitation card ("HTTP 402:
 * Insufficient Balance", a quota, a rate limit), or the session state when there is none. A measurement taken from a
 * run like that is empty, not zero, and must not be written down as a result.
 */
async function failureOf(page, sessionId) {
  return page.evaluate(async (id) => {
    const value = (await window.openclod.sessions.get(id)).value
    const card = value.messages.flatMap((m) => m.parts).find((p) => p.type === 'limitation')
    return card ? String(card.report.error).slice(0, 300) : `estado ${value.state}`
  }, sessionId)
}

/**
 * Did the session END on the provider and model it was created with? `session` is what `newSession` returned. A run that
 * changed models (the reserve, a manual switch) measured something else, and must not be written down as a result.
 */
async function checkModel(page, session) {
  const actual = await page.evaluate(async (id) => {
    const meta = (await window.openclod.sessions.get(id)).value.meta
    return { providerId: meta.providerId, model: meta.model }
  }, session.sessionId)
  return { ok: actual.providerId === session.provider && actual.model === session.model, expected: { providerId: session.provider, model: session.model }, actual }
}

/** Rough cost line of a session (tokens and USD when the provider reports it). */
async function usageOf(page, sessionId) {
  return page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.usage, sessionId)
}

/** Output folder: `--out dir`, or the first positional argument (the old convention), or `fallback`. */
function outDir(fallback) {
  const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  return path.resolve(arg('out', positional || fallback))
}

/** Collects named checks; `ok()` is false as soon as one failed. Each check is echoed as it happens. */
function makeChecks() {
  const checks = {}
  let failed = false
  const check = (name, ok, detail) => {
    const text = typeof detail === 'string' ? detail : detail === undefined ? '' : JSON.stringify(detail)
    checks[name] = ok ? 'ok' : `FALHOU${text ? `: ${text}` : ''}`
    if (!ok) failed = true
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${text ? ` -> ${text.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
    return Boolean(ok)
  }
  return { checks, check, ok: () => !failed }
}

module.exports = { ROOT, arg, makeWorkspace, launch, newSession, openSession, send, waitSettled, turnReport, toolActivity, usageOf, failureOf, checkModel, makeChecks, outDir, PROVIDER, FROM }
