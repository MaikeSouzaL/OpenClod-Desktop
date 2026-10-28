import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Scheduler,
  SchedulerValidationError,
  scheduledSession,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskRunHandler
} from '../src/core/scheduler/scheduler'
import { surfaceFor } from '../src/renderer/src/lib/scheduled-surface'
import { makeTempDir, removeTempDir } from './helpers'

// A scheduled task is Cowork work when it says so: its run opens a Cowork session (the surface with the folder guidance, listed on
// Início), not a Code one. Tasks saved before the field existed keep opening Code sessions.

describe('scheduled task surface', () => {
  let dir: string
  let file: string
  const clock = new Date(2026, 9, 27, 8, 0, 0)
  const created: Scheduler[] = []

  const make = (target = file): Scheduler => {
    const scheduler = new Scheduler(target, { now: () => new Date(clock.getTime()) })
    created.push(scheduler)
    return scheduler
  }

  const input = (over: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput => ({
    name: 'Resumo da pasta',
    prompt: 'Resuma os arquivos novos.',
    projectId: 'prj_1',
    cwd: dir,
    schedule: { kind: 'daily', time: '09:00' },
    ...over
  })

  const stored = (): ScheduledTask[] => JSON.parse(fs.readFileSync(file, 'utf8')).tasks

  beforeEach(async () => {
    dir = await makeTempDir('forja-sched-surface-')
    file = path.join(dir, 'tasks.json')
  })

  afterEach(async () => {
    for (const scheduler of created.splice(0)) scheduler.stop()
    await removeTempDir(dir)
  })

  it('stores the surface of a Cowork task and keeps it across a restart', async () => {
    const first = make()
    const task = await first.create(input({ surface: 'cowork' }))
    expect(task.surface).toBe('cowork')
    expect(stored()[0].surface).toBe('cowork')

    const again = make()
    await again.load()
    expect(again.get(task.id)?.surface).toBe('cowork')
  })

  it('leaves a task without a surface as it was (no field, Code session)', async () => {
    const scheduler = make()
    const task = await scheduler.create(input())
    expect(task.surface).toBeUndefined()
    expect('surface' in stored()[0]).toBe(false)
    expect(scheduledSession(task)).toEqual({ surface: 'code', mode: 'code' })
  })

  it('loads a task file written before the field existed', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [{ id: 'tsk_old', name: 'Antiga', prompt: 'x', projectId: 'prj_1', cwd: dir, schedule: { kind: 'daily', time: '09:00' }, enabled: true, createdAt: 1, updatedAt: 1 }]
      })
    )
    const scheduler = make()
    await scheduler.load()
    const task = scheduler.get('tsk_old')!
    expect(task.surface).toBeUndefined()
    expect(scheduledSession(task).surface).toBe('code')
  })

  it('opens a Cowork session in the autonomous mode the Cowork screen uses, unless the task names a mode', () => {
    expect(scheduledSession({ surface: 'cowork' })).toEqual({ surface: 'cowork', mode: 'autonomous' })
    expect(scheduledSession({ surface: 'cowork', mode: 'plan' })).toEqual({ surface: 'cowork', mode: 'plan' })
    expect(scheduledSession({ surface: 'code' })).toEqual({ surface: 'code', mode: 'code' })
    expect(scheduledSession({ surface: 'code', mode: 'review' })).toEqual({ surface: 'code', mode: 'review' })
  })

  it('refuses a surface that cannot be scheduled', async () => {
    const scheduler = make()
    await expect(scheduler.create(input({ surface: 'chat' as never }))).rejects.toThrow(SchedulerValidationError)
    await expect(scheduler.create(input({ surface: 'desktop' as never }))).rejects.toThrow('Tipo de sessão inválido')
  })

  it('changes the surface on update, and clears it with null', async () => {
    const scheduler = make()
    const task = await scheduler.create(input({ surface: 'code' }))

    const toCowork = await scheduler.update(task.id, { surface: 'cowork' })
    expect(toCowork.surface).toBe('cowork')
    expect(stored()[0].surface).toBe('cowork')

    // An update that does not mention it leaves it alone.
    expect((await scheduler.update(task.id, { name: 'Outro nome' })).surface).toBe('cowork')

    const cleared = await scheduler.update(task.id, { surface: null })
    expect(cleared.surface).toBeUndefined()
    expect('surface' in stored()[0]).toBe(false)
  })

  it('hands the task, with its surface, to the run handler (run now)', async () => {
    const scheduler = make()
    const task = await scheduler.create(input({ surface: 'cowork' }))
    const seen: ScheduledTask[] = []
    const handler: TaskRunHandler = async (item) => {
      seen.push(item)
      return { sessionId: 'ses_1' }
    }
    await scheduler.start(handler)
    const finished = await scheduler.runNow(task.id)
    expect(seen).toHaveLength(1)
    expect(scheduledSession(seen[0])).toEqual({ surface: 'cowork', mode: 'autonomous' })
    expect(finished.lastStatus).toBe('ok')
  })
})

describe('the type a task form starts with', () => {
  it('is Cowork for a blank new task', () => {
    expect(surfaceFor()).toBe('cowork')
  })

  it('keeps Code for a task saved before the type existed and for a template that does not say', () => {
    expect(surfaceFor({})).toBe('code')
    expect(surfaceFor({ surface: 'code' })).toBe('code')
  })

  it('follows the task or template when it says Cowork', () => {
    expect(surfaceFor({ surface: 'cowork' })).toBe('cowork')
  })
})
