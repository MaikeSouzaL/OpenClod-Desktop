import type { HarnessEvent } from '../../shared/types.js'

/**
 * Decides how the overlay mascot feels while an agent works.
 *
 * Like `ComputerActivityTracker` it is free of Electron: the app turns each
 * `onChange(state)` into `window.setAgentMood(...)`, while tests drive it with
 * fake events and a fake clock. The mood is derived from signals the harness
 * already emits (tool calls that go quiet, repeated failures, pending
 * approvals, warnings, context pressure) - never from guesses about the model.
 */

export const MASCOT_MOODS = [
  'calm',
  'working',
  'thinking',
  'curious',
  'waiting',
  'sleepy',
  'confused',
  'struggling',
  'overwhelmed',
  'worried',
  'asking',
  'relieved',
  'happy',
  'sad'
] as const

export type MascotMood = (typeof MASCOT_MOODS)[number]

/** 0 = fine, 1 = a small hiccup, 2 = clearly struggling, 3 = stuck. */
export type MascotDifficulty = 0 | 1 | 2 | 3

export interface MascotState {
  mood: MascotMood
  difficulty: MascotDifficulty
  label: string
}

export const DEFAULT_LABEL = 'Openclod está usando o computador'

/** Higher wins. Temporary overrides (happy/sad/relieved) beat everything. */
export const MOOD_PRIORITY: Record<MascotMood, number> = {
  happy: 100,
  sad: 100,
  relieved: 100,
  asking: 90,
  overwhelmed: 80,
  struggling: 70,
  worried: 60,
  waiting: 50,
  sleepy: 50,
  confused: 40,
  thinking: 30,
  curious: 25,
  working: 20,
  calm: 10
}

export const MOOD_THRESHOLDS = {
  /** A failure older than this no longer counts as "recent". */
  failureWindowMs: 120_000,
  /** Recent failures that make the mascot confused / struggling / overwhelmed. */
  confusedFailures: 1,
  struggleFailures: 2,
  overwhelmedFailures: 4,
  /** Consecutive failures of the same tool that make the mascot overwhelmed. */
  overwhelmedSameTool: 3,
  /** A timeout counts as this many failures. */
  timeoutWeight: 2,
  /** Silence of a running call (no start/progress) before each reaction. */
  waitSilenceMs: 20_000,
  struggleSilenceMs: 60_000,
  overwhelmedSilenceMs: 150_000,
  /** Thinking with no activity at all for this long makes the mascot sleepy. */
  sleepyIdleMs: 60_000,
  /** How long a warn/error notice keeps the mascot worried. */
  noticeMs: 8_000,
  /** contextTokens / contextWindow from which the context is "almost full". */
  contextRatio: 0.9,
  /** How long the temporary celebration / sadness / relief lasts. */
  happyMs: 2_400,
  relievedMs: 3_000,
  sadMs: 3_000
} as const

const OBSERVATION_TOOL = /screenshot|snapshot|read|find|list_windows|ocr|get_page|wait/i
const DENIED_SUMMARY = /negad[oa]|cancelad[oa]|recusad[oa]/i
const TIMEOUT_TEXT = /timeout|tempo esgotado|excedeu \d+\s*s\b/i
const MAX_TRACKED_FAILURES = 32
const MAX_TOOL_NAME = 24

/** "45 s", "1 min 32 s", "2 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

interface RunningCall {
  name: string
  startedAt: number
  lastProgressAt: number
  order: number
}

interface Failure {
  at: number
  weight: number
  tool: string
}

type Phase = 'idle' | 'thinking' | 'streaming' | 'tool'

interface SessionSignals {
  calls: Map<string, RunningCall>
  failures: Failure[]
  approvals: Set<string>
  questions: Set<string>
  phase: Phase
  lastActivityAt: number
  notice: { until: number; text: string } | null
  contextHigh: boolean
  /** Highest difficulty seen during the current turn. */
  peak: number
}

export class MascotMoodTracker {
  private readonly sessions = new Map<string, SessionSignals>()
  private override: { state: MascotState; until: number } | null = null
  private current: MascotState = { mood: 'calm', difficulty: 0, label: DEFAULT_LABEL }
  private sequence = 0
  private disposed = false

