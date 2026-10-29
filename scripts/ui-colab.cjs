// End-to-end of "Google Colab (GPU)" as the user lives it, in the REAL app (Electron, throwaway profile) with a REAL model:
//
//   Configurações → Provedores → Google Colab (GPU) → "Abrir o Google Colab" (the browser, Explorer and clipboard are NOT touched:
//   the app records what it would have done) → the notebook file → paste the connection code → confirmation (host, model, GPU,
//   vision) → Conectar → the provider is in the model picker with no restart → a real session reads an image and calls a tool
//   through it → the Colab "falls" (the tunnel answers the REAL Cloudflare 530 page) → the reserve takes over by itself and says so
//   in the conversation → reconnect with a new code (short) → close and reopen the app → disconnect.
//
// The Colab itself cannot run here (it needs the user's Google account and a GPU in the cloud), so the notebook's server module
// (resources/colab/openclod_llm_server.py, the very file the notebook embeds) runs LOCALLY as a double of the Colab, in front of the
// real small model of this machine (Ollama `qwen3.5:4b`: it reads images and calls tools). Everything between the app and that
// module (the auth, /v1/models, SSE, images, tools, the connection code made by the module, the vault) is the real thing.
//
//   node scripts/ui-colab.cjs [--root <snapshot>] [--label depois] [--out dir] [--skip-model]
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync, spawn } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const { startOllamaProxy } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'depois')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'colab-2026-10-27')))
const SKIP_MODEL = process.argv.includes('--skip-model')
// --tunnel <cloudflared.exe>: the double is published by a REAL Cloudflare quick tunnel (https://<nome>.trycloudflare.com), as in the notebook.
const TUNNEL = e2e.arg('tunnel', '')
const PORT = 9471
const MODULE = path.join(e2e.ROOT, 'resources', 'colab', 'openclod_llm_server.py')
const MODEL = 'qwen3.5:4b'
const GPU = 'RTX 2060 (6 GB) · dublê local do Colab'
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const python = (() => {
  const embedded = path.join(e2e.ROOT, 'resources', 'runtime', 'python', 'python.exe')
  return fs.existsSync(embedded) ? embedded : 'python'
})()

/* ------------------------------ the double of the Colab ------------------------------ */

/**
 * The notebook's server module in front of the local Ollama, plus the connection code the module itself prints. With `tunnel`
 * (the path of cloudflared) the double is published by a REAL Cloudflare quick tunnel, as in the notebook, and the code carries
 * the public https address; without it the code points at this computer (http://127.0.0.1).
 */
async function startDouble({ tunnel } = {}) {
  const key = `occ_${crypto.randomBytes(18).toString('base64url')}`
  const child = spawn(python, ['-X', 'utf8', '-I', MODULE, 'serve', '--engine-url', 'http://127.0.0.1:11434', '--model', MODEL, '--key', key, '--ctx', '32768', '--thinking', 'off', '--gpu', GPU], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`o dublê do Colab não subiu: ${output}`)), 20000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      const match = /"port":\s*(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.stderr.on('data', (chunk) => (output += chunk.toString()))
    child.on('exit', (code) => reject(new Error(`o dublê saiu (${code}): ${output}`)))
  })
  let publicBase = ''
  let tunnelChild = null
  if (tunnel) {
    tunnelChild = spawn(tunnel, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let log = ''
    publicBase = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`o cloudflared não mostrou o endereço: ${log.slice(-300)}`)), 45000)
      const onData = (chunk) => {
        log += chunk.toString()
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(log)
        if (match) {
          clearTimeout(timer)
          resolve(match[0])
        }
      }
      tunnelChild.stdout.on('data', onData)
      tunnelChild.stderr.on('data', onData)
    })
    // The new name takes a few seconds to answer (the notebook waits for the same thing before printing the code).
    let up = false
    for (let attempt = 0; attempt < 60 && !up; attempt++) {
      up = await fetch(`${publicBase}/healthz`, { signal: AbortSignal.timeout(8000) }).then((res) => res.status === 200, () => false)
      if (!up) await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (!up) throw new Error(`o endereço público ${publicBase} não respondeu`)
  }
  const url = `${publicBase || `http://127.0.0.1:${port}`}/v1`
  const code = execFileSync(python, ['-X', 'utf8', '-I', MODULE, 'code', '--url', url, '--key', key, '--model', MODEL, '--gpu', GPU, '--ctx', '32768'], { encoding: 'utf8' }).trim()
  const status = async () => (await fetch(`http://127.0.0.1:${port}/openclod/status`, { headers: { authorization: `Bearer ${key}` } })).json()
  const kill = (pid) => {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* already gone */
    }
  }
  const stopTunnel = () => tunnelChild && kill(tunnelChild.pid)
  const stop = () => {
    stopTunnel()
    kill(child.pid)
  }
  return { key, port, url, host: new URL(url).host, code, status, stop, stopTunnel, child }
}

