import type { HarnessEvent, RunState } from '../../../shared/types'

/**
 * What the agent is doing, derived from harness events: shell commands, other
 * agents and (for each agent) the tools it ran. The "Tarefas em segundo plano"
 * panel and the "working" indicators render from this; nothing here is invented
 * by the UI — every entry comes from a tool_start/tool_end/subagent event.
 */

export type ActivityKind = 'command' | 'agent' | 'tool'
export type ActivityStatus = 'running' | 'done' | 'failed'

export interface ActivityEntry {
  id: string
  kind: ActivityKind
  /** Tool name, or the agent type for agents. */
  name: string
  title: string
  /** Full command line or the prompt given to an agent. */
  detail?: string
  /** The agent (child id) that ran this tool; undefined for the main agent. */
  agentId?: string
  /** For agents: the agent that called it. */
  parentId?: string
  model?: string
  depth?: number
  startedAt: number
  endedAt?: number
  status: ActivityStatus
  output?: string
  pid?: number
  exitCode?: number
  background?: boolean
}

export type ActivityState = ActivityEntry[]

/** Tools that show up as "commands" in the tasks panel. */
const COMMAND_TOOLS = new Set(['run_command', 'start_process', 'external_agent'])
/** The call to an agent is represented by the agent entry itself. */
const AGENT_TOOLS = new Set(['agent', 'task'])

