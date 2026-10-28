import type { PlanItem } from '../../shared/types.js'

/**
 * The model rewrites the whole checklist on every `update_plan`; it never sends
 * timestamps. The runner stamps when an item starts and when it leaves `active`,
 * so the UI can show what happened during each step.
 */
export function mergePlanTimes(previous: PlanItem[], items: PlanItem[], now: number): PlanItem[] {
  const before = new Map(previous.map((item) => [item.id, item]))
  return items.map((item) => {
    const previousItem = before.get(item.id)
    // The app was closed while this step was active; the first update after the
    // resume reopens it and the clock starts from zero for the new attempt.
    const resumed = Boolean(previousItem?.interrupted) && item.status === 'active'
    const startedAt = resumed
      ? now
      : item.status === 'active' && previousItem?.status !== 'active'
        ? now
        : (item.startedAt ?? previousItem?.startedAt)
    const endedAt = item.status === 'active' ? undefined : previousItem?.status === 'active' ? now : (item.endedAt ?? previousItem?.endedAt)
    const interrupted =
      resumed || item.status !== 'active' ? undefined : (item.interrupted ?? previousItem?.interrupted)
    // Activity is written by the runner after each tool call; the model never
    // sends it, so keep the previous log across plan rewrites.
    const activity = item.activity ?? previousItem?.activity
    return {
      ...item,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      ...(activity?.length ? { activity } : {})
    }
  })
}
