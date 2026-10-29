import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from '../security/policy.js'
import { pageClass, rankPages, relatedDurable, type PackClass } from './pack.js'
import { buildStatePage, parseNext, type StateInput, type StatePage, type WorkStatus } from './state-page.js'

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
  /** Optional stable slug; derived from the title when omitted. */
  slug?: string
  tags?: string[]
  pinned?: boolean
  source?: string
  memoryType?: MemoryType
  confidence?: MemoryConfidence
  evidence?: string[]
  context?: string
  supersedes?: string
  /**
   * Link the page to the durable pages it is about (a `## Relacionados` section with `[[links]]`). `true` matches by the
   * title and tags; a string adds that text (the objective of a continuity capsule, say) to what is matched.
   */
  relate?: boolean | string
}

export type MemoryType = 'decision' | 'preference' | 'convention' | 'solution' | 'pending' | 'fact'
export type MemoryConfidence = 'observed' | 'inferred' | 'suggested'
export type MemoryStatus = 'active' | 'superseded' | 'invalidated'

export interface MemoryPage {
  slug: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  created: string
  updated: string
  source: string
  memoryType?: MemoryType
  confidence?: MemoryConfidence
  evidence?: string[]
  context?: string
  status?: MemoryStatus
  supersedes?: string
  supersededBy?: string
  possibleConflicts?: string[]
  invalidationReason?: string
  /** Raw [[wikilink]] targets found in the body (slug or title). */
  links?: string[]
}

export interface MemoryPageSummary {
  slug: string
  title: string
  tags: string[]
  pinned: boolean
  updated: string
  summary: string
  terms: string[]
  memoryType?: MemoryType
  confidence?: MemoryConfidence
  status?: MemoryStatus
  evidence?: string[]
  context?: string
  supersedes?: string
  supersededBy?: string
  possibleConflicts?: string[]
  /** Topic pages (decisions, conventions, solutions, facts) before turn logs. */
  kind?: 'topic' | 'session' | 'turn'
  links?: string[]
  backlinks?: string[]
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
  conflicts?: number
  superseded?: number
  invalidated?: number
}

interface IndexFile {
  version: 1
  pages: MemoryPageSummary[]
  /**
   * `file.md` → `size:mtime` when each summary was read. A rebuild rereads only the pages whose stamp changed (a wiki of
   * thousands of pages used to be parsed whole every time one page was written). Older index files have none.
   */
  stamps?: Record<string, string>
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
const SEMANTIC_TYPES = new Set<MemoryType>(['decision', 'preference', 'convention'])
const GENERIC_MEMORY_TAGS = new Set([
  'turno',
  'sessao',
  'indice',
  'automatico',
  'auto',
  'ai-memory',
  'fato',
  'fact',
  // Continuity capsules (see state-page.ts): their tags describe the state, not a subject.
  'estado',
  'em-aberto',
  'interrompido',
  'concluido'
])
const STOP_TOPIC_TAGS = new Set([
  'para', 'pelo', 'pela', 'como', 'mais', 'menos', 'esse', 'essa', 'isso', 'aqui', 'sobre',
  'quando', 'onde', 'voce', 'você', 'estou', 'fazer', 'coisa', 'projeto', 'arquivo', 'arquivos',
  'sessao', 'sessão', 'turno', 'usar', 'pode', 'deve', 'tem', 'vai', 'foi', 'com', 'sem', 'que',
  'pedido', 'resultado', 'ferramentas', 'arquivos', 'dados', 'tarefa', 'trabalho', 'contexto',
  'uma', 'dos', 'das', 'nos', 'nas', 'por', 'mas', 'não', 'nao', 'sim', 'muito', 'bem', 'agora',
  'depois', 'antes', 'todos', 'todo', 'toda', 'esta', 'este', 'está', 'ser', 'são', 'sao',
  'fazer', 'feito', 'precisa', 'quero', 'queria', 'poderia', 'deveria', 'estamos', 'estao',
  'abrir', 'adicionei', 'adicionada', 'adicionados', 'adicionar', 'aguarde', 'alguns', 'algumas',
  'alterada', 'alterados', 'alinhadas', 'alta', 'amostras', 'aparece', 'aplicadas', 'apenas',
  'corrigido', 'corrigir', 'correcao', 'correcoes', 'criar', 'criado', 'deixar', 'disponivel',
  'encontrado', 'entendi', 'estava', 'funciona', 'incluir', 'mostrar', 'mostra', 'novo', 'nova',
  'outra', 'outro', 'pelos', 'primeiro', 'proxiga', 'realizado', 'resolver', 'seguinte', 'usando',
  'vou', 'vamos', 'faz', 'ter', 'assim', 'qual', 'quais', 'porque', 'pois', 'então', 'entao',
  'também', 'tambem', 'só', 'so', 'já', 'ja', 'ok', 'linha', 'linhas',
  'continue', 'proxiga', 'programa', 'program', 'analysis', 'csproj', 'sln', 'solução', 'solucao'
])

export class ProjectMemory {
  private readonly wikiDir: string
  private readonly indexFile: string
  private readonly handoffsFile: string
  private loadedIndex: IndexFile | null = null
  private loadedHandoffs: HandoffFile | null = null
  private indexSignature = ''
  private initPromise: Promise<void> | null = null

  constructor(readonly root: string) {
    this.wikiDir = path.join(root, 'wiki')
    this.indexFile = path.join(root, 'index.json')
    this.handoffsFile = path.join(root, 'handoffs.json')
  }

  private async ensureDirs(): Promise<void> {
    await fs.promises.mkdir(this.wikiDir, { recursive: true, mode: 0o700 })
  }

