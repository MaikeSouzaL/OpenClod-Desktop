const { chromium } = require('playwright-core')
const fs = require('node:fs')
const path = require('node:path')

const OUT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode'

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.clearDeviceMetricsOverride')
  await page.reload()
  await page.waitForTimeout(1400)
  console.log('real', await page.evaluate(() => `${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}`))
  fs.writeFileSync(path.join(OUT, 'real-1920.png'), await page.screenshot())
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
