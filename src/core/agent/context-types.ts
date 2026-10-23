import type { AgentMode, PolicyConfig } from '../../shared/types.js'
import type { MemoryFact } from '../memory/store.js'

/** Re-exported shape used by the context builder to avoid a cycle. */
export interface MemoryFactLike {
  text: string
}

export type { AgentMode, PolicyConfig, MemoryFact }
