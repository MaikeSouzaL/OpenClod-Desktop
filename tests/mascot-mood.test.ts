import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LABEL,
  MASCOT_MOODS,
  MOOD_PRIORITY,
  MOOD_THRESHOLDS,
  MascotMoodTracker,
  formatDuration,
  type MascotMood,
  type MascotState
} from '../src/core/computer/mood'
import type { HarnessEvent } from '../src/shared/types'

const S = 'ses_1'

const turnStart = (sessionId = S): HarnessEvent => ({ type: 'turn_start', sessionId, messageId: 'm1' })
const turnEnd = (extra: { stopReason?: 'stop' | 'error' | 'length'; error?: string; cancelled?: boolean } = {}, sessionId = S): HarnessEvent => ({
  type: 'turn_end',
  sessionId,
  messageId: 'm1',
  stopReason: extra.stopReason ?? 'stop',
  ...(extra.error ? { error: extra.error } : {}),
  ...(extra.cancelled ? { cancelled: true } : {})
})
const start = (id: string, name = 'computer_click', sessionId = S, agentId?: string): HarnessEvent => ({
  type: 'tool_start',
  sessionId,
  toolCallId: id,
  name,
  args: {},
  ...(agentId ? { agentId } : {})
})
const progress = (id: string, name = 'computer_click', sessionId = S): HarnessEvent => ({
  type: 'tool_progress',
  sessionId,
  toolCallId: id,
  name,
  text: '...'
})
const end = (
  id: string,
  ok = true,
  name = 'computer_click',
  extra: { summary?: string; text?: string; data?: Record<string, unknown>; agentId?: string; sessionId?: string } = {}
): HarnessEvent => ({
  type: 'tool_end',
  sessionId: extra.sessionId ?? S,
  toolCallId: id,
  name,
  ok,
  summary: extra.summary ?? (ok ? 'ok' : 'falhou'),
  ...(extra.text ? { text: extra.text } : {}),
  ...(extra.data ? { data: extra.data } : {}),
  ...(extra.agentId ? { agentId: extra.agentId } : {})
})
const status = (state: 'thinking' | 'streaming' | 'tool' | 'idle' | 'done', sessionId = S): HarnessEvent => ({
  type: 'status',
  sessionId,
  state
})
const notice = (text: string, level: 'info' | 'warn' | 'error' = 'warn', sessionId = S): HarnessEvent => ({
  type: 'notice',
  sessionId,
  level,
  text
})
const budget = (contextTokens: number, contextWindow: number, sessionId = S): HarnessEvent => ({
  type: 'budget',
  sessionId,
  info: {
    kind: 'tokens',
    used: 0,
    limit: 0,
    input: 0,
    output: 0,
    cachedInput: 0,
    iterations: 1,
    toolCalls: 0,
    contextTokens,
    contextWindow
  }
})
const approval = (id: string, sessionId = S): HarnessEvent => ({
  type: 'approval_request',
  sessionId,
  request: { id, tool: 'bash', title: 't', detail: 'd', risk: 'medium' } as never
})
const approvalDone = (id: string, sessionId = S): HarnessEvent => ({ type: 'approval_resolved', sessionId, id, approved: true })
const question = (id: string, sessionId = S): HarnessEvent => ({
  type: 'question_request',
  sessionId,
  request: { id, sessionId, questions: [] }
})
const questionDone = (id: string, sessionId = S): HarnessEvent => ({ type: 'question_resolved', sessionId, id, answers: [] })
const subagent = (state: 'thinking' | 'done' | 'error', childId = 'c1', sessionId = S): HarnessEvent => ({
  type: 'subagent',
  sessionId,
  childId,
  label: 'Especialista',
  state
})

let clock = 0
let changes: MascotState[] = []
let tracker: MascotMoodTracker

const advance = (ms: number): void => {
  clock += ms
  tracker.tick()
}
const feed = (...events: HarnessEvent[]): void => {
  for (const event of events) tracker.handle(event)
}
const mood = (): MascotMood => tracker.state.mood

