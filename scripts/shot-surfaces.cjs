const { chromium } = require('playwright-core')
const fs = require('node:fs')
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

  const maximized = await page.evaluate(() => window.openclod.window.isMaximized())
  if (maximized) {
    await page.evaluate(() => window.openclod.window.maximize())
    await page.waitForTimeout(600)
  }
  await page.evaluate(() => window.resizeTo(1440, 900))
  await page.waitForTimeout(700)
  console.log('layout', await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`))

  const shot = async (name) => {
    fs.writeFileSync(path.join(OUT, name), await page.screenshot())
  }

  await page.locator('.mode-switch button', { hasText: 'Início' }).click()
  await page.waitForTimeout(500)
  await shot('s-chat.png')

  await page.locator('.mode-switch button', { hasText: 'Cowork' }).click()
  await page.waitForTimeout(500)
  await shot('s-cowork.png')

  await page.locator('.mode-switch button', { hasText: 'Code' }).click()
  await page.waitForTimeout(500)
  await shot('s-code.png')

  // expand project + open a session
  const project = page.locator('.side-project-name').first()
  if (await project.count()) {
    await project.click()
    await page.waitForTimeout(900)
  }
  await shot('s-code-session.png')

  // right panel
  const panelBtn = page.locator('.tb-actions button[aria-label="Painel lateral da sessão"]')
  if (await panelBtn.count()) {
    await panelBtn.click()
    await page.waitForTimeout(600)
    await shot('s-panel.png')
  }

  // plus menu
  const plus = page.locator('.composer .composer-attach .round-btn')
  if (await plus.count()) {
    await plus.click()
    await page.waitForTimeout(400)
    await shot('s-plusmenu.png')
    await page.keyboard.press('Escape')
  }

  console.log(errors.length ? errors.join('\n') : 'no console errors')
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
