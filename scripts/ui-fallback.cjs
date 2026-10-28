// End-to-end of "never stop for lack of credit": the provider of the session runs out of balance / hits a limit / refuses
// the key / cuts the answer / overflows its window / goes down, and the conversation must move to the next LLM that works,
// tell the user in the conversation, show the new model in the composer, and stay there on the next turns.
//
// Provider A is a local made-up server that fails on demand (scripts/lib/fake-provider.cjs). The LLM that has to answer is a
// REAL model: the local Ollama `qwen3.5:4b` (through a pass-through that only switches off its long "thinking"), because the
// DeepSeek account of this PC is out of balance (HTTP 402) and Ollama Cloud hit its monthly limit. The real DeepSeek 402 is itself
// one of the scenarios (`real-402`): a session on DeepSeek must end up answered by the local model.
//
//   node scripts/ui-fallback.cjs [--root <snapshot>] [--label depois|antes] [--out dir] [--only 402,429,...] [--turn-timeout ms]
//
// Everything runs in a throwaway profile (a copy of the key vault and sanitized settings); nothing touches the user's own app.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')
const { startFakeProvider, startOllamaProxy } = require('./lib/fake-provider.cjs')

const LABEL = e2e.arg('label', 'depois')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'reserva-2026-10-27')))
const PORT = 9441
const TURN_TIMEOUT_MS = Number(e2e.arg('turn-timeout', 420000))
const ONLY = (e2e.arg('only', '') || '').split(',').filter(Boolean)
const wants = (name) => !ONLY.length || ONLY.includes(name)
fs.mkdirSync(OUT, { recursive: true })

const { check, checks, ok } = e2e.makeChecks()
const report = { label: LABEL, startedAt: new Date().toISOString(), scenarios: {} }

const fakeConfig = (baseUrl, contextWindow = 128000) => ({
  id: 'fake-a', kind: 'openai', label: 'Provedor A (falso)', baseUrl, model: 'fake-pro', apiKeyRef: 'secret:fake-a',
  contextWindow, supportsVision: false, supportsTools: true, models: ['fake-pro']
})
const realConfig = (baseUrl) => ({
  id: 'ollama-real', kind: 'openai', label: 'Ollama (modelo real)', baseUrl, model: 'qwen3.5:4b', apiKeyRef: '',
  contextWindow: 65536, supportsVision: false, supportsTools: true, models: ['qwen3.5:4b']
})

async function configure(page, { providers = [], order, only }) {
  return page.evaluate(async ({ providers, order, only }) => {
    const current = (await window.forja.app.settings()).value
    const keep = current.providers.filter((item) => !providers.some((next) => next.id === item.id))
    const all = [...keep, ...providers]
    const exclude = all.map((item) => item.id).filter((id) => !only.includes(id))
    const saved = await window.forja.app.updateSettings({ providers: all, useAllModels: true, fallbackOrder: order, fallbackExclude: exclude })
    return saved.ok ? { ok: true } : { ok: false, error: saved.error }
  }, { providers, order, only })
}

