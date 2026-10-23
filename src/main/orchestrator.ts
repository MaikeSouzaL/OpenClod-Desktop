import fs from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type {
  AppSettings,
  ApprovalRequest,
  CapabilityReport,
  FileChange,
  HarnessEvent,
  ImagePart,
  Message,
  Project,
  RunState,
  SessionMeta,
  SessionState,
  ToolResult
} from '../shared/types.js'
import { DEFAULT_LIMITS } from '../shared/types.js'
import { SessionStore } from '../core/session/store.js'
import { FileTracker } from '../core/session/tracker.js'
import { SettingsStore } from './settings.js'
import { SkillLibrary } from '../core/skills/library.js'
import { MemoryStore } from '../core/memory/store.js'
import { ProjectMemory } from '../core/memory/project.js'
import { BrowserLayer } from '../core/browser/layer.js'
import { ComputerLayer } from '../core/computer/layer.js'
import { ToolRegistry } from '../core/tools/registry.js'
import type { ToolDef } from '../core/tools/types.js'
import { createAgentRegistry, type AgentRegistry } from '../core/agents/registry.js'
import { writeAgentFile } from '../core/agents/loader.js'
import { agentForgeTools } from '../core/agents/tools.js'
import { spawnAgent, type AgentRuntimeEnv } from '../core/agents/runtime.js'
import { fsTools } from '../core/tools/fs.js'
import { searchTools } from '../core/tools/search.js'
import { shellTools, killSessionProcesses } from '../core/tools/shell.js'
import { gitTools } from '../core/tools/git.js'
import { webTools } from '../core/tools/web.js'
import { browserTools } from '../core/tools/browser.js'
import { computerTools } from '../core/tools/computer.js'
import { planTools } from '../core/tools/plan.js'
import { projectMemoryTools } from '../core/memory/tools.js'
import { SessionRunner } from '../core/agent/runner.js'
import type { RunnerSnapshot } from '../core/agent/runner.js'
import { createProvider, hasCredentials, resolveApiKey } from '../core/providers/index.js'
import { WorkspaceGuard } from '../core/security/policy.js'
import { mergeRules, ruleForApproval } from '../core/security/rules.js'
import { HookRunner } from '../core/hooks/runner.js'
import { ApprovalStore, loadProjectSettings, mergeHooks } from '../core/config/project.js'
import { McpClient, mcpQualifiedName, type McpServerConfig } from '../core/mcp/client.js'
import { describeToolchains, toolchains } from '../core/util/toolchains.js'
import { ensureProjectInstructions } from '../core/agent/context.js'
import { listMcpPresets, type McpPresetInfo } from '../core/mcp/presets.js'
import { discoverForProvider, type DiscoveryResult } from '../core/providers/discovery.js'
import { externalAgentTools, killExternalAgentProcesses } from '../core/tools/external-agent.js'
import { id } from '../core/util/ids.js'
import type { AgentDefinition, AgentsListing, PolicyConfig, ReasoningEffort } from '../shared/types.js'

interface PendingApproval {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  sessionId: string
  signature: string
  request: ApprovalRequest
}

export interface OrchestratorOptions {
  userData: string
  broadcast: (event: HarnessEvent) => void
  /** Optional log sink (the main process writes to %APPDATA%\Forja\logs\main.log). */
  log?: (message: string) => void
}

export class Orchestrator {
  readonly store: SessionStore
  readonly settings: SettingsStore
  readonly computer: ComputerLayer
  readonly skills: SkillLibrary
  private baseRegistry: ToolRegistry
  private mcpClients = new Map<string, McpClient>()
  private mcpTools: ToolDef[] = []
  private runners = new Map<string, SessionRunner>()
  private trackers = new Map<string, FileTracker>()
  private browsers = new Map<string, BrowserLayer>()
  private memories = new Map<string, MemoryStore>()
  private projectMemories = new Map<string, ProjectMemory>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, PendingApproval>()
  private sessionAllow = new Map<string, Set<string>>()
  private sessionPolicies = new Map<string, PolicyConfig>()
  private sessionHooks = new Map<string, HookRunner>()
  /** Live subagents per user session, so aborting the session can also stop their processes. */
  private agentChildren = new Map<string, Set<string>>()
  private readonly approvals: ApprovalStore
  private eventQueue: Promise<void> = Promise.resolve()
  private readonly probeBrowser = new BrowserLayer()

