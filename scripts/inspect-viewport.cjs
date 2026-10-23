const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  console.log(
    await page.evaluate(() => ({
      inner: [window.innerWidth, window.innerHeight],
      outer: [window.outerWidth, window.outerHeight],
      dpr: window.devicePixelRatio,
      docClient: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      body: [document.body.clientWidth, document.body.scrollWidth],
      shell: (() => {
        const r = document.querySelector('.app-shell').getBoundingClientRect()
        return [r.width, r.height]
      })(),
      zoom: getComputedStyle(document.documentElement).zoom,
      visual: window.visualViewport ? [window.visualViewport.width, window.visualViewport.scale] : null
    }))
  )
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
