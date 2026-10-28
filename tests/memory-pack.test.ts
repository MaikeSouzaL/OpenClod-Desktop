import { describe, expect, it } from 'vitest'
import { buildPack, pageClass, rankPages, significantStems, stem } from '../src/core/memory/pack'
import type { MemoryPageSummary } from '../src/core/memory/project'

/**
 * The pack is what turns "the memory is a graph of linked pages" into a few lines for ONE request. The fixture copies
 * the shape of a real project's memory: a handful of durable pages, many turn logs, and auto-generated "Índice: <palavra>"
 * hubs (24 of the 73 pages of the biggest real project) whose words are "abre", "falta", "desktop".
 */
const NOW = Date.parse('2026-10-27T12:00:00Z')

function page(over: Partial<MemoryPageSummary> & { slug: string; title: string }): MemoryPageSummary {
  return { tags: [], pinned: false, updated: '2026-10-27T08:00:00Z', summary: '', terms: [], kind: 'topic', links: [], backlinks: [], status: 'active', memoryType: 'fact', ...over }
}

const jiraSolution = page({
  slug: 'mcp-do-jira-conectado',
  title: 'MCP do Jira conectado pelo conector local jira (read-only)',
  memoryType: 'solution',
  tags: ['jira', 'mcp', 'atlassian', 'solucao'],
  summary: 'Estado final: funcionando. O servidor oficial atlassian recusa token de API; o conector local jira usa uvx mcp-atlassian.',
  terms: ['jira', 'conectado', 'conector', 'local', 'mcp', 'atlassian', 'token', 'read', 'only', 'uvx', 'servidor', 'oficial', 'recusa']
})
const backlog = page({
  slug: 'backlog-cnc',
  title: 'Backlog CNC — o que falta fazer (26/10/2026)',
  memoryType: 'fact',
  tags: ['jira', 'cnc', 'backlog', 'huracan'],
  summary: '34 itens abertos, 113 h estimadas.',
  terms: ['backlog', 'cnc', 'falta', 'fazer', 'itens', 'abertos', 'jira']
})
const hubFalta = page({ slug: 'indice-falta', title: 'Índice: falta', tags: ['indice', 'falta'], summary: 'Páginas com este assunto', terms: ['falta', 'jira', 'backlog', 'harness', 'desktop', 'ola', 'conectei'] })
const hubDesktop = page({ slug: 'indice-desktop', title: 'Índice: desktop', tags: ['indice', 'desktop'], summary: 'Páginas com este assunto', terms: ['desktop', 'jira', 'harness', 'conectado'] })
function turn(n: number, extra: Partial<MemoryPageSummary> = {}): MemoryPageSummary {
  return page({
    slug: `turno-${n}`,
    title: `Turno 26/10/2026, 12:${String(10 + n)} — ola · Teste do harness ${n}`,
    kind: 'turn',
    tags: ['turno', 'automatico', 'jira'],
    summary: 'Pedido: ola. Resultado: conectei no Jira e li o backlog.',
    terms: ['ola', 'teste', 'harness', 'jira', 'conectei', 'backlog', 'falta'],
    ...extra
  })
}

describe('what a request is about', () => {
  it('drops greetings, questions and fillers; keeps one stem for the inflections of a verb', () => {
    expect(significantStems('ola')).toEqual([])
    expect(significantStems('tente novamente')).toEqual([])
    expect(significantStems('como conectei o Jira no harness')).toEqual(['conect', 'jira', 'harnes'])
    expect(stem('conectado')).toBe(stem('conectei'))
    expect(stem('jira')).toBe('jira')
  })

  it('classifies the real kinds of pages', () => {
    expect(pageClass(jiraSolution)).toBe('durable')
    expect(pageClass(hubFalta)).toBe('hub')
    expect(pageClass(turn(1))).toBe('turn')
    expect(pageClass(page({ slug: 'sessao-x', title: 'Sessão: x', kind: 'session', tags: ['sessao', 'indice'] }))).toBe('session')
  })
})

