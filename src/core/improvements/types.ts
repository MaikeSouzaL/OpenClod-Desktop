import type {
  ActivityItem,
  ImprovementFinding,
  MemoryPageInfo,
  ObservabilityEventInfo,
  ProviderUsageInfo
} from '../../shared/api.js'

/** Everything the review reads, handed over by the caller so the logic stays pure and testable. */
export interface ReviewInput {
  project: { id: string; name: string }
  now: number
  /** Look-back window in days. */
  days: number
  /** Sessions of this project only; evidence from other projects is never counted. */
  sessions: Array<{ id: string; title: string; updatedAt: number; providerId?: string; model?: string }>
  activity: ActivityItem[]
  events: ObservabilityEventInfo[]
  /** Global (all projects, all time): provider usage is not tracked per project. */
  usage: ProviderUsageInfo[]
  memoryPages: Array<Pick<MemoryPageInfo, 'slug' | 'title' | 'tags' | 'pinned' | 'updated' | 'summary'> & Partial<Pick<MemoryPageInfo, 'memoryType' | 'status' | 'possibleConflicts'>>>
  memoryStats?: { pages: number; pinned: number; openHandoffs: number; conflicts?: number; superseded?: number; invalidated?: number }
}

export interface LimitationGroup {
  title: string
  count: number
  sessions: string[]
  lastAt: number
  /** Blocked work (true) or only degraded (false). */
  blocking: boolean
  detail: string
}

export interface ToolGroup {
  name: string
  calls: number
  failures: number
  failureRate: number
  averageMs: number
  maxMs: number
  sessions: string[]
  /** Distinct redacted failure messages, newest first. */
  errors: string[]
}

export interface PermissionGroup {
  title: string
  requested: number
  granted: number
  denied: number
  /** Redacted example of what was asked. */
  example: string
}

export interface AgentFailureGroup {
  label: string
  count: number
  example: string
}

export interface Evidence {
  generatedAt: number
  periodDays: number
  since: number
  project: { id: string; name: string }
  /** Oldest observability event still on disk (the log is capped), so a thin window is visible. */
  eventsSince?: number
  totals: {
    sessions: number
    activeSessions: number
    turns: number
    failedTurns: number
    toolCalls: number
    failedToolCalls: number
    approvalsRequested: number
    approvalsGranted: number
    approvalsDenied: number
    limitations: number
    budgetStops: number
    agentFailures: number
  }
  limitations: LimitationGroup[]
  tools: ToolGroup[]
  permissions: PermissionGroup[]
  failedTurns: Array<{ reason: string; count: number }>
  budget: Array<{ kind: string; count: number; example: string }>
  agentFailures: AgentFailureGroup[]
  usage: Array<ProviderUsageInfo & { cacheRate: number }>
  memory: {
    pages: number
    pinned: number
    topics: number
    turnLogs: number
    openHandoffs: number
    conflicts: number
    stale: number
    recent: Array<{ slug: string; title: string; updated: string }>
    /** Previous reviews saved in this project's memory, newest first. */
    reviews: Array<{ slug: string; title: string; updated: string }>
  }
}

export type { ImprovementFinding }
