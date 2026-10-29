// End-to-end check of the Wispr-Flow-style global shortcut with real speech:
// SAPI speaks a sentence, Chromium's fake mic feeds the app, the global shortcut
// starts/stops dictation and the final text is inserted into the composer.
//   node scripts/ui-wispr.cjs
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const PORT = 9337
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-wispr-'))
const profile = path.join(work, 'profile')
const appData = path.join(work, 'appdata')
const localAppData = path.join(work, 'localappdata')
fs.mkdirSync(profile, { recursive: true })
fs.mkdirSync(appData, { recursive: true })
fs.mkdirSync(localAppData, { recursive: true })

const raw = path.join(work, 'raw.wav')
const wav = path.join(work, 'speech.wav')
const SENTENCE = 'Abra o arquivo readme e rode os testes do projeto.'

function synth() {
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Maria Desktop')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${raw.replace(/\\/g, '\\\\')}', $fmt)
$s.Speak('${SENTENCE}')
$s.Dispose()`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe' })
}
function padWav(src, dest, lead, trail) {
  const b = fs.readFileSync(src)
  const at = b.indexOf(Buffer.from('data')) + 8
  const header = Buffer.from(b.subarray(0, at))
  const pcm = b.subarray(at)
  const rate = b.readUInt32LE(24)
  const body = Buffer.concat([Buffer.alloc(rate * 2 * lead), pcm, Buffer.alloc(rate * 2 * trail)])
  header.writeUInt32LE(body.length, at - 4)
  header.writeUInt32LE(36 + body.length, 4)
  fs.writeFileSync(dest, Buffer.concat([header, body]))
  return (body.length / 2 / rate).toFixed(2)
}
function sendKeys(keys) {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`], { stdio: 'pipe' })
}

async function main() {
  synth()
  const seconds = padWav(raw, wav, 0.6, 1.5)
  console.log('audio', seconds, 's')

  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`], {
    cwd: ROOT,
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData },
    stdio: 'ignore'
  })
  const cleanup = () => {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }) } catch {}
  }
  process.on('exit', cleanup)

  let browser
  for (let i = 0; i < 40 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`) } catch { await new Promise((r) => setTimeout(r, 700)) }
  }
  if (!browser) throw new Error('no CDP')
  let page
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('file:'))
    if (!page) await new Promise((r) => setTimeout(r, 500))
  }
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.waitForSelector('.app-shell', { timeout: 30000 })
  await page.waitForTimeout(1200)

  const update = await page.evaluate(async () => {
    return await window.openclod.app.updateSettings({
      voice: { model: 'tiny', language: 'pt', shortcut: 'Control+Alt+J', mode: 'toggle', polish: false, insert: 'composer' }
    })
  })
  console.log('settings', JSON.stringify(update).slice(0, 300))
  await page.waitForTimeout(800)

  const input = page.locator('textarea[aria-label="Mensagem"]')
  await input.click()
  await input.fill('Antes:')
  await page.waitForTimeout(300)
  console.log('before', JSON.stringify(await input.inputValue()))

  sendKeys('^%j')
  console.log('shortcut start sent')
  await page.waitForTimeout(7000)
  sendKeys('^%j')
  console.log('shortcut stop sent')
  await page.waitForTimeout(5000)

  const value = await input.inputValue()
  console.log('after', JSON.stringify(value))
  console.log('errors', errors)
  await page.screenshot({ path: path.join(work, 'wispr.png') })
  console.log('screenshot', path.join(work, 'wispr.png'))
  await browser.close()
  cleanup()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
