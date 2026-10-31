import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../src/core/agents/definitions'
import { toolsForMode, modeAllowsWrite } from '../src/core/security/permissions'
import { buildSystemPrompt } from '../src/core/agent/context'
import { describeLoop } from '../src/renderer/src/lib/loop-view'
import { AGENT_MODES, defaultAgentMode, type LoopState } from '../src/shared/types'
import { policy } from './helpers'

const byName = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, agent]))
const TEAM = ['loop-conductor', 'done-criteria', 'loop-judge', 'app-prover', 'loop-critic', 'loop-memory']

describe('Loop Engineering team', () => {
  it('has the six new agents next to the ones the loop reuses', () => {
    for (const name of [...TEAM, 'planner', 'strategist', 'explorer', 'researcher', 'agent-smith', 'coder', 'tester', 'verifier', 'reviewer', 'debugger', 'security-auditor', 'web-qa', 'mobile-qa', 'qa-lead']) {
      expect(byName.has(name), name).toBe(true)
    }
    for (const name of TEAM) {
      const agent = byName.get(name)!
      expect(agent.source).toBe('builtin')
      expect(agent.hidden).toBeFalsy()
      expect(agent.systemPrompt, name).toMatch(/language of the request/i)
    }
  })

  it('keeps the judge and the critic read-only and lets the judge prove things in the running app', () => {
    const writes = ['write_file', 'edit_file', 'patch_file', 'apply_patch', 'delete_path']
    for (const name of ['loop-judge', 'loop-critic', 'done-criteria', 'app-prover']) {
      const tools = byName.get(name)!.tools ?? []
      for (const tool of writes) expect(tools, `${name} ${tool}`).not.toContain(tool)
    }
    expect(byName.get('loop-judge')!.canCall).toEqual(['verifier', 'app-prover'])
    expect(byName.get('app-prover')!.tools).toEqual(expect.arrayContaining(['start_process', 'browser_snapshot', 'computer_snapshot']))
    expect(byName.get('loop-memory')!.tools).toEqual(expect.arrayContaining(['memory_page', 'memory_recall']))
    expect(byName.get('loop-conductor')!.canCall).toBe('*')
  })

  it('names only tools that exist in some mode', () => {
    const known = new Set(AGENT_MODES.flatMap((mode) => toolsForMode(mode)))
    for (const name of TEAM) {
      for (const tool of byName.get(name)!.tools ?? []) expect(known.has(tool), `${name}: ${tool}`).toBe(true)
    }
  })
})

describe('the loop mode', () => {
  it('is a mode of its own that writes and has every tool of code, computer use and web, plus the loop tool', () => {
    expect(AGENT_MODES).toContain('loop')
    expect(modeAllowsWrite('loop')).toBe(true)
    const loop = new Set(toolsForMode('loop'))
    for (const mode of ['code', 'computer', 'web', 'autonomous'] as const) {
      for (const tool of toolsForMode(mode)) expect(loop.has(tool), `${mode}: ${tool}`).toBe(true)
    }
    expect(loop.has('loop')).toBe(true)
    for (const mode of AGENT_MODES.filter((item) => item !== 'loop')) expect(toolsForMode(mode)).not.toContain('loop')
    // No surface opens in it by default: the user picks it in the composer.
    expect(['chat', 'cowork', 'code'].map((surface) => defaultAgentMode(surface as 'chat'))).not.toContain('loop')
  })

  it('tells the conductor the cycle, the judge and the stop rules', () => {
    const prompt = buildSystemPrompt({
      mode: 'loop',
      cwd: process.cwd(),
      policy: policy(),
      model: 'm',
      provider: 'p',
      skills: [],
      isGitRepo: false,
      teamMode: true
    })
    expect(prompt).toContain('MODO LOOP ENGINEERING')
    expect(prompt).toContain('loop action=define')
    expect(prompt).toContain('loop-judge')
    expect(prompt).toContain('done-criteria')
    expect(prompt).toContain('app-prover')
    expect(prompt).toContain('loop-critic')
    expect(prompt).toContain('loop-memory')
    // Tests that prove the work are written by the tester, not by whoever wrote the code.
    expect(prompt).toContain('chame o tester')
    expect(byName.get('loop-conductor')!.systemPrompt).toContain('have the tester write them')
  })
})

describe('the loop dock view', () => {
  const T0 = 1_700_000_000_000
  const loop: LoopState = {
    goal: 'x',
    status: 'running',
    round: 2,
    maxRounds: 8,
    startedAt: T0,
    maxMinutes: 90,
    deadlineAt: T0 + 90 * 60_000,
    phase: 'verificar',
    criteria: [
      { id: 'c1', text: 'testes passam', check: 'npm test', status: 'failed', evidence: '$ npm test\nexit=1\nFAIL soma.test.js\nTests 1 failed | 4 passed' },
      { id: 'c2', text: 'a tela mostra o total', status: 'met', evidence: 'print' }
    ],
    verdicts: [{ round: 1, decision: 'continue', summary: 'a soma erra', at: T0 }],
    roundAgents: ['coder', 'coder', 'app-prover'],
    stagnantRounds: 1,
    strategyChanges: 0
  }

  it('prints the round, the time, the criteria with the failing line and the last verdict', () => {
    const view = describeLoop(loop, T0 + 12 * 60_000 + 30_000)
    expect(view).toMatchObject({ status: 'Rodando', tone: 'running', round: 'Volta 2 de 8', time: '12 min de 90', phase: 'verificar', met: 1, total: 2 })
    expect(view.criteria[0]).toMatchObject({ mark: 'failed', check: 'npm test', proof: 'Tests 1 failed | 4 passed' })
    expect(view.criteria[1]).toMatchObject({ mark: 'met' })
    expect(view.criteria[1].check).toBeUndefined()
    expect(view.verdict).toBe('Juiz, volta 1: CONTINUAR — a soma erra')
    expect(view.agents).toEqual(['coder', 'app-prover'])
    expect(view.reason).toBeUndefined()
  })

  it('stops the clock and shows why the loop ended', () => {
    const view = describeLoop({ ...loop, status: 'exhausted', endedAt: T0 + 90 * 60_000, reason: 'os 90 minutos do orçamento acabaram' }, T0 + 200 * 60_000)
    expect(view).toMatchObject({ status: 'Orçamento esgotado', tone: 'warn', time: '90 min de 90', reason: 'os 90 minutos do orçamento acabaram' })
    expect(describeLoop({ ...loop, status: 'done', endedAt: T0 }, T0).tone).toBe('good')
    expect(describeLoop({ ...loop, status: 'stalled', endedAt: T0 }, T0).status).toBe('Estagnado')
  })
})
