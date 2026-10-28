import fs from 'node:fs'
import path from 'node:path'
import { AGENT_MODES, type AgentMode } from '../../shared/types.js'
import { id } from '../util/ids.js'
import { SchedulerValidationError, nextRun, validateSchedule } from './schedule.js'
import { SCHEDULED_SURFACES } from './session.js'
import type {
  Schedule,
  ScheduledSurface,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  SchedulerOptions,
  TaskAction,
  TaskActionOptions,
  TaskRunHandler,
  TaskPriority,
  TaskRunRecord,
  TaskStatus
} from './types.js'

export { SchedulerValidationError, nextRun, validateSchedule } from './schedule.js'
export { SCHEDULED_SURFACES, scheduledSession } from './session.js'
export type {
  Schedule,
  ScheduleKind,
  ScheduledSurface,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  SchedulerOptions,
  TaskAction,
  TaskActionOptions,
  TaskRunHandler,
  TaskPriority,
  TaskRunRecord,
  TaskRunResult,
  TaskStatus
} from './types.js'

export const NAME_MAX = 120
export const PROMPT_MAX = 20_000
const DEFAULT_TICK_MS = 30_000
/** A run starting within this long of its slot is on time, not "late". */
const MIN_LATE_GRACE_MS = 60_000
const FILE_VERSION = 1
const STATUSES: TaskStatus[] = ['ok', 'error', 'missed', 'running']

/* -------------------------------- persistence -------------------------------- */

async function atomicWrite(file: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.promises.writeFile(tmp, data, 'utf8')
    // Windows can refuse the rename for a moment while an antivirus/indexer
    // holds the destination open.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
      }
    }
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/* --------------------------------- validation --------------------------------- */

interface TaskFields {
  name: string
  prompt: string
  projectId: string
  cwd: string
  mode?: AgentMode
  surface?: ScheduledSurface
  providerId?: string
  model?: string
  priority?: TaskPriority
  maxRetries?: number
  retryDelayMs?: number
  action?: TaskAction
  actionOptions?: TaskActionOptions
  schedule: Schedule
}

const ACTIONS: TaskAction[] = ['improvement-review']

function text(
  value: unknown,
  label: string,
  max: number,
  required: boolean,
  feminine = false
): string | undefined {
  const missing = `${label} é ${feminine ? 'obrigatória' : 'obrigatório'}.`
  if (value === undefined || value === null || value === '') {
    if (required) throw new SchedulerValidationError(missing)
    return undefined
  }
  if (typeof value !== 'string') throw new SchedulerValidationError(`${label} deve ser um texto.`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (required) throw new SchedulerValidationError(missing)
    return undefined
  }
  if (trimmed.length > max) {
    throw new SchedulerValidationError(`${label} deve ter no máximo ${max} caracteres.`)
  }
  if (trimmed.includes('\0')) throw new SchedulerValidationError(`${label} contém caracteres inválidos.`)
  return trimmed
}

