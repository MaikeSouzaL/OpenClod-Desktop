const { chromium } = require('playwright-core')

const OUT = 'C:/Users/Administrator/AppData/Local/Temp/opencode'
const step = async (name, fn) => {
  try {
    await fn()
    console.log('ok   ' + name)
  } catch (err) {
    console.log('FAIL ' + name + ': ' + err.message.split('\n')[0])
  }
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0].pages()[0]
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

  await page.waitForTimeout(300)

  await step('open session', async () => {
    const session = page.locator('.side-session').first()
    await session.click()
    await page.waitForTimeout(700)
  })

  await step('menu open', async () => {
    await page.locator('.titlebar button[aria-label="Menu"]').click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${OUT}/shot-menu.png` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  })

  for (const [label, file] of [
    ['Terminal', 'shot-tab-terminal'],
    ['Alterações', 'shot-tab-changes'],
    ['Navegador', 'shot-tab-browser'],
    ['Arquivos', 'shot-tab-files'],
    ['Painel lateral da sessão', 'shot-tab-context']
  ]) {
    await step('panel ' + label, async () => {
      await page.locator(`.titlebar button[aria-label="${label}"]`).click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${OUT}/${file}.png` })
    })
  }

  await step('capture screen', async () => {
    await page.locator('.titlebar button[aria-label="Navegador"]').click()
    await page.waitForTimeout(300)
    const capture = page.locator('.screens-pane button', { hasText: 'Capturar' })
    if (await capture.count()) {
      await capture.click()
      await page.waitForTimeout(2500)
      await page.screenshot({ path: `${OUT}/shot-capture.png` })
    }
  })

  await step('open settings', async () => {
    await page.keyboard.press('Control+,')
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/shot-settings.png` })
  })

  await step('appearance tab', async () => {
    await page.locator('.modal-tabs button', { hasText: 'Aparência' }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT}/shot-appearance.png` })
  })

  await step('light theme', async () => {
    await page.locator('.theme-card', { hasText: 'Claro' }).click()
    await page.locator('.modal-foot button', { hasText: 'Salvar alterações' }).click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${OUT}/shot-light.png` })
  })

  await step('back to dark', async () => {
    await page.keyboard.press('Control+,')
    await page.waitForTimeout(400)
    await page.locator('.modal-tabs button', { hasText: 'Aparência' }).click()
    await page.waitForTimeout(200)
    await page.locator('.theme-card', { hasText: 'Escuro' }).click()
    await page.locator('.modal-foot button', { hasText: 'Salvar alterações' }).click()
    await page.waitForTimeout(600)
  })

  const state = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    panel: document.querySelector('.panel-head h2')?.textContent ?? null,
    counts: {
      messages: document.querySelectorAll('.message').length,
      tools: document.querySelectorAll('.tool-card').length,
      sessions: document.querySelectorAll('.side-session').length,
      cards: document.querySelectorAll('.panel-card').length
    }
  }))
  console.log(JSON.stringify({ state, errors }, null, 2))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