describe('ranking', () => {
  const pages = [hubFalta, hubDesktop, turn(1), turn(2), turn(3), backlog, jiraSolution]

  it('puts the durable page that answers the request first, never a hub', () => {
    const ranked = rankPages(pages, 'como conectei o Jira no harness', { now: NOW })
    expect(ranked[0].page.slug).toBe('mcp-do-jira-conectado')
    expect(ranked.every((item) => item.cls !== 'hub')).toBe(true)
  })

  it('ignores a page that was superseded or invalidated', () => {
    const ranked = rankPages([{ ...jiraSolution, status: 'superseded' }, { ...backlog, status: 'invalidated' }, turn(1)], 'jira conector', { now: NOW })
    expect(ranked.map((item) => item.page.slug)).toEqual(['turno-1'])
  })

  it('counts a title or tag match for more than a word buried in the body', () => {
    const inBody = page({ slug: 'a', title: 'Outra coisa', tags: ['x'], summary: '', terms: ['deploy', 'staging'] })
    const inTitle = page({ slug: 'b', title: 'Deploy em staging', tags: ['deploy'], terms: ['deploy', 'staging'] })
    const ranked = rankPages([inBody, inTitle], 'deploy staging', { now: NOW })
    expect(ranked.map((item) => item.page.slug)).toEqual(['b', 'a'])
  })

  it('discounts an open item nobody touched for weeks', () => {
    const fresh = page({ slug: 'novo', title: 'Pendência de deploy', memoryType: 'pending', updated: '2026-10-25T00:00:00Z', terms: ['deploy', 'pendencia'], tags: ['deploy'] })
    const stale = page({ slug: 'velho', title: 'Pendência de deploy antiga', memoryType: 'pending', updated: '2026-08-01T00:00:00Z', terms: ['deploy', 'pendencia'], tags: ['deploy'] })
    const ranked = rankPages([stale, fresh], 'pendência deploy', { now: NOW })
    expect(ranked[0].page.slug).toBe('novo')
  })

  it('lets the full-text index break a tie, in its own order', () => {
    const a = page({ slug: 'a', title: 'Cache de build', tags: ['cache'], terms: ['cache', 'build'] })
    const b = page({ slug: 'b', title: 'Cache de build', tags: ['cache'], terms: ['cache', 'build'] })
    const ranked = rankPages([a, b], 'cache build', { now: NOW, indexed: ['b', 'a'] })
    expect(ranked[0].page.slug).toBe('b')
  })
})