  constructor(private readonly options: OrchestratorOptions) {
    this.store = new SessionStore(userDataPath(options.userData, 'data'))
    this.settings = new SettingsStore(userDataPath(options.userData, 'config'))
    this.approvals = new ApprovalStore(path.join(userDataPath(options.userData, 'data'), 'permissions'))
    this.computer = new ComputerLayer()
    this.skills = new SkillLibrary([])
    this.baseRegistry = buildBaseRegistry()
  }

  /**
   * Effective policy and hooks for a session: app settings + project
   * `.forja/settings*.json` (+ `.claude/` when enabled) + "always allow"
   * choices saved for the project.
   */
  private sessionConfig(state: SessionState): { policy: PolicyConfig; hooks: HookRunner } {
    const settings = this.settings.get()
    const project = loadProjectSettings(state.meta.cwd, { importClaude: settings.importClaudeSettings })
    const policy: PolicyConfig = {
      ...settings.policy,
      rules: mergeRules(settings.policy.rules, project.rules, { allow: this.approvals.load(state.meta.projectId) })
    }
    const hooks = new HookRunner(mergeHooks(settings.hooks, project.hooks), state.meta.cwd, state.meta.id)
    if (project.sources.length) {
      this.onEvent({
        type: 'audit',
        sessionId: state.meta.id,
        level: 'info',
        message: `configuração do projeto carregada: ${project.sources.map((s) => path.relative(state.meta.cwd, s)).join(', ')}`
      })
    }
    return { policy, hooks }
  }

  async init(): Promise<void> {
    await this.settings.init()
    await this.store.init()

    // Every registered project gets the canonical CLAUDE.md if it is missing.
    // Existing files are never touched.
    for (const project of this.store.listProjects()) {
      const created = ensureProjectInstructions(project.path, project.name)
      if (created) this.options.log?.(`CLAUDE.md criado em ${created}`)
    }

    const userSkills = path.join(this.options.userData, 'skills')
    await ensureStarterSkills(userSkills)
    this.skills.addRoot(userSkills, 'usuario')
    await this.skills.reload()

    await this.startMcpServers()
    void toolchains() // warm the cache; the probes spawn processes
  }

  /* ------------------------------- registry ------------------------------ */

  private rebuildRegistry(): void {
    this.baseRegistry = buildBaseRegistry()
    for (const tool of this.mcpTools) {
      // Names are capped at 60 chars, so two long tool names can collide; keep the first.
      if (!this.baseRegistry.get(tool.name)) this.baseRegistry.register(tool)
    }
    // Existing runners hold stale references; dispose them so the next message
    // rebuilds with the new toolset.
    for (const sessionId of [...this.runners.keys()]) this.dropRunner(sessionId)
  }

  private async startMcpServers(): Promise<void> {
    for (const client of this.mcpClients.values()) await client.stop()
    this.mcpClients.clear()
    this.mcpTools = []

    for (const config of this.settings.get().mcpServers ?? []) {
      if (!config.enabled) continue
      const client = new McpClient(config as McpServerConfig)
      try {
        await client.start()
        this.mcpClients.set(config.name, client)
        for (const tool of client.toolsList()) {
          this.mcpTools.push(mcpToolDef(client, tool.name, tool.description, tool.inputSchema))
        }
      } catch (err) {
        client.lastError = (err as Error).message
        this.mcpClients.set(config.name, client)
      }
    }
    this.rebuildRegistry()
  }

  async restartMcp(): Promise<void> {
    await this.startMcpServers()
  }

  /* ------------------------------- sessions ------------------------------ */

  async createSession(input: {
    projectId: string
    cwd: string
    mode: SessionMeta['mode']
    surface?: SessionMeta['surface']
    providerId: string
    model: string
    title?: string
  }): Promise<SessionMeta> {
    return this.store.createSession(input)
  }

