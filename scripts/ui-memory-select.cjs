// End-to-end of "marcar páginas na Memória e apagar em massa", no app de verdade (Electron, perfil descartável: o app e o perfil do
// usuário não são tocados). Semeia 9 páginas (uma fixada) na wiki do projeto e confere: uma caixa por card, o card ainda abre a
// página, Shift+clique, "Selecionar todas", a busca que desmarca o que sumiu da lista, Esc, a confirmação em dois cliques (que diz
// quantas fixadas entram) e os arquivos de verdade apagados do disco.
//
//   node scripts/ui-memory-select.cjs [--root <snapshot>] [--out dir] [--label nome]
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const LABEL = e2e.arg('label', 'selecao')
const OUT = path.resolve(e2e.arg('out', path.join(e2e.ROOT, 'Prints', 'memoria-selecao-2026-10-27')))
fs.mkdirSync(OUT, { recursive: true })
const { check, checks, ok } = e2e.makeChecks()

const TITLES = ['Estado: oi', 'Sessão: ola', 'Turno: pasta azul', 'Decisão: usar Docker', 'Convenção: commits curtos', 'Estado: wifi', 'Turno: arrastar pasta', 'Preferência: respostas curtas', 'Fixada: regras do projeto']
const slugOf = (title) => title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function pageFile(title, index) {
  const pinned = title.startsWith('Fixada')
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `tags: ${pinned ? 'regras, fixada' : 'estado, concluido'}`,
    `pinned: ${pinned}`,
    `created: 2026-10-27T1${index % 10}:00:00.000Z`,
    `updated: 2026-10-27T1${index % 10}:30:00.000Z`,
    'source: agent',
    'memory_type: fact',
    'confidence: observed',
    'status: active',
    '---',
    '',
    `Resumo da página "${title}", só para o teste de seleção.`,
    ''
  ].join('\n')
}

const shot = async (page, name) => {
  const file = path.join(OUT, `${LABEL}-${name}.png`)
  await page.screenshot({ path: file })
  return path.relative(e2e.ROOT, file)
}