beforeEach(() => {
  clock = 1_000_000
  changes = []
  tracker = new MascotMoodTracker((state) => changes.push(state), () => clock)
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours in pt-BR', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(59_999)).toBe('59 s')
    expect(formatDuration(60_000)).toBe('1 min')
    expect(formatDuration(92_000)).toBe('1 min 32 s')
    expect(formatDuration(150_000)).toBe('2 min 30 s')
    expect(formatDuration(3_900_000)).toBe('1 h 5 min')
    expect(formatDuration(-5)).toBe('0 s')
  })
})

describe('MascotMoodTracker - table', () => {
  it('declares the 14 moods with a priority each, in the documented order', () => {
    expect(MASCOT_MOODS).toHaveLength(14)
    for (const m of MASCOT_MOODS) expect(MOOD_PRIORITY[m]).toBeGreaterThan(0)
    const order: MascotMood[] = ['calm', 'working', 'curious', 'thinking', 'confused', 'waiting', 'worried', 'struggling', 'overwhelmed', 'asking', 'happy']
    for (let i = 1; i < order.length; i++) {
      expect(MOOD_PRIORITY[order[i]]).toBeGreaterThanOrEqual(MOOD_PRIORITY[order[i - 1]])
    }
    expect(MOOD_PRIORITY.waiting).toBe(MOOD_PRIORITY.sleepy)
    expect(MOOD_PRIORITY.relieved).toBe(100)
    expect(MOOD_PRIORITY.sad).toBe(100)
  })

  it('starts calm with the default label', () => {
    expect(tracker.state).toEqual({ mood: 'calm', difficulty: 0, label: DEFAULT_LABEL })
    expect(changes).toHaveLength(0)
  })
})

describe('MascotMoodTracker - calm, working, thinking, curious', () => {
  it('thinks at the start of a turn and when a tool result is being digested', () => {
    feed(turnStart())
    expect(tracker.state).toEqual({ mood: 'thinking', difficulty: 0, label: 'Pensando no próximo passo' })
    feed(start('a'))
    expect(mood()).toBe('working')
    feed(end('a'))
    expect(mood()).toBe('thinking')
  })

  it('works while a regular tool runs and while the model streams', () => {
    feed(turnStart(), start('a', 'computer_click'))
    expect(tracker.state).toEqual({ mood: 'working', difficulty: 0, label: DEFAULT_LABEL })
    feed(end('a'), status('streaming'))
    expect(mood()).toBe('working')
    feed(status('thinking'))
    expect(mood()).toBe('thinking')
  })

  it.each(['computer_screenshot', 'browser_snapshot', 'read_file', 'computer_find', 'computer_list_windows', 'computer_ocr', 'browser_get_page', 'computer_wait'])(
    'is curious while the observation tool %s runs',
    (name) => {
      feed(turnStart(), start('a', name))
      expect(tracker.state).toEqual({ mood: 'curious', difficulty: 0, label: DEFAULT_LABEL })
    }
  )

  it('goes back to calm when the turn is idle without override', () => {
    feed(turnStart(), status('idle'))
    expect(mood()).toBe('calm')
  })
})

