import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { discardedPlanNotice, resumePlanAt } from '../src/core/agent/plan-control'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { Orchestrator } from '../src/main/orchestrator'
import { DEFAULT_LIMITS, type HarnessEvent, type Message, type PlanItem } from '../src/shared/types'
import { ScriptedProvider } from './support/scripted-provider'
import { policy } from './helpers'

/**
 * The plan dock after the user pressed Parar: ▶ in front of the step that was running continues exactly from it, and the
 * trash gives the plan up for good (no more work, no queued message, no continuity capsule offering it to other sessions).
 */
let dir = ''
let projectDir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-plan-ctl-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-plan-ctl-proj-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

const plan = (): PlanItem[] => [
  { id: 'p1', text: 'Ler o código', status: 'done' },
  { id: 'p2', text: 'Migrar o banco', status: 'active', startedAt: 1_000 },
  { id: 'p3', text: 'Rodar os testes', status: 'pending' }
]
const text = (message: Message): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')

describe('plan control helpers', () => {
  it('reopens the stopped step as the interrupted active one and keeps a single step in progress', () => {
    const resumed = resumePlanAt(plan(), 'p2', 5_000)!
    expect(resumed.find((item) => item.id === 'p2')).toMatchObject({ status: 'active', interrupted: true, endedAt: 5_000 })

    const blocked: PlanItem[] = [
      { id: 'a', text: 'A', status: 'blocked' },
      { id: 'b', text: 'B', status: 'active' }
    ]
    const next = resumePlanAt(blocked, 'a', 7)!
    expect(next.map((item) => [item.id, item.status, Boolean(item.interrupted)])).toEqual([
      ['a', 'active', true],
      ['b', 'pending', false]
    ])
  })

  it('refuses a finished step or one that is not in the plan', () => {
    expect(resumePlanAt(plan(), 'p1')).toBeNull()
    expect(resumePlanAt(plan(), 'nao-existe')).toBeNull()
  })

  it('leaves a hidden note listing only the steps that were given up', () => {
    const note = discardedPlanNotice(plan())
    expect(note).toMatchObject({ role: 'user', hidden: true })
    expect(text(note)).toContain('<plano-descartado>')
    expect(text(note)).toContain('- Migrar o banco')
    expect(text(note)).toContain('- Rodar os testes')
    expect(text(note)).not.toContain('Ler o código')
  })
})

function makeRunner(provider: ScriptedProvider, events: HarnessEvent[], initialPlan: PlanItem[]): SessionRunner {
  const deps: RunnerDeps = {
    sessionId: 'ses_plan_ctl',
    cwd: projectDir,
    mode: 'code',
    provider,
    providerConfig: {
      id: 'mock',
      kind: 'openai',
      label: 'Duplo',
      baseUrl: 'http://localhost:0/v1',
      model: 'duplo',
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: true
    },
    registry: buildRegistry(),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 4 },
    tracker: new FileTracker(projectDir),
    workspace: new WorkspaceGuard([projectDir]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    initial: { plan: initialPlan }
  }
  return new SessionRunner(deps)
}

describe('the runner', () => {
  it('▶ makes the next turn continue exactly from the step the user picked', async () => {
    const provider = new ScriptedProvider([{ text: 'Retomando a migração.' }])
    const events: HarnessEvent[] = []
    const runner = makeRunner(provider, events, plan())
    const item = runner.resumePlanFrom('p2')
    expect(item).toMatchObject({ id: 'p2', interrupted: true })
    expect(events.some((event) => event.type === 'plan')).toBe(true)

    await runner.send('Continue a partir do passo: Migrar o banco')
    const sent = provider.requests[0].messages.map(text).join('\n')
    expect(sent).toContain('<retomada>')
    expect(sent).toContain('- Migrar o banco')
    expect(sent).toContain('(interrompido — retome daqui)')
  })

  it('🗑 clears the plan and tells the next turn not to pick the abandoned steps up again', async () => {
    const provider = new ScriptedProvider([{ text: 'Ok, outra coisa.' }])
    const events: HarnessEvent[] = []
    const runner = makeRunner(provider, events, plan())
    runner.discardPlan()
    expect(runner.plan).toEqual([])
    expect(events.filter((event) => event.type === 'plan').at(-1)).toMatchObject({ items: [] })

    await runner.send('agora me explique o que é um índice')
    const sent = provider.requests[0].messages.map(text).join('\n')
    expect(sent).toContain('<plano-descartado>')
    expect(sent).toContain('- Migrar o banco')
    expect(sent).not.toContain('<retomada>')
    expect(sent).not.toContain('Plano atual (update_plan)')
  })

  it('refuses both while a turn is running', () => {
    const runner = makeRunner(new ScriptedProvider([]), [], plan())
    runner.busy = true
    expect(() => runner.resumePlanFrom('p2')).toThrow(/aguarde/)
    expect(() => runner.discardPlan()).toThrow(/aguarde/)
  })
})

