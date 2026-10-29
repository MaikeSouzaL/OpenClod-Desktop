// End-to-end de "toda imagem que o agente vê aparece no chat, dizendo se o modelo viu de fato", no app de verdade (Electron,
// perfil descartável; o app e o perfil do usuário não são tocados).
//   1. Sessão semeada (sem modelo): captura do computador, página do navegador descrita pelo relé, folhas de contato de um
//      vídeo (mensagem oculta: só as imagens aparecem, nunca o texto), prévia de um PDF lido por OCR e uma imagem anexada que
//      o modelo não viu. Confere legenda e selo de cada uma.
//   2. Modelo real (Ollama local `qwen3.5:4b`, que lê imagens, atrás de dois repasses): o mesmo anexo enviado a um modelo com
//      visão ("recebeu"), a um modelo só de texto com relé ("descrita por …", com o texto que o modelo leu) e a um modelo só de
//      texto sem nenhum modelo com visão ("NÃO viu"). Os repasses provam o que cada um recebeu de fato.
//   3. Modelo real só de texto lendo um PDF digitalizado (document_extract → OCR) e uma imagem (image_ocr): as páginas e a
//      imagem aparecem com "o modelo recebeu o texto extraído", e o repasse prova que o modelo nunca recebeu essas imagens.
//
//   node scripts/ui-seen-images.cjs [--root <snapshot>] [--out dir] [--label nome] [--turn-timeout ms] [--only seeded|real|files]
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const { startOllamaProxy } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'imagens')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'imagens-no-chat-2026-10-29')))
const TURN_TIMEOUT_MS = Number(e2e.arg('turn-timeout', 420000))
const ONLY = e2e.arg('only', '')
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()
const PROJECT = 'Imagens E2E'

const shot = async (page, name, locator) => {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  if (locator) await locator.screenshot({ path: file })
  else await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

function stop(app) {
  try { app.browser.close() } catch {}
  try { execFileSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
}

/** Real pictures drawn by the page's own canvas: a "screen", a "web page", two contact sheets, a PDF page and a photo. */
async function drawPictures(page) {
  return page.evaluate(() => {
    const draw = (width, height, paint, mediaType = 'image/png') => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      paint(context)
      return canvas.toDataURL(mediaType).split(',')[1]
    }
    const screen = draw(640, 360, (c) => {
      c.fillStyle = '#1f2937'; c.fillRect(0, 0, 640, 360)
      c.fillStyle = '#f9fafb'; c.font = 'bold 34px Arial'; c.fillText('Área de trabalho', 30, 70)
      c.fillStyle = '#2563eb'; c.fillRect(30, 260, 160, 60)
    })
    const web = draw(640, 360, (c) => {
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, 640, 360)
      c.fillStyle = '#111827'; c.font = 'bold 30px Arial'; c.fillText('Entrar', 40, 80)
      c.fillStyle = '#2563eb'; c.fillRect(40, 220, 200, 56)
    })
    const sheet = (n) => draw(480, 270, (c) => {
      c.fillStyle = '#000000'; c.fillRect(0, 0, 480, 270)
      for (let i = 0; i < 9; i++) {
        c.fillStyle = `hsl(${(i * 40 + n * 20) % 360} 60% 45%)`
        c.fillRect((i % 3) * 160 + 4, Math.floor(i / 3) * 90 + 4, 152, 82)
        c.fillStyle = '#fff'; c.font = '16px Arial'; c.fillText(`#${n * 9 + i + 1}`, (i % 3) * 160 + 12, Math.floor(i / 3) * 90 + 26)
      }
    }, 'image/jpeg')
    const pdfPage = draw(420, 594, (c) => {
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, 420, 594)
      c.fillStyle = '#111'; c.font = 'bold 22px Georgia'; c.fillText('CONTRATO DE LOCAÇÃO', 60, 70)
      c.font = '13px Georgia'
      for (let i = 0; i < 18; i++) c.fillText('Cláusula ' + (i + 1) + ' — texto digitalizado da página.', 40, 120 + i * 24)
    }, 'image/jpeg')
    const photo = draw(520, 220, (c) => {
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, 520, 220)
      c.fillStyle = '#d62828'; c.fillRect(24, 24, 120, 120)
      c.fillStyle = '#000000'; c.font = 'bold 54px Arial'; c.fillText('BANANA-77', 170, 100)
      c.font = '24px Arial'; c.fillText('retângulo vermelho à esquerda', 24, 190)
    })
    return { screen, web, sheets: [sheet(0), sheet(1)], pdfPage, photo }
  })
}

