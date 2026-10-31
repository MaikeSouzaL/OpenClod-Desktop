import { describe, expect, it } from 'vitest'
import {
  applyChecks,
  clampBudget,
  defineCriteria,
  failureSignature,
  gate,
  interrupted,
  isCodePath,
  LOOP_JUDGE_AGENT,
  noteCalls,
  phaseOfCall,
  recordVerdict,
  startLoop,
  timeUp
} from '../src/core/loop/engine'
import type { LoopState } from '../src/shared/types'

const T0 = 1_000_000
const budget = { rounds: 4, minutes: 30 }
const fresh = { defineNudges: 0, verdictNudges: 0 }

function defined(overrides: Partial<LoopState> = {}): LoopState {
  const state = defineCriteria(
    startLoop('faça os testes passarem', budget, T0),
    [
      { text: 'a suíte passa', check: 'npm test' },
      { text: 'a tela mostra o total' }
    ],
    { now: T0 }
  )
  return { ...state, ...overrides }
}

const withJudge = (state: LoopState): LoopState => noteCalls(state, [{ name: 'agent', args: { agent: LOOP_JUDGE_AGENT, prompt: 'julgue' } }])

describe('loop engine: start, criteria and budget', () => {
  it('starts a fresh loop in the definition phase with the budget', () => {
    const loop = startLoop('  corrija o bug  ', budget, T0)
    expect(loop).toMatchObject({ goal: 'corrija o bug', status: 'running', round: 1, maxRounds: 4, maxMinutes: 30, phase: 'definir', criteria: [] })
    expect(loop.deadlineAt).toBe(T0 + 30 * 60_000)
  })

  it('continues a loop that stopped with a fresh budget, and starts over after one that finished', () => {
    const stopped: LoopState = { ...defined(), round: 4, status: 'exhausted', endedAt: T0 + 5, reason: 'acabou', stagnantRounds: 2, strategyChanges: 1 }
    const resumed = startLoop('continue', budget, T0 + 100, stopped)
    expect(resumed).toMatchObject({ goal: 'faça os testes passarem', status: 'running', round: 5, maxRounds: 8, phase: 'fazer', stagnantRounds: 0, strategyChanges: 0 })
    expect(resumed.criteria).toHaveLength(2)
    expect(resumed.reason).toBeUndefined()
    expect(resumed.endedAt).toBeUndefined()

    const restarted = startLoop('outra tarefa', budget, T0 + 100, { ...stopped, status: 'done' })
    expect(restarted).toMatchObject({ goal: 'outra tarefa', round: 1, criteria: [] })
  })

  it('numbers the criteria, keeps the check command and takes a budget the user asked for within the ceilings', () => {
    const loop = defineCriteria(startLoop('x', budget, T0), [{ text: 'compila', check: '  npm run build ' }, { text: 'abre a tela', check: '   ' }], {
      now: T0,
      budget: { rounds: 99, minutes: 2 }
    })
    expect(loop.criteria).toEqual([
      { id: 'c1', text: 'compila', check: 'npm run build', status: 'pending' },
      { id: 'c2', text: 'abre a tela', status: 'pending' }
    ])
    expect(loop.maxRounds).toBe(30)
    expect(loop.maxMinutes).toBe(5)
    expect(clampBudget({ rounds: Number.NaN, minutes: 0 }, budget)).toEqual({ rounds: 4, minutes: 5 })
  })

  it('records check results with the tail of the output as proof', () => {
    const loop = applyChecks(defined(), [{ id: 'c1', ok: false, evidence: `${'x'.repeat(3_000)}\n1 failed` }], T0 + 1)
    expect(loop.phase).toBe('verificar')
    expect(loop.criteria[0]).toMatchObject({ status: 'failed', checkedAt: T0 + 1 })
    expect(loop.criteria[0].evidence?.endsWith('1 failed')).toBe(true)
    expect(loop.criteria[0].evidence!.length).toBeLessThanOrEqual(1_501)
    expect(loop.criteria[1].status).toBe('pending')
  })
})

