const { chromium } = require('playwright-core')
const path = require('node:path')

const OUT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode'

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`))

  await page.setViewportSize({ width: 1424, height: 892 })
  await page.waitForTimeout(700)
  console.log('layout', await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`))

  // Start from home
  await page.locator('.mode-switch button', { hasText: 'Início' }).click().catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'v2-home.png') })

  // Code tab + chat
  await page.locator('.mode-switch button', { hasText: 'Code' }).click()
  await page.waitForTimeout(500)
  const rows = page.locator('.side-session')
  console.log('code sessions', await rows.count())
  if (await rows.count()) {
    await rows.first().click()
    await page.waitForTimeout(1000)
  }
  await page.screenshot({ path: path.join(OUT, 'v2-code.png') })

  // Panel
  const panelBtn = page.locator('.tb-actions button[aria-label="Painel lateral da sessão"]')
  if (await panelBtn.count()) {
    await panelBtn.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(OUT, 'v2-panel.png') })
  }

  // Settings
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, 'v2-settings.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Slash
  await page.locator('.composer textarea').click()
  await page.locator('.composer textarea').type('/')
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'v2-slash.png') })
  await page.keyboard.press('Escape')

  // Menu
  await page.locator('.titlebar button[aria-label="Menu"]').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'v2-menu.png') })

  console.log(errors.length ? errors.join('\n') : 'no console errors')
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