async function main() {
  const ws = e2e.makeWorkspace({ real: false, prefix: 'openclod-memsel-' })
  const report = { label: LABEL, startedAt: new Date().toISOString() }
  let app = null
  try {
    app = await e2e.launch({ port: 9483, ...ws })
    const { page } = app

    const added = await page.evaluate((folder) => window.forja.projects.add(folder, 'Memória E2E'), ws.project)
    if (!added.ok) throw new Error(added.error)
    const wiki = path.join(ws.profile, 'data', 'memory', 'projects', added.value.id, 'wiki')
    fs.mkdirSync(wiki, { recursive: true })
    TITLES.forEach((title, index) => fs.writeFileSync(path.join(wiki, `${slugOf(title)}.md`), pageFile(title, index)))
    const onDisk = () => fs.readdirSync(wiki).filter((name) => name.endsWith('.md')).length

    await page.reload()
    await page.waitForSelector('.app-shell')
    await page.locator('.side-nav button', { hasText: 'Memória' }).click()
    await page.waitForSelector('.memory-card', { timeout: 30000 })
    await page.waitForFunction((count) => document.querySelectorAll('.memory-card').length >= count, TITLES.length, { timeout: 30000 })
    const cards = page.locator('.memory-card')
    const checkbox = (title) => page.locator('.memory-card', { hasText: title }).locator('.memory-check input')
    const count = async () => (await page.locator('.memory-card.is-selected').count())
    const bar = () => page.locator('.memory-bulk')
    const barText = async () => ((await bar().textContent()) || '').replace(/\s+/g, ' ').trim()

    /* ---- 1. one box per card, and the card still opens its page ---- */
    check('cada card tem a sua caixa de marcar (9 páginas, 9 caixas) e ninguém começa marcado', (await cards.count()) === TITLES.length && (await page.locator('.memory-check input').count()) === TITLES.length && (await count()) === 0, await cards.count())
    check('a barra acima da grade oferece "Selecionar todas" e explica o Shift+clique', /Selecionar todas/.test(await barText()) && /Shift\+clique/.test(await barText()), await barText())
    report.shotBefore = await shot(page, '01-cards-com-caixa')
    await page.locator('.memory-card', { hasText: 'Turno: pasta azul' }).locator('.memory-card-open').click()
    await page.waitForSelector('.memory-detail', { timeout: 10000 })
    check('clicar no conteúdo do card continua abrindo a página (a caixa não atrapalha)', /Turno: pasta azul/.test((await page.locator('.memory-detail').textContent()) || '') && (await count()) === 0)
    await page.locator('.memory-detail-head button', { hasText: 'Voltar' }).click()
    await page.waitForSelector('.memory-card')

    /* ---- 2. mark, Shift+click, master box, Escape ---- */
    await checkbox('Sessão: ola').click()
    check('marcar a caixa de um card o destaca e a barra conta 1 selecionada', (await count()) === 1 && /1 selecionada/.test(await barText()) && (await page.locator('.memory-bulk.has-selection').count()) === 1, await barText())
    check('clicar na caixa NÃO abriu a página', (await page.locator('.memory-detail').count()) === 0)
    await checkbox('Estado: wifi').click({ modifiers: ['Shift'] })
    const range = await page.locator('.memory-card.is-selected strong').allTextContents()
    check('Shift+clique marca a faixa inteira entre a última marcada e a clicada (5 cards, os do meio inclusive)',(await count()) === 5 && range.includes('Sessão: ola') && range.includes('Estado: wifi') && range.includes('Decisão: usar Docker'), range)
    await checkbox('Decisão: usar Docker').click()
    check('desmarcar um card tira só ele da seleção', (await count()) === 4 && !(await page.locator('.memory-card.is-selected strong').allTextContents()).includes('Decisão: usar Docker'))
    await page.keyboard.press('Escape')
    check('Esc limpa a seleção', (await count()) === 0 && /Selecionar todas/.test(await barText()), await barText())
    await page.locator('.memory-bulk-master').click()
    check('"Selecionar todas" marca todas as páginas da lista e mostra o contador', (await count()) === TITLES.length && new RegExp(`${TITLES.length} selecionada`).test(await barText()), await barText())
    await page.locator('.memory-bulk-master').click()
    check('clicar de novo na caixa-mestra desmarca todas', (await count()) === 0)

    /* ---- 3. the search narrows the list: marks that left it are dropped ---- */
    await page.locator('.memory-bulk-master').click()
    await page.locator('.page-search input').fill('wifi')
    await page.waitForFunction(() => document.querySelectorAll('.memory-card').length === 1, null, { timeout: 5000 })
    check('buscar tira da seleção o que saiu da lista: sobra só a página que a busca mostra (1 de 1)', (await count()) === 1 && /1 selecionada/.test(await barText()), await barText())
    await page.locator('.page-search input').fill('')
    await page.waitForFunction((n) => document.querySelectorAll('.memory-card').length === n, TITLES.length, { timeout: 5000 })
    check('limpar a busca não traz as marcas de volta (o que estava escondido não é apagado sem querer)', (await count()) === 1)
    await page.locator('.memory-bulk button', { hasText: 'Limpar seleção' }).click()
    check('"Limpar seleção" desmarca tudo', (await count()) === 0)

    /* ---- 4. delete: two clicks, the pinned page is named, the files go away ---- */
    for (const title of ['Estado: oi', 'Sessão: ola', 'Fixada: regras do projeto']) await checkbox(title).click()
    const deleteButton = page.locator('.memory-bulk-delete')
    check('com 3 marcadas o botão diz "Apagar 3"', /Apagar 3$/.test(((await deleteButton.textContent()) || '').trim()), await deleteButton.textContent())
    await deleteButton.click()
    const confirmText = ((await deleteButton.textContent()) || '').replace(/\s+/g, ' ').trim()
    check('o primeiro clique só pergunta: "Confirmar: apagar 3 páginas (1 fixada)" e nada foi apagado', /Confirmar: apagar 3 páginas \(1 fixada\)/.test(confirmText) && onDisk() === TITLES.length, confirmText)
    report.shotConfirm = await shot(page, '02-confirmar-apagar')
    await deleteButton.click()
    await page.waitForFunction((n) => document.querySelectorAll('.memory-card').length === n, TITLES.length - 3, { timeout: 15000 })
    check('o segundo clique apaga: 6 cards sobram e a tela mostra "3 página(s) apagada(s)."', (await cards.count()) === 6 && /3 página\(s\) apagada\(s\)\./.test((await page.locator('.panel-note').textContent()) || ''), await page.locator('.panel-note').textContent())
    const left = fs.readdirSync(wiki).filter((name) => name.endsWith('.md'))
    check('os 3 arquivos foram apagados do disco e os outros 6 continuam lá', left.length === 6 && !left.includes('estado-oi.md') && !left.includes('sessao-ola.md') && !left.includes('fixada-regras-do-projeto.md'), left)
    check('depois de apagar, nada fica marcado e as estatísticas se atualizam (6 páginas)', (await count()) === 0 && /^6\b/.test(((await page.locator('.memory-stat-value').first().textContent()) || '').trim()))
    report.shotAfter = await shot(page, '03-depois-de-apagar')

    /* ---- 5. a confirmation that is ignored goes away by itself ---- */
    await checkbox('Estado: wifi').click()
    await deleteButton.click()
    check('a confirmação aberta e ignorada volta ao botão "Apagar 1" sozinha', /Confirmar/.test((await deleteButton.textContent()) || ''))
    await page.waitForFunction(() => /^\s*Apagar 1\s*$/.test(document.querySelector('.memory-bulk-delete')?.textContent || ''), null, { timeout: 9000 })
    check('...depois de alguns segundos, sem apagar nada', onDisk() === 6)
  } finally {
    report.errors = ((app && app.errors) || []).filter((line) => line.startsWith('pageerror'))
    if (app) app.cleanup()
  }
  report.checks = checks
  const file = path.join(OUT, `${LABEL}-ui-memory-select.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  const failed = Object.values(checks).filter((value) => value !== 'ok').length
  console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} verificações ok -> ${path.relative(e2e.ROOT, file)}`)
  process.exit(ok() && !report.errors.length ? 0 : 1)
}

main().catch((err) => {
  console.error('ERRO', err.stack || err.message)
  process.exit(2)
})
