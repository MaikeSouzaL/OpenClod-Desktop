// End-to-end image inspect, edit and generation through the real agent tools.
// The LLM is REAL (DeepSeek by default; only the key vault is borrowed from the real profile): it must load and
// call image_inspect / image_edit / image_generate with arguments we control. The image-GENERATION backend is
// the only thing still stubbed (a local HTTP server on OPENCLOD_IMAGE_BASE_URL that returns a fixed 64x64 PNG),
// because there is no image-API key in the profile; it is not a language model. Checks are structural (files on
// disk, their metadata, the stub's request log, tool calls/results), never the model's wording.
//
//   node scripts/ui-images.cjs [outDir] [--from "%APPDATA%\Openclod Desktop"] [--provider deepseek]
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const sharp = require('sharp')
const e2e = require('./lib/e2e.cjs')

// Without this sharp keeps its input/output files open (Windows), so the throwaway project could not be deleted.
sharp.cache(false)

const OUT = e2e.outDir(path.join(e2e.ROOT, 'Prints', 'images-2026-10-25'))
const PORT = 9361
const TITLE = 'Editar imagens'
const PROJECT = 'Imagens E2E'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const ws = e2e.makeWorkspace({ real: true, prefix: 'openclod-images-ui-' })
  const source = path.join(ws.project, 'source.png')
  await sharp({ create: { width: 320, height: 180, channels: 4, background: { r: 24, g: 58, b: 90, alpha: 0.8 } } }).png().toFile(source)
  const generated = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#e1a95f' } }).png().toBuffer()
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      // Only method/url are kept: the request carries credentials in its headers, which are never logged.
      requests.push({ url: request.url, method: request.method, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const imagePort = server.address().port

  const app = await e2e.launch({ port: PORT, ...ws, env: { OPENCLOD_IMAGE_BASE_URL: `http://127.0.0.1:${imagePort}/v1` } })
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
      'Execute estas três ferramentas, nesta ordem, uma única vez cada (elas não estão no conjunto básico: carregue-as antes com tool_load, todas de uma vez): ' +
        '1) image_inspect com path="source.png"; ' +
        '2) image_edit com input="source.png", output="edited.webp", width=50, height=50, fit="cover", rotate=90, format="webp", quality=75; ' +
        '3) image_generate com prompt="painel de controle escuro", output="generated.png", width=64, height=64. ' +
        'Depois diga só "pronto".'
    )
    const settled = await e2e.waitSettled(page, session.sessionId, { timeoutMs: 300000 })
    result.seconds = Math.round((Date.now() - started) / 1000)
    check('turno-terminou-sem-erro', settled.run !== 'error', settled.run)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT, '01-image-tools.png'), fullPage: true })

    const activity = await e2e.toolActivity(page, session.sessionId)
    const callOf = (name) => activity.calls.find((item) => item.name === name)
    const resultOf = (name) => activity.results.find((item) => item.name === name)
    for (const name of ['image_inspect', 'image_edit', 'image_generate']) {
      check(`modelo-chamou-${name}`, Boolean(callOf(name)), activity.calls.map((item) => item.name))
      check(`${name}-resultado-ok`, Boolean(resultOf(name)?.ok), resultOf(name) && { ok: resultOf(name).ok, text: resultOf(name).text.slice(0, 200) })
    }
    const edit = callOf('image_edit')?.args ?? {}
    check('image_edit-argumentos', edit.input === 'source.png' && edit.output === 'edited.webp' && edit.width === 50 && edit.height === 50 && edit.fit === 'cover' && edit.rotate === 90 && edit.format === 'webp' && edit.quality === 75, edit)
    const gen = callOf('image_generate')?.args ?? {}
    check('image_generate-argumentos', gen.output === 'generated.png' && gen.width === 64 && gen.height === 64 && /painel de controle escuro/i.test(String(gen.prompt)), gen)

    const editedPath = path.join(ws.project, 'edited.webp')
    const generatedPath = path.join(ws.project, 'generated.png')
    check('arquivos-de-saida-existem', fs.existsSync(editedPath) && fs.existsSync(generatedPath), { edited: fs.existsSync(editedPath), generated: fs.existsSync(generatedPath) })
    const editedMeta = fs.existsSync(editedPath) ? await sharp(editedPath).metadata() : {}
    const generatedMeta = fs.existsSync(generatedPath) ? await sharp(generatedPath).metadata() : {}
    check('edited.webp-e-webp-50x50', editedMeta.format === 'webp' && editedMeta.width === 50 && editedMeta.height === 50, editedMeta)
    check('generated.png-e-png-64x64', generatedMeta.format === 'png' && generatedMeta.width === 64 && generatedMeta.height === 64, generatedMeta)
    check('endpoint-de-geracao-chamado-uma-vez', requests.length === 1 && requests[0].url.endsWith('/v1/images/generations'), requests.map((request) => ({ url: request.url, method: request.method })))

    result.usage = await e2e.usageOf(page, session.sessionId)
    result.errors = errors
    check('sem-erros-de-console-ou-pagina', errors.length === 0, errors.slice(0, 5))
    result.ok = ok()
    if (fs.existsSync(editedPath)) fs.copyFileSync(editedPath, path.join(OUT, 'edited.webp'))
    if (fs.existsSync(generatedPath)) fs.copyFileSync(generatedPath, path.join(OUT, 'generated.png'))
    result.edited = { format: editedMeta.format, width: editedMeta.width, height: editedMeta.height, path: path.join(OUT, 'edited.webp') }
    result.generated = { format: generatedMeta.format, width: generatedMeta.width, height: generatedMeta.height, path: path.join(OUT, 'generated.png') }
    result.imageRequests = requests.map((request) => ({ url: request.url, method: request.method }))
    result.screenshot = path.join(OUT, '01-image-tools.png')
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    try { server.close() } catch {}
    app.cleanup()
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
