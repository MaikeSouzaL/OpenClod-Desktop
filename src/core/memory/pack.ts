import type { MemoryPageSummary } from './project.js'

/**
 * The "synapses" of the project memory: given what the user asked, find the few pages that matter and the pages they
 * are wired to, and hand them over as a short list the model can open (`memory_page read`) and keep following.
 *
 * This replaces dumping the same 7 000-character briefing and 7 000-character recall into every prompt. Measured on a
 * real project's memory (73 pages, 27 of them auto-generated "Índice: <palavra>" hubs about words like "abre" and
 * "falta"): for "como conectei o Jira no harness" the long-term index returned two hubs first and left the one page that
 * answers it (a durable solution) out of its first eight results. So pages are ranked by what they ARE
 * (a decision or a solution beats a turn log, a hub is never recalled), by how much of the request they cover, and by how
 * recently they were touched; the best ones pull in their neighbours through links and backlinks; a request that matches
 * nothing (a greeting) recalls nothing.
 */

export type PackClass = 'durable' | 'session' | 'turn' | 'hub'

export interface PackEntry {
  slug: string
  title: string
  cls: PackClass
  score: number
  /** Slug of the page whose link brought this one in (a neighbour, not a direct match). */
  via?: string
}

export interface PackOptions {
  now?: number
  /** Most pages in the pack. */
  limit?: number
  /** Most characters of the rendered pack. */
  budgetChars?: number
  /** A page below this score is not recalled. */
  minScore?: number
  /** Pages already placed in the history: slug -> `updated` stamp they had. Skipped while unchanged. */
  seen?: Map<string, string>
  /** Slugs the long-term index (full text search) ranks best for the same request, best first. */
  indexed?: string[]
  /** Pages that must not be recalled (the session's own continuity capsule: its content is already in the history). */
  exclude?: (page: MemoryPageSummary) => boolean
}

export interface PackResult {
  text: string
  entries: PackEntry[]
  /** Pages that matched but were already in the history. */
  alreadySeen: number
}

const DAY = 86_400_000

/** Words that carry no subject: questions, pronouns, greetings, fillers of a chat request. */
const FILLER = new Set(
  (
    'ola oie oii opa hey hello bom boa dia tarde noite obrigado obrigada valeu certo beleza entao tudo bem claro show pode favor ' +
    'por faz fazer fazendo feito tente tentar novamente nova novo continue continua continuar agora aqui ali isso isto esse essa ' +
    'este esta aquele aquela nosso nossa nossos nossas meu minha meus minhas seu sua seus suas voce voces estou estamos esta ' +
    'sao foi fui ser ter tem tinha ainda tambem apenas sobre entre ate mais menos muito pouco todo toda todos todas cada outro ' +
    'outra qual quais quando onde quem porque pois mas porem que uma uns umas dos das nos nas pelo pela num numa com sem para ' +
    'como the and for you que vou vamos quero queria preciso precisa gostaria poderia pode podemos depois antes ver veja olha ' +
    'diga dizer mostra mostre me nos te lhe eles elas dele dela deles delas coisa coisas parte partes jeito forma tipo ' +
    'responda resposta pergunta perguntas somente soh apenas palavra frase linha linhas'
  ).split(/\s+/)
)

export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * Portuguese verbs and nouns inflect (conectei, conectado, conector; ícone, ícones): a plural "s" is dropped and the first
 * six letters are compared, which ties the common inflections together without a dictionary.
 */
export function stem(word: string): string {
  const singular = word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
  return singular.length > 6 ? singular.slice(0, 6) : singular
}

/** Stems of the words of a request that say something about its subject. */
export function significantStems(query: string): string[] {
  const out: string[] = []
  for (const word of normalizeText(query).split(/[^a-z0-9]+/)) {
    if (word.length < 3 || word.length > 40 || FILLER.has(word) || /^\d+$/.test(word)) continue
    const value = stem(word)
    if (!out.includes(value)) out.push(value)
  }
  return out.slice(0, 16)
}

function stemSet(words: string[]): Set<string> {
  return new Set(words.map(stem))
}

export function pageClass(page: MemoryPageSummary): PackClass {
  if (page.kind === 'session') return 'session'
  if (page.kind === 'turn') return 'turn'
  // Auto-generated tag hubs ("Índice: abre"): navigation for a human, noise for a search.
  if (page.tags.includes('indice') || /^índice:/i.test(page.title)) return 'hub'
  return 'durable'
}

