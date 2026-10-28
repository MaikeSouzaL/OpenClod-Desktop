import type { AgentMode, SessionSurface } from '../../shared/types.js'

/** Where the session of a run lives: Cowork (work in a folder, shown on Início) or Code. Chat is not scheduled. */
export type ScheduledSurface = Extract<SessionSurface, 'cowork' | 'code'>

/**
 * When a task runs. All times are the user's LOCAL wall-clock time.
 *  - hourly:   every hour at `minute` (0-59)
 *  - daily:    every day at `time` ("HH:MM", 24h)
 *  - weekdays: Monday to Friday at `time`
 *  - weekly:   on `day` (0 = Sunday ... 6 = Saturday) at `time`
 *  - once:     a single run at `at` (ISO 8601 date-time)
 */
export type Schedule =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'once'; at: string }

export type ScheduleKind = Schedule['kind']

/**
 *  - ok:      the last run finished without error
 *  - error:   the last run failed (see `lastError`)
 *  - running: a run is in progress
 *  - missed:  a slot passed while the app was not running and the scheduler
 *             was configured NOT to catch up (`catchUpMissed: false`); the run
 *             was skipped. With the default catch-up the late run happens and
 *             is reported as ok/error plus `lastRunLate`.
 */
export type TaskStatus = 'ok' | 'error' | 'missed' | 'running'
export type TaskPriority = 'low' | 'normal' | 'high'

/**
 * Built-in jobs a task may run instead of starting a prompt session. The
 * handler decides what each one does; the scheduler only stores and validates.
 */
export type TaskAction = 'improvement-review'

export interface TaskActionOptions {
  /** Let the configured model write the analysis (default true when a provider exists). */
  useAi?: boolean
  /** Look-back window in days (1-180). */
  days?: number
}

export interface TaskRunRecord {
  id: string
  trigger: 'schedule' | 'manual'
  attempt: number
  status: 'ok' | 'error'
  startedAt: number
  finishedAt: number
  dueAt?: number
  late?: boolean
  sessionId?: string
  error?: string
}

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  projectId: string
  cwd: string
  mode?: AgentMode
  /** Surface of the session each run opens. Missing means `code`, what every task did before this field existed. */
  surface?: ScheduledSurface
  providerId?: string
  model?: string
  schedule: Schedule
  enabled: boolean
  priority?: TaskPriority
  /** Automatic retries after a failed handler call. 0..5. */
  maxRetries?: number
  retryDelayMs?: number
  /** Built-in job to run instead of the prompt; `prompt` then only describes it. */
  action?: TaskAction
  actionOptions?: TaskActionOptions
  /** Most recent attempts, oldest first. */
  runHistory?: TaskRunRecord[]
  /** Epoch milliseconds. */
  createdAt: number
  updatedAt: number
  /** When the most recent run started. */
  lastRunAt?: number
  lastStatus?: TaskStatus
  lastError?: string
  lastSessionId?: string
  /** Next due time while the task is enabled (epoch ms). */
  nextRunAt?: number
  /** The slot the most recent scheduled run was meant for (epoch ms). */
  lastDueAt?: number
  /** The most recent run happened well after its slot (app closed/asleep). */
  lastRunLate?: boolean
}

/** Fields a caller may set when creating a task. */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  projectId: string
  cwd: string
  mode?: AgentMode
  surface?: ScheduledSurface
  providerId?: string
  model?: string
  schedule: Schedule
  /** Defaults to true. */
  enabled?: boolean
  priority?: TaskPriority
  maxRetries?: number
  retryDelayMs?: number
  action?: TaskAction
  actionOptions?: TaskActionOptions
}

/** Fields a caller may change. `null`/undefined clears mode, surface, providerId and model. */
export type ScheduledTaskPatch = Partial<Omit<ScheduledTaskInput, 'mode' | 'surface' | 'providerId' | 'model'>> & {
  mode?: AgentMode | null
  surface?: ScheduledSurface | null
  providerId?: string | null
  model?: string | null
}

export interface TaskRunResult {
  sessionId?: string
}

/**
 * Called when a task is due (or run manually). The task counts as running
 * until the returned promise settles, and a task never runs twice at once, so
 * resolve only when the run is over if overlapping sessions must be avoided.
 * Throwing/rejecting marks the run as an error.
 */
export type TaskRunHandler = (task: ScheduledTask) => Promise<TaskRunResult | void>

export interface SchedulerOptions {
  /** Clock; injected in tests. Defaults to `new Date()`. */
  now?: () => Date
  /** Interval between checks for due tasks. Default 30 000 ms. */
  tickMs?: number
  /**
   * Run a task once when its slot was missed (app closed, computer asleep).
   * Default true. When false the run is skipped and recorded as 'missed'.
   */
  catchUpMissed?: boolean
  /** Maximum number of different tasks started in one scheduling pass. */
  maxConcurrent?: number
}
