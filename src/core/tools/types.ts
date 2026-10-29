import type { z } from 'zod'
import type {
  AgentDefinition,
  AgentMode,
  ApprovalRequest,
  EnvironmentProfile,
  FileChange,
  HarnessEvent,
  ImagePart,
  PlanItem,
  PolicyConfig,
  QuestionAnswer,
  QuestionSpec,
  ReasoningEffort,
  RiskLevel,
  SessionSurface,
  ToolResult,
  ToolSpec,
  Usage
} from '../../shared/types.js'
import type { WorkspaceGuard } from '../security/policy.js'
import type { BrowserLayer } from '../browser/layer.js'
import type { ComputerLayer } from '../computer/layer.js'
import type { TerminalRunner } from '../terminal/runner.js'
import type { SkillLibrary } from '../skills/library.js'
import type { MemoryStore } from '../memory/store.js'
import type { ProjectMemory } from '../memory/project.js'
import type { McpCallOptions } from '../mcp/client.js'
import type { ResolvedToolPolicy } from '../mcp/policy.js'

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
  /** Credential names (never values) copied from `reuseCredentialsFrom`. */
  reused?: string[]
}

/** Result of restarting MCP servers (`mcp_reload`). */
export interface McpReloadReport {
  servers: Array<{ name: string; state: string; tools: number; error?: string; hint?: string }>
}

/** One tool that can be enabled with `tool_load`. */
export interface ToolSearchHit {
  name: string
  description: string
  risk: RiskLevel
  requires?: string
  /** Already sent in the current request. */
  loaded: boolean
}

/** Self-installation surface exposed to the agent (implemented by the app). */
export interface McpToolService {
  search(query: string, limit?: number): Promise<{ catalog: McpSearchHit[]; registry: McpSearchHit[]; installed: string[]; warning?: string }>
  /** Servers and their tool names/descriptions, without schemas. */
  catalog(): Array<{
    name: string
    state: string
    transport: string
    tools: Array<{ name: string; description: string }>
    error?: string
  }>
  /** Input schema for one tool, fetched only when the model asks. */
  schema(server: string, tool: string): { name: string; description: string; inputSchema: Record<string, unknown> } | undefined
  /** Executes a tool on any connected server. */
  call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal, options?: McpCallOptions): Promise<ToolResult>
  /** What the user's settings decide for one tool (exposure, approval, risk); undefined when the server is unknown. */
  policy?(server: string, tool: string): ResolvedToolPolicy | undefined
  /** Known fix for an error message of this server, in pt-BR (the app knows the server's configuration). */
  hint?(server: string, message: string): string | undefined
  /** Restarts the MCP servers from the saved settings (all of them, or only `server`) and rebuilds their tools. */
  reload?(server?: string): Promise<McpReloadReport>
  install(input: {
    id: string
    env?: Record<string, string>
    headers?: Record<string, string>
    name?: string
    /** Custom server outside the catalog. */
    url?: string
    command?: string
    args?: string[]
    /** Name of an already configured server whose credentials are copied inside the app (values never reach the model). */
    reuseCredentialsFrom?: string
  }): Promise<McpInstallResult>
  list(): Array<{
    name: string
    state: string
    transport: string
    tools: string[]
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>
    prompts: Array<{
      name: string
      description?: string
      arguments: Array<{ name: string; description?: string; required?: boolean }>
    }>
    resourceTemplates?: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }>
    error?: string
    /** Known fix for `error`, in pt-BR. */
    hint?: string
    /** Tools hidden by the include/exclude filter or `toolPolicy: deny`. */
    hidden?: number
    /** Tools sent to the model only after tool_search/tool_load. */
    deferred?: number
    /** Tools left out because their schema cannot be offered to a model API. */
    skipped?: Array<{ tool: string; reason: string }>
    /** "reconectando (tentativa 2/5)" while the client is retrying. */
    reconnect?: string
  }>
  readResource(server: string, uri: string): Promise<Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>>
  getPrompt(server: string, name: string, args?: Record<string, string>): Promise<{
    description?: string
    messages: Array<{ role: string; content: string }>
  }>
}

/**
 * The project's long-term memory index (AI-Memory sidecar). The native
 * markdown wiki stays the source of truth; this interface lets tools recall
 * and mirror pages without importing the main-process class.
 */