/** What a Cloudflare quick tunnel answers when the notebook behind it is gone: the REAL captured page (HTTP 530, "Error 1033"). */
async function startTunnelDownPage(port) {
  const page = JSON.parse(fs.readFileSync(path.join(e2e.ROOT, 'tests', 'fixtures', 'colab', 'cloudflare-530-tunel-encerrado.json'), 'utf8'))
  const hits = []
  const server = http.createServer((req, res) => {
    req.resume()
    hits.push({ method: req.method, url: req.url })
    res.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', server: 'cloudflare' })
    res.end(page.body)
  })
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      return { hits, close: () => new Promise((done) => server.close(() => done())) }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`não consegui abrir a página 530 na porta ${port}`)
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
const shot = async (page, name) => {
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

/* ---------------------------------------- the run ---------------------------------------- */

async function main() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-colab-' })
  const openLog = path.join(ws.work, 'aberturas.jsonl')
  const notebookDir = path.join(ws.work, 'Documentos', 'Openclod', 'Colab')
  const env = { OPENCLOD_E2E_OPEN_LOG: openLog, OPENCLOD_COLAB_DIR: notebookDir }
  const report = { label: LABEL, startedAt: new Date().toISOString(), model: MODEL }
  const doubles = []
  let down = null
  let reserve = null
  let app = null

  try {
    const first = await startDouble({ tunnel: TUNNEL || undefined })
    doubles.push(first)
    report.codeLength = first.code.length
    app = await e2e.launch({ port: PORT, ...ws, env })
    const { page } = app

    /* ---- 1. the button ---- */
    await openSettings(page)
    check('o cartão "Google Colab (GPU)" está na aba Provedores, com o botão e a área do código', (await page.locator('.colab-open').count()) === 1 && (await page.locator('.colab-code').count()) === 1)
    check('o cartão diz, na tela e sem precisar abrir nada, que o Google pode encerrar a sessão sem aviso', /sem aviso/.test((await page.locator('.colab-warning').textContent()) || ''))
    const limits = (await page.locator('.colab-limits').textContent()) || ''
    check('o cartão traz os limites e termos do Colab, com a alternativa e os links oficiais', /serviços web/.test(limits) && /proxies remotos/.test(limits) && /GPU alugada/.test(limits) && (await page.locator('.colab-limits a[href*="research.google.com/colaboratory"]').count()) === 2)
    report.shotCardBefore = await shot(page, '01-cartao-antes')

    await page.locator('.colab-open').click()
    await page.waitForSelector('.colab-steps', { timeout: 20000 })
    const file = path.join(notebookDir, 'openclod-servidor-llm.ipynb')
    const notebook = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('o botão gravou o notebook numa pasta visível (.ipynb nbformat 4) que pede GPU', notebook.nbformat === 4 && notebook.metadata.accelerator === 'GPU' && notebook.cells.length >= 10, path.relative(ws.work, file))
    const embedded = notebook.cells.find((cell) => cell.id === 'openclod-servidor').source.join('')
    check('o notebook leva, legível, o mesmo servidor que o dublê executa (o arquivo dos recursos do app)', embedded.includes(fs.readFileSync(MODULE, 'utf8').replace(/\r\n/g, '\n').slice(0, 4000)))
    const compiled = execFileSync(python, ['-X', 'utf8', '-I', '-c', 'import ast,json,sys\nfor s in json.load(sys.stdin):\n    ast.parse(s)\nprint("ok")'], { input: JSON.stringify(notebook.cells.filter((cell) => cell.cell_type === 'code').map((cell) => cell.source.join(''))), encoding: 'utf8' }).trim()
    check('toda célula de código do notebook gerado pelo app compila em Python', compiled === 'ok', compiled)
    const opened = fs.readFileSync(openLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    check('o app copiou o caminho, mostrou o arquivo e abriu SÓ o Colab (nada foi aberto de verdade; nada publicado)', opened.length === 3 && opened[0].kind === 'copy' && opened[0].target === file && opened[1].kind === 'reveal' && opened[2].kind === 'url' && opened[2].target === 'https://colab.research.google.com/', opened)
    const steps = await page.locator('.colab-steps li').allTextContents()
    check('mostra os 5 passos, em português, da primeira execução', steps.length === 5 && /Fazer upload de notebook/.test(steps[0]) && /Executar tudo/.test(steps[1]) && /CÓDIGO DE CONEXÃO/.test(steps[3]), steps.map((step) => step.slice(0, 40)))
    // The file itself is on screen as a tile to drag into Colab's upload area (the native drag is started by the main process).
    const tile = page.locator('.colab-file')
    const tileText = (await tile.textContent()) || ''
    check(
      'o cartão mostra o arquivo do notebook (nome, tamanho, caminho) e o arrastar como opcional',
      (await tile.count()) === 1 && (await tile.getAttribute('draggable')) === 'true' && tileText.includes('openclod-servidor-llm.ipynb') && /\d+ KB/.test(tileText) && tileText.includes(file) && /Arraste/.test(tileText),
      tileText.replace(/\s+/g, ' ').slice(0, 200)
    )
    check('o primeiro passo leva pelo caminho colado (arrastar é só opcional)', /cole o caminho/i.test(steps[0]))
    check('o cartão tem o botão "Copiar caminho" e a dica do método garantido', (await page.locator('.colab-copy-path').count()) === 1 && (await page.locator('.colab-file-hint').count()) === 1)
    report.shotSteps = await shot(page, '02-passos-apos-o-clique')
    await tile.dispatchEvent('dragstart')
    await page.locator('.colab-reveal-file').click()
    await page.waitForTimeout(400)
    const afterDrag = fs.readFileSync(openLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    check('arrastar o item pede o arrasto nativo SÓ do notebook gravado, e "Mostrar na pasta" mostra o arquivo de novo', afterDrag.length === 5 && afterDrag[3].kind === 'drag' && afterDrag[3].target === file && afterDrag[4].kind === 'reveal' && afterDrag[4].target === file, afterDrag.slice(3))

    /* ---- 2. a bad paste is explained, a good one is confirmed ---- */
    const field = page.locator('.colab-code')
    await field.fill(first.code.slice(0, -4))
    await page.waitForSelector('.colab-code-error')
    check('código cortado no final: "incompleto, faltou o final", sem botão de conectar', /faltou o final/.test((await page.locator('.colab-code-error').textContent()) || '') && (await page.locator('.colab-connect').count()) === 0)
    await field.fill(`${first.code.slice(0, 40)}${first.code[40] === 'A' ? 'B' : 'A'}${first.code.slice(41)}`)
    await page.waitForFunction(() => /alterado/.test(document.querySelector('.colab-code-error')?.textContent || ''), null, { timeout: 5000 })
    check('um caractere trocado: "foi alterado (a verificação não confere)"', true)
    await field.fill('isto não é um código')
    await page.waitForFunction(() => /não parece um código/.test(document.querySelector('.colab-code-error')?.textContent || ''), null, { timeout: 5000 })
    check('texto qualquer: "não parece um código de conexão"', true)

    await field.fill(first.code.match(/.{1,60}/g).join('\n')) // pasted with line breaks, as a wrapped copy would be
    await page.waitForSelector('.colab-preview', { timeout: 10000 })
    const preview = (await page.locator('.colab-preview').textContent()) || ''
    check('o código do dublê (feito pelo módulo do notebook, quebrado em linhas) é aceito', /Conectar/.test(preview))
    check('a confirmação mostra servidor, modelo, GPU, visão, ferramentas, contexto e versão do notebook', preview.includes(first.host) && preview.includes(MODEL) && preview.includes('RTX 2060') && /Imagens.*sim/.test(preview) && /Ferramentas.*sim/.test(preview) && /32\.768 tokens/.test(preview) && /v\d+\.\d+\.\d+/.test(preview), preview.replace(/\s+/g, ' ').slice(0, 200))
    check(
      TUNNEL ? 'o endereço é um túnel do Colab (*.trycloudflare.com): a confirmação diz isso e não avisa de nada' : 'o endereço é este computador (modo de teste): a confirmação avisa',
      TUNNEL ? /túnel do Colab/.test(preview) && !/modo de teste/.test(preview) && !/fora do padrão/.test(preview) : /este computador \(teste\)/.test(preview) && /modo de teste/.test(preview),
      first.host
    )
    check('o notebook do dublê é reconhecido como o original desta versão do Openclod', /original/.test(preview) && !/não confere/.test(preview))
    check('a confirmação avisa que a conversa e os arquivos passam por esse servidor', /passarão por este servidor/.test(preview))
    const pageText = await page.evaluate(() => document.body.innerText)
    check('a chave não aparece em lugar nenhum da tela', !pageText.includes(first.key))
    const mask = await page.evaluate(() => getComputedStyle(document.querySelector('.colab-code')).webkitTextSecurity)
    check('a caixa do código fica mascarada por padrão (o código contém a chave)', mask === 'disc', mask)
    check('conferir não grava nada: o settings.json segue sem o provedor do Colab', !readSettings(ws).providers.some((provider) => provider.id === 'colab'))
    report.shotConfirm = await shot(page, '03-codigo-colado-e-confirmacao')

    /* ---- 3. connect ---- */
    await page.locator('.colab-connect').click()
    await page.waitForSelector('.colab-status.ok', { timeout: 60000 })
    const after = readSettings(ws).providers.find((provider) => provider.id === 'colab')
    check('conectado: o provedor "colab" existe, com visão, ferramentas e a janela de contexto que o SERVIDOR informou', Boolean(after) && after.supportsVision === true && after.supportsTools === true && after.contextWindow === 32768 && after.model === MODEL && after.baseUrl === first.url, after && { vision: after.supportsVision, ctx: after.contextWindow })
    check('a chave foi para o cofre: o settings.json guarda só "secret:colab"', after.apiKeyRef === 'secret:colab' && !JSON.stringify(readSettings(ws)).includes(first.key), after.apiKeyRef)
    check('a chave não está em NENHUM arquivo do perfil (configurações, logs, dados), nem em UTF-8 nem em UTF-16', foundInProfile(ws.profile, first.key).length === 0, foundInProfile(ws.profile, first.key))
    check('o código de conexão inteiro também não está em nenhum arquivo do perfil', foundInProfile(ws.profile, first.code.slice(6, 60)).length === 0)
    await page.waitForSelector('.provider-tile:has-text("Google Colab")', { timeout: 15000 })
    const summary = (await page.locator('.colab-summary').textContent()) || ''
    check('o cartão passa a mostrar o servidor, o modelo, a GPU, "lê imagens" e o contexto', summary.includes(MODEL) && /lê imagens/.test(summary) && /32\.768 tokens/.test(summary) && /notebook original/.test(summary), summary.replace(/\s+/g, ' ').slice(0, 220))
    check('depois de conectar a caixa do código some (não sobra a chave na tela)', (await page.locator('.colab-code').count()) === 0)
    const capabilities = await page.evaluate(async () => (await window.openclod.app.capabilities()).value.providers.find((item) => item.id === 'colab'))
    check('as capacidades do app já contam o Colab como provedor com credencial', capabilities && capabilities.configured === true, capabilities)
    report.shotConnected = await shot(page, '04-conectado')
    await page.locator('.provider-tile:has-text("Google Colab")').click()
    await page.waitForSelector('.provider-card')
    const detail = (await page.locator('.provider-card').textContent()) || ''
    check('o cartão do provedor Colab: endereço travado, sem campo de chave, sem "remover" (a remoção é o Desconectar)', (await page.locator('.provider-card label.field:has-text("Base URL") input').isDisabled()) && (await page.locator('.provider-card input[type="password"]').count()) === 0 && (await page.locator('.provider-card [title="Remover"]').count()) === 0 && /código de conexão/.test(detail))
    check('...mas o botão Testar continua lá', (await page.getByRole('button', { name: 'Testar' }).count()) >= 1)
    report.shotProviderCard = await shot(page, '05-cartao-do-provedor')
    await closeSettings(page)

    /* ---- 4. the picker, without restarting ---- */
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Colab', projectName: 'Colab', providerId: 'colab' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Colab', 'Colab')
    await openModelMenu(page)
    const menu = await menuState(page)
    check('o seletor de modelo do compositor lista "Google Colab (GPU)" com o modelo, sem reiniciar o app', menu.headings.some((heading) => /Google Colab/.test(heading)) && menu.items.some((item) => item.includes(MODEL)), menu.headings)
    // The menu lists every provider ("sem chave — configurar" for the ones without a key): filter so the Colab entry is on screen.
    await page.locator('.menu-search').fill('qwen3.5')
    await page.waitForTimeout(300)
    report.shotPicker = await shot(page, '06-seletor-de-modelo')
    await page.keyboard.press('Escape')
    check('o compositor mostra o modelo do Colab na sessão', ((await page.locator('.model-btn .model-short').first().textContent()) || '').includes(MODEL))

    if (!SKIP_MODEL) {
      /* ---- 5. a real session: image + tool through the Colab ---- */
      const ask = async (text, images = []) => {
        const before = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.messages.length, session.sessionId)
        await page.evaluate(({ id, text, images }) => window.openclod.sessions.send(id, text, images, 'auto'), { id: session.sessionId, text, images })
        const state = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 900000, sinceCount: before })
        return { before, state, report: await e2e.turnReport(page, session.sessionId, before) }
      }
      const image = { type: 'image', mediaType: 'image/png', data: solidPng(112, 112, [30, 170, 60]).toString('base64'), label: 'quadrado.png' }
      const t0 = Date.now()
      let turn = await ask('Olhe a imagem anexada. Use a ferramenta write_file para criar o arquivo cor.txt contendo apenas o nome da cor predominante da imagem, em português e em letras minúsculas. Depois diga em uma frase o que fez.', [image])
      const colorFile = path.join(ws.project, 'cor.txt')
      const calls = [...turn.report.calls]
      // The model is a small local one (4B): now and then it SAYS it created the file without calling the tool, or misreads a flat color.
      // That is the model, not the path under test (the server counts the images it receives, checked below), so it is told once or
      // twice what is wrong; how many tries it took goes into the report instead of being hidden.
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
      check('sessão real pelo Colab: o modelo VIU a imagem (a cor certa foi escrita no arquivo)', /verde/.test(color), { color, attempts, final: turn.report.finalText.slice(0, 120) })
      check('...e CHAMOU a ferramenta write_file (chamada de ferramenta em stream pelo servidor)', calls.includes('write_file'), { calls, attempts })
      const live = await first.status()
      check('o servidor do Colab recebeu os pedidos, ao menos uma imagem, e contou tokens (e não registrou erro)', live.requests >= 2 && live.images >= 1 && live.prompt_tokens > 0 && live.completion_tokens > 0 && live.errors === 0, { requests: live.requests, images: live.images, prompt: live.prompt_tokens, completion: live.completion_tokens, errors: live.errors })
      const meta = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.meta, session.sessionId)
      check('a sessão terminou no Colab (a reserva não precisou entrar)', meta.providerId === 'colab' && meta.model === MODEL, { providerId: meta.providerId })
      report.shotSession = await shot(page, '07-sessao-com-imagem-e-ferramenta')

      /* ---- 6. the Colab falls: the tunnel answers the 530 page (the real one: captured, or in --tunnel mode the real edge's);
              the reserve takes over by itself ---- */
      reserve = await startOllamaProxy()
      await page.evaluate(async ({ baseUrl }) => {
        const settings = (await window.openclod.app.settings()).value
        const providers = settings.providers.map((provider) => (provider.id === 'ollama' ? { ...provider, baseUrl, model: 'qwen3.5:4b', supportsVision: true, supportsTools: true, models: ['qwen3.5:4b'] } : provider))
        await window.openclod.app.updateSettings({ providers, useAllModels: true, fallbackOrder: ['ollama'], fallbackExclude: [] })
      }, { baseUrl: reserve.baseUrl })
      if (TUNNEL) {
        first.stop() // the tunnel process is gone: the real Cloudflare edge now answers its HTTP 530 "Error 1033" page
      } else {
        first.stop()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        down = await startTunnelDownPage(first.port)
      }

      // (a) the failure arrives IN the middle of a turn, from the provider's own request (nothing marked it down before).
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
      check('a falha chegou no meio do turno e a reserva assumiu sozinha: a sessão agora está no Ollama', after2.meta.providerId === 'ollama', { providerId: after2.meta.providerId })
      check('a conversa avisa a troca, citando o Colab e o motivo "sem conexão"', after2.notes.some((note) => /Google Colab \(GPU\)/.test(note) && /falhou \(.*sem conexão\)/.test(note) && /continuando com Ollama/.test(note)), after2.notes)
      check('o histórico seguiu: o modelo da reserva respondeu sobre o arquivo criado antes', /cor\.txt/i.test(second.report.finalText), second.report.finalText.slice(0, 160))
      if (down) check('o túnel caído foi chamado poucas vezes (sem 5 tentativas com espera)', down.hits.filter((hit) => hit.method === 'POST').length <= 2, down.hits.length)
      await page.waitForSelector('.transcript-notice', { timeout: 10000 })
      report.shotReserve = await shot(page, '09-reserva-assumiu-na-conversa')

      // (b) the card tells the user (its own check; this also teaches the reserve, so the next conversation starts on the reserve)
      await openSettings(page)
      await page.locator('.colab-test').click()
      await page.waitForSelector('.colab-status.bad', { timeout: 30000 })
      const problem = (await page.locator('.colab-problem').textContent()) || ''
      check('Colab caiu (página 530 do túnel): o cartão passa a "caiu" e diz o que fazer, sem HTML', /caiu/.test((await page.locator('.colab-status').textContent()) || '') && /sessão do Colab provavelmente terminou/.test(problem) && !/<html/i.test(problem), problem.slice(0, 160))
      report.shotDown = await shot(page, '08-cartao-caiu')
      await closeSettings(page)

      // (c) a NEW conversation asked for on the Colab starts on the reserve, and says so.
      const fresh = await e2e.newSession(page, { folder: ws.project, title: 'Nova com o Colab caído', projectName: 'Colab', providerId: 'colab' })
      const third = await page.evaluate(async ({ id }) => {
        await window.openclod.sessions.send(id, 'Responda apenas: ok.', [], 'auto')
        return true
      }, { id: fresh.sessionId })
      void third
      const settledFresh = await e2e.waitSettled(page, fresh.sessionId, { timeoutMs: 900000, sinceCount: 0 })
      const freshState = await page.evaluate(async (id) => {
        const value = (await window.openclod.sessions.get(id)).value
        const last = [...value.messages].reverse().find((message) => message.role === 'assistant' && message.parts.some((part) => part.type === 'text'))
        return { providerId: value.meta.providerId, model: value.meta.model, answer: last ? last.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '', run: value.state }
      }, fresh.sessionId)
      // An empty conversation has nothing to "preserve", so there is no line in it: the session is simply saved on the model that works
      // (the picker shows it); a conversation with history gets the line (case (a) above).
      check('uma conversa NOVA pedida no Colab caído já nasce na reserva: a sessão fica gravada no modelo que funciona e responde', freshState.providerId === 'ollama' && freshState.model === 'qwen3.5:4b' && settledFresh.run !== 'error' && /\bok\b/i.test(freshState.answer), { providerId: freshState.providerId, model: freshState.model, answer: freshState.answer.slice(0, 80), run: settledFresh.run })
    }

    /* ---- 7. a short reconnection: new notebook run, new address, new key ---- */
    if (down) await down.close().catch(() => undefined)
    down = null
    const renewedDouble = await startDouble({ tunnel: TUNNEL || undefined })
    doubles.push(renewedDouble)
    await openSettings(page)
    if (!SKIP_MODEL) {
      await page.locator('.colab-test').click()
      await page.waitForSelector('.colab-status.bad, .colab-status.warn', { timeout: 30000 }).catch(() => undefined)
    }
    // Without the model session (--skip-model) the Colab never "fell": the paste area is behind "Colar código novo".
    if (!(await page.locator('.colab-code').count())) await page.locator('.colab-reconnect').click()
    await page.locator('.colab-code').fill(renewedDouble.code)
    await page.waitForSelector('.colab-preview', { timeout: 10000 })
    check('colar um código novo mostra que ele substitui o endereço e a chave do Colab já conectado', /serão substituídos/.test((await page.locator('.colab-preview').textContent()) || ''))
    await page.locator('.colab-connect').click()
    await page.waitForSelector('.colab-status.ok', { timeout: 60000 })
    const renewed = readSettings(ws).providers.find((provider) => provider.id === 'colab')
    check('reconectado em um passo: novo endereço no mesmo provedor (um só provedor Colab), chave nova no cofre', renewed.baseUrl === renewedDouble.url && readSettings(ws).providers.filter((provider) => provider.id === 'colab').length === 1 && foundInProfile(ws.profile, renewedDouble.key).length === 0, { baseUrl: renewed.baseUrl })
    const live2 = await page.evaluate(() => window.openclod.app.colabStatus(true))
    check('o estado do link volta a "conectado" com a chave nova', live2.ok && live2.value.state === 'conectado', live2.value && live2.value.state)
    report.shotReconnected = await shot(page, '10-reconectado')
    await closeSettings(page)

    /* ---- 8. close and open the app again: still there ---- */
    try { execFileSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2500))
    app = await e2e.launch({ port: PORT + 1, ...ws, env })
    await openSettings(app.page)
    await app.page.waitForSelector('.colab-status.ok', { timeout: 60000 })
    check('depois de fechar e abrir o app: o Colab continua conectado (provedor e chave do cofre)', (await app.page.locator('.colab-summary').textContent()).includes(MODEL))

    /* ---- 9. disconnect ---- */
    await app.page.locator('.colab-disconnect').click()
    check('Desconectar pede uma segunda confirmação (um clique só não apaga)', /Confirmar/.test((await app.page.locator('.colab-disconnect').textContent()) || ''))
    await app.page.locator('.colab-disconnect').click()
    await app.page.waitForFunction(() => !document.querySelector('.colab-summary'), null, { timeout: 15000 })
    const gone = readSettings(ws)
    check('desconectado: o provedor sai das configurações e da reserva', !gone.providers.some((provider) => provider.id === 'colab') && !(gone.fallbackOrder || []).includes('colab'))
    check('desconectado: a chave foi apagada do cofre (o app não encontra mais credencial)', await app.page.evaluate(async () => !(await window.openclod.app.capabilities()).value.providers.some((item) => item.id === 'colab' && item.configured)))
    await app.page.waitForFunction(() => !document.querySelector('.provider-tile') || ![...document.querySelectorAll('.provider-tile')].some((tile) => /Google Colab/.test(tile.textContent || '')), null, { timeout: 10000 })
    check('desconectado: o ladrilho do Colab some da lista', true)
    report.shotDisconnected = await shot(app.page, '11-desconectado')
  } finally {
    report.errors = ((app && app.errors) || []).filter((line) => line.startsWith('pageerror'))
    report.profileFilesLockedByChromium = foundInProfile.locked || 0
    if (app) app.cleanup()
    for (const double of doubles) double.stop()
    if (down) await down.close().catch(() => undefined)
    if (reserve) await reserve.close().catch(() => undefined)
  }
  report.checks = checks
  const file = path.join(OUT, `${LABEL}-ui-colab.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, file)}`)
  process.exit(ok() ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
