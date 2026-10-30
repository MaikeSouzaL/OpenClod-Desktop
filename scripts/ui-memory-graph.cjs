// End-to-end of the Memória screen on a big memory, in the real app (Electron, throwaway profile: the user's app and profile
// are not touched). Copies a real wiki (default: the biggest project of the user's profile, read only) into the throwaway
// profile, seeds a few files in the memory and checks:
//   - the counters of files by kind (pictures, PDFs, documents, sheets, audio, video) are always shown, with how many of
//     each the agent finds by their text, transcript or description;
//   - the graph opens without freezing the app: the main process keeps answering IPC and the screen keeps drawing frames
//     while the graph of thousands of pages is built and laid out; a search goes to the whole memory; a node opens.
//
//   node scripts/ui-memory-graph.cjs [--root <snapshot>] [--wiki <pasta wiki>] [--out dir] [--label nome]
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'grafo')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'memoria-grafo-2026-10-29')))
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

/** The biggest wiki of the user's profile, when none is given. */
function biggestWiki() {
  const projects = path.join(e2e.FROM(), 'data', 'memory', 'projects')
  let best = null
  for (const id of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const wiki = path.join(projects, id, 'wiki')
    if (!fs.existsSync(wiki)) continue
    const count = fs.readdirSync(wiki).filter((name) => name.endsWith('.md')).length
    if (!best || count > best.count) best = { wiki, count }
  }
  return best?.wiki
}

const shot = async (page, name, locator) => {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  await (locator ?? page).screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

/** A file record as the memory keeps it (`files/<slug>/meta.json` + the copy). */
function seedFile(memoryRoot, sourceDir, { name, kind, textChars = 0, description }) {
  const slug = `arquivo-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${crypto.randomBytes(4).toString('hex')}`
  const dir = path.join(memoryRoot, 'files', slug)
  fs.mkdirSync(dir, { recursive: true })
  const source = path.join(sourceDir, name)
  fs.writeFileSync(source, `conteúdo de ${name}`)
  const ext = path.extname(name)
  fs.copyFileSync(source, path.join(dir, `original${ext}`))
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    slug, kind, name, source, stored: `original${ext}`, bytes: 20, sha256: crypto.createHash('sha256').update(name).digest('hex'),
    added: now, updated: now, textChars, parts: textChars ? 1 : 0, tags: [], links: [], ...(description ? { description, describedBy: 'teste' } : {})
  }))
}