  constructor(
    private readonly onChange: (state: MascotState) => void,
    private readonly now: () => number = Date.now
  ) {}

  get state(): MascotState {
    return { ...this.current }
  }

  handle(event: HarnessEvent): void {
    if (this.disposed) return
    const now = this.now()
    this.apply(event, now)
    this.evaluate(now)
  }

  /** Re-evaluates the time-based thresholds (silence, expiring overrides). */
  tick(): void {
    if (this.disposed) return
    this.evaluate(this.now())
  }

  dispose(): void {
    this.disposed = true
    this.sessions.clear()
    this.override = null
  }

  /* ------------------------------------------------------------------ */
  /* Event intake                                                        */
  /* ------------------------------------------------------------------ */

  private apply(event: HarnessEvent, now: number): void {
    switch (event.type) {
      case 'session_start': {
        this.session(event.sessionId, now)
        return
      }
      case 'turn_start': {
        const s = this.session(event.sessionId, now)
        this.resetTurn(s)
        s.phase = 'thinking'
        s.lastActivityAt = now
        return
      }
      case 'status': {
        if (event.state === 'thinking' || event.state === 'streaming' || event.state === 'tool') {
          const s = this.session(event.sessionId, now)
          s.phase = event.state
          s.lastActivityAt = now
        } else if (event.state === 'waiting_approval') {
          this.session(event.sessionId, now).lastActivityAt = now
        } else {
          const s = this.sessions.get(event.sessionId)
          if (s) s.phase = 'idle'
        }
        return
      }
      case 'text_delta':
      case 'reasoning_delta': {
        this.session(event.sessionId, now).lastActivityAt = now
        return
      }
      case 'tool_start': {
        const s = this.session(event.sessionId, now)
        s.calls.set(callKey(event), { name: event.name, startedAt: now, lastProgressAt: now, order: ++this.sequence })
        s.phase = 'tool'
        s.lastActivityAt = now
        if (event.agentId) touchAll(s, now)
        return
      }
      case 'tool_progress': {
        const s = this.session(event.sessionId, now)
        const call = s.calls.get(callKey(event))
        if (call) call.lastProgressAt = now
        s.lastActivityAt = now
        if (event.agentId) touchAll(s, now)
        return
      }
      case 'tool_end': {
        const s = this.session(event.sessionId, now)
        // Measured before the event changes anything: was the agent in trouble?
        const before = this.baseState(s, now)
        s.calls.delete(callKey(event))
        s.lastActivityAt = now
        if (event.agentId) touchAll(s, now)
        if (s.calls.size === 0 && s.phase === 'tool') s.phase = 'thinking'
        if (event.ok) {
          s.failures = []
          if (before.difficulty >= 2) {
            this.setOverride({ mood: 'relieved', difficulty: 0, label: 'Resolvido!' }, MOOD_THRESHOLDS.relievedMs, now)
          }
        } else if (!DENIED_SUMMARY.test(event.summary ?? '')) {
          const timedOut =
            event.data?.timedOut === true ||
            TIMEOUT_TEXT.test(`${event.summary ?? ''}\n${(event.text ?? '').slice(0, 4000)}`)
          this.recordFailure(s, event.name, timedOut ? MOOD_THRESHOLDS.timeoutWeight : 1, now)
        }
        return
      }
      case 'approval_request': {
        const s = this.session(event.sessionId, now)
        s.approvals.add(event.request.id)
        s.lastActivityAt = now
        return
      }
      case 'approval_resolved': {
        const s = this.session(event.sessionId, now)
        s.approvals.delete(event.id)
        // The wait was the user's, not the tool's: restart the silence clock.
        touchAll(s, now)
        s.lastActivityAt = now
        return
      }
      case 'question_request': {
        const s = this.session(event.sessionId, now)
        s.questions.add(event.request.id)
        s.lastActivityAt = now
        return
      }
      case 'question_resolved': {
        const s = this.session(event.sessionId, now)
        s.questions.delete(event.id)
        touchAll(s, now)
        s.lastActivityAt = now
        return
      }
      case 'notice': {
        if (event.level === 'info') return
        const s = this.session(event.sessionId, now)
        s.notice = { until: now + MOOD_THRESHOLDS.noticeMs, text: noticeLabel(event.text) }
        return
      }
      case 'budget': {
        const { contextTokens, contextWindow } = event.info
        const s = this.session(event.sessionId, now)
        s.contextHigh =
          contextWindow > 0 && contextTokens / contextWindow >= MOOD_THRESHOLDS.contextRatio
        return
      }
      case 'subagent': {
        const s = this.session(event.sessionId, now)
        s.lastActivityAt = now
        touchAll(s, now)
        if (event.state === 'error') this.recordFailure(s, event.agent ?? event.label ?? 'subagente', 1, now)
        return
      }
      case 'turn_end': {
        this.finishTurn(event, now)
        return
      }
      default:
        return
    }
  }

