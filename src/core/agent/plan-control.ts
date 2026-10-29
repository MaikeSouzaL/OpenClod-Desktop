import { id } from '../util/ids.js'
import type { Message, PlanItem } from '../../shared/types.js'

/**
 * What the user can do with a plan from the dock once the turn stopped: resume it at one step (▶) or give it up (🗑).
 * Pure functions, so the runner and a session without a live runner apply the same rules.
 */

/** A step the user can resume: the one that was running, or one the agent left blocked. Done steps are finished work. */
export function canResumePlanItem(item: PlanItem): boolean {
  return item.status === 'active' || item.status === 'blocked'
}

/**
 * Reopens `itemId` as the active step and marks it interrupted, so the next turn gets the `<retomada>` notice and the
 * plan in the turn context says "retome daqui". Any other active step goes back to pending: there is one step in
 * progress. Returns null when the step is not in the plan or is already done.
 */
export function resumePlanAt(plan: PlanItem[], itemId: string, now = Date.now()): PlanItem[] | null {
  const target = plan.find((item) => item.id === itemId)
  if (!target || !canResumePlanItem(target)) return null
  return plan.map((item) => {
    if (item.id === itemId) return { ...item, status: 'active' as const, interrupted: true, endedAt: item.endedAt ?? now }
    if (item.status === 'active') return { ...item, status: 'pending' as const, interrupted: undefined }
    return item
  })
}

/**
 * Left in the history when the user discards a plan: the update_plan calls are still there, and without it the next
 * turn would pick the abandoned steps up again.
 */
export function discardedPlanNotice(plan: PlanItem[]): Message {
  const open = plan.filter((item) => item.status !== 'done')
  return {
    id: id('msg'),
    role: 'user',
    ts: Date.now(),
    hidden: true,
    parts: [
      {
        type: 'text',
        text: [
          '<plano-descartado>',
          'O usuário descartou o plano anterior e desistiu dele. Não retome nem execute estes passos, a menos que ele peça de novo:',
          ...open.slice(0, 12).map((item) => `- ${item.text}`),
          'Atenda apenas ao que ele pedir a partir de agora.',
          '</plano-descartado>'
        ].join('\n')
      }
    ]
  }
}
