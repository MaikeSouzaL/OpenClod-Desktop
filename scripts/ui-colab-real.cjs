// End-to-end of "Google Colab (GPU)" against a REAL Colab: the connection code that the user's own run of the notebook printed,
// in the REAL app (Electron, throwaway profile). Same screens as scripts/ui-colab.cjs, but nothing is doubled: the server is the
// notebook's, the GPU is Colab's, the tunnel is Cloudflare's.
//
//   Configurações → Provedores → Google Colab (GPU) → paste the code → confirmation (host, model, GPU, vision) → Conectar →
//   the provider is in the model picker → a real session reads an image and calls a tool through the Colab GPU → (optional) the
//   Colab runtime is stopped by hand and the reserve takes over by itself → disconnect.
//
// The code contains the access key: it is read from a file, never printed, never written to the report, and the host of the tunnel
// is masked in the screenshots. The browser, Explorer and clipboard of the user are NOT touched (the app records what it would open).
//
//   node scripts/ui-colab-real.cjs --code-file <file with the connection code> [--root <snapshot>] [--label real] [--out dir]
//                                  [--drop-signal <file>]
//
// --drop-signal <file>: after the live session the script writes <file>.ready and waits until <file> exists; meanwhile stop the Colab
// runtime (Ambiente de execução → Desconectar e excluir o ambiente de execução), then create <file>: the script goes on to the part
// where the Colab has fallen and the reserve (the local Ollama, qwen3.5:4b) must take over.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const { startOllamaProxy } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'real')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'colab-2026-10-27')))
const CODE_FILE = e2e.arg('code-file', '')
const DROP_SIGNAL = e2e.arg('drop-signal', '')
const PORT = 9481
const MODULE = path.join(e2e.ROOT, 'resources', 'colab', 'openclod_llm_server.py')
const MASK = '[endereço do túnel]'
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const python = (() => {
  const embedded = path.join(e2e.ROOT, 'resources', 'runtime', 'python', 'python.exe')
  return fs.existsSync(embedded) ? embedded : 'python'
})()

/** The fields of the code, decoded by the notebook's own module (stdin in, JSON out: the code is never on a command line). */
function decodeCode(code) {
  const snippet = [
    'import importlib.util, json, sys',
    'sys.dont_write_bytecode = True',
    `spec = importlib.util.spec_from_file_location("oc", ${JSON.stringify(MODULE)})`,
    'oc = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(oc)',
    'print(json.dumps(oc.parse_connection_code(sys.stdin.read())))'
  ].join('\n')
  return JSON.parse(execFileSync(python, ['-X', 'utf8', '-I', '-c', snippet], { input: code, encoding: 'utf8' }))
}

/** A solid-color PNG (the model has to look at it). */
function solidPng(width, height, [r, g, b]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/* --------------------------------------- helpers --------------------------------------- */

const readSettings = (ws) => JSON.parse(fs.readFileSync(path.join(ws.profile, 'config', 'settings.json'), 'utf8'))
const thousands = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/** Screenshot with the tunnel's host hidden (it is part of the connection code); only the copy on the screen is changed. */
async function shot(page, name, host) {
  await page.evaluate(({ needle, mask }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) if (node.nodeValue.includes(needle)) node.nodeValue = node.nodeValue.split(needle).join(mask)
    for (const field of document.querySelectorAll('input, textarea')) if (field.value && field.value.includes(needle)) field.value = field.value.split(needle).join(mask)
  }, { needle: host, mask: MASK })
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

/** True when `needle` appears in any file of the profile's config, logs or data (as UTF-8 or UTF-16): the key must be nowhere. */
function foundInProfile(profile, needle) {
  const utf8 = Buffer.from(needle, 'utf8')
  const utf16 = Buffer.from(needle, 'utf16le')
  const hits = []
  const skip = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GraphiteDawnCache|Shared Dictionary|blob_storage|Crashpad)$/
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skip.test(entry.name)) walk(full)
        continue
      }
      try {
        if (fs.statSync(full).size >= 30 * 1024 * 1024) continue
        const data = fs.readFileSync(full)
        if (data.includes(utf8) || data.includes(utf16)) hits.push(path.relative(profile, full))
      } catch {
        // Chromium keeps some of its own files (cookies, leveldb locks) open while the app runs: those are not the app's data.
        foundInProfile.locked = (foundInProfile.locked || 0) + 1
      }
    }
  }
  walk(profile)
  return hits
}

