// Visual and contract check for Settings -> Backup in the real Electron renderer.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'Prints', 'backup-2026-10-25')
const PORT = 9349
fs.mkdirSync(OUT, { recursive: true })

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-backup-ui-'))
const profile = path.join(temp, 'profile')
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: ROOT,
  stdio: 'ignore',
  windowsHide: false
})

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
  const api = await page.evaluate(() => ({
    export: typeof window.openclod.app.backupExport,
    inspect: typeof window.openclod.app.backupInspect,
    restore: typeof window.openclod.app.backupRestore,
    exportConfiguration: typeof window.openclod.app.exportConfiguration,
    importConfiguration: typeof window.openclod.app.importConfiguration
  }))
  if (Object.values(api).some((kind) => kind !== 'function')) throw new Error(`backup bridge incomplete: ${JSON.stringify(api)}`)

  await page.keyboard.press('Control+,')
  await page.waitForSelector('.settings-sheet')
  await page.locator('.settings-nav button', { hasText: 'Backup' }).click()
  await page.waitForSelector('.backup-center')
  const labels = await page.locator('.backup-actions button').allTextContents()
  for (const expected of ['Criar backup', 'Inspecionar', 'Restaurar', 'Exportar configuração', 'Importar configuração']) {
    if (!labels.some((label) => label.includes(expected))) throw new Error(`missing backup action: ${expected}`)
  }
  const hero = await page.locator('.backup-hero').innerText()
  if (!hero.includes('checksum SHA-256')) throw new Error('backup UI did not render its integrity explanation')
  await page.screenshot({ path: path.join(OUT, '01-settings-backup.png'), fullPage: true })

  const evidence = {
    ok: true,
    api,
    actions: labels.map((label) => label.replace(/\s+/g, ' ').trim()),
    screenshot: path.join(OUT, '01-settings-backup.png'),
    errors
  }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
  if (errors.length) throw new Error(`renderer errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify(evidence, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
  .finally(cleanup)
