import fs from 'node:fs'
import path from 'node:path'
import type {
  HarnessEvent,
  Message,
  Project,
  SessionMeta,
  SessionState,
  SessionSummary
} from '../../shared/types.js'
import { id } from '../util/ids.js'

let tmpSeq = 0
const writeQueues = new Map<string, Promise<void>>()

/**
 * Writes through a temporary file and renames it over the target. Writes to the same file are
 * queued (the last one called wins) and each uses its own temporary name: a single fixed name
 * made concurrent saves of one session fail on the rename.
 */
async function atomicWrite(file: string, data: string): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
      try {
        await fs.promises.writeFile(tmp, data, 'utf8')
        await fs.promises.rename(tmp, file)
      } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        throw err
      }
    })
  writeQueues.set(file, run)
  try {
    await run
  } finally {
    if (writeQueues.get(file) === run) writeQueues.delete(file)
  }
}

/** Streaming deltas are for the live UI; the finished `message` event already carries the text. */
const LIVE_ONLY_EVENTS = new Set<string>(['text_delta', 'reasoning_delta', 'tool_progress'])
const JOURNAL_MAX_BYTES = 10 * 1024 * 1024
const JOURNAL_CHECK_EVERY = 100

export class SessionStore {
  private projects: Project[] = []
  private sessions = new Map<string, SessionState>()
  private loaded = false

  constructor(private readonly dir: string) {}

  private get sessionsDir(): string {
    return path.join(this.dir, 'sessions')
  }

