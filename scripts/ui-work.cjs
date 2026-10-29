// End-to-end check of the "agent at work" UI with a REAL model (DeepSeek by default; only the key vault is
// borrowed from the real profile) and real tools. It starts its own Electron with a THROWAWAY profile
// (--user-data-dir) and a throwaway project, so nothing of the user's is touched. The prompts name the tools
// and their arguments; every check is structural (tool calls/results, files on disk, DOM), never the wording.
//
//   node scripts/ui-work.cjs [outDir] [--scenario basic|agents] [--from "%APPDATA%\Openclod Desktop"]
//
// basic:  plan dock, busy dot, tool summaries, edit cards (diff), tasks panel, stopping a background process
//         and the error bar centred over the chat column (uses a provider WITHOUT credentials, no model call).
// agents: the parent delegates to explorer and coder; the coder delegates to tester (agents calling agents).
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'tmp', 'ui-work'))
const PORT = 9334
const positional = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined
const SCENARIO = e2e.arg('scenario', positional || 'basic')
const TITLE = 'Trabalho'
const PROJECT = 'Projeto de teste'
fs.mkdirSync(OUT, { recursive: true })

const PROMPTS = {
  basic:
    'Faça este trabalho executando as ferramentas abaixo EXATAMENTE nesta ordem, uma de cada vez (espere o resultado antes da próxima) e sem inventar passos extras:\n' +
    '1) update_plan com 3 itens: {text:"Ler o README", status:"active"}, {text:"Criar src/util.ts", status:"pending"}, {text:"Conferir o resultado", status:"pending"};\n' +
    '2) run_command com command=`node -e "console.log(1+1)"` e description="Somar dois números";\n' +
    '3) read_file com path="README.md";\n' +
    '4) start_process com command=`node -e "setInterval(()=>console.log(\'tick\'),400)"`, description="Serviço de teste" e wait_ms=1200 (deixe-o rodando em segundo plano);\n' +
    '5) write_file com path="src/util.ts" e content="export const dobro = (n: number) => n * 2\\n";\n' +
    '6) edit_file com path="README.md", old_string="Linha original." e new_string="Linha editada pelo agente.";\n' +
    '7) update_plan de novo: "Ler o README" done, "Criar src/util.ts" done, "Conferir o resultado" active;\n' +
    '8) run_command com command=`node -e "process.exit(3)"` e description="Comando que falha de propósito" (a falha é esperada: NÃO tente corrigir nem repetir).\n' +
    'Depois escreva um resumo curto do que foi feito.',
  agents:
    'Delegue o trabalho com a ferramenta agent, nesta ordem (espere o relatório de cada agente antes do próximo):\n' +
    '1) agent="explorer", label="Mapear o código", prompt="Liste os arquivos .ts do projeto (use glob com **/*.ts) e diga onde ficam as utilidades.";\n' +
    '2) agent="coder", label="Implementar o dobro", prompt="Crie src/dobro.ts exportando dobro(n) que devolve n * 2. Depois PEÇA AO AGENTE TESTER, chamando a ferramenta agent com agent=\\"tester\\", label=\\"Validar o dobro\\" e prompt=\\"Rode um comando que prove que dobro(21) vale 42 (por exemplo node -e com console.log(2*21)) e relate a saída.\\" Resuma o resultado dele.".\n' +
    'Não faça o trabalho você mesmo. Ao final, resuma em uma frase o que cada agente fez.'
}

