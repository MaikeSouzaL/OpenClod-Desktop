import type { Schedule } from './types.js'

/** Thrown for invalid user input. The message is pt-BR and safe to show as is. */
export class SchedulerValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulerValidationError'
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
// Date AND time are required: a bare "2030-01-01" would be read as UTC midnight.
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/
const HOUR_MS = 3_600_000

export function parseTime(time: unknown): { hour: number; minute: number } | null {
  if (typeof time !== 'string') return null
  const m = TIME_RE.exec(time)
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null
}

/**
 * A real calendar date-time. Date.parse alone is not enough: V8 happily turns
 * "2030-02-30T10:00" into March 2nd.
 */
function isRealDateTime(value: string): boolean {
  const m = ISO_DATE_TIME_RE.exec(value)
  if (!m) return false
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const second = Number(m[6] ?? 0)
  if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) return false
  return !Number.isNaN(new Date(value).getTime())
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function requireTime(value: unknown): string {
  if (parseTime(value) === null) {
    throw new SchedulerValidationError('Horário inválido: use o formato HH:MM (de 00:00 a 23:59).')
  }
  return value as string
}

/**
 * Validates an untrusted schedule (IPC input, JSON from disk) and returns a
 * clean copy holding only the known fields.
 */
export function validateSchedule(input: unknown): Schedule {
  if (typeof input !== 'object' || input === null) {
    throw new SchedulerValidationError('Agendamento inválido.')
  }
  const s = input as Record<string, unknown>
  switch (s.kind) {
    case 'hourly':
      if (!isInt(s.minute, 0, 59)) {
        throw new SchedulerValidationError('Minuto inválido: use um número inteiro de 0 a 59.')
      }
      return { kind: 'hourly', minute: s.minute }
    case 'daily':
      return { kind: 'daily', time: requireTime(s.time) }
    case 'weekdays':
      return { kind: 'weekdays', time: requireTime(s.time) }
    case 'weekly':
      if (!isInt(s.day, 0, 6)) {
        throw new SchedulerValidationError('Dia da semana inválido: use um número inteiro de 0 (domingo) a 6 (sábado).')
      }
      return { kind: 'weekly', day: s.day, time: requireTime(s.time) }
    case 'once': {
      const at = typeof s.at === 'string' ? s.at.trim() : ''
      if (!isRealDateTime(at)) {
        throw new SchedulerValidationError('Data e hora inválidas: use o formato ISO 8601 (ex.: 2030-01-31T09:30).')
      }
      return { kind: 'once', at }
    }
    default:
      throw new SchedulerValidationError(
        'Tipo de agendamento inválido: use hourly, daily, weekdays, weekly ou once.'
      )
  }
}

/** Next hourly slot strictly after `from`, at local minute `minute`. */
function nextHourly(minute: number, from: Date): Date {
  const candidate = new Date(from.getTime())
  candidate.setMinutes(minute, 0, 0)
  // Advance by absolute hours, so a repeated hour (DST fall-back) fires twice
  // and a skipped hour (spring-forward) is simply not there. Re-snapping the
  // minute is only needed in zones whose DST shift is 30 minutes (Lord Howe);
  // doing it unconditionally would bounce between the two copies of an
  // ambiguous local time forever.
  for (let i = 0; i < 24 && candidate.getTime() <= from.getTime(); i++) {
    candidate.setTime(candidate.getTime() + HOUR_MS)
    if (candidate.getMinutes() !== minute) candidate.setMinutes(minute, 0, 0)
  }
  return candidate
}

/**
 * The next time `schedule` fires, strictly after `from`, in LOCAL time; null
 * when there is none (a `once` schedule in the past, or an invalid schedule).
 *
 * Wall-clock slots are built from local calendar components for each
 * candidate day instead of adding 24 h, so daylight-saving changes cannot
 * shift them: a time that does not exist that day (spring-forward gap) fires
 * at the first valid instant after it, and a time that exists twice
 * (fall-back) fires once, at its first occurrence.
 */
export function nextRun(schedule: Schedule, from: Date): Date | null {
  const fromMs = from.getTime()
  if (Number.isNaN(fromMs)) return null

  switch (schedule.kind) {
    case 'hourly':
      return isInt(schedule.minute, 0, 59) ? nextHourly(schedule.minute, from) : null

    case 'once': {
      const at = new Date(schedule.at)
      return !Number.isNaN(at.getTime()) && at.getTime() > fromMs ? at : null
    }

    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const time = parseTime(schedule.time)
      if (!time) return null
      if (schedule.kind === 'weekly' && !isInt(schedule.day, 0, 6)) return null
      // A week plus one day always contains a match; the extra days are slack.
      for (let offset = 0; offset <= 14; offset++) {
        const candidate = new Date(
          from.getFullYear(),
          from.getMonth(),
          from.getDate() + offset,
          time.hour,
          time.minute,
          0,
          0
        )
        if (candidate.getTime() <= fromMs) continue
        const weekday = candidate.getDay()
        if (schedule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue
        if (schedule.kind === 'weekly' && weekday !== schedule.day) continue
        return candidate
      }
      return null
    }
  }
}