  async ensureRunner(sessionId: string): Promise<SessionRunner> {
    const existing = this.runners.get(sessionId)
    if (existing) return existing

    const state = await this.store.loadSession(sessionId)
    if (!state) throw new Error(`sessão não encontrada: ${sessionId}`)
    ensureProjectInstructions(state.meta.cwd)
    const settings = this.settings.get()
    const providerConfig =
      this.settings.providerConfig(state.meta.providerId) ??
      settings.providers.find((p) => p.id === settings.defaultProviderId) ??
      settings.providers[0]
    if (!providerConfig) throw new Error('nenhum provedor configurado')
    if (!hasCredentials(providerConfig, this.settings.resolver())) {
      throw new Error(
        `o provedor "${providerConfig.label}" não tem credencial configurada. Abra Configurações → Provedores.`
      )
    }

    const provider = createProvider({ ...providerConfig, model: state.meta.model || providerConfig.model }, this.settings.resolver())
    const tracker = this.trackers.get(sessionId) ?? new FileTracker(state.meta.cwd)
    if (state.changes?.length) tracker.restore(state.changes)
    this.trackers.set(sessionId, tracker)

    const browser = this.browsers.get(sessionId) ?? new BrowserLayer()
    this.browsers.set(sessionId, browser)

    const memory =
      this.memories.get(sessionId) ??
      new MemoryStore(path.join(userDataPath(this.options.userData, 'data'), 'memory', `${state.meta.projectId}.json`))
    this.memories.set(sessionId, memory)

    // One markdown wiki per project (not per session), shared by every agent
    // and every model working in that project.
    const projectMemory =
      this.projectMemories.get(state.meta.projectId) ??
      new ProjectMemory(path.join(userDataPath(this.options.userData, 'data'), 'memory', 'projects', state.meta.projectId))
    this.projectMemories.set(state.meta.projectId, projectMemory)

    const workspace = new WorkspaceGuard([state.meta.cwd, ...(settings.policy.allowedRoots ?? [])].filter(Boolean))
    const project = this.store.listProjects().find((p) => p.id === state.meta.projectId)
    const branch = await gitBranch(state.meta.cwd)
    const { policy, hooks } = this.sessionConfig(state)
    this.sessionPolicies.set(sessionId, policy)
    this.sessionHooks.set(sessionId, hooks)

    const agents = this.agentRegistryFor(state.meta.cwd)
    const agentEnv = this.agentEnv(agents, describeToolchains(await toolchains()))
    const runner = new SessionRunner({
      sessionId,
      cwd: state.meta.cwd,
      mode: state.meta.mode,
      provider,
      providerConfig: { ...providerConfig, model: state.meta.model || providerConfig.model },
      effort: state.meta.effort,
      registry: this.baseRegistry,
      policy,
      limits: settings.limits ?? DEFAULT_LIMITS,
      tracker,
      workspace,
      services: {
        browser,
        computer: this.computer,
        skills: this.skills,
        memory,
        projectMemory
      },
      project: {
        name: project?.name ?? path.basename(state.meta.cwd),
        branch: branch ?? undefined,
        isGitRepo: Boolean(branch)
      },
      hooks,
      toolOutputDir: this.toolOutputDir(),
      systemExtra: describeToolchains(await toolchains()),
      emit: (event) => this.onEvent(event),
      approve: (request) => this.approve(request),
      agents,
      autoAgents: Boolean(settings.autoAgents),
      createAgent: (input) => this.createAgentFromTool(input, agents, state.meta.cwd),
      runSubagent: (spec, caller) => spawnAgent(agentEnv, caller, spec),
      persist: (snapshot) => this.persist(sessionId, snapshot),
      initial: { messages: state.messages, plan: state.plan, usage: state.usage },
      depth: 0
    })

    this.runners.set(sessionId, runner)
    return runner
  }

  private dropRunner(sessionId: string): void {
    const runner = this.runners.get(sessionId)
    runner?.abort()
    this.runners.delete(sessionId)
  }

  /* -------------------------------- agents -------------------------------- */

  private userAgentsDir(): string {
    return path.join(this.options.userData, 'agents')
  }

  /**
   * Built-in agents plus the user's (`<userData>/agents`) and the project's (`.forja/agents`);
   * `.claude/agents` too when the Claude settings import is on. Cheap, so it is re-read whenever a runner is built.
   */
  agentRegistryFor(cwd?: string): AgentRegistry {
    return createAgentRegistry({
      userDir: this.userAgentsDir(),
      cwd,
      importClaude: Boolean(this.settings.get().importClaudeSettings)
    })
  }

  /** Every agent the folder `cwd` can use (hidden utilities included, flagged `hidden`) plus the files that failed to load. */
  listAgents(cwd?: string): AgentsListing {
    return this.agentRegistryFor(cwd).listing()
  }

  /**
   * Writes a new agent file (`user`: <userData>/agents, `project`: <cwd>/.forja/agents) and refreshes idle
   * sessions so their next turn sees it. Throws a readable error for invalid input or an existing name.
   */
  createAgent(input: { scope: 'user' | 'project'; cwd?: string; agent: AgentDefinition; overwrite?: boolean }): { path: string; listing: AgentsListing } {
    if (input.scope === 'project' && !input.cwd) throw new Error('informe a pasta do projeto para criar um agente de projeto')
    const dir = input.scope === 'project' ? path.join(input.cwd as string, '.forja', 'agents') : this.userAgentsDir()
    const file = writeAgentFile(dir, input.agent, { overwrite: input.overwrite })
    this.settingsChanged()
    return { path: file, listing: this.listAgents(input.cwd) }
  }

