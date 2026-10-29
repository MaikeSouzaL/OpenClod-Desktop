// End-to-end of "o Chat também usa o computador", in the REAL app (Electron, throwaway profile) with a REAL model:
//
//   Início (the Chat surface) → the first message of a new conversation goes through the real composer → the app opens the session in
//   Computer Use (it used to open in the read-only "ask" mode, and the model answered with instructions for the user to follow) →
//   (1) BY COMMAND: asked to "create a folder", the model does it, in a throwaway folder (never the user's real Desktop);
//   (2) BY MOUSE (--mouse): a window with one big red button ("CLIQUE AQUI", scripts/lib/click-target.ps1) appears on top, in the
//       middle of the primary monitor; asked to click it with the mouse, the model takes a screenshot and clicks; the button itself
//       records where the pointer was. This moves and clicks the REAL mouse of the machine running it.
//
// Model: by default the small local one of this machine (Ollama `qwen3.5:4b`, through scripts/lib/fake-provider.cjs). With --real the
// throwaway profile gets a copy of the keys and settings of the user's profile (scripts/lib/e2e.cjs makeWorkspace) and --provider picks
// the provider, e.g. `--real --provider colab` for the Qwen3.5 the user serves from Google Colab (it points on a 0..1000 grid).
//
//   node scripts/ui-chat-computer.cjs [--root <snapshot>] [--label chat] [--out dir] [--mouse] [--real --provider colab]
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const { startOllamaProxy } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'chat')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'chat-computer-2026-10-27')))
const PORT = 9491
const LOCAL_MODEL = 'qwen3.5:4b'
const FOLDER = 'azul'
const REAL = process.argv.includes('--real')
const MOUSE = process.argv.includes('--mouse')
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

// A capture is evidence, not a check: if the window does not paint in time (a background window can stall), the run says so and goes on.
const shot = async (page, name) => {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.screenshot({ path: file, timeout: 15000 })
      return path.relative(e2e.ROOT, file)
    } catch {
      await page.bringToFront().catch(() => undefined)
      await page.waitForTimeout(1500)
    }
  }
  console.log(`(a captura ${name} não saiu depois de 3 tentativas)`)
  return ''
}

const toolsOf = (messages) =>
  messages
    .flatMap((message) => message.parts.filter((part) => part.type === 'tool_use' || part.type === 'tool-call' || part.name).map((part) => ({ name: part.name || part.toolName, args: part.args || part.input })))
    .filter((item) => item.name)

async function ask(page, sessionId, text) {
  const before = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.messages.length, sessionId)
  await page.evaluate(({ id, text }) => window.openclod.sessions.send(id, text, [], 'auto'), { id: sessionId, text })
  const state = await e2e.waitSettled(page, sessionId, { timeoutMs: 600000, sinceCount: before })
  const value = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value, sessionId)
  return { state, tools: toolsOf(value.messages.slice(before)) }
}

/** The target window: resolves when it is on screen, with its button's screen rectangle. */
async function startTarget(dir) {
  const out = path.join(dir, 'clique.json')
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(e2e.ROOT, 'scripts', 'lib', 'click-target.ps1'), '-Out', out, '-Seconds', '900'], { windowsHide: false })
  for (let attempt = 0; attempt < 80 && !fs.existsSync(`${out}.bounds.json`); attempt++) await new Promise((resolve) => setTimeout(resolve, 250))
  if (!fs.existsSync(`${out}.bounds.json`)) throw new Error('a janela-alvo não abriu')
  return {
    bounds: JSON.parse(fs.readFileSync(`${out}.bounds.json`, 'utf8')),
    clicked: () => (fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null),
    stop: () => {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    }
  }
}