async function snapshot(page, sessionId) {
  return page.evaluate(async (id) => {
    const state = (await window.forja.sessions.get(id)).value
    const text = (message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
    const answers = state.messages.filter((message) => message.role === 'assistant' && text(message).trim())
    const last = answers[answers.length - 1]
    return {
      state: state.state,
      meta: { providerId: state.meta.providerId, model: state.meta.model },
      notes: state.messages.filter((message) => message.role === 'system' && message.notice).map(text),
      answeredBy: answers.map((message) => `${message.model || '?'}:${text(message).slice(0, 60)}`),
      lastModel: last ? last.model : undefined,
      lastText: last ? text(last) : '',
      failures: state.messages.filter((message) => message.error).map((message) => String(message.error).slice(0, 160)),
      count: state.messages.length
    }
  }, sessionId)
}

async function composerUi(page) {
  return page.evaluate(() => ({
    model: document.querySelector('.model-btn .model-short')?.textContent?.trim() || '',
    provider: document.querySelector('.hint-provider')?.textContent?.trim() || '',
    notices: [...document.querySelectorAll('.transcript-notice')].map((node) => (node.textContent || '').trim())
  }))
}

async function openFresh(app, ws, { title, providerId }) {
  const session = await e2e.newSession(app.page, { folder: ws.project, title, projectName: 'Reserva', providerId })
  await app.page.reload()
  await app.page.waitForSelector('.app-shell')
  await e2e.openSession(app.page, title, 'Reserva')
  return session
}

async function turn(app, sessionId, prompt) {
  const before = (await snapshot(app.page, sessionId)).count
  const started = Date.now()
  await e2e.send(app.page, prompt)
  let timedOut = false
  try {
    await e2e.waitSettled(app.page, sessionId, { timeoutMs: TURN_TIMEOUT_MS, sinceCount: before })
  } catch {
    timedOut = true
  }
  await app.page.waitForTimeout(800)
  return { seconds: Math.round((Date.now() - started) / 1000), timedOut, ...(await snapshot(app.page, sessionId)) }
}

async function shot(app, name) {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  // A busy machine can make Chromium take a long time to paint: one more try, and a missing picture never fails a check.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await app.page.screenshot({ path: file, timeout: 90000 })
      return path.relative(e2e.ROOT, file)
    } catch (err) {
      console.log(`aviso: captura ${name} falhou (${attempt}/2): ${String(err.message).slice(0, 120)}`)
    }
  }
  return ''
}

