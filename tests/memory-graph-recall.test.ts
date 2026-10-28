import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectMemory } from '../src/core/memory/project'
import { memoryPageTool, memoryRecallTool } from '../src/core/memory/tools'
import type { ToolContext } from '../src/core/tools/types'

/**
 * The memory as a graph a model can walk: a search that puts the page ABOUT the subject first, hubs of random words
 * kept out of the way, durable pages linked to each other when they are written, and a capsule that says where the
 * work stands. Real data motivated every case: 73 pages, 24 of them hubs of words like "abre", "falta", "afzer".
 */
let root: string
let memory: ProjectMemory

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-graph-'))
  memory = new ProjectMemory(root)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const turnTags = ['turno', 'automatico']
async function seedTurn(title: string, body: string, extra: string[] = []): Promise<void> {
  await memory.writePage({ title, body, tags: [...turnTags, ...extra], source: 'auto', memoryType: 'fact' })
}

describe('rank: the page about the subject comes first', () => {
  it('puts the durable solution above turn logs that merely mention the words, and never returns a hub', async () => {
    await memory.writePage({
      title: 'MCP do Jira conectado pelo conector local jira (read-only)',
      body: 'O servidor oficial atlassian recusa token de API. O conector local jira usa uvx mcp-atlassian.',
      tags: ['jira', 'mcp', 'atlassian'],
      memoryType: 'solution'
    })
    for (let n = 1; n <= 4; n++) {
      await seedTurn(`Turno 26/10/2026, 12:0${n} — ola · Teste do harness ${n}`, `**Pedido:** ola\n\n**Resultado:** conectei no Jira ${n}, li o backlog e testei o harness.`, ['jira'])
    }
    await memory.writePage({ title: 'Índice: falta', body: '- [[turno]] jira harness conectei', tags: ['indice', 'falta'], source: 'auto', context: 'auto:hub' })

    const hits = await memory.rank('como conectei o Jira no harness', 6)
    expect(hits[0].slug).toBe('mcp-do-jira-conectado-pelo-conector-local-jira-read-only')
    expect(hits[0].cls).toBe('durable')
    expect(hits.every((hit) => hit.cls !== 'durable' || !hit.title.startsWith('Índice'))).toBe(true)
    expect(hits.map((hit) => hit.slug)).not.toContain('indice-falta')
    expect(hits[0].snippet.toLowerCase()).toContain('jira')
  })

  it('returns nothing for a greeting', async () => {
    await memory.writePage({ title: 'Convenção de nomes', body: 'camelCase nos módulos.', tags: ['nomes'], memoryType: 'convention' })
    expect(await memory.rank('ola')).toEqual([])
  })

  it('lets the full-text index break a tie between pages that match equally well', async () => {
    await memory.writePage({ title: 'Cache de build A', body: 'cache build', tags: ['cache'] })
    await memory.writePage({ title: 'Cache de build B', body: 'cache build', tags: ['cache'] })
    const hits = await memory.rank('cache build', 5, ['cache-de-build-b'])
    expect(hits[0].slug).toBe('cache-de-build-b')
  })
})