function seededMessages(pictures) {
  const now = Date.now()
  const png = (data, over = {}) => ({ type: 'image', mediaType: 'image/png', data, ...over })
  const jpg = (data, over = {}) => ({ type: 'image', mediaType: 'image/jpeg', data, ...over })
  return [
    { id: 'u1', role: 'user', ts: now - 9000, parts: [{ type: 'text', text: 'Veja o vídeo anexado, a tela, o site e o contrato.' }, png(pictures.photo, { label: 'foto.png', delivery: 'none' })] },
    { id: 'h1', role: 'user', ts: now - 8900, hidden: true, parts: [{ type: 'text', text: '<midia>TEXTO-OCULTO-DA-MIDIA transcrição do vídeo</midia>' }, jpg(pictures.sheets[0], { label: 'folha 01.jpg (00:00–00:30)', delivery: 'model' }), jpg(pictures.sheets[1], { label: 'folha 02.jpg (00:30–01:00)', delivery: 'model' })] },
    {
      id: 'a1', role: 'assistant', ts: now - 8000, parts: [
        { type: 'tool_call', id: 'c1', name: 'computer_screenshot', args: {} },
        { type: 'tool_call', id: 'c2', name: 'browser_navigate', args: { url: 'http://localhost/login' } },
        { type: 'tool_call', id: 'c3', name: 'document_extract', args: { path: 'C:\\docs\\contrato.pdf' } }
      ]
    },
    {
      id: 't1', role: 'tool', ts: now - 7000, parts: [
        { type: 'tool_result', toolCallId: 'c1', name: 'computer_screenshot', ok: true, text: 'captura 640x360', detail: 'tela inteira', images: [png(pictures.screen, { label: 'tela', delivery: 'model' })] },
        { type: 'tool_result', toolCallId: 'c2', name: 'browser_navigate', ok: true, text: 'página carregada', detail: 'localhost/login', images: [png(pictures.web, { label: 'página', delivery: 'relay', description: 'Página de login com o título "Entrar" e um botão azul.', describedBy: 'Ollama (lê imagens)/qwen3.5:4b' })] },
        { type: 'tool_result', toolCallId: 'c3', name: 'document_extract', ok: true, text: 'CONTRATO DE LOCAÇÃO — 18 cláusulas', detail: '1 página (OCR)', preview: [jpg(pictures.pdfPage, { label: 'página 1' })] }
      ]
    },
    { id: 'a2', role: 'assistant', ts: now - 6000, parts: [{ type: 'text', text: 'Vi a tela, o site, o vídeo e li o contrato.' }] }
  ]
}