  /**
   * Creates a specialist from the `create_agent` tool and registers it in the
   * live session registry. Unlike the settings-screen helper above, this must
   * NOT drop runners: the calling turn is still running.
   */
  async createAgentFromTool(
    input: import('../core/tools/types.js').CreateAgentInput,
    registry: AgentRegistry,
    cwd?: string
  ): Promise<{ path: string; agent: AgentDefinition }> {
    const scope = input.scope === 'project' ? 'project' : 'user'
    if (scope === 'project' && !cwd) throw new Error('agente de projeto exige uma pasta de projeto')
    const dir = scope === 'project' ? path.join(cwd as string, '.forja', 'agents') : this.userAgentsDir()
    const def: AgentDefinition = {
      name: input.name,
      description: input.description.trim(),
      systemPrompt: input.systemPrompt.trim(),
      mode: input.mode ?? 'code',
      tools: input.tools,
      canCall: input.canCall,
      model: input.model,
      effort: input.effort,
      maxTurns: input.maxTurns,
      source: scope
    }
    const file = writeAgentFile(dir, def)
    const saved: AgentDefinition = { ...def, file }
    registry.register(saved)
    return { path: file, agent: saved }
  }

  /** What the agent runtime needs from the app: providers, the tool registry, events and approvals. */
  private agentEnv(agents: AgentRegistry, extraContext: string): AgentRuntimeEnv {
    const resolver = this.settings.resolver()
    return {
      agents,
      tools: this.baseRegistry,
      extraContext,
      createProvider: (config) => {
        if (!hasCredentials(config, resolver)) {
          throw new Error(`o provedor "${config.label}" não tem credencial configurada`)
        }
        return createProvider(config, resolver)
      },
      findProvider: (providerId) => this.settings.providerConfig(providerId),
      emit: (event) => this.onEvent(event),
      approve: (request) => this.approve(request),
      toolOutputDir: this.toolOutputDir(),
      onChildStart: (rootSessionId, childId) => {
        const set = this.agentChildren.get(rootSessionId) ?? new Set<string>()
        set.add(childId)
        this.agentChildren.set(rootSessionId, set)
      },
      onChildEnd: (rootSessionId, childId) => {
        const set = this.agentChildren.get(rootSessionId)
        set?.delete(childId)
        if (set && !set.size) this.agentChildren.delete(rootSessionId)
      }
    }
  }

  /** Background processes of a session's subagents die with the session's turn. */
  private killAgentChildren(rootSessionId: string): void {
    for (const childId of this.agentChildren.get(rootSessionId) ?? []) {
      killSessionProcesses(childId)
      killExternalAgentProcesses(childId)
    }
  }

  /** Runs a whole turn. `keepTitle` preserves a title set by the caller (scheduled tasks). */
  async send(sessionId: string, text: string, images?: ImagePart[], keepTitle = false): Promise<void> {
    const runner = await this.ensureRunner(sessionId)
    if (runner.messages.length === 0 && !keepTitle) {
      const title = text.replace(/\s+/g, ' ').slice(0, 60)
      await this.store.patchMeta(sessionId, { title })
    }
    await runner.send(text, { images })
  }

  /**
   * Starts a turn and returns as soon as it is accepted. The renderer must not
   * wait for the whole turn (which can take minutes); progress arrives as
   * events. Failures before the turn starts are thrown here.
   */
  async startSend(sessionId: string, text: string, images?: ImagePart[]): Promise<void> {
    const runner = await this.ensureRunner(sessionId)
    if (runner.busy) throw new Error('já existe um turno em execução nesta sessão')
    if (runner.messages.length === 0) {
      const title = text.replace(/\s+/g, ' ').slice(0, 60)
      await this.store.patchMeta(sessionId, { title })
    }
    void runner.send(text, { images }).catch((err) => {
      this.onEvent({
        type: 'notice',
        sessionId,
        level: 'error',
        text: `falha ao iniciar turno: ${(err as Error).message}`
      })
    })
  }

