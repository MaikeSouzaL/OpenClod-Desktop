import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { buildRegistry } from '../src/core/tools/registry'
import { updatePlanTool } from '../src/core/tools/plan'
import { DEFAULT_LIMITS, type HarnessEvent, type PlanItem } from '../src/shared/types'
import { ScriptedProvider } from './support/scripted-provider'
import { makeTempDir, policy, removeTempDir } from './helpers'

// A long Cowork job can reach the iteration cap. The turn then ends with a summary, and the plan the user is looking at must
// not keep showing a step "in progress" (a live spinner on work that stopped).

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('forja-plan-limit-')
})

afterEach(async () => {
  await removeTempDir(cwd)
})

function makeRunner(provider: ScriptedProvider, maxIterations: number): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_plan_limit',
    cwd,
    mode: 'autonomous',
    surface: 'cowork',
    provider,
    providerConfig: {
      id: 'mock',
      kind: 'openai',
      label: 'Scripted',
      baseUrl: 'http://localhost:0/v1',
      model: 'scripted',
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: true
    },
    registry: buildRegistry(updatePlanTool),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    retryBaseMs: 1
  }
  return { runner: new SessionRunner(deps), events }
}

const PLAN = [
  { text: 'Gerar a planilha', status: 'active' },
  { text: 'Gerar a apresentação', status: 'pending' }
]

describe('plan at the iteration limit', () => {
  it('shows the active step as blocked when the iteration budget ends the turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'p1', name: 'update_plan', args: { items: PLAN } }] },
      { text: 'Resumo: a planilha está em andamento; falta a apresentação.' }
    ])
    const { runner, events } = makeRunner(provider, 2)
    await runner.send('prepare os arquivos')

    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'length' })
    const statuses = runner.plan.map((item: PlanItem) => item.status)
    expect(statuses).toEqual(['blocked', 'pending'])
    // The UI is told, so the spinner stops on the screen as well as in the saved state.
    const last = [...events].reverse().find((event) => event.type === 'plan')
    expect(last && last.type === 'plan' ? last.items.map((item) => item.status) : []).toEqual(['blocked', 'pending'])
  })

  it('leaves a plan with no active step untouched', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'p1', name: 'update_plan', args: { items: [{ text: 'A', status: 'done' }, { text: 'B', status: 'pending' }] } }] },
      { text: 'Resumo.' }
    ])
    const { runner } = makeRunner(provider, 2)
    await runner.send('prepare os arquivos')
    expect(runner.plan.map((item: PlanItem) => item.status)).toEqual(['done', 'pending'])
  })
})