async function seeded() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-seen-' })
  let app = null
  const report = {}
  try {
    app = await e2e.launch({ port: 9491, ...ws })
    const pictures = await drawPictures(app.page)
    const created = await app.page.evaluate(async ({ folder, name }) => {
      const project = await window.openclod.projects.add(folder, name)
      if (!project.ok) return { error: project.error }
      const session = await window.openclod.sessions.create({ projectId: project.value.id, cwd: folder, mode: 'code', surface: 'code', providerId: 'ollama', model: 'qwen3.5:4b', title: 'Tudo o que ele viu' })
      return session.ok ? { id: session.value.id } : { error: session.error }
    }, { folder: ws.project, name: PROJECT })
    if (created.error) throw new Error(created.error)
    stop(app)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const file = path.join(ws.profile, 'data', 'sessions', `${created.id}.json`)
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.messages = seededMessages(pictures)
    state.state = 'idle'
    fs.writeFileSync(file, JSON.stringify(state, null, 2))

    app = await e2e.launch({ port: 9491, ...ws })
    const { page } = app
    await page.waitForSelector('.side-project-name', { timeout: 20000 }).catch(() => undefined)
    await e2e.openSession(page, 'Tudo o que ele viu', PROJECT)
    await page.waitForSelector('.chat-shot', { timeout: 20000 })

    const card = (tool) => page.locator(`.chat-shot[data-seen-images="${tool}"]`)
    const caption = async (tool) => ((await card(tool).locator('figcaption span').first().textContent()) || '').trim()
    const seal = async (scope) => (await scope.locator('.image-seal').evaluateAll((nodes) => nodes.map((node) => `${node.dataset.seal}: ${node.querySelector('.image-seal-text')?.textContent?.trim()}`)))

    check('captura do computador: legenda "Tela do computador" e selo "O modelo recebeu esta imagem"', (await caption('computer_screenshot')) === 'Tela do computador' && (await seal(card('computer_screenshot'))).join() === 'seen: O modelo recebeu esta imagem', { caption: await caption('computer_screenshot'), seal: await seal(card('computer_screenshot')) })

    const web = card('browser_navigate')
    check('página do navegador: legenda e selo "Descrita por …; o modelo leu a descrição"', (await caption('browser_navigate')) === 'Página do navegador' && /^described: Descrita por Ollama \(lê imagens\)\/qwen3\.5:4b; o modelo leu a descrição$/.test((await seal(web)).join()), await seal(web))
    await web.locator('.image-seal-description summary').click()
    check('"Ver o que o modelo leu" abre a descrição que o modelo de texto recebeu', /botão azul/.test((await web.locator('.image-seal-description p').textContent()) || ''))

    const context = card('contexto')
    check('folhas de contato do vídeo (mensagem oculta) aparecem: 2 imagens, legenda e selo de recebidas', (await context.locator('img').count()) === 2 && (await caption('contexto')) === 'Folhas de contato do vídeo' && (await seal(context)).every((line) => line.startsWith('seen:')), { images: await context.locator('img').count(), caption: await caption('contexto'), seal: await seal(context) })
    const thread = (await page.locator('.thread').textContent()) || ''
    check('o TEXTO da mensagem oculta não aparece no chat (só as imagens)', !thread.includes('TEXTO-OCULTO-DA-MIDIA'))

    const pdf = card('document_extract')
    check('PDF lido por OCR: prévia da página, legenda "Documento · contrato.pdf" e selo "o modelo recebeu o texto extraído"', (await pdf.locator('img').count()) === 1 && (await caption('document_extract')) === 'Documento · contrato.pdf' && (await seal(pdf)).join() === 'text: O modelo recebeu o texto extraído, não a imagem', { caption: await caption('document_extract'), seal: await seal(pdf) })
    // The capture and the page are cards of their own; the PDF reader keeps its row (its text is what the model read).
    const groupText = (await page.locator('.tool-group summary').allTextContents()).join(' | ')
    check('a linha da ferramenta do PDF continua no grupo (o texto que o modelo leu)', /usou 1 ferramenta/i.test(groupText), groupText)

    const userSeal = await seal(page.locator('.message.user'))
    check('imagem anexada a um modelo sem visão: selo "O modelo NÃO viu esta imagem (sem visão)"', userSeal.join() === 'unseen: O modelo NÃO viu esta imagem (sem visão)', userSeal)

    report.shotThread = await shot(page, '01-semeada-conversa')
    await context.scrollIntoViewIfNeeded()
    report.shotSheets = await shot(page, '02-semeada-folhas', context)
    await pdf.scrollIntoViewIfNeeded()
    report.shotPdf = await shot(page, '03-semeada-pdf', pdf)
    await web.scrollIntoViewIfNeeded()
    report.shotWeb = await shot(page, '04-semeada-navegador', web)
    report.errors = (app.errors || []).filter((line) => line.startsWith('pageerror'))
    check('nenhum erro de página', !report.errors.length, report.errors)
  } finally {
    if (app) stop(app)
    try { fs.rmSync(ws.work, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }) } catch {}
  }
  return report
}

