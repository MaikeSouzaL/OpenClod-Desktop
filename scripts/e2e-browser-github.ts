/**
 * E2E do cenário "criar um repositório pelo navegador", conferindo cada passo — sem tocar numa conta real.
 *
 * Sobe um GitHub-faz-de-conta local (a página "New repository": campo de nome, botão Create, redireciona para a
 * página do repo criado, grava um cookie e faz um fetch de API) e dirige pelo MESMO pipeline das ferramentas do
 * navegador (browser_open → browser_read html → browser_type → browser_click → browser_read → browser_network →
 * browser_cookies), no Chromium isolado (caminho Playwright, sem a extensão nem a conta do usuário). Prova as
 * correções: espera de navegação depois do clique, leitura de HTML, captura a cada ação, rede e cookies.
 *
 *   npx tsx scripts/e2e-browser-github.ts
 *
 * Precisa de Chrome/Edge/Chromium instalado (pula com mensagem se não houver). Saída: matriz JSON + capturas em
 * Prints/browser-github-2026-10-27/; código de saída 1 se alguma verificação falhar.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { BrowserLayer } from '../src/core/browser/layer'
import {
  browserClickTool,
  browserCookiesTool,
  browserNetworkTool,
  browserNewTabTool,
  browserOpenTool,
  browserReadTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserTabsTool,
  browserCloseTabTool,
  browserTypeTool
} from '../src/core/tools/browser'
import type { ToolContext } from '../src/core/tools/types'

type ToolResultLike = { ok: boolean; text: string; data?: Record<string, unknown>; images?: unknown[] }
type Call = { call: string; ok: boolean; ms: number; images: number; data?: Record<string, unknown>; text: string }
type Check = { name: string; pass: boolean; detail?: string }

const REPO = 'OpenClod-Desktop'
const root = process.cwd()
const outputDir = path.join(root, 'Prints', 'browser-github-2026-10-27')
fs.mkdirSync(outputDir, { recursive: true })
const calls: Call[] = []
const checks: Check[] = []
let savedImages = 0

const check = (name: string, pass: boolean, detail?: string): void => {
  checks.push({ name, pass, ...(detail ? { detail } : {}) })
}

function saveImages(label: string, images: unknown[] | undefined): void {
  for (const raw of (images ?? []) as Array<{ data?: unknown; mediaType?: unknown }>) {
    if (typeof raw?.data !== 'string' || savedImages >= 10) continue
    const ext = raw.mediaType === 'image/jpeg' ? 'jpg' : raw.mediaType === 'image/webp' ? 'webp' : 'png'
    fs.writeFileSync(path.join(outputDir, `${label}.${ext}`), Buffer.from(raw.data, 'base64'))
    savedImages++
  }
}

/** The GitHub-like local site: the new-repo form, a create endpoint that redirects, the created page, an API and a cookie. */
function makeServer(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('Set-Cookie', 'logged_in=yes; Path=/')
    if (url.pathname === '/api/availability') {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ name: url.searchParams.get('name'), available: true }))
      return
    }
    if (url.pathname === '/create' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const name = new URLSearchParams(body).get('repository[name]') || 'sem-nome'
        response.writeHead(302, { Location: `/octocat/${encodeURIComponent(name)}` }).end()
      })
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    const created = /^\/octocat\/(.+)$/.exec(url.pathname)
    if (created) {
      const name = decodeURIComponent(created[1])
      response.end(`<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>octocat/${name}</title></head>
<body><header>FakeHub</header><main>
  <h1>octocat/${name}</h1>
  <p>Repositório criado com sucesso.</p>
  <section aria-label="Quick setup"><p>Clone com HTTPS:</p>
    <code>http://127.0.0.1/octocat/${name}.git</code></section>
</main></body></html>`)
      return
    }
    // /new (e qualquer outra rota) devolve o formulário.
    response.end(`<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Novo repositório</title></head>
<body><header>FakeHub</header><main>
  <h1>Criar um novo repositório</h1>
  <form action="/create" method="post">
    <label for="rname">Repository name</label>
    <input id="rname" name="repository[name]" aria-label="Repository name" placeholder="Repository name" autocomplete="off">
    <label for="rdesc">Description</label>
    <textarea id="rdesc" name="repository[description]" aria-label="Description"></textarea>
    <fieldset>
      <label><input type="radio" name="repository[visibility]" value="public" checked> Public</label>
      <label><input type="radio" name="repository[visibility]" value="private"> Private</label>
    </fieldset>
    <button type="submit" aria-label="Create repository">Create repository</button>
  </form>
  <script>fetch('/api/availability?name=probe').then(function(r){return r.json()}).catch(function(){})</script>
</main></body></html>`)
  })
}