async function openSettings(page) {
  await page.keyboard.press('Control+,')
  await page.waitForSelector('.colab-card', { timeout: 20000 })
  await page.locator('.colab-card').scrollIntoViewIfNeeded()
}

async function closeSettings(page) {
  await page.locator('button.btn.ghost', { hasText: /^Fechar$/ }).click()
  await page.waitForTimeout(300)
}

async function openModelMenu(page) {
  await page.locator('.model-btn:has(.model-short)').first().click()
  await page.waitForSelector('.model-menu', { timeout: 10000 })
}

async function menuState(page) {
  return page.evaluate(() => ({
    items: [...document.querySelectorAll('.model-menu [role="menuitem"], .model-menu .menu-item')].map((node) => (node.textContent || '').trim()),
    headings: [...document.querySelectorAll('.model-menu .menu-heading')].map((node) => (node.textContent || '').trim())
  }))
}

async function waitForFile(file, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

/**
 * The Colab VM is reclaimed a minute or two AFTER "Desconectar e excluir o ambiente de execução": measured on the real Colab, the tunnel
 * keeps answering 200, then 502 (the server is gone), then 530 (the tunnel is gone). Asking before that is answered by the live server.
 */
async function waitUntilDown(healthUrl, timeoutMs) {
  const started = Date.now()
  let status = 200
  while (Date.now() - started < timeoutMs) {
    status = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) }).then((res) => res.status, () => 0)
    if (status !== 200) return { down: true, status, seconds: Math.round((Date.now() - started) / 1000) }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  return { down: false, status, seconds: Math.round((Date.now() - started) / 1000) }
}

/* ---------------------------------------- the run ---------------------------------------- */

