// End-to-end: "Ler em voz alta" speaks only what the screen shows, and a second click stops instead of restarting.
// Real model (DeepSeek by default) writes the answer; the real neural voice (Edge) is asked to synthesize it, at volume 0.
//
//   node scripts/ui-tts.cjs [--out Prints/voz-2026-10-27]
//
// 1. The answer is markdown (bold, inline code, a list, a link, a heading): the screen shows it formatted.
// 2. Click on the speaker: the button turns into "Parar leitura" AT ONCE (it used to wait for the audio).
// 3. The text the voice engine receives has no `**`, backticks, `#`, list dashes or addresses, and every word of it
//    is on screen.
// 4. A second click while the voice is still being made stops it: no Windows voice starts, no "Edge Neural TTS
//    falhou" in the log (it used to: the click killed the synthesis and the old request fell back to SAPI).
// 5. A full read keeps the button on "Parar" while the audio plays, and a click ends it.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'voz-2026-10-27')))
const PORT = 9441

const ANSWER = [
  '**MCP do Jira**: conectado (`jira · ready · 38 ferramentas`, read-only) e já retornando dados.',
  '',
  '## Próximo passo',
  '',
  '- **Backlog**: veja [a tarefa CNC-113](https://exemplo.com/browse/CNC-113) e a CNC-114.',
  '- **Harness**: o teste de mouse passou duas vezes.',
  '',
  'Quer que eu abra a CNC-113 pelo MCP?'
].join('\n')

const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const base = JSON.parse(fs.readFileSync(path.join(e2e.FROM(), 'config', 'settings.json'), 'utf8')).voice || {}
  // Neural voice, volume 0: the test must be silent on the user's speakers.
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-tts-', settingsPatch: { voice: { ...base, ttsProvider: 'edge', ttsVolume: 0 } } })
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { checks: {} }
  const check = (name, ok, detail) => {
    result.checks[name] = ok ? 'ok' : `FALHOU${detail ? `: ${detail}` : ''}`
    if (!ok) result.failed = true
  }
  const mainLog = () => {
    try {
      return fs.readFileSync(path.join(ws.profile, 'logs', 'main.log'), 'utf8')
    } catch {
      return ''
    }
  }
  // The same button whether it reads "Ler em voz alta" or "Parar leitura".
  const speaker = page
    .locator('article.message.assistant .message-tools button[title="Ler em voz alta"], article.message.assistant .message-tools button[title="Parar leitura"]')
    .last()
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Voz', projectName: 'Projeto voz' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Voz', 'Projeto voz')
    await e2e.send(page, `Responda com o texto abaixo, copiado exatamente como está (com todos os símbolos de markdown) e sem acrescentar mais nada:\n\n${ANSWER}`)
    await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000 })

    // 1. formatted on screen
    const markdown = page.locator('article.message.assistant .markdown').last()
    const shown = await markdown.innerText()
    const formatted = await markdown.evaluate((node) => ({ strong: node.querySelectorAll('strong').length, code: node.querySelectorAll('code').length, list: node.querySelectorAll('li').length, link: node.querySelectorAll('a').length }))
    result.shown = shown.slice(0, 400)
    check('a-tela-mostra-o-markdown-formatado', formatted.strong >= 1 && formatted.list >= 2 && !shown.includes('**'), JSON.stringify(formatted))

    // The voice engine reports what it is given (the first 160 characters) on its event channel.
    await page.evaluate(() => {
      window.__tts = []
      window.openclod.tts.onEvent((event) => window.__tts.push({ ...event, at: Date.now() }))
    })
    const events = () => page.evaluate(() => window.__tts)

    // 2. the button changes at once
    const before = await speaker.getAttribute('title')
    await speaker.click()
    const quick = await page
      .waitForSelector('article.message.assistant button.msg-action.is-speaking', { timeout: 1500 })
      .then(() => true, () => false)
    check('botao-vira-parar-na-hora', before === 'Ler em voz alta' && quick && (await speaker.getAttribute('title')) === 'Parar leitura', `antes=${before}`)
    await page.screenshot({ path: path.join(OUT, '01-botao-parar-na-hora.png') })

    // 3. what the engine receives
    let spoken = ''
    for (let attempt = 0; attempt < 80 && !spoken; attempt++) {
      const found = (await events()).find((event) => event.phase === 'synthesizing' && event.text)
      if (found) spoken = found.text
      else await new Promise((resolve) => setTimeout(resolve, 250))
    }
    result.spoken = spoken
    check('a-voz-recebeu-o-texto', spoken.length > 20, `texto="${spoken}"`)
    check('sem-simbolos-de-markdown', !/\*\*|`|^#|\]\(|https?:|^\s*-\s/m.test(spoken), spoken)
    const onScreen = new Set(words(shown))
    const extra = words(spoken).filter((word) => !onScreen.has(word))
    check('tudo-que-a-voz-le-aparece-na-tela', extra.length === 0, `fora da tela: ${extra.join(', ')}`)
    check('a-voz-leu-o-conteudo-visivel', /jira/i.test(spoken), spoken)

    // 4. a second click while it is still being made stops it, with no fallback to the Windows voice
    await speaker.click()
    const stopped = await page.waitForSelector('article.message.assistant button.msg-action.is-speaking', { state: 'detached', timeout: 2000 }).then(() => true, () => false)
    check('segundo-clique-para-a-leitura', stopped && (await speaker.getAttribute('title')) === 'Ler em voz alta')
    await new Promise((resolve) => setTimeout(resolve, 7000))
    const afterStop = await events()
    check('nenhuma-voz-do-windows-comecou', !afterStop.some((event) => event.phase === 'speaking'), JSON.stringify(afterStop.map((event) => event.phase)))
    check('sem-falha-da-voz-neural-no-log', !mainLog().includes('Edge Neural TTS falhou'), mainLog().split('\n').filter((line) => line.includes('[tts]')).join(' | ').slice(0, 300))

    // 5. a full read keeps the button on "Parar" while the audio plays
    await speaker.click()
    await page.waitForSelector('article.message.assistant button.msg-action.is-speaking', { timeout: 1500 })
    let ended = false
    for (let attempt = 0; attempt < 80 && !ended; attempt++) {
      ended = (await events()).filter((event) => event.phase === 'idle').length >= 1 && (await events()).filter((event) => event.phase === 'synthesizing').length >= 2
      if (!ended) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
    const stillSpeaking = await page.locator('article.message.assistant button.msg-action.is-speaking').count()
    check('botao-segue-em-parar-enquanto-o-audio-toca', ended && stillSpeaking === 1, `sintese-terminou=${ended} botoes-em-parar=${stillSpeaking}`)
    await page.screenshot({ path: path.join(OUT, '02-lendo.png') })
    await speaker.click()
    const idle = await page.waitForSelector('article.message.assistant button.msg-action.is-speaking', { state: 'detached', timeout: 2000 }).then(() => true, () => false)
    check('clique-encerra-a-leitura', idle && (await speaker.getAttribute('title')) === 'Ler em voz alta')
    check('sem-erros-de-pagina', app.errors.filter((line) => line.startsWith('pageerror')).length === 0, app.errors.join(' | '))
  } finally {
    app.cleanup()
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.failed ? 1 : 0)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
