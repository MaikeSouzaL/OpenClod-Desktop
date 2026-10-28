/** Where a scheduled task's session opens. */
export type TaskSurface = 'cowork' | 'code'

/**
 * The type a task form starts with. A blank new task is Cowork work; a task saved before the type existed (and a developer
 * template that does not say) keeps opening a Code session, which is what it has always done.
 */
export function surfaceFor(source?: { surface?: TaskSurface }): TaskSurface {
  return source ? (source.surface ?? 'code') : 'cowork'
}
