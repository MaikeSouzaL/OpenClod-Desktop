import { describe, expect, it } from 'vitest'
import { inQuietHours, notificationForEvent } from '../src/main/notifications'
import type { NotificationPreferences } from '../src/shared/types'

function prefs(patch: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return { desktop: true, turnFinished: true, failures: true, approvals: true, minimumSeverity: 'success', quietStart: '22:00', quietEnd: '07:00', ...patch }
}

describe('desktop notifications', () => {
  it('filters turn completion, failure, approval and severities', () => {
    const noon = new Date('2026-10-25T12:00:00')
    expect(notificationForEvent({ type: 'turn_end', sessionId: 's', messageId: 'm', stopReason: 'stop' }, prefs(), noon)).toMatchObject({ severity: 'success', sessionId: 's' })
    expect(notificationForEvent({ type: 'turn_end', sessionId: 's', messageId: 'm', stopReason: 'error', error: 'boom' }, prefs({ turnFinished: false }), noon)).toMatchObject({ severity: 'error' })
    expect(notificationForEvent({ type: 'notice', sessionId: 's', level: 'warn', text: 'atenção' }, prefs({ minimumSeverity: 'error' }), noon)).toBeNull()
    expect(notificationForEvent({ type: 'notice', sessionId: 's', level: 'warn', text: 'atenção' }, prefs({ minimumSeverity: 'warning' }), noon)).toMatchObject({ severity: 'warning' })
    expect(
      notificationForEvent(
        { type: 'notice', sessionId: 's', level: 'warn', text: 'trocando de modelo', desktop: false },
        prefs(),
        noon
      )
    ).toBeNull()
    expect(notificationForEvent({ type: 'approval_request', sessionId: 's', request: { id: 'a', tool: 'x', title: 'Rodar', detail: 'npm test', risk: 'exec', sessionId: 's' } }, prefs(), noon)).toMatchObject({ severity: 'warning', actionable: 'approval' })
  })

  it('handles quiet hours across midnight and can disable desktop delivery', () => {
    expect(inQuietHours(prefs(), new Date('2026-10-25T23:30:00'))).toBe(true)
    expect(inQuietHours(prefs(), new Date('2026-10-25T06:30:00'))).toBe(true)
    expect(inQuietHours(prefs(), new Date('2026-10-25T12:00:00'))).toBe(false)
    expect(inQuietHours(prefs({ quietStart: '08:00', quietEnd: '17:00' }), new Date('2026-10-25T12:00:00'))).toBe(true)
    expect(notificationForEvent({ type: 'turn_end', sessionId: 's', messageId: 'm', stopReason: 'error' }, prefs({ desktop: false }), new Date('2026-10-25T12:00:00'))).toBeNull()
  })
})