const MAX_ENTRIES = 400
const MAX_OUTPUT = 20_000

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).find((item) => item.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function argsOf(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

export function commandTitle(name: string, args: unknown): { title: string; detail?: string } {
  const value = argsOf(args)
  if (name === 'external_agent') {
    const prompt = typeof value.prompt === 'string' ? value.prompt : ''
    return { title: `${String(value.agent ?? 'agente externo')}: ${firstLine(prompt, 64)}`, detail: prompt || undefined }
  }
  const command = typeof value.command === 'string' ? value.command : ''
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  return { title: description || firstLine(command, 72) || name, detail: command || undefined }
}

function toolTitle(name: string, args: unknown): string {
  const value = argsOf(args)
  for (const key of ['path', 'url', 'query', 'pattern', 'command', 'label']) {
    if (typeof value[key] === 'string' && value[key]) return `${name} ${firstLine(String(value[key]), 56)}`
  }
  return name
}

function isRunning(state: RunState): boolean {
  return state === 'thinking' || state === 'streaming' || state === 'tool' || state === 'waiting_approval'
}

function upsert(state: ActivityState, entry: ActivityEntry): ActivityState {
  const index = state.findIndex((item) => item.id === entry.id)
  if (index === -1) {
    const next = [...state, entry]
    return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
  }
  const next = [...state]
  next[index] = entry
  return next
}

/** Background processes outlive the call that started them; their state comes from the process list. */
function startsBackground(name: string, args: unknown, existing?: ActivityEntry): boolean {
  return Boolean(existing?.background) || name === 'start_process' || argsOf(args).run_in_background === true
}

/** Marks processes the harness reports as exited (and keeps the ones still alive running). */
export function reconcileProcesses(
  state: ActivityState,
  listed: Array<{ pid: number; exitCode: number | null }>,
  now: number
): ActivityState {
  let changed = false
  const next = state.map((entry) => {
    if (!entry.background || !entry.pid || entry.status !== 'running') return entry
    const info = listed.find((item) => item.pid === entry.pid)
    // Not listed any more (session disposed / app restarted): treat as finished.
    if (info && info.exitCode === null) return entry
    changed = true
    const code = info?.exitCode ?? entry.exitCode
    return { ...entry, status: code === undefined || code === 0 || code === null ? ('done' as const) : ('failed' as const), exitCode: code ?? undefined, endedAt: now }
  })
  return changed ? next : state
}

export function reduceActivity(state: ActivityState, event: HarnessEvent, now: number): ActivityState {
  switch (event.type) {
    case 'tool_start': {
      if (AGENT_TOOLS.has(event.name)) return state
      const agentId = (event as { agentId?: string }).agentId
      const existing = state.find((item) => item.id === event.toolCallId)
      const isCommand = COMMAND_TOOLS.has(event.name)
      const { title, detail } = isCommand ? commandTitle(event.name, event.args) : { title: toolTitle(event.name, event.args), detail: undefined }
      return upsert(state, {
        id: event.toolCallId,
        kind: isCommand ? 'command' : 'tool',
        name: event.name,
        title: existing && !title ? existing.title : title,
        detail: detail ?? existing?.detail,
        agentId: agentId ?? existing?.agentId,
        startedAt: existing?.startedAt ?? now,
        status: existing?.status ?? 'running',
        endedAt: existing?.endedAt,
        output: existing?.output,
        background: startsBackground(event.name, event.args, existing)
      })
    }
    case 'tool_end': {
      if (AGENT_TOOLS.has(event.name)) return state
      const agentId = (event as { agentId?: string }).agentId
      const existing = state.find((item) => item.id === event.toolCallId)
      const isCommand = COMMAND_TOOLS.has(event.name)
      const data = event.data ?? {}
      // A service started in the background keeps running after the call returns.
      const stillRunning = event.ok && existing?.background === true && typeof data.pid === 'number' && (data.exitCode === undefined || data.exitCode === null)
      return upsert(state, {
        id: event.toolCallId,
        kind: existing?.kind ?? (isCommand ? 'command' : 'tool'),
        name: event.name,
        title: existing?.title ?? event.name,
        detail: existing?.detail,
        agentId: agentId ?? existing?.agentId,
        startedAt: existing?.startedAt ?? now,
        endedAt: stillRunning ? undefined : now,
        status: stillRunning ? 'running' : event.ok ? 'done' : 'failed',
        output: event.text ? event.text.slice(0, MAX_OUTPUT) : existing?.output,
        pid: typeof data.pid === 'number' ? data.pid : existing?.pid,
        exitCode: typeof data.exitCode === 'number' ? data.exitCode : existing?.exitCode,
        background: existing?.background
      })
    }
    case 'subagent': {
      const extra = event as typeof event & {
        agent?: string
        model?: string
        parentChildId?: string
        depth?: number
        startedAt?: number
        endedAt?: number
        prompt?: string
        summary?: string
      }
      const existing = state.find((item) => item.id === event.childId)
      const running = isRunning(event.state)
      const failed = event.state === 'error' || event.state === 'cancelled'
      return upsert(state, {
        id: event.childId,
        kind: 'agent',
        name: extra.agent ?? existing?.name ?? 'agent',
        title: event.label || existing?.title || 'agente',
        detail: extra.prompt ?? existing?.detail,
        parentId: extra.parentChildId ?? existing?.parentId,
        model: extra.model ?? existing?.model,
        depth: extra.depth ?? existing?.depth,
        startedAt: extra.startedAt ?? existing?.startedAt ?? now,
        endedAt: running ? undefined : (extra.endedAt ?? existing?.endedAt ?? now),
        status: running ? 'running' : failed ? 'failed' : 'done',
        output: extra.summary ?? existing?.output
      })
    }
    case 'turn_end':
    case 'status': {
      // A turn that ended (or was aborted) leaves nothing running that the harness still tracks,
      // except background processes, which keep going on their own.
      if (event.type === 'status' && event.state !== 'cancelled') return state
      const failed = (event.type === 'turn_end' && event.stopReason === 'error') || event.type === 'status'
      const status: ActivityStatus = failed ? 'failed' : 'done'
      return state.map((item) =>
        item.status === 'running' && !item.background ? { ...item, status, endedAt: item.endedAt ?? now } : item
      )
    }
    default:
      return state
  }
}

/** Direct children of an agent (tools it ran and agents it called), in start order. */
export function childrenOf(state: ActivityState, agentId: string): ActivityEntry[] {
  return state.filter((item) => (item.kind === 'agent' ? item.parentId === agentId : item.agentId === agentId))
}

/** What the panel lists at the top level: the main agent's commands and the agents it called. */
export function topLevel(state: ActivityState): ActivityEntry[] {
  return state.filter((item) => (item.kind === 'command' && !item.agentId) || (item.kind === 'agent' && !item.parentId))
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, '0')} s`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function elapsed(entry: ActivityEntry, now: number): number {
  return (entry.endedAt ?? now) - entry.startedAt
}

/** Drops finished entries (the trash button); running ones and their ancestors stay. */
export function clearFinished(state: ActivityState): ActivityState {
  const keep = new Set<string>()
  for (const item of state) {
    if (item.status !== 'running') continue
    keep.add(item.id)
    if (item.agentId) keep.add(item.agentId)
    if (item.parentId) keep.add(item.parentId)
  }
  return state.filter((item) => keep.has(item.id))
}
