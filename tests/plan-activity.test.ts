import { describe, expect, it } from 'vitest'
import { appendPlanActivity, planActivityEntry } from '../src/core/agent/plan-activity'
import type { PlanItem, ToolResult } from '../src/shared/types'

function result(text: string, ok = true, data?: Record<string, unknown>): ToolResult {
  return { ok, text, ...(data ? { data } : {}) }
}

describe('plan step activity', () => {
  it('records a command with its title, output and exit code', () => {
    const entry = planActivityEntry(
      'call_1',
      'run_command',
      { command: 'npm test', description: 'Rodar a suíte' },
      result('Tests 10 passed', true, { exitCode: 0 }),
      100,
      2400
    )
    expect(entry).toMatchObject({
      id: 'call_1',
      name: 'run_command',
      kind: 'command',
      title: 'Rodar a suíte',
      status: 'done',
      startedAt: 100,
      endedAt: 2400,
      exitCode: 0
    })
    expect(entry?.detail).toBe('npm test')
    expect(entry?.output).toContain('Tests 10 passed')
  })

  it('marks failures and falls back to the file path as the title', () => {
    const entry = planActivityEntry('call_2', 'read_file', { path: 'C:\\rea\\app.asar' }, result('ENOENT', false), 10, 20)
    expect(entry).toMatchObject({
      kind: 'tool',
      status: 'failed',
      title: 'C:\\rea\\app.asar',
      detail: 'C:\\rea\\app.asar'
    })
  })

  it('does not store plan bookkeeping or interaction tools', () => {
    for (const name of ['update_plan', 'report_limitation', 'ask_user', 'tool_search', 'tool_load', 'tool_list']) {
      expect(planActivityEntry('x', name, {}, result('ok'), 1, 2)).toBeNull()
    }
  })

  it('keeps only the tail of very large outputs', () => {
    const text = 'x'.repeat(5000) + 'FIM'
    const entry = planActivityEntry('call_3', 'run_command', { command: 'dir' }, result(text), 1, 2)
    expect(entry?.output?.length).toBe(1200)
    expect(entry?.output?.endsWith('FIM')).toBe(true)
  })

  it('appends to the active item only and caps the log', () => {
    const plan: PlanItem[] = [
      { id: 'done', text: 'feito', status: 'done' },
      { id: 'open', text: 'agora', status: 'active' }
    ]
    let next = plan
    for (let index = 0; index < 45; index++) {
      next = appendPlanActivity(next, {
        id: `c${index}`,
        name: 'read_file',
        kind: 'tool',
        title: `file ${index}`,
        status: 'done',
        startedAt: index,
        endedAt: index + 1
      })
    }
    expect(next[0].activity).toBeUndefined()
    expect(next[1].activity).toHaveLength(40)
    expect(next[1].activity?.[0].id).toBe('c5')

    const idle: PlanItem[] = [{ id: 'a', text: 'a', status: 'done' }]
    expect(appendPlanActivity(idle, next[1].activity![0])).toBe(idle)
  })
})