export interface AiMemoryToolService {
  recall(projectId: string, query: string, limit?: number): Promise<{ text: string; hits: number }>
  /** Ranked full-text search of the index, best first; `path` is `pages/<slug>.md` for the project's wiki pages. */
  search?(projectId: string, query: string, limit?: number): Promise<Array<{ path: string; title: string; snippet: string; rank?: number }>>
  /** Opens a page of the index by its path (`pages/<slug>.md`, `s/<hash>.md`...). */
  readPage?(projectId: string, pagePath: string): Promise<{ path: string; title: string; body: string; tags: string[] } | null>
  relatedMarkdown(projectId: string, query: string, excludePath?: string, limit?: number): Promise<string>
  writePage(
    projectId: string,
    input: { path: string; title: string; body: string; tags?: string[]; pinned?: boolean; tier?: string }
  ): Promise<{ path: string; pageId: string }>
}

export interface ToolContext {
  sessionId: string
  /** Current call id, set by the runner right before execute(). */
  toolCallId?: string
  /** Whether the active model actually receives tool images. */
  vision?: boolean
  /** The active model id: Computer Use reads in which coordinates it points at a screenshot (see pointerGridFor). */
  model?: string
  cwd: string
  mode: AgentMode
  policy: PolicyConfig
  workspace: WorkspaceGuard
  signal: AbortSignal
  tracker: Tracker
  /** Execution environment selected for this session. Missing means local. */
  environment?: EnvironmentProfile
  /** Desktop tab that owns the session (chat, cowork or code); missing outside a session. */
  surface?: SessionSurface
  emit(event: HarnessEvent): void
  /** UI-only live progress (never sent back to the model). */
  progress?(text: string, data?: Record<string, unknown>): void
  approve(request: Omit<ApprovalRequest, 'id' | 'sessionId'>): Promise<boolean>
  /** Structured questions to the user (ask_user); null when skipped/timed out. */
  ask?(request: { questions: QuestionSpec[] }): Promise<QuestionAnswer[] | null>
  setPlan(items: PlanItem[]): void
  runSubagent(spec: SubagentSpec): Promise<SubagentOutcome>
  agents: AgentCatalog
  /** Writes a new specialist to the user's agents folder and registers it now. */
  createAgent(input: CreateAgentInput): Promise<{ path: string; agent: AgentDefinition }>
  /** Tools allowed by the current mode/policy but not sent in the request. */
  searchTools?(query: string, limit?: number): ToolSearchHit[]
  /** Complete catalog for the current mode, independent of the query. */
  listTools?(): ToolSearchHit[]
  /** Enables tools for the next model steps; returns what was accepted. */
  loadTools?(names: string[]): { loaded: string[]; rejected: Array<{ name: string; reason: string }> }
  services: {
    browser: BrowserLayer
    computer: ComputerLayer
    skills: SkillLibrary
    memory: MemoryStore
    projectMemory: ProjectMemory
    mcp?: McpToolService
    aiMemory?: AiMemoryToolService
    /** The session's visible integrated terminal; absent in isolated harness tests. */
    terminal?: TerminalRunner
    /** Describes a picture with a model that reads images (the vision relay); null when none answered. */
    describeImage?(image: ImagePart, question?: string): Promise<{ text: string; via: string } | null>
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
  /**
   * Approval override from the user's per-tool MCP settings (`toolPolicy`/`approvalTools`): 'ask' always asks, even in
   * unrestricted mode; 'allow' skips the prompt in `ask`/`accept-edits`/`auto` modes. It never overrides a deny.
   */
  approval?: 'allow' | 'ask'
  /** Set on first-class MCP tools (`mcp__server__tool`); `deferred` tools are found with tool_search/tool_load. */
  mcp?: { server: string; tool: string; deferred: boolean; title?: string }
  /**
   * Per-call risk/approval for tools that front other tools (`mcp_call`): resolved from the arguments right
   * before the permission decision. `deny` blocks the call with that reason.
   */
  resolveCall?(args: unknown): { risk?: RiskLevel; approval?: 'allow' | 'ask'; deny?: string } | undefined
  /** Description sent to the model when it depends on the session (e.g. the agents it may call). Falls back to `description`. */
  dynamicDescription?(ctx: Pick<ToolContext, 'agents'>): string
  describe(rawArgs: unknown): ToolDescription
  execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ValidatedSpec extends ToolSpec {
  risk: RiskLevel
}