  async abort(sessionId: string): Promise<void> {
    this.runners.get(sessionId)?.abort()
    this.killAgentChildren(sessionId)
    killSessionProcesses(sessionId)
    killExternalAgentProcesses(sessionId)
    await this.browsers.get(sessionId)?.close()
    for (const [approvalId, pending] of [...this.pending.entries()]) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pending.delete(approvalId)
      this.onEvent({ type: 'approval_resolved', sessionId, id: approvalId, approved: false })
      pending.resolve(false)
    }
    this.onEvent({ type: 'status', sessionId, state: 'cancelled' })
  }

  async setMode(sessionId: string, mode: SessionMeta['mode']): Promise<void> {
    this.dropRunner(sessionId)
    await this.store.patchMeta(sessionId, { mode })
  }

  async setEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
    this.dropRunner(sessionId)
    await this.store.patchMeta(sessionId, { effort: effort ?? undefined })
  }

  async setModel(sessionId: string, providerId: string, model: string): Promise<void> {
    this.dropRunner(sessionId)
    await this.store.patchMeta(sessionId, { providerId, model })
  }

  /**
   * Settings changed: drop idle runners so the next turn picks up the new
   * policy/model/tool registry. A busy turn keeps the settings it started with.
   */
  settingsChanged(): void {
    for (const [sessionId, runner] of [...this.runners.entries()]) {
      if (runner.busy) continue
      this.dropRunner(sessionId)
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.dispose(sessionId, 'session_deleted')
    this.sessionAllow.delete(sessionId)
    await this.store.deleteSession(sessionId)
    // Full outputs of large tool results were spilled here (see SessionRunner).
    await fs.promises.rm(path.join(this.toolOutputDir(), sessionId), { recursive: true, force: true }).catch(() => undefined)
  }

  /** Where oversized tool outputs are written so the model can page through them. */
  private toolOutputDir(): string {
    return path.join(userDataPath(this.options.userData, 'data'), 'tool-output')
  }

  /** Fires the SessionEnd hook once; a hook must never block closing or deleting. */
  private async fireSessionEnd(sessionId: string, reason: string): Promise<void> {
    const hooks = this.sessionHooks.get(sessionId)
    if (!hooks) return
    this.sessionHooks.delete(sessionId)
    try {
      const outcome = await hooks.notify('SessionEnd', { reason }, AbortSignal.timeout(5000))
      for (const text of outcome?.warnings ?? []) this.onEvent({ type: 'notice', sessionId, level: 'warn', text })
    } catch {
      /* ignore */
    }
  }

  async renameSession(sessionId: string, title: string): Promise<SessionState | null> {
    const clean = title.trim().slice(0, 120)
    if (!clean) throw new Error('título vazio')
    await this.store.patchMeta(sessionId, { title: clean })
    return this.store.getSession(sessionId)
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<SessionState | null> {
    await this.store.patchMeta(sessionId, { archived })
    return this.store.getSession(sessionId)
  }

  async compactSession(sessionId: string): Promise<SessionState | null> {
    const state = this.store.getSession(sessionId)
    if (!state) return null
    const runner = this.runners.get(sessionId)
    if (!runner) throw new Error('a sessão ainda não tem um executor ativo; envie uma mensagem primeiro')
    await runner.compactNow()
    return this.store.getSession(sessionId)
  }

  async dispose(sessionId: string, reason = 'other'): Promise<void> {
    await this.fireSessionEnd(sessionId, reason)
    this.dropRunner(sessionId)
    this.killAgentChildren(sessionId)
    killSessionProcesses(sessionId)
    await this.browsers.get(sessionId)?.close()
    this.browsers.delete(sessionId)
    this.memories.delete(sessionId)
  }

  async shutdown(): Promise<void> {
    // Sessions whose runner was dropped by a settings change still get SessionEnd.
    for (const sessionId of new Set([...this.runners.keys(), ...this.sessionHooks.keys()])) await this.dispose(sessionId, 'app_quit')
    for (const client of this.mcpClients.values()) await client.stop()
    await this.computer.close()
  }

  /* ------------------------------- approvals ----------------------------- */

  async approve(request: ApprovalRequest): Promise<boolean> {
    const signature = `${request.tool}::${request.preview ?? request.detail}`
    if (this.sessionAllow.get(request.sessionId)?.has(signature)) return true

    this.onEvent({ type: 'approval_request', sessionId: request.sessionId, request })
    void this.sessionHooks
      .get(request.sessionId)
      ?.run('Notification', { message: `O Forja precisa de aprovação: ${request.title} — ${request.detail}`.slice(0, 500) })
      .catch(() => undefined)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.onEvent({
          type: 'approval_resolved',
          sessionId: request.sessionId,
          id: request.id,
          approved: false
        })
        resolve(false)
      }, 5 * 60 * 1000)
      this.pending.set(request.id, { resolve, timer, sessionId: request.sessionId, signature, request })
    })
  }

  resolveApproval(approvalId: string, approved: boolean, always = false): void {
    const pending = this.pending.get(approvalId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(approvalId)
    if (approved && always) {
      const set = this.sessionAllow.get(pending.sessionId) ?? new Set<string>()
      set.add(pending.signature)
      this.sessionAllow.set(pending.sessionId, set)
      // Remember the choice for the project as a rule (Claude Code style), so
      // new sessions in the same folder do not ask again. Destructive tools
      // are only remembered for this session.
      const projectId = this.store.getSession(pending.sessionId)?.meta.projectId
      // Without a preview the rule would cover every use of the tool.
      if (projectId && pending.request.risk !== 'destructive' && pending.request.preview) {
        const rule = ruleForApproval(pending.request.tool, pending.request.preview ?? '')
        try {
          this.approvals.add(projectId, rule)
          this.sessionPolicies.get(pending.sessionId)?.rules?.allow.push(rule)
        } catch {
          /* session-level allow still applies */
        }
      }
    }
    this.onEvent({
      type: 'approval_resolved',
      sessionId: pending.sessionId,
      id: approvalId,
      approved
    })
    pending.resolve(approved)
  }

  /* ------------------------------- events -------------------------------- */

  private onEvent(event: HarnessEvent): void {
    this.options.broadcast(event)
    this.eventQueue = this.eventQueue
      .then(() => this.store.appendEvent(event.sessionId, event))
      .catch(() => undefined)

    if (event.type === 'status') {
      const existing = this.store.getSession(event.sessionId)
      if (existing) existing.state = event.state
    }
  }

  private persist(sessionId: string, snapshot: RunnerSnapshot): void {
    const existingTimer = this.persistTimers.get(sessionId)
    if (existingTimer) clearTimeout(existingTimer)
    const timer = setTimeout(() => {
      this.persistTimers.delete(sessionId)
      void this.flush(sessionId, snapshot)
    }, 350)
    this.persistTimers.set(sessionId, timer)
  }

  private async flush(sessionId: string, snapshot: RunnerSnapshot): Promise<void> {
    const current = await this.store.loadSession(sessionId)
    if (!current) return
    const next: SessionState = {
      ...current,
      messages: stripImages(snapshot.messages),
      plan: snapshot.plan,
      usage: snapshot.usage,
      changes: this.trackers.get(sessionId)?.changes() ?? current.changes,
      state: snapshot.state
    }
    await this.store.saveSession(next)
  }

  async flushAll(): Promise<void> {
    for (const sessionId of this.persistTimers.keys()) {
      const timer = this.persistTimers.get(sessionId)
      if (timer) clearTimeout(timer)
      this.persistTimers.delete(sessionId)
      const runner = this.runners.get(sessionId)
      if (runner) await this.flush(sessionId, runner.snapshot())
    }
    await this.eventQueue
  }

  /* ------------------------------- info ---------------------------------- */

  async capabilities(): Promise<CapabilityReport> {
    const settings = this.settings.get()
    const browserStatus = await this.probeBrowser.status()
    return {
      computer: this.computer.status(),
      browser: browserStatus,
      mcp: [...this.mcpClients.entries()].map(([name, client]) => ({
        name,
        command: (settings.mcpServers ?? []).find((m) => m.name === name)?.command ?? '',
        state: client.state,
        tools: client.toolsList().map((t) => t.name),
        error: client.lastError ?? undefined
      })),
      providers: settings.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        configured: hasCredentials(provider, this.settings.resolver())
      })),
      toolchains: await toolchains(),
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`
    }
  }

  /** Lists the models a saved provider serves (Ollama, LM Studio, OpenAI-compatible, Anthropic). */
  async discoverModels(providerId: string): Promise<DiscoveryResult> {
    const config = this.settings.providerConfig(providerId)
    if (!config) throw new Error('provedor não encontrado')
    if (config.kind === 'mock') return { models: [], source: 'openai', error: 'o provedor de teste não tem modelos' }
    return discoverForProvider(config, resolveApiKey(config, this.settings.resolver()))
  }

  mcpPresets(): McpPresetInfo[] {
    return listMcpPresets()
  }

  async testProvider(providerId: string): Promise<{ ok: boolean; detail: string }> {
    const config = this.settings.providerConfig(providerId)
    if (!config) return { ok: false, detail: 'provedor não encontrado' }
    if (!hasCredentials(config, this.settings.resolver())) {
      return { ok: false, detail: 'sem credencial configurada' }
    }
    const provider = createProvider(config, this.settings.resolver())
    let text = ''
    let error: string | undefined
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      for await (const event of provider.stream({
        system: 'Responda apenas: pong',
        messages: [
          { id: 'test', role: 'user', ts: Date.now(), parts: [{ type: 'text', text: 'ping' }] }
        ],
        tools: [],
        maxTokens: 16,
        signal: controller.signal
      })) {
        if (event.type === 'text_delta') text += event.text
        if (event.type === 'end' && event.stopReason === 'error') error = event.error
      }
      clearTimeout(timer)
    } catch (err) {
      error = (err as Error).message
    }
    if (error) return { ok: false, detail: error }
    return { ok: true, detail: text.trim().slice(0, 120) || 'resposta vazia (mas a conexão funcionou)' }
  }

  /**
   * Optional dictation cleanup: one short, tool-less call to the default
   * provider. It never throws and never blocks insertion — on any failure the
   * raw transcription is returned unchanged.
   */
  async polishText(text: string): Promise<string> {
    const raw = text.trim()
    if (!raw) return raw
    const settings = this.settings.get()
    const config =
      this.settings.providerConfig(settings.defaultProviderId) ??
      settings.providers.find((provider) => provider.kind !== 'mock')
    if (!config || config.kind === 'mock' || !hasCredentials(config, this.settings.resolver())) return raw

    const provider = createProvider(config, this.settings.resolver())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    let out = ''
    try {
      for await (const event of provider.stream({
        system:
          'Você corrige texto ditado em português do Brasil. Corrija pontuação, acentuação e vícios de linguagem; preserve o sentido, nomes próprios, números, caminhos e comandos. Responda somente com o texto final, sem comentários e sem aspas.',
        messages: [{ id: id('msg'), role: 'user', ts: Date.now(), parts: [{ type: 'text', text: raw }] }],
        tools: [],
        maxTokens: 1200,
        temperature: 0.1,
        signal: controller.signal
      })) {
        if (event.type === 'text_delta') out += event.text
        if (event.type === 'end' && event.stopReason === 'error') return raw
      }
    } catch {
      return raw
    } finally {
      clearTimeout(timer)
    }
    return out.trim() || raw
  }

  /* ------------------------------- files --------------------------------- */

  async tree(root: string, depth = 2): Promise<Array<{ path: string; dir: boolean; size: number }>> {
    const out: Array<{ path: string; dir: boolean; size: number }> = []
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', '__pycache__', '.cache'])
    const walk = async (dir: string, level: number): Promise<void> => {
      if (level > depth || out.length > 800) return
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (skip.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        const relative = path.relative(root, full).replace(/\\/g, '/')
        if (entry.isDirectory()) {
          out.push({ path: relative, dir: true, size: 0 })
          await walk(full, level + 1)
        } else {
          const stat = await fs.promises.stat(full).catch(() => null)
          out.push({ path: relative, dir: false, size: stat?.size ?? 0 })
        }
      }
    }
    await walk(root, 1)
    return out
  }

  async readProjectFile(root: string, relative: string): Promise<{ content: string; truncated: boolean }> {
    const base = path.resolve(root)
    const target = path.resolve(base, relative)
    const rel = path.relative(base, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('caminho fora do projeto')
    }
    const stat = await fs.promises.stat(target)
    if (!stat.isFile()) throw new Error('não é um arquivo')
    if (stat.size > 2 * 1024 * 1024) throw new Error('arquivo grande demais para o visualizador')
    const buffer = await fs.promises.readFile(target)
    if (buffer.includes(0)) throw new Error('arquivo binário: use a ferramenta de leitura do agente')
    return { content: buffer.toString('utf8'), truncated: false }
  }

  changes(sessionId: string): FileChange[] {
    return this.trackers.get(sessionId)?.changes() ?? this.store.getSession(sessionId)?.changes ?? []
  }

  async screenshot(): Promise<{ image: string; width: number; height: number }> {
    const shot = await this.computer.captureScreen(1400)
    return { image: shot.image.data, width: shot.width, height: shot.height }
  }

  approvalsFor(sessionId: string): ApprovalRequest[] {
    const state = this.store.getSession(sessionId)
    return state?.approvals ?? []
  }

  async addProject(folder: string, name?: string): Promise<Project> {
    const project = await this.store.addProject(folder, name)
    ensureProjectInstructions(project.path, project.name)
    return project
  }

  /* ------------------------------- memory --------------------------------- */

  private memoryForProject(projectId: string): ProjectMemory {
    const existing = this.projectMemories.get(projectId)
    if (existing) return existing
    const memory = new ProjectMemory(
      path.join(userDataPath(this.options.userData, 'data'), 'memory', 'projects', projectId)
    )
    this.projectMemories.set(projectId, memory)
    return memory
  }

  private requireProject(projectId: string): Project {
    const project = this.store.listProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('projeto não encontrado')
    return project
  }

  memoryStats(projectId: string): Promise<Awaited<ReturnType<ProjectMemory['stats']>>> {
    this.requireProject(projectId)
    return this.memoryForProject(projectId).stats()
  }

  memoryList(projectId: string): Promise<Awaited<ReturnType<ProjectMemory['listPages']>>> {
    this.requireProject(projectId)
    return this.memoryForProject(projectId).listPages()
  }

  memoryRead(projectId: string, slug: string): Promise<Awaited<ReturnType<ProjectMemory['readPage']>>> {
    this.requireProject(projectId)
    return this.memoryForProject(projectId).readPage(slug)
  }

  memoryDelete(projectId: string, slug: string): Promise<boolean> {
    this.requireProject(projectId)
    return this.memoryForProject(projectId).deletePage(slug)
  }

  memoryRoot(projectId: string): string {
    this.requireProject(projectId)
    return this.memoryForProject(projectId).root
  }
}

/* ------------------------------- helpers -------------------------------- */

function userDataPath(base: string, child: string): string {
  return path.join(base, child)
}

function buildBaseRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(...fsTools)
    .register(...searchTools)
    .register(...shellTools)
    .register(...gitTools)
    .register(...webTools)
    .register(...browserTools)
    .register(...computerTools)
    .register(...planTools)
    .register(...projectMemoryTools)
    .register(...agentForgeTools)
    .register(...externalAgentTools)
}

function mcpToolDef(
  client: McpClient,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>
): ToolDef {
  const name = mcpQualifiedName(client.name, toolName)
  return {
    name,
    description: `[MCP ${client.name}] ${description || toolName}`,
    schema: z.record(z.unknown()),
    jsonSchema: inputSchema,
    // approvalTools of the server map to `destructive`, which still asks in auto mode.
    risk: client.toolRisk(toolName),
    parallelSafe: false,
    requires: undefined,
    describe(args) {
      return {
        title: `MCP ${client.name}/${toolName}`,
        detail: JSON.stringify(args).slice(0, 600),
        preview: `${client.name}/${toolName}`
      }
    },
    async execute(args, ctx): Promise<ToolResult> {
      return client.callTool(toolName, args, undefined, ctx.signal)
    }
  }
}

/**
 * Screenshots are useful inside a turn (the model sees them) but must not be
 * written to the session JSON: a single 4K capture is ~1.5 MB of base64.
 * The textual summary stays, so the transcript remains readable.
 */
function stripImages(messages: Message[]): Message[] {
  return messages.map((message) => {
    const hasImages = message.parts.some((part) => part.type === 'tool_result' && part.images?.length)
    if (!hasImages) return message
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.type === 'tool_result' && part.images?.length ? { ...part, images: undefined } : part
      )
    }
  })
}

function gitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout.trim() || null)
    })
  })
}

async function ensureStarterSkills(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true })
  const starter: Record<string, string> = {
    'revisao-de-codigo': `---
