// Opens the packaged app in a throwaway profile and verifies the renderer starts.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const executable = path.join(ROOT, 'release', 'win-unpacked', 'Openclod Desktop.exe')
const OUT = process.argv[2] || path.join(ROOT, 'Prints', 'packaged-smoke-2026-10-25.png')
const PORT = 9345
if (!fs.existsSync(executable)) throw new Error(`packaged executable not found: ${executable}`)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-packaged-profile-'))
const child = spawn(executable, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: path.dirname(executable),
  stdio: 'ignore',
  windowsHide: true
})

const cleanup = () => {
  try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }) } catch {}
}
process.on('exit', cleanup)

async function main() {
  let browser
  for (let attempt = 0; attempt < 50 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`) } catch { await new Promise((resolve) => setTimeout(resolve, 500)) }
  }
  if (!browser) throw new Error('packaged app did not open the debugging port')
  let page
  for (let attempt = 0; attempt < 240 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!page) throw new Error('packaged renderer page was not found')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.app-shell', { timeout: 30_000 })
  await page.screenshot({ path: OUT, fullPage: true })
  const evidence = { ok: true, title: await page.title(), url: page.url(), screenshot: OUT, executable }
  fs.writeFileSync(path.join(path.dirname(OUT), 'packaged-smoke-2026-10-25.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
  .finally(cleanup)
