import type { MemoryPage, MemoryPageSummary } from './project.js'

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
  status?: 'active' | 'superseded' | 'invalidated'
}

export interface NativeMemoryGraphEdge {
  source: string
  target: string
  kind: 'link' | 'tag' | 'term'
  weight: number
}

/** One page as the graph needs it: what the wiki's index already keeps in memory, no page read from disk. */
export interface MemoryGraphSource {
  slug: string
  title: string
  tags: string[]
  updated: string
  /** Significant words of the page, most telling first. */
  terms: string[]
  /** `[[wikilinks]]` written in the page (slug or title). */
  links?: string[]
  summary?: string
  status?: 'active' | 'superseded' | 'invalidated'
  pinned?: boolean
  /** Topic pages weigh more than sessions, sessions more than turn logs when the graph must leave pages out. */
  rank?: 'topic' | 'session' | 'turn'
  kind?: NativeMemoryGraphNode['kind']
}

export interface MemoryGraphOptions {
  /** At most this many nodes (the most connected and recent first); the rest is reached by `query`. */
  limit?: number
  /** Only the pages that match (title, tags, words, summary), plus their linked neighbours. */
  query?: string
}

export interface MemoryGraphResult {
  nodes: NativeMemoryGraphNode[]
  edges: NativeMemoryGraphEdge[]
  /** Pages in the memory (or matching the query) before the limit. */
  total: number
}

/** The whole graph of a memory, computed once per version of it; each view (with or without a search) is cut from it. */
export interface PreparedMemoryGraph {
  sources: MemoryGraphSource[]
  index: Map<string, number>
  edges: Array<{ a: number; b: number; edge: NativeMemoryGraphEdge }>
  linkDegree: Uint32Array
  degree: Uint32Array
  terms: string[][]
  /** Title, tags and summary without accents, for the search. */
  haystacks: string[]
}

/** Semantic edges a page may have: a big group stays a cluster instead of a hairball. */
const SEMANTIC_DEGREE = 12
/** A tag or word on more pages than this links each page only to its nearest ones in time (a chain, not every pair). */
const MIN_COMMON = 40
const COMMON_SHARE = 0.02
const WINDOW = 2
/** Words of a page that tie it to others: the first significant ones (title, tags, the start of the text). */
const GRAPH_TERMS = 20

const STOP = new Set([
  'para', 'pela', 'pelo', 'como', 'mais', 'menos', 'este', 'esta', 'isso', 'aqui', 'sobre',
  'with', 'from', 'that', 'this', 'have', 'will', 'into', 'were', 'your', 'there', 'their',
  'arquivo', 'arquivos', 'sessao', 'resultado', 'pedido', 'projeto', 'openclod', 'ferramenta'
])

/**
 * Obsidian-style graph over the source-of-truth markdown pages. Explicit wikilinks dominate; shared tags and terms keep
 * semantically related pages visible even when no link was written.
 *
 * Built from the wiki's in-memory index with an inverted index of tags and words, linear in the size of the memory: the
 * old version compared every pair of pages (10 million pairs for 4600 pages) on the main process and froze the app for
 * over a minute. It yields now and then, so the asynchronous version never holds the main process for long.
 */
