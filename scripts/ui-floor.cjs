// The floor of a conversation: what the very first request of a brand-new session costs, as the PROVIDER counts it
// (usage of the first call of a session that only says "ola"), plus the app's own breakdown of it.
//
//   node scripts/ui-floor.cjs --label before --root <snapshot folder> [--samples 2] [--out docs/medicoes]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'build')
const SAMPLES = Number(e2e.arg('samples', '2'))
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'docs', 'medicoes')))
const PORT = Number(e2e.arg('port', '9451'))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-floor-' })
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  const result = { label: LABEL, root: process.argv.includes('--root') ? e2e.arg('root') : 'working-tree', startedAt: new Date().toISOString(), samples: [] }
  try {
    for (let index = 1; index <= SAMPLES; index++) {
      const title = `Piso ${index}`
      const session = await e2e.newSession(page, { folder: ws.project, title, projectName: 'Projeto piso' })
      await page.reload()
      await page.waitForSelector('.app-shell')
      await e2e.openSession(page, title, 'Projeto piso')
      await e2e.send(page, 'ola')
      await e2e.waitSettled(page, session.sessionId, { timeoutMs: 180000 })
      const sample = await page.evaluate(async (id) => {
        const value = (await window.forja.sessions.get(id)).value
        const calls = value.messages.filter((message) => message.role === 'assistant' && message.usage)
        const meter = (await window.forja.sessions.contextBreakdown(id)).value
        return { firstInput: calls[0] ? calls[0].usage.input : 0, firstCached: calls[0] ? calls[0].usage.cachedInput || 0 : 0, calls: calls.length, meter }
      }, session.sessionId)
      if (!sample.firstInput) {
        // The model never answered (no credit, quota, rate limit): there is nothing to write down.
        console.error(`amostra ${index}: o modelo não respondeu — ${await e2e.failureOf(page, session.sessionId)}. Nada foi gravado.`)
        process.exitCode = 3
        return
      }
      const model = await e2e.checkModel(page, session)
      if (!model.ok) {
        console.error(`amostra ${index}: o modelo trocou durante a execução (${model.expected.providerId}/${model.expected.model} → ${model.actual.providerId}/${model.actual.model}). Nada foi gravado.`)
        process.exitCode = 3
        return
      }
      result.model = `${model.actual.providerId}/${model.actual.model}`
      result.samples.push(sample)
      console.log(`amostra ${index}: primeira chamada = ${sample.firstInput} tokens (${sample.firstCached} em cache) em ${result.model}`)
    }
    result.firstInput = result.samples.map((sample) => sample.firstInput)
    result.breakdown = Object.fromEntries((result.samples.at(-1).meter?.items ?? []).map((item) => [item.id, item.tokens]))
    result.errors = app.errors.filter((line) => line.startsWith('pageerror'))
  } finally {
    app.cleanup()
  }
  const file = path.join(OUT, `piso-${LABEL}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ label: LABEL, primeiraChamada: result.firstInput, estimativaDoApp: result.breakdown }, null, 2))
  console.log('gravado em', file)
}

main().catch((error) => {
  console.error('ERRO', error)
  process.exit(2)
})