async function main() {
  const ws = e2e.makeWorkspace({ real: REAL, prefix: 'openclod-chatcu-' })
  const report = { label: LABEL, startedAt: new Date().toISOString(), real: REAL }
  let app = null
  let proxy = null
  let target = null
  try {
    if (!REAL) proxy = await startOllamaProxy()
    app = await e2e.launch({ port: PORT, ...ws })
    const { page } = app

    // The only project is a throwaway folder: the app picks the first project for a conversation started on Início, so nothing here
    // touches the Desktop of the person running this.
    report.model = await page.evaluate(async ({ folder, baseUrl, model, real }) => {
      await window.openclod.projects.add(folder, 'Pasta de teste')
      const settings = (await window.openclod.app.settings()).value
      if (real) {
        const chosen = settings.providers.find((provider) => provider.id === settings.defaultProviderId)
        return chosen ? `${chosen.id}/${chosen.model}` : 'sem provedor'
      }
      const providers = settings.providers.map((provider) => (provider.id === 'ollama' ? { ...provider, baseUrl, model, supportsVision: true, supportsTools: true, models: [model] } : provider))
      await window.openclod.app.updateSettings({ providers, defaultProviderId: 'ollama', useAllModels: false, policy: { ...settings.policy, mode: 'auto', allowComputerControl: true } })
      return `ollama/${model}`
    }, { folder: ws.project, baseUrl: proxy ? proxy.baseUrl : '', model: LOCAL_MODEL, real: REAL })
    console.log(`modelo: ${report.model}`)
    await page.reload()
    await page.waitForSelector('.app-shell')
    await page.waitForTimeout(800)

    const home = await page.locator('.composer-dock.is-home').count()
    check('o app abre no Início (Chat), com o campo "Como posso ajudar você hoje?"', home === 1)
    report.shotHome = await shot(page, '01-inicio')

    /* ---- 1. by command ---- */
    const sessionsBefore = await page.evaluate(async () => (await window.openclod.sessions.list()).value.length)
    await e2e.send(page, `Crie uma nova pasta chamada ${FOLDER} aqui, no diretório de trabalho desta conversa. Depois me diga em uma frase o que você fez.`)
    let created = null
    for (let attempt = 0; attempt < 60 && !created; attempt++) {
      await page.waitForTimeout(1000)
      const list = await page.evaluate(async () => (await window.openclod.sessions.list()).value)
      if (list.length > sessionsBefore) created = list[0]
    }
    check('a primeira mensagem do Início abriu uma conversa de Chat', Boolean(created) && created.meta.surface === 'chat', created && created.meta.surface)
    check('a conversa do Chat abre em Computer Use (e não mais em "Perguntar", que só lê)', Boolean(created) && created.meta.mode === 'computer', created && created.meta.mode)
    report.sessionMode = created && created.meta.mode
    const sessionId = created.meta.id

    const folder = path.join(ws.project, FOLDER)
    const t0 = Date.now()
    let attempts = 1
    let state = await e2e.waitSettled(page, sessionId, { timeoutMs: 600000, sinceCount: 0 })
    // A small model now and then answers without calling the tool; it is told, up to twice, and how many tries it took is in the report.
    while (!fs.existsSync(folder) && attempts < 3) {
      attempts++
      ;({ state } = await ask(page, sessionId, `A pasta ${FOLDER} ainda NÃO existe. Crie-a agora, de verdade, com uma ferramenta (por exemplo run_command com mkdir ${FOLDER}) no diretório de trabalho, e confira com list_dir.`))
    }
    report.command = { attempts, seconds: Math.round((Date.now() - t0) / 1000) }
    const full = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value, sessionId)
    const tools = toolsOf(full.messages).map((item) => item.name)
    report.command.tools = tools
    check('POR COMANDO: o modelo CRIOU a pasta no computador (não só explicou como fazer)', fs.existsSync(folder) && fs.statSync(folder).isDirectory(), { attempts, tools: tools.slice(0, 8) })
    check('...usando ferramentas que o Chat antes não tinha (terminal ou Computer Use)', tools.some((name) => /^(run_command|computer_|write_file)/.test(String(name))), tools.slice(0, 12))
    const lastAnswer = [...full.messages].reverse().find((message) => message.role === 'assistant' && message.parts.some((part) => part.type === 'text'))
    const answer = lastAnswer ? lastAnswer.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : ''
    check('...e disse o que fez', /pasta|azul|criei|criada/i.test(answer), answer.slice(0, 160))
    check('a conversa terminou sem erro', state.run !== 'error', state.run)
    report.shotCommand = await shot(page, '02-pasta-criada')

    /* ---- 2. by mouse ---- */
    if (MOUSE) {
      target = await startTarget(ws.work)
      report.target = target.bounds
      const t1 = Date.now()
      const mouseTools = []
      let tries = 0
      const prompts = [
        'Agora use o mouse. Na tela principal apareceu uma janela "Alvo do teste do Openclod" com um botão vermelho escrito CLIQUE AQUI. ' +
          'Clique nesse botão com o mouse: tire uma computer_screenshot e use computer_click com as coordenadas do botão (as que o resultado da captura indicar). ' +
          'Não use o teclado nem comandos. Depois diga onde clicou.',
        'O botão ainda não foi clicado (quando é clicado ele fica verde e escrito OK!). Tire uma nova computer_screenshot, ' +
          'confira no recorte com a cruz vermelha onde o ponteiro parou e clique no centro do botão vermelho CLIQUE AQUI.'
      ]
      while (!target.clicked() && tries < 3) {
        const turn = await ask(page, sessionId, prompts[Math.min(tries, 1)])
        mouseTools.push(...turn.tools)
        tries++
        state = turn.state
      }
      const click = target.clicked()
      const b = target.bounds
      report.mouse = {
        tries,
        seconds: Math.round((Date.now() - t1) / 1000),
        click,
        tools: mouseTools.map((item) => item.name),
        clicks: mouseTools.filter((item) => /computer_(click|mouse_move)/.test(item.name)).map((item) => item.args)
      }
      check('PELO PONTEIRO: o modelo clicou no botão da janela-alvo com o mouse (o próprio botão registrou o clique)', Boolean(click), report.mouse.clicks.slice(0, 6))
      check(
        '...e o ponteiro estava DENTRO do botão',
        Boolean(click) && click.x >= b.x && click.x < b.x + b.width && click.y >= b.y && click.y < b.y + b.height,
        click ? { clique: [click.x, click.y], botao: b } : null
      )
      check('...usando a captura de tela e o clique por coordenada (sem teclado nem comando)', report.mouse.tools.includes('computer_screenshot') && report.mouse.tools.some((name) => /computer_(click|mouse_move)/.test(name)), report.mouse.tools.slice(0, 14))
      report.shotMouse = await shot(page, '03-clique-com-o-mouse')
    }
  } finally {
    if (target) target.stop()
    report.errors = ((app && app.errors) || []).filter((line) => line.startsWith('pageerror'))
    if (app) app.cleanup()
    if (proxy) await proxy.close().catch(() => undefined)
    report.checks = checks
    fs.writeFileSync(path.join(OUT, `${LABEL}-ui-chat-computer.json`), JSON.stringify(report, null, 2))
  }
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, path.join(OUT, `${LABEL}-ui-chat-computer.json`))}`)
  process.exit(ok() ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