interface FakeAi {
  available: true
  writes: string[]
  deletes: string[]
  recent: () => Promise<unknown[]>
  relatedMarkdown: () => Promise<string>
  writePage: (projectId: string, input: { path: string }) => Promise<{ path: string; pageId: string }>
  deletePage: (projectId: string, path: string) => Promise<boolean>
}

async function boot() {
  const events: HarnessEvent[] = []
  const orchestrator = new Orchestrator({ userData: dir, broadcast: (event) => events.push(event as HarnessEvent), log: () => undefined })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  const project = await orchestrator.store.addProject(projectDir, 'Plano')
  const meta = await orchestrator.store.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: 'ollama', model: 'qualquer', title: 'Migração do banco' })
  const ai: FakeAi = {
    available: true,
    writes: [],
    deletes: [],
    recent: async () => [],
    relatedMarkdown: async () => '',
    writePage: async (_projectId, input) => {
      ai.writes.push(input.path)
      return { path: input.path, pageId: input.path }
    },
    deletePage: async (_projectId, pagePath) => {
      ai.deletes.push(pagePath)
      return true
    }
  }
  const internals = orchestrator as unknown as {
    aiMemory: FakeAi
    runners: Map<string, unknown>
    captureTurnMemory: (id: string, runner: unknown, text: string) => Promise<void>
    memoryForProject: (id: string) => import('../src/core/memory/project').ProjectMemory
  }
  internals.aiMemory = ai
  const memory = internals.memoryForProject(project.id)
  const capsules = async (): Promise<string[]> =>
    (await memory.listPages()).filter((page) => page.tags.includes('estado') && page.context === `sessao:${meta.id}`).map((page) => page.slug)
  const turn = { messages: [{ id: 'u1', role: 'user', ts: 1, parts: [{ type: 'text', text: 'Migre o banco' }] }] as Message[], plan: plan(), state: 'done' }
  return { orchestrator, internals, meta, ai, memory, capsules, events, turn }
}

describe('the orchestrator', () => {
  it('🗑 on a session without a live runner clears the stored plan, the queue and the continuity capsule', async () => {
    const { orchestrator, internals, meta, ai, capsules, events, turn } = await boot()
    await internals.captureTurnMemory(meta.id, turn, 'Migre o banco')
    const [slug] = await capsules()
    expect(slug).toMatch(/^estado-/)
    const state = (await orchestrator.store.loadSession(meta.id))!
    await orchestrator.store.saveSession({ ...state, plan: plan() })
    orchestrator.inboxAdd(meta.id, 'depois rode o deploy', undefined, 'queue', 'ui')

    const result = await orchestrator.discardPlan(meta.id)

    expect(result.capsules).toBe(1)
    expect(await capsules()).toEqual([])
    expect(ai.deletes).toContain(`pages/${slug}.md`)
    expect(orchestrator.inboxList(meta.id)).toEqual([])
    const saved = (await orchestrator.store.loadSession(meta.id))!
    expect(saved.plan).toEqual([])
    expect(text(saved.messages.at(-1)!)).toContain('<plano-descartado>')
    expect(saved.messages.at(-1)!.hidden).toBe(true)
    expect(events.filter((event) => event.type === 'plan').at(-1)).toMatchObject({ items: [] })
  })

  it('🗑 while a turn runs stops it and removes the capsule the stopped turn writes on its way out', async () => {
    const { orchestrator, internals, meta, capsules, turn } = await boot()
    let discarded = false
    const runner = {
      busy: true,
      abort() {
        // The real turn ends a moment after the abort, then writes its memory (the capsule) like any other turn.
        setTimeout(() => {
          runner.busy = false
          void internals.captureTurnMemory(meta.id, turn, 'Migre o banco')
        }, 30)
      },
      discardPlan() {
        discarded = true
      }
    }
    internals.runners.set(meta.id, runner)

    await orchestrator.discardPlan(meta.id)

    expect(runner.busy).toBe(false)
    expect(discarded).toBe(true)
    expect(await capsules()).toEqual([])
  })

  it('▶ reopens the step and starts the turn that continues from it', async () => {
    const { orchestrator, internals, meta } = await boot()
    const sent: string[] = []
    const runner = {
      busy: false,
      messages: [{ id: 'u1', role: 'user', ts: 1, parts: [{ type: 'text', text: 'Migre o banco' }] }],
      plan: plan(),
      state: 'cancelled',
      resumePlanFrom: (itemId: string) => (itemId === 'p2' ? { ...plan()[1], interrupted: true } : null),
      send: async (value: string) => {
        sent.push(value)
      }
    }
    internals.runners.set(meta.id, runner)

    await orchestrator.resumePlan(meta.id, 'p2')
    expect(sent).toEqual(['Continue a partir do passo: Migrar o banco'])

    await expect(orchestrator.resumePlan(meta.id, 'p1')).rejects.toThrow(/não pode ser retomado/)
    runner.busy = true
    await expect(orchestrator.resumePlan(meta.id, 'p2')).rejects.toThrow(/ainda está trabalhando/)
  })
})
