// Os logos na tela Personalização → Conectores, no Electron real, com perfil descartável (nada é lido nem gravado no
// perfil do usuário). Reproduz a seção "Conectados" do usuário: servidores com os mesmos nomes (whatsapp, mercadopago,
// appwrite-*, rea, bridge_gpt, affinitas, figcraft, atlassian, jira), todos apontando para um servidor MCP falso local.
//
//   node scripts/ui-connector-icons.cjs [--root <pasta do app>] [--out <pasta>] [--prefix antes-] [--sem-checagens]
//
// `--root` aponta para uma cópia congelada do app (scripts/snapshot-app.cjs), o que permite capturar o "antes" (build
// antigo, sem logos: use --sem-checagens) e o "depois" no mesmo cenário.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'conectores-2026-10-27', 'depois'))
const prefixAt = process.argv.indexOf('--prefix')
const PREFIX = prefixAt > 0 ? process.argv[prefixAt + 1] : ''
const CHECKS = !process.argv.includes('--sem-checagens')
const PORT = 9372
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Os conectores do usuário: o que tem marca óbvia e o que não tem. */
const WITH_LOGO = ['whatsapp', 'mercadopago', 'appwrite-api', 'appwrite-docs', 'appwrite-cli-mcp', 'atlassian', 'jira']
const WITHOUT_LOGO = ['rea', 'bridge_gpt', 'affinitas', 'figcraft']

const STDIO_SERVER = `
let buffer = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'falso', version: '1.0.0' } } })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ver_hora', description: 'Devolve a hora do servidor fictício.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] } })
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`