  private get projectsFile(): string {
    return path.join(this.dir, 'projects.json')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    await fs.promises.mkdir(this.sessionsDir, { recursive: true })
    try {
      const raw = await fs.promises.readFile(this.projectsFile, 'utf8')
      const parsed = JSON.parse(raw) as { projects?: Project[] }
      this.projects = Array.isArray(parsed.projects) ? parsed.projects : []
    } catch {
      this.projects = []
    }
    const entries = await fs.promises.readdir(this.sessionsDir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = await fs.promises.readFile(path.join(this.sessionsDir, entry), 'utf8')
        const state = JSON.parse(raw) as SessionState
        if (state?.meta?.id) {
          const normalized = normalizeStaleState(state)
          this.sessions.set(state.meta.id, normalized ?? state)
          if (normalized) await this.saveSession(normalized)
        }
      } catch {
        /* ignore corrupt session */
      }
    }
    // Projects created before per-project models existed inherit the model of
    // their most recent session, so switching projects never changes the LLM
    // of a project that already had one.
    if (this.backfillProjectModels()) await this.saveProjects()
    this.loaded = true
  }

  private backfillProjectModels(): boolean {
    let changed = false
    for (const project of this.projects) {
      if (project.model?.providerId && project.model.model) continue
      let latest: SessionState | undefined
      for (const state of this.sessions.values()) {
        if (state.meta.projectId !== project.id) continue
        if (!state.meta.providerId || !state.meta.model) continue
        if (!latest || state.meta.updatedAt > latest.meta.updatedAt) latest = state
      }
      if (!latest) continue
      project.model = { providerId: latest.meta.providerId, model: latest.meta.model }
      changed = true
    }
    return changed
  }

  /* ------------------------------- projects ------------------------------ */

  listProjects(): Project[] {
    return [...this.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  }

  async addProject(folder: string, name?: string): Promise<Project> {
    await this.init()
    const absolute = path.resolve(folder)
    const existing = this.projects.find((p) => path.resolve(p.path) === absolute)
    if (existing) {
      existing.lastOpenedAt = Date.now()
      await this.saveProjects()
      return existing
    }
    const project: Project = {
      id: id('prj'),
      name: name ?? path.basename(absolute),
      path: absolute,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    this.projects.push(project)
    await this.saveProjects()
    return project
  }

  /** Saves the default LLM for this project only. */
  async setProjectModel(projectId: string, providerId: string, model: string): Promise<Project | null> {
    await this.init()
    const project = this.projects.find((item) => item.id === projectId)
    if (!project) return null
    project.model = { providerId, model }
    await this.saveProjects()
    return { ...project, model: { ...project.model } }
  }

  async removeProject(projectId: string): Promise<void> {
    this.projects = this.projects.filter((p) => p.id !== projectId)
    await this.saveProjects()
  }

  private async saveProjects(): Promise<void> {
    await atomicWrite(this.projectsFile, JSON.stringify({ projects: this.projects }, null, 2))
  }

  /* ------------------------------- sessions ------------------------------ */

  async createSession(input: {
    projectId: string
    cwd: string
    mode: SessionMeta['mode']
    surface?: SessionMeta['surface']
    providerId: string
    model: string
    title?: string
  }): Promise<SessionMeta> {
    await this.init()
    const meta: SessionMeta = {
      id: id('ses'),
      title: input.title ?? 'Nova sessão',
      projectId: input.projectId,
      cwd: input.cwd,
      mode: input.mode,
      surface: input.surface ?? 'code',
      providerId: input.providerId,
      model: input.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalUsage: { input: 0, output: 0 }
    }
    const state: SessionState = {
      meta,
      messages: [],
      plan: [],
      changes: [],
      approvals: [],
      usage: { input: 0, output: 0 },
      state: 'idle'
    }
    this.sessions.set(meta.id, state)
    await this.saveSession(state)
    return meta
  }

  getSession(id: string): SessionState | null {
    return this.sessions.get(id) ?? null
  }

  async loadSession(id: string): Promise<SessionState | null> {
    await this.init()
    return this.sessions.get(id) ?? null
  }

  async saveSession(state: SessionState): Promise<void> {
    const updated: SessionState = {
      ...state,
      meta: { ...state.meta, updatedAt: Date.now(), totalUsage: state.usage }
    }
    this.sessions.set(updated.meta.id, updated)
    await atomicWrite(path.join(this.sessionsDir, `${updated.meta.id}.json`), JSON.stringify(updated, null, 2))
  }

  async patchMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.meta = { ...state.meta, ...patch, updatedAt: Date.now() }
    await this.saveSession(state)
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.init()
    return [...this.sessions.values()]
      .map((state) => {
        const preview = previewOf(state.messages)
        return {
          meta: state.meta,
          messageCount: state.messages.length,
          preview
        }
      })
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    await fs.promises.rm(path.join(this.sessionsDir, `${sessionId}.json`), { force: true })
    await fs.promises.rm(path.join(this.sessionsDir, `${sessionId}.events.jsonl`), { force: true })
    await fs.promises.rm(path.join(this.sessionsDir, `${sessionId}.events.jsonl.1`), { force: true })
  }

  private journalAppends = new Map<string, number>()

  async appendEvent(sessionId: string, event: HarnessEvent): Promise<void> {
    if (LIVE_ONLY_EVENTS.has(event.type)) return
    const file = path.join(this.sessionsDir, `${sessionId}.events.jsonl`)
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    // The journal is a bounded audit trail: past the cap the previous generation is replaced.
    const count = (this.journalAppends.get(sessionId) ?? 0) + 1
    this.journalAppends.set(sessionId, count)
    if (count % JOURNAL_CHECK_EVERY === 1) {
      const size = (await fs.promises.stat(file).catch(() => null))?.size ?? 0
      if (size > JOURNAL_MAX_BYTES) await fs.promises.rename(file, `${file}.1`).catch(() => undefined)
    }
    await fs.promises.appendFile(file, line, 'utf8')
  }

  async readEvents(sessionId: string, limit = 500): Promise<unknown[]> {
    const file = path.join(this.sessionsDir, `${sessionId}.events.jsonl`)
    try {
      const raw = await fs.promises.readFile(file, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { raw: line }
        }
      })
    } catch {
      return []
    }
  }

  async exportSession(sessionId: string): Promise<string | null> {
    const state = this.sessions.get(sessionId)
    if (!state) return null
    return JSON.stringify({ format: 'forja.session.v1', exportedAt: Date.now(), state }, null, 2)
  }

  async importSession(json: string): Promise<SessionMeta> {
    const parsed = JSON.parse(json) as { format?: string; state?: SessionState }
    if (parsed.format !== 'forja.session.v1' || !parsed.state?.meta) {
      throw new Error('arquivo de sessão inválido')
    }
    const state = parsed.state
    const meta: SessionMeta = {
      ...state.meta,
      id: id('ses'),
      title: `${state.meta.title} (importada)`,
      updatedAt: Date.now()
    }
    const next: SessionState = { ...state, meta }
    this.sessions.set(meta.id, next)
    await this.saveSession(next)
    return meta
  }

  async clearAll(): Promise<void> {
    this.sessions.clear()
    const entries = await fs.promises.readdir(this.sessionsDir).catch(() => [] as string[])
    for (const entry of entries) await fs.promises.rm(path.join(this.sessionsDir, entry), { force: true })
  }
}

/**
 * A session read at startup has no turn running. An `active` plan item was
 * interrupted by the app closing: keep it active (so the next turn resumes it)
 * and mark it, instead of pretending it was blocked. Busy run states collapse
 * to idle so the UI does not spin forever.
 */
function normalizeStaleState(state: SessionState): SessionState | null {
  const busy = ['thinking', 'streaming', 'tool', 'waiting_approval'].includes(state.state)
  const hasActive = state.plan?.some((item) => item.status === 'active') ?? false
  if (!busy && !hasActive) return null
  return {
    ...state,
    plan: (state.plan ?? []).map((item) =>
      item.status === 'active'
        ? { ...item, interrupted: true, endedAt: Date.now() }
        : item
    ),
    state: busy ? 'idle' : state.state
  }
}

function previewOf(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const text = message.parts.find((p) => p.type === 'text')
    if (text && text.type === 'text') return text.text.replace(/\s+/g, ' ').slice(0, 120)
  }
  return ''
}
