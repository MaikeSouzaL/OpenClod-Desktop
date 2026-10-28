// End-to-end offline speech transcription through the real agent tool and Electron transcript.
// Uses a REAL model (DeepSeek by default; only the key vault is borrowed from the real profile) to call the
// media_transcribe tool; the speech-to-text itself is the local, offline Whisper. The check is on the tool call
// and the tool RESULT (language, timestamps, transcript words), never on the model's wording.
//
//   node scripts/ui-media-transcribe.cjs [outDir] [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'media-transcribe-ui-2026-10-25'))
const PORT = 9359
const TITLE = 'Transcrever áudio'
const PROJECT = 'Mídia E2E'
fs.mkdirSync(OUT, { recursive: true })

function synthesizeSpeech(wav) {
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const speechScript = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.SetOutputToWaveFile($env:OPENCLOD_WAV)',
    '$s.Speak("A memoria do projeto usa grafo inteligente e a transcricao funciona offline.")',
    '$s.Dispose()'
  ].join('\r\n')
  execFileSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', speechScript], {
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, OPENCLOD_WAV: wav }
  })
}

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-media-ui-' })
  const wav = path.join(ws.project, 'recado.wav')
  synthesizeSpeech(wav)
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const result = { model: undefined, seconds: 0, checks, usage: undefined, errors: [] }
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: TITLE, projectName: PROJECT })
    result.model = `${session.provider}/${session.model}`
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, TITLE, PROJECT)

    const started = Date.now()
    await e2e.send(
      page,
      'Transcreva o áudio recado.wav com a ferramenta media_transcribe (ela não está no conjunto básico: carregue-a antes com tool_load), uma única vez, com path="recado.wav", model="base" e language="pt". Depois diga em uma frase do que o áudio trata.'
    )
    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 360000 })
    result.seconds = Math.round((Date.now() - started) / 1000)
    check('turno-terminou-sem-erro', settled.run !== 'error', settled.run)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT, '01-media-transcribe.png'), fullPage: true })

    const activity = await e2e.toolActivity(page, session.sessionId)
    const call = activity.calls.find((item) => item.name === 'media_transcribe')
    check('modelo-chamou-media_transcribe', Boolean(call), activity.calls.map((item) => item.name))
    check('argumentos-path-model-language', Boolean(call && call.args && call.args.path === 'recado.wav' && call.args.model === 'base' && call.args.language === 'pt'), call && call.args)
    const output = activity.results.find((item) => item.name === 'media_transcribe')
    check('resultado-ok', Boolean(output && output.ok), output && { ok: output.ok, text: output.text.slice(0, 300) })
    check('resultado-tem-idioma-pt', Boolean(output && /Idioma: pt/.test(output.text)), output && output.text.slice(0, 200))
    check('resultado-tem-timestamps', Boolean(output && /\[0:00–0:0/.test(output.text)), output && output.text.slice(0, 200))
    check('resultado-tem-a-transcricao', Boolean(output && /mem[oó]ria do projeto|transcri[cç][aã]o funciona offline/i.test(output.text)), output && output.text.slice(0, 300))

    result.usage = await e2e.usageOf(page, session.sessionId)
    result.errors = errors
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    result.ok = ok()
    const savedWav = path.join(OUT, 'recado.wav')
    fs.copyFileSync(wav, savedWav)
    result.screenshot = path.join(OUT, '01-media-transcribe.png')
    result.source = savedWav
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    app.cleanup()
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
