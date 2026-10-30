import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectMemory, slugify } from '../src/core/memory/project'
import { memoryPageTool } from '../src/core/memory/tools'
import type { ToolContext } from '../src/core/tools/types'

let root: string
let memory: ProjectMemory

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-memory-'))
  memory = new ProjectMemory(root)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('project memory: markdown wiki', () => {
  it('writes a human-editable markdown page and reads it back', async () => {
    const summary = await memory.writePage({
      title: 'Decisões de arquitetura',
      body: 'O harness roda no processo principal.\n\nA wiki é a fonte da verdade.',
      tags: ['arquitetura', 'harness'],
      pinned: true
    })
    expect(summary.slug).toBe('decisoes-de-arquitetura')
    const file = path.join(root, 'wiki', `${summary.slug}.md`)
    expect(fs.existsSync(file)).toBe(true)
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain('title: "Decisões de arquitetura"')
    expect(raw).toContain('pinned: true')
    expect(raw).toContain('O harness roda no processo principal.')

    const page = await memory.readPage(summary.slug)
    expect(page?.title).toBe('Decisões de arquitetura')
    expect(page?.tags).toEqual(['arquitetura', 'harness'])
    expect(page?.pinned).toBe(true)
  })

  it('lists, searches and deletes pages', async () => {
    await memory.writePage({ title: 'Banco de dados', body: 'SQLite com WAL e migrações.' })
    await memory.writePage({ title: 'Navegador', body: 'Playwright usa o Chrome instalado.' })

    const pages = await memory.listPages()
    expect(pages.map((page) => page.slug).sort()).toEqual(['banco-de-dados', 'navegador'])

    const hits = await memory.search('sqlite migrações')
    expect(hits[0]?.slug).toBe('banco-de-dados')
    expect(hits[0]?.snippet.toLowerCase()).toContain('sqlite')

    expect(await memory.deletePage('navegador')).toBe(true)
    expect((await memory.listPages()).map((page) => page.slug)).toEqual(['banco-de-dados'])
    expect(await memory.readPage('navegador')).toBeNull()
  })

  it('keeps projects isolated by construction', async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-memory-other-'))
    const other = new ProjectMemory(otherRoot)
    await memory.writePage({ title: 'Só do projeto A', body: 'segredo local A' })
    expect(await other.listPages()).toEqual([])
    expect((await other.search('projeto A')).length).toBe(0)
    fs.rmSync(otherRoot, { recursive: true, force: true })
  })

  it('redacts credentials before writing and in the briefing', async () => {
    await memory.writePage({
      title: 'Chave de teste',
      body: 'A chave sk-abcdefghijklmnopqrstuvwxyz012345 não deve vazar.',
      pinned: true
    })
    const page = await memory.readPage('chave-de-teste')
    expect(page?.body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(page?.body).toContain('[REDACTED]')
    const brief = await memory.brief()
    expect(brief.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('rebuilds the index from markdown after it is deleted', async () => {
    await memory.writePage({ title: 'Página persistente', body: 'corpo durável' })
    fs.rmSync(path.join(root, 'index.json'))
    const fresh = new ProjectMemory(root)
    const pages = await fresh.listPages()
    expect(pages.map((page) => page.slug)).toEqual(['pagina-persistente'])
  })

  it('records provenance, confidence, evidence and possible contradictions', async () => {
    const first = await memory.writePage({
      title: 'Decisão de deploy A',
      body: 'O deploy usa Docker Compose.',
      tags: ['deploy'],
      memoryType: 'decision',
      confidence: 'observed',
      evidence: ['tests/deploy.test.ts', 'commit abc123'],
      context: 'Validado na máquina local'
    })
    const second = await memory.writePage({
      title: 'Decisão de deploy B',
      body: 'O deploy usa apenas um processo Node.',
      tags: ['deploy'],
      memoryType: 'decision',
      confidence: 'inferred'
    })
    const page = await memory.readPage(first.slug)
    expect(page).toMatchObject({ memoryType: 'decision', confidence: 'observed', status: 'active' })
    expect(page?.evidence).toEqual(['tests/deploy.test.ts', 'commit abc123'])
    expect(page?.context).toBe('Validado na máquina local')
    expect(second.possibleConflicts).toContain(first.slug)
    expect((await memory.readPage(second.slug))?.possibleConflicts).toContain(first.slug)
    expect((await memory.brief()).text).toContain('Possíveis conflitos')
  })

  it('supersedes and invalidates without erasing history', async () => {
    const old = await memory.writePage({
      title: 'Banco antigo',
      body: 'Usar arquivo JSON para sessões.',
      tags: ['banco', 'sessao'],
      memoryType: 'decision'
    })
    const next = await memory.writePage({
      title: 'Banco novo',
      body: 'Usar SQLite para sessões.',
      tags: ['banco', 'sessao'],
      memoryType: 'decision',
      supersedes: old.slug,
      confidence: 'observed',
      evidence: ['tests/session-store.test.ts']
    })
    expect((await memory.readPage(old.slug))?.status).toBe('superseded')
    expect((await memory.readPage(old.slug))?.supersededBy).toBe(next.slug)
    expect((await memory.search('JSON')).some((hit) => hit.slug === old.slug)).toBe(false)

    const invalidated = await memory.invalidatePage(next.slug, 'arquitetura revista')
    expect(invalidated?.status).toBe('invalidated')
    expect((await memory.readPage(next.slug))?.body).toContain('SQLite')
    expect((await memory.stats()).invalidated).toBe(1)
    expect((await memory.projectSummary())).not.toContain('Banco novo')
  })
})

describe('project memory: handoffs', () => {
  it('claims an open handoff exactly once', async () => {
    const handoff = await memory.beginHandoff({
      summary: 'Implementei a coluna única; falta testar com o painel aberto.',
      next: 'Rodar scripts/ui-work.cjs e comparar as bordas.',
      files: ['src/renderer/src/styles.css'],
      openQuestions: ['O gutter deve ser 24 ou 32 px?']
    })
    expect((await memory.listHandoffs()).map((item) => item.id)).toEqual([handoff.id])
    const claimed = await memory.acceptHandoff(handoff.id)
    expect(claimed?.id).toBe(handoff.id)
    expect(await memory.acceptHandoff(handoff.id)).toBeNull()
    expect((await memory.listHandoffs()).length).toBe(0)
  })

  it('cancels only an open handoff', async () => {
    const handoff = await memory.beginHandoff({ summary: 'teste' })
    expect(await memory.cancelHandoff('ho_inexistente')).toBe(false)
    expect(await memory.cancelHandoff(handoff.id)).toBe(true)
    expect(await memory.cancelHandoff(handoff.id)).toBe(false)
  })

  it('includes pinned pages and open handoffs in the briefing', async () => {
    await memory.writePage({ title: 'Regra fixa', body: 'sempre rodar os testes', pinned: true })
    await memory.writePage({ title: 'Página recente', body: 'contexto recente' })
    await memory.beginHandoff({ summary: 'parou no teste E2E', next: 'rodar o teste de voz' })
    const brief = await memory.brief()
    expect(brief.text).toContain('Regra fixa')
    expect(brief.text).toContain('Página recente')
    expect(brief.text).toContain('Handoffs')
    expect(brief.openHandoffs).toBe(1)
    expect(brief.pages).toBe(2)
  })
})

describe('project memory: automatic turn capture', () => {
  it('writes one atomic note per turn and a small session index', async () => {
    await memory.rememberTurn({
      sessionTitle: 'Corrigir login',
      sessionId: 'ses_1',
      turnId: 'msg_1',
      userText: 'Corrija o login',
      assistantText: 'Login corrigido.',
      tools: ['read_file', 'edit_file'],
      files: ['src/login.ts']
    })
    await memory.rememberTurn({
      sessionTitle: 'Corrigir login',
      sessionId: 'ses_1',
      turnId: 'msg_2',
      userText: 'Rode os testes',
      assistantText: '3 testes passaram.',
      tools: ['run_command']
    })

    const pages = await memory.listPages()
    const session = pages.find((item) => item.slug === 'sessao-corrigir-login')
    const turns = pages.filter((item) => item.kind === 'turn')
    expect(session?.kind).toBe('session')
    expect(turns).toHaveLength(2)

    const index = await memory.readPage('sessao-corrigir-login')
    expect(index?.body).toContain('## Turnos')
    expect(index?.body).toContain(`[[${turns[0].slug}]]`)
    expect(index?.body).toContain(`[[${turns[1].slug}]]`)
    // The session page is an index, not a giant transcript.
    expect(index?.body).not.toContain('**Resultado:**')
    expect(index?.tags).toEqual(['sessao', 'indice'])

    const bodies = await Promise.all(turns.map((turn) => memory.readPage(turn.slug)))
    expect(bodies.some((page) => page?.body.includes('Corrija o login'))).toBe(true)
    expect(bodies.some((page) => page?.body.includes('Rode os testes'))).toBe(true)
    expect(bodies.some((page) => page?.body.includes('src/login.ts'))).toBe(true)
    expect(bodies.every((page) => page?.body.includes('[[sessao-corrigir-login]]'))).toBe(true)
    expect(bodies.every((page) => page?.source === 'auto')).toBe(true)
  })

  it('splits a legacy giant session page into turn notes and an index', async () => {
    await memory.writePage({
      title: 'Sessão: Antiga',
      body: [
        '### 26/10/2026, 15:14',
        '',
        '**Pedido:** primeiro pedido',
        '',
        '**Resultado:** primeiro resultado',
        '',
        '### 26/10/2026, 15:20',
        '',
        '**Pedido:** segundo pedido',
        '',
        '**Resultado:** segundo resultado'
      ].join('\n'),
      tags: ['sessao', 'automatico'],
      source: 'auto'
    })

    const fresh = new ProjectMemory(root)
    await fresh.init()
    const pages = await fresh.listPages()
    const session = pages.find((item) => item.slug === 'sessao-antiga')
    const turns = pages.filter((item) => item.kind === 'turn')
    expect(session?.kind).toBe('session')
    expect(turns).toHaveLength(2)

    const index = await fresh.readPage('sessao-antiga')
    expect(index?.tags).toContain('indice')
    expect(index?.body).toContain('## Turnos')
    expect(index?.body).not.toContain('primeiro resultado')

    const bodies = await Promise.all(turns.map((turn) => fresh.readPage(turn.slug)))
    expect(bodies.some((page) => page?.body.includes('primeiro pedido'))).toBe(true)
    expect(bodies.some((page) => page?.body.includes('segundo pedido'))).toBe(true)
    expect(bodies.every((page) => page?.body.includes('[[sessao-antiga]]'))).toBe(true)
  })

  it('migrates a legacy session whose slug differs from its title only once', async () => {
    await memory.writePage({
      title: 'Sessao Claude (front) - 2026-09-02 - msg (parte 1/8)',
      slug: 'sessao-claude-front-2026-09-02-msg-p1',
      body: ['### 02/09/2026, 10:00', '', '**Pedido:** ler as mensagens', '', '**Resultado:** lidas'].join('\n'),
      tags: ['sessao', 'automatico'],
      source: 'import'
    })

    const primeira = new ProjectMemory(root)
    await primeira.init()
    const index = await primeira.readPage('sessao-claude-front-2026-09-02-msg-p1')
    expect(index?.tags).toContain('indice')
    expect(index?.body).not.toMatch(/^### /m)
    const turnos = (await primeira.listPages()).filter((item) => item.kind === 'turn')
    expect(turnos).toHaveLength(1)
    const antes = turnos[0].updated

    await new Promise((resolve) => setTimeout(resolve, 20))
    const segunda = new ProjectMemory(root)
    await segunda.init()
    const depois = (await segunda.listPages()).filter((item) => item.kind === 'turn')
    expect(depois).toHaveLength(1)
    expect(depois[0].updated).toBe(antes)
    expect((await segunda.listPages()).filter((item) => item.tags.includes('sessao') && item.tags.includes('indice'))).toHaveLength(1)
  })

  it('leaves an imported session summary with section headings untouched', async () => {
    const corpo = ['### Pedido', '', 'corrigir as abas do cliente', '', '### Investigado', '', 'o componente de abas', '', '### Aprendido', '', 'as abas vêm do perfil'].join('\n')
    await memory.writePage({
      title: 'Sessao Claude (front) - 2026-09-03 - abas do cliente',
      slug: 'sessao-claude-front-2026-09-03-abas-do-cliente',
      body: corpo,
      tags: ['urmobo', 'sessao', 'claude-mem'],
      source: 'import'
    })

    const fresh = new ProjectMemory(root)
    await fresh.init()
    const pagina = await fresh.readPage('sessao-claude-front-2026-09-03-abas-do-cliente')
    expect(pagina?.body).toContain('### Investigado')
    expect(pagina?.tags).not.toContain('indice')
    expect((await fresh.listPages()).filter((item) => item.kind === 'turn')).toHaveLength(0)
  })

  it('resolves wikilinks and backlinks across topic pages', async () => {
    await memory.writePage({ title: 'Tópico A', body: 'Veja [[Tópico B]] para o detalhe.' })
    await memory.writePage({ title: 'Tópico B', body: 'Detalhe do tópico B.' })
    const pages = await memory.listPages()
    expect(pages.find((page) => page.slug === 'topico-a')?.links).toEqual(['Tópico B'])
    expect(pages.find((page) => page.slug === 'topico-b')?.backlinks).toContain('topico-a')
  })

  it('searches and reads a page through memory_page, exposing its links', async () => {
    await memory.writePage({ title: 'Overlay do ditado', body: 'A barra mostra o texto ao vivo. Veja [[GPU CUDA]].', tags: ['overlay'] })
    await memory.writePage({ title: 'GPU CUDA', body: 'A transcrição usa a RTX quando disponível.', tags: ['gpu'] })
    const ctx = { services: { projectMemory: memory } } as unknown as ToolContext
    const search = await memoryPageTool.execute({ action: 'search', query: 'overlay' }, ctx)
    expect(search.ok).toBe(true)
    expect(search.text).toContain('Overlay do ditado')
    const read = await memoryPageTool.execute({ action: 'read', slug: 'overlay-do-ditado' }, ctx)
    expect(read.ok).toBe(true)
    expect(read.text).toContain('## Ligações')
    expect(read.text).toContain('[[GPU CUDA]]')
  })
})

describe('slugify', () => {
  it('removes accents and punctuation', () => {
    expect(slugify('Decisões de Arquitetura!')).toBe('decisoes-de-arquitetura')
    expect(slugify('  API / v1  ')).toBe('api-v1')
  })
})
