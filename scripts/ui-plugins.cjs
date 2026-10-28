// End-to-end local plugin install/activation/tool execution through Electron.
// Uses a REAL model (DeepSeek by default; only the key vault is borrowed from the real profile): the model must
// load and call the plugin tool by name; the check is on the structural result (tool call + tool result in the
// transcript and the plugin UI), never on the model's wording.
//
//   node scripts/ui-plugins.cjs [outDir] [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'plugins-2026-10-25'))
const PORT = 9365
const TITLE = 'Executar plugin'
const PROJECT = 'Plugin E2E'
const TOOL = 'plugin__acme-tool__echo'
const MESSAGE = 'olá do subprocesso'
fs.mkdirSync(OUT, { recursive: true })

function writePlugin(profile) {
  const plugin = path.join(profile, 'plugins', 'acme-tool')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(profile, 'plugins', 'state.json'), JSON.stringify({ version: 1, enabled: ['acme-tool'] }))
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'acme-tool',
    name: 'Acme Tool',
    version: '1.2.3',
    description: 'Plugin local de demonstração',
    author: 'E2E',
    apiVersion: '1.0',
    runtime: 'node',
    main: 'index.cjs',
    permissions: ['workspace:read'],
    contributions: {
      tools: [{ key: 'echo', name: 'Echo', description: 'Repete uma mensagem', risk: 'read', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }]
    }
  }))
  fs.writeFileSync(path.join(plugin, 'index.cjs'), `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({ok:true,text:'plugin respondeu: '+r.args.message,summary:'echo do plugin'}))})`)
}

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-plugins-ui-' })
  writePlugin(ws.profile)
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const result = { model: undefined, seconds: 0, checks, usage: undefined, errors: [] }
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: TITLE, projectName: PROJECT })
    result.model = `${session.provider}/${session.model}`
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, TITLE, PROJECT)

    const started = Date.now()
    await e2e.send(
      page,
      `Use a ferramenta de plugin ${TOOL} com message="${MESSAGE}". Ferramentas de plugin só entram no pedido depois de tool_load: carregue-a com tool_load e então chame ${TOOL} uma única vez. Depois diga em uma frase o que ela devolveu.`
    )
    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000 })
    result.seconds = Math.round((Date.now() - started) / 1000)
    const activity = await e2e.toolActivity(page, session.sessionId)
    check('turno-terminou-sem-erro', settled.run !== 'error', settled.run)

    const call = activity.calls.find((item) => item.name === TOOL)
    check('modelo-chamou-a-ferramenta-do-plugin', Boolean(call), activity.calls.map((item) => item.name))
    check('argumento-message-correto', call && call.args && call.args.message === MESSAGE, call && call.args)
    const output = activity.results.find((item) => item.name === TOOL)
    check('resultado-da-ferramenta-veio-do-subprocesso', Boolean(output && output.ok && output.text.includes(`plugin respondeu: ${MESSAGE}`)), output)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT, '00-plugin-tool-no-chat.png'), fullPage: true })

    await page.locator('nav.side-nav .side-row', { hasText: 'Personalização' }).click()
    await page.getByRole('tab', { name: /Plugins/ }).click()
    await page.waitForSelector('.installed-plugin')
    await page.screenshot({ path: path.join(OUT, '01-installed-plugin.png'), fullPage: true })
    const ui = await page.evaluate(() => ({
      pluginName: document.querySelector('.installed-plugin strong')?.textContent?.replace(/\s+/g, ' ').trim(),
      toolChip: document.querySelector('.plugin-tool-chips code')?.textContent,
      toggle: [...document.querySelectorAll('.installed-plugin-actions button')].map((button) => button.textContent?.trim())
    }))
    check('ui-do-plugin-completa', Boolean(ui.pluginName?.includes('Acme Tool') && ui.toolChip === 'echo:read' && ui.toggle.includes('Desativar')), ui)

    result.usage = await e2e.usageOf(page, session.sessionId)
    result.errors = errors
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    result.ok = ok()
    result.screenshot = path.join(OUT, '01-installed-plugin.png')
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    app.cleanup()
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
