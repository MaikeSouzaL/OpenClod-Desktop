// End-to-end media ingestion with a REAL model: an audio and a video attached to the message are processed by the
// harness itself (Python engine: transcript, scene-aware frames, contact sheets, OCR of the frames), written to the
// project's memory, and the model answers from what is there. A SECOND session of the same project then answers about the
// recording without any attachment: it has to find it in the memory.
//
//   node scripts/ui-media.cjs [--root <snapshot>] [--video <file.mp4>] [--out Prints/midia-2026-10-27]
//
// The checks are on what the harness did (hidden digest, pages, files, OCR) and on facts only the media contains
// (the words of the audio, the narration and the on-screen text of the video), never on the model's wording.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'midia-2026-10-27')))
const PORT = Number(e2e.arg('port', '9460'))
const REAL_VIDEO = e2e.arg('video', 'C:\\Users\\Administrator\\Desktop\\01 Projetos\\claude-real-video\\crv-runs\\20261015-190937_DebQHQPA1eS\\source.mp4')
const SPEECH =
  'Reunião de planejamento do projeto Aurora. Decidimos usar o banco de dados PostgreSQL e lançar a versão dois em novembro. A responsável pelo relatório final é a Marina. O orçamento aprovado foi de cinquenta mil reais.'

function synthesize(wav) {
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try { $s.SelectVoice("Microsoft Maria Desktop") } catch {}',
    '$s.SetOutputToWaveFile($env:OPENCLOD_WAV)',
    '$s.Speak($env:OPENCLOD_TEXT)',
    '$s.Dispose()'
  ].join('\r\n')
  execFileSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60_000, env: { ...process.env, OPENCLOD_WAV: wav, OPENCLOD_TEXT: SPEECH } })
}

/** The block the composer appends for attached files (src/renderer/src/lib/path-attachments.ts). */
function attachment(file) {
  return `\n\nPastas e arquivos anexados pelo usuário (estude o conteúdo sob demanda, com list_files, read_file e as ferramentas de shell; eles podem estar fora do projeto):\n- arquivo "${path.basename(file)}": \`${file}\``
}

const approxTokens = (text) => Math.ceil(String(text).length / 4)

async function ask(app, session, title, text, expectedMessagesBefore) {
  const { page } = app
  await page.reload()
  await page.waitForSelector('.app-shell')
  await e2e.openSession(page, title, 'Projeto mídia')
  const started = Date.now()
  await e2e.send(page, text)
  const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 480000, sinceCount: expectedMessagesBefore })
  const report = await e2e.turnReport(page, session.sessionId, expectedMessagesBefore)
  const messages = await page.evaluate(async (id) => (await window.forja.sessions.get(id)).value.messages, session.sessionId)
  return { settled, report, messages, seconds: Math.round((Date.now() - started) / 1000) }
}