function* prepare(sources: MemoryGraphSource[], extraEdges: NativeMemoryGraphEdge[]): Generator<void, PreparedMemoryGraph> {
  const n = sources.length
  let work = 0
  const busy = (): boolean => (++work & 2047) === 0
  const index = new Map(sources.map((source, i) => [source.slug, i]))
  const byReference = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    byReference.set(normalizeReference(sources[i].slug), i)
    byReference.set(normalizeReference(sources[i].title), i)
    if (busy()) yield
  }

  const edges = new Map<number, { a: number; b: number; edge: NativeMemoryGraphEdge }>()
  const linkDegree = new Uint32Array(n)
  const add = (i: number, j: number, kind: NativeMemoryGraphEdge['kind'], weight: number): boolean => {
    if (i === j) return false
    const [a, b] = sources[i].slug < sources[j].slug ? [i, j] : [j, i]
    const key = a * n + b
    const existing = edges.get(key)
    if (existing && existing.edge.weight >= weight) return false
    edges.set(key, { a, b, edge: { source: sources[a].slug, target: sources[b].slug, kind, weight } })
    return !existing
  }

  for (let i = 0; i < n; i++) {
    for (const link of sources[i].links ?? []) {
      const target = byReference.get(normalizeReference(link))
      if (target !== undefined && add(i, target, 'link', 12)) {
        linkDegree[i]++
        linkDegree[target]++
      }
    }
    if (busy()) yield
  }
  for (const edge of extraEdges) {
    const a = index.get(edge.source)
    const b = index.get(edge.target)
    if (a !== undefined && b !== undefined) add(a, b, edge.kind, edge.weight)
  }

  // Inverted index: each tag and word → the pages that have it, in the order of the sources (the wiki's, newest first).
  const terms: string[][] = []
  for (let i = 0; i < n; i++) {
    terms.push(graphTerms(sources[i]))
    if (busy()) yield
  }
  const tagPosts = new Map<string, number[]>()
  const termPosts = new Map<string, number[]>()
  const post = (map: Map<string, number[]>, key: string, i: number): void => {
    const list = map.get(key)
    if (list) list.push(i)
    else map.set(key, [i])
  }
  for (let i = 0; i < n; i++) {
    for (const tag of new Set(sources[i].tags)) post(tagPosts, tag, i)
    for (const term of terms[i]) post(termPosts, term, i)
    if (busy()) yield
  }

  // Pairs that share something, counted once per tag/word: all pairs of a rare one, only near neighbours of a common one.
  const common = Math.max(MIN_COMMON, Math.ceil(n * COMMON_SHARE))
  const sharedTags = new Map<number, number>()
  const sharedTerms = new Map<number, number>()
  for (const [posts, shared] of [[tagPosts, sharedTags], [termPosts, sharedTerms]] as const) {
    for (const list of posts.values()) {
      if (list.length < 2) continue
      const wide = list.length <= common
      for (let p = 0; p < list.length; p++) {
        const end = wide ? list.length : Math.min(list.length, p + 1 + WINDOW)
        for (let q = p + 1; q < end; q++) {
          const key = Math.min(list[p], list[q]) * n + Math.max(list[p], list[q])
          shared.set(key, (shared.get(key) ?? 0) + 1)
          if (busy()) yield
        }
      }
    }
  }

  // Strongest relationships first, each page keeping at most SEMANTIC_DEGREE of them. The weights are small integers:
  // buckets instead of sorting hundreds of thousands of pairs at once.
  const buckets = new Map<number, number[]>()
  const bucket = (weight: number, key: number): void => {
    const list = buckets.get(weight)
    if (list) list.push(key)
    else buckets.set(weight, [key])
  }
  for (const [key, count] of sharedTags) {
    bucket(4 + count, key)
    if (busy()) yield
  }
  for (const [key, count] of sharedTerms) {
    if (count >= 2 && !sharedTags.has(key)) bucket(Math.min(8, count), key)
    if (busy()) yield
  }
  const semanticDegree = new Uint16Array(n)
  for (const weight of [...buckets.keys()].sort((x, y) => y - x)) {
    for (const key of buckets.get(weight)!) {
      const a = Math.floor(key / n)
      const b = key % n
      if (semanticDegree[a] < SEMANTIC_DEGREE && semanticDegree[b] < SEMANTIC_DEGREE && add(a, b, sharedTags.has(key) ? 'tag' : 'term', weight)) {
        semanticDegree[a]++
        semanticDegree[b]++
      }
      if (busy()) yield
    }
  }

  const degree = new Uint32Array(n)
  for (const { a, b } of edges.values()) {
    degree[a]++
    degree[b]++
  }
  const haystacks: string[] = []
  for (const source of sources) {
    haystacks.push(normalizeText(`${source.title} ${source.tags.join(' ')} ${source.summary ?? ''}`))
    if (busy()) yield
  }
  return { sources, index, edges: [...edges.values()], linkDegree, degree, terms, haystacks }
}

export function prepareMemoryGraph(sources: MemoryGraphSource[], extraEdges: NativeMemoryGraphEdge[] = []): PreparedMemoryGraph {
  const steps = prepare(sources, extraEdges)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/** The same, giving the event loop a turn every ~10 ms: the main process keeps answering while a big graph is built. */
export async function prepareMemoryGraphAsync(sources: MemoryGraphSource[], extraEdges: NativeMemoryGraphEdge[] = []): Promise<PreparedMemoryGraph> {
  const steps = prepare(sources, extraEdges)
  let slice = performance.now()
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    if (performance.now() - slice > 10) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      slice = performance.now()
    }
  }
}

/**
 * What the screen shows: all the pages when they fit; else the most connected, pinned and recent (matching the query,
 * with their linked neighbours, when there is one).
 */
