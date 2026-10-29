// End-to-end check of voice dictation with REAL speech recognition and no human:
//  1. Windows SAPI (voice "Microsoft Maria", pt-BR) speaks a sentence into a WAV file;
//  2. Electron starts with Chromium's fake microphone fed from that file;
//  3. the real mic button is clicked and the real embedded Whisper transcribes into the composer.
//   node scripts/ui-voice.cjs [outDir]
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'tmp', 'ui-voice')
const PORT = 9335
const SENTENCE = 'Abra o arquivo readme ponto em dê e rode os testes do projeto.'
const EXPECT = ['arquivo', 'testes', 'projeto']
fs.mkdirSync(OUT, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-ui-voice-'))
const profile = path.join(work, 'profile')

function synthesize(file) {
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Maria Desktop')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${file.replace(/\\/g, '\\\\')}', $fmt)
$s.Speak('${SENTENCE}')
$s.Dispose()`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe' })
}

/** Pads the speech with silence (a fake mic loops its file; the recognizer needs a pause to finish). */
function padWav(src, dest, leadSeconds, trailSeconds) {
  const wav = fs.readFileSync(src)
  const dataAt = wav.indexOf(Buffer.from('data')) + 8
  const header = Buffer.from(wav.subarray(0, dataAt))
  const pcm = wav.subarray(dataAt)
  const rate = wav.readUInt32LE(24)
  const lead = Buffer.alloc(Math.round(rate * 2 * leadSeconds))
  const trail = Buffer.alloc(Math.round(rate * 2 * trailSeconds))
  const body = Buffer.concat([lead, pcm, trail])
  header.writeUInt32LE(body.length, dataAt - 4)
  header.writeUInt32LE(36 + body.length, 4)
  fs.writeFileSync(dest, Buffer.concat([header, body]))
  return { seconds: body.length / 2 / rate, speechSeconds: pcm.length / 2 / rate }
}

async function main() {
  const results = {}
  const errors = []
  const raw = path.join(work, 'speech-raw.wav')
  const wav = path.join(work, 'speech.wav')
  synthesize(raw)
  results.audio = padWav(raw, wav, 1.0, 3.0)

  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
  const child = spawn(
    electronBin,
    [
      '.',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`
    ],
    { cwd: ROOT, stdio: 'ignore' }
  )
  const cleanup = () => {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 })
    } catch {
      /* Electron may still hold the profile */
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
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`))
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.app-shell', { timeout: 30000 })
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })

  results.status = await page.evaluate(async () => (await window.openclod.stt.status()).value ?? null)

  const input = page.locator('textarea[aria-label="Mensagem"]')
  await input.fill('Antes do ditado:')
  const mic = page.locator('.mic-btn')
  const clickedAt = Date.now()
  await mic.click()
  await page.waitForSelector('.mic-btn.state-loading, .mic-btn.state-listening', { timeout: 5000 })
  await shot('01-carregando')
  await page.waitForSelector('.mic-btn.state-listening', { timeout: 90000 })
  results.readyMs = Date.now() - clickedAt
  await shot('02-ouvindo')

  const snapshots = []
  let firstTextMs = null
  const started = Date.now()
  let value = ''
  while (Date.now() - started < 60000) {
    value = await input.inputValue()
    if (firstTextMs === null && value.length > 'Antes do ditado:'.length) firstTextMs = Date.now() - started
    if (!snapshots.length || snapshots[snapshots.length - 1] !== value) snapshots.push(value)
    if (EXPECT.every((word) => value.toLowerCase().includes(word))) break
    await page.waitForTimeout(250)
  }
  results.firstTextAfterListeningMs = firstTextMs
  results.finalText = value
  results.snapshots = snapshots
  results.meter = await page.evaluate(() => getComputedStyle(document.querySelector('.mic-btn')).boxShadow)
  await shot('03-texto-ditado')

  // Typing during dictation must not be lost, and stopping must release the microphone.
  await mic.click()
  await page.waitForSelector('.mic-btn.state-idle', { timeout: 10000 })
  await page.waitForTimeout(600)
  results.afterStop = await input.inputValue()
  results.tracksLive = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audioinput').length
  })
  results.sttRunningAfterStop = await page.evaluate(async () => (await window.openclod.stt.status()).value?.running)
  results.errors = errors
  console.log(JSON.stringify(results, null, 2))
  cleanup()
  process.exit(EXPECT.every((word) => value.toLowerCase().includes(word)) ? 0 : 2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
