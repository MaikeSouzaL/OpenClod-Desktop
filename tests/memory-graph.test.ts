import { describe, expect, it } from 'vitest'
import { buildMemoryGraph, buildNativeMemoryGraph, type MemoryGraphSource } from '../src/core/memory/graph'
import type { MemoryPage } from '../src/core/memory/project'

function page(slug: string, title: string, body: string, tags: string[] = []): MemoryPage {
  return {
    slug,
    title,
    body,
    tags,
    pinned: false,
    created: '2026-10-24T12:00:00.000Z',
    updated: '2026-10-24T12:00:00.000Z',
    source: 'test'
  }
}

describe('native memory graph', () => {
  it('connects explicit Obsidian wikilinks by slug or title', () => {
    const graph = buildNativeMemoryGraph([
      page('jira-qa', 'Jira QA', 'Veja [[Autenticação MCP]] e [[entidades-do-crm]].', ['jira']),
      page('autenticacao-mcp', 'Autenticação MCP', 'Fluxo OAuth.', ['mcp']),
      page('entidades-do-crm', 'Entidades do CRM', 'Tabelas e entidades.', ['crm'])
    ])
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'autenticacao-mcp', target: 'jira-qa', kind: 'link' }),
        expect.objectContaining({ source: 'entidades-do-crm', target: 'jira-qa', kind: 'link' })
      ])
    )
    expect(graph.nodes.find((node) => node.id === 'jira-qa')?.degree).toBe(2)
  })

  it('creates semantic edges from tags and significant full-body terms', () => {
    const graph = buildNativeMemoryGraph([
      page('memory-a', 'Memory A', 'indexação memória conexões grafo recuperação inteligente', ['openclod']),
      page('memory-b', 'Memory B', 'conexões grafo memória busca recuperação inteligente', ['openclod']),
      page('unrelated', 'Outro', 'notas sobre slides e layout visual', ['design'])
    ])
    expect(graph.edges.some((edge) => edge.source === 'memory-a' && edge.target === 'memory-b' && edge.kind === 'tag')).toBe(true)
    expect(graph.edges.some((edge) => edge.target === 'unrelated' || edge.source === 'unrelated')).toBe(false)
  })

  it('deduplicates the edge and keeps the strongest relationship', () => {
    const graph = buildNativeMemoryGraph([
      page('a', 'A', '[[B]] memória indexação', ['x']),
      page('b', 'B', 'memória indexação', ['x'])
    ])
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ kind: 'link', weight: 12 })
  })

  it('caps semantic degree for large groups while preserving explicit links', () => {
    const pages = Array.from({ length: 120 }, (_, index) => page(`p${index}`, `Página ${index}`, index === 0 ? '[[p119]]' : 'memória grafo conexão', ['grupo']))
    const graph = buildNativeMemoryGraph(pages)
    expect(graph.edges.length).toBeLessThanOrEqual(721)
    expect(graph.nodes.every((node) => node.degree <= 13)).toBe(true)
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'p0', target: 'p119', kind: 'link' })]))
  })
})

describe('memory graph of a big wiki', () => {
  const source = (i: number, extra: Partial<MemoryGraphSource> = {}): MemoryGraphSource => ({
    slug: `p${i}`,
    title: `Página ${i}`,
    tags: ['turno', `assunto${i % 50}`],
    updated: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
    terms: [`termo${i % 70}`, `outro${i % 90}`, 'comum', 'pedido'],
    summary: `resumo da página ${i}`,
    rank: i % 10 === 0 ? 'topic' : 'turn',
    ...extra
  })

  it('builds 5000 pages without comparing every pair, and shows only the most relevant ones', () => {
    const sources = Array.from({ length: 5000 }, (_, i) => source(i, i % 7 === 0 ? { links: [`p${(i + 1) % 5000}`] } : {}))
    const started = performance.now()
    const graph = buildMemoryGraph(sources, { limit: 800 })
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(3_000)
    expect(graph.total).toBe(5000)
    expect(graph.nodes).toHaveLength(800)
    const shown = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every((edge) => shown.has(edge.source) && shown.has(edge.target))).toBe(true)
    // A tag on every page ("turno") is a chain, not 12 million pairs: semantic degree stays capped.
    expect(Math.max(...graph.nodes.map((node) => node.degree))).toBeLessThanOrEqual(14)
  })

  it('answers a search with the matching pages and the pages linked to them', () => {
    const sources = [
      source(1, { title: 'Faturamento do pedido', links: ['p2'] }),
      source(2, { title: 'Contrato assinado' }),
      source(3, { title: 'Outro assunto' }),
      ...Array.from({ length: 50 }, (_, i) => source(10 + i))
    ]
    const graph = buildMemoryGraph(sources, { limit: 10, query: 'faturamento' })
    expect(graph.total).toBe(1)
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['p1', 'p2'])
    expect(graph.edges).toEqual([expect.objectContaining({ kind: 'link' })])
  })

  it('links every pair of a rare tag, and only near neighbours in time of a common one', () => {
    const rare = Array.from({ length: 4 }, (_, i) => source(i, { tags: ['raro'], terms: [] }))
    const common = Array.from({ length: 60 }, (_, i) => source(100 + i, { tags: ['frequente'], terms: [] }))
    const graph = buildMemoryGraph([...rare, ...common])
    const among = (prefix: number[]): number =>
      graph.edges.filter((edge) => prefix.includes(Number(edge.source.slice(1))) && prefix.includes(Number(edge.target.slice(1)))).length
    expect(among([0, 1, 2, 3])).toBe(6)
    const chain = common.map((_, i) => 100 + i)
    expect(among(chain)).toBeLessThanOrEqual(60 * 2)
    expect(among(chain)).toBeGreaterThanOrEqual(59)
  })
})
