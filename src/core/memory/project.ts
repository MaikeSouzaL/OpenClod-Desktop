import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from '../security/policy.js'

/**
 * Per-project long-term memory, modeled on ai-memory's file-first design:
 *
 *   <project memory>/wiki/<slug>.md   the source of truth (human-editable markdown)
 *   <project memory>/index.json       a derived lexical index, rebuildable from the wiki
 *   <project memory>/handoffs.json    claim-once handoffs between sessions/agents
 *
 * Every ProjectMemory instance is rooted inside one project, so a page written
 * by project A can never appear in project B. There is no LLM call and no
 * network access in this layer.
 */

export interface MemoryPageInput {
  title: string
  body: string
  tags?: string[]
  pinned?: boolean
  source?: string
}

export interface MemoryPage {
  slug: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  created: string
  updated: string
  source: string
}

export interface MemoryPageSummary {
  slug: string
  title: string
  tags: string[]
  pinned: boolean
  updated: string
  summary: string
  terms: string[]
}

export interface MemoryHandoff {
  id: string
  state: 'open' | 'claimed' | 'cancelled'
  summary: string
  next: string
  files: string[]
  openQuestions: string[]
  createdAt: string
  claimedAt?: string
  owner?: string
}

export interface MemorySearchHit {
  slug: string
  title: string
  tags: string[]
  updated: string
  score: number
  snippet: string
}

export interface MemoryBrief {
  text: string
  pages: number
  pins: number
  openHandoffs: number
}

export interface MemoryStats {
  root: string
  pages: number
  pinned: number
  openHandoffs: number
  updatedAt?: string
}

interface IndexFile {
  version: 1
  pages: MemoryPageSummary[]
}

interface HandoffFile {
  version: 1
  items: MemoryHandoff[]
}

const MAX_TITLE = 200
const MAX_BODY = 60_000
const MAX_TAGS = 12
const MAX_TERMS = 300
const MAX_BRIEF = 7000

export class ProjectMemory {
  private readonly wikiDir: string
  private readonly indexFile: string
  private readonly handoffsFile: string
  private loadedIndex: IndexFile | null = null
  private loadedHandoffs: HandoffFile | null = null
  private indexSignature = ''

  constructor(readonly root: string) {
    this.wikiDir = path.join(root, 'wiki')
    this.indexFile = path.join(root, 'index.json')
    this.handoffsFile = path.join(root, 'handoffs.json')
  }

