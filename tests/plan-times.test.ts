import { describe, expect, it } from 'vitest'
import { mergePlanTimes } from '../src/core/agent/plan-times'
import type { PlanItem } from '../src/shared/types'

function item(
  id: string,
  status: PlanItem['status'],
  extra: Partial<PlanItem> = {}
): PlanItem {
  return { id, text: id, status, ...extra }
}

describe('plan timestamps', () => {
  it('stamps when an item starts and when it finishes', () => {
    let plan = mergePlanTimes([], [item('a', 'pending'), item('b', 'pending')], 1000)
    expect(plan[0].startedAt).toBeUndefined()

    plan = mergePlanTimes(plan, [item('a', 'active'), item('b', 'pending')], 2000)
    expect(plan[0]).toMatchObject({ startedAt: 2000 })
    expect(plan[0].endedAt).toBeUndefined()

    plan = mergePlanTimes(plan, [item('a', 'done'), item('b', 'active')], 5000)
    expect(plan[0]).toMatchObject({ startedAt: 2000, endedAt: 5000 })
    expect(plan[1].startedAt).toBe(5000)
  })

  it('keeps the times when the same status is rewritten', () => {
    const first = mergePlanTimes([], [item('a', 'active')], 1000)
    const second = mergePlanTimes(first, [item('a', 'active')], 3000)
    expect(second[0].startedAt).toBe(1000)

    const done = mergePlanTimes(second, [item('a', 'done')], 4000)
    const again = mergePlanTimes(done, [item('a', 'done')], 9000)
    expect(again[0]).toMatchObject({ startedAt: 1000, endedAt: 4000 })
  })

  it('restarts the clock when an item is reopened', () => {
    const done = mergePlanTimes([], [item('a', 'done', { startedAt: 1000, endedAt: 2000 })], 3000)
    const reopened = mergePlanTimes(done, [item('a', 'active')], 4000)
    expect(reopened[0]).toMatchObject({ startedAt: 4000 })
    expect(reopened[0].endedAt).toBeUndefined()
  })

  it('clears the interrupted marker and restarts the clock when the agent resumes', () => {
    const stale: PlanItem[] = [
      item('a', 'active', { startedAt: 1000, endedAt: 2000, interrupted: true })
    ]
    const resumed = mergePlanTimes(stale, [item('a', 'active')], 5000)
    expect(resumed[0]).toMatchObject({ startedAt: 5000 })
    expect(resumed[0].endedAt).toBeUndefined()
    expect(resumed[0].interrupted).toBeUndefined()
  })

  it('keeps the saved per-step activity when the model rewrites the plan', () => {
    const previous: PlanItem[] = [
      item('a', 'done', {
        startedAt: 1000,
        endedAt: 3000,
        activity: [
          {
            id: 'call_1',
            name: 'run_command',
            kind: 'command',
            title: 'npm test',
            status: 'done',
            startedAt: 1200,
            endedAt: 2800,
            output: 'ok'
          }
        ]
      })
    ]
    const rewritten = mergePlanTimes(previous, [item('a', 'done'), item('b', 'pending')], 4000)
    expect(rewritten[0].activity).toHaveLength(1)
    expect(rewritten[0].activity?.[0]).toMatchObject({ title: 'npm test', output: 'ok' })
    expect(rewritten[1].activity).toBeUndefined()
  })

  it('drops stale item ids that the model removed from the plan', () => {
    const plan = mergePlanTimes([], [item('a', 'active'), item('b', 'pending')], 1000)
    const next = mergePlanTimes(plan, [item('a', 'active')], 2000)
    expect(next.map((row) => row.id)).toEqual(['a'])
    expect(next[0].startedAt).toBe(1000)
  })
})