describe('MascotMoodTracker - waiting, sleepy and silence', () => {
  it('waits when a call is silent for 20 s, and progress wakes it up', () => {
    feed(turnStart(), start('a', 'computer_click'))
    advance(19_000)
    expect(mood()).toBe('working')
    advance(6_000)
    expect(tracker.state).toEqual({ mood: 'waiting', difficulty: 1, label: 'Esperando "computer_click" há 25 s' })
    feed(progress('a'))
    expect(mood()).toBe('working')
    advance(MOOD_THRESHOLDS.waitSilenceMs)
    expect(mood()).toBe('waiting')
  })

  it('shortens long tool names in the label', () => {
    feed(turnStart(), start('a', 'mcp__servidor_com_nome_muito_longo__ferramenta'))
    advance(25_000)
    expect(tracker.state.label.length).toBeLessThanOrEqual(46)
    expect(tracker.state.label).toContain('…')
  })

  it('struggles after 60 s of silence and is overwhelmed after 150 s', () => {
    feed(turnStart(), start('a', 'bash'))
    advance(65_000)
    expect(tracker.state).toEqual({ mood: 'struggling', difficulty: 2, label: 'Sem resposta há 1 min 5 s' })
    advance(85_000)
    expect(tracker.state).toEqual({ mood: 'overwhelmed', difficulty: 3, label: 'Travado há 2 min 30 s sem resposta' })
  })

  it('uses the quietest of several running calls', () => {
    feed(turnStart(), start('a', 'bash'), start('b', 'computer_click'))
    advance(15_000)
    feed(progress('a', 'bash'))
    advance(10_000)
    expect(tracker.state.label).toBe('Esperando "computer_click" há 25 s')
  })

  it('does not count the time spent waiting for the user as silence', () => {
    feed(turnStart(), start('a', 'bash'), approval('ap1'))
    advance(100_000)
    expect(mood()).toBe('asking')
    feed(approvalDone('ap1'))
    expect(mood()).toBe('working')
    advance(10_000)
    expect(mood()).toBe('working')
  })

  it('gets sleepy after 60 s thinking without any activity, and deltas keep it awake', () => {
    feed(turnStart())
    advance(30_000)
    expect(mood()).toBe('thinking')
    feed({ type: 'reasoning_delta', sessionId: S, messageId: 'm1', text: 'hmm' })
    advance(45_000)
    expect(mood()).toBe('thinking')
    advance(25_000)
    expect(tracker.state).toEqual({ mood: 'sleepy', difficulty: 1, label: 'Pensando há 1 min 10 s…' })
    feed({ type: 'text_delta', sessionId: S, messageId: 'm1', text: 'ola' })
    expect(mood()).toBe('thinking')
  })

  it('is not sleepy while a tool is running (that is waiting)', () => {
    feed(turnStart(), start('a', 'bash'))
    advance(25_000)
    expect(mood()).toBe('waiting')
  })
})