async function main() {
  const source = path.resolve(e2e.arg('wiki', biggestWiki() || ''))
  if (!fs.existsSync(source)) throw new Error(`wiki de origem não encontrada: ${source} (use --wiki)`)
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-memgraph-' })
  const report = { label: LABEL, startedAt: new Date().toISOString(), source }
  let app = null
  try {
    app = await e2e.launch({ port: 9491, ...ws })
    const { page } = app
    const added = await page.evaluate((folder) => window.openclod.projects.add(folder, 'Urmobo (cópia)'), ws.project)
    if (!added.ok) throw new Error(added.error)
    const projectId = added.value.id
    const memoryRoot = path.join(ws.profile, 'data', 'memory', 'projects', projectId)
    const wiki = path.join(memoryRoot, 'wiki')
    fs.mkdirSync(wiki, { recursive: true })
    const names = fs.readdirSync(source).filter((name) => name.endsWith('.md'))
    for (const name of names) {
      try {
        fs.copyFileSync(path.join(source, name), path.join(wiki, name))
      } catch {
        /* a page being rewritten right now by the user's app: skipped */
      }
    }
    report.pages = fs.readdirSync(wiki).length
    // Files of each kind: a PDF with its text, a picture without description nor OCR, a transcribed audio.
    const originals = path.join(ws.project, 'originais')
    fs.mkdirSync(originals, { recursive: true })
    seedFile(memoryRoot, originals, { name: 'contrato-tier.pdf', kind: 'pdf', textChars: 5200 })
    seedFile(memoryRoot, originals, { name: 'tela-pedido.png', kind: 'imagem' })
    const audio = path.join(memoryRoot, 'media', 'reuniao-augusto-abc123')
    fs.mkdirSync(audio, { recursive: true })
    fs.writeFileSync(path.join(audio, 'manifest.json'), JSON.stringify({ kind: 'audio', source: path.join(originals, 'reuniao.ogg'), transcript: { segments: [{ start: 0, end: 2, text: 'oi' }] }, frames: [] }))
    fs.writeFileSync(path.join(originals, 'reuniao.ogg'), 'ogg')

    await page.reload()
    await page.waitForSelector('.app-shell')
    const openedAt = Date.now()
    await page.locator('.side-nav button', { hasText: 'Memória' }).click()
    await page.waitForSelector('.memory-page', { timeout: 20000 })
    await page.locator('.memory-project', { hasText: 'Urmobo (cópia)' }).click().catch(() => undefined)
    await page.waitForSelector('.memory-card', { timeout: 120000 })
    report.firstCardsMs = Date.now() - openedAt
    await page.waitForSelector('.memory-files-summary .memory-kinds button[data-kind="pdf"]', { timeout: 120000 })
    await page.waitForFunction(() => /\d+ guardado\(s\)/.test(document.querySelector('.memory-files-head')?.textContent ?? ''), null, { timeout: 60000 })
    report.memoryScreenMs = Date.now() - openedAt

    /* ---- 1. counters of files by kind ---- */
    const kindText = async (kind) => ((await page.locator(`.memory-kinds button[data-kind="${kind}"]`).textContent()) || '').replace(/\s+/g, ' ').trim()
    const kinds = {}
    for (const kind of ['imagem', 'pdf', 'documento', 'planilha', 'audio', 'video']) kinds[kind] = await kindText(kind)
    report.kinds = kinds
    report.filesHead = ((await page.locator('.memory-files-head').textContent()) || '').replace(/\s+/g, ' ').trim()
    check('os seis tipos aparecem sempre, mesmo zerados (imagens, PDFs, documentos, planilhas, áudios, vídeos)', Object.values(kinds).every(Boolean) && /^0 documentos/.test(kinds.documento) && /^0 vídeos/.test(kinds.video), kinds)
    check('o PDF com texto conta como indexado; o áudio transcrito também', /1 PDFs/.test(kinds.pdf) && /todos indexados/.test(kinds.pdf) && /1 áudios/.test(kinds.audio) && /todos indexados/.test(kinds.audio), kinds)
    check('a imagem sem descrição nem OCR aparece como guardada, mas não indexada', /1 imagens/.test(kinds.imagem) && /0 indexado/.test(kinds.imagem), kinds.imagem)
    check('o resumo diz quantos estão guardados e quantos o agente acha a qualquer momento', /3 guardado\(s\) · 2 indexado\(s\)/.test(report.filesHead), report.filesHead)
    check('tipos zerados ficam desabilitados', await page.locator('.memory-kinds button[data-kind="video"]').isDisabled())
    report.shotCounters = await shot(page, '01-contadores', page.locator('.memory-files-summary'))
    await page.locator('.memory-kinds button[data-kind="pdf"]').click()
    await page.waitForSelector('.memory-file-card', { timeout: 15000 })
    check('clicar em "PDFs" mostra o card do PDF', /contrato-tier\.pdf/.test((await page.locator('.memory-file-card').first().textContent()) || ''))
    await page.locator('.memory-kinds button', { hasText: 'Tudo' }).click()

    /* ---- 2. the graph without freezing ---- */
    // While the graph is built: an IPC round trip every 50 ms (the main process) and the gap between animation frames (the screen).
    await page.evaluate((id) => {
      const probe = { ipc: [], frames: [], stop: false }
      window.__probe = probe
      ;(async () => {
        while (!probe.stop) {
          const started = performance.now()
          await window.openclod.memory.addStatus(id)
          probe.ipc.push(performance.now() - started)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      })()
      let last = performance.now()
      const frame = (now) => {
        probe.frames.push(now - last)
        last = now
        if (!probe.stop) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }, projectId)
    const graphAt = Date.now()
    await page.getByRole('tab', { name: 'Grafo' }).click()
    await page.waitForSelector('canvas.memory-graph', { timeout: 120000 })
    await page.waitForFunction(() => /\d+ nós/.test(document.querySelector('[data-graph-count]')?.textContent ?? ''), null, { timeout: 120000 })
    report.graphMs = Date.now() - graphAt
    await page.waitForTimeout(6000)
    const probe = await page.evaluate(() => {
      const probe = window.__probe
      probe.stop = true
      const max = (list) => Math.round(Math.max(0, ...list))
      const p95 = (list) => Math.round([...list].sort((a, b) => a - b)[Math.floor(list.length * 0.95)] ?? 0)
      return { ipcCalls: probe.ipc.length, ipcMaxMs: max(probe.ipc), ipcP95Ms: p95(probe.ipc), frames: probe.frames.length, frameMaxMs: max(probe.frames.slice(1)), frameP95Ms: p95(probe.frames.slice(1)) }
    })
    report.probe = probe
    report.graphCount = ((await page.locator('[data-graph-count]').textContent()) || '').replace(/\s+/g, ' ').trim()
    check('o grafo abre em poucos segundos com milhares de páginas', report.graphMs < 15000, { ms: report.graphMs, count: report.graphCount })
    check('mostra os nós mais ligados e diz de quantos (o resto pela busca)', /mostrando as \d+ mais ligadas de \d+/.test(report.graphCount), report.graphCount)
    check('o processo principal responde durante o grafo (IPC < 1,5 s no pior caso)', probe.ipcMaxMs < 1500, probe)
    check('a tela continua desenhando (quadro mais lento < 250 ms; 95% < 50 ms)', probe.frameMaxMs < 250 && probe.frameP95Ms < 50, probe)
    report.shotGraph = await shot(page, '02-grafo', page.locator('.memory-graph-stage'))

    /* ---- 3. zoom, pan, open a node ---- */
    const box = await page.locator('canvas.memory-graph').boundingBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240)
    await page.mouse.move(cx - 120, cy - 60)
    await page.mouse.down()
    await page.mouse.move(cx + 40, cy + 30, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    let opened = false
    for (let ring = 0; ring < 6 && !opened; ring++) {
      for (let step = 0; step < 8 && !opened; step++) {
        const angle = (step / 8) * Math.PI * 2
        const x = cx + Math.cos(angle) * ring * 22
        const y = cy + Math.sin(angle) * ring * 22
        await page.mouse.move(x, y)
        const cursor = await page.locator('canvas.memory-graph').evaluate((canvas) => canvas.style.cursor)
        if (cursor !== 'pointer') continue
        await page.mouse.click(x, y)
        opened = await page.waitForSelector('.memory-graph-detail h3', { timeout: 3000 }).then(() => true, () => false)
      }
    }
    check('passar o mouse num nó muda o cursor e clicar abre a página dele', opened)
    if (opened) {
      await page.waitForFunction(() => !/Lendo página/.test(document.querySelector('.memory-graph-detail-body')?.textContent ?? ''), null, { timeout: 15000 })
      const detail = ((await page.locator('.memory-graph-detail').textContent()) || '').replace(/\s+/g, ' ').trim()
      report.detail = detail.slice(0, 200)
      check('o painel mostra o conteúdo da página do nó', !/Conteúdo indisponível/.test(detail) && detail.length > 60, detail.slice(0, 160))
      report.shotNode = await shot(page, '03-no-aberto', page.locator('.memory-graph-stage'))
      await page.locator('.memory-graph-detail-head button[title="Fechar"]').click()
    }

    /* ---- 4. search the whole memory ---- */
    const searchAt = Date.now()
    await page.locator('.memory-graph-tools .page-search input').fill('samira')
    await page.waitForFunction(() => /casam com a busca/.test(document.querySelector('[data-graph-count]')?.textContent ?? ''), null, { timeout: 30000 })
    report.searchMs = Date.now() - searchAt
    report.searchCount = ((await page.locator('[data-graph-count]').textContent()) || '').replace(/\s+/g, ' ').trim()
    check('procurar "samira" busca na memória inteira e diz quantas páginas casam', /\d+ páginas casam com a busca/.test(report.searchCount), report.searchCount)
    check('a busca responde rápido (o grafo já preparado só é recortado)', report.searchMs < 3000, report.searchMs)
    report.shotSearch = await shot(page, '04-busca', page.locator('.memory-graph-stage'))

    check('nenhum erro no console da janela', app.errors.length === 0, app.errors.slice(0, 5))
  } catch (err) {
    check('o roteiro chegou ao fim', false, err.stack || String(err))
  } finally {
    report.checks = checks
    report.ok = ok()
    fs.writeFileSync(path.join(OUT, `${LABEL}-relatorio.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    app?.cleanup()
    process.exit(report.ok ? 0 : 1)
  }
}

void main()
