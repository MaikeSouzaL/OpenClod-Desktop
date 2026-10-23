const { chromium } = require('playwright-core')
const fs = require('node:fs')
const path = require('node:path')

const OUT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode'

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const contexts = browser.contexts()
  const page = contexts[0].pages()[0]
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[${msg.type()}]`, msg.text())
  })
  page.on('pageerror', (err) => console.log('[pageerror]', err.message))

  await page.waitForTimeout(900)
  console.log('viewport', await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`))
  await page.screenshot({ path: path.join(OUT, 'now-home.png') })

  // Chat: open the most recent session from the sidebar.
  const rows = page.locator('.side-session')
  const count = await rows.count()
  console.log('sessions', count)
  if (count) {
    await rows.first().click()
    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(OUT, 'now-chat.png') })
  }

  // Panel
  const panelBtn = page.locator('.tb-actions button[aria-label="Painel lateral da sessão"]')
  if (await panelBtn.count()) {
    await panelBtn.click()
    await page.waitForTimeout(900)
    await page.screenshot({ path: path.join(OUT, 'now-panel.png') })
  }

  // Code mode
  await page.locator('.mode-switch button', { hasText: 'Code' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, 'now-code.png') })

  // Settings
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(OUT, 'now-settings.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // Slash menu
  await page.locator('.mode-switch button', { hasText: 'Início' }).click()
  await page.waitForTimeout(500)
  const textarea = page.locator('.composer textarea')
  await textarea.click()
  await textarea.type('/')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'now-slash.png') })

  // Menu
  await page.keyboard.press('Escape')
  await page.locator('.titlebar button[aria-label="Menu"]').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'now-menu.png') })

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
