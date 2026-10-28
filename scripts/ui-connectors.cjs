// End-to-end da tela de Conectores (Personalização → Conectores) e de Configurações → MCP, no Electron real,
// com perfil descartável (--user-data-dir temporário; nada é lido nem gravado no perfil do usuário).
//
//   node scripts/ui-connectors.cjs [outDir]
//
// O que roda (sem modelo de IA: é interface + o backend de conectores de verdade):
//  - um servidor MCP stdio fictício com env API_KEY=segredo-de-teste-123 é escrito em texto puro no settings.json
//    ANTES de abrir o app, para provar a migração para o cofre e que o segredo nunca aparece na tela;
//  - um servidor MCP HTTP falso local (o próprio script sobe) é conectado como conector personalizado, pela tela;
//  - o diretório real (resources/mcp-directory.json) é exibido, buscado, filtrado e aberto;
//  - um programa deste computador (comando, argumentos, variáveis, pasta) é adicionado pelo formulário e outro, já existente, é editado
//    (o segredo continua mascarado e no cofre); Configurações → MCP não tem mais editor de JSON;
//  - nenhum login OAuth é iniciado (abriria o navegador do usuário em um serviço real).
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'conectores-2026-10-27'))
const PORT = 9371
const SECRET = 'segredo-de-teste-123'
const HEADER_SECRET = 'cabecalho-segredo-456'
const STDIO_NAME = 'servidor-stdio-falso'
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Servidor MCP por stdio mínimo; grava o que viu no ambiente para provar qual valor chegou ao processo. */
const STDIO_SERVER = `
const fs = require('node:fs')
fs.writeFileSync(process.env.SEEN_FILE, Date.now() + '\\n' + (process.env.API_KEY || ''))
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
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stdio-falso', version: '1.0.0' } } })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ver_hora', description: 'Devolve a hora do servidor fictício.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] } })
    else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'agora' }] } })
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`

const TOOLS = [
  { name: 'buscar_pedidos', description: 'Busca pedidos pelo número ou pelo cliente.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'criar_pedido', description: 'Cria um pedido novo para um cliente.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'apagar_pedido', description: 'Apaga um pedido e o histórico dele.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } }
]

/** Servidor MCP HTTP falso (Streamable HTTP, respostas JSON). Guarda o cabeçalho Authorization de cada chamada. */
function startFakeMcp() {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let message = {}
      try { message = JSON.parse(body || '{}') } catch {}
      seen.push({ method: message.method || req.method, authorization: String(req.headers.authorization || '') })
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      // Endereços de falha: /401 pede credencial sem dizer como entrar; /500 quebra.
      if (req.url === '/401') { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(JSON.stringify({ error: 'unauthorized' })); return }
      if (req.url === '/500') { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'falha interna de teste' })); return }
      const json = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })) }
      if (message.method === 'initialize') return json({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pedidos-falso', version: '1.0.0' } })
      if (message.method === 'tools/list') return json({ tools: TOOLS })
      if (message.method === 'tools/call') return json({ content: [{ type: 'text', text: 'ok' }] })
      res.writeHead(202).end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })))
}