const textOnly = (baseUrl) => ({
  id: 'ollama-texto', kind: 'openai', label: 'Ollama (só texto)', baseUrl, model: 'qwen3.5:4b', apiKeyRef: '',
  contextWindow: 65536, supportsVision: false, supportsTools: true, models: ['qwen3.5:4b']
})
const seeing = (baseUrl) => ({
  id: 'ollama-visao', kind: 'openai', label: 'Ollama (lê imagens)', baseUrl, model: 'qwen3.5:4b', apiKeyRef: '',
  contextWindow: 65536, supportsVision: true, supportsTools: true, models: ['qwen3.5:4b']
})

async function real() {
  // `real`: the sanitized copy of the user's settings (no MCP servers), as ui-vision-relay.cjs; a 4B model with dozens of
  // connector tools answers about the tools instead of the picture.
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-seen-real-' })
  const textProxy = await startOllamaProxy()
  const visionProxy = await startOllamaProxy()
  const app = await e2e.launch({ port: 9492, ...ws })
  const report = {}
  try {
    const { page } = app
    const pictures = await drawPictures(page)
    const image = { type: 'image', mediaType: 'image/png', data: pictures.photo, label: 'teste.png' }
    const configure = (exclude) => page.evaluate(async ({ providers, exclude }) => {
      const settings = (await window.openclod.app.settings()).value
      const keep = settings.providers.filter((item) => !providers.some((next) => next.id === item.id))
      const all = [...keep, ...providers]
      await window.openclod.app.updateSettings({
        providers: all, useAllModels: true, fallbackOrder: ['ollama-visao'],
        fallbackExclude: all.map((item) => item.id).filter((id) => !['ollama-texto', 'ollama-visao'].includes(id) || exclude.includes(id)),
        visionModel: { providerId: '', model: '' }
      })
    }, { providers: [textOnly(textProxy.baseUrl), seeing(visionProxy.baseUrl)], exclude })

    const run = async (title, providerId, name) => {
      const session = await e2e.newSession(page, { folder: ws.project, title, projectName: PROJECT, providerId, mode: 'ask' })
      await page.reload()
      await page.waitForSelector('.side-project-name', { timeout: 20000 }).catch(() => undefined)
      await e2e.openSession(page, title, PROJECT)
      const textHits = textProxy.hits.length
      const visionHits = visionProxy.hits.length
      await page.evaluate(({ id, image }) => window.openclod.sessions.send(id, 'O que está escrito na imagem anexada? Responda só com o texto grande.', [image], 'auto'), { id: session.sessionId, image })
      // While the turn runs a picture waiting for the relay says so; it is fast, so this is an observation, not a check.
      const waiting = await page.waitForSelector('.message.user .image-seal.is-waiting', { timeout: 8000 }).then(() => true).catch(() => false)
      let timedOut = false
      try {
        await e2e.waitSettled(page, session.sessionId, { timeoutMs: TURN_TIMEOUT_MS, sinceCount: 0 })
      } catch {
        timedOut = true
      }
      await page.waitForTimeout(800)
      const seals = await page.locator('.message.user .image-seal').evaluateAll((nodes) => nodes.map((node) => ({ tone: node.dataset.seal, text: node.querySelector('.image-seal-text')?.textContent?.trim(), description: node.querySelector('.image-seal-description p')?.textContent || '' })))
      const answer = await page.evaluate(async (id) => {
        const state = (await window.openclod.sessions.get(id)).value
        const text = (message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
        const last = [...state.messages].reverse().find((message) => message.role === 'assistant' && text(message).trim())
        const picture = state.messages.flatMap((message) => message.parts).find((part) => part.type === 'image')
        return { state: state.state, text: last ? text(last) : '', stored: picture ? { delivery: picture.delivery, describedBy: picture.describedBy, description: String(picture.description || '').slice(0, 300) } : null }
      }, session.sessionId)
      const shotFile = await shot(page, name, page.locator('.message.user').first())
      return { seals, answer, timedOut, waiting, shot: shotFile, textHits: textProxy.hits.slice(textHits), visionHits: visionProxy.hits.slice(visionHits) }
    }

    await configure([])
    const withVision = await run('Modelo com visão', 'ollama-visao', '05-real-com-visao')
    report.withVision = { ...withVision, textHits: withVision.textHits.length, visionHits: withVision.visionHits.map((hit) => hit.images) }
    check('modelo com visão: o repasse recebeu os bytes da imagem', withVision.visionHits.some((hit) => hit.images), withVision.visionHits.map((hit) => hit.images))
    check('modelo com visão: selo "O modelo recebeu esta imagem"', withVision.seals.map((s) => s.tone).join() === 'seen', withVision.seals)
    // Whether a 4B model answers the question is its own quality, not the seal's: recorded, not checked.
    report.withVision.answeredFromPicture = /BANANA-?77/i.test(withVision.answer.text)

    const relayed = await run('Texto com relé', 'ollama-texto', '06-real-rele')
    report.relayed = {
      ...relayed,
      textHits: relayed.textHits.map((hit) => hit.images),
      visionHits: relayed.visionHits.map((hit) => hit.images),
      // What the text-only model got in place of the picture (the relay's note), for reading the run afterwards.
      textNote: (relayed.textHits.map((hit) => hit.serialized.match(/\[imagem[^\]]{0,400}/)?.[0]).find(Boolean) || '').slice(0, 400)
    }
    check('só texto + relé: a sessão guardou a descrição na imagem', Boolean(relayed.answer.stored?.description), relayed.answer.stored)
    check('só texto + relé: o modelo de texto NUNCA recebeu os bytes da imagem', relayed.textHits.length > 0 && relayed.textHits.every((hit) => !hit.images), relayed.textHits.map((hit) => hit.images))
    check('só texto + relé: o modelo com visão recebeu a imagem para descrevê-la', relayed.visionHits.some((hit) => hit.images), relayed.visionHits.map((hit) => hit.images))
    check('só texto + relé: selo "Descrita por Ollama (lê imagens)/qwen3.5:4b; o modelo leu a descrição"', relayed.seals.length === 1 && relayed.seals[0].tone === 'described' && /Ollama \(lê imagens\)\/qwen3\.5:4b/.test(relayed.seals[0].text || ''), relayed.seals)
    // A run of plain words from the description shown in the chat must be in what the text-only model received.
    const probe = (relayed.seals[0]?.description.match(/[\p{L}\p{N} ,]{20,}/u)?.[0] ?? '').trim().slice(0, 30)
    check('só texto + relé: a descrição mostrada é a que o modelo de texto recebeu', probe.length >= 15 && relayed.textHits.some((hit) => hit.serialized.replace(/\\n/g, ' ').includes(probe)), { probe, shown: relayed.seals[0]?.description.slice(0, 160) })
    report.relayWaitingSeen = relayed.waiting

    await configure(['ollama-visao'])
    const blind = await run('Texto sem visão', 'ollama-texto', '07-real-sem-visao')
    report.blind = { ...blind, textHits: blind.textHits.map((hit) => hit.images), visionHits: blind.visionHits.length }
    check('só texto sem nenhum modelo com visão: ninguém recebeu a imagem', blind.textHits.every((hit) => !hit.images) && blind.visionHits.length === 0, { text: blind.textHits.map((hit) => hit.images), vision: blind.visionHits.length })
    check('só texto sem nenhum modelo com visão: selo "O modelo NÃO viu esta imagem (sem visão)"', blind.seals.map((s) => `${s.tone}: ${s.text}`).join() === 'unseen: O modelo NÃO viu esta imagem (sem visão)', blind.seals)
    report.errors = (app.errors || []).filter((line) => line.startsWith('pageerror'))
    check('nenhum erro de página', !report.errors.length, report.errors)
  } finally {
    app.cleanup()
    await textProxy.close().catch(() => undefined)
    await visionProxy.close().catch(() => undefined)
  }
  return report
}

/** A scanned PDF (pages are pictures, no text layer), made with the embedded Python's Pillow as tests/media-ocr does. */
function scannedPdf(file, titles) {
  const python = path.join(e2e.ROOT, 'resources', 'runtime', 'python', 'python.exe')
  const make = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 40)',
    'pages = []',
    'for title in sys.argv[2:]:',
    '    page = Image.new("RGB", (1240, 1754), "white")',
    '    draw = ImageDraw.Draw(page)',
    '    draw.text((90, 90), title, font=font, fill="black")',
    '    draw.text((90, 170), "Valor mensal: R$ 1.284,00", font=font, fill="black")',
    '    pages.append(page)',
    'pages[0].save(sys.argv[1], save_all=True, append_images=pages[1:], resolution=150)'
  ].join('\n')
  execFileSync(python, ['-I', '-c', make, file, ...titles], { stdio: 'ignore', windowsHide: true })
}

