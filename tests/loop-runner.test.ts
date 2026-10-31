import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps, type RunnerSnapshot } from '../src/core/agent/runner'
import { ScriptedProvider, type MockTurn } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { loopTool } from '../src/core/tools/loop'
import { agentTool } from '../src/core/tools/plan'
import { shellTools } from '../src/core/tools/shell'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { AgentRegistry } from '../src/core/agents/registry'
import { DEFAULT_LIMITS, type HarnessEvent, type LoopState } from '../src/shared/types'
import type { SubagentCaller } from '../src/core/agents/types'
import type { ToolDef } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('openclod-loop-')
})
afterEach(async () => {
  await removeTempDir(cwd)
})

/** Writes a real file in the project, like the real write tool. */
const writeTool: ToolDef = {
  name: 'write_file',
  description: 'fake write',
  schema: z.object({ path: z.string(), content: z.string() }),
  risk: 'write',
  parallelSafe: false,
  describe: (raw) => ({ title: 'Escrever', detail: String((raw as { path: string }).path) }),
  async execute(raw, ctx) {
    const args = raw as { path: string; content: string }
    const file = path.join(cwd, args.path)
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    fs.writeFileSync(file, args.content)
    ctx.tracker.recordChange(file, before, args.content)
    return { ok: true, text: `escrito ${args.path}`, summary: 'escrito' }
  }
}

interface Harness {
  runner: SessionRunner
  events: HarnessEvent[]
  snapshots: RunnerSnapshot[]
  callers: SubagentCaller[]
}

function harness(provider: ScriptedProvider, overrides: Partial<RunnerDeps> = {}): Harness {
  const events: HarnessEvent[] = []
  const snapshots: RunnerSnapshot[] = []
  const callers: SubagentCaller[] = []
  const runner = new SessionRunner({
    sessionId: 'ses_loop',
    cwd,
    mode: 'loop',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry: buildRegistry(loopTool, agentTool, writeTool, ...shellTools),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 20 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    agents: new AgentRegistry(),
    runSubagent: async (spec, caller) => {
      callers.push(caller)
      return { ok: true, text: spec.agent === 'loop-judge' ? 'PRONTO: c1 cumprido (exit 0).' : 'feito', sessionId: `sub_${callers.length}` }
    },
    emit: (event) => events.push(event),
    persist: (snapshot) => snapshots.push(structuredClone(snapshot)),
    approve: async () => true,
    selfReview: false,
    ...overrides
  })
  return { runner, events, snapshots, callers }
}

const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "process.exit(1)"'
const OK_FILE = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"`

const define = (id: string, check: string): MockTurn => ({
  toolCalls: [{ id, name: 'loop', args: { action: 'define', criteria: [{ text: 'o check do projeto passa', check }] } }]
})
const judge = (id: string): MockTurn => ({ toolCalls: [{ id, name: 'agent', args: { agent: 'loop-judge', prompt: 'julgue a entrega com as provas da volta' } }] })
const verdict = (id: string, decision: 'done' | 'continue' | 'blocked', summary = 'parecer'): MockTurn => ({
  toolCalls: [{ id, name: 'loop', args: { action: 'verdict', decision, summary } }]
})
const hiddenTexts = (provider: ScriptedProvider, index: number): string =>
  provider.requests[index].messages.flatMap((message) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))).join('\n')
const toolNames = (provider: ScriptedProvider, index: number): string[] => (provider.requests[index].tools ?? []).map((tool) => tool.name)

