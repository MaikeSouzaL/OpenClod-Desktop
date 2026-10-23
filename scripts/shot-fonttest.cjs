const { chromium } = require('playwright-core')
const fs = require('node:fs')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 892, deviceScaleFactor: 1, mobile: false })
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'font-test'
    style.textContent = `
      .thread .message.assistant .markdown { font-family: Arial, sans-serif !important; }
      .thread .message.assistant .markdown p { font-size: 14px !important; }
    `
    document.head.appendChild(style)
  })
  await page.waitForTimeout(400)
  fs.writeFileSync('C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode\\v3-arial.png', await page.screenshot({ scale: 'css' }))
  await page.evaluate(() => {
    const s = document.getElementById('font-test')
    if (s) s.textContent = `.thread .message.assistant .markdown { font-variation-settings: 'wght' 300 !important; font-weight: 300 !important; }`
  })
  await page.waitForTimeout(300)
  fs.writeFileSync('C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode\\v3-var300.png', await page.screenshot({ scale: 'css' }))
  console.log(await page.evaluate(() => getComputedStyle(document.querySelector('.message.assistant .markdown p')).fontVariationSettings))
  await page.evaluate(() => document.getElementById('font-test')?.remove())
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