  private finishTurn(event: Extract<HarnessEvent, { type: 'turn_end' }>, now: number): void {
    const s = this.sessions.get(event.sessionId)
    const peak = s ? Math.max(s.peak, this.baseState(s, now).difficulty) : 0
    this.sessions.delete(event.sessionId)
    if (event.cancelled) return
    if (event.stopReason === 'error' || event.error) {
      this.setOverride({ mood: 'sad', difficulty: 2, label: 'Não consegui concluir' }, MOOD_THRESHOLDS.sadMs, now)
      return
    }
    this.setOverride(
      {
        mood: 'happy',
        difficulty: 0,
        label: peak >= 2 ? 'Consegui, mesmo com as dificuldades!' : 'Pronto!'
      },
      MOOD_THRESHOLDS.happyMs,
      now
    )
  }

  private session(id: string, now: number): SessionSignals {
    let s = this.sessions.get(id)
    if (!s) {
      s = {
        calls: new Map(),
        failures: [],
        approvals: new Set(),
        questions: new Set(),
        phase: 'idle',
        lastActivityAt: now,
        notice: null,
        contextHigh: false,
        peak: 0
      }
      this.sessions.set(id, s)
    }
    return s
  }

  private resetTurn(s: SessionSignals): void {
    s.calls.clear()
    s.failures = []
    s.approvals.clear()
    s.questions.clear()
    s.notice = null
    s.contextHigh = false
    s.peak = 0
  }

  private recordFailure(s: SessionSignals, tool: string, weight: number, now: number): void {
    s.failures.push({ at: now, weight, tool })
    if (s.failures.length > MAX_TRACKED_FAILURES) s.failures.splice(0, s.failures.length - MAX_TRACKED_FAILURES)
  }

  private setOverride(state: MascotState, ms: number, now: number): void {
    this.override = { state, until: now + ms }
  }

  /* ------------------------------------------------------------------ */
  /* Evaluation                                                          */
  /* ------------------------------------------------------------------ */

  private evaluate(now: number): void {
    if (this.override && now >= this.override.until) this.override = null
    let best: MascotState | null = null
    for (const s of this.sessions.values()) {
      const state = this.baseState(s, now)
      s.peak = Math.max(s.peak, state.difficulty)
      if (!best || beats(state, best)) best = state
    }
    const next: MascotState = this.override?.state ?? best ?? { mood: 'calm', difficulty: 0, label: DEFAULT_LABEL }
    if (
      next.mood === this.current.mood &&
      next.label === this.current.label &&
      next.difficulty === this.current.difficulty
    ) {
      return
    }
    this.current = { ...next }
    this.onChange({ ...next })
  }