describe('loop engine: the verdict', () => {
  it('refuses PRONTO without the judge in the round, with a failed check or without proof for a manual criterion', () => {
    const noJudge = recordVerdict(applyChecks(defined(), [{ id: 'c1', ok: true, evidence: 'ok' }], T0), { decision: 'done', summary: 'pronto', evidence: [{ id: 'c2', met: true, proof: 'print' }] }, T0)
    expect(noJudge.accepted).toBe(false)
    expect(noJudge.state.status).toBe('running')
    expect(noJudge.message).toContain(`${LOOP_JUDGE_AGENT}) não foi chamado`)
    expect(noJudge.state.verdicts.at(-1)?.decision).toBe('continue')

    const failed = recordVerdict(withJudge(applyChecks(defined(), [{ id: 'c1', ok: false, evidence: 'FAIL soma.test.js\n1 failed' }], T0)), { decision: 'done', summary: 'pronto', evidence: [{ id: 'c2', met: true, proof: 'print' }] }, T0)
    expect(failed.accepted).toBe(false)
    expect(failed.message).toContain('c1 falhou')
    expect(failed.message).toContain('npm test')

    const noProof = recordVerdict(withJudge(applyChecks(defined(), [{ id: 'c1', ok: true, evidence: 'ok' }], T0)), { decision: 'done', summary: 'pronto', evidence: [{ id: 'c2', met: true }] }, T0)
    expect(noProof.accepted).toBe(false)
    expect(noProof.message).toContain('c2 não provado')
  })

  it('accepts PRONTO with the judge, every check passing and a proof for every manual criterion', () => {
    const outcome = recordVerdict(
      withJudge(applyChecks(defined(), [{ id: 'c1', ok: true, evidence: '5 passed' }], T0)),
      { decision: 'done', summary: 'tudo provado', evidence: [{ id: 'c2', met: true, proof: 'snapshot mostra Total: 42' }] },
      T0 + 9
    )
    expect(outcome.accepted).toBe(true)
    expect(outcome.state).toMatchObject({ status: 'done', endedAt: T0 + 9, phase: 'julgar' })
    expect(outcome.state.criteria.map((c) => c.status)).toEqual(['met', 'met'])
    expect(outcome.state.criteria[1].evidence).toBe('snapshot mostra Total: 42')
    expect(gate(outcome.state, T0 + 10, fresh).gate).toEqual({ kind: 'end' })
  })

  it('refuses PRONTO after a code change until the tester took part in the loop, in any round', () => {
    const proven = withJudge(applyChecks(defined(), [{ id: 'c1', ok: true, evidence: '5 passed' }], T0))
    const input = { decision: 'done' as const, summary: 'pronto', evidence: [{ id: 'c2', met: true, proof: 'print' }], codeChanged: true }
    const untested = recordVerdict(proven, input, T0)
    expect(untested.accepted).toBe(false)
    expect(untested.message).toContain('o código mudou e o tester não foi chamado neste loop')

    // The tester wrote the tests in round 1; the judge says PRONTO in round 2.
    const round1 = noteCalls(defined(), [{ name: 'agent', args: { agent: 'tester' } }])
    const round2 = gate(recordVerdict(round1, { decision: 'continue', summary: 'falta' }, T0).state, T0, fresh).state
    expect(round2.roundAgents).toEqual([])
    expect(round2.agents).toEqual(['tester'])
    const tested = recordVerdict(withJudge(applyChecks(round2, [{ id: 'c1', ok: true, evidence: 'ok' }], T0)), input, T0)
    expect(tested.accepted).toBe(true)
    // Docs or data only: no tester needed.
    expect(recordVerdict(proven, { ...input, codeChanged: false }, T0).accepted).toBe(true)
  })

  it('tells source files from docs and data', () => {
    for (const file of ['src/a.ts', 'App.tsx', 'cli.js', 'x.mjs', 'main.py', 'lib.rs', 'run.ps1', 'Page.vue']) expect(isCodePath(file), file).toBe(true)
    for (const file of ['README.md', 'package.json', 'ok.txt', 'logo.svg', 'styles.css', 'data.csv']) expect(isCodePath(file), file).toBe(false)
  })

  it('stops for the user on BLOQUEADO and keeps the question as the reason', () => {
    const outcome = recordVerdict(defined(), { decision: 'blocked', summary: 'preciso da senha do banco', missing: ['Qual banco usar em teste?'] }, T0)
    expect(outcome.state).toMatchObject({ status: 'blocked', reason: 'preciso da senha do banco · Qual banco usar em teste?' })
    expect(gate(outcome.state, T0, fresh).gate.kind).toBe('end')
  })
})