describe('the pack for one request', () => {
  it('is empty for a greeting and for "tente novamente": the memory costs no tokens', () => {
    const pages = [jiraSolution, backlog, hubFalta, turn(1)]
    expect(buildPack(pages, 'ola', { now: NOW }).text).toBe('')
    expect(buildPack(pages, 'tente novamente', { now: NOW }).text).toBe('')
    expect(buildPack(pages, 'ola', { now: NOW }).entries).toEqual([])
  })

  it('lists title, slug, kind and date, and tells the model how to open a page', () => {
    const result = buildPack([jiraSolution, turn(1)], 'como conectei o Jira no harness', { now: NOW })
    expect(result.text).toContain('MCP do Jira conectado pelo conector local jira (read-only) [mcp-do-jira-conectado] (solution, 2026-10-27)')
    expect(result.text).toContain('memory_page action=read slug=<slug>')
    expect(result.text.length).toBeLessThan(3_200)
  })

  it('lets only a couple of turn logs ride along when durable pages answer, and more when none does', () => {
    const turns = Array.from({ length: 8 }, (_, index) => turn(index + 1))
    const withDurable = buildPack([jiraSolution, ...turns], 'jira harness conectei backlog', { now: NOW })
    expect(withDurable.entries.filter((entry) => entry.cls === 'turn').length).toBeLessThanOrEqual(2)
    const onlyTurns = buildPack(turns, 'jira harness conectei backlog', { now: NOW })
    expect(onlyTurns.entries.length).toBeGreaterThan(2)
    expect(onlyTurns.entries.length).toBeLessThanOrEqual(4)
  })

  it('follows the links of the best match to durable neighbours, in both directions, and says through which page', () => {
    const decision = page({ slug: 'decisao-oauth', title: 'Decisão: usar OAuth no Jira', memoryType: 'decision', tags: ['oauth'], terms: ['oauth', 'login'], links: [], backlinks: [] })
    const guide = page({ slug: 'guia-token', title: 'Guia do token de API', memoryType: 'convention', tags: ['token'], terms: ['token', 'api'], links: ['mcp-do-jira-conectado'] })
    const seed = { ...jiraSolution, links: ['decisao-oauth'], backlinks: ['guia-token', 'turno-1'] }
    const result = buildPack([seed, decision, guide, turn(1)], 'como conectei o Jira no harness', { now: NOW })
    const bySlug = Object.fromEntries(result.entries.map((entry) => [entry.slug, entry]))
    expect(bySlug['mcp-do-jira-conectado'].via).toBeUndefined()
    expect(bySlug['decisao-oauth'].via).toBe('mcp-do-jira-conectado')
    expect(bySlug['guia-token'].via).toBe('mcp-do-jira-conectado')
    expect(result.text).toContain('ligada a [mcp-do-jira-conectado]')
    // A turn log that links back is not carried along as a neighbour (it would only be found when it matches).
    expect(result.entries.find((entry) => entry.slug === 'turno-1' && entry.via)).toBeUndefined()
  })

  it('does not send again a page that is already in the history, until it changes', () => {
    const seen = new Map([['mcp-do-jira-conectado', jiraSolution.updated]])
    const again = buildPack([jiraSolution, backlog], 'jira conector backlog', { now: NOW, seen })
    expect(again.entries.map((entry) => entry.slug)).not.toContain('mcp-do-jira-conectado')
    expect(again.alreadySeen).toBe(1)
    const edited = buildPack([{ ...jiraSolution, updated: '2026-10-27T11:00:00Z' }, backlog], 'jira conector backlog', { now: NOW, seen })
    expect(edited.entries.map((entry) => entry.slug)).toContain('mcp-do-jira-conectado')
    const anyStamp = buildPack([jiraSolution], 'jira conector', { now: NOW, seen: new Map([['mcp-do-jira-conectado', '*']]) })
    expect(anyStamp.text).toBe('')
  })

  it('leaves out the pages it is told to exclude, such as the session\'s own capsule', () => {
    const capsule = page({ slug: 'estado-x', title: 'Estado: Jira conectado', tags: ['estado', 'em-aberto', 'jira'], context: 'sessao:ses_1', memoryType: 'pending', terms: ['jira', 'conectado'] })
    const withIt = buildPack([jiraSolution, capsule], 'conectei o jira', { now: NOW })
    expect(withIt.entries.map((entry) => entry.slug)).toContain('estado-x')
    const without = buildPack([jiraSolution, capsule], 'conectei o jira', { now: NOW, exclude: (candidate) => candidate.context === 'sessao:ses_1' })
    expect(without.entries.map((entry) => entry.slug)).not.toContain('estado-x')
    expect(without.entries.map((entry) => entry.slug)).toContain('mcp-do-jira-conectado')
  })

  it('stays inside its character budget', () => {
    const big = Array.from({ length: 10 }, (_, index) =>
      page({ slug: `p${index}`, title: `Deploy ${index} em staging`, memoryType: 'solution', tags: ['deploy'], terms: ['deploy', 'staging'], summary: 'x'.repeat(400) })
    )
    const result = buildPack(big, 'deploy staging', { now: NOW, budgetChars: 700 })
    expect(result.entries.length).toBeGreaterThanOrEqual(1)
    expect(result.text.length).toBeLessThan(700 + 200)
  })

  it('marks an old page so the model checks it before trusting it', () => {
    const old = page({ slug: 'velha', title: 'Convenção de nomes', memoryType: 'convention', updated: '2026-06-01T00:00:00Z', tags: ['nomes'], terms: ['nomes', 'convencao'] })
    expect(buildPack([old], 'convenção de nomes', { now: NOW }).text).toContain('(antigo: confira)')
  })
})
