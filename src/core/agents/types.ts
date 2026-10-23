import type {
  AgentMode,
  HarnessLimits,
  PolicyConfig,
  ProviderConfig,
  ReasoningEffort
} from '../../shared/types.js'
import type { BrowserLayer } from '../browser/layer.js'
import type { ComputerLayer } from '../computer/layer.js'
import type { HookRunner } from '../hooks/runner.js'
import type { MemoryStore } from '../memory/store.js'
import type { WorkspaceGuard } from '../security/policy.js'
import type { SkillLibrary } from '../skills/library.js'
import type { Tracker } from '../tools/types.js'

// The definition types live in shared/types.ts so the renderer can use them.
export type { AgentDefinition, AgentLoadWarning, AgentSource, AgentsListing } from '../../shared/types.js'

/**
 * Everything the runtime needs to know about the runner that is making an
 * `agent` call. The runner fills it from its own deps, so a child built by the
 * runtime can in turn become a caller.
 */
export interface SubagentCaller {
  /** Id of the calling runner: the user's session id, or the `childId` of a subagent. */
  sessionId: string
  /** The user's session. Events and approvals of the whole tree are reported under it. */
  rootSessionId: string
  /** 0 for the user's session, 1 for its children, ... */
  depth: number
  /** Name of the definition the caller runs as; undefined for the user's session. */
  agentName?: string
  /** Agent names from the first child down to the caller (empty for the user's session). */
  chain: string[]
  cwd: string
  mode: AgentMode
  policy: PolicyConfig
  providerConfig: ProviderConfig
  effort?: ReasoningEffort
  limits: HarnessLimits
  /** Tools the caller can use right now. A child never gets more than this. */
  availableTools: string[]
  /** Abort signal of the caller's current turn. Aborting it aborts every child. */
  signal: AbortSignal
  hooks?: HookRunner
  workspace: WorkspaceGuard
  tracker: Tracker
  project: { name: string; branch?: string; isGitRepo: boolean }
  services: {
    browser: BrowserLayer
    computer: ComputerLayer
    skills: SkillLibrary
    memory: MemoryStore
  }
}
