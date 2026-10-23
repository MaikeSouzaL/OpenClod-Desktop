import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectMemory, slugify } from '../src/core/memory/project'

let root: string
let memory: ProjectMemory

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-memory-'))
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
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-memory-other-'))
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

describe('slugify', () => {
  it('removes accents and punctuation', () => {
    expect(slugify('Decisões de Arquitetura!')).toBe('decisoes-de-arquitetura')
    expect(slugify('  API / v1  ')).toBe('api-v1')
  })
})