function kindWeight(page: MemoryPageSummary, cls: PackClass, ageDays: number): number {
  if (cls === 'hub') return 0
  if (cls === 'session') return 0.5
  if (cls === 'turn') return 0.4
  let weight = 1
  switch (page.memoryType) {
    case 'decision':
      weight = 1.25
      break
    case 'solution':
    case 'convention':
      weight = 1.2
      break
    case 'preference':
      weight = 1.15
      break
    case 'pending':
      // An open item that nobody touched for weeks is more likely stale than urgent.
      weight = ageDays > 21 ? 0.7 : 1.1
      break
    default:
      weight = 1
  }
  return page.pinned ? weight * 1.3 : weight
}

function isLive(page: MemoryPageSummary): boolean {
  return page.status !== 'superseded' && page.status !== 'invalidated'
}

interface Scored {
  page: MemoryPageSummary
  cls: PackClass
  score: number
}

/** Direct matches for the request, best first. Exported for tests and for the context meter. */
export function rankPages(pages: MemoryPageSummary[], query: string, options: PackOptions = {}): Scored[] {
  return rankStems(pages, significantStems(query), options)
}

/** Same ranking for stems that were already computed (stemming twice is not idempotent). */
export function rankStems(pages: MemoryPageSummary[], stems: string[], options: PackOptions = {}): Scored[] {
  if (!stems.length) return []
  const now = options.now ?? Date.now()
  const indexedRank = new Map((options.indexed ?? []).map((slug, index) => [slug, index]))
  const out: Scored[] = []
  for (const page of pages) {
    if (!isLive(page) || options.exclude?.(page)) continue
    const cls = pageClass(page)
    if (cls === 'hub') continue
    const title = stemSet(normalizeText(page.title).split(/[^a-z0-9]+/).filter((word) => word.length >= 3))
    const tags = stemSet(page.tags.flatMap((tag) => normalizeText(tag).split(/[^a-z0-9]+/)).filter((word) => word.length >= 3))
    const body = stemSet(page.terms)
    let titleHits = 0
    let tagHits = 0
    let bodyHits = 0
    let matched = 0
    for (const value of stems) {
      const inTitle = title.has(value)
      const inTags = tags.has(value)
      const inBody = body.has(value)
      if (inTitle) titleHits++
      if (inTags) tagHits++
      if (inBody) bodyHits++
      if (inTitle || inTags || inBody) matched++
    }
    const indexedAt = indexedRank.get(page.slug)
    if (!matched && indexedAt === undefined) continue
    const coverage = matched / stems.length
    // A weak match: a body word or two out of a long request, and nothing in the title or tags.
    if (titleHits + tagHits === 0 && coverage < 0.34 && indexedAt === undefined) continue
    const lexical = (titleHits * 3 + tagHits * 2.5 + bodyHits) / stems.length
    const ageDays = Math.max(0, (now - Date.parse(page.updated || '')) / DAY) || 0
    const recency = 1 + 0.25 * Math.exp(-ageDays / 30)
    const fusion = indexedAt === undefined ? 0 : 3 / (5 + indexedAt)
    const score = lexical * (0.5 + 0.5 * coverage) * kindWeight(page, cls, ageDays) * recency + fusion * (cls === 'durable' ? 1 : 0.5)
    out.push({ page, cls, score })
  }
  return out.sort((a, b) => b.score - a.score || b.page.updated.localeCompare(a.page.updated))
}

/**
 * The durable pages a page being written is about. Linking them is what makes the memory a graph instead of a pile: the
 * real project had 3 durable pages and no link between any two of them, so there was nothing to follow. Only the title
 * and the tags are matched (a long body would dilute the score), and only a clear match becomes a link.
 */
export function relatedDurable(
  pages: MemoryPageSummary[],
  draft: { slug: string; title: string; tags: string[]; hint?: string },
  options: { limit?: number } = {}
): PackEntry[] {
  // Tags that say what KIND of page it is, not what it is about: they never tie two pages together.
  const kindTags = new Set(['estado', 'em-aberto', 'interrompido', 'concluido', 'indice', 'turno', 'sessao', 'automatico', 'auto', 'fato', 'fact'])
  const tags = new Set(draft.tags.map((tag) => normalizeText(tag)).filter((tag) => !kindTags.has(tag)))
  const words = significantStems(`${draft.title} ${draft.hint ?? ''}`).slice(0, 12)
  const out: PackEntry[] = []
  for (const page of pages) {
    if (page.slug === draft.slug || !isLive(page) || pageClass(page) !== 'durable') continue
    const sharedTags = page.tags.filter((tag) => tags.has(normalizeText(tag))).length
    const title = stemSet(normalizeText(page.title).split(/[^a-z0-9]+/).filter((word) => word.length >= 3))
    const sharedWords = words.filter((value) => title.has(value)).length
    // A tag in common is a subject in common; without one, two words of the title are needed.
    if (sharedTags === 0 && sharedWords < 2) continue
    out.push({ slug: page.slug, title: page.title, cls: 'durable', score: sharedTags * 3 + sharedWords * 2 })
  }
  const updated = new Map(pages.map((page) => [page.slug, page.updated]))
  return out
    .sort((a, b) => b.score - a.score || (updated.get(b.slug) ?? '').localeCompare(updated.get(a.slug) ?? ''))
    .slice(0, options.limit ?? 3)
}