describe('loop engine: the gate between rounds', () => {
  it('asks for the criteria once, then lets a message that is not a task end', () => {
    const loop = startLoop('oi', budget, T0)
    const first = gate(loop, T0, fresh)
    expect(first.gate).toMatchObject({ kind: 'nudge', reason: 'define' })
    const second = gate(loop, T0, { defineNudges: 1, verdictNudges: 0 })
    expect(second.gate).toEqual({ kind: 'end' })
    expect(second.state).toMatchObject({ status: 'blocked' })
  })

  it('asks for the verdict once, then counts the round as CONTINUAR', () => {
    const first = gate(defined(), T0, fresh)
    expect(first.gate).toMatchObject({ kind: 'nudge', reason: 'verdict' })
    if (first.gate.kind === 'nudge') expect(first.gate.prompt).toContain(LOOP_JUDGE_AGENT)
    const second = gate(defined(), T0 + 60_000, { defineNudges: 0, verdictNudges: 1 })
    expect(second.gate.kind).toBe('round')
    if (second.gate.kind === 'round') expect(second.gate.prompt).toContain('terminou sem veredito')
    expect(second.state).toMatchObject({ round: 2, roundAgents: [], phase: 'fazer' })
  })

  it('starts the next round with what is missing, the criteria and the time', () => {
    const judged = recordVerdict(applyChecks(defined(), [{ id: 'c1', ok: false, evidence: 'FAIL soma.test.js\nexpected 5, got 6' }], T0), {
      decision: 'continue',
      summary: 'a soma ainda erra',
      missing: ['corrigir soma()']
    }, T0)
    const { state, gate: step } = gate(judged.state, T0 + 3 * 60_000, fresh)
    expect(step.kind).toBe('round')
    if (step.kind !== 'round') return
    expect(step.prompt).toContain('<loop-volta n="2" de="4">')
    expect(step.prompt).toContain('O juiz deu CONTINUAR na volta 1: a soma ainda erra')
    expect(step.prompt).toContain('- corrigir soma()')
    expect(step.prompt).toContain('[!] c1 a suíte passa — check: `npm test`')
    expect(step.prompt).toContain('expected 5, got 6')
    expect(step.prompt).toContain('Tempo: 3 min de 30.')
    expect(state.round).toBe(2)
  })

  it('stops with a final answer when the rounds or the minutes run out', () => {
    const lastRound = recordVerdict({ ...defined(), round: 4 }, { decision: 'continue', summary: 'falta' }, T0).state
    const out = gate(lastRound, T0, fresh)
    expect(out.gate.kind).toBe('final')
    expect(out.state).toMatchObject({ status: 'exhausted', reason: 'as 4 voltas do orçamento acabaram' })
    if (out.gate.kind === 'final') expect(out.gate.prompt).toContain('Não chame mais ferramentas')

    const late = recordVerdict(defined(), { decision: 'continue', summary: 'falta' }, T0).state
    expect(gate(late, T0 + 31 * 60_000, fresh).state).toMatchObject({ status: 'exhausted', reason: 'os 30 minutos do orçamento acabaram' })
    expect(timeUp(defined(), T0 + 1)).toBeNull()
    expect(timeUp(defined(), T0 + 30 * 60_000)).toMatchObject({ status: 'exhausted' })
  })

  it('forces a change of strategy after the same failure in 3 rounds, and stops after 2 changes without progress', () => {
    let loop: LoopState = { ...defined(), maxRounds: 20 }
    const prompts: string[] = []
    let stoppedAt = 0
    for (let round = 1; round <= 10; round++) {
      // Every round ends with the same failure; only the duration printed by the runner changes.
      loop = applyChecks(loop, [{ id: 'c1', ok: false, evidence: `FAIL soma.test.js\nexpected 5, got 6 (${round * 13}ms)` }], T0)
      loop = recordVerdict(loop, { decision: 'continue', summary: 'mesma falha' }, T0).state
      const out = gate(loop, T0, fresh)
      loop = out.state
      if (out.gate.kind === 'final') {
        stoppedAt = round
        expect(out.gate.prompt).toContain('UMA pergunta objetiva')
        break
      }
      if (out.gate.kind === 'round') prompts.push(out.gate.prompt)
    }
    expect(prompts[0]).not.toContain('<mude-de-estrategia>')
    expect(prompts[1]).not.toContain('<mude-de-estrategia>')
    expect(prompts[2]).toContain('<mude-de-estrategia>')
    expect(prompts[2]).toContain('mudança de estratégia 1 de 2')
    expect(prompts[3]).toContain('mudança de estratégia 2 de 2')
    expect(stoppedAt).toBe(5)
    expect(loop).toMatchObject({ status: 'stalled' })
    expect(loop.reason).toContain('5 voltas seguidas')
  })

  it('does not count a new failure or progress as stagnation', () => {
    let loop: LoopState = { ...defined(), maxRounds: 20 }
    for (const evidence of ['erro A', 'erro B', 'erro C', 'erro D']) {
      loop = applyChecks(loop, [{ id: 'c1', ok: false, evidence }], T0)
      loop = recordVerdict(loop, { decision: 'continue', summary: 'falta' }, T0).state
      loop = gate(loop, T0, fresh).state
    }
    expect(loop).toMatchObject({ status: 'running', stagnantRounds: 1, strategyChanges: 0 })
  })

  it('reads a failure the same way when only numbers change', () => {
    const a = failureSignature(applyChecks(defined(), [{ id: 'c1', ok: false, evidence: 'Tests 1 failed (12ms)' }], T0))
    const b = failureSignature(applyChecks(defined(), [{ id: 'c1', ok: false, evidence: 'Tests 1 failed (873ms)' }], T0))
    const c = failureSignature(applyChecks(defined(), [{ id: 'c1', ok: false, evidence: 'SyntaxError in soma.js' }], T0))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('says why a turn left the loop running', () => {
    expect(interrupted(defined(), 'cancelled', undefined, T0)).toMatchObject({ status: 'cancelled', reason: 'parado pelo usuário' })
    expect(interrupted(defined(), 'error', 'HTTP 402', T0)).toMatchObject({ status: 'blocked', reason: 'o turno parou com erro: HTTP 402' })
    expect(interrupted(defined(), 'length', undefined, T0)).toMatchObject({ status: 'exhausted' })
    const done = { ...defined(), status: 'done' as const }
    expect(interrupted(done, 'error', 'x', T0)).toBe(done)
  })
})

describe('loop engine: phases', () => {
  it('maps each call to the phase of the cycle and remembers the agents of the round', () => {
    expect(phaseOfCall('agent', { agent: 'done-criteria' })).toBe('definir')
    expect(phaseOfCall('agent', { agent: 'coder' })).toBe('fazer')
    expect(phaseOfCall('agent', { agent: 'app-prover' })).toBe('verificar')
    expect(phaseOfCall('agent', { agent: 'loop-critic' })).toBe('criticar')
    expect(phaseOfCall('agent', { agent: LOOP_JUDGE_AGENT })).toBe('julgar')
    expect(phaseOfCall('agent', { agent: 'loop-memory' })).toBe('memoria')
    expect(phaseOfCall('loop', { action: 'check' })).toBe('verificar')
    expect(phaseOfCall('edit_file', {})).toBe('fazer')
    expect(phaseOfCall('read_file', {})).toBeNull()

    const loop = noteCalls(defined(), [
      { name: 'read_file', args: {} },
      { name: 'agent', args: { agent: 'coder' } },
      { name: 'agent', args: { agent: 'loop-critic' } }
    ])
    expect(loop).toMatchObject({ phase: 'criticar', roundAgents: ['coder', 'loop-critic'] })
    const same = defined()
    expect(noteCalls(same, [{ name: 'read_file', args: {} }])).toBe(same)
    // Closing the plan after PRONTO does not move a finished loop back to "planejar".
    const finished = { ...defined(), status: 'done' as const, phase: 'julgar' as const }
    expect(noteCalls(finished, [{ name: 'update_plan', args: {} }])).toBe(finished)
  })
})