describe('MascotMoodTracker - failures', () => {
  it('is confused after one failure and recovers with a success', () => {
    feed(turnStart(), start('a'), end('a', false))
    expect(tracker.state).toEqual({ mood: 'confused', difficulty: 1, label: 'Algo não saiu como esperado' })
    feed(start('b'), end('b', true))
    expect(mood()).toBe('thinking')
  })

  it('struggles after two failures in a row and says how many', () => {
    feed(turnStart(), start('a', 'computer_click'), end('a', false, 'computer_click'), start('b', 'computer_type'), end('b', false, 'computer_type'))
    expect(tracker.state).toEqual({ mood: 'struggling', difficulty: 2, label: 'Tentando de novo: 2 falhas seguidas' })
  })

  it('is overwhelmed after four failures of different tools', () => {
    feed(turnStart())
    for (const [i, name] of ['a_tool', 'b_tool', 'c_tool', 'd_tool'].entries()) feed(start(`t${i}`, name), end(`t${i}`, false, name))
    expect(tracker.state).toEqual({ mood: 'overwhelmed', difficulty: 3, label: 'Está difícil: 4 falhas seguidas' })
  })

  it('is overwhelmed when the same tool fails three times in a row', () => {
    feed(turnStart())
    for (let i = 0; i < 3; i++) feed(start(`t${i}`, 'computer_click'), end(`t${i}`, false, 'computer_click'))
    expect(tracker.state).toEqual({ mood: 'overwhelmed', difficulty: 3, label: '"computer_click" falhou 3× seguidas' })
  })

  it('a success in between resets the streak', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false), start('c'), end('c', true))
    advance(MOOD_THRESHOLDS.relievedMs + 100)
    feed(start('d'), end('d', false))
    expect(mood()).toBe('confused')
  })

  it('only considers failures from the last 120 s', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false))
    expect(mood()).toBe('struggling')
    advance(MOOD_THRESHOLDS.failureWindowMs - 10_000)
    expect(mood()).toBe('struggling')
    feed(start('c'), end('c', false)) // third failure, the first two are about to expire
    expect(mood()).toBe('overwhelmed')
    advance(15_000) // first two fall out of the window: one recent failure left
    expect(mood()).toBe('confused')
    advance(MOOD_THRESHOLDS.failureWindowMs)
    feed({ type: 'reasoning_delta', sessionId: S, messageId: 'm1', text: 'hmm' })
    expect(mood()).toBe('thinking')
  })

  it('counts a timeout twice (data.timedOut and the word TIMEOUT)', () => {
    feed(turnStart(), start('a', 'bash'), end('a', false, 'bash', { data: { timedOut: true } }))
    expect(tracker.state).toEqual({ mood: 'struggling', difficulty: 2, label: 'Tentando de novo: 2 falhas seguidas' })
    feed(start('b', 'bash'), end('b', true, 'bash'))
    advance(MOOD_THRESHOLDS.relievedMs + 100)
    feed(start('c', 'bash'), end('c', false, 'bash', { summary: 'TIMEOUT após 30 s' }))
    expect(mood()).toBe('struggling')
    feed(start('d', 'bash'), end('d', false, 'bash', { text: 'erro: TIMEOUT' }))
    expect(mood()).toBe('overwhelmed')
  })

  it('ignores calls denied or cancelled by the user', () => {
    feed(turnStart(), start('a'), end('a', false, 'bash', { summary: 'negado pelo usuário' }))
    expect(mood()).toBe('thinking')
    feed(start('b'), end('b', false, 'bash', { summary: 'cancelada' }), start('c'), end('c', false, 'bash', { summary: 'ação recusada' }))
    expect(mood()).toBe('thinking')
    expect(tracker.state.difficulty).toBe(0)
  })

  it('a failing subagent counts as a failure, and its tool events count on the root session', () => {
    feed(turnStart(), subagent('thinking'), start('s1', 'bash', S, 'c1'), end('s1', false, 'bash', { agentId: 'c1' }))
    expect(mood()).toBe('confused')
    feed(subagent('error'))
    expect(mood()).toBe('struggling')
  })

  it('subagent activity keeps a long agent call from looking stuck', () => {
    feed(turnStart(), start('a', 'agent'))
    for (let i = 0; i < 8; i++) {
      advance(15_000)
      feed(start(`s${i}`, 'read_file', S, 'c1'), end(`s${i}`, true, 'read_file', { agentId: 'c1' }))
    }
    expect(mood()).not.toBe('struggling')
    expect(mood()).not.toBe('overwhelmed')
  })

  it('a new turn forgets the failures of the previous one', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false))
    expect(mood()).toBe('struggling')
    feed(turnStart())
    expect(mood()).toBe('thinking')
  })
})