function normalizeRef(value: string): string {
  return normalizeText(value).trim().replace(/^pages\//, '').replace(/\.md$/i, '').replace(/\s+/g, '-')
}

function oneLine(page: MemoryPageSummary, max: number): string {
  const text = page.summary
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function typeLabel(page: MemoryPageSummary, cls: PackClass): string {
  if (cls === 'turn') return 'turno'
  if (cls === 'session') return 'sessão'
  return page.memoryType && page.memoryType !== 'fact' ? page.memoryType : 'assunto'
}

function stamp(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : ''
}

/**
 * The pack for one request: direct matches, plus the durable pages the best of them are linked to ("synapses"), cut to
 * a budget. Empty text means nothing in the memory is worth the tokens.
 */
export function buildPack(pages: MemoryPageSummary[], query: string, options: PackOptions = {}): PackResult {
  const limit = options.limit ?? 6
  const budget = options.budgetChars ?? 3_200
  const minScore = options.minScore ?? 0.9
  const all = rankPages(pages, query, options).filter((item) => item.score >= minScore)
  if (!all.length) return { text: '', entries: [], alreadySeen: 0 }
  // The weak tail of a ranking is noise next to a strong match; turn logs are evidence, not knowledge, so only a couple
  // of them ride along when durable pages answer the request.
  const top = all[0].score
  const ranked = all.filter((item) => item.score >= top * 0.3)
  const durable = ranked.filter((item) => item.cls === 'durable')
  const episodic = ranked.filter((item) => item.cls !== 'durable')
  const picked = [...durable.slice(0, limit), ...episodic.slice(0, durable.length ? 2 : 4)].sort((a, b) => b.score - a.score).slice(0, limit)

  const byRef = new Map<string, MemoryPageSummary>()
  for (const page of pages) {
    byRef.set(normalizeRef(page.slug), page)
    byRef.set(normalizeRef(page.title), page)
  }
  const chosen = new Map<string, PackEntry & { page: MemoryPageSummary }>()
  for (const item of picked) {
    chosen.set(item.page.slug, { slug: item.page.slug, title: item.page.title, cls: item.cls, score: item.score, page: item.page })
  }

  // Neighbours of the three best matches: the pages they link to and the pages that link to them.
  for (const seed of picked.slice(0, 3)) {
    const neighbours = new Set<string>()
    for (const link of seed.page.links ?? []) {
      const target = byRef.get(normalizeRef(link))
      if (target) neighbours.add(target.slug)
    }
    for (const back of seed.page.backlinks ?? []) neighbours.add(back)
    for (const slug of neighbours) {
      const page = byRef.get(normalizeRef(slug))
      if (!page || page.slug === seed.page.slug || !isLive(page)) continue
      const cls = pageClass(page)
      // Only durable knowledge travels along a link; turn logs and sessions are reached through search when they matter.
      if (cls !== 'durable') continue
      const score = seed.score * 0.55
      const existing = chosen.get(page.slug)
      if (existing) {
        if (!existing.via && score > existing.score) existing.score = score
        continue
      }
      chosen.set(page.slug, { slug: page.slug, title: page.title, cls, score, via: seed.page.slug, page })
    }
  }

  const now = options.now ?? Date.now()
  const ordered = [...chosen.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  const lines: string[] = []
  const entries: PackEntry[] = []
  let alreadySeen = 0
  let used = 0
  for (const item of ordered) {
    const known = options.seen?.get(item.slug)
    if (known !== undefined && (known === '*' || known === item.page.updated)) {
      alreadySeen++
      continue
    }
    const age = Math.max(0, Math.round((now - Date.parse(item.page.updated || '')) / DAY))
    const label = `${typeLabel(item.page, item.cls)}${stamp(item.page.updated) ? `, ${stamp(item.page.updated)}` : ''}${age > 45 ? ' (antigo: confira)' : ''}`
    const via = item.via ? ` ↳ ligada a [${item.via}]` : ''
    const line = `- ${item.title} [${item.slug}] (${label})${via}\n  ${oneLine(item.page, 170)}`
    if (used + line.length > budget && lines.length) break
    lines.push(line)
    used += line.length + 1
    entries.push({ slug: item.slug, title: item.title, cls: item.cls, score: item.score, via: item.via })
  }
  if (!lines.length) return { text: '', entries: [], alreadySeen }
  return {
    text: [...lines, 'Abra uma página com memory_page action=read slug=<slug>: ela mostra os links e backlinks para seguir.'].join('\n'),
    entries,
    alreadySeen
  }
}
