import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { buildRegistry } from '../src/core/tools/registry'
import { updatePlanTool } from '../src/core/tools/plan'
import { DEFAULT_LIMITS, type HarnessEvent, type Message } from '../src/shared/types'
import { ScriptedProvider, type MockTurn } from './support/scripted-provider'
import type { ToolDef } from '../src/core/tools/types'
import { z } from 'zod'
import { makeTempDir, policy, removeTempDir } from './helpers'

// Two long-job problems seen in real Cowork runs: the model writes its plan once and never updates it (the screen shows
// "0/6" over finished work), and a turn that hits the iteration cap ends with no way to continue but typing it yourself.

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('openclod-plan-reminder-')
})

afterEach(async () => {
  await removeTempDir(cwd)
})

const readTool: ToolDef = {
  name: 'read_file',
  description: 'fake read',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: (raw) => ({ title: 'Ler', detail: String((raw as { path: string }).path), preview: String((raw as { path: string }).path) }),
  async execute(raw) {
    return { ok: true, text: `conteúdo de ${(raw as { path: string }).path}` }
  }
}

function makeRunner(provider: ScriptedProvider, maxIterations: number, over: Partial<RunnerDeps> = {}): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_plan_reminder',
    cwd,
    mode: 'autonomous',
    surface: 'cowork',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry: buildRegistry(updatePlanTool, readTool),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: { all: async () => [] } } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    retryBaseMs: 1,
    ...over
  }
  return { runner: new SessionRunner(deps), events }
}

const text = (message: Message): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
let planCalls = 0
const plan = (...status: Array<'pending' | 'active' | 'done'>): MockTurn => ({
  toolCalls: [{ id: `plan-${++planCalls}`, name: 'update_plan', args: { items: status.map((s, index) => ({ text: `Passo ${index + 1}`, status: s })) } }]
})
const read = (n: number): MockTurn => ({ toolCalls: [{ id: `read-${n}`, name: 'read_file', args: { path: `arquivo-${n}.txt` } }] })
const reads = (count: number): MockTurn[] => Array.from({ length: count }, (_, index) => read(index))

/** Index of the first provider request that carried a plan reminder, or -1. */
function firstReminder(provider: ScriptedProvider): number {
  return provider.requests.findIndex((request) => request.messages.some((message) => message.hidden && text(message).includes('<plan-reminder>')))
}

describe('plan reminder', () => {
  it('reminds the agent after 12 iterations without updating a plan that still has open steps', async () => {
    const provider = new ScriptedProvider([plan('active', 'pending'), ...reads(20), { text: 'pronto' }])
    const { runner } = makeRunner(provider, 40)
    await runner.send('prepare os arquivos')

    // update_plan ran at iteration 1; the 12 quiet iterations that follow end at iteration 13 (the 13th request).
    expect(firstReminder(provider)).toBe(12)
    const reminder = provider.requests[12].messages.find((message) => message.hidden && text(message).includes('<plan-reminder>'))!
    expect(text(reminder)).toContain('[active] Passo 1')
    expect(text(reminder)).toContain('[pending] Passo 2')
    expect(text(reminder)).toContain('update_plan')
  })

  it('does not remind before 12 iterations, and not at all once the plan is brought up to date', async () => {
    const provider = new ScriptedProvider([plan('active', 'pending'), ...reads(5), plan('done', 'active'), ...reads(5), { text: 'pronto' }])
    const { runner } = makeRunner(provider, 40)
    await runner.send('prepare os arquivos')
    expect(firstReminder(provider)).toBe(-1)
  })

  it('reminds again later when the plan stays untouched, but at most four times per turn', async () => {
    const provider = new ScriptedProvider([plan('active', 'pending'), ...reads(70), { text: 'pronto' }])
    const { runner } = makeRunner(provider, 80)
    await runner.send('prepare os arquivos')
    const reminders = provider.requests[provider.requests.length - 1].messages.filter((message) => message.hidden && text(message).includes('<plan-reminder>'))
    expect(reminders).toHaveLength(4)
  })

  it('stays quiet when no step is open', async () => {
    const provider = new ScriptedProvider([plan('done', 'done'), ...reads(20), { text: 'pronto' }])
    const { runner } = makeRunner(provider, 40)
    await runner.send('prepare os arquivos')
    expect(firstReminder(provider)).toBe(-1)
  })

  it('stays quiet when the agent never wrote a plan', async () => {
    const provider = new ScriptedProvider([...reads(20), { text: 'pronto' }])
    const { runner } = makeRunner(provider, 40)
    await runner.send('leia os arquivos')
    expect(firstReminder(provider)).toBe(-1)
  })

  it('is for the user\'s own session: a subagent\'s plan is not on the screen', async () => {
    const provider = new ScriptedProvider([plan('active', 'pending'), ...reads(20), { text: 'pronto' }])
    const { runner } = makeRunner(provider, 40, { depth: 1 })
    await runner.send('prepare os arquivos')
    expect(firstReminder(provider)).toBe(-1)
  })
})

describe('stopping at the iteration cap', () => {
  const budgetEvents = (events: HarnessEvent[]): Array<Extract<HarnessEvent, { type: 'budget' }>> =>
    events.filter((event): event is Extract<HarnessEvent, { type: 'budget' }> => event.type === 'budget')

  it('offers to continue, like a token or cost stop, with the iteration counts', async () => {
    const provider = new ScriptedProvider([plan('active', 'pending'), read(1), { text: 'Resumo: li um arquivo.' }])
    const { runner, events } = makeRunner(provider, 3)
    await runner.send('tarefa longa')

    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'length' })
    const budgets = budgetEvents(events)
    expect(budgets).toHaveLength(1)
    expect(budgets[0].info).toMatchObject({ kind: 'iterations', used: 3, limit: 3, iterations: 3 })
  })

  it('does not offer it for a subagent that hit its own cap', async () => {
    const provider = new ScriptedProvider([read(1), { text: 'Resumo parcial.' }])
    const { events, runner } = makeRunner(provider, 2, { depth: 1 })
    await runner.send('subtarefa')
    expect(budgetEvents(events)).toHaveLength(0)
  })

  it('does not offer it when the turn simply finishes', async () => {
    const provider = new ScriptedProvider([read(1), { text: 'pronto' }])
    const { runner, events } = makeRunner(provider, 6)
    await runner.send('tarefa curta')
    expect(budgetEvents(events)).toHaveLength(0)
  })
})
