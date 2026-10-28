// End-to-end check for the visual slide editor and standalone HTML export.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'Prints', 'slides-2026-10-25')
const PORT = 9343
fs.mkdirSync(OUT, { recursive: true })

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-slides-e2e-'))
const profile = path.join(temp, 'profile')
const project = path.join(temp, 'slides-project')
fs.mkdirSync(project, { recursive: true })
const slidePath = path.join(project, 'demo.openclod-slides.json')
fs.writeFileSync(slidePath, JSON.stringify({
  version: 1,
  title: 'Demonstração',
  slides: [
    {
      id: 'slide-1', title: 'Openclod', body: 'Editor visual de artefatos', accent: '#e1a95f', background: '#151920',
      x: 70, y: 90, width: 650, height: 300
    },
    {
      id: 'slide-2', title: 'Segundo slide', body: 'Duplicação e apresentação', accent: '#6ba3d8', background: '#1c1d24',
      x: 120, y: 120, width: 560, height: 260
    }
  ]
}, null, 2))

const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: ROOT,
  stdio: 'ignore',
  windowsHide: false
})
const cleanup = () => {
  try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }) } catch {}
}
process.on('exit', cleanup)

async function main() {
  let browser
  for (let attempt = 0; attempt < 50 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`) } catch { await new Promise((resolve) => setTimeout(resolve, 500)) }
  }
  if (!browser) throw new Error('Electron did not open the debugging port')
  let page
  for (let attempt = 0; attempt < 240 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!page) throw new Error('renderer page was not found')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.app-shell', { timeout: 30_000 })
  const added = await page.evaluate((folder) => window.forja.projects.add(folder, 'Projeto de slides E2E'), project)
  if (!added.ok) throw new Error(added.error)
  await page.reload()
  await page.waitForSelector('.app-shell', { timeout: 30_000 })
  await page.locator('nav.side-nav .side-row', { hasText: 'Artefatos' }).click()
  await page.locator('.artifact-file-card', { hasText: 'demo.openclod-slides.json' }).click()
  await page.waitForSelector('.slide-studio')
  await page.screenshot({ path: path.join(OUT, '01-slide-editor.png'), fullPage: true })

  await page.locator('.slide-stage-head button', { hasText: 'Apresentar' }).click()
  await page.waitForSelector('.slide-presentation')
  await page.screenshot({ path: path.join(OUT, '02-presentation.png'), fullPage: true })
  await page.locator('.slide-presentation-nav button', { hasText: 'Fechar' }).click()

  await page.locator('input[aria-label="Título da apresentação"]').fill('Apresentação E2E')
  await page.locator('.artifact-studio-actions button', { hasText: 'Exportar HTML' }).click()
  await page.waitForSelector('.artifact-success')
  const htmlPath = path.join(project, 'demo.slides.html')
  if (!fs.existsSync(htmlPath)) throw new Error('the HTML export was not written')
  const html = fs.readFileSync(htmlPath, 'utf8')
  if (!html.includes('Apresentação E2E') || !html.includes('Editor visual de artefatos')) {
    throw new Error('exported HTML does not contain the edited presentation')
  }
  await page.screenshot({ path: path.join(OUT, '03-exported.png'), fullPage: true })
  const evidence = { ok: true, slidePath, htmlPath, htmlBytes: Buffer.byteLength(html) }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
  .finally(cleanup)