async function main() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-connector-icons-' })
  const stdioScript = path.join(ws.work, 'stdio-falso.cjs')
  fs.writeFileSync(stdioScript, STDIO_SERVER)
  fs.writeFileSync(
    path.join(ws.profile, 'config', 'settings.json'),
    JSON.stringify(
      {
        importClaudeSettings: false,
        claudeCatalogImported: true,
        selfRepair: { enabled: false },
        mcpServers: [...WITH_LOGO, ...WITHOUT_LOGO].map((name) => ({ name, command: process.execPath, args: [stdioScript], enabled: true }))
      },
      null,
      2
    )
  )
  const app = await e2e.launch({ port: PORT, ...ws, viewport: { width: 1440, height: 1000 } })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const result = { checks, shots: [], errors: [], ok: false }
  const imageRequests = []
  page.on('request', (request) => request.resourceType() === 'image' && imageRequests.push(request.url()))
  const shot = async (name) => {
    await page.waitForTimeout(350)
    const file = path.join(OUT, `${PREFIX}${name}`)
    await page.screenshot({ path: file })
    result.shots.push(file)
  }
  const api = (fn, ...args) => page.evaluate(async ({ fn, args }) => (await window.openclod.app[fn](...args)), { fn, args })
  const waitFor = async (label, probe, timeoutMs = 40000) => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error(`tempo esgotado esperando: ${label}`)
      await sleep(250)
    }
  }
  /** Rola o cartão até a tela e espera a imagem terminar de carregar: `naturalWidth` ou o motivo da falha. */
  const logoState = (selector) =>
    page.evaluate(async (css) => {
      const root = document.querySelector(css)
      if (!root) return 'sem-elemento'
      const img = root.querySelector('.cnx-logo img')
      if (!img) return root.querySelector('[data-logo="initials"]') ? 'iniciais' : 'sem-avatar'
      img.scrollIntoView({ block: 'center' })
      const done = await new Promise((resolve) => {
        if (img.complete) return resolve(true)
        img.addEventListener('load', () => resolve(true), { once: true })
        img.addEventListener('error', () => resolve(false), { once: true })
        setTimeout(() => resolve(false), 6000)
      })
      return done && img.naturalWidth > 0 ? `imagem ${img.naturalWidth}x${img.naturalHeight}` : `falhou (${img.naturalWidth})`
    }, selector)

  try {
    await waitFor('conectores locais conectados', async () => {
      const states = (await api('connectorStates')).value
      return [...WITH_LOGO, ...WITHOUT_LOGO].every((name) => states.find((state) => state.id === name)?.status === 'connected')
    })
    await page.locator('nav.side-nav .side-row', { hasText: 'Personalização' }).click()
    await page.getByRole('tab', { name: /Conectores/ }).click()
    await page.waitForSelector('[data-testid="connectors-panel"]')
    await page.waitForSelector('.cnx-card[data-connector-id]')
    await page.waitForSelector('[data-testid="connectors-installed"] .cnx-card')
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))
    await shot('01-grade.png')
    await page.locator('#cnx-installed-title').scrollIntoViewIfNeeded()
    await page.locator('.page').evaluate((el) => el.scrollBy(0, -20))
    await shot('02-conectados.png')
    // A grade do diretório (os cartões populares primeiro), com o título da seção no topo.
    await page.evaluate(() => document.getElementById('cnx-directory-title')?.scrollIntoView({ block: 'start' }))
    await page.locator('.page').evaluate((el) => el.scrollBy(0, -14))
    await shot('07-diretorio.png')

    if (CHECKS) {
      // ---------------------------------------------------------------- marcas óbvias têm logo; as outras, iniciais
      for (const name of WITH_LOGO) {
        const state = await logoState(`[data-testid="connectors-installed"] .cnx-card[data-connector-id="${name}"]`)
        check(`conectados-${name}-mostra-o-logo`, /^imagem \d+x\d+$/.test(state), state)
      }
      for (const name of WITHOUT_LOGO) {
        const state = await logoState(`[data-testid="connectors-installed"] .cnx-card[data-connector-id="${name}"]`)
        check(`conectados-${name}-mostra-as-iniciais`, state === 'iniciais', state)
      }
      const rea = await page.locator('[data-testid="connectors-installed"] .cnx-card[data-connector-id="rea"] [data-logo]').textContent()
      check('iniciais-de-um-nome-so-sao-a-primeira-letra', rea?.trim() === 'R', rea)
      const hues = await page.evaluate(() => {
        const mono = (name) => getComputedStyle(document.querySelector(`.cnx-card[data-connector-id="${name}"] .cnx-mono`)).getPropertyValue('--h')
        return { antes: ['affinitas', 'figcraft', 'rea'].map(mono) }
      })
      check('iniciais-continuam-coloridas-por-nome', hues.antes.every((value) => value.trim() !== ''), hues)

      // ---------------------------------------------------------------- tamanho fixo e acabamento
      const box = await page.locator('[data-testid="connectors-installed"] .cnx-card[data-connector-id="whatsapp"] .cnx-logo').evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return { width: rect.width, height: rect.height, radius: style.borderTopLeftRadius, overflow: style.overflow }
      })
      check('logo-do-cartao-tem-40px-quadrado-e-cantos-arredondados', box.width === 40 && box.height === 40 && box.radius === '12px' && box.overflow === 'hidden', box)

      // ---------------------------------------------------------------- diretório: amostra de cartões populares
      const sample = ['github', 'notion', 'linear', 'google-drive', 'gmail', 'figma-remote', 'asana-remote', 'sentry', 'stripe-remote', 'vercel', 'supabase-remote', 'canva', 'hubspot', 'intercom', 'zapier', 'context7']
      const loaded = {}
      for (const id of sample) loaded[id] = await logoState(`[data-testid="connectors-directory"] .cnx-card[data-connector-id="${id}"]`)
      check('diretorio-amostra-de-16-logos-carrega-com-naturalWidth-maior-que-0', Object.values(loaded).every((state) => /^imagem \d+x\d+$/.test(state)), loaded)
      const first = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-testid="connectors-directory"] .cnx-card')]
        return { cartoes: cards.length, comLogo: cards.filter((card) => card.querySelector('.cnx-logo img')).length }
      })
      check('primeira-pagina-do-diretorio-quase-toda-com-logo', first.cartoes === 60 && first.comLogo >= 57, first)

      // ---------------------------------------------------------------- nada sai da máquina
      const outside = imageRequests.filter((url) => !/^(file:|data:|blob:)/i.test(url))
      check('nenhuma-imagem-vem-da-internet', outside.length === 0 && imageRequests.some((url) => url.includes('connector-icons/')), { fora: outside.slice(0, 5), total: imageRequests.length })
    }

    // ---------------------------------------------------------------- detalhes
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))
    await page.locator('[data-testid="connectors-installed"] .cnx-card[data-connector-id="whatsapp"] .cnx-card-title').click()
    await page.waitForSelector('[data-connector-detail="whatsapp"]')
    if (CHECKS) {
      const drawer = await logoState('[data-connector-detail="whatsapp"] .cnx-drawer-head')
      check('detalhe-de-conector-personalizado-mostra-o-logo', /^imagem \d+x\d+$/.test(drawer), drawer)
      const size = await page.locator('[data-connector-detail="whatsapp"] .cnx-logo').evaluate((el) => el.getBoundingClientRect().width)
      check('logo-do-detalhe-tem-46px', size === 46, size)
    }
    await shot('03-detalhe-whatsapp.png')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.cnx-drawer', { state: 'detached' })
    await page.locator('input[aria-label="Procurar conectores"]').fill('github')
    await page.waitForTimeout(450)
    await page.locator('.cnx-card[data-connector-id="github"] .cnx-card-title').first().click()
    await page.waitForSelector('[data-connector-detail="github"]')
    await shot('04-detalhe-github.png')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.cnx-drawer', { state: 'detached' })
    await page.locator('input[aria-label="Procurar conectores"]').fill('')
    await page.waitForTimeout(450)

    // ---------------------------------------------------------------- tema claro
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))
    await shot('05-grade-tema-claro.png')
    await page.locator('#cnx-installed-title').scrollIntoViewIfNeeded()
    await shot('06-conectados-tema-claro.png')
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    if (CHECKS) check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    result.errors = errors
    result.ok = CHECKS ? ok() : true
    fs.writeFileSync(path.join(OUT, `${PREFIX}evidence-logos.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ ok: result.ok, shots: result.shots.length, falhas: Object.entries(checks).filter(([, value]) => value !== 'ok') }, null, 2))
  } catch (error) {
    result.errors = errors
    await page.screenshot({ path: path.join(OUT, `${PREFIX}falha-logos.png`) }).catch(() => undefined)
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    fs.writeFileSync(path.join(OUT, `${PREFIX}evidence-logos.json`), JSON.stringify({ ...result, erro: String(error) }, null, 2))
  } finally {
    app.cleanup()
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