describe('hubs of words that are not subjects', () => {
  it('are not created for tags that only turn logs carry, and the old ones are archived, not deleted', async () => {
    // Two turn logs share the word "abre": the old code made "Índice: abre" out of it.
    await seedTurn('Turno 1 — abre o navegador', '**Pedido:** abre o navegador', ['abre'])
    await seedTurn('Turno 2 — abre o jira', '**Pedido:** abre o jira', ['abre'])
    // Two pages share "jira" and one of them is durable: that is a subject.
    await memory.writePage({ title: 'Jira conectado', body: 'ok', tags: ['jira'], memoryType: 'solution' })
    await seedTurn('Turno 3 — jira', '**Pedido:** jira', ['jira'])
    // A hub the previous version had already written for "abre".
    await memory.writePage({ title: 'Índice: abre', body: '## Páginas com este assunto\n\n- [[turno-1-abre-o-navegador]]', tags: ['indice', 'abre'], source: 'auto', context: 'auto:hub' })
    // And one a person wrote and edited by hand: it must stay.
    await memory.writePage({ title: 'Índice: manual', body: 'escrito por uma pessoa', tags: ['indice', 'manual'], source: 'user', context: 'auto:hub' })

    const fresh = new ProjectMemory(root)
    const titles = (await fresh.listPages()).map((page) => page.title)
    expect(titles).toContain('Índice: jira')
    expect(titles).not.toContain('Índice: abre')
    expect(titles).toContain('Índice: manual')
    expect(fs.existsSync(path.join(root, 'wiki', '.archive', 'indice-abre.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'wiki', 'indice-abre.md'))).toBe(false)
  })

  it('stay out of the subjects of the briefing', async () => {
    await memory.writePage({ title: 'Jira conectado', body: 'ok', tags: ['jira', 'mcp'], memoryType: 'solution' })
    await memory.writePage({ title: 'Jira de novo', body: 'ok', tags: ['jira', 'mcp'], memoryType: 'fact' })
    await seedTurn('Turno 1 — falta', 'x', ['falta'])
    await seedTurn('Turno 2 — falta', 'x', ['falta'])
    const brief = (await new ProjectMemory(root).brief()).text
    expect(brief).toContain('jira (')
    expect(brief).not.toContain('falta (')
  })
})

describe('links between durable pages', () => {
  it('writes a Relacionados section that points at the durable pages the new one is about', async () => {
    await memory.writePage({ title: 'Decisão: usar OAuth no Jira', body: 'Login pelo navegador.', tags: ['jira', 'oauth'], memoryType: 'decision' })
    await memory.writePage({ title: 'Receita de deploy', body: 'npm run build', tags: ['deploy'], memoryType: 'convention' })
    const written = await memory.writePage({ title: 'MCP do Jira conectado', body: 'Funciona via conector local.', tags: ['jira', 'mcp'], memoryType: 'solution', relate: true })

    const page = await memory.readPage(written.slug)
    expect(page?.body).toContain('## Relacionados')
    expect(page?.body).toContain('[[decisao-usar-oauth-no-jira]]')
    expect(page?.body).not.toContain('receita-de-deploy')
    // The link makes the two pages neighbours in both directions.
    const pages = await memory.listPages()
    expect(pages.find((item) => item.slug === 'decisao-usar-oauth-no-jira')?.backlinks).toContain(written.slug)
    expect(pages.find((item) => item.slug === written.slug)?.links).toContain('decisao-usar-oauth-no-jira')
  })

  it('does not add links when nothing matches, and never duplicates a section the author wrote', async () => {
    const alone = await memory.writePage({ title: 'Página isolada', body: 'conteúdo', tags: ['unico'], relate: true })
    expect((await memory.readPage(alone.slug))?.body).not.toContain('Relacionados')
    await memory.writePage({ title: 'Assunto de rede', body: 'x', tags: ['rede'], memoryType: 'fact' })
    const own = await memory.writePage({ title: 'Mais sobre rede', body: 'texto\n\n## Relacionados\n\n- [[assunto-de-rede]]', tags: ['rede'], relate: true })
    expect(((await memory.readPage(own.slug))?.body.match(/## Relacionados/g) ?? []).length).toBe(1)
  })
})

describe('map: the first turn of a session', () => {
  it('is a few lines, not the briefing', async () => {
    await memory.writePage({ title: 'Convenção de nomes', body: 'camelCase', tags: ['nomes'], memoryType: 'convention', pinned: true })
    await memory.writePage({ title: 'Receita de deploy', body: 'npm run build', tags: ['deploy'], memoryType: 'solution' })
    await seedTurn('Turno 1 — x', 'y')
    const map = await memory.map()
    expect(map.durable).toBe(2)
    expect(map.text).toContain('2 página(s) de assunto')
    expect(map.text).toContain('Fixadas: Convenção de nomes [convencao-de-nomes]')
    expect(map.text).toContain('Receita de deploy [receita-de-deploy] (solution)')
    expect(map.text.length).toBeLessThan(900)
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-empty-'))
    try {
      expect(await new ProjectMemory(empty).map()).toMatchObject({ text: '', pages: 0 })
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('the memory tools use the same ranking', () => {
  function context(index?: Partial<NonNullable<ToolContext['services']['aiMemory']>>): ToolContext {
    return {
      projectId: 'prj_test',
      log: () => undefined,
      services: { projectMemory: memory, aiMemory: index as ToolContext['services']['aiMemory'] }
    } as unknown as ToolContext
  }

  async function seedJira(): Promise<void> {
    await memory.writePage({ title: 'MCP do Jira conectado', body: 'O conector local jira usa uvx mcp-atlassian.', tags: ['jira', 'mcp'], memoryType: 'solution' })
    for (let n = 1; n <= 3; n++) await seedTurn(`Turno ${n} — ola · harness`, '**Pedido:** ola\n\n**Resultado:** conectei no Jira e testei o harness.', ['jira'])
  }

  it('memory_page search lists the page about the subject first and shows how connected each page is', async () => {
    await seedJira()
    const result = await memoryPageTool.execute({ action: 'search', query: 'como conectei o Jira no harness' }, context())
    const lines = result.text.split('\n').filter((line) => line.startsWith('- '))
    expect(lines[0]).toContain('MCP do Jira conectado [mcp-do-jira-conectado] (solution,')
    expect(result.text).toContain('backlink(s)')
    expect(result.text).not.toContain('Índice:')
  })

  it('memory_recall answers from the ranked pages and tells the model how to keep walking', async () => {
    await seedJira()
    const result = await memoryRecallTool.execute({ query: 'como conectei o Jira no harness' }, context())
    expect(result.ok).toBe(true)
    expect(result.text.indexOf('MCP do Jira conectado')).toBeGreaterThanOrEqual(0)
    expect(result.text).toContain('memory_page action=read')
    expect(result.text).toContain('citada por')
    const nothing = await memoryRecallTool.execute({ query: 'ola' }, context())
    expect(nothing.text).toContain('Nada encontrado')
  })

  it('memory_recall falls back to what only the long-term index knows, without its auto-generated hubs', async () => {
    const index = {
      search: async () => [
        { path: 'pages/indice-jira.md', title: 'Índice: jira', snippet: 'hub' },
        { path: 's/ab12cd.md', title: 'Sessão antiga — migração do banco', snippet: 'decidimos usar pg com pool de 10' }
      ]
    }
    const result = await memoryRecallTool.execute({ query: 'migração do banco pool' }, context(index))
    expect(result.text).toContain('[s/ab12cd.md]')
    expect(result.text).toContain('decidimos usar pg com pool de 10')
    expect(result.text).not.toContain('indice-jira')
  })

  it('memory_page read opens a page that exists only in the index, and a mirrored path as the wiki page', async () => {
    await seedJira()
    const index = { readPage: async (_project: string, p: string) => (p === 's/ab12cd.md' ? { path: p, title: 'Sessão antiga', body: 'decidimos usar pg', tags: [] } : null) }
    const old = await memoryPageTool.execute({ action: 'read', slug: 's/ab12cd.md' }, context(index))
    expect(old.ok).toBe(true)
    expect(old.text).toContain('decidimos usar pg')
    expect(old.text).toContain('source="índice"')
    const mirrored = await memoryPageTool.execute({ action: 'read', slug: 'pages/mcp-do-jira-conectado.md' }, context(index))
    expect(mirrored.ok).toBe(true)
    expect(mirrored.text).toContain('uvx mcp-atlassian')
    expect((await memoryPageTool.execute({ action: 'read', slug: 'nao/existe.md' }, context(index))).ok).toBe(false)
  })

  it('memory_page write ties the new page to the durable ones and says so', async () => {
    await memory.writePage({ title: 'Decisão: OAuth no Jira', body: 'Login pelo navegador.', tags: ['jira', 'oauth'], memoryType: 'decision' })
    const result = await memoryPageTool.execute({ action: 'write', title: 'Jira via conector local', body: 'Funciona.', tags: ['jira'], memory_type: 'solution' }, context())
    expect(result.ok).toBe(true)
    expect(result.text).toContain('ligada a: decisao-oauth-no-jira')
  })

  it('memory_page list leaves the auto-generated hubs out', async () => {
    await memory.writePage({ title: 'Índice: jira', body: '- [[x]]', tags: ['indice', 'jira'], source: 'auto', context: 'auto:hub' })
    await memory.writePage({ title: 'Convenção', body: 'x', tags: ['nomes'], memoryType: 'convention' })
    const result = await memoryPageTool.execute({ action: 'list' }, context())
    expect(result.text).toContain('Convenção')
    expect(result.text).not.toContain('Índice: jira')
  })
})

describe('the continuity capsule', () => {
  const base = {
    sessionTitle: 'Exportador CSV',
    sessionId: 'ses_a',
    provider: 'DeepSeek',
    model: 'deepseek-flash',
    runState: 'done',
    firstRequest: 'Implemente o parser, o validador e o exportador CSV. Separador ponto e vírgula.',
    lastRequest: 'Agora o validador.',
    result: 'Validador pronto.',
    plan: [
      { id: 'p1', text: 'parser', status: 'done' as const },
      { id: 'p2', text: 'exportador CSV com ponto e vírgula', status: 'pending' as const }
    ],
    files: ['src/parser.js']
  }

  it('is one page per session, rewritten every turn, and offered as open work to OTHER sessions only', async () => {
    const first = await memory.recordState(base)
    expect(first.summary.slug).toBe('estado-exportador-csv')
    expect(first.state.status).toBe('em-aberto')
    const again = await memory.recordState({ ...base, result: 'Validador e testes prontos.' })
    expect(again.summary.slug).toBe(first.summary.slug)
    expect((await memory.listPages()).filter((page) => page.slug.startsWith('estado-'))).toHaveLength(1)

    const other = await memory.openWork({ excludeContext: 'sessao:ses_b' })
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({ slug: 'estado-exportador-csv', status: 'em-aberto', next: 'exportador CSV com ponto e vírgula' })
    expect(other[0].body).toContain('Separador ponto e vírgula')
    // The session itself already has this in its history.
    expect(await memory.openWork({ excludeContext: 'sessao:ses_a' })).toEqual([])
  })

  it('offers the last finished session when nothing is open, and drops old ones', async () => {
    await memory.recordState({ ...base, plan: base.plan.map((item) => ({ ...item, status: 'done' as const })) })
    const last = await memory.openWork({ excludeContext: 'sessao:ses_b' })
    expect(last).toHaveLength(1)
    expect(last[0].status).toBe('concluido')
    expect(await memory.openWork({ excludeContext: 'sessao:ses_b', now: Date.now() + 40 * 86_400_000 })).toEqual([])
  })

  it('is not mistaken for a subject: no hub is made of its tags', async () => {
    await memory.recordState(base)
    await memory.recordState({ ...base, sessionId: 'ses_c', sessionTitle: 'Outra coisa' })
    const titles = (await new ProjectMemory(root).listPages()).map((page) => page.title)
    expect(titles.filter((title) => title.startsWith('Índice'))).toEqual([])
  })
})