/**
 * 3. A real model reads a scanned PDF (document_extract → OCR) and a picture (image_ocr): the chat shows the pages and the
 * picture with "o modelo recebeu o texto extraído", and the model, text-only, never receives those pictures.
 */
async function files() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-seen-files-' })
  const textProxy = await startOllamaProxy()
  const report = {}
  scannedPdf(path.join(ws.project, 'contrato.pdf'), ['CONTRATO DE LOCACAO 2026', 'ANEXO DE VALORES'])
  await require('sharp')({ create: { width: 900, height: 240, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="900" height="240"><text x="40" y="140" font-family="Arial" font-size="72">RECIBO 4821</text></svg>'), top: 0, left: 0 }])
    .png()
    .toFile(path.join(ws.project, 'recibo.png'))
  const app = await e2e.launch({ port: 9493, ...ws })
  try {
    const { page } = app
    await page.waitForFunction(() => Boolean(window.openclod?.app), null, { timeout: 30000 })
    await page.evaluate(async ({ provider }) => {
      const settings = (await window.openclod.app.settings()).value
      const all = [...settings.providers.filter((item) => item.id !== provider.id), provider]
      await window.openclod.app.updateSettings({ providers: all, useAllModels: false, fallbackExclude: all.map((item) => item.id).filter((id) => id !== provider.id), visionModel: { providerId: '', model: '' } })
    }, { provider: textOnly(textProxy.baseUrl) })
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Ler PDF e imagem', projectName: PROJECT, providerId: 'ollama-texto', mode: 'code' })
    await page.reload()
    await page.waitForSelector('.side-project-name', { timeout: 20000 }).catch(() => undefined)
    await e2e.openSession(page, 'Ler PDF e imagem', PROJECT)
    await page.evaluate(({ id }) => window.openclod.sessions.send(id, 'Leia o arquivo contrato.pdf com a ferramenta document_extract e a imagem recibo.png com a ferramenta image_ocr. Depois responda numa linha: o título do contrato e o número do recibo.', [], 'auto'), { id: session.sessionId })
    let timedOut = false
    try {
      await e2e.waitSettled(page, session.sessionId, { timeoutMs: TURN_TIMEOUT_MS, sinceCount: 0 })
    } catch {
      timedOut = true
    }
    await page.waitForTimeout(800)
    const stored = await page.evaluate(async (id) => {
      const state = (await window.openclod.sessions.get(id)).value
      const results = state.messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool_result')
      const text = (message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
      const last = [...state.messages].reverse().find((message) => message.role === 'assistant' && text(message).trim())
      return {
        state: state.state,
        answer: last ? text(last) : '',
        tools: results.map((part) => ({ name: part.name, ok: part.ok, preview: (part.preview || []).map((image) => ({ label: image.label, probe: image.data.slice(200, 260) })) }))
      }
    }, session.sessionId)
    report.stored = { ...stored, timedOut }
    // The last messages of the first request, roles and starts: shows what a small model took as "the user's message".
    report.firstRequestTail = (() => {
      try {
        return JSON.parse(textProxy.hits[0].serialized).slice(-4).map((message) => `${message.role}: ${JSON.stringify(message.content).slice(0, 160)}`)
      } catch {
        return []
      }
    })()
    const card = (tool) => page.locator(`.chat-shot[data-seen-images="${tool}"]`)
    const seals = async (tool) => card(tool).locator('.image-seal-text').allTextContents()
    const pdf = stored.tools.find((tool) => tool.name === 'document_extract' && tool.preview.length)
    const ocr = stored.tools.find((tool) => tool.name === 'image_ocr' && tool.preview.length)
    report.calls = stored.tools.map((tool) => `${tool.name}:${tool.ok}`)
    check('o modelo real chamou document_extract e image_ocr, e os dois devolveram prévias', Boolean(pdf && ocr), report.calls)
    if (pdf) {
      check('PDF digitalizado: as 2 páginas aparecem no chat como "Documento · contrato.pdf" com o selo do texto extraído', (await card('document_extract').locator('img').count()) === 2 && /Documento · contrato\.pdf/.test((await card('document_extract').locator('figcaption').textContent()) || '') && (await seals('document_extract')).every((text) => text.trim() === 'O modelo recebeu o texto extraído, não a imagem'), { labels: pdf.preview.map((image) => image.label), seals: await seals('document_extract') })
      await card('document_extract').scrollIntoViewIfNeeded()
      report.shotPdf = await shot(page, '08-real-pdf', card('document_extract'))
    }
    if (ocr) {
      check('image_ocr: a imagem lida aparece como "Imagem · recibo.png" com o selo do texto extraído', (await card('image_ocr').locator('img').count()) === 1 && /Imagem · recibo\.png/.test((await card('image_ocr').locator('figcaption').textContent()) || ''), await seals('image_ocr'))
      await card('image_ocr').scrollIntoViewIfNeeded()
      report.shotOcr = await shot(page, '09-real-ocr', card('image_ocr'))
    }
    const probes = [...(pdf?.preview ?? []), ...(ocr?.preview ?? [])].map((image) => image.probe)
    check('o modelo de texto nunca recebeu os bytes das prévias (só o texto extraído)', textProxy.hits.length > 0 && probes.length > 0 && textProxy.hits.every((hit) => !hit.images && probes.every((probe) => !hit.serialized.includes(probe))), { hits: textProxy.hits.length, probes: probes.length })
    check('o texto extraído chegou ao modelo (CONTRATO DE LOCACAO e RECIBO 4821)', textProxy.hits.some((hit) => /CONTRATO DE LOCA/i.test(hit.serialized)) && textProxy.hits.some((hit) => /RECIBO 4821/i.test(hit.serialized)))
    report.shotThread = await shot(page, '10-real-arquivos-conversa')
    report.errors = (app.errors || []).filter((line) => line.startsWith('pageerror'))
    check('nenhum erro de página (arquivos)', !report.errors.length, report.errors)
  } finally {
    app.cleanup()
    await textProxy.close().catch(() => undefined)
  }
  return report
}

async function main() {
  const report = { label: LABEL, startedAt: new Date().toISOString() }
  if (!ONLY || ONLY === 'seeded') report.seeded = await seeded()
  if (!ONLY || ONLY === 'real') report.real = await real()
  if (!ONLY || ONLY === 'files') report.files = await files()
  report.checks = checks
  report.ok = ok()
  fs.writeFileSync(path.join(OUT, `${LABEL}-relatorio.json`), JSON.stringify(report, null, 2))
  const results = Object.values(checks)
  console.log(`\n${results.filter((value) => value === 'ok').length}/${results.length} — relatório em ${path.relative(e2e.ROOT, OUT)}`)
  process.exit(report.ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