async function main(): Promise<number> {
  const server = makeServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const layer = new BrowserLayer({ sessionId: 'e2e-browser-github', mode: 'playwright' })
  const context = {
    sessionId: 'e2e-browser-github', cwd: root, mode: 'web', model: '', vision: true,
    policy: { mode: 'auto', blockedCommands: [], allowedRoots: [], fullAccess: true, allowNetwork: true, allowComputerControl: false, shellTimeoutSec: 300 },
    signal: AbortSignal.timeout(180_000), emit: () => undefined, approve: async () => true, progress: () => undefined, log: () => undefined,
    services: { browser: layer }
  } as unknown as ToolContext

  const invoke = async (callName: string, action: () => Promise<ToolResultLike>, save = false): Promise<Call> => {
    const started = Date.now()
    try {
      const result = await action()
      if (save) saveImages(callName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(), result.images)
      const record: Call = { call: callName, ok: result.ok, ms: Date.now() - started, images: result.images?.length ?? 0, data: result.data, text: String(result.text).slice(0, 800) }
      calls.push(record)
      return record
    } catch (error) {
      const record: Call = { call: callName, ok: false, ms: Date.now() - started, images: 0, text: (error as Error).message.slice(0, 800) }
      calls.push(record)
      return record
    }
  }

  try {
    /* 1. abre a página "New repository" */
    const open = await invoke('browser_open /new', () => browserOpenTool.execute({ url: `${base}/new` }, context), true)
    if (!open.ok && /n[ãa]o foi poss[ií]vel iniciar o Chromium|Chromium/.test(open.text)) {
      console.log(`PULADO: nenhum Chrome/Edge/Chromium para o caminho Playwright — ${open.text.slice(0, 160)}`)
      return 0
    }
    check('browser_open abre a página e já devolve a captura (conferir o passo)', open.ok && open.images >= 1 && /Criar um novo reposit|Repository name/i.test(open.text), `ok=${open.ok} imagens=${open.images}`)

    /* 2. lê o HTML para achar os campos */
    const html = await invoke('browser_read html', () => browserReadTool.execute({ html: true }, context))
    check('browser_read html=true traz as tags/atributos (campo e botão existem)', html.ok && /aria-label="Repository name"/.test(html.text) && /Create repository/.test(html.text), `${html.text.length} chars`)

    /* 3. digita o nome do repositório */
    const typed = await invoke('browser_type nome', () => browserTypeTool.execute({ role: 'textbox', name: 'Repository name', value: REPO }, context), true)
    check('browser_type preenche o campo e devolve a captura', typed.ok && typed.images >= 1, `ok=${typed.ok} imagens=${typed.images}`)
    const afterType = await invoke('browser_read html (confere o valor)', () => browserReadTool.execute({ html: true }, context))
    check('o valor digitado aparece no HTML do campo', afterType.text.includes(`value="${REPO}"`), afterType.text.includes(`value="${REPO}"`) ? REPO : 'valor não encontrado')

    /* 4. clica em "Create repository" — tem que esperar a navegação e cair na página do repo */
    await invoke('browser_click Create repository', () => browserClickTool.execute({ role: 'button', name: 'Create repository' }, context), true)
    const afterClick = await invoke('browser_snapshot (página resultante)', () => browserSnapshotTool.execute({}, context), true)
    const resultUrl = String((afterClick.data as { url?: string } | undefined)?.url ?? '')
    check('depois do clique a navegação assentou na página do repo criado (/octocat/…)', resultUrl.includes(`/octocat/${REPO}`), `url=${resultUrl}`)

    /* 5. confere o conteúdo da página do repo */
    const result = await invoke('browser_read (página do repo)', () => browserReadTool.execute({}, context))
    check('a página confirma o repositório criado, com o nome e a URL de clone', /Reposit[óo]rio criado/i.test(result.text) && result.text.includes(`octocat/${REPO}`) && result.text.includes(`${REPO}.git`), result.text.replace(/\s+/g, ' ').slice(0, 160))

    /* 6. rede: as requisições do fluxo foram capturadas */
    const net = await invoke('browser_network', () => browserNetworkTool.execute({}, context))
    check('browser_network capturou as requisições do fluxo (API, create/navegação)', net.ok && /\/api\/availability|\/create|\/octocat\//.test(net.text), net.text.replace(/\s+/g, ' ').slice(0, 160))

    /* 7. cookies: lê o que o site gravou e grava/relê um novo */
    const cookies = await invoke('browser_cookies get', () => browserCookiesTool.execute({ action: 'get' }, context))
    check('browser_cookies lê o cookie que o site gravou (logged_in)', /logged_in=yes/.test(cookies.text), cookies.text.replace(/\s+/g, ' ').slice(0, 120))
    await invoke('browser_cookies set', () => browserCookiesTool.execute({ action: 'set', name: 'tema', value: 'escuro' }, context))
    const cookies2 = await invoke('browser_cookies get (depois do set)', () => browserCookiesTool.execute({ action: 'get' }, context))
    check('browser_cookies grava e relê um cookie novo (tema=escuro)', /tema=escuro/.test(cookies2.text), cookies2.text.replace(/\s+/g, ' ').slice(0, 120))

    /* 8. abas: abre uma nova, lista, fecha */
    const newTab = await invoke('browser_new_tab /new', () => browserNewTabTool.execute({ url: `${base}/new` }, context), true)
    const tabId = String((newTab.data as { tab?: string } | undefined)?.tab ?? '')
    const tabs = await invoke('browser_tabs', () => browserTabsTool.execute({}, context))
    check('browser_new_tab + browser_tabs: duas abas, uma ativa', (tabs.text.match(/\n|^/g) ? tabs.text.split('\n').filter(Boolean).length : 0) >= 2 && tabs.text.includes('*'), tabs.text.replace(/\s+/g, ' ').slice(0, 160))
    if (tabId) await invoke('browser_close_tab', () => browserCloseTabTool.execute({ tab: tabId }, context))

    await invoke('browser_screenshot final', () => browserScreenshotTool.execute({}, context), true)
  } finally {
    await layer.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const failed = checks.filter((item) => !item.pass)
  const unexpected = calls.filter((item) => !item.ok && !/esperada/.test(item.call))
  const summary = {
    generatedAt: new Date().toISOString(), scenario: 'criar repositório pelo navegador (GitHub-fake local)',
    totalCalls: calls.length, unexpectedFailures: unexpected.map((item) => ({ call: item.call, text: item.text })),
    checks, calls
  }
  fs.writeFileSync(path.join(outputDir, 'browser-github-matrix.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  console.log(`\n===== E2E: criar repositório pelo navegador =====`)
  console.log(`chamadas: ${calls.length} · verificações: ${checks.length - failed.length}/${checks.length} ok`)
  for (const item of checks) console.log(`  ${item.pass ? 'ok   ' : 'FALHOU'} ${item.name}${item.detail ? ` -> ${item.detail}` : ''}`)
  if (unexpected.length) {
    console.log(`\nfalhas inesperadas:`)
    for (const item of unexpected) console.log(`  ${item.call}: ${item.text.slice(0, 160)}`)
  }
  console.log(`\nmatriz: ${path.relative(root, path.join(outputDir, 'browser-github-matrix.json'))}`)
  return failed.length === 0 && unexpected.length === 0 ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('ERRO no E2E do navegador:', error)
    process.exit(2)
  })
