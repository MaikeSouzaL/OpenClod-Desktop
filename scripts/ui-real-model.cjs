// End-to-end check with a REAL model: the whole loop (prompt -> tools -> files on disk) in the real app.
// It starts its own Electron with a THROWAWAY profile and a throwaway project. To reuse a provider
// that is already configured, point --from at an existing profile: only `Local State`, the key vault
// (config/secrets.bin) and a SANITIZED copy of settings.json (no MCP servers, hooks or self-repair) are
// copied (see scripts/lib/e2e.cjs); nothing is written back to the source profile and the copy is deleted at the end.
//
//   node scripts/ui-real-model.cjs [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek] [--out dir] [--only id1,id2]
//
// Each prompt is sent through the real IPC; the transcript is then inspected for the tools the model
// actually used and for the files it produced. Costs a few cents of API usage.
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'tmp', 'ui-real-model')))
const PORT = 9395
const TURN_TIMEOUT_MS = Number(e2e.arg('turn-timeout', 360000))
fs.mkdirSync(OUT, { recursive: true })

const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-real-' })
const project = ws.project

const ALL_PROMPTS = [
  {
    id: 'codigo-e-teste',
    text: 'Neste projeto, crie src/soma.js exportando soma(a, b) e test/soma.test.js usando node:test (node --test). Rode o teste e me diga o resultado real.',
    expectTools: ['write_file', 'run_command'],
    check: (ctx) => fs.existsSync(path.join(project, 'src', 'soma.js')) && fs.existsSync(path.join(project, 'test', 'soma.test.js')) && /passou|pass|aprovad|ok/i.test(ctx.finalText)
  },
  {
    id: 'edicao',
    text: 'Altere soma para converter strings numéricas com Number antes de somar, acrescente um caso de teste para soma("2", "3") e rode os testes de novo.',
    expectAnyTool: ['edit_file', 'patch_file', 'write_file'],
    check: (ctx) => /Number\(/.test(fs.readFileSync(path.join(project, 'src', 'soma.js'), 'utf8'))
  },
  {
    id: 'git',
    text: 'Inicialize um repositório git neste projeto (branch main), faça commit de tudo com uma mensagem em português e mostre o git log.',
    check: (ctx) => fs.existsSync(path.join(project, '.git')) && /commit|log/i.test(ctx.finalText)
  },
  {
    id: 'subagente',
    text: 'Use o agente especialista "reviewer" para revisar o código de src/soma.js e resuma em 3 linhas o que ele achou.',
    expectTools: ['agent'],
    check: (ctx) => ctx.finalText.length > 40
  },
  {
    id: 'svg-skill',
    text: 'Crie um ícone SVG simples de uma lupa em icons/lupa.svg (24x24, traço, currentColor). Siga a skill svg-master e valide com o verificador que ela traz.',
    expectTools: ['use_skill'],
    expectAnyTool: ['write_file', 'agent'],
    check: (ctx) => {
      const file = path.join(project, 'icons', 'lupa.svg')
      return fs.existsSync(file) && /<svg[\s\S]*xmlns=/.test(fs.readFileSync(file, 'utf8'))
    }
  },
  {
    id: 'animacao',
    text: 'Crie um spinner de carregamento animado em SVG em anim/spinner.svg (24x24, traço, currentColor). Siga a skill animation-master e valide com o verificador que ela traz.',
    expectTools: ['use_skill'],
    expectAnyTool: ['write_file', 'agent'],
    check: () => {
      const file = path.join(project, 'anim', 'spinner.svg')
      return fs.existsSync(file) && /<animate|@keyframes|animation/i.test(fs.readFileSync(file, 'utf8'))
    }
  },
  {
    id: 'web',
    text: 'Abra https://example.com e me diga o título da página e a primeira frase do texto principal.',
    check: (ctx) => /example domain/i.test(ctx.finalText)
  },
  {
    id: 'memoria',
    text: 'Registre na memória do projeto a convenção: "testes usam node:test e ficam em test/". Depois confirme o que foi salvo.',
    expectAnyTool: ['memory_page', 'memory_write'],
    check: (ctx) => /node:test/i.test(ctx.finalText)
  }
]

const ONLY = (e2e.arg('only', '') || '').split(',').filter(Boolean)
const PROMPTS = ONLY.length ? ALL_PROMPTS.filter((p) => ONLY.includes(p.id)) : ALL_PROMPTS

async function main() {
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page, errors } = app
  try {
    const created = await e2e.newSession(page, { folder: project, title: 'Modelo real', projectName: 'Projeto real' })
    const configured = await page.evaluate(async (providerId) => {
      const caps = (await window.openclod.app.capabilities()).value
      return caps.providers.find((item) => item.id === providerId)?.configured
    }, created.provider)
    if (!configured) throw new Error(`provedor ${created.provider} sem credencial neste perfil (use --from)`)
    await page.reload()
    await page.waitForSelector('.app-shell')
    await e2e.openSession(page, 'Modelo real', 'Projeto real')

    const report = { model: created.model, defaultProvider: created.provider, turns: [], errors }
    const sessionId = created.sessionId
    for (const [index, prompt] of PROMPTS.entries()) {
      const before = await page.evaluate(async (id) => (await window.openclod.sessions.get(id)).value.messages.length, sessionId)
      const started = Date.now()
      await e2e.send(page, prompt.text)
      let settleError = ''
      try {
        await e2e.waitSettled(page, sessionId, { timeoutMs: TURN_TIMEOUT_MS, sinceCount: before })
      } catch (error) {
        settleError = error.message
      }
      const turn = await e2e.turnReport(page, sessionId, before)
      const seconds = Math.round((Date.now() - started) / 1000)
      const usedAll = (prompt.expectTools || []).every((name) => turn.calls.includes(name))
      const usedAny = !prompt.expectAnyTool || prompt.expectAnyTool.some((name) => turn.calls.includes(name))
      let checked = false
      try { checked = Boolean(prompt.check(turn)) } catch { checked = false }
      report.turns.push({
        id: prompt.id,
        seconds,
        run: turn.run,
        pass: usedAll && usedAny && checked && !settleError,
        usedExpectedTools: usedAll && usedAny,
        outcomeChecked: checked,
        settleError: settleError || undefined,
        toolCalls: turn.calls,
        failedTools: turn.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.text}`),
        finalText: turn.finalText.slice(0, 400)
      })
      await page.screenshot({ path: path.join(OUT, `${String(index + 1).padStart(2, '0')}-${prompt.id}.png`) })
    }
    report.usage = await e2e.usageOf(page, sessionId)
    report.pass = report.turns.filter((t) => t.pass).length
    report.total = report.turns.length
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    app.cleanup()
    process.exit(report.pass === report.total ? 0 : 1)
  } finally {
    app.cleanup()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