async function main() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-connectors-ui-' })
  const seenFile = path.join(ws.work, 'env-visto.txt')
  const stdioScript = path.join(ws.work, 'stdio-falso.cjs')
  fs.writeFileSync(stdioScript, STDIO_SERVER)
  const settingsFile = path.join(ws.profile, 'config', 'settings.json')
  // Segredo em TEXTO PURO no arquivo, como as versões antigas guardavam: a migração tem de movê-lo para o cofre.
  fs.writeFileSync(settingsFile, JSON.stringify({
    importClaudeSettings: false,
    claudeCatalogImported: true,
    selfRepair: { enabled: false },
    mcpServers: [{ name: STDIO_NAME, command: process.execPath, args: [stdioScript], env: { API_KEY: SECRET, SEEN_FILE: seenFile }, enabled: true }]
  }, null, 2))
  const fake = await startFakeMcp()
  const fakeUrl = `http://127.0.0.1:${fake.port}/mcp`

  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  // Todo pedido de imagem da página: os logos têm de vir do pacote do app (file:), nunca da internet.
  const imageRequests = []
  page.on('request', (request) => request.resourceType() === 'image' && imageRequests.push(request.url()))
  const result = { checks, shots: [], timings: {}, errors: [], ok: false }
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const rawSettings = () => fs.readFileSync(settingsFile, 'utf8')
  const shot = async (name) => {
    await page.waitForTimeout(250)
    const file = path.join(OUT, name)
    await page.screenshot({ path: file })
    result.shots.push(file)
  }
  const api = (fn, ...args) => page.evaluate(async ({ fn, args }) => (await window.forja.app[fn](...args)), { fn, args })
  const screenText = () => page.evaluate(() => {
    const parts = [document.body.innerText, document.documentElement.outerHTML]
    for (const field of document.querySelectorAll('input, textarea')) parts.push(field.value || '')
    try { parts.push(JSON.stringify(localStorage)) } catch {}
    return parts.join('\n')
  })
  // textContent (not innerText): rows below the fold use content-visibility and would read as empty.
  const textOf = async (locator) => ((await locator.textContent()) || '').replace(/ /g, ' ')
  const waitFor = async (label, probe, timeoutMs = 20000) => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error(`tempo esgotado esperando: ${label}`)
      await sleep(250)
    }
  }
  const openConnectors = async (measure = false) => {
    await page.locator('nav.side-nav .side-row', { hasText: 'Personalização' }).click()
    const tab = page.getByRole('tab', { name: /Conectores/ })
    await tab.waitFor()
    if (measure) {
      // The clock starts at the click on the tab and stops when the panel and the first card are in the DOM.
      await page.evaluate(() => {
        window.__cnx = {}
        document.addEventListener('click', () => { window.__cnx.t0 = performance.now() }, { capture: true, once: true })
        new MutationObserver((_records, observer) => {
          const t0 = window.__cnx.t0
          if (t0 === undefined) return
          if (window.__cnx.panel === undefined && document.querySelector('[data-testid="connectors-panel"]')) window.__cnx.panel = performance.now() - t0
          if (window.__cnx.cards === undefined && document.querySelector('.cnx-card[data-connector-id]')) { window.__cnx.cards = performance.now() - t0; observer.disconnect() }
        }).observe(document.body, { childList: true, subtree: true })
      })
    }
    await tab.click()
    await page.waitForSelector('[data-testid="connectors-panel"]')
    await page.waitForSelector('.cnx-card[data-connector-id]')
  }
  const search = async (text) => {
    await page.locator('input[aria-label="Procurar conectores"]').fill(text)
    await page.waitForTimeout(450)
  }
  const openCard = async (id) => {
    await page.locator(`.cnx-card[data-connector-id="${id}"] .cnx-card-title`).first().click()
    await page.waitForSelector(`[data-connector-detail="${id}"]`)
  }
  /** Rola o avatar até a tela e espera a imagem terminar: "imagem LxA", "iniciais" (sem logo) ou o motivo da falha. */
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
  const closeDetail = async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector('.cnx-drawer', { state: 'detached' })
  }

  try {
    // ------------------------------------------------------------------ migração
    const afterBoot = rawSettings()
    check('settings.json-sem-o-segredo-depois-da-migracao', !afterBoot.includes(SECRET), afterBoot.includes(SECRET) ? 'o segredo continua no arquivo' : '')
    check('settings.json-guarda-so-uma-referencia', afterBoot.includes('${secret:'), 'referência ${secret:...} esperada')
    const backups = fs.readdirSync(path.join(ws.profile, 'config')).filter((name) => name.startsWith('settings.json.bak-'))
    check('migracao-deixou-copia-de-seguranca', backups.length === 1, backups)
    await waitFor('servidor stdio conectado', async () => {
      const states = (await api('connectorStates')).value
      return states.find((state) => state.id === STDIO_NAME)?.status === 'connected'
    })
    const firstSeen = fs.readFileSync(seenFile, 'utf8').split('\n')
    check('processo-recebeu-o-segredo-real-do-cofre', firstSeen[1] === SECRET, firstSeen[1] === SECRET ? '' : 'valor diferente')

    // ------------------------------------------------------------------ abrir a tela
    await openConnectors(true)
    result.timings = await page.evaluate(() => ({ painelMs: Math.round(window.__cnx.panel), cartoesMs: Math.round(window.__cnx.cards) }))
    check('tela-abre-na-hora', result.timings.painelMs < 1500, result.timings)
    check('cartoes-aparecem-rapido', result.timings.cartoesMs < 4000, result.timings)
    const directoryCount = Number(await page.locator('[data-testid="directory-count"]').textContent())
    const directory = (await api('connectorDirectory')).value
    const states0 = (await api('connectorStates')).value
    check('diretorio-com-mais-de-100-conectores', directoryCount > 100, { exibidos: directoryCount, noArquivo: directory.entries.length })
    const firstPage = await page.locator('[data-testid="connectors-directory"] .cnx-card').count()
    check('paginacao-de-60-em-60', firstPage === 60, firstPage)
    await page.getByRole('button', { name: /Mostrar mais/ }).click()
    await page.waitForTimeout(300)
    check('mostrar-mais-revela-mais-60', (await page.locator('[data-testid="connectors-directory"] .cnx-card').count()) === 120)
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))
    check('conector-stdio-aparece-em-conectados', (await page.locator(`[data-testid="connectors-installed"] .cnx-card[data-connector-id="${STDIO_NAME}"][data-status="connected"]`).count()) === 1)
    const installedText = (await page.locator('[data-testid="connectors-installed"]').textContent()) || ''
    check('cartao-do-stdio-mostra-status-vivo', /Conectado · 1 ferramenta/.test(installedText), installedText.replace(/\s+/g, ' ').slice(0, 160))
    await shot('01-grade-de-conectores.png')

    // ------------------------------------------------------------------ logos (empacotados no app, sem rede)
    const sample = ['github', 'notion', 'linear', 'google-drive', 'gmail', 'figma-remote', 'asana-remote', 'sentry', 'stripe-remote', 'vercel', 'supabase-remote', 'hubspot']
    const loaded = {}
    for (const id of sample) loaded[id] = await logoState(`[data-testid="connectors-directory"] .cnx-card[data-connector-id="${id}"]`)
    check('logos-amostra-de-12-cartoes-carrega-imagem-de-verdade', Object.values(loaded).every((state) => /^imagem \d+x\d+$/.test(state)), loaded)
    check('logos-vem-do-pacote-do-app-sem-pedido-de-rede', imageRequests.length > 0 && imageRequests.every((url) => /^(file:|data:|blob:)/i.test(url)) && imageRequests.some((url) => url.includes('connector-icons/')), { total: imageRequests.length, fora: imageRequests.filter((url) => !/^(file:|data:|blob:)/i.test(url)).slice(0, 5) })
    check('cartao-sem-logo-mostra-as-iniciais', (await logoState(`[data-testid="connectors-installed"] .cnx-card[data-connector-id="${STDIO_NAME}"]`)) === 'iniciais')
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))

    // ------------------------------------------------------------------ busca
    await search('atlassian')
    await page.waitForSelector('.cnx-card[data-connector-id="atlassian"]')
    const firstId = await page.locator('[data-testid="connectors-directory"] .cnx-card').first().getAttribute('data-connector-id')
    check('busca-atlassian-acha-o-cartao', firstId === 'atlassian', firstId)
    const atlassianHits = await page.locator('[data-testid="connectors-directory"] .cnx-card').count()
    check('busca-esconde-os-outros', atlassianHits >= 1 && atlassianHits < 15, atlassianHits)
    await shot('02-busca-atlassian.png')
    // "juridico" (sem acento) encontra a categoria "Jurídico".
    await search('juridico')
    const legalExpected = directory.entries.filter((entry) => entry.category === 'juridico').length
    const legalShown = Number(await page.locator('[data-testid="directory-count"]').textContent())
    check('busca-ignora-acentos', legalShown >= legalExpected && legalExpected > 0, { exibidos: legalShown, naCategoria: legalExpected })
    await search('zzzz-nao-existe')
    check('busca-sem-resultado-mostra-estado-vazio', (await page.locator('[data-testid="connectors-empty"]').count()) === 1)
    await shot('03-busca-sem-resultado.png')
    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await page.waitForTimeout(300)

    // ------------------------------------------------------------------ categoria e situação
    const devEntries = directory.entries.filter((entry) => entry.category === 'desenvolvimento').length
    await page.locator('.cnx-chips-row .cnx-chip', { hasText: 'Desenvolvimento' }).first().click()
    await page.waitForTimeout(300)
    const devShown = Number(await page.locator('[data-testid="directory-count"]').textContent())
    const devInstalled = await page.locator('[data-testid="connectors-installed"] .cnx-card').count()
    check('filtro-por-categoria-conta-igual-ao-diretorio', devShown + devInstalled === devEntries, { exibidos: devShown, instalados: devInstalled, noArquivo: devEntries })
    check('chip-da-categoria-marcado', (await page.locator('.cnx-chip.active', { hasText: 'Desenvolvimento' }).count()) === 1)
    await shot('04-filtro-por-categoria.png')
    await page.locator('.cnx-chips-row .cnx-chip', { hasText: 'Todas' }).first().click()
    await page.locator('.cnx-segmented button', { hasText: 'Conectados' }).click()
    await page.waitForTimeout(300)
    check('filtro-conectados-mostra-so-o-conectado', (await page.locator('.cnx-card').count()) === 1)
    await page.locator('.cnx-segmented button', { hasText: 'Precisam de login' }).click()
    await page.waitForTimeout(300)
    check('filtro-precisam-de-login-vazio-e-claro', /Nenhum conector precisa de login/.test(await page.locator('[data-testid="connectors-empty"]').innerText()))
    await page.locator('.cnx-segmented button', { hasText: 'Todos' }).click()
    await page.waitForTimeout(300)

    // ------------------------------------------------------------------ detalhe (OAuth) e acessibilidade
    await search('atlassian')
    await page.locator('.cnx-card[data-connector-id="atlassian"] .cnx-card-title').focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-connector-detail="atlassian"]')
    const detail = await textOf(page.locator('[data-connector-detail="atlassian"]'))
    check('detalhe-mostra-nome-e-selo-de-login', /Atlassian/.test(detail) && /Login com sua conta/.test(detail))
    check('detalhe-mostra-endereco', /mcp\.atlassian\.com/.test(detail))
    check('detalhe-explica-a-verificacao-sem-jargao', /Verificado em \d\d\/\d\d: chega ao login/.test(detail), detail.match(/Verificado em[^\n]*/)?.[0])
    check('detalhe-tem-botao-conectar-com-sua-conta', (await page.getByRole('button', { name: 'Conectar com sua conta' }).count()) === 1)
    const dialogAttrs = await page.locator('[data-connector-detail="atlassian"]').evaluate((el) => ({ role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), label: document.getElementById(el.getAttribute('aria-labelledby'))?.textContent }))
    check('detalhe-e-dialogo-acessivel', dialogAttrs.role === 'dialog' && dialogAttrs.modal === 'true' && /Atlassian/.test(dialogAttrs.label || ''), dialogAttrs)
    for (let index = 0; index < 40; index++) await page.keyboard.press('Tab')
    check('foco-fica-preso-no-detalhe', await page.evaluate(() => Boolean(document.activeElement?.closest('.cnx-drawer'))))
    check('detalhe-mostra-o-logo-do-servico', /^imagem \d+x\d+$/.test(await logoState('[data-connector-detail="atlassian"] .cnx-drawer-head')))
    await shot('05-detalhe-oauth.png')
    await closeDetail()
    check('foco-volta-ao-cartao-ao-fechar', await page.evaluate(() => document.activeElement?.closest('.cnx-card')?.dataset.connectorId === 'atlassian'))
    check('nenhum-login-foi-iniciado', (await api('connectorStates')).value.find((state) => state.id === 'atlassian')?.status === 'not-installed')

    // ------------------------------------------------------------------ formulário de chave de API
    await search('atlassian api token')
    await openCard('atlassian-token')
    const form = page.locator('[data-connector-detail="atlassian-token"] form')
    check('formulario-gerado-das-credenciais', (await form.locator('label', { hasText: 'E-mail da conta Atlassian' }).count()) === 1 && (await form.locator('label', { hasText: 'API token Atlassian' }).count()) === 1)
    const tokenField = form.locator('input[type="password"]').first()
    check('campo-secreto-vem-mascarado', (await tokenField.count()) === 1)
    await tokenField.fill('token-falso-so-para-captura')
    await form.locator('button[aria-label^="Mostrar"]').first().click()
    check('mostrar-revela-o-valor', (await form.locator('input[type="text"][aria-label], input[type="text"]').evaluateAll((nodes) => nodes.some((node) => node.value === 'token-falso-so-para-captura'))) === true)
    await form.locator('button[aria-label^="Ocultar"]').first().click()
    check('ocultar-volta-a-mascarar', (await form.locator('input[type="password"]').count()) === 1)
    await form.getByRole('button', { name: 'Conectar' }).click()
    check('obrigatorios-sao-validados-antes-de-enviar', (await form.getByText('Campo obrigatório.').count()) >= 1)
    check('nada-foi-instalado-sem-credencial-completa', (await api('connectorStates')).value.find((state) => state.id === 'atlassian-token')?.status === 'not-installed')
    await shot('06-formulario-chave-de-api.png')
    await closeDetail()

    // ------------------------------------------------------------------ OAuth que exige app próprio e entrada sem URL
    const staticEntry = directory.entries.find((entry) => entry.auth === 'oauth-static' && !entry.oauthClientId && entry.url)
    if (staticEntry) {
      await search(staticEntry.name)
      await openCard(staticEntry.id)
      const text = await textOf(page.locator(`[data-connector-detail="${staticEntry.id}"]`))
      check('oauth-static-explica-que-precisa-de-app-proprio', /exige um aplicativo OAuth cadastrado por você/.test(text) && /Client ID/.test(text) && /Client Secret/.test(text), text.slice(0, 200))
      check('oauth-static-pede-client-id-e-segredo-mascarado', (await page.locator(`[data-connector-detail="${staticEntry.id}"] form input[type="password"]`).count()) >= 1)
      await shot('07-oauth-com-app-proprio.png')
      await closeDetail()
    } else {
      check('oauth-static-explica-que-precisa-de-app-proprio', false, 'nenhuma entrada oauth-static no diretório')
    }
    const noUrl = directory.entries.find((entry) => entry.transport !== 'stdio' && !entry.url)
    if (noUrl) {
      await search(noUrl.name)
      await openCard(noUrl.id)
      check('entrada-sem-url-pede-o-endereco', (await page.locator(`[data-connector-detail="${noUrl.id}"] form label`, { hasText: 'URL do servidor MCP' }).count()) === 1)
      await closeDetail()
    }
    await search('')

    // ------------------------------------------------------------------ conector personalizado (servidor MCP HTTP falso)
    await page.getByRole('button', { name: /Conector personalizado/ }).click()
    await page.waitForSelector('.cnx-dialog')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    check('personalizado-valida-nome-e-url', (await page.locator('.cnx-dialog small.is-bad').count()) >= 2)
    await page.locator('.cnx-dialog input[placeholder="meu-servidor"]').fill('pedidos-falso')
    await page.locator('.cnx-dialog input[placeholder^="https://mcp"]').fill('http://exemplo.com/mcp')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    check('personalizado-recusa-http-fora-de-localhost', (await page.locator('.cnx-dialog').innerText()).includes('só é aceito para endereços deste computador'))
    await page.locator('.cnx-dialog input[placeholder^="https://mcp"]').fill(fakeUrl)
    await shot('08-conector-personalizado.png')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    await page.waitForSelector('[data-connector-detail="pedidos-falso"]', { timeout: 30000 })
    await waitFor('pedidos-falso conectado', async () => (await api('connectorStates')).value.find((state) => state.id === 'pedidos-falso')?.status === 'connected', 30000)
    await page.waitForSelector('[data-connector-detail="pedidos-falso"] .cnx-tool')
    const detailText = await textOf(page.locator('[data-connector-detail="pedidos-falso"]'))
    check('personalizado-fica-conectado-com-3-ferramentas', /Conectado · 3 ferramentas/.test(detailText), detailText.match(/Conectado[^\n]*/)?.[0])
    check('servidor-falso-recebeu-initialize-e-tools-list', fake.seen.some((item) => item.method === 'initialize') && fake.seen.some((item) => item.method === 'tools/list'), fake.seen.map((item) => item.method))
    check('ferramentas-listadas-com-selos', (await page.locator('[data-connector-detail="pedidos-falso"] .cnx-tool').count()) === 3 && /somente leitura/.test(detailText) && /pode alterar ou apagar dados/.test(detailText) && /pode alterar dados/.test(detailText))
    check('ferramentas-agrupadas-por-tipo', (await page.locator('[data-connector-detail="pedidos-falso"] .cnx-tool-group h4').count()) === 2)

    // ------------------------------------------------------------------ política por ferramenta
    const selectOf = (tool) => page.locator(`[data-connector-detail="pedidos-falso"] .cnx-tool[data-tool="${tool}"] select`)
    const policies = async () => Object.fromEntries((await api('connectorTools', 'pedidos-falso')).value.map((tool) => [tool.name, tool.policy]))
    await page.locator('[data-connector-detail="pedidos-falso"] .cnx-tools-all select').selectOption('ask')
    await waitFor('todas perguntam', async () => Object.values(await policies()).every((policy) => policy === 'ask'))
    check('todas-as-ferramentas-aplica-a-todas', true)
    await selectOf('buscar_pedidos').selectOption('allow')
    await selectOf('apagar_pedido').selectOption('deny')
    const saved = await waitFor('politicas salvas', async () => {
      const now = await policies()
      return now.buscar_pedidos === 'allow' && now.criar_pedido === 'ask' && now.apagar_pedido === 'deny' ? now : null
    })
    check('politica-por-ferramenta-persiste-no-backend', Boolean(saved), saved)
    const stored = readSettings().mcpServers.find((server) => server.name === 'pedidos-falso')
    check('politica-gravada-no-settings.json', stored?.toolPolicy?.apagar_pedido === 'deny' && stored?.toolPolicy?.buscar_pedidos === 'allow', stored?.toolPolicy)
    await shot('09-ferramentas-com-politicas.png')
    await closeDetail()
    await page.reload()
    await page.waitForSelector('.app-shell')
    await openConnectors()
    await openCard('pedidos-falso')
    await page.waitForSelector('[data-connector-detail="pedidos-falso"] .cnx-tool')
    const afterReload = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-connector-detail] .cnx-tool')].map((row) => [row.dataset.tool, row.querySelector('select').value])))
    check('politica-continua-igual-apos-recarregar-a-tela', afterReload.buscar_pedidos === 'allow' && afterReload.criar_pedido === 'ask' && afterReload.apagar_pedido === 'deny', afterReload)

    // ------------------------------------------------------------------ desconectar com confirmação
    await page.getByRole('button', { name: 'Desconectar' }).first().click()
    const confirmText = await page.locator('[role="alertdialog"]').innerText()
    check('desconectar-pede-confirmacao-clara', /apaga do cofre os tokens e segredos/.test(confirmText), confirmText.replace(/\s+/g, ' ').slice(0, 200))
    await shot('10-confirmar-desconexao.png')
    await page.getByRole('button', { name: 'Desconectar e apagar segredos' }).click()
    await waitFor('pedidos-falso removido', async () => (await api('connectorStates')).value.every((state) => state.id !== 'pedidos-falso' || state.status === 'not-installed'))
    check('desconectar-remove-do-settings.json', !readSettings().mcpServers.some((server) => server.name === 'pedidos-falso'))
    await page.waitForSelector('.cnx-callout.tone-ok', { timeout: 10000 }).catch(() => undefined)
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(400)
    check('cartao-sai-de-conectados', (await page.locator('.cnx-card[data-connector-id="pedidos-falso"]').count()) === 0)

    // ------------------------------------------------------------------ cabeçalho secreto vai para o cofre
    await page.getByRole('button', { name: /Conector personalizado/ }).click()
    await page.waitForSelector('.cnx-dialog')
    await page.locator('.cnx-dialog input[placeholder="meu-servidor"]').fill('com-cabecalho')
    await page.locator('.cnx-dialog input[placeholder^="https://mcp"]').fill(fakeUrl)
    await page.getByRole('button', { name: 'Adicionar cabeçalho' }).click()
    await page.locator('.cnx-dialog input[placeholder="Authorization"]').fill('Authorization')
    const headerValue = page.locator('.cnx-dialog .cnx-header-row input[type="password"]')
    check('valor-do-cabecalho-vem-mascarado', (await headerValue.count()) === 1)
    await headerValue.fill(`Bearer ${HEADER_SECRET}`)
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    await page.waitForSelector('[data-connector-detail="com-cabecalho"]', { timeout: 30000 })
    await waitFor('com-cabecalho conectado', async () => (await api('connectorStates')).value.find((state) => state.id === 'com-cabecalho')?.status === 'connected', 30000)
    check('cabecalho-chegou-ao-servidor', fake.seen.some((item) => item.authorization === `Bearer ${HEADER_SECRET}`))
    check('cabecalho-nao-esta-no-settings.json', !rawSettings().includes(HEADER_SECRET))
    check('cabecalho-nao-aparece-na-tela', !(await screenText()).includes(HEADER_SECRET))
    await page.getByRole('button', { name: 'Desconectar' }).first().click()
    await page.getByRole('button', { name: 'Desconectar e apagar segredos' }).click()
    await waitFor('com-cabecalho removido', async () => (await api('connectorStates')).value.every((state) => state.id !== 'com-cabecalho' || state.status === 'not-installed'))
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(300)

    // ------------------------------------------------------------------ falhas: nada fica pela metade, e o erro é explicado
    const origin = fakeUrl.slice(0, -'/mcp'.length)
    await page.getByRole('button', { name: /Conector personalizado/ }).click()
    await page.waitForSelector('.cnx-dialog')
    await page.locator('.cnx-dialog input[placeholder="meu-servidor"]').fill('pede-login')
    await page.locator('.cnx-dialog input[placeholder^="https://mcp"]').fill(origin + '/401')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    await page.waitForSelector('.cnx-dialog [role="alert"]', { timeout: 30000 })
    check('conector-que-pede-login-sem-oauth-mostra-erro-no-dialogo', (await page.locator('.cnx-dialog').count()) === 1 && ((await page.locator('.cnx-dialog [role="alert"]').textContent()) || '').length > 10, await page.locator('.cnx-dialog [role="alert"]').textContent())
    check('conector-que-falhou-ao-iniciar-nao-fica-instalado', !readSettings().mcpServers.some((server) => server.name === 'pede-login') && (await api('connectorStates')).value.every((state) => state.id !== 'pede-login' || state.status === 'not-installed'))
    await shot('11-conector-personalizado-com-erro-no-dialogo.png')
    await page.locator('.cnx-dialog input[placeholder="meu-servidor"]').fill('quebrado')
    await page.locator('.cnx-dialog input[placeholder^="https://mcp"]').fill(origin + '/500')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    await page.waitForSelector('[data-connector-detail="quebrado"]', { timeout: 30000 })
    await waitFor('quebrado com erro', async () => ['error', 'connecting'].includes((await api('connectorStates')).value.find((state) => state.id === 'quebrado')?.status || ''), 30000)
    await waitFor('quebrado em erro', async () => (await api('connectorStates')).value.find((state) => state.id === 'quebrado')?.status === 'error', 60000)
    await page.waitForSelector('[data-connector-detail="quebrado"] .cnx-callout.tone-bad')
    const brokenText = await textOf(page.locator('[data-connector-detail="quebrado"]'))
    check('servidor-com-erro-mostra-status-e-motivo', /Erro/.test(brokenText) && /500/.test(brokenText), brokenText.slice(0, 300))
    check('servidor-com-erro-oferece-reconectar-e-desconectar', (await page.locator('[data-connector-detail="quebrado"]').getByRole('button', { name: 'Reconectar' }).count()) === 1 && (await page.locator('[data-connector-detail="quebrado"]').getByRole('button', { name: 'Desconectar' }).count()) === 1)
    await shot('12-conector-com-erro.png')
    await page.getByRole('button', { name: 'Desconectar' }).first().click()
    await page.getByRole('button', { name: 'Desconectar e apagar segredos' }).click()
    await waitFor('quebrado removido', async () => (await api('connectorStates')).value.every((state) => state.id !== 'quebrado' || state.status === 'not-installed'))
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(300)

    // ------------------------------------------------------------------ segredo do stdio nunca na tela
    check('segredo-do-stdio-nao-aparece-na-pagina-de-conectores', !(await screenText()).includes(SECRET))
    await openCard(STDIO_NAME)
    await page.waitForSelector(`[data-connector-detail="${STDIO_NAME}"] .cnx-tool`)
    await page.waitForFunction((name) => /ver_hora/.test(document.querySelector(`[data-connector-detail="${name}"]`)?.innerText || ''), STDIO_NAME, { timeout: 15000 }).catch(() => undefined)
    const stdioDetail = await textOf(page.locator(`[data-connector-detail="${STDIO_NAME}"]`))
    check('detalhe-do-stdio-nao-mostra-segredo-nem-argumentos', !stdioDetail.includes(SECRET) && !stdioDetail.includes('stdio-falso.cjs'))
    check('detalhe-do-stdio-lista-a-ferramenta', /ver_hora/.test(stdioDetail), stdioDetail.replace(/\s+/g, ' ').slice(0, 400))
    await shot('13-conector-stdio-sem-segredo.png')
    await closeDetail()

    // ------------------------------------------------------------------ editar um conector que o usuário adicionou (programa local)
    const seenEdit = fs.readFileSync(seenFile, 'utf8')
    await openCard(STDIO_NAME)
    const editButton = page.locator(`[data-connector-detail="${STDIO_NAME}"] [data-testid="edit-connector"]`)
    check('detalhe-do-conector-proprio-oferece-editar', (await editButton.count()) === 1)
    await editButton.click()
    await page.waitForSelector('.cnx-dialog')
    const editTitle = await page.locator('.cnx-dialog h2').innerText()
    check('editar-abre-o-formulario-do-programa-local', /^Editar servidor-stdio-falso/.test(editTitle) && (await page.locator('.cnx-dialog input[placeholder="npx"]').inputValue()) === process.execPath, editTitle)
    check('editar-nao-deixa-trocar-o-nome', await page.locator('.cnx-dialog input[placeholder="meu-servidor"]').evaluate((el) => el.readOnly))
    check('editar-nao-mostra-a-escolha-de-tipo', (await page.locator('.cnx-dialog .cnx-kind').count()) === 0)
    check('editar-mostra-os-argumentos-um-por-linha', (await page.locator('.cnx-dialog textarea').inputValue()).trim() === stdioScript)
    const maskedField = page.locator('.cnx-dialog .cnx-header-row input[type="password"]')
    const maskedValue = (await maskedField.count()) === 1 ? await maskedField.inputValue() : ''
    check('editar-mostra-o-segredo-mascarado', maskedValue.startsWith('••••••') && !maskedValue.includes(SECRET), maskedValue)
    check('editar-nao-mostra-o-segredo-real-em-lugar-nenhum', !(await screenText()).includes(SECRET))
    await shot('20-editar-programa-local.png')
    // Muda o tempo de partida e acrescenta uma variável; o segredo fica como está (mascarado).
    await page.locator('.cnx-dialog .cnx-advanced > summary').click()
    await page.locator('.cnx-dialog input[type="number"]').fill('40')
    await page.getByRole('button', { name: 'Adicionar variável' }).click()
    await page.locator('.cnx-dialog input[aria-label="Nome da variável 3"]').fill('EXTRA')
    await page.locator('.cnx-dialog input[aria-label="valor da variável 3"]').fill('1')
    await page.getByRole('button', { name: 'Salvar e reconectar' }).click()
    await page.waitForSelector('.cnx-dialog', { state: 'detached', timeout: 30000 })
    await waitFor('servidor reiniciado pela edição', async () => fs.readFileSync(seenFile, 'utf8') !== seenEdit, 30000)
    const seenAfterEdit = fs.readFileSync(seenFile, 'utf8').split('\n')
    check('editar-reinicia-o-servidor-com-o-segredo-real', seenAfterEdit[1] === SECRET, seenAfterEdit[1] === SECRET ? '' : 'o processo recebeu outro valor')
    const editedStdio = readSettings().mcpServers.find((server) => server.name === STDIO_NAME)
    check('editar-grava-o-tempo-de-partida-e-a-variavel-nova', editedStdio?.startTimeoutMs === 40000 && editedStdio?.env?.EXTRA === '1', JSON.stringify({ t: editedStdio?.startTimeoutMs, extra: editedStdio?.env?.EXTRA }))
    check('editar-mantem-o-segredo-no-cofre-e-nunca-grava-a-mascara', String(editedStdio?.env?.API_KEY).startsWith('${secret:') && !rawSettings().includes('••') && !rawSettings().includes(SECRET), String(editedStdio?.env?.API_KEY))
    await waitFor('conector editado conectado', async () => (await api('connectorStates')).value.find((state) => state.id === STDIO_NAME)?.status === 'connected', 30000)
    check('editar-mantem-o-conector-conectado-com-a-ferramenta', /ver_hora/.test(await textOf(page.locator(`[data-connector-detail="${STDIO_NAME}"]`))))
    await closeDetail()

    // ------------------------------------------------------------------ adicionar um programa deste computador pelo formulário
    const seenNew = path.join(ws.work, 'env-visto-novo.txt')
    const NEW_SECRET = 'outro-segredo-777'
    await page.getByRole('button', { name: /Conector personalizado/ }).click()
    await page.waitForSelector('.cnx-dialog')
    check('formulario-oferece-os-dois-tipos', (await page.locator('.cnx-dialog .cnx-kind input[type="radio"]').count()) === 2)
    await page.locator('.cnx-dialog [data-testid="kind-local"]').check()
    await page.locator('.cnx-dialog input[placeholder="meu-servidor"]').fill('local-pela-tela')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    check('programa-local-exige-o-comando', /Informe o programa/.test(await page.locator('.cnx-dialog').innerText()) && (await page.locator('.cnx-dialog').count()) === 1)
    check('programa-local-avisa-que-roda-neste-computador', /vai rodar no seu computador, com as suas permissões/.test(await page.locator('.cnx-dialog').innerText()))
    await page.locator('.cnx-dialog input[placeholder="npx"]').fill(process.execPath)
    await page.locator('.cnx-dialog textarea').fill(stdioScript)
    await page.locator('.cnx-dialog input[placeholder^="C:"]').fill('pasta-relativa')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    check('programa-local-recusa-pasta-sem-caminho-completo', /caminho completo da pasta/.test(await page.locator('.cnx-dialog').innerText()))
    await page.locator('.cnx-dialog input[placeholder^="C:"]').fill(ws.work)
    await page.getByRole('button', { name: 'Adicionar variável' }).click()
    await page.getByRole('button', { name: 'Adicionar variável' }).click()
    await page.locator('.cnx-dialog input[aria-label="Nome da variável 1"]').fill('API_KEY')
    await page.locator('.cnx-dialog input[aria-label="valor da variável 1"]').fill(NEW_SECRET)
    await page.locator('.cnx-dialog input[aria-label="Nome da variável 2"]').fill('SEEN_FILE')
    await page.locator('.cnx-dialog input[aria-label="valor da variável 2"]').fill(seenNew)
    check('variavel-com-nome-de-credencial-vem-mascarada-e-a-outra-nao', (await page.locator('.cnx-dialog .cnx-header-row input[type="password"]').count()) === 1)
    await shot('21-adicionar-programa-local.png')
    await page.getByRole('button', { name: 'Adicionar e conectar' }).click()
    await page.waitForSelector('[data-connector-detail="local-pela-tela"]', { timeout: 30000 })
    await waitFor('local-pela-tela conectado', async () => (await api('connectorStates')).value.find((state) => state.id === 'local-pela-tela')?.status === 'connected', 30000)
    await page.waitForSelector('[data-connector-detail="local-pela-tela"] .cnx-tool')
    check('programa-local-conecta-e-lista-a-ferramenta', /ver_hora/.test(await textOf(page.locator('[data-connector-detail="local-pela-tela"]'))))
    const seenLocal = fs.existsSync(seenNew) ? fs.readFileSync(seenNew, 'utf8').split('\n') : []
    check('programa-local-recebeu-o-segredo-real', seenLocal[1] === NEW_SECRET, seenLocal[1] === NEW_SECRET ? '' : 'o processo recebeu outro valor')
    const storedLocal = readSettings().mcpServers.find((server) => server.name === 'local-pela-tela')
    check(
      'programa-local-gravado-como-configurado',
      storedLocal?.command === process.execPath && JSON.stringify(storedLocal?.args) === JSON.stringify([stdioScript]) && storedLocal?.cwd === ws.work && storedLocal?.env?.SEEN_FILE === seenNew,
      JSON.stringify(storedLocal)
    )
    check('programa-local-segredo-so-no-cofre', String(storedLocal?.env?.API_KEY).startsWith('${secret:') && !rawSettings().includes(NEW_SECRET), String(storedLocal?.env?.API_KEY))
    check('programa-local-nao-mostra-o-segredo-na-tela', !(await screenText()).includes(NEW_SECRET))
    await shot('22-programa-local-conectado.png')
    await page.getByRole('button', { name: 'Desconectar' }).first().click()
    await page.getByRole('button', { name: 'Desconectar e apagar segredos' }).click()
    await waitFor('local-pela-tela removido', async () => (await api('connectorStates')).value.every((state) => state.id !== 'local-pela-tela' || state.status === 'not-installed'))
    check('programa-local-desconectado-sai-do-settings.json', !readSettings().mcpServers.some((server) => server.name === 'local-pela-tela'))
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(300)

    // ------------------------------------------------------------------ Configurações → MCP (sem editor de JSON)
    await page.keyboard.press('Control+,')
    await page.waitForSelector('.settings-sheet')
    await page.locator('.settings-nav button', { hasText: 'MCP' }).click()
    await page.waitForSelector('.mcp-settings')
    const mcpText = await page.locator('.mcp-settings').innerText()
    check('mcp-aponta-para-personalizacao-conectores', /Personalização → Conectores/.test(mcpText) && (await page.getByRole('button', { name: 'Abrir Conectores' }).count()) === 1)
    check('configuracoes-mcp-nao-tem-mais-editor-de-json', (await page.locator('.mcp-settings textarea').count()) === 0 && (await page.locator('.mcp-settings details').count()) === 0 && !/editar JSON/i.test(mcpText), mcpText.replace(/\s+/g, ' ').slice(0, 200))
    check('configuracoes-mcp-diz-que-a-tela-e-uma-so', /numa tela só/.test(mcpText) && /por endereço ou por um programa/.test(mcpText.replace(/\s+/g, ' ')))
    await waitFor('aviso de cópia antiga', async () => (await page.locator('[data-testid="mcp-backup-warning"]').count()) === 1)
    check('aviso-de-copia-com-segredo-antigo', /settings\.json\.bak-/.test(await page.locator('[data-testid="mcp-backup-warning"]').innerText()))
    check('configuracoes-nao-mostram-segredo-na-tela-nem-nos-campos', !(await screenText()).includes(SECRET))
    await shot('14-configuracoes-mcp-sem-json.png')

    // Salvar sem tocar em nada: o diálogo não manda os servidores, então nada muda e o servidor não reinicia.
    const serversBefore = JSON.stringify(readSettings().mcpServers)
    const seenBefore = fs.readFileSync(seenFile, 'utf8')
    const mtimeBefore = fs.statSync(settingsFile).mtimeMs
    await page.getByRole('button', { name: 'Salvar alterações' }).click()
    // (o aviso "Configurações salvas." é apagado pelo próprio diálogo ao receber as configurações novas; a prova é o arquivo gravado)
    await waitFor('settings.json regravado pelo Salvar', async () => fs.statSync(settingsFile).mtimeMs !== mtimeBefore)
    await sleep(1500)
    check('salvar-sem-tocar-nao-altera-os-servidores', JSON.stringify(readSettings().mcpServers) === serversBefore)
    check('salvar-sem-tocar-nao-reinicia-o-servidor', fs.readFileSync(seenFile, 'utf8') === seenBefore)

    // Apagar as cópias antigas (só settings.json.bak-*).
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: 'Apagar cópias antigas' }).click()
    await waitFor('cópias apagadas', async () => fs.readdirSync(path.join(ws.profile, 'config')).every((name) => !name.startsWith('settings.json.bak-')))
    check('apagar-copias-remove-so-os-backups', fs.existsSync(settingsFile) && fs.existsSync(path.join(ws.profile, 'config', 'secrets.bin')))
    await waitFor('aviso some', async () => (await page.locator('[data-testid="mcp-backup-warning"]').count()) === 0)
    check('aviso-some-depois-de-apagar', true)

    // Abrir Conectores a partir daqui.
    await page.getByRole('button', { name: 'Abrir Conectores' }).click()
    await page.waitForSelector('.settings-sheet', { state: 'detached' })
    check('abrir-conectores-leva-a-tela-de-conectores', (await page.locator('[data-testid="connectors-panel"]').count()) === 1)
    check('settings-final-sem-segredo-no-disco', !rawSettings().includes(SECRET) && !rawSettings().includes(HEADER_SECRET))

    // ------------------------------------------------------------------ tema claro e janela estreita
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))
    await shot('15-grade-tema-claro.png')
    await openCard(STDIO_NAME)
    await shot('16-detalhe-tema-claro.png')
    await closeDetail()
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.setViewportSize({ width: 960, height: 760 })
    await page.waitForTimeout(400)
    await shot('17-janela-estreita.png')
    await page.setViewportSize({ width: 1440, height: 900 })

    // Uma imagem que falha volta para as iniciais (o erro de carregamento provocado de propósito não conta como erro do app).
    const brokenId = 'intercom'
    await page.locator('.page').evaluate((el) => el.scrollTo(0, 0))
    await page.locator('input[aria-label="Procurar conectores"]').fill(brokenId)
    await page.waitForSelector(`.cnx-card[data-connector-id="${brokenId}"]`)
    check('antes-de-quebrar-o-logo-aparece-como-imagem', /^imagem \d+x\d+$/.test(await logoState(`.cnx-card[data-connector-id="${brokenId}"]`)))
    const errorsBefore = errors.length
    await page.locator(`.cnx-card[data-connector-id="${brokenId}"] .cnx-logo img`).evaluate((img) => { img.src = 'connector-icons/nao-existe.webp' })
    await page.waitForSelector(`.cnx-card[data-connector-id="${brokenId}"] [data-logo="initials"]`, { timeout: 5000 }).catch(() => undefined)
    check('logo-que-nao-carrega-volta-para-as-iniciais', (await page.locator(`.cnx-card[data-connector-id="${brokenId}"] [data-logo="initials"]`).count()) === 1 && (await page.locator(`.cnx-card[data-connector-id="${brokenId}"] .cnx-logo`).count()) === 0)
    // O erro de carregamento da imagem que quebramos de propósito (o Chromium não diz qual arquivo) não conta como erro do app.
    for (let index = errors.length - 1; index >= errorsBefore; index--) if (/ERR_FILE_NOT_FOUND/.test(errors[index])) errors.splice(index, 1)
    await page.locator('input[aria-label="Procurar conectores"]').fill('')
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    result.errors = errors
    result.ok = ok()
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ ok: result.ok, timings: result.timings, shots: result.shots.length, falhas: Object.entries(checks).filter(([, value]) => value !== 'ok') }, null, 2))
  } catch (error) {
    result.errors = errors
    await page.screenshot({ path: path.join(OUT, 'falha.png') }).catch(() => undefined)
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ ...result, erro: String(error) }, null, 2))
  } finally {
    fake.server.close()
    app.cleanup()
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
