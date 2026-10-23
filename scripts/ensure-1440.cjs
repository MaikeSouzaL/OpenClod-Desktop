const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const max = await page.evaluate(() => window.forja.window.isMaximized())
  if (max) {
    await page.evaluate(() => window.forja.window.maximize())
    await page.waitForTimeout(700)
  }
  await page.evaluate(() => window.resizeTo(1440, 900))
  await page.waitForTimeout(900)
  console.log(await page.evaluate(() => `${window.innerWidth}x${window.innerHeight} / ${window.outerWidth}x${window.outerHeight}`))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
