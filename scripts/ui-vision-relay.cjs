// End-to-end of the vision relay: "whenever the harness has to use an LLM that cannot see images, a model that can reads them first
// and describes them". The LLM of the session is flagged as not reading images; a second entry for the SAME real local model
// (`qwen3.5:4b`, which does read images) is the describer. Two pass-throughs in front of Ollama show what each one received: the
// text-only one must never see image bytes, the vision one must see the picture exactly once.
//
//   node scripts/ui-vision-relay.cjs [--root <snapshot>] [--label depois] [--out dir] [--turn-timeout ms]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')
const { startOllamaProxy, startFakeProvider } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'depois')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'reserva-2026-10-27')))
const PORT = 9461
const TURN_TIMEOUT_MS = Number(e2e.arg('turn-timeout', 420000))
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const textOnly = (baseUrl) => ({
  id: 'ollama-texto', kind: 'openai', label: 'Ollama (só texto)', baseUrl, model: 'qwen3.5:4b', apiKeyRef: '',
  contextWindow: 65536, supportsVision: false, supportsTools: true, models: ['qwen3.5:4b']
})
const seeing = (baseUrl) => ({
  id: 'ollama-visao', kind: 'openai', label: 'Ollama (lê imagens)', baseUrl, model: 'qwen3.5:4b', apiKeyRef: '',
  contextWindow: 65536, supportsVision: true, supportsTools: true, models: ['qwen3.5:4b']
})

