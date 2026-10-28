import type { NotificationPreferences } from '../shared/types.js'
import type { HarnessEvent } from '../shared/types.js'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

export interface DesktopNotification {
  title: string
  body: string
  severity: NotificationSeverity
  sessionId?: string
  actionable?: 'session' | 'approval'
}

const RANK: Record<NotificationSeverity, number> = { info: 0, success: 1, warning: 2, error: 3 }

function minutes(value: string | undefined): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null
  const [hours, mins] = value.split(':').map(Number)
  if (hours > 23 || mins > 59) return null
  return hours * 60 + mins
}

export function inQuietHours(preferences: NotificationPreferences, date = new Date()): boolean {
  const start = minutes(preferences.quietStart)
  const end = minutes(preferences.quietEnd)
  if (start === null || end === null || start === end) return false
  const current = date.getHours() * 60 + date.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

export function notificationForEvent(
  event: HarnessEvent,
  preferences: NotificationPreferences,
  date = new Date()
): DesktopNotification | null {
  if (!preferences.desktop || inQuietHours(preferences, date)) return null
  let notification: DesktopNotification | null = null
  if (event.type === 'turn_end') {
    if (event.cancelled) return null
    if (event.stopReason === 'error' && preferences.failures) {
      notification = { title: 'Openclod — tarefa falhou', body: (event.error || 'O turno terminou com erro.').slice(0, 180), severity: 'error', sessionId: event.sessionId, actionable: 'session' }
    } else if (event.stopReason !== 'error' && preferences.turnFinished) {
      notification = { title: 'Openclod — tarefa concluída', body: `O turno terminou (${event.stopReason}).`, severity: 'success', sessionId: event.sessionId, actionable: 'session' }
    }
  } else if (event.type === 'approval_request' && preferences.approvals) {
    notification = { title: 'Openclod — aprovação necessária', body: `${event.request.title}: ${event.request.detail}`.slice(0, 180), severity: 'warning', sessionId: event.sessionId, actionable: 'approval' }
  } else if (event.type === 'notice' && event.desktop !== false && ((event.level === 'error' && preferences.failures) || event.level === 'warn')) {
    notification = { title: `Openclod — ${event.level === 'error' ? 'erro' : 'aviso'}`, body: event.text.slice(0, 180), severity: event.level === 'error' ? 'error' : 'warning', sessionId: event.sessionId }
  } else if (event.type === 'subagent' && event.state === 'error' && preferences.failures) {
    notification = { title: `Openclod — agente ${event.label} falhou`, body: (event.summary || event.prompt || '').slice(0, 180), severity: 'error', sessionId: event.sessionId }
  }
  if (!notification || RANK[notification.severity] < RANK[preferences.minimumSeverity]) return null
  return notification
}
