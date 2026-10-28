import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type {
  DiagnosticExportInfo,
  HealthComponentInfo,
  ObservabilityEventInfo,
  ObservabilitySnapshotInfo,
  ObservabilityViewInfo,
  ToolMetricInfo
} from '../../shared/api.js'
import type { HarnessEvent } from '../../shared/types.js'
import { id } from '../util/ids.js'

const VERSION = 1
const MAX_EVENTS = 4_000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ARCHIVES = 3

interface PersistedMetrics {
  version: 1
  startedAt: number
  updatedAt: number
  eventCount: number
  sessionIds: string[]
  turnCount: number
  failedTurns: number
  toolCalls: number
  failedToolCalls: number
  approvalRequests: number
  blockedAudits: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  tools: ToolMetricInfo[]
}

interface ServiceOptions {
  maxEvents?: number
  maxFileBytes?: number
  maxArchives?: number
}

interface MetricAccumulator {
  total: number
  failures: number
  totalMs: number
  maxMs: number
}

function blankMetrics(startedAt = Date.now()): PersistedMetrics {
  return {
    version: VERSION,
    startedAt,
    updatedAt: startedAt,
    eventCount: 0,
    sessionIds: [],
    turnCount: 0,
    failedTurns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    approvalRequests: 0,
    blockedAudits: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    tools: []
  }
}

function finite(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

/** Removes credentials and personal user paths before telemetry is persisted. */
export function redactDiagnosticText(value: unknown, max = 2_000): string {
  const source = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '')
  return source
    .replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '[REDACTED_API_KEY]')
    .replace(/\bauthorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/[a-z]:\\users\\[^\\\s]+/gi, '<USER_HOME>')
    .replace(/\/home\/[^/\s]+/g, '<USER_HOME>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]'
  if (typeof value === 'string') return redactDiagnosticText(value, 1_000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, entry]) => {
      const safeKey = redactDiagnosticText(key, 100)
      const secretKey = /(?:api[_-]?key|token|secret|password|credential|authorization)/i.test(key)
      return [safeKey, secretKey ? '[REDACTED]' : sanitizeValue(entry, depth + 1)]
    }))
  }
  return undefined
}

function eventLevel(event: HarnessEvent): ObservabilityEventInfo['level'] {
  if (event.type === 'turn_end') return event.stopReason === 'error' && !event.cancelled ? 'error' : 'info'
  if (event.type === 'tool_end') return event.ok ? 'info' : 'error'
  if (event.type === 'notice') return event.level === 'warn' ? 'warn' : event.level
  if (event.type === 'audit') return event.level === 'blocked' ? 'error' : event.level
  if (event.type === 'status' && event.state === 'error') return 'error'
  if (event.type === 'subagent' && event.state === 'error') return 'error'
  return 'info'
}

export class ObservabilityService {
  private readonly metricsFile: string
  private readonly eventsFile: string
  private readonly maxEvents: number
  private readonly maxFileBytes: number
  private readonly maxArchives: number
  private metrics = blankMetrics()
  private events: ObservabilityEventInfo[] = []
  private toolStarted = new Map<string, { name: string; at: number }>()
  private turnStarted = new Map<string, { sessionId: string; at: number }>()
  private activeTools = new Map<string, string>()
  private activeTurns = new Set<string>()
  private writeTimer: NodeJS.Timeout | null = null
  private loaded = false

  constructor(private readonly dir: string, options: ServiceOptions = {}) {
    this.metricsFile = path.join(dir, 'metrics.json')
    this.eventsFile = path.join(dir, 'events.jsonl')
    this.maxEvents = Math.max(100, options.maxEvents ?? MAX_EVENTS)
    this.maxFileBytes = Math.max(4_096, options.maxFileBytes ?? MAX_FILE_BYTES)
    this.maxArchives = Math.max(1, options.maxArchives ?? MAX_ARCHIVES)
  }