export function selectMemoryGraph(prepared: PreparedMemoryGraph, options: MemoryGraphOptions = {}): MemoryGraphResult {
  const { sources, edges, linkDegree, degree, terms, haystacks } = prepared
  const n = sources.length
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const weight = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const source = sources[i]
    const rankBonus = source.rank === 'topic' ? 6 : source.rank === 'session' ? 3 : 0
    weight[i] = linkDegree[i] * 3 + degree[i] + rankBonus + (source.pinned ? 20 : 0) - i / Math.max(1, n)
  }
  const query = normalizeText(options.query ?? '').trim()
  let pool: number[] = sources.map((_, i) => i)
  if (query) {
    const words = query.split(/[^a-z0-9_]+/).filter((word) => word.length >= 2)
    pool = pool.filter((i) => words.every((word) => haystacks[i].includes(word) || sources[i].terms.includes(word)))
  }
  const total = pool.length
  let chosen: Set<number>
  if (pool.length <= limit && !query) {
    chosen = new Set(pool)
  } else {
    chosen = new Set(pool.sort((x, y) => weight[y] - weight[x]).slice(0, limit))
    if (query && chosen.size < limit) {
      // The pages linked to what matched, so the matches are seen in their context.
      const around = new Set<number>()
      for (const { a, b, edge } of edges) {
        if (edge.kind !== 'link') continue
        if (chosen.has(a) && !chosen.has(b)) around.add(b)
        else if (chosen.has(b) && !chosen.has(a)) around.add(a)
      }
      for (const i of [...around].sort((x, y) => weight[y] - weight[x])) {
        if (chosen.size >= limit) break
        chosen.add(i)
      }
    }
  }

  const kept = edges.filter(({ a, b }) => chosen.has(a) && chosen.has(b)).map(({ edge }) => edge)
  kept.sort((x, y) => y.weight - x.weight)
  const shownDegree = new Map<string, number>()
  for (const edge of kept) {
    shownDegree.set(edge.source, (shownDegree.get(edge.source) ?? 0) + 1)
    shownDegree.set(edge.target, (shownDegree.get(edge.target) ?? 0) + 1)
  }
  const nodes: NativeMemoryGraphNode[] = [...chosen]
    .sort((a, b) => a - b)
    .map((i) => {
      const source = sources[i]
      return {
        id: source.slug,
        path: source.slug,
        title: source.title,
        kind: source.kind ?? (source.tags.includes('sessao') ? 'session' : 'page'),
        tags: source.tags,
        updated: source.updated,
        degree: shownDegree.get(source.slug) ?? 0,
        terms: terms[i].slice(0, 12),
        summary: source.summary,
        status: source.status ?? 'active'
      }
    })
  return { nodes, edges: kept, total }
}

export function buildMemoryGraph(
  sources: MemoryGraphSource[],
  options: MemoryGraphOptions & { extraEdges?: NativeMemoryGraphEdge[] } = {}
): MemoryGraphResult {
  return selectMemoryGraph(prepareMemoryGraph(sources, options.extraEdges), options)
}

/** The graph of whole pages (tests, small memories): the same graph, with the words and links read from each body. */
export function buildNativeMemoryGraph(pages: MemoryPage[]): {
  nodes: NativeMemoryGraphNode[]
  edges: NativeMemoryGraphEdge[]
} {
  const sources: MemoryGraphSource[] = pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    tags: page.tags,
    updated: page.updated,
    terms: bodyTerms(`${page.title} ${page.body}`),
    links: [...page.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]),
    summary: page.body.replace(/\s+/g, ' ').trim().slice(0, 600),
    status: page.status ?? 'active'
  }))
  const { nodes, edges } = buildMemoryGraph(sources)
  return { nodes, edges }
}

/** A summary of the wiki's index as a graph source. */
export function graphSourceOf(summary: MemoryPageSummary): MemoryGraphSource {
  return {
    slug: summary.slug,
    title: summary.title,
    tags: summary.tags,
    updated: summary.updated,
    terms: summary.terms,
    links: summary.links,
    summary: summary.summary,
    status: summary.status,
    pinned: summary.pinned,
    rank: summary.kind
  }
}

function graphTerms(source: Pick<MemoryGraphSource, 'terms'>): string[] {
  const out: string[] = []
  for (const term of source.terms) {
    if (term.length < 4 || /^\d+$/.test(term) || STOP.has(term)) continue
    out.push(term)
    if (out.length >= GRAPH_TERMS) break
  }
  return out
}

/** The 40 most frequent significant words of a text. */
function bodyTerms(text: string): string[] {
  const counts = new Map<string, number>()
  for (const value of normalizeText(text).split(/[^a-z0-9_]+/)) {
    if (value.length < 4 || /^\d+$/.test(value) || STOP.has(value)) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([value]) => value)
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function normalizeReference(value: string): string {
  return normalizeText(value.trim())
    .replace(/\.md$/i, '')
    .replace(/\s+/g, '-')
}
