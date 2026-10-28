import { describe, expect, it } from 'vitest'
import {
  clearFinished,
  childrenOf,
  commandTitle,
  elapsed,
  formatDuration,
  reconcileProcesses,
  reduceActivity,
  topLevel,
  type ActivityState
} from '../src/renderer/src/lib/activity'
import { buildAssistantBlocks, isEditCall, isPlanCall, previewEdit, summarizeCalls } from '../src/renderer/src/lib/groups'
import type { HarnessEvent, Message } from '../src/shared/types'

const S = 'ses'

function run(events: Array<[HarnessEvent, number]>): ActivityState {
  return events.reduce<ActivityState>((state, [event, at]) => reduceActivity(state, event, at), [])
}

describe('activity reducer', () => {
  it('tracks a command from start to end with duration, pid and exit code', () => {
    const state = run([
      [{ type: 'tool_start', sessionId: S, toolCallId: 'c1', name: 'run_command', args: { command: 'npx vitest run 2>&1 | tail -40' } }, 1000],
      [{ type: 'tool_end', sessionId: S, toolCallId: 'c1', name: 'run_command', ok: true, summary: 'ok', text: 'Tests 475 passed', data: { exitCode: 0, pid: 99 } }, 66_000]
    ])
    expect(state).toHaveLength(1)
    expect(state[0]).toMatchObject({ kind: 'command', status: 'done', title: 'npx vitest run 2>&1 | tail -40', exitCode: 0, pid: 99, output: 'Tests 475 passed' })
    expect(formatDuration(elapsed(state[0], 70_000))).toBe('1 min 05 s')
  })

  it('shows live output from a running command before it ends', () => {
    const state = run([
      [{ type: 'tool_start', sessionId: S, toolCallId: 'c1', name: 'run_command', args: { command: 'npm test' } }, 100],
      [{ type: 'tool_progress', sessionId: S, toolCallId: 'c1', name: 'run_command', text: 'RUN  v5.0.5\n...' }, 900]
    ])
    expect(state[0]).toMatchObject({ status: 'running', output: 'RUN  v5.0.5\n...' })
    expect(state[0].startedAt).toBe(100)
  })

  it('marks failures and keeps the first start time on duplicate starts', () => {
    const state = run([
      [{ type: 'tool_start', sessionId: S, toolCallId: 'c1', name: 'run_command', args: {} }, 100],
      [{ type: 'tool_start', sessionId: S, toolCallId: 'c1', name: 'run_command', args: { command: 'go test ./...' } }, 900],
      [{ type: 'tool_end', sessionId: S, toolCallId: 'c1', name: 'run_command', ok: false, summary: 'falhou', text: 'FAIL' }, 1500]
    ])
    expect(state[0]).toMatchObject({ status: 'failed', startedAt: 100, endedAt: 1500, title: 'go test ./...' })
  })

  it('prefers a description over the raw command as title and flags background runs', () => {
    expect(commandTitle('run_command', { command: 'npm run dev', description: 'Servidor de desenvolvimento' })).toEqual({ title: 'Servidor de desenvolvimento', detail: 'npm run dev' })
    const state = run([[{ type: 'tool_start', sessionId: S, toolCallId: 'p', name: 'start_process', args: { command: 'npm run dev' } }, 1]])
    expect(state[0].background).toBe(true)
  })

  it('builds the agent tree from subagent events and attributes child tools', () => {
    const base = { type: 'subagent' as const, sessionId: S }
    const state = run([
      [{ ...base, childId: 'a1', label: 'Mapear o código', state: 'thinking', agent: 'explorer', model: 'Sonnet 5.5', depth: 1, startedAt: 10, prompt: 'procure X' } as HarnessEvent, 10],
      [{ type: 'tool_start', sessionId: S, toolCallId: 't1', name: 'grep', args: { pattern: 'foo' }, agentId: 'a1' } as HarnessEvent, 20],
      [{ type: 'tool_end', sessionId: S, toolCallId: 't1', name: 'grep', ok: true, summary: '3', agentId: 'a1' } as HarnessEvent, 30],
      [{ ...base, childId: 'a2', label: 'Rodar testes', state: 'thinking', agent: 'tester', parentChildId: 'a1', depth: 2 } as HarnessEvent, 40],
      [{ ...base, childId: 'a2', label: 'Rodar testes', state: 'done', endedAt: 90, summary: 'tudo passou' } as HarnessEvent, 90],
      [{ ...base, childId: 'a1', label: 'Mapear o código', state: 'done', endedAt: 100, summary: 'achei 3' } as HarnessEvent, 100]
    ])
    expect(topLevel(state).map((entry) => entry.id)).toEqual(['a1'])
    expect(childrenOf(state, 'a1').map((entry) => entry.id)).toEqual(['t1', 'a2'])
    const a1 = state.find((entry) => entry.id === 'a1')!
    expect(a1).toMatchObject({ kind: 'agent', name: 'explorer', model: 'Sonnet 5.5', status: 'done', output: 'achei 3', startedAt: 10, endedAt: 100 })
    expect(state.find((entry) => entry.id === 'a2')).toMatchObject({ status: 'done', parentId: 'a1', output: 'tudo passou' })
  })

  it('ignores the call to an agent tool (the agent entry represents it) and shows errors as failed', () => {
    const state = run([
      [{ type: 'tool_start', sessionId: S, toolCallId: 'x', name: 'agent', args: { agent: 'coder' } }, 1],
      [{ type: 'subagent', sessionId: S, childId: 'a1', label: 'x', state: 'error' }, 5]
    ])
    expect(state.map((entry) => entry.id)).toEqual(['a1'])
    expect(state[0].status).toBe('failed')
  })

  it('closes running work when the turn ends or is cancelled, but not background processes', () => {
    const base = [
      [{ type: 'tool_start', sessionId: S, toolCallId: 'fg', name: 'run_command', args: { command: 'sleep 9' } }, 1],
      [{ type: 'tool_start', sessionId: S, toolCallId: 'bg', name: 'start_process', args: { command: 'npm run dev' } }, 2]
    ] as Array<[HarnessEvent, number]>
    const ended = run([...base, [{ type: 'turn_end', sessionId: S, messageId: 'm', stopReason: 'stop' }, 50]])
    expect(ended.find((e) => e.id === 'fg')).toMatchObject({ status: 'done', endedAt: 50 })
    expect(ended.find((e) => e.id === 'bg')?.status).toBe('running')
    const cancelled = run([...base, [{ type: 'status', sessionId: S, state: 'cancelled' }, 60]])
    expect(cancelled.find((e) => e.id === 'fg')).toMatchObject({ status: 'failed' })
    expect(run([...base, [{ type: 'status', sessionId: S, state: 'thinking' }, 60]]).find((e) => e.id === 'fg')?.status).toBe('running')
  })

  it('keeps a background service running after its call returns, until the process list says it exited', () => {
    const base: Array<[HarnessEvent, number]> = [
      [{ type: 'tool_start', sessionId: S, toolCallId: 'svc', name: 'start_process', args: { command: 'npm run dev' } }, 1000],
      [{ type: 'tool_end', sessionId: S, toolCallId: 'svc', name: 'start_process', ok: true, summary: 'iniciado', text: 'ready', data: { pid: 4242 } }, 2000]
    ]
    const state = run(base)
    expect(state[0]).toMatchObject({ status: 'running', pid: 4242, background: true })
    expect(state[0].endedAt).toBeUndefined()
    // a finished turn does not stop it either
    expect(run([...base, [{ type: 'turn_end', sessionId: S, messageId: 'm', stopReason: 'stop' }, 3000]])[0].status).toBe('running')

    expect(reconcileProcesses(state, [{ pid: 4242, exitCode: null }], 5000)).toBe(state)
    expect(reconcileProcesses(state, [{ pid: 4242, exitCode: 0 }], 5000)[0]).toMatchObject({ status: 'done', endedAt: 5000 })
    expect(reconcileProcesses(state, [{ pid: 4242, exitCode: 1 }], 5000)[0]).toMatchObject({ status: 'failed', exitCode: 1 })
    // a process the harness no longer lists is treated as finished
    expect(reconcileProcesses(state, [], 6000)[0].status).toBe('done')
  })

  it('a foreground command that exits is simply done', () => {
    const state = run([
      [{ type: 'tool_start', sessionId: S, toolCallId: 'fg', name: 'run_command', args: { command: 'echo' } }, 1],
      [{ type: 'tool_end', sessionId: S, toolCallId: 'fg', name: 'run_command', ok: true, summary: '', data: { pid: 7, exitCode: 0 } }, 2]
    ])
    expect(state[0]).toMatchObject({ status: 'done', background: false })
  })

  it('clears finished entries but keeps running ones and their parents', () => {
    const state = run([
      [{ type: 'subagent', sessionId: S, childId: 'a1', label: 'pai', state: 'done' }, 1],
      [{ type: 'subagent', sessionId: S, childId: 'a2', label: 'filho', state: 'thinking', parentChildId: 'a1' } as HarnessEvent, 2],
      [{ type: 'tool_start', sessionId: S, toolCallId: 'old', name: 'run_command', args: { command: 'x' } }, 3],
      [{ type: 'tool_end', sessionId: S, toolCallId: 'old', name: 'run_command', ok: true, summary: '' }, 4]
    ])
    expect(clearFinished(state).map((entry) => entry.id).sort()).toEqual(['a1', 'a2'])
  })

  it('formats durations the way the panel shows them', () => {
    expect(formatDuration(44_000)).toBe('44 s')
    expect(formatDuration(65_000)).toBe('1 min 05 s')
    expect(formatDuration(22 * 60_000 + 30_000)).toBe('22 min 30 s')
    expect(formatDuration(3_725_000)).toBe('1 h 02 min')
    expect(formatDuration(-5)).toBe('0 s')
  })
})

