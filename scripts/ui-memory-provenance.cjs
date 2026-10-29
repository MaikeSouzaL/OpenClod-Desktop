// Visual check for provenance, conflict and invalidation metadata in project memory.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'Prints', 'memory-provenance-2026-10-25')
const PORT = 9353
fs.mkdirSync(OUT, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-memory-ui-'))
const profile = path.join(temp, 'profile')
const project = path.join(temp, 'project')
fs.mkdirSync(project, { recursive: true })
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

function memoryPage(title, body, fields) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `tags: ${fields.tags.join(', ')}`,
    'pinned: false',
    'created: 2026-10-25T12:00:00.000Z',
    'updated: 2026-10-25T12:00:00.000Z',
    'source: agent',
    `memory_type: ${fields.type}`,
    `confidence: ${fields.confidence || 'observed'}`,
    `status: ${fields.status || 'active'}`,
    `evidence: ${JSON.stringify(fields.evidence || [])}`,
    `context: ${JSON.stringify(fields.context || '')}`,
    `conflicts_with: ${JSON.stringify(fields.conflicts || [])}`,
    ...(fields.supersededBy ? [`superseded_by: ${fields.supersededBy}`] : []),
    '---',
    '',
    body,
    ''
  ].join('\n')
}

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

  const added = await page.evaluate((folder) => window.openclod.projects.add(folder, 'Memória avançada E2E'), project)
  if (!added.ok) throw new Error(added.error)
  const wiki = path.join(profile, 'data', 'memory', 'projects', added.value.id, 'wiki')
  fs.mkdirSync(wiki, { recursive: true })
  fs.writeFileSync(path.join(wiki, 'deploy-docker.md'), memoryPage('Deploy Docker', 'O deploy usa Docker Compose.', {
    tags: ['deploy'], type: 'decision', evidence: ['tests/deploy.test.ts'], context: 'validado localmente'
  }))
  fs.writeFileSync(path.join(wiki, 'deploy-node.md'), memoryPage('Deploy Node', 'O deploy usa um processo Node.', {
    tags: ['deploy'], type: 'decision', confidence: 'inferred', conflicts: ['deploy-docker']
  }))
  fs.writeFileSync(path.join(wiki, 'deploy-antigo.md'), memoryPage('Deploy antigo', 'Arquivo JSON como armazenamento.', {
    tags: ['deploy'], type: 'decision', status: 'superseded', supersededBy: 'deploy-docker'
  }))

  await page.reload()
  await page.waitForSelector('.app-shell')
  const projectRow = page.locator('.side-project-name', { hasText: 'Memória avançada E2E' }).first()
  if (await projectRow.count()) await projectRow.click()
  await page.keyboard.press('Control+,')
  await page.waitForSelector('.settings-sheet')
  await page.locator('.settings-nav button', { hasText: 'Memória' }).click()
  await page.waitForSelector('.memory-row', { timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('.memory-badge').length >= 4, null, { timeout: 30_000 })
  await page.screenshot({ path: path.join(OUT, '01-memory-provenance.png'), fullPage: true })

  const result = await page.evaluate(() => ({
    rows: document.querySelectorAll('.memory-row').length,
    types: [...document.querySelectorAll('.memory-badge.type-decision')].map((node) => node.textContent),
    conflicts: [...document.querySelectorAll('.memory-badge.conflict')].map((node) => node.textContent),
    superseded: [...document.querySelectorAll('.memory-badge.status-superseded')].map((node) => node.textContent),
    summary: document.querySelector('.field-note')?.textContent?.replace(/\s+/g, ' ').trim(),
    bridge: typeof window.openclod.memory.invalidate
  }))
  if (result.rows < 3 || !result.types.length || !result.conflicts.length || !result.superseded.length) {
    throw new Error(`memory UI incomplete: ${JSON.stringify(result)}`)
  }
  if (errors.length) throw new Error(`renderer errors: ${errors.join(' | ')}`)
  const evidence = { ok: true, ...result, screenshot: path.join(OUT, '01-memory-provenance.png'), errors }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
  .finally(cleanup)