/** Validates and normalizes the editable fields of a task. */
function normalizeFields(input: Record<string, unknown>): TaskFields {
  const mode = input.mode
  if (mode !== undefined && mode !== null && !AGENT_MODES.includes(mode as AgentMode)) {
    throw new SchedulerValidationError(`Modo inválido. Use um destes: ${AGENT_MODES.join(', ')}.`)
  }
  const surface = input.surface
  if (surface !== undefined && surface !== null && !SCHEDULED_SURFACES.includes(surface as ScheduledSurface)) {
    throw new SchedulerValidationError(`Tipo de sessão inválido. Use um destes: ${SCHEDULED_SURFACES.join(', ')}.`)
  }
  const fields: TaskFields = {
    name: text(input.name, 'O nome da tarefa', NAME_MAX, true)!,
    prompt: text(input.prompt, 'O prompt da tarefa', PROMPT_MAX, true)!,
    projectId: text(input.projectId, 'O projeto da tarefa', 200, true)!,
    cwd: text(input.cwd, 'A pasta de trabalho da tarefa', 4096, true, true)!,
    schedule: validateSchedule(input.schedule)
  }
  if (mode) fields.mode = mode as AgentMode
  if (surface) fields.surface = surface as ScheduledSurface
  const providerId = text(input.providerId, 'O provedor da tarefa', 200, false)
  if (providerId) fields.providerId = providerId
  const model = text(input.model, 'O modelo da tarefa', 200, false)
  if (model) fields.model = model
  if (input.priority === 'low' || input.priority === 'high' || input.priority === 'normal') fields.priority = input.priority
  if (input.maxRetries !== undefined) {
    if (!Number.isInteger(input.maxRetries) || Number(input.maxRetries) < 0 || Number(input.maxRetries) > 5) {
      throw new SchedulerValidationError('maxRetries deve ser um inteiro de 0 a 5.')
    }
    fields.maxRetries = Number(input.maxRetries)
  }
  if (input.retryDelayMs !== undefined) {
    if (!Number.isFinite(input.retryDelayMs) || Number(input.retryDelayMs) < 0 || Number(input.retryDelayMs) > 300_000) {
      throw new SchedulerValidationError('retryDelayMs deve estar entre 0 e 300000.')
    }
    fields.retryDelayMs = Math.round(Number(input.retryDelayMs))
  }
  const action = input.action
  if (action !== undefined && action !== null) {
    if (!ACTIONS.includes(action as TaskAction)) {
      throw new SchedulerValidationError(`Ação inválida. Use uma destas: ${ACTIONS.join(', ')}.`)
    }
    fields.action = action as TaskAction
    const options = input.actionOptions
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new SchedulerValidationError('As opções da ação devem ser um objeto.')
      }
      const { useAi, days } = options as Record<string, unknown>
      const parsed: TaskActionOptions = {}
      if (useAi !== undefined) {
        if (typeof useAi !== 'boolean') throw new SchedulerValidationError('useAi deve ser verdadeiro ou falso.')
        parsed.useAi = useAi
      }
      if (days !== undefined) {
        if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 180) {
          throw new SchedulerValidationError('days deve ser um inteiro de 1 a 180.')
        }
        parsed.days = Number(days)
      }
      fields.actionOptions = parsed
    }
  }
  return fields
}

const EDITABLE: Array<keyof ScheduledTaskInput> = [
  'name',
  'prompt',
  'projectId',
  'cwd',
  'mode',
  'surface',
  'providerId',
  'model',
  'priority',
  'maxRetries',
  'retryDelayMs',
  'action',
  'actionOptions',
  'schedule'
]

function fieldsOf(task: ScheduledTask): Record<string, unknown> {
  return {
    name: task.name,
    prompt: task.prompt,
    projectId: task.projectId,
    cwd: task.cwd,
    mode: task.mode,
    surface: task.surface,
    providerId: task.providerId,
    model: task.model,
    priority: task.priority,
    maxRetries: task.maxRetries,
    retryDelayMs: task.retryDelayMs,
    action: task.action,
    actionOptions: task.actionOptions,
    schedule: task.schedule
  }
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SchedulerValidationError('O campo "enabled" deve ser verdadeiro ou falso.')
  return value
}

function sameSchedule(a: Schedule, b: Schedule): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function priorityRank(priority: TaskPriority | undefined): number {
  return priority === 'high' ? 2 : priority === 'low' ? 0 : 1
}

function normalizeRunRecord(value: unknown, index: number): TaskRunRecord[] {
  if (!value || typeof value !== 'object') return []
  const raw = value as Record<string, unknown>
  if ((raw.status !== 'ok' && raw.status !== 'error') || !isFiniteNumber(raw.startedAt) || !isFiniteNumber(raw.finishedAt)) return []
  return [{
    id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : `run-restored-${index}`,
    trigger: raw.trigger === 'manual' ? 'manual' : 'schedule',
    attempt: Math.max(1, Math.round(Number(raw.attempt) || 1)),
    status: raw.status,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    dueAt: isFiniteNumber(raw.dueAt) ? raw.dueAt : undefined,
    late: raw.late === true,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 2_000) : undefined
  }]
}

function view(task: ScheduledTask): ScheduledTask {
  return { ...task, schedule: { ...task.schedule } }
}

const NOT_STARTED = 'O agendador não foi iniciado.'
const NOT_FOUND = 'Tarefa agendada não encontrada.'

/* ----------------------------------- class ----------------------------------- */

/**
 * Persistent scheduler for recurring and one-off agent tasks.
 *
 * State lives in one JSON file written atomically (temp file + rename, writes
 * serialized). The scheduler only decides WHEN; what a run does is up to the
 * handler given to {@link start}. Mutators are async because they persist
 * before resolving; reads (`list`, `get`) are synchronous.
 */
export class Scheduler {
  private tasks = new Map<string, ScheduledTask>()
  private loaded = false
  private loading: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private readonly running = new Set<string>()
  private readonly listeners = new Set<(tasks: ScheduledTask[]) => void>()
  private handler: TaskRunHandler | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => Date
  private readonly tickMs: number
  private readonly catchUpMissed: boolean
  private readonly maxConcurrent: number