  /** The mood a single session asks for, ignoring temporary overrides. */
  private baseState(s: SessionSignals, now: number): MascotState {
    const T = MOOD_THRESHOLDS
    const recent = s.failures.filter((failure) => now - failure.at <= T.failureWindowMs)
    const failureCount = recent.reduce((sum, failure) => sum + failure.weight, 0)
    const sameTool = trailingSameTool(recent)

    let silence = 0
    let quietest: RunningCall | null = null
    let latest: RunningCall | null = null
    for (const call of s.calls.values()) {
      const quiet = now - Math.max(call.startedAt, call.lastProgressAt)
      if (!quietest || quiet > silence) {
        silence = quiet
        quietest = call
      }
      if (!latest || call.order > latest.order) latest = call
    }

    if (s.approvals.size + s.questions.size > 0) {
      return { mood: 'asking', difficulty: 0, label: 'Esperando sua resposta' }
    }

    if (failureCount >= T.overwhelmedFailures || sameTool.count >= T.overwhelmedSameTool || silence >= T.overwhelmedSilenceMs) {
      let label: string
      if (sameTool.count >= T.overwhelmedSameTool) {
        label = `"${shortName(sameTool.tool)}" falhou ${sameTool.count}× seguidas`
      } else if (failureCount >= T.overwhelmedFailures) {
        label = `Está difícil: ${failureCount} falhas seguidas`
      } else {
        label = `Travado há ${formatDuration(silence)} sem resposta`
      }
      return { mood: 'overwhelmed', difficulty: 3, label }
    }

    if (failureCount >= T.struggleFailures || silence >= T.struggleSilenceMs) {
      const label =
        failureCount >= T.struggleFailures
          ? `Tentando de novo: ${failureCount} falhas seguidas`
          : `Sem resposta há ${formatDuration(silence)}`
      return { mood: 'struggling', difficulty: 2, label }
    }

    if (s.notice && now < s.notice.until) {
      return { mood: 'worried', difficulty: 1, label: s.notice.text }
    }
    if (s.contextHigh) {
      return { mood: 'worried', difficulty: 1, label: 'Contexto quase cheio' }
    }

    if (silence >= T.waitSilenceMs && quietest) {
      return { mood: 'waiting', difficulty: 1, label: `Esperando "${shortName(quietest.name)}" há ${formatDuration(silence)}` }
    }
    const idle = now - s.lastActivityAt
    if (s.calls.size === 0 && s.phase === 'thinking' && idle >= T.sleepyIdleMs) {
      return { mood: 'sleepy', difficulty: 1, label: `Pensando há ${formatDuration(idle)}…` }
    }

    if (failureCount === T.confusedFailures) {
      return { mood: 'confused', difficulty: 1, label: 'Algo não saiu como esperado' }
    }

    if (s.calls.size === 0 && s.phase === 'thinking') {
      return { mood: 'thinking', difficulty: 0, label: 'Pensando no próximo passo' }
    }
    if (latest && OBSERVATION_TOOL.test(latest.name)) {
      return { mood: 'curious', difficulty: 0, label: DEFAULT_LABEL }
    }
    if (s.calls.size > 0 || s.phase === 'streaming' || s.phase === 'tool') {
      return { mood: 'working', difficulty: 0, label: DEFAULT_LABEL }
    }
    return { mood: 'calm', difficulty: 0, label: DEFAULT_LABEL }
  }
}

function beats(a: MascotState, b: MascotState): boolean {
  const pa = MOOD_PRIORITY[a.mood]
  const pb = MOOD_PRIORITY[b.mood]
  if (pa !== pb) return pa > pb
  return a.difficulty > b.difficulty
}

function trailingSameTool(failures: Failure[]): { tool: string; count: number } {
  const last = failures[failures.length - 1]
  if (!last) return { tool: '', count: 0 }
  let count = 0
  for (let i = failures.length - 1; i >= 0 && failures[i].tool === last.tool; i--) count += failures[i].weight
  return { tool: last.tool, count }
}

function touchAll(s: SessionSignals, now: number): void {
  for (const call of s.calls.values()) call.lastProgressAt = now
}

function callKey(event: Extract<HarnessEvent, { type: 'tool_start' | 'tool_progress' | 'tool_end' }>): string {
  return `${event.agentId ?? 'root'}::${event.toolCallId}`
}

function shortName(name: string): string {
  return name.length > MAX_TOOL_NAME ? `${name.slice(0, MAX_TOOL_NAME - 1)}…` : name
}

function noticeLabel(text: string): string {
  if (/contexto/i.test(text)) return 'Contexto quase cheio: compactando'
  if (/transit|tentativa|limite|cota|rate/i.test(text)) return 'Instabilidade no provedor: tentando de novo'
  return 'Aviso do sistema'
}
