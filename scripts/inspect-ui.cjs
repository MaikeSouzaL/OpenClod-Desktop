const { chromium } = require('playwright-core')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const context = browser.contexts()[0]
  const page = context.pages()[0]
  await page.waitForTimeout(400)

  const info = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display,
        width: cs.width,
        maxWidth: cs.maxWidth,
        flexDirection: cs.flexDirection,
        alignItems: cs.alignItems,
        fontSize: cs.fontSize,
        padding: cs.padding,
        background: cs.backgroundColor
      }
    }
    const ta = document.querySelector('.composer textarea')
    return {
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      homeCenter: pick('.home-center'),
      homeComposer: pick('.home-composer'),
      dock: pick('.composer-dock'),
      composer: pick('.composer'),
      textarea: pick('.composer textarea'),
      meta: pick('.composer-meta'),
      banner: pick('.home-banner'),
      sidebar: pick('.sidebar'),
      appBody: pick('.app-body'),
      workspace: pick('.workspace'),
      textareaValue: ta ? ta.value : null,
      placeholder: ta ? ta.placeholder : null,
      active: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await page.screenshot({ path: 'C:/Users/Administrator/AppData/Local/Temp/opencode/openclod-cdp.png' })
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