describe('MascotMoodTracker - asking and worried', () => {
  it('asks while an approval or a question is pending', () => {
    feed(turnStart(), start('a'), approval('ap1'))
    expect(tracker.state).toEqual({ mood: 'asking', difficulty: 0, label: 'Esperando sua resposta' })
    feed(approvalDone('ap1'))
    expect(mood()).toBe('working')
    feed(question('q1'))
    expect(mood()).toBe('asking')
    feed(approval('ap2'), questionDone('q1'))
    expect(mood()).toBe('asking')
    feed(approvalDone('ap2'))
    expect(mood()).toBe('working')
  })

  it('asking beats being stuck', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false), question('q1'))
    expect(mood()).toBe('asking')
  })

  it('worries for ~8 s on a warn/error notice, with a reason from the text', () => {
    feed(turnStart(), notice('Contexto 92% cheio, compactando'))
    expect(tracker.state).toEqual({ mood: 'worried', difficulty: 1, label: 'Contexto quase cheio: compactando' })
    advance(8_100)
    expect(mood()).toBe('thinking')
    feed(notice('transitório: nova tentativa em 2s', 'error'))
    expect(tracker.state.label).toBe('Instabilidade no provedor: tentando de novo')
    advance(8_100)
    feed(notice('limite de cota atingido'))
    expect(tracker.state.label).toBe('Instabilidade no provedor: tentando de novo')
    advance(8_100)
    feed(notice('algo estranho aconteceu'))
    expect(tracker.state).toEqual({ mood: 'worried', difficulty: 1, label: 'Aviso do sistema' })
  })

  it('ignores info notices', () => {
    feed(turnStart(), notice('tudo certo', 'info'))
    expect(mood()).toBe('thinking')
  })

  it('worries while the context is at least 90% full, and calms down below that', () => {
    feed(turnStart(), budget(89_000, 100_000))
    expect(mood()).toBe('thinking')
    feed(budget(90_000, 100_000))
    expect(tracker.state).toEqual({ mood: 'worried', difficulty: 1, label: 'Contexto quase cheio' })
    feed(budget(40_000, 100_000))
    expect(mood()).toBe('thinking')
    feed(budget(10, 0))
    expect(mood()).toBe('thinking')
  })

  it('struggling beats worried', () => {
    feed(turnStart(), notice('aviso'), start('a'), end('a', false), start('b'), end('b', false))
    expect(mood()).toBe('struggling')
  })
})

describe('MascotMoodTracker - relief, joy and sadness', () => {
  it('feels relieved when a call succeeds after struggling, then moves on', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false), start('c'))
    expect(mood()).toBe('struggling')
    feed(end('c', true))
    expect(tracker.state).toEqual({ mood: 'relieved', difficulty: 0, label: 'Resolvido!' })
    advance(MOOD_THRESHOLDS.relievedMs - 100)
    expect(mood()).toBe('relieved')
    advance(200)
    expect(mood()).toBe('thinking')
  })

  it('is relieved after being stuck in silence for a minute', () => {
    feed(turnStart(), start('a', 'bash'))
    advance(70_000)
    expect(mood()).toBe('struggling')
    feed(end('a', true, 'bash'))
    expect(mood()).toBe('relieved')
  })

  it('is not relieved after a small hiccup (difficulty 1)', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', true))
    expect(mood()).toBe('thinking')
  })

  it('celebrates a successful turn for a couple of seconds', () => {
    feed(turnStart(), start('a'), end('a', true), status('done'), turnEnd())
    expect(tracker.state).toEqual({ mood: 'happy', difficulty: 0, label: 'Pronto!' })
    advance(MOOD_THRESHOLDS.happyMs - 100)
    expect(mood()).toBe('happy')
    advance(200)
    expect(tracker.state).toEqual({ mood: 'calm', difficulty: 0, label: DEFAULT_LABEL })
  })

  it('celebrates differently when the turn was hard', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false), start('c'), end('c', true), turnEnd())
    expect(tracker.state).toEqual({ mood: 'happy', difficulty: 0, label: 'Consegui, mesmo com as dificuldades!' })
  })

  it('remembers the hardest moment of the turn even if it ended before turn_end', () => {
    feed(turnStart(), start('a'), end('a', false), start('b'), end('b', false))
    advance(1_000)
    feed(start('c'), end('c', true)) // relieved, failures cleared
    advance(MOOD_THRESHOLDS.relievedMs + 1_000)
    feed(turnEnd())
    expect(tracker.state.label).toBe('Consegui, mesmo com as dificuldades!')
  })

  it('is sad when the turn ends with an error, by stopReason or by error text', () => {
    feed(turnStart(), start('a'), end('a', true), turnEnd({ stopReason: 'error', error: 'falha do provedor' }))
    expect(tracker.state).toEqual({ mood: 'sad', difficulty: 2, label: 'Não consegui concluir' })
    advance(MOOD_THRESHOLDS.sadMs + 100)
    expect(mood()).toBe('calm')
    feed(turnStart(), turnEnd({ stopReason: 'length', error: 'limite de 50 iterações atingido' }))
    expect(mood()).toBe('sad')
    advance(MOOD_THRESHOLDS.sadMs + 100)
    feed(turnStart(), turnEnd({ stopReason: 'error' }))
    expect(mood()).toBe('sad')
  })

  it('does not celebrate or mourn a cancelled turn', () => {
    feed(turnStart(), start('a'), turnEnd({ stopReason: 'error', error: 'turno cancelado pelo usuário', cancelled: true }))
    expect(tracker.state).toEqual({ mood: 'calm', difficulty: 0, label: DEFAULT_LABEL })
  })

  it('a turn end drops stale calls and failures instead of lingering on struggling', () => {
    feed(turnStart(), start('a', 'bash'), start('b'), end('b', false), end('x', false), turnEnd({ cancelled: true, error: 'turno cancelado pelo usuário', stopReason: 'error' }))
    advance(200_000)
    expect(mood()).toBe('calm')
  })

  it('overrides beat everything else, including asking', () => {
    feed(turnStart(), question('q1'))
    feed(turnEnd())
    expect(mood()).toBe('happy')
  })
})

