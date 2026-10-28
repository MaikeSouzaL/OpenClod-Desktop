import { describe, expect, it } from 'vitest'
import { buildNativeMemoryGraph } from '../src/core/memory/graph'
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
