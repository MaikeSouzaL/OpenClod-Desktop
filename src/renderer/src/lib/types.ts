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
  /** When execution started; drives the live elapsed timer. */
  startedAt?: number
  /** Last live chunk while a long tool is still running. */
  progress?: string
  /** When the last live chunk arrived. */
  updatedAt?: number
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