function hidden(messages, prefix) {
  return messages.filter((m) => m.role === 'user' && m.hidden).map((m) => (m.parts.find((p) => p.type === 'text') || {}).text || '').filter((t) => t.startsWith(prefix))
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-media-e2e-' })
  const attachments = path.join(ws.work, 'anexos')
  fs.mkdirSync(attachments, { recursive: true })
  const wav = path.join(attachments, 'reuniao aurora.wav')
  synthesize(wav)
  const haveVideo = fs.existsSync(REAL_VIDEO)
  const video = path.join(attachments, 'aula hinoter.mp4')
  if (haveVideo) fs.copyFileSync(REAL_VIDEO, video)

  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const result = { checks, sessions: {}, usage: {} }
  try {
    /* ------------------------------ 1. audio ------------------------------ */
    const a = await e2e.newSession(page, { folder: ws.project, title: 'Áudio anexado', projectName: 'Projeto mídia' })
    result.model = `${a.provider}/${a.model}`
    const turnA = await ask(app, a, 'Áudio anexado', `Resuma o que foi dito neste áudio e diga quem é a responsável pelo relatório final.${attachment(wav)}`, 0)
    check('audio: turno terminou sem erro', turnA.settled.run !== 'error', turnA.settled.run)
    const digestA = hidden(turnA.messages, '<midia-processada>')[0] || ''
    check('audio: o harness processou o anexo ANTES do modelo (resumo oculto com o slug da memória)', /Mídia processada: reuniao aurora\.wav/.test(digestA) && /\[audio-reuniao-aurora-[0-9a-f]{6}\]/.test(digestA), digestA.slice(0, 240))
    const answerA = turnA.report.finalText
    check('audio: a resposta traz fatos que só estão no áudio (Marina)', /marina/i.test(answerA), answerA.slice(0, 200))
    check('audio: o modelo NÃO precisou transcrever por ferramenta', !turnA.report.calls.includes('media_transcribe') && !turnA.report.calls.includes('media_ingest'), turnA.report.calls)
    // The processing shows as a running tool ("processando 1 mídia · 12 s"), not as a silent thinking: its start and end are persisted.
    const eventLines = fs.readFileSync(path.join(ws.profile, 'data', 'sessions', `${a.sessionId}.events.jsonl`), 'utf8').split('\n')
    const events = eventLines.filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    const started = events.find((event) => event.type === 'tool_start' && event.name === 'media_ingest')
    const ended = events.find((event) => event.type === 'tool_end' && event.name === 'media_ingest')
    check('audio: o processamento apareceu como atividade em andamento e terminou bem', Boolean(started && ended && ended.ok), { started: Boolean(started), ended })
    await page.screenshot({ path: path.join(OUT, '01-audio-anexado.png'), fullPage: true })

    const wiki = path.join(ws.profile, 'data', 'memory', 'projects', a.projectId, 'wiki')
    const pages = fs.existsSync(wiki) ? fs.readdirSync(wiki).filter((f) => /^audio-reuniao-aurora/.test(f)) : []
    check('audio: página-índice e parte gravadas na memória do projeto', pages.some((f) => !/parte/.test(f)) && pages.some((f) => /parte-1/.test(f)), pages)
    const partPage = pages.find((f) => /parte-1/.test(f))
    const partText = partPage ? fs.readFileSync(path.join(wiki, partPage), 'utf8') : ''
    check('audio: a parte tem a transcrição (PostgreSQL, novembro, Marina) com tempos', /postgresql/i.test(partText) && /novembro/i.test(partText) && /marina/i.test(partText) && /\[0:\d\d–/.test(partText), partText.slice(0, 200))
    const mediaDirs = path.join(ws.profile, 'data', 'memory', 'projects', a.projectId, 'media')
    const audioDir = fs.existsSync(mediaDirs) ? fs.readdirSync(mediaDirs).find((d) => /^reuniao-aurora/.test(d)) : null
    check('audio: manifesto e transcrição em disco', Boolean(audioDir) && fs.existsSync(path.join(mediaDirs, audioDir, 'manifest.json')) && fs.existsSync(path.join(mediaDirs, audioDir, 'transcript.json')))
    result.sessions.audio = { seconds: turnA.seconds, calls: turnA.report.calls, answer: answerA.slice(0, 300), digestTokens: approxTokens(digestA), transcriptTokens: approxTokens(partText) }

    /* ------- 2. a NEW session, no attachment: the recording is in the memory ------- */
    const b = await e2e.newSession(page, { folder: ws.project, title: 'Pergunta sem anexo', projectName: 'Projeto mídia' })
    const turnB = await ask(app, b, 'Pergunta sem anexo', 'Na reunião gravada do projeto Aurora, qual banco de dados decidimos usar, quando sai a versão dois e quanto foi o orçamento? Procure na memória do projeto.', 0)
    check('memória: sessão nova responde sobre a gravação sem anexo', /postgres/i.test(turnB.report.finalText) && /novembro/i.test(turnB.report.finalText), turnB.report.finalText.slice(0, 240))
    const usedMemory = turnB.report.calls.filter((name) => /^memory_/.test(name))
    const injected = hidden(turnB.messages, '<contexto-do-turno>').some((t) => /audio-reuniao-aurora/.test(t))
    check('memória: achou pela memória (ferramenta de memória ou contexto do turno), sem reprocessar', (usedMemory.length > 0 || injected) && !turnB.report.calls.includes('media_ingest') && !turnB.report.calls.includes('media_transcribe'), { usedMemory, injected, calls: turnB.report.calls })
    await page.screenshot({ path: path.join(OUT, '02-sessao-nova-responde-pelo-audio.png'), fullPage: true })
    result.sessions.memory = { seconds: turnB.seconds, calls: turnB.report.calls, injected, answer: turnB.report.finalText.slice(0, 300) }

    /* ------------------------------ 3. video ------------------------------ */
    if (haveVideo) {
      const c = await e2e.newSession(page, { folder: ws.project, title: 'Vídeo anexado', projectName: 'Projeto mídia' })
      const turnC = await ask(app, c, 'Vídeo anexado', `O que este vídeo mostra e o que a narração diz? Responda em poucas linhas.${attachment(video)}`, 0)
      check('vídeo: turno terminou sem erro', turnC.settled.run !== 'error', turnC.settled.run)
      const digestC = hidden(turnC.messages, '<midia-processada>')[0] || ''
      check('vídeo: resumo oculto com slugs, frames e folhas', /\[video-aula-hinoter-[0-9a-f]{6}\]/.test(digestC) && /frames em \d+ folha/.test(digestC), digestC.slice(0, 300))
      check('vídeo: a resposta reflete a narração (anotar/transcrever/resumo)', /transcri|anot|resum|aula|professor/i.test(turnC.report.finalText), turnC.report.finalText.slice(0, 240))
      const wikiC = fs.readdirSync(wiki).filter((f) => /^video-aula-hinoter/.test(f))
      const partsC = wikiC.filter((f) => /parte/.test(f)).map((f) => fs.readFileSync(path.join(wiki, f), 'utf8'))
      const all = partsC.join('\n')
      check('vídeo: a memória tem a fala E o texto que o OCR leu nos frames', /transcreve|anotar|professor/i.test(all) && /na tela:/.test(all), all.slice(0, 300))
      check('vídeo: os frames aparecem na linha do tempo com folha e célula', /▸ #\d+ \d+:\d\d frame_\d+\.jpg · folha \d+ célula \d+/.test(all))
      const dirC = fs.readdirSync(mediaDirs).find((d) => /^aula-hinoter/.test(d))
      const manifest = dirC ? JSON.parse(fs.readFileSync(path.join(mediaDirs, dirC, 'manifest.json'), 'utf8')) : null
      check('vídeo: frames e folhas de contato em disco (JPEG)', Boolean(manifest) && manifest.frames.length >= 10 && manifest.sheets.length >= 2 && fs.readFileSync(path.join(mediaDirs, dirC, manifest.sheets[0].file)).subarray(0, 2).toString('hex') === 'ffd8', manifest && manifest.stats)
      // The sheets only reach a model the settings say can see images.
      const vision = await page.evaluate(async (id) => ((await window.forja.app.settings()).value.providers.find((item) => item.id === id) || {}).supportsVision === true, c.provider)
      const withImages = turnC.messages.some((m) => m.hidden && m.parts.some((p) => p.type === 'image'))
      check(`vídeo: as folhas só vão como imagem para modelo com visão (visão=${vision})`, withImages === vision, { vision, withImages })
      await page.screenshot({ path: path.join(OUT, '03-video-anexado.png'), fullPage: true })
      result.sessions.video = { seconds: turnC.seconds, calls: turnC.report.calls, answer: turnC.report.finalText.slice(0, 400), digestTokens: approxTokens(digestC), pages: wikiC.length, frames: manifest && manifest.frames.length, sheets: manifest && manifest.sheets.length, ocrFrames: manifest && Object.keys(JSON.parse(fs.readFileSync(path.join(mediaDirs, dirC, 'ocr.json'), 'utf8')).frames).length, transcriptSegments: manifest && manifest.transcript.segments.length, partTokens: approxTokens(all) }
    } else {
      console.log(`(sem o vídeo real em ${REAL_VIDEO}: parte do vídeo pulada)`)
    }
    check('sem erros de página', errors.filter((line) => line.startsWith('pageerror')).length === 0, errors.join(' | '))
    result.usage = { audio: await e2e.usageOf(page, a.sessionId), memory: await e2e.usageOf(page, b.sessionId) }
  } finally {
    app.cleanup()
  }
  fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: ok(), sessions: result.sessions, usage: result.usage }, null, 2))
  process.exit(ok() ? 0 : 1)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
