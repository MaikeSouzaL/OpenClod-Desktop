// O painel Sessão (aba Contexto) funcionando como o do Claude Code, no Electron real com perfil descartável.
//
//   node scripts/ui-session-panel.cjs [--root <cópia congelada>] [--out <pasta dos prints>]
//
// Sem modelo de IA e sem serviço externo: os conectores são servidores MCP falsos que o próprio script sobe (cinco
// saudáveis por stdio, um stdio que falha enquanto um arquivo-flag existe, um HTTP que responde 401) e o projeto é um
// repositório git temporário com alterações por commitar. Confere:
//  - Conectores: "Autenticar" no que pede login, "Reconectar" no que falhou, os que pedem atenção primeiro, 5 visíveis e
//    "Mostrar mais"; "Reconectar" reconecta de verdade (a falha é removida e o servidor volta) e "Autenticar" num conector
//    adicionado à mão abre Personalização → Conectores;
//  - Contexto: "Buffer de auto-compact" e "Espaço livre", porcentagens da janela somando 100%, rodapé "até o auto-compact";
//  - Ambiente: a branch do git; Alterações: o total +N −M da árvore de trabalho.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'painel-sessao-2026-10-29'))
const PORT = Number(e2e.arg('port', '9452'))
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Servidor MCP por stdio com uma ferramenta; sai com código 5 enquanto o arquivo FAIL_IF_FILE existir. */
const STDIO_SERVER = `
const fs = require('node:fs')
if (process.env.FAIL_IF_FILE && fs.existsSync(process.env.FAIL_IF_FILE)) process.exit(5)
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
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`

/** HTTP que recusa tudo com 401: o app tem de mostrar o conector como "precisa entrar". */
function startUnauthorized() {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(JSON.stringify({ error: 'unauthorized' })))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

/** git no repositório descartável, com identidade só para este comando (nada vai para a configuração global). */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Openclod E2E', '-c', 'user.email=e2e@openclod.local', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', windowsHide: true }).toString()
}