async function main() {
  if (!PROMPTS[SCENARIO]) throw new Error(`cenário desconhecido: ${SCENARIO} (use basic ou agents)`)
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-ui-work-' })
  fs.mkdirSync(path.join(ws.project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(ws.project, 'README.md'), '# Projeto\n\nLinha original.\n')
  // The explorer needs something to find in the agents scenario; the basic one must create src/util.ts itself.
  if (SCENARIO === 'agents') fs.writeFileSync(path.join(ws.project, 'src', 'util.ts'), 'export const util = true\n')

  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  const { checks, check, ok } = e2e.makeChecks()
  const results = { scenario: SCENARIO, checks }
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
  try {
    const session = await e2e.newSession(page, { folder: ws.project, title: TITLE, projectName: PROJECT })
    results.model = `${session.provider}/${session.model}`
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, TITLE, PROJECT)

    const started = Date.now()
    await e2e.send(page, PROMPTS[SCENARIO])

    // While it works: plan dock (basic scenario), busy dot, running summary
    if (SCENARIO === 'basic') {
      await page.waitForSelector('.plan-dock', { timeout: 90000 })
      results.planWhileRunning = await page.evaluate(() => ({
        header: document.querySelector('.plan-dock-head')?.textContent?.trim(),
        items: [...document.querySelectorAll('.plan-dock-item')].map((item) => `${item.className.match(/status-(\w+)/)?.[1]}:${item.textContent.trim()}`)
      }))
      results.busyDot = await page.locator('.side-busy').count()
      check('plano-aparece-enquanto-trabalha', results.planWhileRunning.items.length >= 3, results.planWhileRunning)
      await shot('01-trabalhando-plano')
    }

    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 420000 })
    results.seconds = Math.round((Date.now() - started) / 1000)
    check('turno-terminou-sem-erro', settled.run !== 'error', settled.run)
    await page.waitForFunction(() => !document.querySelector('.status-line') && document.querySelectorAll('.message.assistant').length > 0, null, { timeout: 60000 })
    await page.waitForTimeout(800)
    const activity = await e2e.toolActivity(page, session.sessionId)
    results.toolCalls = activity.calls.map((call) => call.name)

    if (SCENARIO === 'agents') {
      const delegated = activity.calls.filter((call) => call.name === 'agent').map((call) => call.args && call.args.agent)
      check('pai-delegou-ao-explorer-e-ao-coder', delegated.includes('explorer') && delegated.includes('coder'), delegated)
      results.panelAutoOpened = await page.evaluate(() => document.querySelector('.panel h2')?.textContent)
      if (!results.panelAutoOpened || !results.panelAutoOpened.includes('Tarefas')) {
        await page.locator('.tb-actions [aria-label="Ver opções"]').click()
        await page.locator('.menu-item', { hasText: 'Tarefas em segundo plano' }).click()
        await page.waitForTimeout(600)
      }
      const doneToggle = page.locator('.task-toggle.big')
      if (await doneToggle.count()) await doneToggle.click()
      await page.waitForTimeout(500)
      results.agentCards = await page.evaluate(() =>
        [...document.querySelectorAll('.task-row-card.kind-agent')].map((card) => ({
          title: card.querySelector(':scope > .task-head .task-title-text')?.textContent,
          chip: card.querySelector(':scope > .task-sub .task-agent-chip')?.textContent,
          model: card.querySelector(':scope > .task-sub .task-model')?.textContent,
          time: card.querySelector(':scope > .task-head .task-time')?.textContent,
          counts: card.querySelector(':scope > .task-agent-body > .task-counts')?.textContent,
          nested: [...card.querySelectorAll(':scope > .task-agent-body .task-row-card .task-title-text, :scope > .task-agent-body .task-line .task-line-title')].map((el) => el.textContent)
        }))
      )
      // Finished agent cards start collapsed (they only stay open when the panel was already watching them
      // run): expand the coder card and its "N concluídas" group, then read what hangs under it.
      const coderRow = page.locator('.task-row-card.kind-agent').filter({ has: page.locator('.task-agent-chip', { hasText: /^coder$/ }) }).first()
      if (await coderRow.count()) {
        await coderRow.locator(':scope > .task-head .task-title').click()
        await page.waitForTimeout(300)
        const group = coderRow.locator(':scope > .task-agent-body > .task-toggle').first()
        if (await group.count()) {
          await group.click()
          await page.waitForTimeout(300)
        }
        results.coderBody = await coderRow.locator(':scope > .task-agent-body').innerText().catch(() => '')
        results.coderNested = await coderRow.evaluate((card) =>
          [...card.querySelectorAll(':scope > .task-agent-body .task-row-card .task-title-text, :scope > .task-agent-body .task-line .task-line-title')].map((el) => el.textContent)
        )
        await page.waitForTimeout(300)
      }
      results.strip = await page.locator('.subagent-chip').allTextContents()
      results.sidebarDot = await page.locator('.side-busy').count()
      results.diskDobro = fs.existsSync(path.join(ws.project, 'src', 'dobro.ts'))
      check('cards-de-agente-no-painel', results.agentCards.length >= 2, results.agentCards.map((card) => card.title))
      check('card-do-explorer-e-do-coder', results.agentCards.some((card) => /explorer/i.test(`${card.chip} ${card.title}`)) && results.agentCards.some((card) => /coder/i.test(`${card.chip} ${card.title}`)), results.agentCards.map((card) => `${card.chip}|${card.title}`))
      const coderCard = results.agentCards.find((card) => /coder/i.test(`${card.chip} ${card.title}`))
      check('tester-aparece-aninhado-no-coder', Boolean((results.coderNested || []).some((text) => /Validar o dobro/i.test(text || ''))), { nested: results.coderNested, body: String(results.coderBody || '').slice(0, 300) })
      check('coder-escreveu-src-dobro.ts', results.diskDobro && /dobro/.test(fs.readFileSync(path.join(ws.project, 'src', 'dobro.ts'), 'utf8')))
      await shot('07-agentes-painel')
    } else {
      // The tools the prompt named were really used, in the transcript.
      for (const name of ['update_plan', 'run_command', 'read_file', 'start_process', 'write_file', 'edit_file']) {
        check(`ferramenta-usada-${name}`, results.toolCalls.includes(name), results.toolCalls)
      }
      const failing = activity.calls.find((call) => call.name === 'run_command' && /process\.exit\(3\)/.test(String(call.args && call.args.command)))
      const failingResult = failing && activity.results.find((item) => item.toolCallId === failing.id)
      check('comando-que-falha-voltou-como-falha', Boolean(failingResult && failingResult.ok === false), failingResult && failingResult.text.slice(0, 120))

      results.summaries = await page.locator('.tool-group-text').allTextContents()
      results.editCards = await page.evaluate(() =>
        [...document.querySelectorAll('.edit-card')].map((card) => ({
          path: card.querySelector('.edit-card-path')?.textContent,
          counts: card.querySelector('.edit-card-count')?.textContent?.replace(/\s+/g, ' ').trim(),
          added: [...card.querySelectorAll('.edit-line.add .edit-text')].map((line) => line.textContent),
          removed: [...card.querySelectorAll('.edit-line.del .edit-text')].map((line) => line.textContent)
        }))
      )
      results.diskUtil = fs.existsSync(path.join(ws.project, 'src', 'util.ts')) ? fs.readFileSync(path.join(ws.project, 'src', 'util.ts'), 'utf8') : null
      results.diskReadme = fs.readFileSync(path.join(ws.project, 'README.md'), 'utf8')
      results.planAfter = await page.locator('.plan-dock').count()
      results.busyAfter = await page.locator('.side-busy').count()
      check('resumos-de-ferramentas-na-conversa', results.summaries.length >= 1, results.summaries.length)
      check('src-util.ts-no-disco', Boolean(results.diskUtil && /dobro/.test(results.diskUtil)), results.diskUtil)
      check('README-editado-no-disco', results.diskReadme.includes('Linha editada pelo agente.') && !results.diskReadme.includes('Linha original.'), results.diskReadme)
      const readmeCard = results.editCards.find((card) => /README\.md$/.test(card.path || ''))
      check('card-de-edicao-mostra-o-diff-do-README', Boolean(readmeCard && readmeCard.added.join(' ').includes('Linha editada pelo agente.') && readmeCard.removed.join(' ').includes('Linha original.')), readmeCard || results.editCards)
      check('ponto-ocupado-some-ao-terminar', results.busyAfter === 0, results.busyAfter)
      await shot('02-concluido')

      // Tasks panel
      await page.locator('.tb-actions [aria-label="Ver opções"]').click()
      await page.locator('.menu-item', { hasText: 'Tarefas em segundo plano' }).click()
      await page.waitForSelector('.tasks-panel, .panel .panel-empty', { timeout: 5000 })
      await page.waitForTimeout(800)
      results.tasksPanel = await page.evaluate(() => ({
        toolbar: document.querySelector('.tasks-toolbar')?.textContent?.trim(),
        titles: [...document.querySelectorAll('.task-row-card .task-title-text')].map((el) => el.textContent),
        times: [...document.querySelectorAll('.task-row-card .task-time')].map((el) => el.textContent),
        failedMarks: document.querySelectorAll('.task-failed').length
      }))
      check('painel-lista-o-processo-em-segundo-plano', results.tasksPanel.titles.some((title) => /Serviço de teste/i.test(title || '')), results.tasksPanel.titles)
      await shot('03-tarefas')
      const doneToggle = page.locator('.task-toggle.big')
      if (await doneToggle.count()) {
        await doneToggle.click()
        await page.waitForTimeout(300)
        results.tasksFinished = await page.evaluate(() => [...document.querySelectorAll('.task-row-card .task-title-text')].map((el) => el.textContent))
        check('painel-lista-tambem-os-concluidos', results.tasksFinished.length >= results.tasksPanel.titles.length, results.tasksFinished)
        results.failedMarksFinished = await page.locator('.task-failed').count()
        check('comando-que-falhou-vem-marcado-como-falha', results.failedMarksFinished >= 1, results.failedMarksFinished)
        await shot('04-tarefas-concluidas')
      }
      // Stop the background process from the panel
      const stop = page.locator('.task-stop').first()
      if (await stop.count()) {
        await stop.click()
        await page.waitForTimeout(1500)
        results.afterStop = await page.evaluate(() => document.querySelector('.tasks-toolbar')?.textContent?.trim())
        check('parar-pelo-painel-encerra-o-processo', /nada em execu/i.test(results.afterStop || ''), results.afterStop)
      } else {
        check('parar-pelo-painel-encerra-o-processo', false, 'botão de parar não encontrado')
      }

      // Error bar must be centred over the chat column (the composer's column), with and without the side panel.
      // A provider WITHOUT credentials is picked, so the send fails locally and no model is called.
      const noKey = await page.evaluate(async (projectPath) => {
        const settings = (await window.openclod.app.settings()).value
        const caps = (await window.openclod.app.capabilities()).value
        const target = settings.providers.find((item) => caps.providers.find((cap) => cap.id === item.id)?.configured === false)
        if (!target) return { error: 'todos os provedores têm credencial neste perfil' }
        const projects = (await window.openclod.projects.list()).value
        const proj = projects.find((item) => item.path === projectPath) || projects[0]
        const created = await window.openclod.sessions.create({ projectId: proj.id, cwd: proj.path, mode: 'code', surface: 'code', providerId: target.id, model: target.model, title: 'Sem credencial' })
        return created.ok ? { provider: target.id } : { error: created.error }
      }, ws.project)
      check('provedor-sem-credencial-disponivel', !noKey.error, noKey)
      if (!noKey.error) {
        await page.reload()
        await page.waitForSelector('.app-shell')
        await page.locator('.mode-switch button', { hasText: 'Code' }).click()
        await page.waitForTimeout(300)
        await page.locator('.side-session', { hasText: 'Sem credencial' }).first().click()
        await page.waitForTimeout(500)
        await page.locator('textarea[aria-label="Mensagem"]').fill('oi')
        await page.locator('textarea[aria-label="Mensagem"]').press('Enter')
        await page.waitForSelector('.error-bar', { timeout: 10000 })
        const measure = () =>
          page.evaluate(() => {
            const box = (selector) => {
              const rect = document.querySelector(selector)?.getBoundingClientRect()
              return rect ? Math.round(rect.left + rect.width / 2) : null
            }
            return { errorCenter: box('.error-bar'), composerCenter: box('.composer'), workspaceCenter: box('.workspace'), windowCenter: Math.round(window.innerWidth / 2) }
          })
        results.errorBarNoPanel = await measure()
        await shot('05-erro-centralizado')
        await page.locator('.tb-actions [aria-label="Terminal"]').click()
        await page.waitForTimeout(800)
        results.errorBarWithPanel = await measure()
        await shot('06-erro-centralizado-com-painel')
        const centred = (m) => m.errorCenter !== null && m.composerCenter !== null && Math.abs(m.errorCenter - m.composerCenter) <= 3
        check('barra-de-erro-centralizada-sem-painel', centred(results.errorBarNoPanel), results.errorBarNoPanel)
        check('barra-de-erro-centralizada-com-painel', centred(results.errorBarWithPanel), results.errorBarWithPanel)
      }
    }

    results.usage = await e2e.usageOf(page, session.sessionId)
    results.errors = errors
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    results.ok = ok()
    fs.writeFileSync(path.join(OUT, `evidence-${SCENARIO}.json`), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  } finally {
    app.cleanup()
  }
  process.exit(results.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
