import type { MemoryPage } from './project.js'

export interface NativeMemoryGraphNode {
  id: string
  path: string
  title: string
  kind: 'session' | 'page' | 'fact'
  tags: string[]
  updated: string
  degree: number
  terms: string[]
  summary?: string
}

export interface NativeMemoryGraphEdge {
  source: string
  target: string
  kind: 'link' | 'tag' | 'term'
  weight: number
}

/**
 * Obsidian-style graph over the source-of-truth markdown pages. Explicit
 * wikilinks dominate; shared tags and terms keep semantically related turns
 * visible even when the agent has not written a link yet.
 */
export function buildNativeMemoryGraph(pages: MemoryPage[]): {
  nodes: NativeMemoryGraphNode[]
  edges: NativeMemoryGraphEdge[]
} {
  const nodes: NativeMemoryGraphNode[] = pages.map((page) => ({
    id: page.slug,
    path: page.slug,
    title: page.title,
    kind: page.tags.includes('sessao') ? 'session' : 'page',
    tags: page.tags,
    updated: page.updated,
    degree: 0,
    terms: graphTerms(`${page.title} ${page.body}`),
    summary: page.body.replace(/\s+/g, ' ').trim().slice(0, 600)
  }))
  const edges = new Map<string, NativeMemoryGraphEdge>()
  const add = (source: string, target: string, kind: NativeMemoryGraphEdge['kind'], weight: number): void => {
    if (source === target) return
    const [a, b] = source < target ? [source, target] : [target, source]
    const key = `${a}|${b}`
    const existing = edges.get(key)
    if (!existing || existing.weight < weight) edges.set(key, { source: a, target: b, kind, weight })
  }

  const byReference = new Map<string, string>()
  for (const page of pages) {
    byReference.set(normalizeReference(page.slug), page.slug)
    byReference.set(normalizeReference(page.title), page.slug)
  }
  for (const page of pages) {
    for (const match of page.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      const target = byReference.get(normalizeReference(match[1]))
      if (target) add(page.slug, target, 'link', 12)
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const tags = intersectionCount(nodes[i].tags, nodes[j].tags)
      const terms = intersectionCount(nodes[i].terms, nodes[j].terms)
      if (tags) add(nodes[i].id, nodes[j].id, 'tag', 4 + tags)
      else if (terms >= 2) add(nodes[i].id, nodes[j].id, 'term', Math.min(8, terms))
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges.values()) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (source) source.degree++
    if (target) target.degree++
  }
  return { nodes, edges: [...edges.values()].sort((a, b) => b.weight - a.weight) }
}

function normalizeReference(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.md$/i, '')
    .replace(/\s+/g, '-')
}

function intersectionCount(a: string[], b: string[]): number {
  const right = new Set(b)
  return a.filter((value) => right.has(value)).length
}

function graphTerms(text: string): string[] {
  const stop = new Set([
    'para', 'pela', 'pelo', 'como', 'mais', 'menos', 'este', 'esta', 'isso', 'aqui', 'sobre',
    'with', 'from', 'that', 'this', 'have', 'will', 'into', 'were', 'your', 'there', 'their',
    'arquivo', 'arquivos', 'sessao', 'resultado', 'pedido', 'projeto', 'openclod', 'ferramenta'
  ])
  const counts = new Map<string, number>()
  for (const value of text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_]+/)) {
    if (value.length < 4 || /^\d+$/.test(value) || stop.has(value)) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([value]) => value)
}