async function main() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-session-panel-' })
  git(ws.project, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(ws.project, 'app.txt'), 'linha 1\nlinha 2\nlinha 3\n')
  git(ws.project, 'add', '-A')
  git(ws.project, 'commit', '-q', '-m', 'inicio')
  // +3 −1 por commitar: "linha 2" trocada, duas linhas novas.
  fs.writeFileSync(path.join(ws.project, 'app.txt'), 'linha 1\nlinha 2 alterada\nlinha 3\nlinha 4\nlinha 5\n')

  const stdioScript = path.join(ws.work, 'stdio-falso.cjs')
  fs.writeFileSync(stdioScript, STDIO_SERVER)
  const failFlag = path.join(ws.work, 'servidor-quebrado.flag')
  fs.writeFileSync(failFlag, 'enquanto este arquivo existir o servidor falha ao iniciar')
  const unauthorized = await startUnauthorized()
  const healthy = (name) => ({ name, command: process.execPath, args: [stdioScript], enabled: true })
  fs.writeFileSync(path.join(ws.profile, 'config', 'settings.json'), JSON.stringify({
    importClaudeSettings: false,
    claudeCatalogImported: true,
    selfRepair: { enabled: false },
    mcpServers: [
      healthy('saudavel-a'), healthy('saudavel-b'), healthy('saudavel-c'), healthy('saudavel-d'), healthy('saudavel-e'),
      { name: 'servidor-quebrado', command: process.execPath, args: [stdioScript], env: { FAIL_IF_FILE: failFlag }, enabled: true },
      { name: 'pede-login', type: 'http', url: `http://127.0.0.1:${unauthorized.port}/mcp`, command: '', args: [], enabled: true }
    ]
  }, null, 2))

  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const result = { checks, shots: [], states: {} }
  const shot = async (name) => {
    await page.waitForTimeout(300)
    const file = path.join(OUT, name)
    await page.screenshot({ path: file })
    result.shots.push(file)
  }
  const waitFor = async (label, probe, timeoutMs = 30000) => {
    const started = Date.now()
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error(`tempo esgotado esperando: ${label}`)
      await sleep(400)
    }
  }
  const stateOf = async (name) => {
    const states = (await page.evaluate(async () => (await window.openclod.app.connectorStates()).value)) ?? []
    return states.find((item) => item.serverName === name || item.id === name)
  }
  const row = (name) => page.locator('.connector-list li', { hasText: name }).first()
  const shownNames = async () => (await page.locator('.connector-list li > span:nth-child(2)').allTextContents()).slice(2)

  try {
    // 1. Os três estados no backend antes de olhar a tela.
    await waitFor('saudavel-a conectado', async () => (await stateOf('saudavel-a'))?.status === 'connected', 60000)
    await waitFor('servidor-quebrado em erro', async () => (await stateOf('servidor-quebrado'))?.status === 'error', 120000)
    await waitFor('pede-login precisando entrar', async () => (await stateOf('pede-login'))?.status === 'needs-auth', 60000)
    for (const name of ['saudavel-a', 'servidor-quebrado', 'pede-login']) result.states[name] = (await stateOf(name))?.status

    // 2. A sessão e o painel.
    await e2e.newSession(page, { folder: ws.project, title: 'Painel', projectName: 'Projeto painel' })
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Painel', 'Projeto painel')
    await page.locator('button[aria-label="Painel lateral da sessão"]').click()
    await page.waitForSelector('.context-top', { timeout: 15000 })
    await waitFor('conectores no painel', async () => (await row('pede-login').count()) > 0, 30000)

    // 3. Conectores.
    check('"pede-login" (401) mostra Autenticar', (await row('pede-login').locator('button.connector-action').textContent()) === 'Autenticar')
    check('"servidor-quebrado" mostra Reconectar', (await row('servidor-quebrado').locator('button.connector-action').textContent()) === 'Reconectar')
    check('um conector saudável mostra as ferramentas', /1 ferramenta/.test((await row('saudavel-a').textContent()) ?? ''), await row('saudavel-a').textContent())
    const names = await shownNames()
    check('os que pedem atenção vêm primeiro', names[0] === 'pede-login' && names[1] === 'servidor-quebrado', names)
    check('5 conectores visíveis antes de "Mostrar mais"', names.length === 5, names)
    const more = page.locator('button.connector-more')
    check('"Mostrar mais (2)"', /Mostrar mais \(2\)/.test((await more.textContent()) ?? ''), await more.textContent())

    // 4. Contexto: as linhas são da janela e somam 100%.
    const ctx = await page.evaluate(() => {
      const card = document.querySelector('.context-top')?.closest('.panel-card')
      const rows = [...(card?.querySelectorAll('.context-rows li') ?? [])].map((li) => ({
        label: li.querySelector('.ctx-label')?.textContent ?? '',
        pct: parseFloat((li.querySelector('.ctx-pct')?.textContent ?? '0').replace(',', '.'))
      }))
      return { rows, foot: (card?.querySelector('.context-foot')?.textContent ?? '').replace(/\s+/g, ' ') }
    })
    result.context = ctx
    const buffer = ctx.rows.find((item) => item.label === 'Buffer de auto-compact')
    check('linha "Buffer de auto-compact" (25% da janela)', Boolean(buffer) && Math.abs(buffer.pct - 25) < 0.2, buffer)
    check('linha "Espaço livre"', ctx.rows.some((item) => item.label === 'Espaço livre'))
    const sum = ctx.rows.reduce((total, item) => total + item.pct, 0)
    check('as porcentagens somam 100% da janela', Math.abs(sum - 100) <= 1.5, sum.toFixed(1))
    check('rodapé: quanto falta para o auto-compact', /até o auto-compact|auto-compact no próximo pedido/.test(ctx.foot), ctx.foot)
    check('o rodapé antigo "até a janela" sumiu', !/até a janela/.test(ctx.foot), ctx.foot)

    // 5. Ambiente e Alterações.
    const env = await page.locator('.env-list .env-row').allTextContents()
    check('Ambiente mostra a branch "main"', env.some((text) => text.trim().startsWith('main')), env)
    const diff = ((await page.locator('.diff-total').textContent()) ?? '').replace(/\s+/g, ' ')
    // The app itself adds files to the project (CLAUDE.md when there is none): the count is whatever git reports, and a new
    // file adds no lines to the total (like `git diff --stat`).
    const porcelain = git(ws.project, 'status', '--porcelain', '--untracked-files=all').trim().split('\n').filter(Boolean)
    result.gitFiles = porcelain
    // Read from its own element: the button's textContent glues "−1" and "2 arquivos" into "−12 arquivos".
    const files = Number(/(\d+) arquivos?/.exec((await page.locator('.diff-total > span').textContent()) ?? '')?.[1] ?? -1)
    check('Alterações mostra o total +3 −1 da árvore de trabalho', /\+3/.test(diff) && /−1/.test(diff), diff)
    check('Alterações conta os mesmos arquivos que o git', files === porcelain.length, `${diff} · git: ${porcelain.join(', ')}`)
    await shot('01-painel-sessao.png')

    await more.click()
    const expanded = await shownNames()
    check('"Mostrar mais" lista os 7 conectores', expanded.length === 7, expanded)
    check('vira "Mostrar menos"', /Mostrar menos/.test((await more.textContent()) ?? ''))
    await shot('02-mostrar-mais.png')

    // 6. Reconectar reconecta de verdade: a causa da falha some e o clique traz o servidor de volta.
    fs.rmSync(failFlag, { force: true })
    await row('servidor-quebrado').locator('button.connector-action').click()
    await waitFor('servidor-quebrado conectado depois de Reconectar', async () => (await stateOf('servidor-quebrado'))?.status === 'connected', 60000)
    await waitFor('a linha mostra as ferramentas', async () => /1 ferramenta/.test((await row('servidor-quebrado').textContent()) ?? ''), 20000)
    check('"Reconectar" trouxe o servidor de volta', true)
    check('depois de reconectar, o botão sumiu', (await row('servidor-quebrado').locator('button.connector-action').count()) === 0)
    await shot('03-depois-de-reconectar.png')

    // 7. Autenticar num conector adicionado à mão leva à tela de Conectores (lá ele informa a credencial).
    await row('pede-login').locator('button.connector-action').click()
    await page.waitForSelector('[data-testid="connectors-panel"]', { timeout: 15000 })
    check('"Autenticar" abriu Personalização → Conectores', true)
    await shot('04-autenticar-abre-conectores.png')

    check('sem erros de página', errors.filter((line) => line.startsWith('pageerror')).length === 0, errors.join(' | '))
  } catch (error) {
    check('roteiro chegou ao fim', false, error.message)
    await shot('erro.png').catch(() => undefined)
  } finally {
    unauthorized.server.close()
    app.cleanup()
  }
  result.ok = ok()
  fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(result, null, 2))
  console.log(`\n${result.ok ? 'PASSOU' : 'FALHOU'} · prints em ${OUT}`)
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
