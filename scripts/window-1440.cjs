const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const client = await page.context().newCDPSession(page)
  const { windowId } = await client.send('Browser.getWindowForTarget')
  await client.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal' }
  })
  await client.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 30, top: 20, width: 1440, height: 900, windowState: 'normal' }
  })
  await page.waitForTimeout(900)
  console.log(await page.evaluate(() => `${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}`))
  const { writeFileSync } = require('node:fs')
  writeFileSync(
    'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode\\native-1440.png',
    await page.screenshot()
  )
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
