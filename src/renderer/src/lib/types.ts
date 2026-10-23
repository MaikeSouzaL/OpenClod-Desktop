import type { RunState } from '../../../shared/types'

export interface LiveTool {
  id: string
  name: string
  args: unknown
  summary?: string
  ok?: boolean
  text?: string
  files?: string[]
  data?: Record<string, unknown>
  running: boolean
}

export interface LogEntry {
  id: string
  ts: number
  level: 'info' | 'warn' | 'blocked' | 'error'
  text: string
}

export interface SubagentInfo {
  childId: string
  label: string
  state: RunState
}
