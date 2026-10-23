// End-to-end check of the "agent at work" UI with real tools and scripted model turns
// (no real model needed). It starts its own Electron with a THROWAWAY profile
// (--user-data-dir) and a throwaway project, so nothing of the user's is touched.
//   node scripts/ui-work.cjs [outDir]
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'tmp', 'ui-work')
const PORT = 9334
const SCENARIO = process.argv[3] || 'basic'
fs.mkdirSync(OUT, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-ui-work-'))
const profile = path.join(work, 'profile')
const project = path.join(work, 'projeto')
fs.mkdirSync(path.join(project, 'src'), { recursive: true })
fs.writeFileSync(path.join(project, 'README.md'), '# Projeto\n\nLinha original.\n')

const call = (id, name, args) => ({ id, name, args })
const scenarios = {
  basic: [
    [
      {
        text: 'Vou mapear o projeto e montar um plano.',
        toolCalls: [
          call('c1', 'update_plan', { items: [{ text: 'Ler o README', status: 'active' }, { text: 'Criar src/util.ts', status: 'pending' }, { text: 'Conferir o resultado', status: 'pending' }] }),
          call('c2', 'run_command', { command: 'node -e "console.log(1+1)"', description: 'Somar dois números' })
        ]
      },
      {
        toolCalls: [
          call('c3', 'read_file', { path: 'README.md' }),
          call('c4', 'start_process', { command: 'node -e "setInterval(()=>console.log(\'tick\'),400)"', description: 'Serviço de teste', wait_ms: 1200 })
        ]
      },
      {
        text: 'Agora crio o utilitário e ajusto o README.',
        toolCalls: [
          call('c5', 'write_file', { path: 'src/util.ts', content: 'export const dobro = (n: number) => n * 2\n' }),
          call('c6', 'edit_file', { path: 'README.md', old_string: 'Linha original.', new_string: 'Linha editada pelo agente.' }),
          call('c7', 'update_plan', { items: [{ text: 'Ler o README', status: 'done' }, { text: 'Criar src/util.ts', status: 'done' }, { text: 'Conferir o resultado', status: 'active' }] })
        ]
      },
      { toolCalls: [call('c8', 'run_command', { command: 'node -e "process.exit(3)"', description: 'Comando que falha de propósito' })] },
      { text: 'Terminei: criei `src/util.ts`, ajustei o README e o último comando falhou de propósito para o teste.' }
    ]
  ]
}

scenarios.agents = [
  // parent
  [
    { text: 'Vou delegar o mapeamento a um especialista.', toolCalls: [call('p1', 'agent', { agent: 'explorer', label: 'Mapear o código', prompt: 'Liste os arquivos .ts do projeto e diga onde ficam as utilidades.' })] },
    { toolCalls: [call('p2', 'agent', { agent: 'coder', label: 'Implementar o dobro', prompt: 'Crie src/dobro.ts exportando dobro(n) e peça ao tester para validar a conta.' })] },
    { text: 'Concluído: o explorer mapeou, o coder implementou e o tester validou.' }
  ],
  // explorer
  [{ toolCalls: [call('e1', 'glob', { pattern: '**/*.ts' })] }, { text: 'Achei src/util.ts como única utilidade.' }],
  // coder (calls the tester: agents calling agents)
  [
    {
      toolCalls: [
        call('k1', 'write_file', { path: 'src/dobro.ts', content: 'export const dobro = (n: number) => n * 2\n' }),
        call('k2', 'agent', { agent: 'tester', label: 'Validar o dobro', prompt: 'Rode um comando que prove que dobro(21) vale 42.' })
      ]
    },
    { text: 'Implementei src/dobro.ts e o tester validou a conta.' }
  ],
  // tester
  [{ toolCalls: [call('t1', 'run_command', { command: 'node -e "console.log(2*21)"', description: 'Validar a conta do dobro' })] }, { text: 'Validado: dobro(21) = 42.' }]
]

async function main() {
  const results = {}
  const errors = []
  const scriptFile = path.join(work, 'script.json')
  fs.writeFileSync(scriptFile, JSON.stringify({ scripts: scenarios[SCENARIO] }))

  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    env: { ...process.env, FORJA_MOCK_SCRIPT: scriptFile },
    stdio: 'ignore',
    windowsHide: false
  })
  const cleanup = () => {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 })
    } catch {
      /* Electron may still hold the profile; the OS temp folder is cleaned later */
    }
  }
  process.on('exit', cleanup)

  let browser
  for (let attempt = 0; attempt < 40 && !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
  }
  if (!browser) throw new Error('o Electron não abriu a porta de depuração')
  let page
  for (let attempt = 0; attempt < 40 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:') || candidate.url().startsWith('http://localhost'))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`))
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.app-shell', { timeout: 30000 })
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })

  // Project + session on the scripted provider
  const created = await page.evaluate(async (folder) => {
    const settings = (await window.forja.app.settings()).value
    const mock = settings.providers.find((item) => item.kind === 'mock')
    if (!mock) return { error: 'sem provedor Scripted' }
    const added = await window.forja.projects.add(folder, 'Projeto de teste')
    if (!added.ok) return { error: added.error }
    const session = await window.forja.sessions.create({ projectId: added.value.id, cwd: added.value.path, mode: 'code', surface: 'code', providerId: mock.id, model: mock.model, title: 'Trabalho' })
    return session.ok ? { sessionId: session.value.id } : { error: session.error }
  }, project)
  if (created.error) throw new Error(created.error)
  await page.reload()
  await page.waitForSelector('.app-shell')
  await page.locator('.mode-switch button', { hasText: 'Code' }).click()
  await page.waitForTimeout(400)
  const row = page.locator('.side-session', { hasText: 'Trabalho' }).first()
  if (!(await row.count())) await page.locator('.side-project-name', { hasText: 'Projeto de teste' }).click()
  await page.locator('.side-session', { hasText: 'Trabalho' }).first().click()
  await page.waitForTimeout(600)

  // Send the prompt through the real composer
  const input = page.locator('textarea[aria-label="Mensagem"]')
  await input.fill('Faça o trabalho e me mostre o que está acontecendo.')
  await input.press('Enter')

  // While it works: plan dock, busy dot, running summary
  await page.waitForSelector('.plan-dock', { timeout: 20000 })
  results.planWhileRunning = await page.evaluate(() => ({
    header: document.querySelector('.plan-dock-head')?.textContent?.trim(),
    items: [...document.querySelectorAll('.plan-dock-item')].map((item) => `${item.className.match(/status-(\w+)/)?.[1]}:${item.textContent.trim()}`)
  }))
  results.busyDot = await page.locator('.side-busy').count()
  await shot('01-trabalhando-plano')

  if (SCENARIO === 'agents') {
    await page.waitForFunction(() => !document.querySelector('.status-line') && document.body.innerText.includes('Concluído: o explorer'), null, { timeout: 90000 })
    await page.waitForTimeout(800)
    results.panelAutoOpened = await page.evaluate(() => document.querySelector('.panel h2')?.textContent)
    if (!results.panelAutoOpened || !results.panelAutoOpened.includes('Tarefas')) {
      await page.locator('.tb-actions [aria-label="Ver opções"]').click()
      await page.locator('.menu-item', { hasText: 'Tarefas em segundo plano' }).click()
      await page.waitForTimeout(600)
    }
    const doneToggle = page.locator('.task-toggle.big')
    if (await doneToggle.count()) await doneToggle.click()
    await page.waitForTimeout(500)
    results.agentCards = await page.evaluate(() =>
      [...document.querySelectorAll('.task-row-card.kind-agent')].map((card) => ({
        title: card.querySelector(':scope > .task-head .task-title-text')?.textContent,
        chip: card.querySelector(':scope > .task-sub .task-agent-chip')?.textContent,
        model: card.querySelector(':scope > .task-sub .task-model')?.textContent,
        time: card.querySelector(':scope > .task-head .task-time')?.textContent,
        counts: card.querySelector(':scope > .task-agent-body > .task-counts')?.textContent,
        nested: [...card.querySelectorAll(':scope > .task-agent-body .task-row-card .task-title-text, :scope > .task-agent-body .task-line .task-line-title')].map((el) => el.textContent)
      }))
    )
    results.strip = await page.locator('.subagent-chip').allTextContents()
    results.sidebarDot = await page.locator('.side-busy').count()
    results.diskDobro = fs.existsSync(path.join(project, 'src', 'dobro.ts'))
    await shot('07-agentes-painel')
    results.errors = errors
    console.log(JSON.stringify(results, null, 2))
    cleanup()
    process.exit(0)
  }

  // Wait for the turn to end
  await page.waitForFunction(() => !document.querySelector('.status-line') && document.querySelectorAll('.message.assistant').length > 0, null, { timeout: 60000 })
  await page.waitForTimeout(800)

  results.summaries = await page.locator('.tool-group-text').allTextContents()
  results.editCards = await page.evaluate(() =>
    [...document.querySelectorAll('.edit-card')].map((card) => ({
      path: card.querySelector('.edit-card-path')?.textContent,
      counts: card.querySelector('.edit-card-count')?.textContent?.replace(/\s+/g, ' ').trim(),
      added: [...card.querySelectorAll('.edit-line.add .edit-text')].map((line) => line.textContent),
      removed: [...card.querySelectorAll('.edit-line.del .edit-text')].map((line) => line.textContent)
    }))
  )
  results.diskUtil = fs.existsSync(path.join(project, 'src', 'util.ts')) ? fs.readFileSync(path.join(project, 'src', 'util.ts'), 'utf8') : null
  results.diskReadme = fs.readFileSync(path.join(project, 'README.md'), 'utf8')
  results.planAfter = await page.locator('.plan-dock').count()
  results.busyAfter = await page.locator('.side-busy').count()
  await shot('02-concluido')

  // Tasks panel
  await page.locator('.tb-actions [aria-label="Ver opções"]').click()
  await page.locator('.menu-item', { hasText: 'Tarefas em segundo plano' }).click()
  await page.waitForSelector('.tasks-panel, .panel .panel-empty', { timeout: 5000 })
  await page.waitForTimeout(800)
  results.tasksPanel = await page.evaluate(() => ({
    toolbar: document.querySelector('.tasks-toolbar')?.textContent?.trim(),
    titles: [...document.querySelectorAll('.task-row-card .task-title-text')].map((el) => el.textContent),
    times: [...document.querySelectorAll('.task-row-card .task-time')].map((el) => el.textContent),
    failedMarks: document.querySelectorAll('.task-failed').length
  }))
  await shot('03-tarefas')
  const doneToggle = page.locator('.task-toggle.big')
  if (await doneToggle.count()) {
    await doneToggle.click()
    await page.waitForTimeout(300)
    results.tasksFinished = await page.evaluate(() => [...document.querySelectorAll('.task-row-card .task-title-text')].map((el) => el.textContent))
    await shot('04-tarefas-concluidas')
  }
  // Stop the background process from the panel
  const stop = page.locator('.task-stop').first()
  if (await stop.count()) {
    await stop.click()
    await page.waitForTimeout(1500)
    results.afterStop = await page.evaluate(() => document.querySelector('.tasks-toolbar')?.textContent?.trim())
  }

  // Error bar must be centered over the chat column (the composer's column), with and without the side panel
  await page.evaluate(async (projectPath) => {
    const settings = (await window.forja.app.settings()).value
    const real = settings.providers.find((item) => item.kind !== 'mock')
    const projects = (await window.forja.projects.list()).value
    const proj = projects.find((item) => item.path === projectPath) || projects[0]
    await window.forja.sessions.create({ projectId: proj.id, cwd: proj.path, mode: 'code', surface: 'code', providerId: real.id, model: real.model, title: 'Sem credencial' })
  }, project)
  await page.reload()
  await page.waitForSelector('.app-shell')
  await page.locator('.mode-switch button', { hasText: 'Code' }).click()
  await page.waitForTimeout(300)
  await page.locator('.side-session', { hasText: 'Sem credencial' }).first().click()
  await page.waitForTimeout(500)
  await page.locator('textarea[aria-label="Mensagem"]').fill('oi')
  await page.locator('textarea[aria-label="Mensagem"]').press('Enter')
  await page.waitForSelector('.error-bar', { timeout: 10000 })
  const measure = () =>
    page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect()
        return rect ? Math.round(rect.left + rect.width / 2) : null
      }
      return { errorCenter: box('.error-bar'), composerCenter: box('.composer'), workspaceCenter: box('.workspace'), windowCenter: Math.round(window.innerWidth / 2) }
    })
  results.errorBarNoPanel = await measure()
  await shot('05-erro-centralizado')
  await page.locator('.tb-actions [aria-label="Terminal"]').click()
  await page.waitForTimeout(800)
  results.errorBarWithPanel = await measure()
  await shot('06-erro-centralizado-com-painel')

  results.errors = errors
  console.log(JSON.stringify(results, null, 2))
  cleanup()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
