import type { z } from 'zod'
import type {
  AgentDefinition,
  AgentMode,
  ApprovalRequest,
  FileChange,
  HarnessEvent,
  PlanItem,
  PolicyConfig,
  ReasoningEffort,
  RiskLevel,
  ToolResult,
  ToolSpec,
  Usage
} from '../../shared/types.js'
import type { WorkspaceGuard } from '../security/policy.js'
import type { BrowserLayer } from '../browser/layer.js'
import type { ComputerLayer } from '../computer/layer.js'
import type { SkillLibrary } from '../skills/library.js'
import type { MemoryStore } from '../memory/store.js'
import type { ProjectMemory } from '../memory/project.js'

export interface Tracker {
  markRead(path: string): void
  hasRead(path: string): boolean
  recordChange(path: string, before: string | null, after: string | null): void
  changes(): FileChange[]
  readFiles(): string[]
}

export interface SubagentSpec {
  label: string
  prompt: string
  /**
   * With `agent`: names (or globs) that can only narrow the definition's toolset.
   * Without it (legacy `task`): the child's toolset; defaults to a safe read/test subset.
   */
  tools?: string[]
  /** Legacy `task` only; a named agent brings its own mode. */
  mode?: AgentMode
  /** Name of the agent definition to run. Undefined = the generic worker behind `task`. */
  agent?: string
}

export interface SubagentOutcome {
  ok: boolean
  text: string
  /** Id of the child that ran; empty when the call was refused before anything started. */
  sessionId: string
  usage?: Usage
}

/** Input for the `create_agent` tool: a new specialist saved as markdown. */
export interface CreateAgentInput {
  name: string
  description: string
  systemPrompt: string
  tools?: string[]
  canCall?: string[] | '*'
  mode?: AgentMode
  model?: string
  effort?: ReasoningEffort
  maxTurns?: number
  scope?: 'user' | 'project'
}

/** The agents the current caller may delegate to, as the tools see them. */
export interface AgentCatalog {
  /** Level of the caller: 0 for the user's session. */
  depth: number
  /** Deepest level that may still be spawned (HarnessLimits.maxAgentDepth). */
  maxDepth: number
  /** Visible agents the caller may call; empty when delegation is unavailable. */
  callable(): AgentDefinition[]
  get(name: string): AgentDefinition | undefined
}

export interface McpSearchHit {
  id: string
  name: string
  description: string
  version?: string
  transport: string
  installed: boolean
  needs: string[]
  source: 'catalog' | 'registry'
  docs?: string
}

export interface McpInstallResult {
  ok: boolean
  name?: string
  state?: string
  tools?: string[]
  missing?: string[]
  needsOAuth?: boolean
  error?: string
}

/** Self-installation surface exposed to the agent (implemented by the app). */
export interface McpToolService {
  search(query: string, limit?: number): Promise<{ catalog: McpSearchHit[]; registry: McpSearchHit[]; installed: string[]; warning?: string }>
  install(input: {
    id: string
    env?: Record<string, string>
    headers?: Record<string, string>
    name?: string
    /** Custom server outside the catalog. */
    url?: string
    command?: string
    args?: string[]
  }): Promise<McpInstallResult>
  list(): Array<{ name: string; state: string; transport: string; tools: string[]; error?: string }>
}

/**
 * The project's long-term memory index (AI-Memory sidecar). The native
 * markdown wiki stays the source of truth; this interface lets tools recall
 * and mirror pages without importing the main-process class.
 */
export interface AiMemoryToolService {
  recall(projectId: string, query: string, limit?: number): Promise<{ text: string; hits: number }>
  writePage(
    projectId: string,
    input: { path: string; title: string; body: string; tags?: string[]; pinned?: boolean; tier?: string }
  ): Promise<{ path: string; pageId: string }>
}

export interface ToolContext {
  sessionId: string
  cwd: string
  mode: AgentMode
  policy: PolicyConfig
  workspace: WorkspaceGuard
  signal: AbortSignal
  tracker: Tracker
  emit(event: HarnessEvent): void
  approve(request: Omit<ApprovalRequest, 'id' | 'sessionId'>): Promise<boolean>
  setPlan(items: PlanItem[]): void
  runSubagent(spec: SubagentSpec): Promise<SubagentOutcome>
  agents: AgentCatalog
  /** Writes a new specialist to the user's agents folder and registers it now. */
  createAgent(input: CreateAgentInput): Promise<{ path: string; agent: AgentDefinition }>
  services: {
    browser: BrowserLayer
    computer: ComputerLayer
    skills: SkillLibrary
    memory: MemoryStore
    projectMemory: ProjectMemory
    mcp?: McpToolService
    aiMemory?: AiMemoryToolService
  }
  /** Project scope used by the long-term memory index. */
  projectId?: string
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface ToolDescription {
  title: string
  detail: string
  preview?: string
}

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodTypeAny
  /** Pre-built JSON Schema (used by MCP tools whose schema is already known). */
  jsonSchema?: Record<string, unknown>
  risk: RiskLevel
  /** Safe to run concurrently with other parallelSafe tools. */
  parallelSafe: boolean
  /** Tools hidden unless the session mode enables them. */
  requires?: 'network' | 'computer' | 'coding'
  /** Description sent to the model when it depends on the session (e.g. the agents it may call). Falls back to `description`. */
  dynamicDescription?(ctx: Pick<ToolContext, 'agents'>): string
  describe(rawArgs: unknown): ToolDescription
  execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ValidatedSpec extends ToolSpec {
  risk: RiskLevel
}