async function snapshot(page, sessionId) {
  return page.evaluate(async (id) => {
    const state = (await window.forja.sessions.get(id)).value
    const text = (message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
    const answers = state.messages.filter((message) => message.role === 'assistant' && text(message).trim())
    const last = answers[answers.length - 1]
    const userImages = state.messages.flatMap((message) => message.parts.filter((part) => part.type === 'image'))
    return {
      state: state.state,
      lastText: last ? text(last) : '',
      lastModel: last?.model,
      described: userImages.map((image) => String(image.description || '').slice(0, 200)),
      count: state.messages.length
    }
  }, sessionId)
}

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-visao-' })
  const textProxy = await startOllamaProxy()
  const visionProxy = await startOllamaProxy()
  const dead = await startFakeProvider()
  dead.state.mode = '402'
  const app = await e2e.launch({ port: PORT, ...ws })
  const report = { label: LABEL, startedAt: new Date().toISOString() }
  try {
    const { page } = app
    // Providers of the run; the vision model is NOT chosen by hand in the first part (automatic: the first one of the reserve that reads images).
    await page.evaluate(async ({ providers }) => {
      const settings = (await window.forja.app.settings()).value
      const keep = settings.providers.filter((item) => !providers.some((next) => next.id === item.id))
      const all = [...keep, ...providers]
      await window.forja.app.updateSettings({
        providers: all, useAllModels: true, fallbackOrder: ['ollama-visao'],
        fallbackExclude: all.map((item) => item.id).filter((id) => !['ollama-texto', 'ollama-visao'].includes(id)),
        visionModel: { providerId: '', model: '' }
      })
    }, { providers: [textOnly(textProxy.baseUrl), seeing(visionProxy.baseUrl)] })

    const session = await e2e.newSession(page, { folder: ws.project, title: 'Imagem para LLM de texto', projectName: 'Visao', providerId: 'ollama-texto', mode: 'ask' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Imagem para LLM de texto', 'Visao')

    // A real picture: big black text on white with a red square, drawn by the page's own canvas.
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 520
      canvas.height = 220
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 520, 220)
      context.fillStyle = '#d62828'
      context.fillRect(24, 24, 120, 120)
      context.fillStyle = '#000000'
      context.font = 'bold 54px Arial'
      context.fillText('BANANA-77', 170, 100)
      context.font = '24px Arial'
      context.fillText('retângulo vermelho à esquerda', 24, 190)
      return { type: 'image', mediaType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], label: 'teste.png' }
    })
    fs.writeFileSync(path.join(OUT, `${LABEL}-visao-imagem-enviada.png`), Buffer.from(image.data, 'base64'))

    const send = async (text, images) => {
      const before = (await snapshot(page, session.sessionId)).count
      const started = Date.now()
      await page.evaluate(({ id, text, images }) => window.forja.sessions.send(id, text, images, 'auto'), { id: session.sessionId, text, images })
      let timedOut = false
      try {
        await e2e.waitSettled(page, session.sessionId, { timeoutMs: TURN_TIMEOUT_MS, sinceCount: before })
      } catch {
        timedOut = true
      }
      await page.waitForTimeout(600)
      return { seconds: Math.round((Date.now() - started) / 1000), timedOut, ...(await snapshot(page, session.sessionId)) }
    }

    const first = await send('O que está escrito na imagem anexada? Responda só com o texto grande.', [image])
    report.first = first
    check('o LLM de texto respondeu sobre a imagem', !first.timedOut && first.state !== 'error' && first.lastText.trim().length > 0, { state: first.state, seconds: first.seconds })
    check('a resposta usa o que a imagem mostra (BANANA-77), lido por um modelo com visão', /BANANA-?77/i.test(first.lastText), first.lastText.slice(0, 160))
    check('o LLM de texto NUNCA recebeu os bytes da imagem', textProxy.hits.length > 0 && textProxy.hits.every((hit) => hit.images === false), textProxy.hits.map((hit) => hit.images))
    check('o que o LLM de texto recebeu no lugar da imagem é a descrição escrita pelo modelo com visão (BANANA-77)', textProxy.hits.some((hit) => /BANANA-?77/.test(hit.serialized) && /não lê imagens/.test(hit.serialized)), textProxy.hits.map((hit) => hit.serialized.length))
    check('o modelo com visão recebeu a imagem, uma única vez', visionProxy.hits.filter((hit) => hit.images).length === 1, visionProxy.hits.map((hit) => hit.images))
    check('a descrição ficou guardada junto da imagem na sessão', first.described.length === 1 && /BANANA/i.test(first.described[0]), first.described)

    const second = await send('Qual era a cor do quadrado na imagem? Responda só a cor.', [])
    report.second = second
    check('uma segunda pergunta sobre a mesma imagem é respondida pela descrição guardada', /vermelh/i.test(second.lastText), second.lastText.slice(0, 120))
    check('a imagem não é descrita de novo (o modelo com visão não recebeu outra imagem)', visionProxy.hits.filter((hit) => hit.images).length === 1, visionProxy.hits.map((hit) => hit.images))
    report.shot = path.join(path.relative(e2e.ROOT, OUT), `${LABEL}-visao-conversa.png`)
    await page.screenshot({ path: path.join(e2e.ROOT, report.shot) })

    // No model that reads images is available: the turn must still end, saying so, instead of failing or inventing.
    await page.evaluate(async ({ providers }) => {
      const settings = (await window.forja.app.settings()).value
      const keep = settings.providers.filter((item) => !providers.some((next) => next.id === item.id))
      await window.forja.app.updateSettings({
        providers: [...keep, ...providers], visionModel: { providerId: 'fake-cego', model: 'fake-pro' },
        fallbackExclude: [...keep, ...providers].map((item) => item.id).filter((id) => id !== 'ollama-texto' && id !== 'fake-cego')
      })
      await window.forja.app.setSecret('fake-cego', 'chave-de-teste-local-sem-valor')
    }, {
      providers: [
        textOnly(textProxy.baseUrl),
        { id: 'fake-cego', kind: 'openai', label: 'Provedor de visão (falso, sem saldo)', baseUrl: dead.baseUrl, model: 'fake-pro', apiKeyRef: 'secret:fake-cego', contextWindow: 32000, supportsVision: true, supportsTools: true, models: ['fake-pro'] }
      ]
    })
    const other = await e2e.newSession(page, { folder: ws.project, title: 'Sem modelo com visão', projectName: 'Visao', providerId: 'ollama-texto', mode: 'ask' })
    const hitsBefore = textProxy.hits.length
    const state = await page.evaluate(async ({ id, image }) => {
      await window.forja.sessions.send(id, 'Descreva a imagem anexada em uma frase.', [image], 'auto')
    }, { id: other.sessionId, image })
    void state
    try {
      await e2e.waitSettled(page, other.sessionId, { timeoutMs: TURN_TIMEOUT_MS, sinceCount: 0 })
    } catch {
      /* reported below */
    }
    const degraded = await snapshot(page, other.sessionId)
    report.degraded = degraded
    check('sem nenhum modelo com visão disponível o turno termina com resposta, sem erro', degraded.state !== 'error' && degraded.lastText.trim().length > 0, { state: degraded.state })
    check('e o LLM de texto continua sem receber a imagem', textProxy.hits.slice(hitsBefore).every((hit) => hit.images === false), textProxy.hits.slice(hitsBefore).map((hit) => hit.images))
  } finally {
    report.errors = (app.errors || []).filter((line) => line.startsWith('pageerror'))
    report.textRequests = textProxy.hits.length
    report.visionRequests = visionProxy.hits.length
    app.cleanup()
    await textProxy.close().catch(() => undefined)
    await visionProxy.close().catch(() => undefined)
    await dead.close().catch(() => undefined)
  }
  report.checks = checks
  const file = path.join(OUT, `${LABEL}-visao.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, file)}`)
  process.exit(ok() ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