async function main() {
  if (!CODE_FILE) throw new Error('use --code-file <arquivo>: o código de conexão que o notebook mostrou (ele contém a chave: o script nunca o imprime)')
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim()
  const info = decodeCode(code)
  const url = String(info.u)
  const host = new URL(url).host
  const key = String(info.k)
  const statusUrl = `${url.replace(/\/v1\/?$/, '')}/openclod/status`
  const serverStatus = async () => (await fetch(statusUrl, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })).json()

  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-colabreal-' })
  const openLog = path.join(ws.work, 'aberturas.jsonl')
  const env = { OPENCLOD_E2E_OPEN_LOG: openLog, OPENCLOD_COLAB_DIR: path.join(ws.work, 'Documentos', 'Openclod', 'Colab') }
  const report = { label: LABEL, startedAt: new Date().toISOString(), model: info.m, gpu: info.g, context: info.c, engine: info.e, codeLength: code.length }
  let reserve = null
  let app = null

  try {
    app = await e2e.launch({ port: PORT, ...ws, env })
    const { page } = app

    /* ---- 1. the real code is pasted and confirmed ---- */
    await openSettings(page)
    check('o cartão "Google Colab (GPU)" está na aba Provedores, com a área do código', (await page.locator('.colab-code').count()) === 1)
    const field = page.locator('.colab-code')
    await field.fill(code.match(/.{1,60}/g).join('\n')) // pasted with line breaks, as a wrapped copy would be
    await page.waitForSelector('.colab-preview', { timeout: 10000 })
    const preview = (await page.locator('.colab-preview').textContent()) || ''
    check('o código REAL do Colab (feito pelo notebook rodando na GPU) é aceito e mostra a confirmação', /Conectar/.test(preview))
    check(
      'a confirmação mostra o servidor, o modelo, a GPU, visão, ferramentas, contexto e a versão do notebook',
      preview.includes(host) && preview.includes(info.m) && preview.includes(String(info.g).split(' (')[0]) && /Imagens.*sim/.test(preview) && /Ferramentas.*sim/.test(preview) && preview.includes(`${thousands(info.c)} tokens`) && preview.includes(`v${info.nb}`),
      preview.replace(host, MASK).replace(/\s+/g, ' ').slice(0, 240)
    )
    check('o endereço é um túnel do Colab (*.trycloudflare.com): a confirmação diz isso e não avisa de nada', /túnel do Colab/.test(preview) && !/modo de teste/.test(preview) && !/fora do padrão/.test(preview))
    check('o notebook do Colab é reconhecido como o original desta versão do Openclod (mesmo hash do servidor)', /original/.test(preview) && !/não confere/.test(preview), `sh ${info.sh}`)
    check('a confirmação avisa que a conversa e os arquivos passam por esse servidor', /passarão por este servidor/.test(preview))
    const pageText = await page.evaluate(() => document.body.innerText)
    check('a chave não aparece em lugar nenhum da tela', !pageText.includes(key))
    const mask = await page.evaluate(() => getComputedStyle(document.querySelector('.colab-code')).webkitTextSecurity)
    check('a caixa do código fica mascarada por padrão (o código contém a chave)', mask === 'disc', mask)
    check('conferir não grava nada: o settings.json segue sem o provedor do Colab', !readSettings(ws).providers.some((provider) => provider.id === 'colab'))
    report.shotConfirm = await shot(page, '03-codigo-colado-e-confirmacao', host)

    /* ---- 2. connect (the app asks the real server, through the tunnel, with the key) ---- */
    const tConnect = Date.now()
    await page.locator('.colab-connect').click()
    await page.waitForSelector('.colab-status.ok', { timeout: 90000 })
    report.connectSeconds = Math.round((Date.now() - tConnect) / 1000)
    const after = readSettings(ws).providers.find((provider) => provider.id === 'colab')
    check(
      'conectado: o provedor "colab" existe, com visão, ferramentas e a janela de contexto que o SERVIDOR informou',
      Boolean(after) && after.supportsVision === true && after.supportsTools === true && after.contextWindow === info.c && after.model === info.m && after.baseUrl === url,
      after && { vision: after.supportsVision, tools: after.supportsTools, ctx: after.contextWindow, model: after.model }
    )
    check('a chave foi para o cofre: o settings.json guarda só "secret:colab"', after.apiKeyRef === 'secret:colab' && !JSON.stringify(readSettings(ws)).includes(key), after.apiKeyRef)
    check('a chave não está em NENHUM arquivo do perfil (configurações, logs, dados), nem em UTF-8 nem em UTF-16', foundInProfile(ws.profile, key).length === 0, foundInProfile(ws.profile, key))
    check('o código de conexão inteiro também não está em nenhum arquivo do perfil', foundInProfile(ws.profile, code.slice(6, 60)).length === 0)
    await page.waitForSelector('.provider-tile:has-text("Google Colab")', { timeout: 15000 })
    const summary = (await page.locator('.colab-summary').textContent()) || ''
    check('o cartão passa a mostrar o servidor, o modelo, a GPU, "lê imagens" e o contexto', summary.includes(info.m) && /lê imagens/.test(summary) && summary.includes(`${thousands(info.c)} tokens`) && /notebook original/.test(summary), summary.replace(host, MASK).replace(/\s+/g, ' ').slice(0, 240))
    check('depois de conectar a caixa do código some (não sobra a chave na tela)', (await page.locator('.colab-code').count()) === 0)
    report.shotConnected = await shot(page, '04-conectado', host)
    await page.locator('.provider-tile:has-text("Google Colab")').click()
    await page.waitForSelector('.provider-card')
    check('o cartão do provedor Colab: endereço travado, sem campo de chave, sem "remover"', (await page.locator('.provider-card label.field:has-text("Base URL") input').isDisabled()) && (await page.locator('.provider-card input[type="password"]').count()) === 0 && (await page.locator('.provider-card [title="Remover"]').count()) === 0)
    report.shotProviderCard = await shot(page, '05-cartao-do-provedor', host)
    await closeSettings(page)

    /* ---- 3. the picker, without restarting ---- */
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Colab real', projectName: 'Colab', providerId: 'colab' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Colab real', 'Colab')
    await openModelMenu(page)
    const menu = await menuState(page)
    check('o seletor de modelo do compositor lista "Google Colab (GPU)" com o modelo, sem reiniciar o app', menu.headings.some((heading) => /Google Colab/.test(heading)) && menu.items.some((item) => item.includes(info.m)), menu.headings)
    await page.locator('.menu-search').fill('qwen3.5')
    await page.waitForTimeout(300)
    report.shotPicker = await shot(page, '06-seletor-de-modelo', host)
    await page.keyboard.press('Escape')
    check('o compositor mostra o modelo do Colab na sessão', ((await page.locator('.model-btn .model-short').first().textContent()) || '').includes(info.m))

    /* ---- 4. a real session: image + tool through the Colab GPU ---- */
    const ask = async (text, images = []) => {
      const before = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.messages.length, session.sessionId)
      await page.evaluate(({ id, text, images }) => window.openclod.sessions.send(id, text, images, 'auto'), { id: session.sessionId, text, images })
      const state = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 900000, sinceCount: before })
      return { before, state, report: await e2e.turnReport(page, session.sessionId, before) }
    }
    const baseline = await serverStatus()
    const image = { type: 'image', mediaType: 'image/png', data: solidPng(112, 112, [30, 170, 60]).toString('base64'), label: 'quadrado.png' }
    const t0 = Date.now()
    let turn = await ask('Olhe a imagem anexada. Use a ferramenta write_file para criar o arquivo cor.txt contendo apenas o nome da cor predominante da imagem, em português e em letras minúsculas. Depois diga em uma frase o que fez.', [image])
    const colorFile = path.join(ws.project, 'cor.txt')
    const calls = [...turn.report.calls]
    const readColor = () => (fs.existsSync(colorFile) ? fs.readFileSync(colorFile, 'utf8').trim().toLowerCase() : '')
    let attempts = 1
    while (!/verde/.test(readColor()) && attempts < 3) {
      attempts++
      turn = await ask(
        fs.existsSync(colorFile)
          ? 'A cor que você escreveu em cor.txt está errada. Olhe de novo a imagem anexada e reescreva cor.txt com a ferramenta write_file, só com o nome da cor predominante da imagem (em português, minúsculas).'
          : 'Atenção: o arquivo cor.txt ainda NÃO existe, porque você não chamou a ferramenta write_file. Chame a ferramenta write_file agora, de verdade, para criar cor.txt com o nome da cor da imagem anexada (em português, minúsculas).'
      )
      calls.push(...turn.report.calls)
    }
    report.attempts = attempts
    report.turnSeconds = Math.round((Date.now() - t0) / 1000)
    const color = readColor()
    check('sessão real pela GPU do Colab: o modelo VIU a imagem (a cor certa foi escrita no arquivo)', /verde/.test(color), { color, attempts, final: turn.report.finalText.slice(0, 120) })
    check('...e CHAMOU a ferramenta write_file (chamada de ferramenta em stream pelo servidor do Colab)', calls.includes('write_file'), { calls, attempts })
    const live = await serverStatus()
    const delta = (name) => (live[name] || 0) - (baseline[name] || 0)
    report.serverDelta = { requests: delta('requests'), images: delta('images'), promptTokens: delta('prompt_tokens'), completionTokens: delta('completion_tokens'), errors: delta('errors') }
    check('o servidor do Colab contou os pedidos deste app, ao menos uma imagem e os tokens (e nenhum erro)', report.serverDelta.requests >= 2 && report.serverDelta.images >= 1 && report.serverDelta.promptTokens > 0 && report.serverDelta.completionTokens > 0 && report.serverDelta.errors === 0, report.serverDelta)
    const meta = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.meta, session.sessionId)
    check('a sessão terminou no Colab (a reserva não precisou entrar)', meta.providerId === 'colab' && meta.model === info.m, { providerId: meta.providerId })
    report.shotSession = await shot(page, '07-sessao-com-imagem-e-ferramenta', host)

    /* ---- 5. (optional) the Colab runtime is stopped by hand; the reserve takes over ---- */
    if (DROP_SIGNAL) {
      reserve = await startOllamaProxy()
      await page.evaluate(async ({ baseUrl }) => {
        const settings = (await window.openclod.app.settings()).value
        const providers = settings.providers.map((provider) => (provider.id === 'ollama' ? { ...provider, baseUrl, model: 'qwen3.5:4b', supportsVision: true, supportsTools: true, models: ['qwen3.5:4b'] } : provider))
        await window.openclod.app.updateSettings({ providers, useAllModels: true, fallbackOrder: ['ollama'], fallbackExclude: [] })
      }, { baseUrl: reserve.baseUrl })
      fs.rmSync(DROP_SIGNAL, { force: true })
      fs.writeFileSync(`${DROP_SIGNAL}.ready`, 'pronto')
      console.log(`\n>>> Ao vivo no Colab. Pare o runtime do Colab e crie o arquivo ${DROP_SIGNAL} para continuar.`)
      const signalled = await waitForFile(DROP_SIGNAL, 25 * 60 * 1000)
      check('o sinal de "runtime do Colab parado" chegou', signalled)
      const gone = await waitUntilDown(`${url.replace(/\/v1\/?$/, '')}/healthz`, 6 * 60 * 1000)
      report.tunnelDown = gone
      check('o servidor do Colab realmente parou de responder pelo túnel (a VM é recolhida depois de "Desconectar e excluir")', gone.down, gone)
      const t1 = Date.now()
      const second = await ask('Qual é o nome do arquivo que você criou antes e o que está escrito nele? Responda curto.')
      report.reserveSeconds = Math.round((Date.now() - t1) / 1000)
      const after2 = await page.evaluate(async (id) => {
        const value = (await window.openclod.sessions.get(id)).value
        return {
          meta: value.meta,
          notes: value.messages.filter((message) => message.role === 'system' && message.notice).map((message) => message.parts.map((part) => part.text || '').join(' '))
        }
      }, session.sessionId)
      check('o runtime do Colab parou de verdade e a reserva assumiu sozinha no meio do turno: a sessão agora está no Ollama', after2.meta.providerId === 'ollama', { providerId: after2.meta.providerId })
      check('a conversa avisa a troca, citando o Colab e o motivo "sem conexão"', after2.notes.some((note) => /Google Colab \(GPU\)/.test(note) && /falhou \(.*sem conexão\)/.test(note) && /continuando com Ollama/.test(note)), after2.notes.map((note) => note.replace(host, MASK)))
      check('o histórico seguiu: o modelo da reserva respondeu sobre o arquivo criado antes', /cor\.txt/i.test(second.report.finalText), second.report.finalText.slice(0, 160))
      check('o aviso da troca aparece na conversa', await page.waitForSelector('.transcript-notice', { timeout: 10000 }).then(() => true, () => false))
      report.shotReserve = await shot(page, '09-reserva-assumiu-na-conversa', host)

      await openSettings(page)
      await page.locator('.colab-test').click()
      await page.waitForSelector('.colab-status.bad', { timeout: 60000 })
      const problem = (await page.locator('.colab-problem').textContent()) || ''
      check('Colab parado (a borda real da Cloudflare responde pelo túnel morto): o cartão passa a "caiu" e diz o que fazer, sem HTML', /caiu/.test((await page.locator('.colab-status').textContent()) || '') && /sessão do Colab provavelmente terminou/.test(problem) && !/<html/i.test(problem), problem.replace(host, MASK).slice(0, 200))
      report.shotDown = await shot(page, '08-cartao-caiu', host)
      await closeSettings(page)

      const fresh = await e2e.newSession(page, { folder: ws.project, title: 'Nova com o Colab parado', projectName: 'Colab', providerId: 'colab' })
      await page.evaluate(async ({ id }) => {
        await window.openclod.sessions.send(id, 'Responda apenas: ok.', [], 'auto')
        return true
      }, { id: fresh.sessionId })
      const settledFresh = await e2e.waitSettled(page, fresh.sessionId, { timeoutMs: 900000, sinceCount: 0 })
      const freshState = await page.evaluate(async (id) => {
        const value = (await window.openclod.sessions.get(id)).value
        const last = [...value.messages].reverse().find((message) => message.role === 'assistant' && message.parts.some((part) => part.type === 'text'))
        return { providerId: value.meta.providerId, model: value.meta.model, answer: last ? last.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '' }
      }, fresh.sessionId)
      check('uma conversa NOVA pedida no Colab parado já nasce na reserva e responde', freshState.providerId === 'ollama' && freshState.model === 'qwen3.5:4b' && settledFresh.run !== 'error' && /\bok\b/i.test(freshState.answer), { providerId: freshState.providerId, model: freshState.model, answer: freshState.answer.slice(0, 80) })
    }

    /* ---- 6. disconnect ---- */
    await openSettings(page)
    await page.locator('.colab-disconnect').click()
    check('Desconectar pede uma segunda confirmação (um clique só não apaga)', /Confirmar/.test((await page.locator('.colab-disconnect').textContent()) || ''))
    await page.locator('.colab-disconnect').click()
    await page.waitForFunction(() => !document.querySelector('.colab-summary'), null, { timeout: 15000 })
    const gone = readSettings(ws)
    check('desconectado: o provedor sai das configurações e da reserva', !gone.providers.some((provider) => provider.id === 'colab') && !(gone.fallbackOrder || []).includes('colab'))
    check('desconectado: a chave foi apagada do cofre (o app não encontra mais credencial)', await page.evaluate(async () => !(await window.openclod.app.capabilities()).value.providers.some((item) => item.id === 'colab' && item.configured)))
    report.shotDisconnected = await shot(page, '11-desconectado', host)
  } finally {
    report.errors = ((app && app.errors) || []).filter((line) => line.startsWith('pageerror'))
    report.profileFilesLockedByChromium = foundInProfile.locked || 0
    if (app) app.cleanup()
    if (reserve) await reserve.close().catch(() => undefined)
    // The report is written even when a step throws: a failure must leave its record (the checks so far).
    report.checks = checks
    fs.writeFileSync(path.join(OUT, `${LABEL}-ui-colab-real.json`), JSON.stringify(report, null, 2))
  }
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, path.join(OUT, `${LABEL}-ui-colab-real.json`))}`)
  process.exit(ok() ? 0 : 1)
}

main().catch((err) => {
  // A failure must never carry the connection code (a locator's call log can echo what was typed into a field).
  const scrub = (text) => String(text).replace(/OCLC1\.[A-Za-z0-9_.\-\s]{20,}/g, 'OCLC1.[REDACTADO]').replace(/occ_[A-Za-z0-9_-]+/g, 'occ_[REDACTADO]').replace(/[A-Za-z0-9-]+\.trycloudflare\.com/g, '[endereço do túnel]')
  console.error('ERRO', scrub(err.stack || err.message))
  process.exit(2)
})
