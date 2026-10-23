const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  await page.setViewportSize({ width: 1424, height: 892 })
  console.log(
    await page.evaluate(async () => {
      await document.fonts.ready
      const info = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        return {
          sel,
          fontFamily: cs.fontFamily,
          weight: cs.fontWeight,
          size: cs.fontSize,
          lineHeight: cs.lineHeight,
          color: cs.color,
          text: (el.textContent || '').slice(0, 40)
        }
      }
      return {
        loaded: [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`),
        checks: [
          info('body'),
          info('.message.assistant .markdown p'),
          info('.composer textarea'),
          info('.side-project-name'),
          info('.panel-card-head'),
          info('.ctx-label'),
          info('.thread')
        ]
      }
    })
  )
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
