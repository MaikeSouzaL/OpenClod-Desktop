// Drives the running Forja (started with --remote-debugging-port=9333) through
// the side-panel panes and saves screenshots. Usage: node scripts/ui-panes.cjs <outDir>
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const OUT = process.argv[2] || path.join(__dirname, '..', 'tmp', 'ui-panes')
fs.mkdirSync(OUT, { recursive: true })

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Forja preview OK</title><h1 style="font-family:sans-serif">Forja preview OK</h1>')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  const results = {}
  const errors = []
  const server = await serve()
  const port = server.address().port
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools'))
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`))
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)

  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })

  // Disposable fixture project: a dev server that prints its URL and a git repo with pending changes.
  const fixture = path.join(__dirname, '..', 'tmp', 'ui-fixture')
  fs.rmSync(fixture, { recursive: true, force: true })
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true })
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'ui-fixture', private: true, scripts: { dev: 'node server.js', build: 'echo build' } }, null, 2))
  fs.writeFileSync(
    path.join(fixture, 'server.js'),
    "require('http').createServer((q, r) => { r.writeHead(200, {'content-type': 'text/html'}); r.end('<title>Fixture dev server</title><h1>Fixture dev server</h1>') })" +
      ".listen(5174, '127.0.0.1', () => console.log('  Local:   http://localhost:5174/'))\n"
  )
  fs.writeFileSync(path.join(fixture, 'README.md'), '# UI fixture\n\nLinha original.\n')
  fs.writeFileSync(path.join(fixture, 'src', 'index.ts'), 'export const answer = 42\n')
  const git = (...args) => require('node:child_process').execFileSync('git', ['-c', 'user.name=Forja', '-c', 'user.email=forja@example.invalid', ...args], { cwd: fixture, stdio: 'pipe' })
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  fs.writeFileSync(path.join(fixture, 'README.md'), '# UI fixture\n\nLinha alterada.\nLinha nova.\n')
  fs.writeFileSync(path.join(fixture, 'src', 'novo.ts'), 'export const novo = true\n')

  const created = await page.evaluate(async (folder) => {
    const settings = await window.forja.app.settings()
    const project = await window.forja.projects.add(folder, 'UI fixture')
    if (!project.ok) return { error: project.error }
    const session = await window.forja.sessions.create({
      projectId: project.value.id,
      cwd: project.value.path,
      mode: 'code',
      surface: 'code',
      providerId: settings.value.defaultProviderId,
      model: '',
      title: 'UI fixture'
    })
    return session.ok ? { projectId: project.value.id, sessionId: session.value.id } : { error: session.error }
  }, fixture)
  if (created.error) throw new Error(created.error)
  await page.reload()
  await page.waitForTimeout(2000)

  const code = page.locator('.mode-switch button', { hasText: 'Code' })
  if (await code.count()) await code.click()
  await page.waitForTimeout(400)
  const session = page.locator('.side-session', { hasText: 'UI fixture' }).first()
  if (!(await session.count())) {
    // Clicking an already-active project collapses it, so only expand when the row is hidden.
    await page.locator('.side-project-name', { hasText: 'UI fixture' }).click()
    await page.waitForTimeout(400)
  }
  if (!(await session.count())) throw new Error('sessão de teste não apareceu na barra lateral')
  await session.click()
  await page.waitForTimeout(800)

  // Terminal
  await page.locator('.tb-actions [aria-label="Terminal"]').click()
  await page.waitForSelector('.xterm-host.active .xterm', { timeout: 15000 })
  await page.waitForTimeout(2500)
  await page.locator('.xterm-host.active .xterm').click()
  await page.keyboard.type('echo FORJA_TERM_$((6*7))')
  await page.keyboard.press('Enter')
  await page.keyboard.type('echo FORJA_TERM_OK')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  results.terminal = await page.evaluate(async () => {
    const list = await window.forja.terminal.list()
    if (!list.ok || !list.value.length) return { ok: false, reason: 'sem terminais' }
    const info = list.value[list.value.length - 1]
    const snap = await window.forja.terminal.snapshot(info.id)
    const text = snap.ok ? snap.value : ''
    return { ok: (text.match(/FORJA_TERM_OK/g) || []).length >= 2, shell: info.shell, pid: info.pid, tail: text.slice(-300) }
  })
  await shot('12-terminal')

  // Changes
  await page.locator('.tb-actions [aria-label="Alterações"]').click()
  await page.waitForTimeout(1500)
  results.changes = await page.evaluate(() => document.querySelector('.changes-pane')?.innerText.slice(0, 300) ?? null)
  await shot('13-alteracoes')

  // Browser: start page, then a local page in a webview
  await page.locator('.tb-actions [aria-label="Navegador"]').click()
  await page.waitForTimeout(1500)
  await shot('14-navegador-inicio')
  results.devservers = await page.evaluate(() => [...document.querySelectorAll('.devserver-card code')].map((el) => el.textContent))
  const use = page.locator('.devserver-card button', { hasText: 'Usar esta' }).first()
  if (await use.count()) {
    await use.click()
    await page.waitForSelector('webview.browser-webview.active', { timeout: 60000 }).catch(() => undefined)
    await page.waitForTimeout(2500)
    results.devserver = await page.evaluate(() => {
      const view = document.querySelector('webview.browser-webview.active')
      return view ? { ok: view.getTitle() === 'Fixture dev server', title: view.getTitle(), url: view.getURL() } : { ok: false, error: document.querySelector('.browser-start .inline-error')?.textContent ?? null }
    })
    results.launchJson = fs.existsSync(path.join(fixture, '.forja', 'launch.json')) ? JSON.parse(fs.readFileSync(path.join(fixture, '.forja', 'launch.json'), 'utf8')) : null
    await shot('14-navegador-devserver')
  }
  await page.locator('.browser-tabs [title="Nova aba"]').click()
  await page.waitForTimeout(300)
  await page.locator('.browser-address input').fill(`127.0.0.1:${port}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3500)
  results.browser = await page.evaluate(() => {
    const view = document.querySelector('webview.browser-webview.active')
    if (!view) return { ok: false, reason: 'sem webview ativo' }
    return { ok: view.getTitle() === 'Forja preview OK', title: view.getTitle(), url: view.getURL() }
  })
  await shot('14-navegador-pagina')

  // Files + editor
  await page.locator('.tb-actions [aria-label="Arquivos"]').click()
  await page.waitForTimeout(1500)
  const pkg = page.locator('.files-tree-col .file-row:not(.dir)', { hasText: 'README.md' }).first()
  if (await pkg.count()) {
    await pkg.click()
    await page.waitForTimeout(1200)
  }
  results.editor = await page.evaluate(() => ({
    codemirror: Boolean(document.querySelector('.code-editor .cm-editor')),
    tab: document.querySelector('.editor-tab.active')?.textContent ?? null,
    lines: document.querySelectorAll('.code-editor .cm-line').length
  }))
  await shot('15-arquivos-editor')
  // Type into CodeMirror and save with Ctrl+S; the file on disk must change.
  await page.locator('.code-editor .cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Linha digitada no editor')
  await page.keyboard.press('Control+S')
  await page.waitForTimeout(1500)
  results.editorSave = {
    onDisk: fs.readFileSync(path.join(fixture, 'README.md'), 'utf8').includes('Linha digitada no editor'),
    status: await page.locator('.editor-status-actions em').first().textContent()
  }
  await page.locator('.files-pane2 [title="Opções do editor"]').click()
  await page.waitForTimeout(300)
  await shot('16-arquivos-opcoes')
  await page.keyboard.press('Escape')

  // Panel maximize + restore
  await page.locator('.panel-head [title="Maximizar"]').click()
  await page.waitForTimeout(500)
  results.maximized = await page.evaluate(() => getComputedStyle(document.querySelector('.workspace')).display === 'none')
  await shot('17-painel-maximizado')
  await page.locator('.panel-head [title="Restaurar"]').click()
  await page.waitForTimeout(300)

  // Options menu + background tasks dialog
  await page.locator('.tb-actions [aria-label="Ver opções"]').click()
  await page.waitForTimeout(300)
  await shot('18-menu-opcoes')
  await page.locator('.menu-item', { hasText: 'Tarefas em segundo plano' }).click()
  await page.waitForTimeout(800)
  results.tasksDialog = await page.evaluate(() => Boolean(document.querySelector('.tasks-modal')))
  await shot('19-tarefas-segundo-plano')
  await page.keyboard.press('Escape')

  // Git changes on the fixture repo (README modified, src/novo.ts untracked)
  await page.locator('.tb-actions [aria-label="Alterações"]').click()
  await page.waitForTimeout(2500)
  results.git = await page.evaluate(() => ({
    branch: document.querySelector('.changes-pane .pane-path')?.textContent?.trim() ?? null,
    rows: [...document.querySelectorAll('.changes-pane .change-row')].map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
    addedLines: document.querySelectorAll('.changes-pane .diff-view pre span.add').length,
    removedLines: document.querySelectorAll('.changes-pane .diff-view pre span.del').length,
    error: document.querySelector('.changes-pane .inline-error')?.textContent ?? null
  }))
  await shot('20-alteracoes-git')
  await page.locator('.panel-head [title="Fechar painel"]').click()

  // Pages
  await page.locator('.side-nav button', { hasText: 'Projetos' }).click()
  await page.waitForTimeout(600)
  results.projectsPage = await page.locator('.project-card').count()
  await shot('21-projetos')

  await page.locator('.side-nav button', { hasText: 'Agendados' }).click()
  await page.waitForTimeout(800)
  await shot('22-agendados-modelos')
  await page.locator('.template-card').first().click()
  await page.waitForTimeout(400)
  await page.locator('.task-form select').first().selectOption({ label: 'UI fixture' })
  await shot('23-agendados-formulario')
  await page.locator('.task-modal .btn.primary', { hasText: 'Salvar' }).click()
  await page.waitForTimeout(1000)
  const task = await page.evaluate(async () => {
    const list = await window.forja.schedules.list()
    return list.ok ? list.value.find((item) => item.name === 'Revisão diária do código') ?? null : null
  })
  results.scheduleCreated = task ? { id: task.id, nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toString() : null, schedule: task.schedule } : null
  if (task) {
    results.scheduleRun = await page.evaluate(async (taskId) => {
      const started = await window.forja.schedules.runNow(taskId)
      if (!started.ok) return { error: started.error }
      for (let i = 0; i < 40; i++) {
        const list = await window.forja.schedules.list()
        const item = list.value.find((entry) => entry.id === taskId)
        if (item && item.lastStatus !== 'running') return { status: item.lastStatus, error: item.lastError ?? null, sessionId: item.lastSessionId ?? null }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return { status: 'timeout' }
    }, task.id)
    await page.waitForTimeout(800)
    await shot('24-agendados-lista')
    results.scheduleCleanup = await page.evaluate(
      async ({ taskId, sessionId }) => {
        const removed = await window.forja.schedules.remove(taskId)
        const deleted = sessionId ? await window.forja.sessions.delete(sessionId) : { ok: true }
        return { removed: removed.ok, sessionDeleted: deleted.ok }
      },
      { taskId: task.id, sessionId: results.scheduleRun?.sessionId }
    )
  }

  await page.locator('.side-nav button', { hasText: 'Personalização' }).click()
  await page.waitForTimeout(800)
  results.skills = await page.locator('.info-card').count()
  await shot('25-personalizacao-skills')
  await page.locator('.page-tabs button', { hasText: 'Conectores' }).click()
  await page.waitForTimeout(400)
  await shot('26-personalizacao-conectores')
  await page.locator('.page-tabs button', { hasText: 'Hooks' }).click()
  await page.waitForTimeout(400)
  await shot('27-personalizacao-hooks')

  // Composer: effort picker (mock model exposes none) and permission quick switch (restored afterwards)
  await page.locator('.side-session', { hasText: 'UI fixture' }).first().click()
  await page.waitForTimeout(600)
  await page.locator('.effort-btn').click()
  await page.waitForTimeout(300)
  results.effortMenu = await page.locator('.model-menu .menu-item').allTextContents()
  await shot('28-esforco-modelo-sem-suporte')
  await page.keyboard.press('Escape')
  const originalMode = await page.evaluate(async () => (await window.forja.app.settings()).value.policy.mode)
  try {
    await page.locator('.composer-permission').click()
    await page.waitForTimeout(300)
    results.permissionMenu = await page.locator('.permission-menu .menu-item').allTextContents()
    await shot('29-permissoes-compositor')
    await page.locator('.permission-menu .menu-item', { hasText: /^Perguntar/ }).click()
    await page.waitForTimeout(800)
    results.permissionChanged = await page.evaluate(async () => (await window.forja.app.settings()).value.policy.mode)
  } finally {
    await page.evaluate(async (mode) => {
      const current = (await window.forja.app.settings()).value
      await window.forja.app.updateSettings({ policy: { ...current.policy, mode } })
    }, originalMode)
  }
  results.permissionRestored = await page.evaluate(async () => (await window.forja.app.settings()).value.policy.mode) === originalMode

  results.keepAwake = await page.evaluate(async () => {
    const on = await window.forja.power.keepAwake(true)
    const state = await window.forja.power.state()
    const off = await window.forja.power.keepAwake(false)
    return { on: on.value, state: state.value, off: off.value }
  })

  // Skills: create one through the UI path (IPC) and remove it afterwards
  const skillName = 'ui-teste-temporaria'
  results.skillCreate = await page.evaluate(async (name) => {
    const created = await window.forja.app.createSkill(name, 'Skill temporária do roteiro de UI', 'Passo 1: nada.')
    const list = await window.forja.app.skills()
    return { ok: created.ok, error: created.ok ? null : created.error, listed: list.ok && list.value.some((item) => item.name === name) }
  }, skillName)
  const skillDir = path.join(process.env.APPDATA, 'Forja', 'skills', skillName)
  results.skillFile = fs.existsSync(path.join(skillDir, 'SKILL.md')) ? fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') : null
  fs.rmSync(skillDir, { recursive: true, force: true })

  // Clean up: terminals of the fixture session (incl. the dev server), the session and the project entry.
  results.cleanup = await page.evaluate(async ({ projectId, sessionId }) => {
    const list = await window.forja.terminal.list()
    let killed = 0
    for (const item of list.ok ? list.value : []) {
      if (item.sessionId === sessionId) {
        await window.forja.terminal.kill(item.id)
        killed++
      }
    }
    const deleted = await window.forja.sessions.delete(sessionId)
    const removed = await window.forja.projects.remove(projectId)
    return { killed, deleted: deleted.ok, removed: removed.ok }
  }, created)

  server.close()
  console.log(JSON.stringify({ results, errors }, null, 2))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