  private async ensureDirs(): Promise<void> {
    await fs.promises.mkdir(this.wikiDir, { recursive: true, mode: 0o700 })
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T
    } catch {
      return null
    }
  }

  private async writeAtomic(file: string, text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.promises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(tmp, file)
  }

  /**
   * The wiki is the source of truth: a human (or another agent) may edit or add
   * a `.md` file outside Openclod. The derived index is rebuilt when the folder
   * signature changes, so the UI's "Atualizar" always sees the files on disk.
   */
  private async ensureFresh(): Promise<boolean> {
    const signature = await this.wikiSignature()
    if (this.indexSignature === signature) return false
    this.indexSignature = signature
    this.loadedIndex = null
    return true
  }

  private async wikiSignature(): Promise<string> {
    try {
      const files = (await fs.promises.readdir(this.wikiDir)).filter((file) => file.endsWith('.md')).sort()
      const parts = await Promise.all(
        files.map(async (file) => {
          const stat = await fs.promises.stat(path.join(this.wikiDir, file))
          return `${file}:${stat.size}:${stat.mtimeMs}`
        })
      )
      return parts.join('|')
    } catch {
      return ''
    }
  }

  private async index(): Promise<IndexFile> {
    const stale = await this.ensureFresh()
    if (stale) {
      const rebuilt = await this.rebuildIndex()
      this.loadedIndex = rebuilt
      await this.writeAtomic(this.indexFile, `${JSON.stringify(rebuilt, null, 2)}\n`)
      return rebuilt
    }
    if (this.loadedIndex) return this.loadedIndex
    const stored = await this.readJson<IndexFile>(this.indexFile)
    if (stored && stored.version === 1 && Array.isArray(stored.pages)) {
      this.loadedIndex = stored
      return stored
    }
    const rebuilt = await this.rebuildIndex()
    this.loadedIndex = rebuilt
    await this.writeAtomic(this.indexFile, `${JSON.stringify(rebuilt, null, 2)}\n`)
    return rebuilt
  }

  private async rebuildIndex(): Promise<IndexFile> {
    const pages: MemoryPageSummary[] = []
    try {
      const files = await fs.promises.readdir(this.wikiDir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const page = await this.readPageFile(path.join(this.wikiDir, file))
        if (page) pages.push(summarize(page))
      }
    } catch {
      /* empty memory */
    }
    pages.sort((a, b) => b.updated.localeCompare(a.updated))
    return { version: 1, pages }
  }

  private async readPageFile(file: string): Promise<MemoryPage | null> {
    try {
      const raw = await fs.promises.readFile(file, 'utf8')
      const parsed = parsePage(raw)
      const slug = path.basename(file, '.md')
      return { ...parsed, slug }
    } catch {
      return null
    }
  }

  private async saveIndex(pages: MemoryPageSummary[]): Promise<void> {
    const sorted = [...pages].sort((a, b) => b.updated.localeCompare(a.updated))
    this.loadedIndex = { version: 1, pages: sorted }
    this.indexSignature = await this.wikiSignature()
    await this.writeAtomic(this.indexFile, `${JSON.stringify(this.loadedIndex, null, 2)}\n`)
  }

  /** Creates or updates a page by slug (derived from the title). Returns the summary. */
  async writePage(input: MemoryPageInput): Promise<MemoryPageSummary> {
    await this.ensureDirs()
    const title = clean(input.title, MAX_TITLE) || 'Sem título'
    const body = clean(input.body, MAX_BODY)
    if (!body.trim()) throw new Error('a página precisa de um corpo')
    const tags = cleanTags(input.tags)
    const slug = pageSlug(title)
    const file = path.join(this.wikiDir, `${slug}.md`)
    const now = new Date().toISOString()
    let created = now
    try {
      const existing = await this.readPageFile(file)
      if (existing) created = existing.created
    } catch {
      /* new page */
    }
    const page: MemoryPage = {
      slug,
      title,
      body,
      tags,
      pinned: Boolean(input.pinned),
      created,
      updated: now,
      source: clean(input.source ?? 'agent', 40) || 'agent'
    }
    await this.writeAtomic(file, serializePage(page))
    const index = await this.index()
    const summary = summarize(page)
    const pages = index.pages.filter((item) => item.slug !== slug)
    pages.push(summary)
    await this.saveIndex(pages)
    return summary
  }

  async readPage(slug: string): Promise<MemoryPage | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return null
    return this.readPageFile(path.join(this.wikiDir, `${slug}.md`))
  }

  async listPages(): Promise<MemoryPageSummary[]> {
    return [...(await this.index()).pages]
  }

  async deletePage(slug: string): Promise<boolean> {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return false
    try {
      await fs.promises.unlink(path.join(this.wikiDir, `${slug}.md`))
    } catch {
      return false
    }
    const index = await this.index()
    await this.saveIndex(index.pages.filter((item) => item.slug !== slug))
    return true
  }

  async search(query: string, limit = 8): Promise<MemorySearchHit[]> {
    const terms = tokenize(query).slice(0, 12)
    if (!terms.length) return []
    const index = await this.index()
    const hits: MemorySearchHit[] = []
    for (const page of index.pages) {
      const title = page.title.toLowerCase()
      const tags = page.tags.map((tag) => tag.toLowerCase())
      let score = 0
      for (const term of terms) {
        if (title.includes(term)) score += 4
        if (tags.some((tag) => tag.includes(term))) score += 3
        if (page.terms.some((candidate) => candidate.startsWith(term))) score += 1
      }
      if (!score) continue
      const pageBody = (await this.readPage(page.slug))?.body ?? page.summary
      hits.push({ slug: page.slug, title: page.title, tags: page.tags, updated: page.updated, score, snippet: snippet(pageBody, terms) })
    }
    return hits.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated)).slice(0, limit)
  }

  /** Bounded briefing injected at session start and available through memory_brief. */
  async brief(): Promise<MemoryBrief> {
    const index = await this.index()
    const handoffs = (await this.handoffFile()).items.filter((item) => item.state === 'open')
    const pinned = index.pages.filter((page) => page.pinned)
    const recent = index.pages.filter((page) => !page.pinned).slice(0, 10)
    const chosen = [...pinned.slice(0, 8), ...recent].slice(0, 14)
    const lines: string[] = []
    if (handoffs.length) {
      lines.push('## Handoffs abertos')
      for (const handoff of handoffs.slice(0, 3)) {
        lines.push(`- ${handoff.id}: ${handoff.summary}${handoff.next ? ` · próximo: ${handoff.next}` : ''}`)
      }
    }
    if (chosen.length) {
      lines.push('## Páginas do projeto')
      for (const page of chosen) {
        const pin = page.pinned ? ' (fixada)' : ''
        lines.push(`- ${page.title}${pin} [${page.slug}]: ${page.summary.slice(0, 220)}`)
      }
    }
    if (!lines.length) return { text: '(memória do projeto vazia)', pages: 0, pins: 0, openHandoffs: 0 }
    let text = redactSecrets(lines.join('\n'))
    if (text.length > MAX_BRIEF) text = `${text.slice(0, MAX_BRIEF)}\n…[memória truncada; use memory_page list/read para ver o resto]`
    return { text, pages: index.pages.length, pins: pinned.length, openHandoffs: handoffs.length }
  }

  async stats(): Promise<MemoryStats> {
    const index = await this.index()
    const handoffs = (await this.handoffFile()).items.filter((item) => item.state === 'open')
    return {
      root: this.root,
      pages: index.pages.length,
      pinned: index.pages.filter((page) => page.pinned).length,
      openHandoffs: handoffs.length,
      updatedAt: index.pages[0]?.updated
    }
  }

  /* ------------------------------- handoffs ------------------------------- */

  private async handoffFile(): Promise<HandoffFile> {
    if (this.loadedHandoffs) return this.loadedHandoffs
    const stored = await this.readJson<HandoffFile>(this.handoffsFile)
    this.loadedHandoffs = stored && stored.version === 1 && Array.isArray(stored.items) ? stored : { version: 1, items: [] }
    return this.loadedHandoffs
  }

  private async saveHandoffs(file: HandoffFile): Promise<void> {
    this.loadedHandoffs = file
    await this.writeAtomic(this.handoffsFile, `${JSON.stringify(file, null, 2)}\n`)
  }

  async beginHandoff(input: {
    summary: string
    next?: string
    files?: string[]
    openQuestions?: string[]
    owner?: string
  }): Promise<MemoryHandoff> {
    const file = await this.handoffFile()
    const handoff: MemoryHandoff = {
      id: `ho_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      state: 'open',
      summary: clean(input.summary, 2000),
      next: clean(input.next ?? '', 2000),
      files: cleanList(input.files, 40, 500),
      openQuestions: cleanList(input.openQuestions, 20, 1000),
      createdAt: new Date().toISOString(),
      owner: input.owner ? clean(input.owner, 80) : undefined
    }
    if (!handoff.summary) throw new Error('o handoff precisa de um resumo')
    file.items.push(handoff)
    if (file.items.length > 200) file.items = file.items.slice(-200)
    await this.saveHandoffs(file)
    return handoff
  }

  async listHandoffs(includeClaimed = false): Promise<MemoryHandoff[]> {
    const file = await this.handoffFile()
    return file.items.filter((item) => item.state === 'open' || (includeClaimed && item.state === 'claimed'))
  }

  /** Claim-once: returns null when the handoff was already claimed/cancelled or does not exist. */
  async acceptHandoff(id?: string): Promise<MemoryHandoff | null> {
    const file = await this.handoffFile()
    const handoff = id
      ? file.items.find((item) => item.id === id && item.state === 'open')
      : [...file.items].reverse().find((item) => item.state === 'open')
    if (!handoff) return null
    handoff.state = 'claimed'
    handoff.claimedAt = new Date().toISOString()
    await this.saveHandoffs(file)
    return handoff
  }

  async cancelHandoff(id: string): Promise<boolean> {
    const file = await this.handoffFile()
    const handoff = file.items.find((item) => item.id === id && item.state === 'open')
    if (!handoff) return false
    handoff.state = 'cancelled'
    await this.saveHandoffs(file)
    return true
  }
}

/* --------------------------------- helpers -------------------------------- */

function clean(text: string, max: number): string {
  return redactSecrets(String(text ?? '')).trim().slice(0, max)
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const tag of tags.slice(0, MAX_TAGS)) {
    const value = clean(tag, 40).toLowerCase().replace(/\s+/g, '-')
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

function cleanList(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(values)) return []
  return values.slice(0, maxItems).map((value) => clean(value, maxChars)).filter(Boolean)
}

export function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** A page is identified by the slug of its title; writing the same title updates it. */
function pageSlug(title: string): string {
  return slugify(title) || `pagina-${Date.now().toString(36)}`
}

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length >= 3 && term.length <= 40)
  )]
}

function summarize(page: MemoryPage): MemoryPageSummary {
  const summary = page.body.replace(/\s+/g, ' ').trim().slice(0, 260)
  return {
    slug: page.slug,
    title: page.title,
    tags: page.tags,
    pinned: page.pinned,
    updated: page.updated,
    summary,
    terms: tokenize(`${page.title} ${page.tags.join(' ')} ${page.body}`).slice(0, MAX_TERMS)
  }
}

function snippet(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return flat.slice(0, 220)
  const start = Math.max(0, at - 80)
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 240)}${start + 240 < flat.length ? '…' : ''}`
}

function serializePage(page: MemoryPage): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `slug: ${page.slug}`,
    `tags: ${page.tags.join(', ')}`,
    `pinned: ${page.pinned ? 'true' : 'false'}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    `source: ${page.source}`,
    '---',
    '',
    page.body.trim(),
    ''
  ]
  return lines.join('\n')
}

function parsePage(raw: string): Omit<MemoryPage, 'slug'> {
  const now = new Date().toISOString()
  if (!raw.startsWith('---')) {
    return { title: 'Sem título', body: raw, tags: [], pinned: false, created: now, updated: now, source: 'agent' }
  }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) {
    return { title: 'Sem título', body: raw, tags: [], pinned: false, created: now, updated: now, source: 'agent' }
  }
  const front = raw.slice(3, end).split(/\r?\n/)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const data: Record<string, string> = {}
  for (const line of front) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    data[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  const decode = (value: string | undefined): string => {
    if (!value) return ''
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value)
      } catch {
        return value.slice(1, -1)
      }
    }
    return value
  }
  return {
    title: decode(data.title) || 'Sem título',
    body,
    tags: (data.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
    pinned: data.pinned === 'true',
    created: data.created || now,
    updated: data.updated || now,
    source: data.source || 'agent'
  }
}
