import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextRun } from '../src/core/scheduler/schedule'
import {
  NAME_MAX,
  PROMPT_MAX,
  Scheduler,
  SchedulerValidationError,
  type ScheduledTask,
  type ScheduledTaskInput,
  type Schedule,
  type TaskRunHandler
} from '../src/core/scheduler/scheduler'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * Wall-clock rules depend on the local zone, so the suite pins one: Sao Paulo
 * has had no DST since 2019, which keeps ordinary dates predictable. The DST
 * block switches to New York on purpose and switches back afterwards.
 */
const PLAIN_ZONE = 'America/Sao_Paulo'
const originalTz = process.env.TZ

beforeAll(() => {
  process.env.TZ = PLAIN_ZONE
})
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

/** Local date-time; month is 1-based. */
function d(y: number, mo: number, day: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  return new Date(y, mo - 1, day, h, mi, s, ms)
}

/** "2025-01-06 09:00" in local time, for readable assertions. */
function fmt(date: Date | null | number | undefined): string | null {
  if (date === null || date === undefined) return null
  const x = new Date(date)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`
}

/* ------------------------------------------------------------------------- */

describe('nextRun', () => {
  describe('hourly', () => {
    const s = (minute: number): Schedule => ({ kind: 'hourly', minute })

    it('fires later in the current hour when the minute has not passed', () => {
      expect(fmt(nextRun(s(30), d(2025, 1, 6, 10, 20)))).toBe('2025-01-06 10:30')
      expect(fmt(nextRun(s(30), d(2025, 1, 6, 10, 29, 59, 999)))).toBe('2025-01-06 10:30')
    })

    it('is strictly after `from`: the exact slot moves on to the next hour', () => {
      expect(fmt(nextRun(s(30), d(2025, 1, 6, 10, 30)))).toBe('2025-01-06 11:30')
      expect(fmt(nextRun(s(30), d(2025, 1, 6, 10, 30, 0, 1)))).toBe('2025-01-06 11:30')
      expect(fmt(nextRun(s(30), d(2025, 1, 6, 10, 45)))).toBe('2025-01-06 11:30')
    })

    it('handles minute 0', () => {
      expect(fmt(nextRun(s(0), d(2025, 1, 6, 9, 59, 59)))).toBe('2025-01-06 10:00')
      expect(fmt(nextRun(s(0), d(2025, 1, 6, 10, 0)))).toBe('2025-01-06 11:00')
    })

    it('rolls over day, month and year', () => {
      expect(fmt(nextRun(s(15), d(2025, 1, 6, 23, 45)))).toBe('2025-01-07 00:15')
      expect(fmt(nextRun(s(15), d(2025, 1, 31, 23, 45)))).toBe('2025-02-01 00:15')
      expect(fmt(nextRun(s(0), d(2024, 12, 31, 23, 50)))).toBe('2025-01-01 00:00')
    })

    it('returns seconds and milliseconds as zero', () => {
      const next = nextRun(s(30), d(2025, 1, 6, 10, 20, 17, 345))!
      expect([next.getSeconds(), next.getMilliseconds()]).toEqual([0, 0])
    })
  })

  describe('daily', () => {
    const s = (time: string): Schedule => ({ kind: 'daily', time })

    it('fires today when the time is still ahead, tomorrow otherwise', () => {
      expect(fmt(nextRun(s('09:00'), d(2025, 1, 6, 8, 0)))).toBe('2025-01-06 09:00')
      expect(fmt(nextRun(s('09:00'), d(2025, 1, 6, 9, 0)))).toBe('2025-01-07 09:00')
      expect(fmt(nextRun(s('09:00'), d(2025, 1, 6, 9, 0, 1)))).toBe('2025-01-07 09:00')
      expect(fmt(nextRun(s('09:00'), d(2025, 1, 6, 23, 59)))).toBe('2025-01-07 09:00')
    })

    it('handles midnight and the last minute of the day', () => {
      expect(fmt(nextRun(s('00:00'), d(2025, 1, 6, 23, 59)))).toBe('2025-01-07 00:00')
      expect(fmt(nextRun(s('23:59'), d(2025, 1, 6, 23, 58)))).toBe('2025-01-06 23:59')
    })

    it('rolls over month, year and leap days', () => {
      expect(fmt(nextRun(s('09:00'), d(2025, 1, 31, 10, 0)))).toBe('2025-02-01 09:00')
      expect(fmt(nextRun(s('09:00'), d(2024, 12, 31, 10, 0)))).toBe('2025-01-01 09:00')
      expect(fmt(nextRun(s('09:00'), d(2024, 2, 28, 10, 0)))).toBe('2024-02-29 09:00')
      expect(fmt(nextRun(s('09:00'), d(2024, 2, 29, 10, 0)))).toBe('2024-03-01 09:00')
      expect(fmt(nextRun(s('09:00'), d(2025, 2, 28, 10, 0)))).toBe('2025-03-01 09:00')
    })
  })

  describe('weekdays (Monday to Friday)', () => {
    const s: Schedule = { kind: 'weekdays', time: '09:00' }

    it('fires the same day on a weekday before the time', () => {
      expect(fmt(nextRun(s, d(2025, 1, 6, 8, 0)))).toBe('2025-01-06 09:00') // Monday
    })

    it('moves to the next weekday after the time', () => {
      expect(fmt(nextRun(s, d(2025, 1, 6, 9, 0)))).toBe('2025-01-07 09:00')
      expect(fmt(nextRun(s, d(2025, 1, 9, 10, 0)))).toBe('2025-01-10 09:00') // Thu -> Fri
    })

    it('skips Saturday and Sunday', () => {
      expect(fmt(nextRun(s, d(2025, 1, 10, 10, 0)))).toBe('2025-01-13 09:00') // Fri after time
      expect(fmt(nextRun(s, d(2025, 1, 11, 8, 0)))).toBe('2025-01-13 09:00') // Saturday
      expect(fmt(nextRun(s, d(2025, 1, 12, 23, 0)))).toBe('2025-01-13 09:00') // Sunday
    })

    it('skips the weekend across a month boundary', () => {
      expect(fmt(nextRun(s, d(2025, 1, 31, 10, 0)))).toBe('2025-02-03 09:00') // Fri -> Mon
    })

    it('never returns a Saturday or Sunday over a whole year', () => {
      let from = d(2025, 1, 1, 0, 0)
      for (let i = 0; i < 400; i++) {
        const next = nextRun(s, from)!
        expect([0, 6]).not.toContain(next.getDay())
        expect(next.getTime()).toBeGreaterThan(from.getTime())
        from = next
      }
    })
  })

  describe('weekly', () => {
    const s = (day: number, time = '09:00'): Schedule => ({ kind: 'weekly', day, time })

    it('fires the same day when it is the right weekday and the time is ahead', () => {
      expect(fmt(nextRun(s(3), d(2025, 1, 8, 8, 0)))).toBe('2025-01-08 09:00') // Wednesday
    })

    it('waits a full week when the slot has just passed', () => {
      expect(fmt(nextRun(s(3), d(2025, 1, 8, 9, 0)))).toBe('2025-01-15 09:00')
      expect(fmt(nextRun(s(3), d(2025, 1, 8, 9, 0, 1)))).toBe('2025-01-15 09:00')
    })

    it('finds the next occurrence of the weekday', () => {
      expect(fmt(nextRun(s(3), d(2025, 1, 7, 12, 0)))).toBe('2025-01-08 09:00') // Tue -> Wed
      expect(fmt(nextRun(s(3), d(2025, 1, 9, 12, 0)))).toBe('2025-01-15 09:00') // Thu -> next Wed
    })

    it('treats 0 as Sunday and 6 as Saturday', () => {
      expect(fmt(nextRun(s(0), d(2025, 1, 5, 10, 0)))).toBe('2025-01-12 09:00') // Sunday after time
      expect(fmt(nextRun(s(0), d(2025, 1, 11, 10, 0)))).toBe('2025-01-12 09:00') // Saturday
      expect(fmt(nextRun(s(6), d(2025, 1, 31, 10, 0)))).toBe('2025-02-01 09:00') // Fri -> Sat, next month
    })

    it('covers every weekday from every weekday', () => {
      for (let day = 0; day <= 6; day++) {
        for (let from = 0; from < 7; from++) {
          const start = d(2025, 1, 5 + from, 12, 0) // 2025-01-05 is a Sunday
          const next = nextRun(s(day), start)!
          expect(next.getDay()).toBe(day)
          const days = Math.round((next.getTime() - start.getTime()) / 86_400_000)
          expect(days).toBeGreaterThanOrEqual(0)
          expect(days).toBeLessThanOrEqual(7)
        }
      }
    })
  })

  describe('once', () => {
    it('returns the date while it is in the future', () => {
      const at = d(2030, 5, 1, 14, 30)
      const next = nextRun({ kind: 'once', at: at.toISOString() }, d(2030, 5, 1, 14, 29, 59))
      expect(next?.getTime()).toBe(at.getTime())
    })

    it('returns null once it has passed (the exact instant counts as passed)', () => {
      const at = d(2030, 5, 1, 14, 30)
      expect(nextRun({ kind: 'once', at: at.toISOString() }, at)).toBeNull()
      expect(nextRun({ kind: 'once', at: at.toISOString() }, d(2030, 5, 2))).toBeNull()
    })

    it('reads a time without offset as local time and one with Z as UTC', () => {
      const local = nextRun({ kind: 'once', at: '2030-05-01T14:30' }, d(2030, 1, 1))!
      expect(fmt(local)).toBe('2030-05-01 14:30')
      const utc = nextRun({ kind: 'once', at: '2030-05-01T14:30:00Z' }, d(2030, 1, 1))!
      expect(utc.toISOString()).toBe('2030-05-01T14:30:00.000Z')
    })

    it('returns null for an unparsable date', () => {
      expect(nextRun({ kind: 'once', at: 'not a date' }, d(2030, 1, 1))).toBeNull()
    })
  })

  it('returns null for invalid schedules instead of throwing', () => {
    const from = d(2025, 1, 6, 8, 0)
    expect(nextRun({ kind: 'daily', time: '25:00' }, from)).toBeNull()
    expect(nextRun({ kind: 'weekly', day: 9, time: '09:00' }, from)).toBeNull()
    expect(nextRun({ kind: 'hourly', minute: 75 }, from)).toBeNull()
    expect(nextRun({ kind: 'daily', time: '09:00' }, new Date(NaN))).toBeNull()
  })

  describe('daylight saving time (America/New_York)', () => {
    beforeAll(() => {
      process.env.TZ = 'America/New_York'
    })
    afterAll(() => {
      process.env.TZ = PLAIN_ZONE
    })

    it('uses a calendar day, not 24 hours: the day has 23 h in spring and 25 h in autumn', () => {
      const noon = { kind: 'daily', time: '12:00' } as const
      const spring = nextRun(noon, d(2024, 3, 9, 12, 0))!
      expect(fmt(spring)).toBe('2024-03-10 12:00')
      expect((spring.getTime() - d(2024, 3, 9, 12, 0).getTime()) / 3_600_000).toBe(23)

      const autumn = nextRun(noon, d(2024, 11, 2, 12, 0))!
      expect(fmt(autumn)).toBe('2024-11-03 12:00')
      expect((autumn.getTime() - d(2024, 11, 2, 12, 0).getTime()) / 3_600_000).toBe(25)
    })

    it('fires a time that does not exist (02:30 on spring-forward day) once, at 03:30', () => {
      const s = { kind: 'daily', time: '02:30' } as const
      const first = nextRun(s, d(2024, 3, 9, 12, 0))!
      expect(fmt(first)).toBe('2024-03-10 03:30')
      // And it does not fire a second time the same day.
      expect(fmt(nextRun(s, first))).toBe('2024-03-11 02:30')
    })

    it('fires a repeated time (01:30 on fall-back day) only at its first occurrence', () => {
      const s = { kind: 'daily', time: '01:30' } as const
      const first = nextRun(s, d(2024, 11, 2, 12, 0))!
      expect(fmt(first)).toBe('2024-11-03 01:30')
      expect(first.getTimezoneOffset()).toBe(240) // still EDT
      const second = nextRun(s, first)!
      expect(fmt(second)).toBe('2024-11-04 01:30')
      expect((second.getTime() - first.getTime()) / 3_600_000).toBe(25)
    })

    it('does not skip or duplicate the day when running at the repeated hour itself', () => {
      const s = { kind: 'daily', time: '01:30' } as const
      // 01:45 EST, i.e. the second pass through the 01:xx hour.
      const secondPass = new Date(d(2024, 11, 3, 1, 30).getTime() + 3_600_000 + 15 * 60_000)
      expect(fmt(secondPass)).toBe('2024-11-03 01:45')
      expect(fmt(nextRun(s, secondPass))).toBe('2024-11-04 01:30')
    })

    it('hourly: skips the missing hour on spring-forward day', () => {
      const s = { kind: 'hourly', minute: 30 } as const
      const a = nextRun(s, d(2024, 3, 10, 1, 45))!
      expect(fmt(a)).toBe('2024-03-10 03:30')
      expect(fmt(nextRun(s, a))).toBe('2024-03-10 04:30')
    })

    it('hourly: fires in both copies of the repeated hour on fall-back day', () => {
      const s = { kind: 'hourly', minute: 30 } as const
      const a = nextRun(s, d(2024, 11, 3, 0, 45))!
      const b = nextRun(s, a)!
      const c = nextRun(s, b)!
      expect([fmt(a), fmt(b), fmt(c)]).toEqual(['2024-11-03 01:30', '2024-11-03 01:30', '2024-11-03 02:30'])
      expect([a.getTimezoneOffset(), b.getTimezoneOffset(), c.getTimezoneOffset()]).toEqual([240, 300, 300])
      expect(b.getTime() - a.getTime()).toBe(3_600_000)
    })

    it('weekdays and weekly keep their wall-clock time across the change', () => {
      const weekdays = nextRun({ kind: 'weekdays', time: '09:00' }, d(2024, 3, 8, 10, 0))! // Fri
      expect(fmt(weekdays)).toBe('2024-03-11 09:00') // Monday, after the change
      const weekly = nextRun({ kind: 'weekly', day: 0, time: '02:30' }, d(2024, 3, 9, 12, 0))!
      expect(fmt(weekly)).toBe('2024-03-10 03:30')
    })
  })
})

/* ------------------------------------------------------------------------- */

describe('Scheduler', () => {
  let dir: string
  let file: string
  let clock: Date
  const created: Scheduler[] = []

  const now = (): Date => new Date(clock.getTime())

  function make(options: { tickMs?: number; catchUpMissed?: boolean; maxConcurrent?: number } = {}, target = file): Scheduler {
    const scheduler = new Scheduler(target, { now, ...options })
    created.push(scheduler)
    return scheduler
  }

  function input(over: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput {
    return {
      name: 'Resumo diário',
      prompt: 'Resuma o que mudou ontem.',
      projectId: 'prj_1',
      cwd: dir,
      schedule: { kind: 'daily', time: '09:00' },
      ...over
    }
  }

  function recorder(): { calls: ScheduledTask[]; handler: TaskRunHandler } {
    const calls: ScheduledTask[] = []
    const handler: TaskRunHandler = async (task) => {
      calls.push(task)
      return { sessionId: `ses_${calls.length}` }
    }
    return { calls, handler }
  }

  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
    let resolve!: () => void
    let reject!: (e: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const readFile = (): { version: number; tasks: ScheduledTask[] } => JSON.parse(fs.readFileSync(file, 'utf8'))

  beforeEach(async () => {
    dir = await makeTempDir('openclod-scheduler-')
    file = path.join(dir, 'state', 'scheduled-tasks.json')
    clock = d(2025, 1, 6, 8, 0) // Monday 08:00
  })

  afterEach(async () => {
    while (created.length) created.pop()!.stop()
    await removeTempDir(dir)
  })

  /* ------------------------------ validation ------------------------------ */

  describe('validation', () => {
    it('requires a name of at most 120 characters', async () => {
      const s = make()
      await expect(s.create(input({ name: '' }))).rejects.toThrow('O nome da tarefa é obrigatório.')
      await expect(s.create(input({ name: '   ' }))).rejects.toThrow('O nome da tarefa é obrigatório.')
      await expect(s.create(input({ name: 'x'.repeat(NAME_MAX + 1) }))).rejects.toThrow(
        'O nome da tarefa deve ter no máximo 120 caracteres.'
      )
      await expect(s.create(input({ name: 'x'.repeat(NAME_MAX) }))).resolves.toMatchObject({ name: 'x'.repeat(NAME_MAX) })
    })

    it('requires a prompt of at most 20000 characters', async () => {
      const s = make()
      await expect(s.create(input({ prompt: '' }))).rejects.toThrow('O prompt da tarefa é obrigatório.')
      await expect(s.create(input({ prompt: 'p'.repeat(PROMPT_MAX + 1) }))).rejects.toThrow(
        'O prompt da tarefa deve ter no máximo 20000 caracteres.'
      )
      await expect(s.create(input({ prompt: 'p'.repeat(PROMPT_MAX) }))).resolves.toBeDefined()
    })

    it('requires project and working folder', async () => {
      const s = make()
      await expect(s.create(input({ projectId: '' }))).rejects.toThrow('O projeto da tarefa é obrigatório.')
      await expect(s.create(input({ cwd: '' }))).rejects.toThrow('A pasta de trabalho da tarefa é obrigatória.')
    })

    it('accepts only HH:MM times', async () => {
      const s = make()
      for (const time of ['9:00', '24:00', '12:60', '12:5', 'abc', '', '09:00:00', '09-00', ' 09:00']) {
        for (const kind of ['daily', 'weekdays'] as const) {
          await expect(s.create(input({ schedule: { kind, time } }))).rejects.toThrow(
            'Horário inválido: use o formato HH:MM (de 00:00 a 23:59).'
          )
        }
        await expect(s.create(input({ schedule: { kind: 'weekly', day: 1, time } }))).rejects.toThrow(/Horário inválido/)
      }
      for (const time of ['00:00', '09:05', '23:59']) {
        await expect(s.create(input({ schedule: { kind: 'daily', time } }))).resolves.toBeDefined()
      }
    })

    it('validates the minute of an hourly schedule', async () => {
      const s = make()
      for (const minute of [-1, 60, 1.5, '5', null, NaN]) {
        await expect(s.create(input({ schedule: { kind: 'hourly', minute: minute as number } }))).rejects.toThrow(
          'Minuto inválido: use um número inteiro de 0 a 59.'
        )
      }
      await expect(s.create(input({ schedule: { kind: 'hourly', minute: 0 } }))).resolves.toBeDefined()
      await expect(s.create(input({ schedule: { kind: 'hourly', minute: 59 } }))).resolves.toBeDefined()
    })

    it('validates the weekday of a weekly schedule', async () => {
      const s = make()
      for (const day of [-1, 7, 2.5, '1', undefined]) {
        await expect(
          s.create(input({ schedule: { kind: 'weekly', day: day as number, time: '09:00' } }))
        ).rejects.toThrow(/Dia da semana inválido/)
      }
    })

    it('validates the date of a one-off schedule and refuses the past', async () => {
      const s = make()
      for (const at of ['', 'tomorrow', '2030-02-30T10:00', '2030-01-01', '2030-01-01 10:00']) {
        await expect(s.create(input({ schedule: { kind: 'once', at } }))).rejects.toThrow(/Data e hora inválidas/)
      }
      await expect(s.create(input({ schedule: { kind: 'once', at: '2025-01-06T07:59' } }))).rejects.toThrow(
        'O horário agendado já passou. Escolha uma data e hora no futuro.'
      )
      await expect(s.create(input({ schedule: { kind: 'once', at: '2025-01-06T08:00' } }))).rejects.toThrow(/já passou/)
      await expect(s.create(input({ schedule: { kind: 'once', at: '2025-01-06T08:01' } }))).resolves.toBeDefined()
      // A finished (disabled) one-off task may keep its old date.
      const finished = await s.create(input({ enabled: false, schedule: { kind: 'once', at: '2020-01-01T10:00' } }))
      expect(finished.enabled).toBe(false)
      expect(finished.nextRunAt).toBeUndefined()
    })

    it('rejects unknown schedule kinds and non-objects', async () => {
      const s = make()
      await expect(s.create(input({ schedule: { kind: 'monthly' } as unknown as Schedule }))).rejects.toThrow(
        /Tipo de agendamento inválido/
      )
      await expect(s.create(input({ schedule: null as unknown as Schedule }))).rejects.toThrow('Agendamento inválido.')
      await expect(s.create(input({ schedule: undefined as unknown as Schedule }))).rejects.toThrow('Agendamento inválido.')
    })

    it('validates mode and non-string fields', async () => {
      const s = make()
      await expect(s.create(input({ mode: 'hacker' as never }))).rejects.toThrow(/Modo inválido/)
      await expect(s.create(input({ model: 42 as never }))).rejects.toThrow('O modelo da tarefa deve ser um texto.')
      await expect(s.create(input({ enabled: 'yes' as never }))).rejects.toThrow(/"enabled"/)
      await expect(s.create(undefined as never)).rejects.toThrow(/obrigatório/)
      await expect(s.create(input({ mode: 'plan', providerId: 'openai', model: 'gpt-x' }))).resolves.toMatchObject({
        mode: 'plan',
        providerId: 'openai',
        model: 'gpt-x'
      })
    })

    it('throws SchedulerValidationError so callers can tell input errors apart', async () => {
      const s = make()
      await expect(s.create(input({ name: '' }))).rejects.toBeInstanceOf(SchedulerValidationError)
    })

    it('validates patches too and leaves the task untouched on failure', async () => {
      const s = make()
      const task = await s.create(input())
      await expect(s.update(task.id, { name: 'x'.repeat(121) })).rejects.toThrow(/no máximo 120/)
      await expect(s.update(task.id, { schedule: { kind: 'daily', time: '7:00' } })).rejects.toThrow(/Horário inválido/)
      expect(s.get(task.id)).toEqual(task)
      expect(readFile().tasks[0]).toMatchObject({ name: 'Resumo diário', schedule: { kind: 'daily', time: '09:00' } })
    })
  })

  /* ------------------------------ persistence ------------------------------ */

  describe('persistence', () => {
    it('round-trips tasks through the JSON file', async () => {
      const first = make()
      await first.create(input())
      await first.create(
        input({
          name: 'Semanal',
          schedule: { kind: 'weekly', day: 5, time: '17:30' },
          mode: 'review',
          providerId: 'anthropic',
          model: 'claude-x'
        })
      )
      await first.create(input({ name: 'Uma vez', schedule: { kind: 'once', at: '2025-03-01T10:00' }, enabled: false }))
      const expected = first.list()

      const second = make()
      await second.load()
      expect(second.list()).toEqual(expected)
      expect(second.list().map((t) => t.name)).toEqual(['Resumo diário', 'Semanal', 'Uma vez'])
    })

    it('writes versioned JSON atomically and leaves no temp file behind', async () => {
      const s = make()
      await s.create(input())
      await s.create(input({ name: 'Outra' }))
      const onDisk = readFile()
      expect(onDisk.version).toBe(1)
      expect(onDisk.tasks).toHaveLength(2)
      expect(fs.readdirSync(path.dirname(file))).toEqual(['scheduled-tasks.json'])
    })

    it('serializes concurrent writes (no temp-file collisions, nothing lost)', async () => {
      const s = make()
      await Promise.all(Array.from({ length: 25 }, (_, i) => s.create(input({ name: `Tarefa ${i}` }))))
      expect(s.list()).toHaveLength(25)
      const onDisk = readFile()
      expect(onDisk.tasks.map((t) => t.name).sort()).toEqual(s.list().map((t) => t.name).sort())
      expect(fs.readdirSync(path.dirname(file))).toEqual(['scheduled-tasks.json'])
    })

    it('starts empty when the file does not exist and creates the folder on first write', async () => {
      const s = make()
      await s.load()
      expect(s.list()).toEqual([])
      expect(fs.existsSync(file)).toBe(false)
      await s.create(input())
      expect(fs.existsSync(file)).toBe(true)
    })

    it('keeps an unreadable file as a backup and starts empty', async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '{ this is not json')
      const s = make()
      await s.load()
      expect(s.list()).toEqual([])
      const names = fs.readdirSync(path.dirname(file))
      const backup = names.find((n) => n.startsWith('scheduled-tasks.json.corrupt-'))
      expect(backup).toBeDefined()
      expect(fs.readFileSync(path.join(path.dirname(file), backup!), 'utf8')).toBe('{ this is not json')
    })

    it('drops invalid entries from the file and keeps the valid ones', async () => {
      const s = make()
      const good = await s.create(input())
      const onDisk = readFile()
      onDisk.tasks.push(
        { id: 'tsk_bad1', name: '', prompt: 'x', projectId: 'p', cwd: dir, schedule: { kind: 'daily', time: '09:00' } } as never,
        { id: 'tsk_bad2', name: 'x', prompt: 'x', projectId: 'p', cwd: dir, schedule: { kind: 'daily', time: '99:99' } } as never,
        null as never,
        'text' as never
      )
      fs.writeFileSync(file, JSON.stringify(onDisk))

      const reloaded = make()
      await reloaded.load()
      expect(reloaded.list().map((t) => t.id)).toEqual([good.id])
    })

    it('turns a run that was in progress when the app died into an error', async () => {
      const s = make()
      const task = await s.create(input())
      const onDisk = readFile()
      onDisk.tasks[0].lastStatus = 'running'
      fs.writeFileSync(file, JSON.stringify(onDisk))

      const reloaded = make()
      await reloaded.load()
      expect(reloaded.get(task.id)).toMatchObject({
        lastStatus: 'error',
        lastError: 'Interrompida: o aplicativo foi fechado durante a execução.'
      })
      expect(readFile().tasks[0].lastStatus).toBe('error')
    })

    it('returns copies from list() and get()', async () => {
      const s = make()
      const task = await s.create(input())
      const listed = s.list()
      listed[0].name = 'hacked'
      listed[0].schedule = { kind: 'hourly', minute: 1 }
      task.enabled = false
      expect(s.get(task.id)).toMatchObject({ name: 'Resumo diário', enabled: true, schedule: { kind: 'daily', time: '09:00' } })
    })
  })

  /* ------------------------------ CRUD ------------------------------ */

  describe('create, update, remove', () => {
    it('creates an enabled task with id, timestamps and the next run', async () => {
      const s = make()
      const task = await s.create(input())
      expect(task.id).toMatch(/^tsk_/)
      expect(task).toMatchObject({ name: 'Resumo diário', enabled: true, createdAt: clock.getTime(), updatedAt: clock.getTime() })
      expect(fmt(task.nextRunAt)).toBe('2025-01-06 09:00')
      expect(task.lastRunAt).toBeUndefined()
      expect(task.lastStatus).toBeUndefined()
    })

    it('trims text fields and ignores unknown input keys', async () => {
      const s = make()
      const task = await s.create({ ...input({ name: '  Nome  ', prompt: '\n prompt \n' }), id: 'evil', lastStatus: 'ok' } as never)
      expect(task.name).toBe('Nome')
      expect(task.prompt).toBe('prompt')
      expect(task.id).not.toBe('evil')
      expect(task.lastStatus).toBeUndefined()
    })

    it('creates a disabled task without a next run', async () => {
      const s = make()
      const task = await s.create(input({ enabled: false }))
      expect(task.enabled).toBe(false)
      expect(task.nextRunAt).toBeUndefined()
    })

    it('recomputes the next run when the schedule changes', async () => {
      const s = make()
      const task = await s.create(input())
      clock = d(2025, 1, 6, 8, 30)
      const updated = await s.update(task.id, { schedule: { kind: 'hourly', minute: 45 } })
      expect(fmt(updated.nextRunAt)).toBe('2025-01-06 08:45')
      expect(updated.updatedAt).toBe(clock.getTime())
      expect(updated.createdAt).toBe(task.createdAt)
    })

    it('keeps an overdue next run when only unrelated fields change', async () => {
      const s = make()
      const task = await s.create(input())
      clock = d(2025, 1, 6, 10, 0) // 09:00 slot is now overdue
      const updated = await s.update(task.id, { name: 'Renomeada', prompt: 'Outro prompt' })
      expect(updated.name).toBe('Renomeada')
      expect(fmt(updated.nextRunAt)).toBe('2025-01-06 09:00')
    })

    it('cannot change protected fields through a patch', async () => {
      const s = make()
      const task = await s.create(input())
      const updated = await s.update(task.id, { id: 'x', createdAt: 1, lastStatus: 'ok', nextRunAt: 5 } as never)
      expect(updated).toMatchObject({ id: task.id, createdAt: task.createdAt, nextRunAt: task.nextRunAt })
      expect(updated.lastStatus).toBeUndefined()
    })

    it('clears optional fields with null', async () => {
      const s = make()
      const task = await s.create(input({ mode: 'plan', providerId: 'p', model: 'm' }))
      const updated = await s.update(task.id, { mode: null, providerId: null, model: null })
      expect(updated.mode).toBeUndefined()
      expect(updated.providerId).toBeUndefined()
      expect(updated.model).toBeUndefined()
      expect('mode' in readFile().tasks[0]).toBe(false)
    })

    it('disables and re-enables, counting from now when re-enabled', async () => {
      const s = make()
      const task = await s.create(input())
      const off = await s.setEnabled(task.id, false)
      expect(off.enabled).toBe(false)
      expect(off.nextRunAt).toBeUndefined()

      clock = d(2025, 1, 6, 10, 0) // the 09:00 slot passes while it is off
      const on = await s.setEnabled(task.id, true)
      expect(on.enabled).toBe(true)
      expect(fmt(on.nextRunAt)).toBe('2025-01-07 09:00') // not a catch-up of the old slot
    })

    it('refuses to re-enable a one-off task whose time has passed', async () => {
      const s = make()
      const task = await s.create(input({ schedule: { kind: 'once', at: '2025-01-06T09:00' } }))
      await s.setEnabled(task.id, false)
      clock = d(2025, 1, 6, 12, 0)
      await expect(s.setEnabled(task.id, true)).rejects.toThrow(/já passou/)
      expect(s.get(task.id)!.enabled).toBe(false)
      const rescheduled = await s.update(task.id, { enabled: true, schedule: { kind: 'once', at: '2025-01-07T09:00' } })
      expect(fmt(rescheduled.nextRunAt)).toBe('2025-01-07 09:00')
    })

    it('reports unknown ids in Portuguese and removes tasks', async () => {
      const s = make()
      await expect(s.update('tsk_nope', { name: 'x' })).rejects.toThrow('Tarefa agendada não encontrada.')
      await expect(s.setEnabled('tsk_nope', true)).rejects.toThrow('Tarefa agendada não encontrada.')
      await expect(s.runNow('tsk_nope')).rejects.toThrow('Tarefa agendada não encontrada.')

      const task = await s.create(input())
      expect(await s.remove(task.id)).toBe(true)
      expect(await s.remove(task.id)).toBe(false)
      expect(s.list()).toEqual([])
      expect(readFile().tasks).toEqual([])
    })

    it('notifies subscribers after each change until they unsubscribe', async () => {
      const s = make()
      const seen: number[] = []
      const off = s.onChange((tasks) => seen.push(tasks.length))
      const task = await s.create(input())
      await s.update(task.id, { name: 'Outra' })
      await s.remove(task.id)
      expect(seen).toEqual([1, 1, 0])
      off()
      await s.create(input())
      expect(seen).toEqual([1, 1, 0])
    })
  })

  /* ------------------------------ running ------------------------------ */

  describe('runNow', () => {
    it('refuses to run before start()', async () => {
      const s = make()
      const task = await s.create(input())
      await expect(s.runNow(task.id)).rejects.toThrow('O agendador não foi iniciado.')
    })

    it('runs immediately and records the outcome without touching the schedule', async () => {
      const s = make()
      const task = await s.create(input())
      const { calls, handler } = recorder()
      await s.start(handler)

      clock = d(2025, 1, 6, 8, 10)
      const finished = await s.runNow(task.id)

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ id: task.id, name: 'Resumo diário', lastStatus: 'running' })
      expect(finished).toMatchObject({ lastStatus: 'ok', lastSessionId: 'ses_1', lastRunAt: clock.getTime(), enabled: true })
      expect(finished.lastError).toBeUndefined()
      expect(finished.lastRunLate).toBeUndefined()
      expect(fmt(finished.nextRunAt)).toBe('2025-01-06 09:00') // the 09:00 run still happens
      expect(readFile().tasks[0]).toMatchObject({ lastStatus: 'ok', lastSessionId: 'ses_1' })
    })

    it('runs a disabled task and leaves it disabled', async () => {
      const s = make()
      const task = await s.create(input({ enabled: false }))
      const { calls, handler } = recorder()
      await s.start(handler)
      const finished = await s.runNow(task.id)
      expect(calls).toHaveLength(1)
      expect(finished).toMatchObject({ enabled: false, lastStatus: 'ok' })
      expect(finished.nextRunAt).toBeUndefined()
    })

    it('counts as the run of a one-off task, which then disables itself', async () => {
      const s = make()
      const task = await s.create(input({ schedule: { kind: 'once', at: '2025-01-06T15:00' } }))
      const { calls, handler } = recorder()
      await s.start(handler)
      const finished = await s.runNow(task.id)
      expect(finished).toMatchObject({ enabled: false, lastStatus: 'ok' })
      expect(finished.nextRunAt).toBeUndefined()

      clock = d(2025, 1, 6, 15, 1)
      await s.tick()
      expect(calls).toHaveLength(1)
    })

    it('rejects when the task is already running', async () => {
      const s = make()
      const task = await s.create(input())
      const gate = deferred()
      let started = 0
      await s.start(async () => {
        started++
        await gate.promise
      })
      const first = s.runNow(task.id)
      await vi.waitFor(() => expect(started).toBe(1))
      await expect(s.runNow(task.id)).rejects.toThrow('A tarefa já está em execução.')
      gate.resolve()
      await first
      expect(started).toBe(1)
    })
  })

  describe('tick', () => {
    it('fires a due task exactly once and schedules the next slot', async () => {
      const s = make()
      const task = await s.create(input())
      const { calls, handler } = recorder()
      await s.start(handler)

      clock = d(2025, 1, 6, 8, 59, 59)
      await s.tick()
      expect(calls).toHaveLength(0)

      clock = d(2025, 1, 6, 9, 0, 5)
      await s.tick()
      expect(calls).toHaveLength(1)
      const after = s.get(task.id)!
      expect(after).toMatchObject({ lastStatus: 'ok', lastSessionId: 'ses_1', lastRunAt: clock.getTime(), lastDueAt: d(2025, 1, 6, 9).getTime() })
      expect(after.lastRunLate).toBeUndefined() // 5 s after the slot is on time
      expect(fmt(after.nextRunAt)).toBe('2025-01-07 09:00')

      await s.tick()
      await s.tick()
      expect(calls).toHaveLength(1)

      clock = d(2025, 1, 7, 9, 0, 10)
      await s.tick()
      expect(calls).toHaveLength(2)
      expect(fmt(s.get(task.id)!.nextRunAt)).toBe('2025-01-08 09:00')
    })

    it('passes the handler a copy of the task', async () => {
      const s = make()
      const task = await s.create(input())
      let seen: ScheduledTask | undefined
      await s.start(async (t) => {
        seen = t
        t.name = 'tampered'
        t.schedule = { kind: 'hourly', minute: 1 }
      })
      clock = d(2025, 1, 6, 9, 0, 1)
      await s.tick()
      expect(seen!.id).toBe(task.id)
      expect(s.get(task.id)).toMatchObject({ name: 'Resumo diário', schedule: { kind: 'daily', time: '09:00' } })
    })

    it('ignores disabled tasks', async () => {
      const s = make()
      const task = await s.create(input())
      await s.setEnabled(task.id, false)
      const { calls, handler } = recorder()
      await s.start(handler)
      clock = d(2025, 1, 6, 12, 0)
      await s.tick()
      expect(calls).toHaveLength(0)
    })

    it('runs several due tasks, each once, concurrently', async () => {
      const s = make()
      const a = await s.create(input({ name: 'A' }))
      const b = await s.create(input({ name: 'B', schedule: { kind: 'hourly', minute: 30 } }))
      await s.create(input({ name: 'C (later)', schedule: { kind: 'daily', time: '18:00' } }))

      const gate = deferred()
      const active: string[] = []
      let peak = 0
      const done: string[] = []
      await s.start(async (task) => {
        active.push(task.name)
        peak = Math.max(peak, active.length)
        await gate.promise
        done.push(task.name)
        active.splice(active.indexOf(task.name), 1)
      })

      clock = d(2025, 1, 6, 9, 31)
      const tick = s.tick()
      await vi.waitFor(() => expect(peak).toBe(2))
      gate.resolve()
      await tick
      expect(done.sort()).toEqual(['A', 'B'])
      expect(s.get(a.id)!.lastStatus).toBe('ok')
      expect(s.get(b.id)!.lastStatus).toBe('ok')
    })

    it('orders due tasks by priority when the concurrency limit is one', async () => {
      const s = make({ maxConcurrent: 1 })
      await s.create(input({ name: 'baixa', priority: 'low', schedule: { kind: 'hourly', minute: 30 } }))
      await s.create(input({ name: 'alta', priority: 'high', schedule: { kind: 'hourly', minute: 30 } }))
      await s.create(input({ name: 'normal', priority: 'normal', schedule: { kind: 'hourly', minute: 30 } }))
      const order: string[] = []
      await s.start(async (task) => { order.push(task.name) })
      clock = d(2025, 1, 6, 9, 31)
      await s.tick()
      expect(order).toEqual(['alta', 'normal', 'baixa'])
    })

    it('retries failed attempts and persists a bounded run history', async () => {
      const s = make()
      const task = await s.create(input({ maxRetries: 2, retryDelayMs: 0 }))
      let attempts = 0
      await s.start(async () => {
        attempts++
        if (attempts < 3) throw new Error(`falha ${attempts}`)
        return { sessionId: 'ses_retry' }
      })
      clock = d(2025, 1, 6, 9, 0, 10)
      await s.tick()
      const result = s.get(task.id)!
      expect(attempts).toBe(3)
      expect(result.lastStatus).toBe('ok')
      expect(result.lastSessionId).toBe('ses_retry')
      expect(result.runHistory?.map((run) => run.status)).toEqual(['error', 'error', 'ok'])
      expect(result.runHistory?.map((run) => run.attempt)).toEqual([1, 2, 3])
    })

    it('never runs the same task twice at once, and skips slots that pass during a run', async () => {
      const s = make()
      const task = await s.create(input({ schedule: { kind: 'hourly', minute: 0 } })) // next 09:00
      const gate = deferred()
      let started = 0
      await s.start(async () => {
        started++
        await gate.promise
      })

      clock = d(2025, 1, 6, 9, 0, 10)
      const firstTick = s.tick()
      await vi.waitFor(() => expect(started).toBe(1))
      expect(s.get(task.id)!.lastStatus).toBe('running')
      expect(readFile().tasks[0].lastStatus).toBe('running') // visible on disk while it runs

      // 10:00 and 11:00 slots come and go while the 09:00 run is still going.
      clock = d(2025, 1, 6, 10, 0, 10)
      await s.tick()
      clock = d(2025, 1, 6, 11, 0, 10)
      await s.tick()
      expect(started).toBe(1)

      clock = d(2025, 1, 6, 11, 30)
      gate.resolve()
      await firstTick
      const after = s.get(task.id)!
      expect(after.lastStatus).toBe('ok')
      expect(fmt(after.nextRunAt)).toBe('2025-01-06 12:00') // not 10:00 or 11:00

      await s.tick()
      expect(started).toBe(1)
      clock = d(2025, 1, 6, 12, 0, 5)
      await s.tick()
      await vi.waitFor(() => expect(started).toBe(2))
    })

    it('disables a one-off task as it starts and never runs it again', async () => {
      const s = make()
      const task = await s.create(input({ schedule: { kind: 'once', at: '2025-01-06T10:00' } }))
      expect(fmt(task.nextRunAt)).toBe('2025-01-06 10:00')

      const { calls } = recorder()
      let duringRun: ScheduledTask | undefined
      await s.start(async (t) => {
        calls.push(t)
        duringRun = s.get(t.id)
        return { sessionId: 'ses_once' }
      })

      clock = d(2025, 1, 6, 10, 0, 3)
      await s.tick()
      // Already off while the run is in progress, so a crash cannot repeat it.
      expect(duringRun).toMatchObject({ enabled: false, lastStatus: 'running' })
      expect(duringRun!.nextRunAt).toBeUndefined()

      const after = s.get(task.id)!
      expect(after).toMatchObject({ enabled: false, lastStatus: 'ok', lastSessionId: 'ses_once' })
      expect(after.nextRunAt).toBeUndefined()
      expect(readFile().tasks[0]).toMatchObject({ enabled: false, lastStatus: 'ok' })

      clock = d(2025, 1, 6, 10, 5)
      await s.tick()
      clock = d(2025, 1, 7, 10, 0)
      await s.tick()
      expect(calls).toHaveLength(1)
    })
  })

  describe('errors', () => {
    it('records a failing run and keeps the task scheduled', async () => {
      const s = make()
      const task = await s.create(input())
      let fail = true
      await s.start(async () => {
        if (fail) throw new Error('provedor indisponível')
        return { sessionId: 'ses_ok' }
      })

      clock = d(2025, 1, 6, 9, 0, 2)
      await s.tick()
      const failed = s.get(task.id)!
      expect(failed).toMatchObject({ lastStatus: 'error', lastError: 'provedor indisponível', enabled: true })
      expect(failed.lastSessionId).toBeUndefined()
      expect(fmt(failed.nextRunAt)).toBe('2025-01-07 09:00')
      expect(readFile().tasks[0]).toMatchObject({ lastStatus: 'error', lastError: 'provedor indisponível' })

      fail = false
      clock = d(2025, 1, 7, 9, 0, 2)
      await s.tick()
      const recovered = s.get(task.id)!
      expect(recovered).toMatchObject({ lastStatus: 'ok', lastSessionId: 'ses_ok' })
      expect(recovered.lastError).toBeUndefined()
    })

    it('records synchronous throws and non-Error rejections', async () => {
      const s = make()
      const task = await s.create(input())
      let mode: 'sync' | 'string' = 'sync'
      await s.start((() => {
        if (mode === 'sync') throw new TypeError('quebrou na hora')
        return Promise.reject('texto solto')
      }) as TaskRunHandler)

      await s.runNow(task.id)
      expect(s.get(task.id)).toMatchObject({ lastStatus: 'error', lastError: 'quebrou na hora' })
      mode = 'string'
      await s.runNow(task.id)
      expect(s.get(task.id)).toMatchObject({ lastStatus: 'error', lastError: 'texto solto' })
    })

    it('does not reject runNow or tick when the handler fails', async () => {
      const s = make()
      const task = await s.create(input())
      await s.start(async () => {
        throw new Error('x')
      })
      await expect(s.runNow(task.id)).resolves.toMatchObject({ lastStatus: 'error' })
      clock = d(2025, 1, 6, 9, 1)
      await expect(s.tick()).resolves.toBeUndefined()
    })

    it('truncates very long error messages', async () => {
      const s = make()
      const task = await s.create(input())
      await s.start(async () => {
        throw new Error('e'.repeat(5000))
      })
      const finished = await s.runNow(task.id)
      expect(finished.lastError).toHaveLength(2000)
    })

    it('still disables a one-off task that fails', async () => {
      const s = make()
      const task = await s.create(input({ schedule: { kind: 'once', at: '2025-01-06T10:00' } }))
      await s.start(async () => {
        throw new Error('falhou')
      })
      clock = d(2025, 1, 6, 10, 0, 1)
      await s.tick()
      expect(s.get(task.id)).toMatchObject({ enabled: false, lastStatus: 'error', lastError: 'falhou' })
    })

    it('survives the task being removed or edited while it runs', async () => {
      const s = make()
      const removed = await s.create(input({ name: 'Removida' }))
      const edited = await s.create(input({ name: 'Editada' }))
      const gate = deferred()
      await s.start(async () => {
        await gate.promise
        return { sessionId: 'ses_x' }
      })

      clock = d(2025, 1, 6, 9, 0, 1)
      const tick = s.tick()
      await vi.waitFor(() => expect(s.get(removed.id)!.lastStatus).toBe('running'))
      await s.remove(removed.id)
      await s.update(edited.id, { name: 'Editada 2', schedule: { kind: 'daily', time: '20:00' } })
      gate.resolve()
      await tick

      expect(s.get(removed.id)).toBeUndefined()
      expect(s.get(edited.id)).toMatchObject({ name: 'Editada 2', lastStatus: 'ok', lastSessionId: 'ses_x' })
      expect(fmt(s.get(edited.id)!.nextRunAt)).toBe('2025-01-06 20:00')
      expect(readFile().tasks.map((t) => t.name)).toEqual(['Editada 2'])
    })
  })

  describe('missed runs', () => {
    it('runs a task once at startup when several slots passed while the app was closed', async () => {
      const before = make()
      const task = await before.create(input()) // daily 09:00, next = Mon 09:00
      expect(fmt(task.nextRunAt)).toBe('2025-01-06 09:00')
      before.stop() // "app closed"

      clock = d(2025, 1, 9, 14, 20) // Thursday afternoon: Mon, Tue, Wed and Thu 09:00 were missed
      const after = make()
      await after.load()
      const { calls, handler } = recorder()
      await after.start(handler)

      expect(calls).toHaveLength(1) // once, not once per missed slot
      const run = after.get(task.id)!
      expect(run).toMatchObject({
        lastStatus: 'ok',
        lastSessionId: 'ses_1',
        lastRunLate: true,
        lastRunAt: clock.getTime(),
        lastDueAt: d(2025, 1, 6, 9).getTime() // the first slot that was missed
      })
      expect(fmt(run.nextRunAt)).toBe('2025-01-10 09:00')
      expect(readFile().tasks[0]).toMatchObject({ lastRunLate: true, lastStatus: 'ok' })

      await after.tick()
      expect(calls).toHaveLength(1)
    })

    it('treats hourly and weekly tasks the same way', async () => {
      const before = make()
      const hourly = await before.create(input({ name: 'hourly', schedule: { kind: 'hourly', minute: 15 } }))
      const weekly = await before.create(input({ name: 'weekly', schedule: { kind: 'weekly', day: 1, time: '09:00' } }))
      before.stop()

      clock = d(2025, 1, 20, 11, 30) // two weeks later
      const fresh = await before.create(input({ name: 'not due', schedule: { kind: 'daily', time: '23:00' } }))
      clock = d(2025, 1, 20, 12, 0)
      const after = make()
      const { calls, handler } = recorder()
      await after.start(handler)

      expect(calls.map((c) => c.name).sort()).toEqual(['hourly', 'weekly'])
      expect(fmt(after.get(hourly.id)!.nextRunAt)).toBe('2025-01-20 12:15')
      expect(fmt(after.get(weekly.id)!.nextRunAt)).toBe('2025-01-27 09:00')
      expect(after.get(fresh.id)!.lastStatus).toBeUndefined() // 23:00 tonight is still ahead
    })

    it('runs a missed one-off task once, late, and disables it', async () => {
      const before = make()
      const task = await before.create(input({ schedule: { kind: 'once', at: '2025-01-06T10:00' } }))
      before.stop()

      clock = d(2025, 1, 8, 9, 0)
      const after = make()
      const { calls, handler } = recorder()
      await after.start(handler)
      expect(calls).toHaveLength(1)
      expect(after.get(task.id)).toMatchObject({ enabled: false, lastStatus: 'ok', lastRunLate: true })
      expect(after.get(task.id)!.nextRunAt).toBeUndefined()
    })

    it('does not call a slightly delayed run late', async () => {
      const s = make({ tickMs: 30_000 })
      const task = await s.create(input())
      const { handler } = recorder()
      await s.start(handler)
      clock = d(2025, 1, 6, 9, 0, 50) // one tick plus a bit
      await s.tick()
      expect(s.get(task.id)!.lastRunLate).toBeUndefined()
    })

    it('does not run tasks that were disabled while the app was closed', async () => {
      const before = make()
      const task = await before.create(input({ enabled: false }))
      before.stop()
      clock = d(2025, 1, 9, 14, 20)
      const after = make()
      const { calls, handler } = recorder()
      await after.start(handler)
      expect(calls).toHaveLength(0)
      expect(after.get(task.id)!.lastStatus).toBeUndefined()
    })

    it('can skip instead of catching up, recording the task as missed', async () => {
      const before = make()
      const task = await before.create(input())
      clock = d(2025, 1, 9, 14, 0)
      const onTime = await before.create(input({ name: 'on time', schedule: { kind: 'daily', time: '14:20' } }))
      before.stop()

      clock = d(2025, 1, 9, 14, 20, 5)
      const after = make({ catchUpMissed: false })
      const { calls, handler } = recorder()
      await after.start(handler)

      expect(calls.map((c) => c.name)).toEqual(['on time']) // its slot is only 5 s old: not missed
      expect(after.get(task.id)).toMatchObject({ lastStatus: 'missed', lastDueAt: d(2025, 1, 6, 9).getTime() })
      expect(after.get(task.id)!.lastRunAt).toBeUndefined()
      expect(fmt(after.get(task.id)!.nextRunAt)).toBe('2025-01-10 09:00')
      expect(after.get(onTime.id)!.lastStatus).toBe('ok')
      expect(readFile().tasks[0].lastStatus).toBe('missed')
    })
  })

  describe('timer', () => {
    it('checks for due tasks on its own every tickMs until stopped', async () => {
      const s = make({ tickMs: 10 })
      await s.create(input())
      const { calls, handler } = recorder()
      await s.start(handler)
      expect(calls).toHaveLength(0)

      clock = d(2025, 1, 6, 9, 0, 1)
      await vi.waitFor(() => expect(calls).toHaveLength(1))

      s.stop()
      clock = d(2025, 1, 7, 9, 0, 1)
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(calls).toHaveLength(1)
      await expect(s.runNow(calls[0].id)).rejects.toThrow('O agendador não foi iniciado.')
    })

    it('can be started again after stop()', async () => {
      const s = make({ tickMs: 10 })
      await s.create(input())
      const first = recorder()
      await s.start(first.handler)
      s.stop()

      clock = d(2025, 1, 6, 9, 0, 1)
      const second = recorder()
      await s.start(second.handler)
      expect(first.calls).toHaveLength(0)
      expect(second.calls).toHaveLength(1)
    })
  })
})