/** The reasons a provider-side failure is told to the user (core/providers/health.ts, describeFailure). */
const WORDS = { quota: /sem saldo ou cota/, rate_limit: /limite de uso atingido/, auth: /chave recusada/, network: /sem conexão|network/, context_overflow: /janela de contexto/ }

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-reserva-' })
  const fake = await startFakeProvider()
  const proxy = await startOllamaProxy()
  let app = await e2e.launch({ port: PORT, ...ws })
  try {
    const setup = await configure(app.page, { providers: [fakeConfig(fake.baseUrl), realConfig(proxy.baseUrl)], order: ['ollama-real'], only: ['fake-a', 'ollama-real'] })
    check('configuração dos provedores de teste gravada', setup.ok, setup.error)
    await app.page.evaluate(() => window.forja.app.setSecret('fake-a', 'chave-de-teste-local-sem-valor'))

    /* ------------------------------ 402: credit runs out mid-conversation ----------------------------- */
    if (wants('402')) {
      const s = await openFresh(app, ws, { title: 'Reserva 402', providerId: 'fake-a' })
      fake.state.mode = 'ok'
      const t1 = await turn(app, s.sessionId, 'Lembre desta palavra-código: CAJU-42. Responda apenas: ok.')
      check('402: o turno 1 é respondido pelo provedor A (ainda com saldo)', t1.lastModel === 'fake-pro', t1.answeredBy)

      fake.state.mode = '402'
      const hitsBefore = fake.hits('402').length
      const t2 = await turn(app, s.sessionId, 'Qual era a palavra-código que pedi para você lembrar? Responda só a palavra.')
      const ui = await composerUi(app.page)
      report.scenarios['402'] = { t2, ui, hitsA: fake.hits('402').length - hitsBefore }
      check('402: o turno terminou com resposta (não parou por falta de crédito)', !t2.timedOut && t2.state !== 'error' && t2.lastText.trim().length > 0, { state: t2.state, failures: t2.failures })
      check('402: quem respondeu foi o LLM real da reserva', t2.lastModel === 'qwen3.5:4b', t2.answeredBy)
      check('402: o contexto foi preservado (o modelo novo sabe a palavra-código)', /CAJU/i.test(t2.lastText), t2.lastText.slice(0, 120))
      check('402: o provedor esgotado foi chamado só uma vez no turno', fake.hits('402').length - hitsBefore === 1, fake.hits('402').length - hitsBefore)
      check('402: a conversa avisa a troca (linha na conversa, com os dois nomes e o motivo)', t2.notes.length === 1 && /Provedor A/.test(t2.notes[0]) && /Ollama \(modelo real\)/.test(t2.notes[0]) && WORDS.quota.test(t2.notes[0]), t2.notes)
      check('402: a linha de aviso aparece na tela', ui.notices.length >= 1 && /continuando com/.test(ui.notices[0]), ui.notices)
      check('402: a sessão passou a usar o modelo que funciona', t2.meta.providerId === 'ollama-real' && t2.meta.model === 'qwen3.5:4b', t2.meta)
      check('402: o seletor de modelo do compositor mostra o modelo novo', ui.model === 'qwen3.5:4b', ui)
      check('402: o rodapé do compositor mostra o provedor novo', ui.provider === 'Ollama (modelo real)', ui)
      report.scenarios['402'].shot = await shot(app, '402-conversa')

      // Next turns: stays on the one that works, and does not ask the exhausted one again.
      const t3 = await turn(app, s.sessionId, 'Quanto é 21 vezes 2? Responda só o número.')
      check('402: o turno seguinte continua no modelo que funciona', t3.lastModel === 'qwen3.5:4b' && /42/.test(t3.lastText), t3.answeredBy.slice(-1))
      check('402: o provedor esgotado NÃO é tentado de novo a cada turno', fake.hits('402').length - hitsBefore === 1, fake.hits('402').length - hitsBefore)

      // A new conversation asked to start on the exhausted provider starts on the one that works.
      const fresh = await app.page.evaluate(async ({ folder }) => {
        const project = (await window.forja.projects.list()).value.find((item) => item.path === folder)
        const created = await window.forja.sessions.create({ projectId: project.id, cwd: folder, mode: 'code', surface: 'code', providerId: 'fake-a', model: 'fake-pro', title: 'Nova depois da falha' })
        return created.ok ? { providerId: created.value.providerId, model: created.value.model } : { error: created.error }
      }, { folder: ws.project })
      check('402: uma conversa nova pedida no provedor esgotado já começa no que funciona', fresh.providerId === 'ollama-real', fresh)

      // The settings are saved (what the user does when adding a provider): the session must not go back to the exhausted one.
      await app.page.evaluate(async () => {
        const settings = (await window.forja.app.settings()).value
        await window.forja.app.updateSettings({ providers: settings.providers })
      })
      const t4 = await turn(app, s.sessionId, 'Repita a palavra-código, só a palavra.')
      check('402: depois de salvar as configurações a sessão continua no modelo que funciona', t4.meta.providerId === 'ollama-real' && /CAJU/i.test(t4.lastText), { meta: t4.meta, text: t4.lastText.slice(0, 80) })
      check('402: nem salvar as configurações fez o esgotado ser chamado de novo', fake.hits('402').length - hitsBefore === 1, fake.hits('402').length - hitsBefore)

      // The app is closed and opened again: the session is still on the model that works.
      try { execFileSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2500))
      app = await e2e.launch({ port: PORT + 1, ...ws })
      // The app opens on Início; the sessions of a project are listed under Code, a moment after the window opens.
      await app.page.locator('.mode-switch button', { hasText: 'Code' }).click()
      await app.page.waitForSelector('.side-project-name', { timeout: 30000 })
      await app.page.waitForTimeout(1500)
      // The first message names the session: it is no longer called "Reserva 402".
      await e2e.openSession(app.page, 'Lembre desta palavra', 'Reserva')
      const afterRestart = await composerUi(app.page)
      check('402: depois de reabrir o app o seletor continua mostrando o modelo que funciona', afterRestart.model === 'qwen3.5:4b', afterRestart)
      const t5 = await turn(app, s.sessionId, 'Qual era a palavra-código? Responda só a palavra.')
      check('402: depois de reabrir o app a resposta vem do modelo que funciona, sem tocar no esgotado', /CAJU/i.test(t5.lastText) && fake.hits('402').length - hitsBefore === 1, { text: t5.lastText.slice(0, 80), hits: fake.hits('402').length - hitsBefore })
    }

    /* --------------------------- one turn per kind of failure of the provider -------------------------- */
    const kinds = [
      { name: '429', mode: '429', prompt: 'Responda apenas com a palavra: pronto.', why: WORDS.rate_limit, fast: true },
      { name: '401', mode: '401', prompt: 'Responda apenas com a palavra: pronto.', why: WORDS.auth },
      { name: 'partial', mode: 'partial', prompt: 'Diga em uma frase qual é a capital da França.', why: WORDS.rate_limit, partial: 'A capital da França é' },
      { name: 'overflow', mode: 'overflow', prompt: 'Responda apenas com a palavra: pronto.', why: WORDS.context_overflow, window: 8192 },
      { name: 'refused', mode: 'refused', prompt: 'Responda apenas com a palavra: pronto.', why: WORDS.network }
    ]
    for (const kind of kinds) {
      if (!wants(kind.name)) continue
      await configure(app.page, { providers: [fakeConfig(fake.baseUrl, kind.window ?? 128000)], order: ['ollama-real'], only: ['fake-a', 'ollama-real'] })
      fake.state.mode = kind.mode
      const hitsBefore = fake.hits(kind.mode).length
      const s = await openFresh(app, ws, { title: `Reserva ${kind.name}`, providerId: 'fake-a' })
      const t = await turn(app, s.sessionId, kind.prompt)
      const ui = await composerUi(app.page)
      const hits = fake.hits(kind.mode).length - hitsBefore
      report.scenarios[kind.name] = { t, ui, hitsA: hits }
      check(`${kind.name}: a conversa terminou com resposta de um LLM que funciona`, !t.timedOut && t.state !== 'error' && t.lastModel === 'qwen3.5:4b' && t.lastText.trim().length > 0, { state: t.state, lastModel: t.lastModel, failures: t.failures, seconds: t.seconds })
      check(`${kind.name}: a conversa avisa a troca e o motivo`, t.notes.length >= 1 && kind.why.test(t.notes.join(' ')), t.notes)
      check(`${kind.name}: o seletor do compositor mostra o modelo novo`, ui.model === 'qwen3.5:4b' && t.meta.providerId === 'ollama-real', { ui, meta: t.meta })
      if (kind.fast) check(`${kind.name}: sem esperar o Retry-After de 1 hora (turno em menos de 3 min, uma só chamada ao limitado)`, t.seconds < 180 && hits === 1, { seconds: t.seconds, hits })
      if (kind.partial) {
        check(`${kind.name}: a metade da resposta que já estava na tela foi mantida`, t.answeredBy.some((entry) => entry.startsWith('fake-pro:') && entry.includes(kind.partial)), t.answeredBy)
        check(`${kind.name}: o modelo novo continuou a resposta (texto depois da metade)`, t.lastText.trim().length > 0 && t.lastModel === 'qwen3.5:4b', t.lastText.slice(0, 100))
      }
      report.scenarios[kind.name].shot = await shot(app, `${kind.name}-conversa`)
    }

    /* ----------------- the real DeepSeek of this PC: out of balance (402) -> the real local model ---------------- */
    if (wants('real-402')) {
      await configure(app.page, { providers: [], order: ['ollama-real'], only: ['deepseek', 'ollama-real'] })
      const probe = await app.page.evaluate(async () => (await window.forja.app.testProvider('deepseek')))
      const detail = probe.ok ? String(probe.value.detail) : String(probe.error)
      const exhausted = probe.ok && !probe.value.ok && /402|insufficient|balance|saldo/i.test(detail)
      if (!exhausted) {
        console.log(`SKIP real-402: o DeepSeek respondeu (${detail.slice(0, 100)}); sem saldo esgotado não há o que provar aqui`)
        report.scenarios['real-402'] = { skipped: detail.slice(0, 160) }
      } else {
        await configure(app.page, { providers: [], order: ['ollama-real'], only: ['deepseek', 'ollama-real'] })
        const s = await openFresh(app, ws, { title: 'Reserva DeepSeek real', providerId: 'deepseek' })
        const before = (await app.page.evaluate(async (id) => (await window.forja.sessions.get(id)).value.meta, s.sessionId))
        const t = await turn(app, s.sessionId, 'Responda apenas com a palavra: pronto.')
        const ui = await composerUi(app.page)
        report.scenarios['real-402'] = { before, t, ui, deepseek: detail.slice(0, 160) }
        check('real-402: a sessão começou no DeepSeek (provedor padrão do usuário)', before.providerId === 'deepseek' || t.notes.length > 0, before)
        check('real-402: com o DeepSeek sem saldo de verdade, o LLM local real respondeu', !t.timedOut && t.lastModel === 'qwen3.5:4b' && t.lastText.trim().length > 0, { state: t.state, lastModel: t.lastModel, failures: t.failures })
        check('real-402: a conversa avisa "DeepSeek ... sem saldo"', t.notes.some((note) => /DeepSeek/.test(note) && WORDS.quota.test(note)), t.notes)
        check('real-402: o seletor mostra o modelo local', ui.model === 'qwen3.5:4b', ui)
        report.scenarios['real-402'].shot = await shot(app, 'real-402-conversa')
      }
    }

    /* ----------------- OpenRouter as the reserve (needs the user's OpenRouter key in the vault copy) ---------------- */
    if (wants('openrouter')) {
      const caps = await app.page.evaluate(async () => (await window.forja.app.capabilities()).value.providers.find((item) => item.id === 'openrouter'))
      if (!caps?.configured) {
        console.log('SKIP openrouter: o OpenRouter não tem chave no cofre do perfil de origem (salve a chave em Configurações → Provedores e rode de novo)')
        report.scenarios.openrouter = { skipped: 'sem chave no cofre' }
      } else {
        // The user's own OpenRouter provider (key from the vault copy), with a cheap model unless --openrouter-model says otherwise.
        const model = e2e.arg('openrouter-model', 'deepseek/deepseek-chat')
        const card = await app.page.evaluate(async (model) => {
          const settings = (await window.forja.app.settings()).value
          return { ...settings.providers.find((item) => item.id === 'openrouter'), model }
        }, model)
        await configure(app.page, { providers: [fakeConfig(fake.baseUrl), card], order: ['openrouter'], only: ['fake-a', 'openrouter'] })
        fake.state.mode = '402'
        const s = await openFresh(app, ws, { title: 'Reserva OpenRouter', providerId: 'fake-a' })
        const t = await turn(app, s.sessionId, 'Responda apenas com a palavra: pronto.')
        const ui = await composerUi(app.page)
        report.scenarios.openrouter = { model, t, ui }
        check('openrouter: o provedor que acabou foi trocado pelo OpenRouter e a resposta veio de um modelo dele', !t.timedOut && t.state !== 'error' && t.lastModel === model && t.lastText.trim().length > 0, { state: t.state, lastModel: t.lastModel, failures: t.failures })
        check('openrouter: a conversa avisa a troca', t.notes.some((note) => /OpenRouter/.test(note) && WORDS.quota.test(note)), t.notes)
        check('openrouter: o seletor mostra o modelo do OpenRouter', ui.model === model && ui.provider === 'OpenRouter', ui)
        report.scenarios.openrouter.shot = await shot(app, 'openrouter-conversa')
      }
    }

    /* ---- Settings: each provider opens a list of its models; the ones ticked are the ones the reserve tries ---- */
    if (wants('modelos')) {
      const fakeB = {
        id: 'fake-b', kind: 'openai', label: 'Provedor B (falso)', baseUrl: fake.baseUrl, model: 'fake-b-1', apiKeyRef: 'secret:fake-b',
        contextWindow: 128000, supportsVision: false, supportsTools: true, models: ['fake-b-1', 'fake-b-2', 'fake-b-3']
      }
      await app.page.evaluate(() => window.forja.app.setSecret('fake-b', 'chave-de-teste-local-sem-valor').catch(() => undefined))
      await configure(app.page, { providers: [fakeConfig(fake.baseUrl), fakeB, realConfig(proxy.baseUrl)], order: ['fake-b', 'ollama-real'], only: ['fake-a', 'fake-b', 'ollama-real'] })
      await app.page.evaluate(() => window.forja.app.setSecret('fake-b', 'chave-de-teste-local-sem-valor'))
      await app.page.reload()
      await app.page.waitForSelector('.app-shell')
      await app.page.keyboard.press('Control+,')
      await app.page.waitForSelector('.reserve-list', { timeout: 15000 })
      const row = app.page.locator('.reserve-row[data-provider="fake-b"]')
      const panel = app.page.locator('#reserve-models-fake-b')
      check('modelos: o item do provedor ainda não mostra a lista de modelos (começa fechado)', (await panel.count()) === 0)
      await row.locator('.reserve-expand').click()
      await panel.waitFor({ timeout: 10000 })
      const count = async () => ((await panel.locator('.reserve-count').textContent()) || '').trim()
      check('modelos: ao abrir, lista os modelos do provedor com uma caixa por modelo', (await panel.locator('input[data-model]').count()) === 3, await count())
      check('modelos: sem mexer, só o modelo principal está marcado', (await count()) === '1 de 3 marcados' && (await panel.locator('input[data-model="fake-b-1"]').isChecked()), await count())
      await panel.getByLabel('Selecionar todos').check()
      check('modelos: "Selecionar todos" marca todos', (await count()) === '3 de 3 marcados', await count())
      await panel.locator('input[data-model="fake-b-3"]').uncheck()
      check('modelos: desmarcar um deixa os outros', (await count()) === '2 de 3 marcados' && !(await panel.locator('input[data-model="fake-b-3"]').isChecked()), await count())
      check('modelos: a linha do provedor resume "2 modelos"', /2 modelos/.test((await row.locator('.reserve-name em').textContent()) || ''))
      report.shotModelos = await shot(app, 'modelos-da-reserva')
      await app.page.getByRole('button', { name: 'Salvar alterações' }).click()
      for (let attempt = 0; attempt < 40; attempt++) {
        const ticked = await app.page.evaluate(async () => (await window.forja.app.settings()).value.fallbackModels?.['fake-b'])
        if (Array.isArray(ticked) && ticked.length === 2) break
        await app.page.waitForTimeout(250)
      }
      const saved = await app.page.evaluate(async () => (await window.forja.app.settings()).value.fallbackModels)
      check('modelos: "Salvar alterações" grava só os modelos marcados', JSON.stringify(saved?.['fake-b']) === JSON.stringify(['fake-b-1', 'fake-b-2']), saved)

      // The ticked models are the ones tried, in order; the unticked one never is; a real model answers at the end.
      await app.page.locator('button.btn.ghost', { hasText: /^Fechar$/ }).click().catch(() => undefined)
      fake.state.mode = 'ok'
      fake.state.perModel = { 'fake-pro': '402', 'fake-b-1': '429', 'fake-b-2': '429' }
      const hitsOf = (model) => fake.state.hits.filter((hit) => hit.model === model).length
      const before = { a: hitsOf('fake-pro'), b1: hitsOf('fake-b-1'), b2: hitsOf('fake-b-2'), b3: hitsOf('fake-b-3') }
      const s = await openFresh(app, ws, { title: 'Reserva modelos marcados', providerId: 'fake-a' })
      const t = await turn(app, s.sessionId, 'Responda apenas com a palavra: pronto.')
      report.scenarios.modelos = { t, hits: { a: hitsOf('fake-pro') - before.a, b1: hitsOf('fake-b-1') - before.b1, b2: hitsOf('fake-b-2') - before.b2, b3: hitsOf('fake-b-3') - before.b3 } }
      check('modelos: depois dos dois modelos marcados falharem, o LLM real respondeu', !t.timedOut && t.state !== 'error' && t.lastModel === 'qwen3.5:4b' && t.lastText.trim().length > 0, { state: t.state, lastModel: t.lastModel, failures: t.failures })
      check('modelos: foram tentados nesta ordem: o esgotado, o 1º marcado, o 2º marcado', hitsOf('fake-pro') - before.a === 1 && hitsOf('fake-b-1') - before.b1 === 1 && hitsOf('fake-b-2') - before.b2 === 1, report.scenarios.modelos.hits)
      check('modelos: o modelo que NÃO foi marcado nunca foi chamado', hitsOf('fake-b-3') - before.b3 === 0, report.scenarios.modelos.hits)
      check('modelos: a conversa avisou as três trocas', t.notes.length === 3 && /Provedor B \(falso\)\/fake-b-1/.test(t.notes[1] || '') && /fake-b-2/.test(t.notes[1] || ''), t.notes)
      fake.state.perModel = {}
    }

    /* ------------------- Settings: the user sees and chooses the order of the reserve -------------------- */
    if (wants('ordem')) {
      await configure(app.page, { providers: [fakeConfig(fake.baseUrl), realConfig(proxy.baseUrl)], order: ['fake-a', 'ollama-real'], only: ['fake-a', 'ollama-real', 'deepseek'] })
      await app.page.reload()
      await app.page.waitForSelector('.app-shell')
      await app.page.keyboard.press('Control+,')
      await app.page.waitForSelector('.settings-nav, .modal-body', { timeout: 15000 })
      const present = await app.page.locator('.reserve-list').count()
      check('ordem: Configurações → Provedores mostra a lista "Ordem da reserva"', present === 1)
      if (present) {
        const read = () => app.page.evaluate(() => [...document.querySelectorAll('.reserve-row')].map((row) => ({ id: row.getAttribute('data-provider'), status: row.querySelector('.reserve-status')?.textContent?.trim() })))
        const first = await read()
        check('ordem: a lista segue a ordem escolhida e mostra o estado de cada provedor', first[0]?.id === 'fake-a' && first[1]?.id === 'ollama-real' && first.every((row) => row.status), first.slice(0, 4))
        await app.page.locator('.reserve-row[data-provider="ollama-real"] button[aria-label^="Subir"]').click()
        const moved = await read()
        check('ordem: o botão "Subir" troca a ordem', moved[0]?.id === 'ollama-real', moved.slice(0, 3).map((row) => row.id))
        await app.page.locator('.reserve-row[data-provider="fake-a"] input[type="checkbox"]').uncheck()
        report.shotOrdem = await shot(app, 'ordem-da-reserva')
        await app.page.getByRole('button', { name: 'Salvar alterações' }).click()
        await app.page.waitForTimeout(1500)
        const saved = await app.page.evaluate(async () => { const s = (await window.forja.app.settings()).value; return { order: s.fallbackOrder, exclude: s.fallbackExclude } })
        check('ordem: "Salvar alterações" grava a ordem e quem fica fora', saved.order?.[0] === 'ollama-real' && saved.exclude?.includes('fake-a'), saved)
      }
    }
  } finally {
    report.fakeHits = fake.state.hits.map((hit) => `${hit.mode}`).join(',')
    report.proxyRequests = proxy.hits.length
    report.errors = (app.errors || []).filter((line) => line.startsWith('pageerror'))
    app.cleanup()
    await fake.close().catch(() => undefined)
    await proxy.close().catch(() => undefined)
  }
  report.checks = checks
  const file = path.join(OUT, `${LABEL}-reserva.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, file)}`)
  process.exit(ok() ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
