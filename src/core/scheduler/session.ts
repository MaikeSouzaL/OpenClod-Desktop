import type { AgentMode } from '../../shared/types.js'
import type { ScheduledSurface, ScheduledTask } from './types.js'

/** The surfaces a scheduled task may open its session in. */
export const SCHEDULED_SURFACES: readonly ScheduledSurface[] = ['cowork', 'code']

/**
 * What one run of a task opens. A Cowork task gets the Cowork surface (its folder guidance, its place on Início) and the
 * autonomous mode the Cowork screen uses; a task from before the surface existed keeps opening a Code session.
 * An explicit mode on the task always wins.
 */
export function scheduledSession(task: Pick<ScheduledTask, 'surface' | 'mode'>): { surface: ScheduledSurface; mode: AgentMode } {
  const surface: ScheduledSurface = task.surface ?? 'code'
  return { surface, mode: task.mode ?? (surface === 'cowork' ? 'autonomous' : 'code') }
}
