// Visual contract check for notification preferences in the real renderer.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'Prints', 'notifications-2026-10-25')
const PORT = 9363
fs.mkdirSync(OUT, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-notifications-ui-'))
const profile = path.join(temp, 'profile')
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { cwd: ROOT, stdio: 'ignore', windowsHide: false })
let browser = null
const cleanup = () => {
  try { browser?.close() } catch {}
  try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }) } catch {}
}
process.on('exit', cleanup)

async function main() {
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
  await page.locator('.settings-nav button', { hasText: 'Aparência' }).click()
  await page.getByRole('heading', { name: 'Notificações' }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, '01-notification-settings.png'), fullPage: true })
  const result = await page.evaluate(() => ({
    checkboxes: [...document.querySelectorAll('.modal-body .check-line')].filter((node) => /notificações|Tarefas concluídas|Falhas e erros|Aprovações/.test(node.textContent || '')).length,
    timeInputs: document.querySelectorAll('input[type="time"]').length,
    priority: [...document.querySelectorAll('select option')].some((node) => node.textContent === 'Somente erros'),
    heading: [...document.querySelectorAll('h3')].some((node) => node.textContent === 'Notificações')
  }))
  if (result.checkboxes < 4 || result.timeInputs !== 2 || !result.priority || !result.heading) throw new Error(`notification UI incomplete: ${JSON.stringify(result)}`)
  if (errors.length) throw new Error(`renderer errors: ${errors.join(' | ')}`)
  const evidence = { ok: true, ...result, screenshot: path.join(OUT, '01-notification-settings.png'), errors }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
}).finally(cleanup)