describe('tool call summaries', () => {
  it('summarizes by kind, in past and present tense', () => {
    expect(summarizeCalls(['run_command', 'run_command', 'run_command'], false)).toBe('Executou 3 comandos')
    expect(summarizeCalls(['run_command'], true)).toBe('Executando 1 comando')
    expect(summarizeCalls(['run_command', 'read_file', 'read_file', 'grep'], false)).toBe('Executou 1 comando, leu 2 arquivos e pesquisou 1 vez')
    expect(summarizeCalls(['browser_open', 'mcp__rea__x', 'mystery'], false)).toBe('Usou o navegador 1 vez, usou 1 ferramenta MCP e usou 1 ferramenta')
    expect(summarizeCalls([], false)).toBe('Sem ferramentas')
  })

  it('keeps plan calls and edits out of the summary line', () => {
    expect(isPlanCall('update_plan')).toBe(true)
    expect(isPlanCall('run_command')).toBe(false)
    expect(summarizeCalls(['run_command', 'read_file'], false)).toBe('Executou 1 comando e leu 1 arquivo')
    expect(summarizeCalls(['grep', 'run_command'], false)).toBe('Pesquisou 1 vez e executou 1 comando')
  })

  it('knows which calls get their own diff card', () => {
    expect(isEditCall('edit_file')).toBe(true)
    expect(isEditCall('write_file')).toBe(true)
    expect(isEditCall('delete_path')).toBe(false)
  })
})

