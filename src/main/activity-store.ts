import fs from 'node:fs'
import path from 'node:path'
import type { ActivityItem, ActivitySeverity } from '../shared/api.js'
import { budgetAmount, budgetKindLabel } from '../shared/budget.js'
import type { HarnessEvent } from '../shared/types.js'
import { id } from '../core/util/ids.js'

const MAX_ITEMS = 2500
const DEDUPE_WINDOW_MS = 30_000

interface ActivityFile {
  version: 1
  items: ActivityItem[]
}

interface ActivityDraft {
  type: string
  severity: ActivitySeverity
  title: string
  detail: string
  actionRequired?: boolean
  actionable?: ActivityItem['actionable']
  metadata?: Record<string, unknown>
}

function clean(value: unknown, max = 1000): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function draft(event: HarnessEvent): ActivityDraft | null {
  switch (event.type) {
    case 'session_start':
      return { type: 'session', severity: 'info', title: 'Sessão iniciada', detail: 'O runner da sessão foi criado.', actionable: 'session' }
    case 'turn_start':
      return { type: 'turn', severity: 'info', title: 'Tarefa iniciada', detail: `Mensagem ${event.messageId}`, actionable: 'session' }
    case 'tool_start':
      return { type: 'tool', severity: 'info', title: `Ferramenta: ${event.name}`, detail: JSON.stringify(event.args ?? {}).slice(0, 500), actionable: 'tool', metadata: { toolCallId: event.toolCallId, agentId: event.agentId } }
    case 'tool_end':
      if (event.name === 'report_limitation') {
        const raw = event.data?.limitation
        const limitation = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        const title = clean(limitation.title, 120) || clean(event.summary, 120) || 'Limitação do harness'
        return {
          type: 'limitation',
          severity: 'warning',
          title: `Limitação: ${title}`,
          detail: clean(limitation.difficulty) || clean(event.text),
          actionRequired: limitation.severity !== 'degraded',
          actionable: 'tool',
          metadata: { toolCallId: event.toolCallId }
        }
      }
      return {
        type: 'tool',
        severity: event.ok ? 'success' : 'error',
        title: `${event.name}: ${event.ok ? 'concluída' : 'falhou'}`,
        detail: event.summary || clean(event.text) || '',
        actionable: 'tool',
        metadata: { toolCallId: event.toolCallId, files: event.files, agentId: event.agentId }
      }
    case 'limitation':
      return {
        type: 'limitation',
        severity: 'warning',
        title: `Limitação: ${clean(event.report.title, 120) || 'falha do turno'}`,
        detail: clean(event.report.difficulty) || clean(event.report.error),
        actionRequired: event.report.severity !== 'degraded',
        actionable: 'session'
      }
    case 'approval_request':
      return { type: 'approval', severity: 'warning', title: 'Aprovação necessária', detail: `${event.request.title}: ${event.request.detail}`, actionRequired: true, actionable: 'approval', metadata: { approvalId: event.request.id } }
    case 'budget': {
      const info = event.info
      const used = budgetAmount(info.kind, info.used)
      const limit = budgetAmount(info.kind, info.limit)
      const context = info.contextWindow ? ` · contexto ${Math.round((info.contextTokens / info.contextWindow) * 100)}%` : ''
      return {
        type: 'budget',
        severity: 'warning',
        title: `Orçamento do turno esgotado (${budgetKindLabel(info.kind)})`,
        detail: `${used} de ${limit} · ${info.iterations} iterações · ${info.toolCalls} ferramentas${context}`,
        actionRequired: true,
        actionable: 'tool',
        metadata: { ...info }
      }
    }
    case 'approval_resolved':
      return { type: 'approval', severity: event.approved ? 'success' : 'warning', title: event.approved ? 'Aprovação concedida' : 'Aprovação recusada', detail: event.id, actionable: 'approval' }
    case 'turn_end':
      if (event.cancelled) return { type: 'turn', severity: 'info', title: 'Tarefa cancelada', detail: 'Interrompida pelo usuário.', actionable: 'session' }
      return {
        type: 'turn',
        severity: event.stopReason === 'error' ? 'error' : 'success',
        title: event.stopReason === 'error' ? 'Tarefa falhou' : 'Tarefa concluída',
        detail: clean(event.error) || `Motivo: ${event.stopReason}`,
        actionable: 'session'
      }
    case 'notice':
      return { type: 'notice', severity: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warning' : 'info', title: 'Aviso do harness', detail: clean(event.text) }
    case 'audit':
      return { type: 'audit', severity: event.level === 'blocked' ? 'error' : event.level === 'warn' ? 'warning' : 'info', title: 'Auditoria', detail: clean(event.message) }
    case 'subagent': {
      const ending = event.state === 'done' || event.state === 'error' || event.state === 'cancelled'
      return {
        type: 'agent',
        severity: event.state === 'error' ? 'error' : event.state === 'cancelled' ? 'warning' : ending ? 'success' : 'info',
        title: `${event.label}: ${event.state}`,
        detail: clean(event.summary || event.prompt || event.agent || ''),
        actionable: 'session',
        metadata: { childId: event.childId, parentChildId: event.parentChildId, depth: event.depth, model: event.model }
      }
    }
    case 'settings_changed':
      return { type: 'settings', severity: 'info', title: 'Configuração atualizada', detail: `Escopo: ${event.scope}`, actionable: 'settings' }
    default:
      return null
  }
}

export class ActivityStore {
  private readonly file: string
  private items: ActivityItem[] = []
  private loaded = false
  private writeTimer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    this.file = path.join(dir, 'activity.json')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as ActivityFile
      this.items = parsed.version === 1 && Array.isArray(parsed.items) ? parsed.items.filter((item) => item && typeof item.id === 'string').slice(-MAX_ITEMS) : []
    } catch {
      this.items = []
    }
  }

  record(event: HarnessEvent): void {
    const value = draft(event)
    if (!value) return
    const now = Date.now()
    const duplicate = [...this.items].reverse().find((item) => now - item.createdAt < DEDUPE_WINDOW_MS && item.sessionId === event.sessionId && item.type === value.type && item.title === value.title && item.detail === value.detail && !item.archived)
    if (duplicate) {
      duplicate.count += 1
      duplicate.updatedAt = now
      this.scheduleWrite()
      return
    }
    this.items.push({
      id: id('act'),
      sessionId: event.sessionId || undefined,
      createdAt: now,
      updatedAt: now,
      read: false,
      archived: false,
      count: 1,
      ...value
    })
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS)
    this.scheduleWrite()
  }

  /** Adds an entry that does not come from a harness event (for example the improvement review). */
  addNote(note: ActivityDraft & { sessionId?: string }): ActivityItem {
    const now = Date.now()
    const { sessionId, ...value } = note
    const item: ActivityItem = {
      id: id('act'),
      sessionId: sessionId || undefined,
      createdAt: now,
      updatedAt: now,
      read: false,
      archived: false,
      count: 1,
      ...value,
      title: clean(value.title, 200),
      detail: clean(value.detail, 1000)
    }
    this.items.push(item)
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS)
    this.scheduleWrite()
    return { ...item }
  }

  /** Every item, archived ones included, for analysis (the inbox `list` hides one side). */
  all(): ActivityItem[] {
    return this.items.map((item) => ({ ...item }))
  }

  list(filters: { query?: string; type?: string; severity?: string; archived?: boolean; limit?: number } = {}): ActivityItem[] {
    const query = filters.query?.trim().toLowerCase()
    return this.items
      .filter((item) => item.archived === Boolean(filters.archived))
      .filter((item) => !filters.type || item.type === filters.type)
      .filter((item) => !filters.severity || item.severity === filters.severity)
      .filter((item) => !query || `${item.title} ${item.detail} ${item.sessionId ?? ''}`.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(1000, filters.limit ?? 300)))
  }

  setRead(itemId: string, read: boolean): boolean {
    const item = this.items.find((candidate) => candidate.id === itemId)
    if (!item) return false
    item.read = read
    item.updatedAt = Date.now()
    this.scheduleWrite()
    return true
  }

  archive(itemId: string, archived = true): boolean {
    const item = this.items.find((candidate) => candidate.id === itemId)
    if (!item) return false
    item.archived = archived
    item.updatedAt = Date.now()
    this.scheduleWrite()
    return true
  }

  clear(archivedOnly = true): number {
    const before = this.items.length
    this.items = archivedOnly ? this.items.filter((item) => !item.archived) : []
    this.scheduleWrite()
    return before - this.items.length
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const payload: ActivityFile = { version: 1, items: this.items }
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await fs.promises.rename(tmp, this.file)
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush().catch(() => undefined)
    }, 250)
  }
}
