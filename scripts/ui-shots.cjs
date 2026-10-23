const { chromium } = require('playwright-core')

const OUT = 'C:/Users/Administrator/AppData/Local/Temp/opencode'

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/shot-home.png` })

  const session = page.locator('.side-session').first()
  if (await session.count()) {
    await session.click()
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/shot-chat.png` })

    const panel = page.locator('[aria-label="Painel lateral da sessão"]')
    if (await panel.count()) {
      await panel.click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${OUT}/shot-panel.png` })
      await panel.click()
    }
  }

  await page.keyboard.press('Control+,')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/shot-settings.png` })

  const appearance = page.locator('.modal-tabs button', { hasText: 'Aparência' })
  if (await appearance.count()) {
    await appearance.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT}/shot-appearance.png` })
  }

  const html = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    counts: {
      messages: document.querySelectorAll('.message').length,
      tools: document.querySelectorAll('.tool-card').length,
      sessions: document.querySelectorAll('.side-session').length
    }
  }))
  console.log(JSON.stringify({ html, errors }, null, 2))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