describe('MascotMoodTracker - several sessions', () => {
  it('shows the highest priority across sessions', () => {
    feed(turnStart('a'), start('a1', 'computer_click', 'a'))
    expect(mood()).toBe('working')
    feed(turnStart('b'), start('b1', 'bash', 'b'), end('b1', false, 'bash', { sessionId: 'b' }), start('b2', 'bash', 'b'), end('b2', false, 'bash', { sessionId: 'b' }))
    expect(mood()).toBe('struggling')
    feed(question('q', 'a'))
    expect(mood()).toBe('asking')
    feed(questionDone('q', 'a'))
    expect(mood()).toBe('struggling')
  })

  it('failures of one session do not leak into another', () => {
    feed(turnStart('a'), start('a1', 'bash', 'a'), end('a1', false, 'bash', { sessionId: 'a' }))
    feed(turnStart('b'), start('b1', 'bash', 'b'), end('b1', false, 'bash', { sessionId: 'b' }))
    expect(mood()).toBe('confused') // one each, not two
  })

  it('a finished session leaves the other one in charge once the celebration ends', () => {
    feed(turnStart('a'), start('a1', 'computer_screenshot', 'a'))
    feed(turnStart('b'), turnEnd({}, 'b'))
    expect(mood()).toBe('happy')
    advance(MOOD_THRESHOLDS.happyMs + 100)
    expect(mood()).toBe('curious')
  })
})

describe('MascotMoodTracker - onChange', () => {
  it('fires only when mood, label or difficulty change', () => {
    feed(turnStart())
    expect(changes).toHaveLength(1)
    feed({ type: 'text_delta', sessionId: S, messageId: 'm1', text: 'a' }, { type: 'reasoning_delta', sessionId: S, messageId: 'm1', text: 'b' })
    tracker.tick()
    tracker.tick()
    expect(changes).toHaveLength(1)
    feed(status('thinking'), { type: 'plan', sessionId: S, items: [] })
    expect(changes).toHaveLength(1)
    feed(start('a', 'bash'), progress('a', 'bash'))
    expect(changes.map((c) => c.mood)).toEqual(['thinking', 'working'])
  })

  it('fires again when only the label changes (the waiting counter) and when difficulty changes', () => {
    feed(turnStart(), start('a', 'bash'))
    const before = changes.length
    advance(21_000)
    advance(1_000)
    expect(changes.length).toBe(before + 2)
    expect(changes[changes.length - 1].label).toBe('Esperando "bash" há 22 s')
  })

  it('hands out copies, so the listener cannot corrupt the tracker', () => {
    feed(turnStart())
    changes[0].mood = 'sad'
    tracker.state.label = 'x'
    expect(tracker.state.mood).toBe('thinking')
  })

  it('stops reacting after dispose', () => {
    feed(turnStart())
    tracker.dispose()
    feed(start('a'))
    advance(100_000)
    expect(changes).toHaveLength(1)
  })
})
