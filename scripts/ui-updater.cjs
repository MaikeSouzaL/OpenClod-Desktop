// Visual and contract check for update discovery from a local HTTPS-contract-compatible HTTP loopback feed.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'Prints', 'updater-2026-10-25')
const PORT = 9367
fs.mkdirSync(OUT, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-updater-ui-'))
const profile = path.join(temp, 'profile')

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      version: '9.9.9',
      notes: 'Atualização de teste',
      publishedAt: '2026-10-25T12:00:00Z',
      platforms: { win32: { url: 'http://127.0.0.1:1/Openclod.exe', sha256: 'a'.repeat(64), size: 12345 } }
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const feed = `http://127.0.0.1:${server.address().port}/latest.json`
  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    env: { ...process.env, OPENCLOD_UPDATE_MANIFEST_URL: feed },
    stdio: 'ignore',
    windowsHide: false
  })
  let browser = null
  const cleanup = () => {
    try { browser?.close() } catch {}
    try { server.close() } catch {}
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }) } catch {}
  }
  process.on('exit', cleanup)
  const errors = []
  for (let attempt = 0; attempt < 50 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`) } catch { await new Promise((resolve) => setTimeout(resolve, 500)) }
  }
  if (!browser) throw new Error('Electron did not open the debugging port')
  let page = null
  for (let attempt = 0; attempt < 240 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!page) throw new Error('renderer page was not found')
  page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`))
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.app-shell', { timeout: 30_000 })
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav button', { hasText: 'Sobre' }).click()
  const feedInput = page.getByPlaceholder('https://exemplo.com/openclod/latest.json')
  await feedInput.fill(feed)
  await page.getByRole('button', { name: 'Verificar atualizações' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Versão 9.9.9'), null, { timeout: 30_000 })
  await page.screenshot({ path: path.join(OUT, '01-updater.png'), fullPage: true })
  const result = await page.evaluate(() => ({
    hasVersion: document.body.innerText.includes('Versão 9.9.9'),
    hasChecksum: document.body.innerText.includes('SHA-256'),
    downloadButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Baixar e verificar')),
    bridge: typeof window.openclod.app.checkForUpdates
  }))
  if (!result.hasVersion || !result.hasChecksum || !result.downloadButton || result.bridge !== 'function') throw new Error(`updater UI incomplete: ${JSON.stringify(result)}`)
  if (errors.length) throw new Error(`renderer errors: ${errors.join(' | ')}`)
  const evidence = { ok: true, feed, ...result, screenshot: path.join(OUT, '01-updater.png'), errors }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  cleanup()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
