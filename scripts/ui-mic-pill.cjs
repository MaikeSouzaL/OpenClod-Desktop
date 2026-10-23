// End-to-end check that the microphone button uses the same global dictation
// engine as the shortcut: the floating pill appears, the fake mic is transcribed
// and the final text is inserted into the composer.
//   node scripts/ui-mic-pill.cjs
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const PORT = 9341
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-mic-pill-'))
const profile = path.join(work, 'profile')
const appData = path.join(work, 'appdata')
const localAppData = path.join(work, 'localappdata')
for (const d of [profile, appData, localAppData]) fs.mkdirSync(d, { recursive: true })
const raw = path.join(work, 'raw.wav')
const wav = path.join(work, 'speech.wav')
const SENTENCE = 'Testando a pilula do microfone com o atalho e o botao.'

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
}

async function main() {
  synth()
  padWav(raw, wav, 0.6, 1.5)

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
  await page.waitForTimeout(1000)

  const input = page.locator('textarea[aria-label="Mensagem"]')
  await input.click()
  await input.fill('Antes:')

  const mic = page.locator('.mic-btn')
  await mic.click()
  await page.waitForSelector('.mic-btn.state-listening', { timeout: 30000 })
  console.log('mic listening')

  // The overlay is a separate BrowserWindow with a data: URL.
  let overlay = null
  for (let i = 0; i < 20 && !overlay; i++) {
    overlay = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('data:text/html'))
    if (!overlay) await new Promise((r) => setTimeout(r, 300))
  }
  console.log('overlay page', Boolean(overlay), overlay ? overlay.url().slice(0, 60) : 'none')
  if (overlay) {
    await overlay.waitForFunction(() => Boolean(window.forjaOverlay), { timeout: 5000 }).catch(() => undefined)
    console.log('overlay status', JSON.stringify(await overlay.evaluate(() => ({
      cls: document.body.className,
      status: document.getElementById('status')?.textContent,
      text: document.getElementById('text')?.textContent
    }))))
  }

  await page.waitForTimeout(6500)
  await mic.click()
  await page.waitForSelector('.mic-btn.state-idle', { timeout: 15000 })
  await page.waitForTimeout(800)
  console.log('composer', JSON.stringify(await input.inputValue()))
  if (overlay) {
    console.log('overlay after', JSON.stringify(await overlay.evaluate(() => ({
      cls: document.body.className,
      status: document.getElementById('status')?.textContent,
      text: document.getElementById('text')?.textContent
    }))))
  }
  console.log('errors', errors)
  await page.screenshot({ path: path.join(work, 'main.png') })
  if (overlay) await overlay.screenshot({ path: path.join(work, 'overlay.png') })
  console.log('screenshots', work)
  await browser.close()
  cleanup()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
