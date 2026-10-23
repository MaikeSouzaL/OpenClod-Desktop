import type { AgentDefinition, HarnessLimits } from '../../shared/types.js'

/** Levels of agents calling agents (the user's session is level 0). */
export const DEFAULT_MAX_AGENT_DEPTH = 3

/** Structural caps of the agent tree. Tests may lower them through AgentRuntimeEnv.caps. */
export interface AgentCaps {
  /** Children one runner may have running at the same time; extra calls wait for a free slot. */
  maxConcurrent: number
  /** Children started by one user turn, across the whole tree. */
  maxPerTurn: number
  /** How many times one agent may appear in its own ancestor chain (counting the new child). */
  maxRepeat: number
}

export const DEFAULT_AGENT_CAPS: AgentCaps = {
  maxConcurrent: 6,
  maxPerTurn: 24,
  maxRepeat: 2
}

/** Budget of a level-1 child; deeper levels get 65% of the level above, down to a floor. */
const LEVEL_ONE = { maxIterations: 24, maxToolCalls: 100, maxWallClockMs: 10 * 60 * 1000 }
const LEVEL_FACTOR = 0.65
const FLOORS = { maxIterations: 6, maxToolCalls: 24, maxWallClockMs: 2 * 60 * 1000, maxTokens: 50_000 }
/** Each level may spend at most this share of the token / cost budget of its caller. */
const BUDGET_SHARE = 0.5

/**
 * Limits for a child at `depth` (1 = called by the user's session). They never
 * exceed the caller's and shrink with every level; `maxTurns` of the definition
 * is an explicit choice for the iteration cap and is only bounded by the caller.
 */
export function childLimits(parent: HarnessLimits, depth: number, def: Pick<AgentDefinition, 'maxTurns'> = {}): HarnessLimits {
  const scale = LEVEL_FACTOR ** Math.max(0, depth - 1)
  const scaled = (base: number, floor: number): number => Math.max(floor, Math.round(base * scale))
  const iterations = def.maxTurns ?? scaled(LEVEL_ONE.maxIterations, FLOORS.maxIterations)
  return {
    ...parent,
    maxIterations: Math.max(1, Math.min(parent.maxIterations, iterations)),
    maxToolCalls: Math.min(parent.maxToolCalls, scaled(LEVEL_ONE.maxToolCalls, FLOORS.maxToolCalls)),
    maxWallClockMs: Math.min(parent.maxWallClockMs, scaled(LEVEL_ONE.maxWallClockMs, FLOORS.maxWallClockMs)),
    maxTokens: Math.min(parent.maxTokens, Math.max(FLOORS.maxTokens, Math.floor(parent.maxTokens * BUDGET_SHARE))),
    // 0 means "no cost cap" in the runner; keep it that way.
    maxCostUsd: parent.maxCostUsd > 0 ? parent.maxCostUsd * BUDGET_SHARE : 0
  }
}