function assistant(id: string, text: string, callIds: string[], extra: Partial<Message> = {}): Message {
  return {
    id,
    role: 'assistant',
    ts: 1,
    parts: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...callIds.map((callId) => ({ type: 'tool_call' as const, id: callId, name: 'run_command', args: {} }))
    ],
    ...extra
  }
}
const toolMsg = (id: string, callId: string): Message => ({ id, role: 'tool', ts: 1, parts: [{ type: 'tool_result', toolCallId: callId, name: 'run_command', ok: true, text: 'x' }] })
const userMsg: Message = { id: 'u', role: 'user', ts: 0, parts: [{ type: 'text', text: 'faça' }] }

describe('assistant blocks', () => {
  it('merges consecutive tool-only iterations into the block before them', () => {
    const blocks = buildAssistantBlocks([
      userMsg,
      assistant('a1', 'Vou olhar', ['c1']),
      toolMsg('t1', 'c1'),
      assistant('a2', '', ['c2', 'c3']),
      toolMsg('t2', 'c2'),
      assistant('a3', '', ['c4']),
      assistant('a4', 'Pronto, terminei.', [])
    ])
    expect(blocks).toHaveLength(3)
    const [, first, last] = blocks as Array<{ message: Message; text: string; calls: Array<{ id: string }> }>
    expect(first.calls.map((call) => call.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(last.text).toBe('Pronto, terminei.')
  })

  it('starts a new block when narration appears or an error interrupts', () => {
    const blocks = buildAssistantBlocks([assistant('a1', '', ['c1']), assistant('a2', 'Agora a segunda parte', ['c2']), assistant('a3', '', ['c3'], { error: 'falhou' })])
    expect(blocks).toHaveLength(3)
  })

  it('keeps a harness limitation card as its own block', () => {
    const limitation: Message = {
      id: 'lim',
      role: 'assistant',
      ts: 2,
      parts: [
        {
          type: 'limitation',
          report: {
            title: 'Turno interrompido',
            goal: 'continuar a tarefa',
            error: 'HTTP 400',
            difficulty: 'o provedor recusou a requisição',
            suggestion: 'remover mensagens vazias',
            severity: 'blocked',
            automatic: true
          }
        }
      ]
    }
    const blocks = buildAssistantBlocks([assistant('a1', 'trabalhando', []), limitation])
    expect(blocks).toHaveLength(2)
    const last = blocks[1] as { limitations: Array<{ report: { title: string } }> }
    expect(last.limitations[0].report.title).toBe('Turno interrompido')
  })

  it('folds the reasoning of merged tool iterations into the block', () => {
    const thinking = (id: string, callId: string, text: string): Message => ({
      id,
      role: 'assistant',
      ts: 1,
      parts: [
        { type: 'reasoning', text },
        { type: 'tool_call', id: callId, name: 'run_command', args: {} }
      ]
    })
    const blocks = buildAssistantBlocks([
      userMsg,
      thinking('a1', 'c1', 'primeiro eu listo os arquivos'),
      toolMsg('t1', 'c1'),
      thinking('a2', 'c2', 'agora leio o arquivo principal'),
      toolMsg('t2', 'c2'),
      assistant('a3', 'Terminei.', [])
    ])
    const [, work, final] = blocks as Array<{ reasoning: string; calls: Array<{ id: string }> }>
    expect(work.calls.map((call) => call.id)).toEqual(['c1', 'c2'])
    expect(work.reasoning).toBe('primeiro eu listo os arquivos\n\nagora leio o arquivo principal')
    expect(final.reasoning).toBe('')
  })
})

describe('edit previews', () => {
  it('shows only the changed lines of an edit_file call, with a few context lines', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n')
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n')
    const preview = previewEdit('edit_file', { path: 'src/x.ts', old_string: before, new_string: after })!
    expect(preview).toMatchObject({ path: 'src/x.ts', additions: 1, deletions: 1 })
    expect(preview.lines.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual(['E'])
    expect(preview.lines.filter((line) => line.kind === 'del').map((line) => line.text)).toEqual(['e'])
  })

  it('shows a new file as additions only', () => {
    const preview = previewEdit('write_file', { path: 'a.txt', content: 'um\ndois\ntrês\n' })!
    expect(preview).toMatchObject({ additions: 3, deletions: 0, truncated: false })
    expect(preview.lines.every((line) => line.kind === 'add')).toBe(true)
  })

  it('truncates huge diffs and rejects malformed calls', () => {
    const big = previewEdit('write_file', { path: 'big.txt', content: Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') })!
    expect(big.truncated).toBe(true)
    expect(big.lines).toHaveLength(400)
    expect(big.additions).toBe(1000)
    expect(previewEdit('edit_file', { path: 'a', old_string: 1 })).toBeNull()
    expect(previewEdit('write_file', {})).toBeNull()
    expect(previewEdit('read_file', { path: 'a' })).toBeNull()
  })
})

describe('background service reported by the shell tool', () => {
  it('start_process returns exitCode null while alive and the panel keeps it running', () => {
    const state = [
      [{ type: 'tool_start', sessionId: 'ses', toolCallId: 'svc', name: 'start_process', args: { command: 'npm run dev' } }, 1],
      [{ type: 'tool_end', sessionId: 'ses', toolCallId: 'svc', name: 'start_process', ok: true, summary: 'pid 9 (ativo)', data: { pid: 9, exitCode: null, command: 'npm run dev' } }, 2]
    ].reduce<ActivityState>((acc, [event, at]) => reduceActivity(acc, event as HarnessEvent, at as number), [])
    expect(state[0]).toMatchObject({ status: 'running', pid: 9 })
  })
})