describe('Loop Engineering in the runner', () => {
  it('ends the turn only when the judge said PRONTO and the harness re-ran the check', async () => {
    const provider = new ScriptedProvider([define('d1', PASS), judge('j1'), verdict('v1', 'done', 'tudo provado'), { text: 'Pronto: o check passou.' }])
    const { runner, events, snapshots } = harness(provider)
    await runner.send('faça o check passar')

    expect(provider.requests).toHaveLength(4)
    expect(runner.loop).toMatchObject({ status: 'done', round: 1, reason: 'o juiz deu PRONTO e todos os critérios estão provados' })
    expect(runner.loop?.criteria[0]).toMatchObject({ status: 'met', check: PASS })
    expect(runner.loop?.criteria[0].evidence).toContain('exit=0')
    // The loop tool is sent in every request of a loop session; the user sees every change of the loop.
    expect(toolNames(provider, 0)).toContain('loop')
    const phases = events.flatMap((event) => (event.type === 'loop' ? [event.loop.phase] : []))
    expect(phases).toEqual(expect.arrayContaining(['definir', 'julgar']))
    expect(snapshots.at(-1)?.loop?.status).toBe('done')
    const end = events.find((event) => event.type === 'turn_end')
    expect(end).toMatchObject({ stopReason: 'stop' })
  })

  it('refuses PRONTO when the check fails and starts the next round with what is missing', async () => {
    const provider = new ScriptedProvider([
      define('d1', OK_FILE),
      judge('j1'),
      verdict('v1', 'done', 'acho que terminou'),
      { text: 'O harness recusou: falta o arquivo.' },
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'ok.txt', content: 'ok' } }] },
      judge('j2'),
      verdict('v2', 'done', 'agora o arquivo existe'),
      { text: 'Pronto na volta 2.' }
    ])
    const { runner, events } = harness(provider)
    await runner.send('crie o arquivo ok.txt')

    const refused = events.find((event) => event.type === 'tool_end' && event.toolCallId === 'v1')
    expect(refused).toMatchObject({ ok: false })
    expect(hiddenTexts(provider, 4)).toContain('<loop-volta n="2" de="8">')
    expect(hiddenTexts(provider, 4)).toContain('PRONTO recusado pelo harness')
    expect(runner.loop).toMatchObject({ status: 'done', round: 2 })
    expect(runner.loop?.verdicts.map((item) => item.decision)).toEqual(['continue', 'done'])
    expect(provider.requests).toHaveLength(8)
  })

  it('refuses PRONTO after a code change until the tester has tested it', async () => {
    const provider = new ScriptedProvider([
      define('d1', PASS),
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'soma.js', content: 'module.exports = (a, b) => a + b\n' } }] },
      judge('j1'),
      verdict('v1', 'done', 'corrigi a soma'),
      { text: 'Falta o tester.' },
      { toolCalls: [{ id: 't1', name: 'agent', args: { agent: 'tester', prompt: 'escreva e rode os testes da soma corrigida' } }] },
      judge('j2'),
      verdict('v2', 'done', 'testado pelo tester'),
      { text: 'Pronto.' }
    ])
    const { runner, events } = harness(provider)
    await runner.send('corrija a soma')

    const refused = events.find((event) => event.type === 'tool_end' && event.toolCallId === 'v1')
    expect(refused).toMatchObject({ ok: false })
    expect(hiddenTexts(provider, 5)).toContain('o código mudou e o tester não foi chamado neste loop')
    expect(runner.loop).toMatchObject({ status: 'done', round: 2 })
    expect(runner.loop?.agents).toEqual(expect.arrayContaining(['tester', 'loop-judge']))
  })

  it('stops when the rounds run out, with one last answer and no tools', async () => {
    const provider = new ScriptedProvider([
      define('d1', FAIL),
      verdict('v1', 'continue', 'falta'),
      { text: 'Volta 1 feita.' },
      verdict('v2', 'continue', 'ainda falta'),
      { text: 'Volta 2 feita.' },
      { text: 'Relatório: não terminou; mande continue para mais voltas.' }
    ])
    const { runner } = harness(provider, { loopBudget: { rounds: 2, minutes: 90 } })
    await runner.send('faça o impossível')

    expect(provider.requests).toHaveLength(6)
    expect(provider.requests[5].toolChoice).toBe('none')
    expect(hiddenTexts(provider, 5)).toContain('<loop-fim motivo="orçamento">')
    expect(runner.loop).toMatchObject({ status: 'exhausted', round: 2, reason: 'as 2 voltas do orçamento acabaram' })
  })

  it('gives every round the per-turn caps again', async () => {
    // 4 iterations per round, 6 model calls in the turn: without the reset the 4th call would be forced to answer without tools.
    const provider = new ScriptedProvider([
      define('d1', PASS),
      verdict('v1', 'continue', 'falta revisar'),
      { text: 'Volta 1.' },
      judge('j1'),
      verdict('v2', 'done', 'provado'),
      { text: 'Pronto.' }
    ])
    const { runner } = harness(provider, { limits: { ...DEFAULT_LIMITS, maxIterations: 4 } })
    await runner.send('tarefa')

    expect(provider.requests).toHaveLength(6)
    expect(provider.requests.slice(0, 5).every((request) => request.toolChoice !== 'none')).toBe(true)
    expect(runner.loop).toMatchObject({ status: 'done', round: 2 })
  })

  it('lets a message that is not a task end after one reminder', async () => {
    const provider = new ScriptedProvider([{ text: 'Olá! Qual é a tarefa?' }, { text: 'Foi só um cumprimento.' }])
    const { runner } = harness(provider)
    await runner.send('oi')
    expect(provider.requests).toHaveLength(2)
    expect(hiddenTexts(provider, 1)).toContain('<loop-definir>')
    expect(runner.loop).toMatchObject({ status: 'blocked' })
  })

  it('gives specialists every tool of the mode except the loop tool, and a fresh agent tree each round', async () => {
    const provider = new ScriptedProvider([
      define('d1', PASS),
      judge('j1'),
      verdict('v1', 'continue', 'falta'),
      { text: 'Volta 1.' },
      judge('j2'),
      verdict('v2', 'done', 'provado'),
      { text: 'Pronto.' }
    ])
    const { runner, callers } = harness(provider)
    await runner.send('tarefa')

    expect(callers).toHaveLength(2)
    // start_process is not sent to the conductor until it loads it, but a specialist may use it.
    expect(toolNames(provider, 0)).not.toContain('start_process')
    expect(callers[0].availableTools).toContain('start_process')
    expect(callers[0].availableTools).not.toContain('loop')
    expect(callers[0].signal).not.toBe(callers[1].signal)
    expect(runner.loop?.status).toBe('done')
  })

  it('continues a loop that stopped, with the same criteria and a fresh budget', async () => {
    const stopped: LoopState = {
      goal: 'crie ok.txt',
      status: 'exhausted',
      round: 3,
      maxRounds: 3,
      startedAt: Date.now() - 60_000,
      maxMinutes: 90,
      deadlineAt: Date.now() + 60_000,
      phase: 'julgar',
      criteria: [{ id: 'c1', text: 'o arquivo existe', check: OK_FILE, status: 'failed' }],
      verdicts: [],
      roundAgents: [],
      stagnantRounds: 0,
      strategyChanges: 0,
      reason: 'as 3 voltas do orçamento acabaram'
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'ok.txt', content: 'ok' } }] },
      judge('j1'),
      verdict('v1', 'done', 'existe'),
      { text: 'Pronto.' }
    ])
    const { runner } = harness(provider, { initial: { loop: stopped } })
    await runner.send('continue')
    expect(runner.loop).toMatchObject({ status: 'done', round: 4, maxRounds: 11, goal: 'crie ok.txt' })
  })

  it('records a cancelled turn on the loop', async () => {
    const provider = new ScriptedProvider([define('d1', PASS), { text: 'pensando devagar…'.repeat(20), delayMs: 30 }])
    const { runner } = harness(provider)
    const turn = runner.send('tarefa longa')
    setTimeout(() => runner.abort(), 150)
    await turn
    expect(runner.loop).toMatchObject({ status: 'cancelled', reason: 'parado pelo usuário' })
  })

  it('keeps the loop tool out of every other mode', async () => {
    const provider = new ScriptedProvider([{ toolCalls: [{ id: 'l1', name: 'loop', args: { action: 'status' } }] }, { text: 'ok' }])
    const { runner, events } = harness(provider, { mode: 'code' })
    await runner.send('use o loop')
    expect(toolNames(provider, 0)).not.toContain('loop')
    const end = events.find((event) => event.type === 'tool_end' && event.toolCallId === 'l1')
    expect(end).toMatchObject({ ok: false })
    expect(runner.loop).toBeNull()
  })
})
