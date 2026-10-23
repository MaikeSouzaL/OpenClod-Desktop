const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const data = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        sel,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display,
        margin: cs.margin,
        padding: cs.padding,
        flex: cs.flex,
        background: cs.backgroundColor,
        color: cs.color,
        fontSize: cs.fontSize,
        className: el.className
      }
    }
    return [
      pick('.titlebar'),
      pick('.tb-left'),
      pick('.tb-main'),
      pick('.tb-actions'),
      pick('.tb-window'),
      pick('.sidebar'),
      pick('.workspace'),
      pick('.panel'),
      pick('.mode-switch'),
      ...[...document.querySelectorAll('.mode-switch button')].map((el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          sel: 'mode-btn',
          text: el.textContent,
          active: el.className,
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          background: cs.backgroundColor,
          color: cs.color
        }
      }),
      pick('.composer'),
      pick('.thread')
    ]
  })
  console.log(JSON.stringify(data, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
