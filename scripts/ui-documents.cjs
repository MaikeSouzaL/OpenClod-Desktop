// End-to-end DOCX extraction through the real agent tool and Electron transcript.
// Uses a REAL model (DeepSeek by default; only the key vault is borrowed from the real profile): the model must
// load and call document_extract with arguments we control; the check is on the tool call and the tool RESULT
// (citation, extracted text, hit summary), never on the model's wording.
//
//   node scripts/ui-documents.cjs [outDir] [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
const fs = require('node:fs')
const path = require('node:path')
const { strToU8, zipSync } = require('fflate')
const e2e = require('./lib/e2e.cjs')

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'documents-2026-10-25'))
const PORT = 9357
const TITLE = 'Ler DOCX'
const PROJECT = 'Documentos E2E'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-doc-ui-' })
  fs.writeFileSync(path.join(ws.project, 'brief.docx'), Buffer.from(zipSync({
    'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Arquitetura do Openclod</w:t></w:r></w:p><w:p><w:r><w:t>Todos os testes passaram.</w:t></w:r></w:p></w:body></w:document>')
  })))
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
      'Use a ferramenta document_extract (ela não está no conjunto básico: carregue-a antes com tool_load) uma única vez, com path="brief.docx" e query="testes". Depois me diga, citando o arquivo, o trecho que ela encontrou.'
    )
    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 240000 })
    result.seconds = Math.round((Date.now() - started) / 1000)
    check('turno-terminou-sem-erro', settled.run !== 'error', settled.run)
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(OUT, '01-document-tool.png'), fullPage: true })

    const activity = await e2e.toolActivity(page, session.sessionId)
    const call = activity.calls.find((item) => item.name === 'document_extract')
    check('modelo-chamou-document_extract', Boolean(call), activity.calls.map((item) => item.name))
    check('argumentos-path-e-query', Boolean(call && call.args && call.args.path === 'brief.docx' && /testes/i.test(String(call.args.query))), call && call.args)
    const output = activity.results.find((item) => item.name === 'document_extract')
    check('resultado-ok', Boolean(output && output.ok), output && { ok: output.ok, text: output.text.slice(0, 200) })
    check('resultado-cita-brief.docx#1', Boolean(output && /brief\.docx#1/.test(output.text)), output && output.text.slice(0, 200))
    check('resultado-traz-o-texto-extraido', Boolean(output && /Todos os testes passaram/.test(output.text)), output && output.text.slice(0, 200))
    check('resumo-1-trecho-em-1-documento', Boolean(output && /1 trecho\(s\) em 1 documento\(s\)/.test(output.summary)), output && output.summary)

    result.usage = await e2e.usageOf(page, session.sessionId)
    result.errors = errors
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    result.ok = ok()
    result.screenshot = path.join(OUT, '01-document-tool.png')
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
