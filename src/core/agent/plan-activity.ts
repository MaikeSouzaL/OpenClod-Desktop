import type { PlanItem, PlanStepActivity, ToolResult } from '../../shared/types.js'

/** Tools that are plan bookkeeping or interaction, not step work. */
const SKIP = new Set(['update_plan', 'report_limitation', 'ask_user', 'tool_search', 'tool_load', 'tool_list'])

const MAX_ENTRIES = 40
const MAX_OUTPUT = 1_200
const MAX_DETAIL = 2_000

function firstLine(value: string, max: number): string {
  const line = value.split(/\r?\n/).find((row) => row.trim()) ?? ''
  return line.trim().slice(0, max)
}

function argsOf(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text
}

/**
 * Converts one finished tool call into the activity stored under the active
 * plan step. Runs only on completion, so the persisted entry has the output.
 */
export function planActivityEntry(
  id: string,
  name: string,
  args: unknown,
  result: ToolResult,
  startedAt: number,
  endedAt: number
): PlanStepActivity | null {
  if (SKIP.has(name)) return null
  const value = argsOf(args)
  const command = typeof value.command === 'string' ? value.command : ''
  const target =
    command ||
    (typeof value.path === 'string' ? value.path : '') ||
    (typeof value.url === 'string' ? value.url : '') ||
    (typeof value.query === 'string' ? value.query : '') ||
    (typeof value.pattern === 'string' ? value.pattern : '')
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  const title = description || firstLine(target, 110) || firstLine(result.summary ?? '', 110) || name
  const kind = command ? 'command' : name === 'agent' || name === 'task' ? 'agent' : 'tool'
  const exitCode = typeof result.data?.exitCode === 'number' ? result.data.exitCode : undefined
  return {
    id,
    name,
    kind,
    title,
    status: result.ok ? 'done' : 'failed',
    startedAt,
    endedAt,
    ...(target ? { detail: target.slice(0, MAX_DETAIL) } : {}),
    ...(result.text ? { output: tail(result.text, MAX_OUTPUT) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {})
  }
}

/** Appends to the first `active` item; returns the same array when there is none. */
export function appendPlanActivity(plan: PlanItem[], entry: PlanStepActivity): PlanItem[] {
  const index = plan.findIndex((item) => item.status === 'active')
  if (index === -1) return plan
  const item = plan[index]
  const activity = [...(item.activity ?? []), entry].slice(-MAX_ENTRIES)
  const next = [...plan]
  next[index] = { ...item, activity }
  return next
}