  constructor(
    private readonly file: string,
    options: SchedulerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.tickMs = options.tickMs && options.tickMs > 0 ? options.tickMs : DEFAULT_TICK_MS
    this.catchUpMissed = options.catchUpMissed !== false
    this.maxConcurrent = Math.max(1, Math.min(16, Math.round(options.maxConcurrent ?? 4)))
  }

  /** A run starting later than this after its slot counts as late. */
  private get lateGraceMs(): number {
    return Math.max(MIN_LATE_GRACE_MS, this.tickMs * 2)
  }

  /* ------------------------------ load / persist ------------------------------ */

  /** Reads the file once; later calls are no-ops. A missing file means no tasks. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.readFromDisk().finally(() => {
      this.loading = null
    })
    await this.loading
  }

  private async readFromDisk(): Promise<void> {
    let raw: string | null = null
    try {
      raw = await fs.promises.readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    let stored: unknown[] = []
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { tasks?: unknown }
        stored = Array.isArray(parsed.tasks) ? parsed.tasks : []
      } catch {
        // Keep the unreadable file for inspection instead of overwriting it.
        await fs.promises.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined)
      }
    }

    const now = this.now()
    let dirty = false
    const tasks = new Map<string, ScheduledTask>()
    for (const entry of stored) {
      const task = this.restore(entry, now)
      if (!task) {
        dirty = true
        continue
      }
      if (task.lastStatus === 'running') {
        // The process died mid-run: nothing is running now.
        task.lastStatus = 'error'
        task.lastError = 'Interrompida: o aplicativo foi fechado durante a execução.'
        dirty = true
      }
      tasks.set(task.id, task)
    }
    this.tasks = tasks
    this.loaded = true
    if (dirty) await this.persist().catch(() => undefined)
  }

  /** Rebuilds a task from untrusted JSON; null when it is unusable. */
  private restore(entry: unknown, now: Date): ScheduledTask | null {
    if (typeof entry !== 'object' || entry === null) return null
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id) return null
    let fields: TaskFields
    try {
      fields = normalizeFields(raw)
    } catch {
      return null
    }
    const enabled = raw.enabled === true
    const task: ScheduledTask = {
      id: raw.id,
      ...fields,
      enabled,
      createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : now.getTime(),
      updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : now.getTime()
    }
    if (isFiniteNumber(raw.lastRunAt)) task.lastRunAt = raw.lastRunAt
    if (STATUSES.includes(raw.lastStatus as TaskStatus)) task.lastStatus = raw.lastStatus as TaskStatus
    if (typeof raw.lastError === 'string') task.lastError = raw.lastError
    if (typeof raw.lastSessionId === 'string') task.lastSessionId = raw.lastSessionId
    if (isFiniteNumber(raw.lastDueAt)) task.lastDueAt = raw.lastDueAt
    if (raw.lastRunLate === true) task.lastRunLate = true
    if (Array.isArray(raw.runHistory)) {
      task.runHistory = raw.runHistory.slice(-50).flatMap((entry, index) => normalizeRunRecord(entry, index))
    }
    if (enabled) {
      // A stored time in the past is a missed slot and must survive: it is
      // what makes the first tick run the task.
      const next = isFiniteNumber(raw.nextRunAt) ? raw.nextRunAt : nextRun(task.schedule, now)?.getTime()
      if (next !== undefined) task.nextRunAt = next
    }
    return task
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(() =>
      atomicWrite(this.file, JSON.stringify({ version: FILE_VERSION, tasks: [...this.tasks.values()] }, null, 2))
    )
    this.writeChain = run.catch(() => undefined)
    return run
  }

  /* --------------------------------- reading --------------------------------- */

  list(): ScheduledTask[] {
    return [...this.tasks.values()].map(view)
  }

  get(taskId: string): ScheduledTask | undefined {
    const task = this.tasks.get(taskId)
    return task ? view(task) : undefined
  }

  /** Subscribes to changes (after they are persisted). Returns the unsubscribe function. */
  onChange(listener: (tasks: ScheduledTask[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    if (!this.listeners.size) return
    const snapshot = this.list()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        /* a broken listener must not break the scheduler */
      }
    }
  }

  private require(taskId: string): ScheduledTask {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(NOT_FOUND)
    return task
  }

  /* --------------------------------- mutating --------------------------------- */

  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    await this.load()
    const raw = (input ?? {}) as unknown as Record<string, unknown>
    const fields = normalizeFields(raw)
    const enabled = raw.enabled === undefined ? true : requireBoolean(raw.enabled)
    const now = this.now()
    const nextRunAt = enabled ? this.upcoming(fields.schedule, now) : undefined

    const task: ScheduledTask = {
      id: id('tsk'),
      ...fields,
      enabled,
      createdAt: now.getTime(),
      updatedAt: now.getTime()
    }
    if (nextRunAt !== undefined) task.nextRunAt = nextRunAt
    this.tasks.set(task.id, task)
    await this.persist()
    this.emit()
    return view(task)
  }

  async update(taskId: string, patch: ScheduledTaskPatch): Promise<ScheduledTask> {
    await this.load()
    const current = this.require(taskId)
    const raw = (patch ?? {}) as Record<string, unknown>

    const merged = fieldsOf(current)
    for (const key of EDITABLE) if (key in raw) merged[key] = raw[key]
    const fields = normalizeFields(merged)
    const enabled = raw.enabled === undefined ? current.enabled : requireBoolean(raw.enabled)
    const now = this.now()

    const next: ScheduledTask = { ...current, ...fields, enabled, updatedAt: now.getTime() }
    if (!('mode' in fields)) delete next.mode
    if (!('surface' in fields)) delete next.surface
    if (!('providerId' in fields)) delete next.providerId
    if (!('model' in fields)) delete next.model
    if (!('action' in fields)) delete next.action
    if (!('actionOptions' in fields)) delete next.actionOptions

    if (!enabled) {
      delete next.nextRunAt
    } else if (!current.enabled || !sameSchedule(current.schedule, fields.schedule)) {
      // New schedule, or switched back on: count from now (a re-enabled task
      // does not "catch up" slots that passed while it was off).
      const upcoming = this.upcoming(fields.schedule, now)
      if (upcoming === undefined) delete next.nextRunAt
      else next.nextRunAt = upcoming
    }
    // Otherwise keep nextRunAt: renaming a task must not swallow an overdue run.

    this.tasks.set(taskId, next)
    await this.persist()
    this.emit()
    return view(next)
  }

  setEnabled(taskId: string, enabled: boolean): Promise<ScheduledTask> {
    return this.update(taskId, { enabled })
  }

  /** Removes a task. Resolves false when there was no such task. */
  async remove(taskId: string): Promise<boolean> {
    await this.load()
    if (!this.tasks.delete(taskId)) return false
    await this.persist()
    this.emit()
    return true
  }

  /**
   * Next due time for a task being enabled/rescheduled, as epoch ms. A `once`
   * time that already passed is refused; other kinds always have a next slot.
   */
  private upcoming(schedule: Schedule, now: Date): number | undefined {
    const next = nextRun(schedule, now)
    if (!next && schedule.kind === 'once') {
      throw new SchedulerValidationError('O horário agendado já passou. Escolha uma data e hora no futuro.')
    }
    return next?.getTime()
  }

  /* --------------------------------- running --------------------------------- */

  /**
   * Starts ticking and registers the run handler. The returned promise settles
   * after the immediate catch-up pass (tasks whose slot passed while the app
   * was closed, run once each) and the runs it started; it never rejects for a
   * failing task, only if the file cannot be read.
   */
  start(onDue: TaskRunHandler): Promise<void> {
    this.handler = onDue
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.tick().catch(() => undefined)
    }, this.tickMs)
    this.timer.unref?.()
    return this.tick()
  }

  /** Stops ticking. Runs already in flight finish and are still recorded. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.handler = null
  }

  /**
   * One scheduling pass: runs every enabled task whose time has come and that
   * is not already running. Called by the timer; public so it can be driven
   * directly (tests, "check now"). Resolves when the runs it started settle.
   */
  async tick(): Promise<void> {
    await this.load()
    if (!this.handler) return
    const nowMs = this.now().getTime()
    const lateGraceMs = this.lateGraceMs
    const due: ScheduledTask[] = []
    for (const task of this.tasks.values()) {
      if (!task.enabled || task.nextRunAt === undefined || task.nextRunAt > nowMs) continue
      if (this.running.has(task.id)) continue
      due.push(task)
    }
    due.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
    let cursor = 0
    const workers = Array.from({ length: Math.min(this.maxConcurrent, due.length) }, async () => {
      while (cursor < due.length) {
        const task = due[cursor++]
        if (!this.catchUpMissed && nowMs - task.nextRunAt! > lateGraceMs) {
          await this.skipMissed(task.id).catch(() => undefined)
        } else {
          await this.execute(task.id, 'schedule').catch(() => undefined)
        }
      }
    })
    await Promise.all(workers)
  }

  /** Runs a task right now, even if it is disabled. Resolves with the finished task. */
  async runNow(taskId: string): Promise<ScheduledTask> {
    await this.load()
    this.require(taskId)
    if (!this.handler) throw new Error(NOT_STARTED)
    return this.execute(taskId, 'manual')
  }

  private async skipMissed(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    const now = this.now()
    const next: ScheduledTask = {
      ...task,
      lastStatus: 'missed',
      lastDueAt: task.nextRunAt,
      updatedAt: now.getTime()
    }
    delete next.nextRunAt
    this.advance(next, now)
    this.tasks.set(taskId, next)
    await this.persist()
    this.emit()
  }

  /**
   * Moves a task past `now` after a run: recurring tasks get their next slot,
   * a `once` task switches itself off.
   */
  private advance(task: ScheduledTask, now: Date): void {
    if (task.schedule.kind === 'once') {
      task.enabled = false
      delete task.nextRunAt
      return
    }
    if (!task.enabled) {
      delete task.nextRunAt
      return
    }
    const next = nextRun(task.schedule, now)
    if (next) task.nextRunAt = next.getTime()
    else delete task.nextRunAt
  }

  private async execute(taskId: string, trigger: 'schedule' | 'manual'): Promise<ScheduledTask> {
    const handler = this.handler
    if (!handler) throw new Error(NOT_STARTED)
    const task = this.require(taskId)
    if (this.running.has(taskId)) throw new Error('A tarefa já está em execução.')
    this.running.add(taskId)

    try {
      const startedAt = this.now()
      const dueAt = trigger === 'schedule' ? task.nextRunAt : undefined
      const late = dueAt !== undefined && startedAt.getTime() - dueAt > this.lateGraceMs

      // Mark it running and move the schedule on BEFORE the run: a `once` task
      // is already off if the app dies mid-run, so it can never run twice.
      const started: ScheduledTask = {
        ...task,
        lastRunAt: startedAt.getTime(),
        lastStatus: 'running',
        updatedAt: startedAt.getTime()
      }
      delete started.lastError
      delete started.lastSessionId
      delete started.lastDueAt
      delete started.lastRunLate
      if (dueAt !== undefined) started.lastDueAt = dueAt
      if (late) started.lastRunLate = true
      this.advance(started, startedAt)
      this.tasks.set(taskId, started)
      await this.persist().catch(() => undefined)
      this.emit()

      let status: TaskStatus = 'error'
      let error: string | undefined
      let sessionId: string | undefined
      const history: TaskRunRecord[] = []
      const attempts = 1 + Math.max(0, Math.min(5, task.maxRetries ?? 0))
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const attemptStartedAt = this.now()
        try {
          const result = await handler(view(started))
          sessionId = result?.sessionId
          status = 'ok'
          error = undefined
          history.push({
            id: id('run'),
            trigger,
            attempt,
            status: 'ok',
            startedAt: attemptStartedAt.getTime(),
            finishedAt: this.now().getTime(),
            dueAt,
            late,
            sessionId
          })
          break
        } catch (err) {
          status = 'error'
          error = (err instanceof Error ? err.message : String(err)).slice(0, 2000) || 'Erro desconhecido.'
          history.push({
            id: id('run'),
            trigger,
            attempt,
            status: 'error',
            startedAt: attemptStartedAt.getTime(),
            finishedAt: this.now().getTime(),
            dueAt,
            late,
            error
          })
          if (attempt < attempts && (task.retryDelayMs ?? 0) > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(300_000, task.retryDelayMs!)))
          }
        }
      }

      // The task may have been edited or removed while it ran: apply the
      // outcome to whatever is current.
      const current = this.tasks.get(taskId)
      if (!current) return view(started)
      const finishedAt = this.now()
      const finished: ScheduledTask = { ...current, lastStatus: status, updatedAt: finishedAt.getTime() }
      finished.runHistory = [...(current.runHistory ?? []), ...history].slice(-50)
      delete finished.lastError
      delete finished.lastSessionId
      if (error !== undefined) finished.lastError = error
      if (sessionId) finished.lastSessionId = sessionId
      // Slots that elapsed during a long run are skipped, not queued.
      if (finished.enabled && finished.nextRunAt !== undefined && finished.nextRunAt <= finishedAt.getTime()) {
        this.advance(finished, finishedAt)
      }
      this.tasks.set(taskId, finished)
      await this.persist().catch(() => undefined)
      this.emit()
      return view(finished)
    } finally {
      this.running.delete(taskId)
    }
  }
}