  /**
   * Opens the project brain: splits legacy one-file session logs into atomic
   * turn notes and a small session index. Idempotent and safe to call often.
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // One read of the wiki for the three passes (each used to read every page again: three times the whole wiki on
        // every start); it is read again only when the migration changed it, which is rare.
        // All three only maintain derived pages (turn notes, tags, subject hubs): one that fails (a file held by another
        // program) must not keep the memory from opening — the wiki is intact, and the next start tries again.
        try {
          let pages = await this.readWiki()
          if (await this.migrateLegacyPages(pages)) pages = await this.readWiki()
          await this.enrichTurnTags(pages)
          await this.rebuildTopicHubs(pages)
        } catch {
          /* maintenance only */
        }
      })()
    }
    return this.initPromise
  }

  /**
   * Builds one small index page per recurring subject tag. These are hubs the
   * LLM can open and follow, not a second giant transcript.
   */
  /** Every page of the wiki, read once, with the file it came from. */
  private async readWiki(): Promise<Array<{ file: string; page: MemoryPage }>> {
    let files: string[] = []
    try {
      files = (await fs.promises.readdir(this.wikiDir)).filter((file) => file.endsWith('.md'))
    } catch {
      return []
    }
    const out: Array<{ file: string; page: MemoryPage }> = []
    for (const file of files) {
      const page = await this.readPageFile(path.join(this.wikiDir, file))
      if (page) out.push({ file, page: { ...page, slug: path.basename(file, '.md') } })
    }
    return out
  }

  private async rebuildTopicHubs(entries: Array<{ file: string; page: MemoryPage }>): Promise<void> {
    const pages = entries.map((entry) => entry.page)
    const byTag = new Map<string, MemoryPage[]>()
    for (const page of pages) {
      if (page.tags.includes('indice')) continue
      for (const tag of page.tags) {
        if (GENERIC_MEMORY_TAGS.has(tag) || STOP_TOPIC_TAGS.has(tag)) continue
        const list = byTag.get(tag) ?? []
        list.push(page)
        byTag.set(tag, list)
      }
    }
    const qualifying = new Set<string>()
    for (const [tag, related] of byTag) {
      // A hub is worth having for a subject some durable page is about. A word that shows up only in turn logs ("abre",
      // "falta", a typo) is not a subject: 24 of the 73 pages of the biggest real memory were such hubs.
      if (related.length < 2 || !related.some(isDurablePage)) continue
      qualifying.add(tag)
      const lines = related
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, 40)
        .map((page) => `- [[${page.slug}]] — ${shortText(resultHeadline(page.body) || page.title, 100)}`)
      const title = `Índice: ${tag}`
      const body = ['## Páginas com este assunto', '', ...lines].join('\n')
      const slug = pageSlug(title)
      const existing = await this.readPage(slug)
      if (existing && existing.source !== 'auto') continue
      if (existing?.body.trim() === body.trim()) continue
      // Written straight to the wiki, all in one pass: through writePage each hub reread and rewrote the whole index, which
      // made opening a memory of thousands of pages take minutes (hundreds of hubs × the index). The index picks up only
      // these files afterwards (their stamps changed).
      const now = new Date().toISOString()
      // One hub that cannot be written (the file is held) does not stop the others.
      await this.writeAtomic(
        path.join(this.wikiDir, `${slug}.md`),
        serializePage({
          slug,
          title: clean(title, MAX_TITLE),
          body: clean(body, MAX_BODY),
          tags: cleanTags(['indice', tag]),
          pinned: false,
          created: existing?.created ?? now,
          updated: now,
          source: 'auto',
          memoryType: 'fact',
          confidence: normalizeConfidence('observed'),
          evidence: [],
          context: 'auto:hub',
          status: 'active',
          possibleConflicts: []
        })
      ).catch(() => undefined)
    }
    await this.archiveStaleHubs(pages, qualifying)
  }

  /**
   * Moves the auto-generated hubs of words that are not subjects out of the wiki, into `wiki/.archive` (nothing is
   * deleted, and a hub a person edited stays where it is). They only added noise to the search and to the graph.
   */
  private async archiveStaleHubs(pages: MemoryPage[], qualifying: Set<string>): Promise<void> {
    const stale = pages.filter(
      (page) =>
        page.tags.includes('indice') &&
        !page.tags.includes('sessao') &&
        page.source === 'auto' &&
        page.context === 'auto:hub' &&
        !qualifying.has(page.tags.find((tag) => tag !== 'indice') ?? '')
    )
    if (!stale.length) return
    const archive = path.join(this.wikiDir, '.archive')
    await fs.promises.mkdir(archive, { recursive: true, mode: 0o700 })
    for (const page of stale) {
      try {
        await fs.promises.rename(path.join(this.wikiDir, `${page.slug}.md`), path.join(archive, `${page.slug}.md`))
      } catch {
        /* in use right now: it is tried again at the next start */
      }
    }
  }

  /** Backfills subject tags on turn notes created before the tag index existed. */
  private async enrichTurnTags(entries: Array<{ file: string; page: MemoryPage }>): Promise<void> {
    for (const entry of entries) {
      const { file, page } = entry
      if (!page.tags.includes('turno')) continue
      const tags = cleanTags([
        'turno',
        'automatico',
        ...keywordTags(`${page.title} ${tagTextFromBody(page.body)}`)
      ])
      const headline = resultHeadline(page.body)
      const title = headline && !page.title.includes(' · ')
        ? `${page.title} · ${shortText(headline, 60)}`
        : page.title
      if (tags.join(',') === page.tags.join(',') && title === page.title) continue
      const enriched = { ...page, slug: path.basename(file, '.md'), title, tags }
      // A note that cannot be written now (held by another program) keeps its old tags until the next start.
      if (!(await this.writeAtomic(path.join(this.wikiDir, file), serializePage(enriched)).then(() => true, () => false))) continue
      // The hubs built next see the new title and tags.
      entry.page = enriched
    }
  }

  /** Splits old one-file session logs into turn notes. True when it changed the wiki. */
  private async migrateLegacyPages(entries: Array<{ file: string; page: MemoryPage }>): Promise<boolean> {
    await this.ensureDirs()
    let migrated = false
    for (const { page } of entries) {
      if (!page.tags.includes('sessao') || page.tags.includes('indice')) continue
      if (!/^###\s+/m.test(page.body)) continue
      const sections = splitLegacySections(page.body)
      if (!sections.length) continue
      const links: string[] = []
      for (const section of sections) {
        const turn = await this.writeTurnNote({
          sessionSlug: page.slug,
          sessionTitle: page.title.replace(/^sess[aã]o:\s*/i, ''),
          sessionId: page.context?.replace(/^sessao:/i, '') || '',
          stamp: section.stamp,
          request: section.request,
          body: section.body,
          tags: ['turno', 'automatico'],
          related: false
        })
        links.push(`- [[${turn.slug}]] — ${section.stamp} — ${shortText(section.request, 90)}`)
      }
      migrated = true
      await this.writePage({
        title: page.title,
        body: ['## Turnos', '', ...links.slice(-300)].join('\n'),
        tags: [...new Set(['sessao', 'indice', ...page.tags.filter((tag) => tag !== 'automatico')])],
        source: 'auto',
        memoryType: 'fact',
        confidence: 'observed',
        context: page.context
      })
    }
    return migrated
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
    // On Windows the swap fails (EBUSY, EPERM) while another program holds the file for a moment: an antivirus, the search
    // indexer, a backup or copy. It is tried again a few times before giving up, and the temporary file never stays behind.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 5 || !(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
          await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
          throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
      }
    }
  }

  /**
   * The wiki is the source of truth: a human (or another agent) may edit or add
   * a `.md` file outside Openclod. The derived index is rebuilt when the folder
   * signature changes, so the UI's "Atualizar" always sees the files on disk.
   */
  /** `file.md` → `size:mtime` of every page on disk: one readdir and one stat per file. */
  private async wikiStamps(): Promise<Map<string, string>> {
    try {
      const files = (await fs.promises.readdir(this.wikiDir)).filter((file) => file.endsWith('.md')).sort()
      const stamps = await Promise.all(
        files.map(async (file) => {
          const stat = await fs.promises.stat(path.join(this.wikiDir, file)).catch(() => null)
          return [file, stat ? `${stat.size}:${stat.mtimeMs}` : ''] as const
        })
      )
      return new Map(stamps.filter(([, stamp]) => stamp))
    } catch {
      return new Map()
    }
  }

  /** The index in use while a rebuild runs: callers at the same time (the screen asks for pages and stats together) share it. */
  private indexing: Promise<IndexFile> | null = null

  private index(): Promise<IndexFile> {
    if (!this.indexing) {
      this.indexing = this.freshIndex().finally(() => {
        this.indexing = null
      })
    }
    return this.indexing
  }

  /**
   * The wiki is the source of truth (a human or another agent may change a `.md` outside Openclod): the index follows it,
   * rereading only the pages whose size or time changed since they were summarized.
   */
  private async freshIndex(): Promise<IndexFile> {
    const stamps = await this.wikiStamps()
    const signature = [...stamps].map(([file, stamp]) => `${file}:${stamp}`).join('|')
    if (this.loadedIndex && this.indexSignature === signature) return this.loadedIndex
    let known = this.loadedIndex
    if (!known) {
      const stored = await this.readJson<IndexFile>(this.indexFile)
      known = stored && stored.version === 1 && Array.isArray(stored.pages) ? stored : null
    }
    const previous = new Map((known?.pages ?? []).map((page) => [page.slug, page]))
    const previousStamps = known?.stamps ?? {}
    const pages: MemoryPageSummary[] = []
    let reread = 0
    for (const [file, stamp] of stamps) {
      const prior = previous.get(file.slice(0, -3))
      if (prior && previousStamps[file] === stamp) {
        pages.push(prior)
        continue
      }
      const page = await this.readPageFile(path.join(this.wikiDir, file))
      reread++
      if (page) pages.push(summarize(page))
    }
    const next: IndexFile = { version: 1, pages: withBacklinks(sortSummaries(pages)), stamps: Object.fromEntries(stamps) }
    this.loadedIndex = next
    this.indexSignature = signature
    // Written only when something changed (a page read again, one removed, or an index without stamps yet).
    if (reread || !known || !known.stamps || known.pages.length !== next.pages.length) await this.writeIndex(next)
    return next
  }

  /**
   * Compact JSON: the index of a big wiki is tens of megabytes, and indentation only made it bigger and slower. The index
   * is derived from the wiki, so failing to save it never fails the read: the pages are in memory, and the next change
   * writes it again.
   */
  private async writeIndex(index: IndexFile): Promise<void> {
    await this.writeAtomic(this.indexFile, `${JSON.stringify(index)}\n`).catch(() => undefined)
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
    const stamps = await this.wikiStamps()
    this.loadedIndex = { version: 1, pages: withBacklinks(sortSummaries(pages)), stamps: Object.fromEntries(stamps) }
    this.indexSignature = [...stamps].map(([file, stamp]) => `${file}:${stamp}`).join('|')
    await this.writeIndex(this.loadedIndex)
  }

  /** Creates or updates a page by slug (derived from the title). Returns the summary. */
  async writePage(input: MemoryPageInput): Promise<MemoryPageSummary> {
    await this.ensureDirs()
    const title = clean(input.title, MAX_TITLE) || 'Sem título'
    const body = clean(input.body, MAX_BODY)
    if (!body.trim()) throw new Error('a página precisa de um corpo')
    const tags = cleanTags(input.tags)
    const slug =
      input.slug && /^[a-z0-9][a-z0-9-]{0,80}$/.test(input.slug) ? input.slug : pageSlug(title)
    const file = path.join(this.wikiDir, `${slug}.md`)
    const now = new Date().toISOString()
    let created = now
    try {
      const existing = await this.readPageFile(file)
      if (existing) created = existing.created
    } catch {
      /* new page */
    }
    const supersedes = input.supersedes ? clean(input.supersedes, 80) : undefined
    if (supersedes && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(supersedes)) throw new Error('slug substituído inválido')
    const indexBefore = await this.index()
    let pageBody = body
    if (input.relate && !/^##\s+Relacionados\s*$/m.test(pageBody)) {
      const hint = typeof input.relate === 'string' ? input.relate : body.slice(0, 300)
      const related = relatedDurable(indexBefore.pages, { slug, title, tags, hint })
      if (related.length) {
        pageBody = `${pageBody.trimEnd()}\n\n## Relacionados\n\n${related.map((item) => `- [[${item.slug}]] — ${shortText(item.title, 100)}`).join('\n')}`
      }
    }
    const page: MemoryPage = {
      slug,
      title,
      body: pageBody,
      tags,
      pinned: Boolean(input.pinned),
      created,
      updated: now,
      source: clean(input.source ?? 'agent', 40) || 'agent',
      memoryType: normalizeMemoryType(input.memoryType) ?? inferMemoryType(title, tags, input.source),
      confidence: normalizeConfidence(input.confidence),
      evidence: cleanList(input.evidence, 40, 1_000),
      context: clean(input.context ?? '', 4_000),
      status: 'active',
      supersedes,
      possibleConflicts: []
    }
    if (supersedes) {
      const replaced = await this.readPage(supersedes)
      if (!replaced) throw new Error(`memória substituída não encontrada: ${supersedes}`)
      await this.writeAtomic(path.join(this.wikiDir, `${supersedes}.md`), serializePage({
        ...replaced,
        status: 'superseded',
        supersededBy: slug,
        updated: now
      }))
    }
    // Only pages of the same semantic type can conflict (detectPotentialConflicts skips every other one): reading the whole
    // wiki for each write made a 2000-page project take seconds per page.
    page.possibleConflicts = page.memoryType && SEMANTIC_TYPES.has(page.memoryType)
      ? detectPotentialConflicts(page, await Promise.all(
          indexBefore.pages
            .filter((candidate) => candidate.slug !== slug && candidate.slug !== supersedes && candidate.memoryType === page.memoryType)
            .map((candidate) => this.readPage(candidate.slug))
        ))
      : []
    await this.writeAtomic(file, serializePage(page))
    // The index read above is fresh (index() rebuilds it when the wiki changed behind it): only this page, and the one it
    // supersedes, change in it.
    const changed = new Set([slug, ...(supersedes ? [supersedes] : [])])
    const pages = indexBefore.pages.filter((item) => !changed.has(item.slug))
    const summary = summarize(page)
    pages.push(summary)
    if (supersedes) {
      const replaced = await this.readPage(supersedes)
      if (replaced) pages.push(summarize(replaced))
    }
    await this.saveIndex(pages)
    return summary
  }

  async invalidatePage(slug: string, reason = ''): Promise<MemoryPageSummary | null> {
    const page = await this.readPage(slug)
    if (!page) return null
    const next: MemoryPage = {
      ...page,
      status: 'invalidated',
      invalidationReason: clean(reason, 1_000),
      updated: new Date().toISOString()
    }
    await this.writeAtomic(path.join(this.wikiDir, `${slug}.md`), serializePage(next))
    const index = await this.index()
    await this.saveIndex(index.pages.filter((item) => item.slug !== slug).concat(summarize(next)))
    return summarize(next)
  }

  async readPage(slug: string): Promise<MemoryPage | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return null
    return this.readPageFile(path.join(this.wikiDir, `${slug}.md`))
  }

  async listPages(): Promise<MemoryPageSummary[]> {
    await this.init()
    return sortSummaries((await this.index()).pages)
  }

  /**
   * Writes one atomic episodic note per turn and keeps the session page as a
   * small index of links. Durable topic/decision pages are written by the
   * agent through `memory_page`; turn notes link to them so an LLM can search
   * one subject, read a few notes and follow the graph instead of loading a
   * giant session transcript.
   */
  async rememberTurn(input: {
    sessionTitle: string
    sessionId: string
    turnId?: string
    userText: string
    assistantText: string
    tools?: string[]
    files?: string[]
  }): Promise<{ session: MemoryPageSummary; turn: MemoryPageSummary } | null> {
    await this.init()
    const request = input.userText.replace(/\s+/g, ' ').trim().slice(0, 2_000)
    if (!request) return null
    const sessionTitle = `Sessão: ${clean(input.sessionTitle, 80) || input.sessionId}`
    const sessionSlug = pageSlug(sessionTitle)
    const stamp = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    const lines = [
      `**Pedido:** ${request}`,
      '',
      `**Resultado:** ${input.assistantText.replace(/\s+/g, ' ').trim().slice(0, 1_500) || '(sem resposta textual)'}`
    ]
    if (input.tools?.length) lines.push('', `**Ferramentas:** ${input.tools.slice(0, 20).join(', ')}`)
    if (input.files?.length) lines.push('', `**Arquivos:** ${input.files.slice(0, 20).join(', ')}`)
    const turn = await this.writeTurnNote({
      sessionSlug,
      sessionTitle,
      sessionId: input.sessionId,
      turnId: input.turnId,
      stamp,
      request,
      body: lines.join('\n'),
      tags: ['turno', 'automatico'],
      related: true
    })

    const existing = await this.readPage(sessionSlug)
    const prior =
      existing && !/^###\s+/m.test(existing.body)
        ? existing.body.split('\n').filter((line) => line.trim().startsWith('- [['))
        : []
    const link = `- [[${turn.slug}]] — ${stamp} — ${shortText(request, 90)}`
    const indexLines = [link, ...prior.filter((line) => !line.includes(`[[${turn.slug}]]`))].slice(0, 300)
    const session = await this.writePage({
      title: sessionTitle,
      body: ['## Turnos', '', ...indexLines].join('\n'),
      tags: ['sessao', 'indice'],
      source: 'auto',
      memoryType: 'fact',
      confidence: 'observed',
      context: `sessao:${input.sessionId}`
    })
    return { session, turn }
  }

  private async writeTurnNote(input: {
    sessionSlug: string
    sessionTitle: string
    sessionId: string
    turnId?: string
    stamp: string
    request: string
    body: string
    tags: string[]
    related: boolean
  }): Promise<MemoryPageSummary> {
    const headline = resultHeadline(input.body)
    const title = `Turno ${input.stamp} — ${shortText(input.request, 60)}${headline ? ` · ${shortText(headline, 60)}` : ''}`
    const baseSlug = pageSlug(title)
    const marker = input.turnId ? `turn:${input.turnId}` : `turn:${input.stamp}:${input.request.slice(0, 40)}`
    let slug = baseSlug
    const existing = await this.readPage(baseSlug)
    if (existing && !(existing.evidence ?? []).includes(marker)) {
      slug = `${baseSlug.slice(0, 70)}-${shortHash(marker)}`
    }
    let related: MemorySearchHit[] = []
    if (input.related) {
      related = (await this.search(`${input.request} ${input.body}`, 12))
        .filter(
          (hit) =>
            hit.slug !== input.sessionSlug &&
            hit.slug !== slug &&
            !hit.tags.includes('turno') &&
            !hit.tags.includes('indice')
        )
        .slice(0, 5)
    }
    const relatedLines = related.length
      ? ['', '## Relacionados', '', ...related.map((hit) => `- [[${hit.slug}]] — ${hit.title}`)]
      : []
    const topicTags = [...new Set(related.flatMap((hit) => hit.tags))].filter(
      (tag) => !GENERIC_MEMORY_TAGS.has(tag)
    ).slice(0, 6)
    const autoTags = keywordTags(`${input.request} ${tagTextFromBody(input.body)}`)
    const body = [`**Sessão:** [[${input.sessionSlug}]]`, `**Data:** ${input.stamp}`, '', input.body.trim(), ...relatedLines].join('\n')
    return this.writePage({
      title,
      slug,
      body,
      tags: [...new Set(['turno', ...input.tags, ...autoTags, ...topicTags])].slice(0, 12),
      source: 'auto',
      memoryType: 'fact',
      confidence: 'observed',
      evidence: [marker, input.sessionId, ...related.map((hit) => hit.slug)].filter(Boolean),
      context: `sessao:${input.sessionId}`
    })
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
    await this.init()
    const terms = tokenize(query).slice(0, 12)
    if (!terms.length) return []
    const index = await this.index()
    const hits: MemorySearchHit[] = []
    for (const page of index.pages) {
      if (page.status === 'superseded' || page.status === 'invalidated') continue
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

  /**
   * Search for the agent's tools: the pages that match, durable ones first, a hub never (see pack.ts). `indexed` are the
   * slugs the long-term full-text index ranks best for the same words. Unlike `search`, a page that merely mentions a
   * word in a turn log cannot outrank the page that is about it.
   */
  async rank(
    query: string,
    limit = 8,
    indexed: string[] = []
  ): Promise<Array<MemorySearchHit & { cls: PackClass; memoryType?: MemoryType; links: string[]; backlinks: string[] }>> {
    await this.init()
    const pages = (await this.index()).pages
    const ranked = rankPages(pages, query, { indexed }).filter((item) => item.score >= 0.4).slice(0, limit)
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3)
    const out: Array<MemorySearchHit & { cls: PackClass; memoryType?: MemoryType; links: string[]; backlinks: string[] }> = []
    for (const item of ranked) {
      const body = (await this.readPage(item.page.slug))?.body ?? item.page.summary
      out.push({
        slug: item.page.slug,
        title: item.page.title,
        tags: item.page.tags,
        updated: item.page.updated,
        score: Math.round(item.score * 100) / 100,
        snippet: snippet(body, words),
        cls: item.cls,
        memoryType: item.page.memoryType,
        links: item.page.links ?? [],
        backlinks: item.page.backlinks ?? []
      })
    }
    return out
  }

  /**
   * Writes the continuity capsule of a session (see state-page.ts): where the work stands, for whoever continues it.
   * One page per session, rewritten after every turn, linked to the durable pages it is about.
   */
  async recordState(input: Omit<StateInput, 'sessionSlug'>): Promise<{ summary: MemoryPageSummary; state: StatePage }> {
    await this.init()
    const sessionSlug = pageSlug(`Sessão: ${clean(input.sessionTitle, 80) || input.sessionId}`)
    const state = buildStatePage({ ...input, sessionSlug })
    const summary = await this.writePage({
      title: state.title,
      slug: state.slug,
      body: state.body,
      tags: state.tags,
      source: 'auto',
      memoryType: state.memoryType,
      confidence: 'observed',
      context: `sessao:${input.sessionId}`,
      relate: `${input.firstRequest.slice(0, 200)} ${input.lastRequest.slice(0, 200)}`
    })
    return { summary, state }
  }

  /**
   * Capsules of work that was left unfinished (open, or interrupted by an error), newest first, other sessions' only.
   * When nothing is open, the most recent finished one stands in as "the last session" so a plain "continue" still has
   * something to continue from.
   */
  async openWork(
    options: { excludeContext?: string; maxAgeDays?: number; limit?: number; now?: number } = {}
  ): Promise<Array<{ slug: string; title: string; updated: string; status: WorkStatus; next: string; body: string }>> {
    await this.init()
    const now = options.now ?? Date.now()
    const maxAge = (options.maxAgeDays ?? 30) * 86_400_000
    const capsules = (await this.index()).pages
      .filter(
        (page) =>
          page.tags.includes('estado') &&
          page.status !== 'superseded' &&
          page.status !== 'invalidated' &&
          page.context !== options.excludeContext &&
          now - Date.parse(page.updated || '') <= maxAge
      )
      .sort((a, b) => b.updated.localeCompare(a.updated))
    const open = capsules.filter((page) => page.tags.includes('em-aberto') || page.tags.includes('interrompido'))
    const chosen = (open.length ? open : capsules.slice(0, 1)).slice(0, options.limit ?? 2)
    const out = []
    for (const page of chosen) {
      const body = (await this.readPage(page.slug))?.body ?? ''
      const status: WorkStatus = page.tags.includes('interrompido') ? 'interrompido' : page.tags.includes('em-aberto') ? 'em-aberto' : 'concluido'
      out.push({ slug: page.slug, title: page.title, updated: page.updated, status, next: parseNext(body), body })
    }
    return out
  }

  /** Bounded briefing injected at session start and available through memory_brief. */
  async brief(): Promise<MemoryBrief> {
    await this.init()
    const index = await this.index()
    const handoffs = (await this.handoffFile()).items.filter((item) => item.state === 'open')
    const active = index.pages.filter((page) => page.status !== 'superseded' && page.status !== 'invalidated')
    const pinned = active.filter((page) => page.pinned)
    const turns = active.filter((page) => page.kind === 'turn')
    const durable = active.filter((page) => page.kind !== 'turn')
    const seen = new Set<string>()
    const chosen = [...pinned, ...durable.filter((page) => !page.pinned), ...turns.slice(0, 4)]
      .filter((page) => {
        if (seen.has(page.slug)) return false
        seen.add(page.slug)
        return true
      })
      .slice(0, 16)
    const lines: string[] = [
      'Navegação: use `memory_page` action=search para achar o assunto, action=read para abrir uma página e siga os `[[links]]`. Turnos são episódicos; decisões, convenções, soluções e pendências são páginas de tópico duráveis.'
    ]
    if (handoffs.length) {
      lines.push('## Handoffs abertos')
      for (const handoff of handoffs.slice(0, 3)) {
        lines.push(`- ${handoff.id}: ${handoff.summary}${handoff.next ? ` · próximo: ${handoff.next}` : ''}`)
      }
    }
    const topicMap = new Map<string, MemoryPageSummary[]>()
    // Subjects come from durable pages only: the tags of turn logs are words like "abre" and "falta", not subjects.
    for (const page of active.filter((candidate) => pageClass(candidate) === 'durable')) {
      for (const tag of page.tags) {
        if (GENERIC_MEMORY_TAGS.has(tag)) continue
        const list = topicMap.get(tag) ?? []
        list.push(page)
        topicMap.set(tag, list)
      }
    }
    const topics = [...topicMap.entries()]
      .filter(([, pages]) => pages.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
    if (topics.length) {
      lines.push('', '## Assuntos (índice por tag)')
      for (const [tag, pages] of topics) {
        const refs = pages.slice(0, 4).map((page) => `[[${page.slug}]]`).join(' · ')
        lines.push(`- ${tag} (${pages.length}): ${refs}`)
      }
    }
    if (chosen.length) {
      lines.push('', '## Páginas principais')
      for (const page of chosen) {
        const pin = page.pinned ? ' (fixada)' : ''
        const kind = page.kind === 'turn' ? 'turno' : page.memoryType ?? 'tópico'
        lines.push(`- [${kind}] ${page.title}${pin} [${page.slug}]: ${page.summary.slice(0, 200)}`)
      }
    }
    const conflicts = active.filter((page) => (page.possibleConflicts?.length ?? 0) > 0)
    if (conflicts.length) {
      lines.push('## Possíveis conflitos')
      for (const page of conflicts.slice(0, 5)) {
        lines.push(`- ${page.title} [${page.slug}] ↔ ${(page.possibleConflicts ?? []).slice(0, 5).join(', ')}`)
      }
    }
    if (!lines.length) return { text: '(memória do projeto vazia)', pages: 0, pins: 0, openHandoffs: 0 }
    let text = redactSecrets(lines.join('\n'))
    if (text.length > MAX_BRIEF) text = `${text.slice(0, MAX_BRIEF)}\n…[memória truncada; use memory_page list/read para ver o resto]`
    return { text, pages: index.pages.length, pins: pinned.length, openHandoffs: handoffs.length }
  }

  /**
   * A few lines about this memory for the FIRST turn of a session: how big it is, what is pinned, which subjects were
   * touched last. Not the 7 000-character briefing (`brief`, still behind `memory_brief`): what matches each request
   * arrives through the pack (pack.ts), and the model can search the rest itself.
   */
  async map(): Promise<{ text: string; pages: number; durable: number; openHandoffs: number }> {
    await this.init()
    const index = await this.index()
    const handoffs = (await this.handoffFile()).items.filter((item) => item.state === 'open')
    const active = index.pages.filter((page) => page.status !== 'superseded' && page.status !== 'invalidated')
    const durable = active.filter((page) => pageClass(page) === 'durable')
    const sessions = active.filter((page) => page.kind === 'session').length
    const turns = active.filter((page) => page.kind === 'turn').length
    if (!active.length && !handoffs.length) return { text: '', pages: 0, durable: 0, openHandoffs: 0 }
    const lines = [
      `Esta memória tem ${durable.length} página(s) de assunto, ${sessions} sessão(ões) e ${turns} turno(s). O que casa com cada pedido vem na seção de memória do contexto do turno; o resto se acha com memory_recall e memory_page.`
    ]
    const pinned = durable.filter((page) => page.pinned).slice(0, 6)
    if (pinned.length) lines.push(`Fixadas: ${pinned.map((page) => `${page.title} [${page.slug}]`).join('; ')}`)
    const recent = durable
      .filter((page) => !page.pinned)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 6)
    if (recent.length) {
      lines.push('Assuntos tocados por último:')
      for (const page of recent) lines.push(`- ${page.title} [${page.slug}] (${page.memoryType && page.memoryType !== 'fact' ? page.memoryType : 'assunto'})`)
    }
    return { text: redactSecrets(lines.join('\n')), pages: index.pages.length, durable: durable.length, openHandoffs: handoffs.length }
  }

  async stats(): Promise<MemoryStats> {
    await this.init()
    const index = await this.index()
    const handoffs = (await this.handoffFile()).items.filter((item) => item.state === 'open')
    return {
      root: this.root,
      pages: index.pages.length,
      pinned: index.pages.filter((page) => page.pinned).length,
      openHandoffs: handoffs.length,
      updatedAt: index.pages[0]?.updated,
      conflicts: index.pages.filter((page) => page.status !== 'invalidated' && page.status !== 'superseded' && (page.possibleConflicts?.length ?? 0) > 0).length,
      superseded: index.pages.filter((page) => page.status === 'superseded').length,
      invalidated: index.pages.filter((page) => page.status === 'invalidated').length
    }
  }

  async projectSummary(): Promise<string> {
    await this.init()
    const index = await this.index()
    const active = index.pages.filter((page) => page.status !== 'superseded' && page.status !== 'invalidated')
    const decisions = active.filter((page) => page.memoryType === 'decision').slice(0, 8)
    const pending = active.filter((page) => page.memoryType === 'pending').slice(0, 8)
    const conventions = active.filter((page) => page.memoryType === 'convention').slice(0, 8)
    const conflicts = active.filter((page) => (page.possibleConflicts?.length ?? 0) > 0).slice(0, 8)
    const section = (title: string, pages: MemoryPageSummary[]): string[] => pages.length
      ? [`## ${title}`, ...pages.map((page) => `- ${page.title} [${page.slug}]: ${page.summary.slice(0, 260)}`)]
      : []
    return [
      '# Memória consolidada do projeto',
      '',
      `- Páginas ativas: ${active.length}`,
      `- Substituídas: ${index.pages.filter((page) => page.status === 'superseded').length}`,
      `- Inválidas: ${index.pages.filter((page) => page.status === 'invalidated').length}`,
      ...section('Decisões', decisions),
      ...section('Convenções', conventions),
      ...section('Pendências', pending),
      ...section('Possíveis conflitos', conflicts)
    ].join('\n').slice(0, MAX_BRIEF)
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

/** A page the user or the agent wrote, or a capsule: not a turn log, not a session index, not an auto-generated hub. */
function isDurablePage(page: MemoryPage): boolean {
  return !page.tags.includes('turno') && !page.tags.includes('indice') && !page.tags.includes('sessao')
}

function clean(text: string, max: number): string {
  return redactSecrets(String(text ?? '')).trim().slice(0, max)
}

function shortText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** First meaningful heading of the result, used as the turn's subject label. */
function resultHeadline(body: string): string {
  const marker = body.indexOf('**Resultado:**')
  const after = marker >= 0 ? body.slice(marker + '**Resultado:**'.length) : body
  // Stop before the tool/file sections: they are metadata, not the subject.
  const result = after.split(/\n?\*\*(?:Ferramentas|Arquivos):\*\*/i)[0].slice(0, 1_500).trim()
  if (!result) return ''
  const generic = /^(resumo|resumo do turno|resultado|status|o que foi feito|conclusão|conclusao|sem resposta textual)$/i
  const headings = [...result.matchAll(/#{2,4}\s+([^#\n]+)/g)]
    .map((match) => match[1].split('**')[0].trim())
    .filter(Boolean)
  const heading = headings.find((item) => item.length > 3 && !generic.test(item))
  if (heading) return heading.slice(0, 120)

  const bold = /\*\*([^*\n]{8,120})\*\*/.exec(result)?.[1]?.trim() ?? ''
  if (bold && !generic.test(bold)) return bold

  const plain = result.replace(/#{2,4}\s+/g, ' ').replace(/\*\*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!plain || generic.test(plain) || /^sem resposta/i.test(plain)) return ''
  return plain.slice(0, 120)
}

/** Tags come from the request, result headings and touched files — not from prose/numbers. */
function tagTextFromBody(body: string): string {
  const headings = [...body.matchAll(/^#{2,4}\s+(.+)$/gm)].map((match) => match[1]).join(' ')
  const files = /\*\*Arquivos:\*\*\s*([^\n]+)/i.exec(body)?.[1] ?? ''
  return `${headings} ${resultHeadline(body)} ${files}`.slice(0, 1_500)
}

function shortHash(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36).slice(0, 6)
}

/**
 * Splits the legacy one-file session log:
 *   ### 26/10/2026, 15:14
 *   **Pedido:** ...
 *   **Resultado:** ...
 */
function splitLegacySections(body: string): Array<{ stamp: string; request: string; body: string }> {
  const chunks = body.split(/\n(?=###\s+)/).filter((chunk) => /^###\s+/m.test(chunk))
  const sections: Array<{ stamp: string; request: string; body: string }> = []
  for (const chunk of chunks) {
    const lines = chunk.trim().split(/\r?\n/)
    const stamp = lines.shift()?.replace(/^###\s+/, '').trim() ?? ''
    const content = lines.join('\n').trim()
    if (!content) continue
    const request =
      /\*\*Pedido:\*\*\s*([^\n]+)/i.exec(content)?.[1]?.trim() ||
      content.split('\n').find((line) => line.trim() && !line.startsWith('**'))?.trim() ||
      '(sem pedido)'
    sections.push({ stamp, request: shortText(request, 300), body: content.slice(0, 6_000) })
  }
  return sections
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const tag of tags.slice(0, MAX_TAGS)) {
    const value = clean(tag, 40)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    // Code constants, line numbers and hashes are not subjects.
    if (!value || /^\d+$/.test(value) || !/[a-z]/.test(value) || out.includes(value)) continue
    out.push(value)
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

/** Cheap subject tags for the tag index (no LLM, deterministic). */
function keywordTags(text: string): string[] {
  const counts = new Map<string, number>()
  for (const word of tokenize(text)) {
    // Only natural-language-ish tokens: no line numbers, hashes, constants
    // with underscores or pure code identifiers.
    if (!/^[a-z][a-z-]{3,}$/.test(word)) continue
    if (STOP_TOPIC_TAGS.has(word) || GENERIC_MEMORY_TAGS.has(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([word]) => word)
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
  const links = extractLinks(page.body)
  return {
    slug: page.slug,
    title: page.title,
    tags: page.tags,
    pinned: page.pinned,
    updated: page.updated,
    summary,
    terms: tokenize(`${page.title} ${page.tags.join(' ')} ${page.memoryType ?? ''} ${page.confidence ?? ''} ${(page.evidence ?? []).join(' ')} ${page.context ?? ''} ${page.body}`).slice(0, MAX_TERMS),
    memoryType: page.memoryType,
    confidence: page.confidence,
    status: page.status ?? 'active',
    evidence: page.evidence,
    context: page.context,
    supersedes: page.supersedes,
    supersededBy: page.supersededBy,
    possibleConflicts: page.possibleConflicts,
    kind: page.tags.includes('turno')
      ? 'turn'
      : page.tags.includes('sessao') && page.tags.includes('indice')
        ? 'session'
        : 'topic',
    links
  }
}

/** Extracts unique `[[target]]` / `[[target|label]]` references from a page body. */
export function extractLinks(body: string): string[] {
  const links: string[] = []
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1].trim()
    if (target && !links.includes(target)) links.push(target)
  }
  return links.slice(0, 80)
}

/** Resolves link targets to slugs and fills `backlinks` without another disk pass. */
function sortSummaries(pages: MemoryPageSummary[]): MemoryPageSummary[] {
  const rank: Record<string, number> = { topic: 0, session: 1, turn: 2 }
  return [...pages].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const byKind = (rank[a.kind ?? 'topic'] ?? 0) - (rank[b.kind ?? 'topic'] ?? 0)
    if (byKind) return byKind
    return b.updated.localeCompare(a.updated)
  })
}

function withBacklinks(pages: MemoryPageSummary[]): MemoryPageSummary[] {
  const byReference = new Map<string, string>()
  for (const page of pages) {
    byReference.set(normalizeReference(page.slug), page.slug)
    byReference.set(normalizeReference(page.title), page.slug)
  }
  const backlinks = new Map<string, string[]>()
  for (const page of pages) {
    for (const link of page.links ?? []) {
      const target = byReference.get(normalizeReference(link))
      if (!target || target === page.slug) continue
      const list = backlinks.get(target) ?? []
      if (!list.includes(page.slug)) list.push(page.slug)
      backlinks.set(target, list)
    }
  }
  return pages.map((page) => ({ ...page, backlinks: backlinks.get(page.slug) ?? [] }))
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
    `memory_type: ${page.memoryType ?? 'fact'}`,
    `confidence: ${page.confidence ?? 'suggested'}`,
    `status: ${page.status ?? 'active'}`,
    `evidence: ${JSON.stringify(page.evidence ?? [])}`,
    `context: ${JSON.stringify(page.context ?? '')}`,
    ...(page.supersedes ? [`supersedes: ${page.supersedes}`] : []),
    ...(page.supersededBy ? [`superseded_by: ${page.supersededBy}`] : []),
    `conflicts_with: ${JSON.stringify(page.possibleConflicts ?? [])}`,
    ...(page.invalidationReason ? [`invalidation_reason: ${JSON.stringify(page.invalidationReason)}`] : []),
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
    return {
      title: 'Sem título', body: raw, tags: [], pinned: false, created: now, updated: now, source: 'agent',
      memoryType: 'fact', confidence: 'suggested', status: 'active', evidence: [], context: '', possibleConflicts: []
    }
  }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) {
    return {
      title: 'Sem título', body: raw, tags: [], pinned: false, created: now, updated: now, source: 'agent',
      memoryType: 'fact', confidence: 'suggested', status: 'active', evidence: [], context: '', possibleConflicts: []
    }
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
    tags: cleanTags(
      (data.tags ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    ),
    pinned: data.pinned === 'true',
    created: data.created || now,
    updated: data.updated || now,
    source: data.source || 'agent',
    memoryType: normalizeMemoryType(decode(data.memory_type)) ?? 'fact',
    confidence: normalizeConfidence(decode(data.confidence)),
    status: normalizeStatus(decode(data.status)),
    evidence: decodeArray(data.evidence),
    context: decode(data.context),
    supersedes: data.supersedes || undefined,
    supersededBy: data.superseded_by || undefined,
    possibleConflicts: decodeArray(data.conflicts_with),
    invalidationReason: decode(data.invalidation_reason) || undefined
  }
}

function normalizeMemoryType(value: unknown): MemoryType | undefined {
  return value === 'decision' || value === 'preference' || value === 'convention' || value === 'solution' || value === 'pending' || value === 'fact'
    ? value
    : undefined
}

function normalizeConfidence(value: unknown): MemoryConfidence {
  return value === 'observed' || value === 'inferred' ? value : 'suggested'
}

function normalizeStatus(value: unknown): MemoryStatus {
  return value === 'superseded' || value === 'invalidated' ? value : 'active'
}

function inferMemoryType(title: string, tags: string[], source = 'agent'): MemoryType {
  const text = `${title} ${tags.join(' ')}`.toLowerCase()
  if (/decis|adr|architect|arquitet/.test(text)) return 'decision'
  if (/prefer|gosto|style|estilo/.test(text)) return 'preference'
  if (/conven|regra|padr[aã]o|convention/.test(text)) return 'convention'
  if (/solu[cç][aã]o|fix|corre[cç][aã]o|solution/.test(text)) return 'solution'
  if (/pend|todo|pr[oó]xim|backlog/.test(text)) return 'pending'
  return source === 'auto' ? 'fact' : 'fact'
}

function decodeArray(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string').slice(0, 40)
  } catch {
    /* older pages may contain a comma-separated value */
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 40)
}

function detectPotentialConflicts(candidate: MemoryPage, pages: Array<MemoryPage | null>): string[] {
  if (!candidate.memoryType || !SEMANTIC_TYPES.has(candidate.memoryType)) return []
  const candidateTags = new Set(candidate.tags)
  const candidateTerms = new Set(tokenize(`${candidate.title} ${candidate.body}`).slice(0, 80))
  const conflicts: string[] = []
  for (const page of pages) {
    if (!page || page.slug === candidate.slug || page.status === 'invalidated' || page.status === 'superseded') continue
    if (page.memoryType !== candidate.memoryType) continue
    const tagOverlap = page.tags.filter((tag) => candidateTags.has(tag)).length
    const sharedTerms = [...new Set(tokenize(`${page.title} ${page.body}`).slice(0, 80))].filter((term) => candidateTerms.has(term))
    if (tagOverlap > 0 && sharedTerms.length >= 1 || sharedTerms.length >= 3) conflicts.push(page.slug)
    if (conflicts.length >= 12) break
  }
  return conflicts
}
