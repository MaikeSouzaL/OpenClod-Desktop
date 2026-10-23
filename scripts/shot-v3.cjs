const { chromium } = require('playwright-core')
const path = require('node:path')

const OUT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode'

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1424,
    height: 892,
    deviceScaleFactor: 1,
    mobile: false
  })
  await page.waitForTimeout(600)
  console.log(await page.evaluate(() => `${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}`))
  const shot = await page.screenshot({ scale: 'css' })
  require('node:fs').writeFileSync(path.join(OUT, 'v3-test.png'), shot)
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