  async init(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await fs.promises.mkdir(this.dir, { recursive: true })
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.metricsFile, 'utf8')) as PersistedMetrics
      if (saved.version === VERSION && Array.isArray(saved.tools) && Array.isArray(saved.sessionIds)) this.metrics = saved
    } catch {
      this.metrics = blankMetrics()
    }
    try {
      const lines = (await fs.promises.readFile(this.eventsFile, 'utf8')).split('\n').filter(Boolean)
      this.events = lines.slice(-this.maxEvents).flatMap((line) => {
        try {
          const event = JSON.parse(line) as ObservabilityEventInfo
          return event?.id && event?.type ? [event] : []
        } catch {
          return []
        }
      })
    } catch {
      this.events = []
    }
    await this.pruneArchives()
  }

  record(event: HarnessEvent, at = Date.now()): ObservabilityEventInfo | null {
    this.metrics.eventCount += 1
    this.metrics.updatedAt = at
    if (event.sessionId && !this.metrics.sessionIds.includes(event.sessionId)) {
      this.metrics.sessionIds.push(event.sessionId)
      if (this.metrics.sessionIds.length > 500) this.metrics.sessionIds.splice(0, this.metrics.sessionIds.length - 500)
    }

    let durationMs: number | undefined
    let turnId: string | undefined
    let toolCallId: string | undefined
    let name: string | undefined
    let ok: boolean | undefined
    let detail: string | undefined
    let metadata: Record<string, unknown> | undefined

    switch (event.type) {
      case 'turn_start':
        turnId = event.messageId
        this.turnStarted.set(`${event.sessionId}:${event.messageId}`, { sessionId: event.sessionId, at })
        this.activeTurns.add(event.sessionId)
        this.metrics.turnCount += 1
        break
      case 'turn_end': {
        turnId = event.messageId
        const key = `${event.sessionId}:${event.messageId}`
        const started = this.turnStarted.get(key)
        durationMs = started ? Math.max(0, at - started.at) : undefined
        this.turnStarted.delete(key)
        this.activeTurns.delete(event.sessionId)
        // A turn the user stopped is neither a success nor a failure.
        ok = event.cancelled ? undefined : event.stopReason !== 'error'
        if (ok === false) this.metrics.failedTurns += 1
        detail = event.error
        break
      }
      case 'tool_start': {
        toolCallId = event.toolCallId
        name = event.name
        const key = `${event.sessionId}:${event.agentId ?? 'root'}:${event.toolCallId}`
        this.toolStarted.set(key, { name: event.name, at })
        this.activeTools.set(key, event.name)
        metadata = {
          agentId: event.agentId,
          argumentKeys: event.args && typeof event.args === 'object' ? Object.keys(event.args as Record<string, unknown>).slice(0, 20) : []
        }
        break
      }
      case 'tool_end': {
        toolCallId = event.toolCallId
        name = event.name
        ok = event.ok
        const key = `${event.sessionId}:${event.agentId ?? 'root'}:${event.toolCallId}`
        const started = this.toolStarted.get(key)
        durationMs = started ? Math.max(0, at - started.at) : undefined
        this.toolStarted.delete(key)
        this.activeTools.delete(key)
        this.metrics.toolCalls += 1
        if (!event.ok) this.metrics.failedToolCalls += 1
        this.addToolMetric(event.name, event.ok, durationMs ?? 0)
        detail = event.summary || event.text
        metadata = { agentId: event.agentId, files: event.files?.length ?? 0 }
        break
      }
      case 'approval_request':
        this.metrics.approvalRequests += 1
        detail = event.request.detail
        name = event.request.tool
        break
      case 'audit':
        detail = event.message
        if (event.level === 'blocked') this.metrics.blockedAudits += 1
        break
      case 'notice':
        detail = event.text
        break
      case 'usage':
        this.metrics.inputTokens += finite(event.usage.input)
        this.metrics.outputTokens += finite(event.usage.output)
        this.metrics.cachedTokens += finite(event.usage.cachedInput)
        this.metrics.costUsd += finite(event.usage.costUsd)
        metadata = { input: finite(event.usage.input), output: finite(event.usage.output), cachedInput: finite(event.usage.cachedInput) }
        break
      case 'message':
        if (event.message.role !== 'assistant') return null
        metadata = { model: event.message.model }
        break
      case 'status':
        detail = event.detail
        break
      case 'subagent':
        name = event.agent
        detail = event.state === 'done' ? undefined : event.summary || event.prompt
        metadata = { childId: event.childId, parentChildId: event.parentChildId, depth: event.depth, model: event.model, state: event.state }
        break
      case 'settings_changed':
        detail = `Escopo: ${event.scope}`
        break
      case 'text_delta':
      case 'reasoning_delta':
      case 'plan':
      case 'diff':
      case 'session_start':
      case 'approval_resolved':
        break
    }

    const record: ObservabilityEventInfo = {
      id: id('obs'),
      ts: at,
      type: event.type,
      level: eventLevel(event),
      sessionId: event.sessionId || undefined,
      turnId,
      toolCallId,
      name,
      ok,
      durationMs,
      detail: detail ? redactDiagnosticText(detail, 600) : undefined,
      metadata: metadata ? sanitizeValue(metadata) as Record<string, unknown> : undefined
    }
    this.addRecord(record)
    this.scheduleWrite()
    return record
  }

  recordLog(scope: string, message: unknown, level: ObservabilityEventInfo['level'] = 'info'): ObservabilityEventInfo {
    this.metrics.eventCount += 1
    this.metrics.updatedAt = Date.now()
    const record: ObservabilityEventInfo = {
      id: id('log'),
      ts: Date.now(),
      type: 'log',
      level,
      name: redactDiagnosticText(scope, 80),
      detail: redactDiagnosticText(message, 1_000)
    }
    this.addRecord(record)
    this.scheduleWrite()
    return record
  }

  snapshot(): ObservabilitySnapshotInfo {
    const now = Date.now()
    return {
      startedAt: this.metrics.startedAt,
      updatedAt: this.metrics.updatedAt,
      uptimeMs: Math.max(0, now - this.metrics.startedAt),
      eventCount: this.metrics.eventCount,
      sessionCount: this.metrics.sessionIds.length,
      turnCount: this.metrics.turnCount,
      failedTurns: this.metrics.failedTurns,
      toolCalls: this.metrics.toolCalls,
      failedToolCalls: this.metrics.failedToolCalls,
      approvalRequests: this.metrics.approvalRequests,
      blockedAudits: this.metrics.blockedAudits,
      inputTokens: this.metrics.inputTokens,
      outputTokens: this.metrics.outputTokens,
      cachedTokens: this.metrics.cachedTokens,
      costUsd: this.metrics.costUsd,
      activeTurns: this.activeTurns.size,
      activeTools: this.activeTools.size,
      tools: [...this.metrics.tools].sort((a, b) => b.total - a.total)
    }
  }

  list(filters: { query?: string; level?: string; type?: string; sessionId?: string; limit?: number } = {}): ObservabilityEventInfo[] {
    const query = filters.query?.trim().toLowerCase()
    return [...this.events]
      .filter((event) => !filters.level || event.level === filters.level)
      .filter((event) => !filters.type || event.type === filters.type)
      .filter((event) => !filters.sessionId || event.sessionId === filters.sessionId)
      .filter((event) => !query || `${event.type} ${event.name ?? ''} ${event.detail ?? ''} ${event.sessionId ?? ''}`.toLowerCase().includes(query))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, Math.max(1, Math.min(1_000, filters.limit ?? 300)))
  }

  /** Every event still stored (oldest first), for analyses that need more than `list`'s 1000. */
  all(): ObservabilityEventInfo[] {
    return this.events.map((event) => ({ ...event }))
  }

  view(health: HealthComponentInfo[], filters: Parameters<ObservabilityService['list']>[0] = {}): ObservabilityViewInfo {
    const status = health.some((component) => component.status === 'error')
      ? 'error'
      : health.some((component) => component.status === 'warn')
        ? 'warn'
        : 'ok'
    return { snapshot: this.snapshot(), health: { status, components: health }, events: this.list(filters) }
  }

  async exportDiagnostic(destination: string, extras: Record<string, unknown> = {}): Promise<DiagnosticExportInfo> {
    const createdAt = new Date().toISOString()
    const payload = {
      kind: 'openclod-diagnostics',
      version: VERSION,
      createdAt,
      snapshot: this.snapshot(),
      events: this.list({ limit: 1_000 }),
      extras: sanitizeValue(extras)
    }
    const json = JSON.stringify(payload, null, 2)
    const sha256 = crypto.createHash('sha256').update(json).digest('hex')
    const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
    await fs.promises.mkdir(path.dirname(path.resolve(destination)), { recursive: true })
    await fs.promises.writeFile(destination, compressed)
    return { path: destination, bytes: compressed.length, sha256, createdAt }
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    await fs.promises.mkdir(this.dir, { recursive: true })
    const metricsTmp = `${this.metricsFile}.${process.pid}.tmp`
    await fs.promises.writeFile(metricsTmp, JSON.stringify(this.metrics, null, 2), 'utf8')
    await fs.promises.rename(metricsTmp, this.metricsFile)

    const eventsText = `${this.events.map((event) => JSON.stringify(event)).join('\n')}\n`
    if (Buffer.byteLength(eventsText) > this.maxFileBytes && fs.existsSync(this.eventsFile)) await this.rotate()
    const eventsTmp = `${this.eventsFile}.${process.pid}.tmp`
    await fs.promises.writeFile(eventsTmp, eventsText, 'utf8')
    await fs.promises.rename(eventsTmp, this.eventsFile)
    await this.pruneArchives()
  }

  private addToolMetric(name: string, ok: boolean, durationMs: number): void {
    let metric = this.metrics.tools.find((item) => item.name === name)
    if (!metric) {
      metric = { name, total: 0, failures: 0, totalMs: 0, averageMs: 0, maxMs: 0 }
      this.metrics.tools.push(metric)
    }
    metric.total += 1
    if (!ok) metric.failures += 1
    metric.totalMs += durationMs
    metric.maxMs = Math.max(metric.maxMs, durationMs)
    metric.averageMs = metric.total ? Math.round(metric.totalMs / metric.total) : 0
  }

  private addRecord(record: ObservabilityEventInfo): void {
    this.events.push(record)
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush().catch(() => undefined)
    }, 250)
  }

  private async rotate(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const archive = path.join(this.dir, `events-${stamp}.jsonl`)
    await fs.promises.rename(this.eventsFile, archive).catch(() => undefined)
  }

  private async pruneArchives(): Promise<void> {
    const files = (await fs.promises.readdir(this.dir).catch(() => [] as string[]))
      .filter((name) => /^events-.*\.jsonl$/.test(name))
      .sort()
    for (const stale of files.slice(0, Math.max(0, files.length - this.maxArchives))) {
      await fs.promises.rm(path.join(this.dir, stale), { force: true }).catch(() => undefined)
    }
  }
}
