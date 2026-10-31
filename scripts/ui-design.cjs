// End-to-end of "screens designed in FigCraft, delivered as contact sheets" in the real app (throwaway profile with a
// copy of the key vault): a real model loads the design-telas skill, draws a few app screens through the FigCraft MCP
// and calls design_sheet, whose sheets show up in the conversation.
//
// FigCraft runs WITHOUT a window (`figcraft-cli mcp`, no --attach): the run never touches a FigCraft app the user has
// open. Approvals of the throwaway session are answered here: FigCraft, the skill, design_sheet and files of the
// throwaway project are allowed; anything else (computer, browser, shell outside it) is denied.
//
//   node scripts/ui-design.cjs --root <snapshot> [--provider opencode-go --model beam-free] [--out dir] [--minutes 25]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'design-folhas-2026-10-30')))
const FIGCRAFT = e2e.arg('figcraft', 'C:\\Users\\Administrator\\Desktop\\FigCraft\\bin\\figcraft-cli.exe')
const MINUTES = Number(e2e.arg('minutes', '25'))
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const ALLOWED = /^(mcp__figcraft__|design_sheet$|use_skill$|write_file$|edit_file$|read_file$|list_dir$|tool_load$|tool_search$|update_plan$|memory_)/

const PROMPT = [
  'Desenhe no FigCraft 4 telas de celular (390×844) de um app fictício de delivery de comida chamado "Prato Feito":',
  'DEL-INI-01 Início (busca, categorias, restaurantes), DEL-RES-01 Restaurante (cardápio), DEL-CAR-01 Carrinho e DEL-CAR-01b Carrinho vazio.',
  'Siga a skill design-telas. Trabalhe sem janela (FigCraft headless) e, no fim, entregue as telas em folha de contato com design_sheet.',
  'Não use o computador nem o navegador.'
].join(' ')

const shot = async (page, name, locator) => {
  const file = path.join(OUT, `${name}.png`)
  if (locator) await locator.screenshot({ path: file })
  else await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

async function main() {
  const realSettings = JSON.parse(fs.readFileSync(path.join(e2e.FROM(), 'config', 'settings.json'), 'utf8'))
  const ws = e2e.makeWorkspace({
    real: true,
    prefix: 'openclod-design-',
    settingsPatch: {
      policy: { ...realSettings.policy, mode: 'auto', allowComputerControl: false },
      mcpServers: [{ name: 'figcraft', command: FIGCRAFT, args: ['mcp'], env: {}, enabled: true }]
    }
  })
  const app = await e2e.launch({ port: 9493, ...ws })
  const report = { startedAt: new Date().toISOString(), prompt: PROMPT, approvals: [] }
  try {
    const { page } = app
    const session = await e2e.newSession(page, { folder: ws.project, title: 'Telas no FigCraft', projectName: 'Design E2E', mode: 'code' })
    report.provider = `${session.provider}/${session.model}`
    await page.evaluate(({ id, text }) => window.openclod.sessions.send(id, text), { id: session.sessionId, text: PROMPT })
    const started = Date.now()
    let settled = null
    while (Date.now() - started < MINUTES * 60_000) {
      await page.waitForTimeout(3000)
      const state = await page.evaluate(async (id) => {
        const value = (await window.openclod.sessions.get(id)).value
        const last = value.messages[value.messages.length - 1]
        return {
          run: value.state,
          approvals: value.approvals.map((item) => ({ id: item.id, tool: item.tool, preview: String(item.preview ?? '').slice(0, 120) })),
          answered: Boolean(last && last.role === 'assistant' && !last.parts.some((part) => part.type === 'tool_call') && last.parts.some((part) => part.type === 'text' && part.text.trim()))
        }
      }, session.sessionId)
      for (const approval of state.approvals) {
        const allow = ALLOWED.test(approval.tool) || (/^(write_file|edit_file)$/.test(approval.tool) && approval.preview.startsWith(ws.project))
        report.approvals.push({ tool: approval.tool, allow })
        await page.evaluate(({ id, allow }) => window.openclod.approvals.resolve(id, allow), { id: approval.id, allow })
      }
      if (['idle', 'done', 'error', 'cancelled'].includes(state.run) && state.answered) {
        settled = state
        break
      }
    }
    report.minutes = Math.round((Date.now() - started) / 6000) / 10
    check('o turno termina com uma resposta', Boolean(settled), { minutes: report.minutes })

    const activity = await e2e.toolActivity(page, session.sessionId)
    const names = activity.calls.map((call) => call.name)
    report.tools = names.reduce((acc, name) => ({ ...acc, [name]: (acc[name] || 0) + 1 }), {})
    check('carregou a skill design-telas', activity.calls.some((call) => call.name === 'use_skill' && JSON.stringify(call.args).includes('design-telas')), report.tools)
    check('desenhou pelo FigCraft (MCP)', names.filter((name) => name.startsWith('mcp__figcraft__')).length >= 3, report.tools)
    const sheetCall = await page.evaluate(async (id) => {
      const value = (await window.openclod.sessions.get(id)).value
      const results = value.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.name === 'design_sheet')
      return results.map((p) => ({ ok: p.ok, text: String(p.text).slice(0, 600), images: (p.images || []).length, preview: (p.preview || []).length }))
    }, session.sessionId)
    report.sheets = sheetCall
    const good = sheetCall.find((item) => item.ok)
    check('chamou design_sheet e as folhas foram montadas', Boolean(good), sheetCall)
    const files = good ? [...good.text.matchAll(/folha \d+: (.+?\.png)/g)].map((match) => match[1]) : []
    check('os PNG das folhas existem no projeto', files.length > 0 && files.every((file) => fs.existsSync(file)), files)
    for (const [index, file] of files.slice(0, 3).entries()) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(OUT, `folha-${index + 1}.png`))
    }

    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Telas no FigCraft', 'Design E2E').catch(() => undefined)
    await page.waitForTimeout(2500)
    const inChat = await page.evaluate(() => [...document.querySelectorAll('img')].filter((img) => /^data:image\//.test(img.src) && img.naturalWidth > 400).length)
    check('a folha aparece desenhada na conversa', inChat > 0, inChat)
    report.conversation = await shot(page, '01-conversa')
    const reply = await e2e.turnReport(page, session.sessionId)
    report.reply = String(reply.finalText || '').slice(0, 1500)
    check('sem erros no console da tela', app.errors.length === 0, app.errors.slice(0, 3))
  } catch (err) {
    check('sem exceção', false, err.stack || String(err))
    try {
      report.failure = await shot(app.page, 'falha')
    } catch {}
  } finally {
    report.checks = checks
    fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(report, null, 2))
    app.cleanup()
    const values = Object.values(checks)
    console.log(`\n${values.filter((value) => value === 'ok').length}/${values.length} OK · ${path.relative(e2e.ROOT, OUT)}`)
    for (const [name, value] of Object.entries(checks)) console.log(`${value === 'ok' ? 'OK  ' : 'FAIL'} ${name}${value === 'ok' ? '' : ` -> ${value.slice(7, 400)}`}`)
    process.exitCode = ok() ? 0 : 1
  }
}

void main()