name: revisao-de-codigo
description: Checklist para revisar mudanças de código com foco em correção, segurança e regressões.
---

# Revisão de código

1. Leia o diff completo antes de opinar.
2. Verifique contratos nas bordas: entradas nulas, erros de rede, timeouts.
3. Procure regressões silenciosas: retornos vazios tratados como sucesso.
4. Cheque tratamento de erro: o erro é propagado ou engolido?
5. Segurança: injeção, path traversal, segredos em log, permissões ampliadas.
6. Testes: existe teste que falharia se a mudança estivesse errada?
7. Cite arquivo:linha e classifique por severidade.
`,
    'depuracao-sistematica': `---
name: depuracao-sistematica
description: Método para reproduzir, isolar e corrigir falhas sem chutar.
---

# Depuração sistemática

1. Reproduza: comando exato, saída exata, ambiente.
2. Reduza: menor entrada que ainda falha.
3. Formule uma hipótese falsificável.
4. Instrumente (log, teste, breakpoint) para testá-la.
5. Corrija a causa, não o sintoma.
6. Reexecute o teste que falhou **e** os vizinhos.
7. Registre a causa raiz no relatório final.
`
  }
  for (const [name, content] of Object.entries(starter)) {
    const file = path.join(dir, name, 'SKILL.md')
    if (!fs.existsSync(file)) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, content, 'utf8')
    }
  }
}
