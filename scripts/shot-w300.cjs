const { chromium } = require('playwright-core')
const fs = require('node:fs')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 892, deviceScaleFactor: 1, mobile: false })
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'weight-test'
    style.textContent = `.thread, .composer textarea, .side-nav-row, .side-project-name, .panel-body, .composer-meta { font-weight: 300 !important; }`
    document.head.appendChild(style)
  })
  await page.waitForTimeout(400)
  fs.writeFileSync('C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode\\v3-w300.png', await page.screenshot({ scale: 'css' }))
  await page.evaluate(() => document.getElementById('weight-test')?.remove())
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
