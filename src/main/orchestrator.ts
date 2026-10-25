import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  CapabilityReport,
  FileChange,
  HarnessEvent,
  ImagePart,
  Message,
  McpServerSettings,
  Project,
  ProviderConfig,
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
import { McpClient, mcpQualifiedName, normalizeMcpServerSettings, type McpServerConfig } from '../core/mcp/client.js'
import { buildCatalogServer, catalogEntry, searchMcpCatalog, MCP_CATALOG } from '../core/mcp/catalog.js'
import { installFromRegistry, searchMcpRegistry } from '../core/mcp/registry.js'
import type { McpToolService } from '../core/tools/types.js'
import { mcpTools } from '../core/tools/mcp.js'
import { describeToolchains, toolchains } from '../core/util/toolchains.js'
import { ensureProjectInstructions } from '../core/agent/context.js'
import { resourcePath } from '../core/util/resources.js'
import { listMcpPresets, type McpPresetInfo } from '../core/mcp/presets.js'
import { discoverForProvider, type DiscoveryResult } from '../core/providers/discovery.js'
import { importClaudeCatalog, type ClaudeImportReport } from './claude-import.js'
import { AiMemoryService } from './ai-memory.js'
import { InboxStore } from './inbox.js'
import { McpOAuthManager } from './mcp-oauth.js'
import { externalAgentTools, killExternalAgentProcesses } from '../core/tools/external-agent.js'
import { id } from '../core/util/ids.js'
import { ChromeBridge } from './chrome/bridge.js'
import { buildNativeMemoryGraph } from '../core/memory/graph.js'
import type { AgentDefinition, AgentsListing, PolicyConfig, ReasoningEffort } from '../shared/types.js'

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
  sessionId: string
  signature: string
  request: ApprovalRequest
}

export interface OrchestratorOptions {
  userData: string
  broadcast: (event: HarnessEvent) => void
  /** Optional log sink (the main process writes to %APPDATA%\Openclod\logs\main.log). */
  log?: (message: string) => void
}

export class Orchestrator {
  readonly store: SessionStore
  readonly settings: SettingsStore
  readonly computer: ComputerLayer
  readonly skills: SkillLibrary
  readonly aiMemory: AiMemoryService
  readonly inbox: InboxStore
  private readonly oauth: McpOAuthManager
  private baseRegistry: ToolRegistry
  private mcpClients = new Map<string, McpClient>()
  private mcpTools: ToolDef[] = []
  private mcpReloadAt = new Map<string, number>()
  private runners = new Map<string, SessionRunner>()
  private trackers = new Map<string, FileTracker>()
  private browsers = new Map<string, BrowserLayer>()
  private memories = new Map<string, MemoryStore>()
  private projectMemories = new Map<string, ProjectMemory>()
  /** Projects whose native wiki was already mirrored into AI-Memory this run. */
  private syncedMemories = new Set<string>()
  /** In-flight mirror, shared by concurrent list/status/runner calls. */
  private memorySyncs = new Map<string, Promise<void>>()
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
  readonly chromeBridge: ChromeBridge

  constructor(private readonly options: OrchestratorOptions) {
    this.store = new SessionStore(userDataPath(options.userData, 'data'))
    this.settings = new SettingsStore(userDataPath(options.userData, 'config'))
    this.approvals = new ApprovalStore(path.join(userDataPath(options.userData, 'data'), 'permissions'))
    this.computer = new ComputerLayer()
    this.skills = new SkillLibrary([])
    this.aiMemory = new AiMemoryService(path.join(userDataPath(options.userData, 'data'), 'ai-memory'))
    this.inbox = new InboxStore(path.join(userDataPath(options.userData, 'data'), 'inbox'))
    this.oauth = new McpOAuthManager(path.join(userDataPath(options.userData, 'data'), 'oauth'))
    this.chromeBridge = new ChromeBridge(options.userData)
    this.baseRegistry = buildBaseRegistry()
  }

  /**
   * Effective policy and hooks for a session: app settings + project
   * `.forja/settings*.json` (+ `.claude/` when enabled) + "always allow"
   * choices saved for the project.
   */
  private sessionConfig(state: SessionState): { policy: PolicyConfig; hooks: HookRunner } {    const settings = this.settings.get()
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
    await this.chromeBridge.start().catch((err) => this.options.log?.(`ponte Chrome: ${(err as Error).message}`))

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

    // First start after the rename: bring the Claude Desktop/Code catalog in
    // (skills, agents and MCP servers). The flag makes it a one-time import;
    // the UI can run it again on demand.
    if (!this.settings.get().claudeCatalogImported) {
      try {
        const imported = await this.importClaudeCatalog(false)
        this.options.log?.(
          `catálogo do Claude importado: ${imported.skills} skills, ${imported.agents} agentes, ${imported.imported} MCPs`
        )
      } catch (err) {
        this.options.log?.(`importação do catálogo do Claude falhou: ${(err as Error).message}`)
      }
    }

    await this.startMcpServers()
    // The AI-Memory sidecar indexes every project's wiki. Start it in the
    // background: a missing binary or a slow model must never delay the UI.
    void this.aiMemory.start().catch((err) => this.options.log?.(`ai-memory: ${(err as Error).message}`))
    void toolchains() // warm the cache; the probes spawn processes
  }

  /* ------------------------------- registry ------------------------------ */

  private rebuildRegistry(): void {
    const next = buildBaseRegistry()
    for (const tool of this.mcpTools) {
      // Names are capped at 60 chars, so two long tool names can collide; keep the first.
      if (!next.get(tool.name)) next.register(tool)
    }
    // Mutate the existing registry instead of replacing it: an active runner
    // keeps its reference, so tools installed mid-turn become visible on the
    // very next model iteration.
    this.baseRegistry.replaceAll(next.list())
  }

  private async startMcpServers(): Promise<void> {
    for (const client of this.mcpClients.values()) await client.stop()
    this.mcpClients.clear()
    this.mcpTools = []

    for (const config of this.settings.get().mcpServers ?? []) {
      if (!config.enabled) continue
      const client = new McpClient({
        ...(config as McpServerConfig),
        onUnauthorized: async (challenge) => {
          if (!config.url) return null
          this.onEvent({
            type: 'notice',
            sessionId: '',
            level: 'info',
            text: `MCP ${config.name}: abrindo login OAuth no navegador`
          })
          return this.oauth.authorize(config.name, config.url, challenge).catch((err) => {
            this.options.log?.(`OAuth de MCP ${config.name} falhou: ${(err as Error).message}`)
            return null
          })
        },
        onToolsChanged: () => {
          const now = Date.now()
          if (now - (this.mcpReloadAt.get(config.name) ?? 0) < 5_000) return
          this.mcpReloadAt.set(config.name, now)
          this.options.log?.(`MCP ${config.name}: tools/list_changed; recarregando servidores`)
          void this.restartMcp()
        }
      })
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

    const activeConfig = { ...providerConfig, model: state.meta.model || providerConfig.model }
    const provider = createProvider(activeConfig, this.settings.resolver())
    const fallback = settings.useAllModels ? this.buildFallback(settings, activeConfig) : undefined
    const tracker = this.trackers.get(sessionId) ?? new FileTracker(state.meta.cwd)
    if (state.changes?.length) tracker.restore(state.changes)
    this.trackers.set(sessionId, tracker)

    const browserSettings = settings.browser ?? { mode: 'auto' as const, groupBySession: true }
    const browser = this.browsers.get(sessionId) ?? new BrowserLayer({
      sessionId,
      chrome: this.chromeBridge,
      mode: browserSettings.mode,
      groupBySession: browserSettings.groupBySession
    })
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
    await this.syncNativeToAi(state.meta.projectId)

    const effectiveFullAccess = settings.policy.fullAccess === true || settings.policy.mode === 'unrestricted'
    const effectivePolicy: PolicyConfig = {
      ...settings.policy,
      fullAccess: effectiveFullAccess,
      allowNetwork: settings.policy.mode === 'unrestricted' ? true : settings.policy.allowNetwork,
      allowComputerControl: settings.policy.mode === 'unrestricted' ? true : settings.policy.allowComputerControl
    }
    const workspace = new WorkspaceGuard(
      [state.meta.cwd, ...(settings.policy.allowedRoots ?? [])].filter(Boolean),
      effectiveFullAccess
    )
    const project = this.store.listProjects().find((p) => p.id === state.meta.projectId)
    const branch = await gitBranch(state.meta.cwd)
    const { policy: sessionPolicy, hooks } = this.sessionConfig(state)
    const policy: PolicyConfig = settings.policy.mode === 'unrestricted'
      ? { ...sessionPolicy, ...effectivePolicy }
      : sessionPolicy
    this.sessionPolicies.set(sessionId, policy)
    this.sessionHooks.set(sessionId, hooks)

    const agents = this.agentRegistryFor(state.meta.cwd)
    const agentEnv = this.agentEnv(agents, describeToolchains(await toolchains()))
    const runner = new SessionRunner({
      sessionId,
      cwd: state.meta.cwd,
      mode: state.meta.mode,
      provider,
      providerConfig: activeConfig,
      fallback,
      effort: state.meta.effort,
      registry: this.baseRegistry,
      policy,
      environment: this.environmentFor(state),
      limits: settings.limits ?? DEFAULT_LIMITS,
      tracker,
      workspace,
      services: {
        browser,
        computer: this.computer,
        skills: this.skills,
        memory,
        projectMemory,
        mcp: this.mcpToolService(),
        aiMemory: this.aiMemory
      },
      projectId: state.meta.projectId,
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
      surface: state.meta.surface ?? 'code',
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

  /**
   * When `useAllModels` is on, every configured provider/model with credentials
   * becomes a fallback, in order. The active model is excluded; the runner
   * switches only after a quota/rate-limit/auth/transport failure and keeps the
   * same conversation + project memory.
   */
  private buildFallback(
    settings: AppSettings,
    current: ProviderConfig
  ): Array<{ provider: ReturnType<typeof createProvider>; config: ProviderConfig }> {
    const out: Array<{ provider: ReturnType<typeof createProvider>; config: ProviderConfig }> = []
    const seen = new Set<string>([`${current.id}::${current.model}`])
    const resolver = this.settings.resolver()
    for (const provider of settings.providers) {
      if (provider.kind === 'mock') continue
      if (!hasCredentials(provider, resolver)) continue
      const models = provider.models?.length ? provider.models : [provider.model]
      for (const model of models) {
        const key = `${provider.id}::${model}`
        if (seen.has(key)) continue
        seen.add(key)
        const config = { ...provider, model }
        try {
          out.push({ provider: createProvider(config, resolver), config })
        } catch {
          /* one invalid provider must not stop the fallback chain */
        }
        if (out.length >= 100) return out
      }
    }
    return out
  }

  /** What the agent runtime needs from the app: providers, the tool registry, events and approvals. */
  private bestProviderConfig(): ProviderConfig | undefined {
    const settings = this.settings.get()
    const resolver = this.settings.resolver()
    const priority: Record<string, number> = {
      anthropic: 0,
      openai: 1,
      deepseek: 2,
      kimi: 3,
      qwen: 4,
      openrouter: 5,
      ollama: 6,
      lmstudio: 7
    }
    const providers = settings.providers
      .filter((provider) => provider.kind !== 'mock' && hasCredentials(provider, resolver))
      .sort((a, b) => (priority[a.id] ?? 20) - (priority[b.id] ?? 20))
    const provider = providers[0]
    if (!provider) return undefined
    const models = (provider.models?.length ? provider.models : [provider.model]).filter(Boolean)
    const preferred = settings.lastModel?.providerId === provider.id ? settings.lastModel.model : provider.model
    const score = (model: string): number => {
      const value = model.toLowerCase()
      let total = 0
      if (model === preferred) total += 200
      if (value.includes('claude')) total += 60
      if (/\bgpt-5|\bgpt-4|\bo3\b|\bo4\b/.test(value)) total += 55
      if (value.includes('gemini')) total += 45
      if (value.includes('deepseek')) total += 40
      if (value.includes('qwen')) total += 35
      if (value.includes('kimi')) total += 32
      if (value.includes('gemma')) total += 28
      if (value.includes('llama')) total += 22
      if (/31b|32b|70b|72b|120b|235b|405b/.test(value)) total += 12
      if (/4b|3b|1b|0\.5b|7b|8b/.test(value)) total -= 8
      if (value.includes(':cloud')) total -= 30
      if (value.includes(':free')) total -= 6
      if (value.includes('coder')) total += 3
      if (model === provider.model) total += 2
      return total
    }
    const best = [...models].sort((a, b) => score(b) - score(a))[0] ?? provider.model
    return { ...provider, model: best }
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
      bestModel: () => this.bestProviderConfig(),
      createBrowser: () => {
        const browser = this.settings.get().browser ?? { mode: 'auto' as const, groupBySession: true }
        return new BrowserLayer({
          sessionId: `agent-${id('child')}`,
          chrome: this.chromeBridge,
          mode: browser.mode,
          groupBySession: browser.groupBySession
        })
      },
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
    await this.captureTurnMemory(sessionId, runner, text)
  }

  /**
   * Starts a turn and returns as soon as it is accepted. The renderer must not
   * wait for the whole turn (which can take minutes); progress arrives as
   * events. Failures before the turn starts are thrown here.
   */
  async startSend(sessionId: string, text: string, images?: ImagePart[], mode: 'steer' | 'queue' | 'auto' = 'auto'): Promise<void> {
    const runner = await this.ensureRunner(sessionId)
    if (runner.busy) {
      const item = this.inbox.add(sessionId, { text, images, mode: mode === 'steer' ? 'steer' : 'queue' })
      if (item.mode === 'steer') runner.steer(text)
      this.onEvent({
        type: 'notice',
        sessionId,
        level: 'info',
        text:
          item.mode === 'steer'
            ? 'instrução enviada ao turno em execução'
            : 'mensagem na fila; será enviada quando o turno atual terminar'
      })
      return
    }
    if (mode === 'queue') this.inbox.add(sessionId, { text, images, mode: 'queue' })
    if (runner.messages.length === 0) {
      const title = text.replace(/\s+/g, ' ').slice(0, 60)
      await this.store.patchMeta(sessionId, { title })
    }
    void runner
      .send(text, { images })
      .then(async () => {
        await this.captureTurnMemory(sessionId, runner, text)
        await this.drainInbox(sessionId)
      })
      .catch((err) => {
        this.onEvent({
          type: 'notice',
          sessionId,
          level: 'error',
          text: `falha ao iniciar turno: ${(err as Error).message}`
        })
      })
  }

  /** Sends the next durable inbox item, one at a time, until empty. */
  private async drainInbox(sessionId: string): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      const runner = this.runners.get(sessionId)
      if (!runner || runner.busy) return
      const next = this.inbox.list(sessionId).find((item) => item.mode === 'queue' && item.origin === 'agent')
      if (!next) return
      this.inbox.remove(sessionId, next.id)
      try {
        await runner.send(next.text, { images: next.images })
        await this.captureTurnMemory(sessionId, runner, next.text)
      } catch (err) {
        this.onEvent({
          type: 'notice',
          sessionId,
          level: 'error',
          text: `falha ao enviar item da fila: ${(err as Error).message}`
        })
        return
      }
    }
  }

  inboxList(sessionId: string): ReturnType<InboxStore['list']> {
    return this.inbox.list(sessionId)
  }

  inboxAdd(sessionId: string, text: string, images?: ImagePart[], mode: 'steer' | 'queue' = 'queue', origin: 'ui' | 'agent' = 'agent'): ReturnType<InboxStore['add']> {
    return this.inbox.add(sessionId, { text, images, mode, origin })
  }

  inboxRemove(sessionId: string, itemId: string): boolean {
    return this.inbox.remove(sessionId, itemId)
  }

  inboxClear(sessionId: string): void {
    this.inbox.clear(sessionId)
  }

  /**
   * Deterministic memory capture after every turn. The agent can still write
   * curated pages/handoffs, but a model that never calls memory_page still
   * leaves a durable session record in the project wiki.
   */
  private async captureTurnMemory(sessionId: string, runner: SessionRunner, userText: string): Promise<void> {
    try {
      const state = await this.store.loadSession(sessionId)
      if (!state) return
      const messages = runner.messages
      const lastUser = [...messages].reverse().find((message) => message.role === 'user' && !message.hidden)
      const after = lastUser ? messages.slice(messages.indexOf(lastUser) + 1) : messages
      const assistantText = after
        .filter((message) => message.role === 'assistant')
        .map((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ').trim())
        .filter(Boolean)
        .pop() ?? ''
      const tools = [...new Set(after.flatMap((message) => message.parts).filter((part) => part.type === 'tool_call').map((part) => part.name))]
      const files = (this.trackers.get(sessionId)?.changes() ?? []).map((change) => change.path).slice(-12)
      await this.memoryForProject(state.meta.projectId).rememberTurn({
        sessionTitle: state.meta.title,
        sessionId,
        userText,
        assistantText,
        tools,
        files
      })

      // Full turn in AI-Memory: request, answer, tool calls and their real
      // output. One page per turn keeps writes idempotent and avoids a
      // read-modify-write race between concurrent sessions.
      const turnId = lastUser?.id ?? `turn_${Date.now()}`
      const stamp = new Date().toISOString()
      const transcript = renderTurnTranscript(after)
      const body: string[] = [
        `## Turno — ${new Date().toLocaleString('pt-BR')}`,
        '',
        `- **Turno:** ${turnId}`,
        `- **Data:** ${stamp}`,
        `- **Modelo:** ${state.meta.providerId}/${state.meta.model}`,
        '',
        '### Pedido',
        '',
        userText.trim().slice(0, 12_000) || '(sem texto)',
        '',
        '### Resposta',
        '',
        assistantText.trim().slice(0, 20_000) || '(sem resposta textual)',
        '',
        '### Execução',
        '',
        transcript || '(nenhuma ferramenta usada)',
        '',
        '### Arquivos alterados',
        '',
        files.length ? files.map((file) => `- ${file}`).join('\n') : '(nenhum)'
      ]
      const pagePath = `s/${shortHash(sessionId)}.md`
      const related = await this.aiMemory
        .relatedMarkdown(state.meta.projectId, `${userText}\n${assistantText}`, pagePath, 4)
        .catch(() => '')
      if (related) body.push('', '### Relacionados', '', related)
      const existing = await this.aiMemory.readPage(state.meta.projectId, pagePath).catch(() => null)
      const fullBody = existing
        ? `${existing.body.trim()}\n\n---\n\n${body.join('\n')}`
        : [`# ${state.meta.title || 'Sessão'}`, '', body.join('\n')].join('\n')
      await this.aiMemory.writePage(state.meta.projectId, {
        path: pagePath,
        title: `Sessão ${state.meta.title || sessionId}`,
        body: fullBody,
        tags: ['sessao', 'automatico', 'turno'],
        tier: 'episodic'
      })
    } catch (err) {
      this.options.log?.(`memória automática da sessão ${sessionId} falhou: ${(err as Error).message}`)
    }
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
      pending.resolve({ approved: false, reason: 'turno cancelado' })
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

  private environmentFor(state: SessionState): import('../shared/types.js').EnvironmentProfile | undefined {
    const profiles = this.settings.get().environments ?? [
      { id: 'local', label: 'Local', kind: 'local' as const },
      { id: 'wsl', label: 'WSL', kind: 'wsl' as const }
    ]
    return profiles.find((profile) => profile.id === state.meta.environment) ?? profiles.find((profile) => profile.kind === 'local') ?? profiles[0]
  }

  async setEnvironment(sessionId: string, environmentId: string): Promise<void> {
    const state = await this.store.loadSession(sessionId)
    if (!state) throw new Error('sessão não encontrada')
    const profiles = this.settings.get().environments ?? []
    const profile = profiles.find((item) => item.id === environmentId)
    if (!profile) throw new Error('ambiente não encontrado')
    this.dropRunner(sessionId)
    await this.store.patchMeta(sessionId, { environment: profile.id })
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
    await this.aiMemory.stop()
    await this.computer.close()
    await this.chromeBridge.stop()
  }

  /* ------------------------------- approvals ----------------------------- */

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const signature = `${request.tool}::${request.preview ?? request.detail}`
    if (this.sessionAllow.get(request.sessionId)?.has(signature)) return { approved: true }

    this.onEvent({ type: 'approval_request', sessionId: request.sessionId, request })
    void this.sessionHooks
      .get(request.sessionId)
      ?.run('Notification', { message: `O Openclod precisa de aprovação: ${request.title} — ${request.detail}`.slice(0, 500) })
      .catch(() => undefined)
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.onEvent({
          type: 'approval_resolved',
          sessionId: request.sessionId,
          id: request.id,
          approved: false
        })
        resolve({ approved: false, reason: 'tempo de aprovação esgotado' })
      }, 5 * 60 * 1000)
      this.pending.set(request.id, { resolve, timer, sessionId: request.sessionId, signature, request })
    })
  }

  resolveApproval(approvalId: string, approved: boolean, always = false, reason = ''): void {
    const pending = this.pending.get(approvalId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(approvalId)
    const feedback = reason.replace(/\s+/g, ' ').trim().slice(0, 1_000)
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
    if (!approved && feedback) {
      this.onEvent({
        type: 'audit',
        sessionId: pending.sessionId,
        level: 'warn',
        message: `aprovação negada com feedback: ${feedback}`
      })
    }
    this.onEvent({
      type: 'approval_resolved',
      sessionId: pending.sessionId,
      id: approvalId,
      approved
    })
    pending.resolve(feedback ? { approved, reason: feedback } : { approved })
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
    const browserStatus = this.chromeBridge.isAttached()
      ? await this.chromeBridge.status()
      : await this.probeBrowser.status().catch(() => this.chromeBridge.status())
    return {
      computer: this.computer.status(),
      browser: browserStatus,
      mcp: [...this.mcpClients.entries()].map(([name, client]) => {
        const config = (settings.mcpServers ?? []).find((m) => m.name === name)
        return {
          name,
          command: config?.url ? `${config.type ?? 'http'} ${config.url}` : (config?.command ?? ''),
          state: client.state,
          tools: client.toolsList().map((t) => t.name),
          error: client.lastError ?? undefined
        }
      }),
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

  /** Returns the open flow without exposing tokens or provider secrets. */
  mcpOAuthStatus(serverName?: string): { available: boolean; connected: boolean; server?: string; expiresAt?: number; detail: string } {
    const oauth = this.oauth.status(serverName)
    if (!serverName) {
      return {
        available: oauth.total > 0,
        connected: oauth.connected > 0,
        detail: oauth.connected ? `${oauth.connected} login(s) OAuth conectado(s)` : 'Nenhum login OAuth conectado'
      }
    }
    return {
      available: true,
      connected: oauth.connected > 0,
      server: serverName,
      expiresAt: oauth.expiresAt,
      detail: oauth.connected ? 'Login OAuth ativo neste servidor.' : 'Este servidor não tem login OAuth válido.'
    }
  }

  /** Starts the real OAuth flow for a configured remote MCP. */
  async authorizeMcp(serverName: string): Promise<{ connected: boolean; detail: string }> {
    const config = (this.settings.get().mcpServers ?? []).find((server) => server.name === serverName)
    if (!config?.url) throw new Error('o conector selecionado não é remoto')
    const token = await this.oauth.authorize(serverName, config.url)
    if (!token) return { connected: false, detail: 'O provedor não concluiu o login OAuth.' }
    await this.restartMcp()
    return { connected: true, detail: 'Login OAuth concluído; conector reiniciado.' }
  }

  /** Full connector catalog for Personalização → Conectores → Descobrir. */
  mcpCatalog(): import('../shared/api.js').McpCatalogInfo[] {
    const installed = new Set((this.settings.get().mcpServers ?? []).map((server) => server.name))
    return MCP_CATALOG.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      transport: entry.transport,
      needs: [
        ...(entry.env ?? []).filter((item) => item.required).map((item) => item.key),
        ...(entry.headers ?? []).filter((item) => item.required).map((item) => item.key)
      ],
      oauth: Boolean(entry.oauth),
      docs: entry.docs,
      installed: installed.has(entry.id)
    }))
  }

  /** Installs an MCP from the catalog/registry on behalf of the UI or the agent. */
  async installMcp(input: { id: string; env?: Record<string, string>; headers?: Record<string, string>; name?: string }): ReturnType<McpToolService['install']> {
    return this.mcpToolService().install(input)
  }

  /**
   * Imports skills, agents and MCP servers from the user's Claude Desktop/Code
   * installation. Existing Openclod entries win; nothing is deleted.
   */
  async importClaudeCatalog(restart = true): Promise<ClaudeImportReport & { imported: number }> {
    const { report, servers } = importClaudeCatalog({ userData: this.options.userData })
    const current = this.settings.get().mcpServers ?? []
    const known = new Set(current.map((server) => server.name))
    let added = 0
    const merged = [...current]
    for (const server of servers) {
      if (known.has(server.name)) continue
      known.add(server.name)
      merged.push(server)
      added++
    }
    await this.settings.update({ mcpServers: merged.slice(0, 40), claudeCatalogImported: true })
    await this.skills.reload()
    if (restart) await this.restartMcp()
    return { ...report, imported: added }
  }

  /**
   * Self-installation surface the agent uses when a task needs an integration
   * that is not configured yet. It can search the curated catalog and the
   * official MCP Registry, then save and hot-reload the server.
   */
  private mcpToolService(): McpToolService {
    return {
      search: async (query, limit = 8) => {
        const installed = new Set((this.settings.get().mcpServers ?? []).map((server) => server.name))
        const catalog = searchMcpCatalog(query, limit).map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          transport: entry.transport,
          installed: installed.has(entry.id),
          needs: [
            ...(entry.env ?? []).filter((item) => item.required).map((item) => item.key),
            ...(entry.headers ?? []).filter((item) => item.required).map((item) => item.key)
          ],
          source: 'catalog' as const,
          docs: entry.docs
        }))
        let registry: Awaited<ReturnType<typeof searchMcpRegistry>> = []
        let warning: string | undefined
        try {
          registry = await searchMcpRegistry(query, limit)
        } catch (err) {
          warning = `registro MCP indisponível: ${(err as Error).message}`
        }
        return {
          catalog,
          registry: registry
            .filter((entry) => !catalog.some((hit) => hit.id === entry.id))
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              description: entry.description,
              version: entry.version,
              transport: entry.transport,
              installed: [...installed].some((name) => entry.id.endsWith(`/${name}`)),
              needs: entry.needs,
              source: 'registry' as const,
              docs: entry.docs
            })),
          installed: [...installed],
          warning
        }
      },
      install: async (input) => {
        let server: McpServerSettings | null = null
        let missing: string[] = []
        let needsOAuth = false
        let error: string | undefined

        if (input.url || input.command) {
          try {
            server = normalizeMcpServerSettings({
              name: input.name || (input.url ? 'remote-mcp' : 'custom-mcp'),
              type: input.url ? 'http' : 'stdio',
              url: input.url,
              command: input.command ?? '',
              args: input.args ?? [],
              env: input.env,
              headers: input.headers,
              enabled: true
            })
          } catch (err) {
            error = (err as Error).message
          }
        } else {
          const entry = catalogEntry(input.id) ?? searchMcpCatalog(input.id, 1).find((item) => item.id === input.id)
          if (entry) {
            const built = buildCatalogServer(entry, { env: input.env, headers: input.headers, name: input.name })
            server = built.server
            missing = built.missing
            needsOAuth = built.needsOAuth
          } else {
            try {
              const built = await installFromRegistry(input.id, { env: input.env, headers: input.headers, name: input.name })
              server = built.server
              missing = built.missing
              error = built.error
            } catch (err) {
              error = `não foi possível consultar o registro MCP: ${(err as Error).message}`
            }
          }
        }

        if (!server) return { ok: false, missing, needsOAuth, error: error ?? 'servidor não encontrado no catálogo nem no registro' }

        const current = this.settings.get().mcpServers ?? []
        const next = [...current.filter((item) => item.name !== server!.name), server].slice(-20)
        await this.settings.update({ mcpServers: next })
        this.onEvent({ type: 'settings_changed', sessionId: '', scope: 'mcp' })
        await this.restartMcp()
        const client = this.mcpClients.get(server.name)
        return {
          ok: Boolean(client?.state === 'ready') || Boolean(needsOAuth),
          name: server.name,
          state: client?.state ?? 'stopped',
          tools: client?.toolsList().map((tool) => tool.name) ?? [],
          needsOAuth,
          error: client?.lastError ?? undefined
        }
      },
      list: () => {
        const configs = this.settings.get().mcpServers ?? []
        return configs.map((config) => {
          const client = this.mcpClients.get(config.name)
          return {
            name: config.name,
            state: config.enabled ? (client?.state ?? 'stopped') : 'disabled',
            transport: config.type ?? 'stdio',
            tools: client?.toolsList().map((tool) => tool.name) ?? [],
            error: client?.lastError ?? undefined
          }
        })
      }
    }
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
        maxTokens: 128,
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
    const answer = text.trim()
    if (!answer) return { ok: false, detail: 'o provedor respondeu sem texto; aumente o limite ou verifique o modelo' }
    return { ok: true, detail: answer.slice(0, 120) }
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

  /**
   * Mirrors native wiki pages that predate the AI-Memory integration (or were
   * imported outside it) into the project's index. Runs once per project per
   * app run; new pages are mirrored at write time.
   */
  private async syncNativeToAi(projectId: string): Promise<void> {
    if (this.syncedMemories.has(projectId) || !this.aiMemory.available) return
    const running = this.memorySyncs.get(projectId)
    if (running) return running
    const task = this.doSyncNativeToAi(projectId).finally(() => {
      this.memorySyncs.delete(projectId)
      this.syncedMemories.add(projectId)
    })
    this.memorySyncs.set(projectId, task)
    return task
  }

  private async doSyncNativeToAi(projectId: string): Promise<void> {
    try {
      const native = await this.memoryForProject(projectId).listPages()
      if (!native.length) return
      const indexed = await this.aiMemory.recent(projectId, 100)
      const known = new Set(indexed.map((hit) => hit.path))
      for (const summary of native) {
        const path = `pages/${summary.slug}.md`
        const page = await this.memoryForProject(projectId).readPage(summary.slug)
        if (!page) continue
        // Session pages already have a richer AI-Memory transcript at
        // `s/<hash>.md`; mirroring the native summary would create a duplicate
        // node for the same conversation in the graph.
        if (summary.tags.includes('sessao') && summary.tags.includes('automatico')) {
          await this.aiMemory.deletePage(projectId, path).catch(() => false)
          continue
        }
        if (known.has(path)) continue
        const related = await this.aiMemory
          .relatedMarkdown(projectId, `${page.title}\n${page.body}`, path, 4)
          .catch(() => '')
        await this.aiMemory
          .writePage(projectId, {
            path,
            title: page.title,
            body: related ? `${page.body}\n\n## Relacionados\n\n${related}` : page.body,
            tags: page.tags,
            pinned: page.pinned,
            tier: 'semantic'
          })
          .catch(() => undefined)
      }
    } catch (err) {
      this.options.log?.(`sincronização da memória nativa com AI-Memory falhou: ${(err as Error).message}`)
    }
  }

  async memoryStats(
    projectId: string
  ): Promise<Awaited<ReturnType<ProjectMemory['stats']>> & { indexed?: number; aiRunning?: boolean }> {
    this.requireProject(projectId)
    await this.syncNativeToAi(projectId)
    const stats = await this.memoryForProject(projectId).stats()
    const indexed = await this.aiMemory.recent(projectId, 100).catch(() => [])
    return { ...stats, indexed: indexed.length, aiRunning: this.aiMemory.status().running }
  }

  /**
   * Native wiki pages plus AI-Memory pages that are not a session transcript
   * and have no native twin. Session transcripts stay out of the page grid (a
   * long project would drown it); they are still searchable by the agent and
   * available through `memory_recall`.
   */
  async memoryList(projectId: string): Promise<Awaited<ReturnType<ProjectMemory['listPages']>>> {
    this.requireProject(projectId)
    await this.syncNativeToAi(projectId)
    const native = await this.memoryForProject(projectId).listPages()
    const indexed = await this.aiMemory.recent(projectId, 100).catch(() => [])
    const known = new Set(native.map((page) => page.title.trim().toLowerCase()))
    const extra = indexed
      .filter(
        (hit) =>
          !hit.path.startsWith('sessions/') &&
          !hit.path.startsWith('s/') &&
          !known.has(hit.title.trim().toLowerCase())
      )
      .map((hit) => ({
        slug: aiPageId(hit.path),
        title: hit.title,
        tags: ['ai-memory'],
        pinned: false,
        updated: hit.updated ?? new Date().toISOString(),
        summary: hit.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 220),
        terms: [] as string[],
        source: 'ai-memory' as const,
        path: hit.path
      }))
    return [...native.map((page) => ({ ...page, source: 'wiki' as const })), ...extra]
  }

  async memoryRead(projectId: string, slug: string): Promise<Awaited<ReturnType<ProjectMemory['readPage']>>> {
    this.requireProject(projectId)
    if (slug.startsWith(AI_PAGE_PREFIX)) {
      const page = await this.aiMemory.readPage(projectId, slug.slice(AI_PAGE_PREFIX.length))
      if (!page) return null
      return {
        slug,
        title: page.title,
        body: page.body,
        tags: page.tags,
        pinned: page.pinned,
        created: page.updated,
        updated: page.updated,
        source: 'ai-memory'
      }
    }
    return this.memoryForProject(projectId).readPage(slug)
  }

  async memoryDelete(projectId: string, slug: string): Promise<boolean> {
    this.requireProject(projectId)
    if (slug.startsWith(AI_PAGE_PREFIX)) {
      return this.aiMemory.deletePage(projectId, slug.slice(AI_PAGE_PREFIX.length))
    }
    const deleted = await this.memoryForProject(projectId).deletePage(slug)
    // Curated pages are mirrored into AI-Memory; remove both copies.
    await this.aiMemory.deletePage(projectId, `pages/${slug}.md`).catch(() => false)
    return deleted
  }

  /** A bounded, ranked view of the project's long-term memory for the agent. */
  async memoryRecall(projectId: string, query: string, limit = 10): Promise<{ text: string; hits: number }> {
    this.requireProject(projectId)
    return this.aiMemory.recall(projectId, query, limit)
  }

  /**
   * Unified memory graph. The markdown wiki is the durable source and the
   * sidecar contributes extra transcript nodes; both are merged by path/title
   * so one page can never disappear merely because the sidecar indexed it.
   */
  async memoryGraph(projectId: string): Promise<import('./ai-memory.js').AiMemoryGraph> {
    this.requireProject(projectId)
    await this.syncNativeToAi(projectId)
    const summaries = await this.memoryForProject(projectId).listPages()
    const native = await Promise.all(summaries.map((summary) => this.memoryForProject(projectId).readPage(summary.slug)))
    const sidecar = await this.aiMemory.graph(projectId).catch(() => null)

    const nodes: Array<{
      id: string
      path: string
      title: string
      kind: 'session' | 'page' | 'fact'
      tags: string[]
      updated: string
      degree: number
      terms: string[]
      summary?: string
    }> = native.flatMap((page) => {
      if (!page) return []
      const path = `pages/${page.slug}.md`
      const twin = sidecar?.nodes.find((node) => node.path === path || node.path === page.slug)
      return [{
        id: page.slug,
        path: page.slug,
        title: page.title,
        kind: (page.tags.includes('sessao') ? 'session' : 'page') as 'session' | 'page',
        tags: page.tags,
        updated: page.updated,
        degree: twin?.degree ?? 0,
        terms: graphKeywords(`${page.title} ${page.body}`, 24),
        summary: page.body.replace(/\s+/g, ' ').trim().slice(0, 600)
      }]
    })
    const nativeKeys = new Set(nodes.flatMap((node) => [node.path.toLowerCase(), node.title.trim().toLowerCase()]))
    for (const node of sidecar?.nodes ?? []) {
      if (nativeKeys.has(node.path.toLowerCase()) || nativeKeys.has(node.title.trim().toLowerCase())) continue
      const wrapped = await this.aiMemory.readPage(projectId, node.path).catch(() => null)
      nodes.push({
        ...node,
        terms: graphKeywords(`${node.title} ${node.tags.join(' ')} ${wrapped?.body ?? ''}`, 24),
        summary: (wrapped?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      })
    }

    const byId = new Map(nodes.map((node) => [node.id, node]))
    const edges = new Map<string, import('./ai-memory.js').AiMemoryGraphEdge>()
    const addEdge = (source: string, target: string, kind: 'link' | 'tag' | 'term', weight: number): void => {
      if (!byId.has(source) || !byId.has(target) || source === target) return
      const [a, b] = source < target ? [source, target] : [target, source]
      const key = `${a}|${b}`
      const current = edges.get(key)
      if (!current || current.weight < weight) edges.set(key, { source: a, target: b, kind, weight })
    }

    // Explicit wiki links resolve by slug or title, the same convention used by
    // Obsidian: [[memory-page]] and [[Memory page]] point to the same node.
    const nativeGraph = buildNativeMemoryGraph(native.filter((page): page is NonNullable<typeof page> => Boolean(page)))
    for (const edge of nativeGraph.edges) addEdge(edge.source, edge.target, edge.kind, edge.weight)
    for (const edge of sidecar?.edges ?? []) {
      const source = edge.source.startsWith('pages/') ? edge.source.slice(6, -3) : edge.source
      const target = edge.target.startsWith('pages/') ? edge.target.slice(6, -3) : edge.target
      addEdge(source, target, edge.kind, edge.weight)
    }

    for (const node of nodes) node.degree = 0
    for (const edge of edges.values()) {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (source) source.degree++
      if (target) target.degree++
    }
    return {
      nodes,
      edges: [...edges.values()].sort((a, b) => b.weight - a.weight),
      truncated: (sidecar?.nodes.length ?? 0) >= 100,
      source: sidecar?.nodes.length ? 'ai-memory' : 'native'
    }
  }

  /** Public status used by Configurações → Memória. */
  aiMemoryStatus(): import('./ai-memory.js').AiMemoryStatus {
    return { ...this.aiMemory.status(), root: this.aiMemory.root }
  }

  /** Deletes a project's sessions, native wiki and AI-Memory index. */
  async deleteProject(projectId: string): Promise<void> {
    const project = this.requireProject(projectId)
    const sessions = (await this.store.listSessions()).filter((session) => session.meta.projectId === projectId)
    for (const session of sessions) await this.deleteSession(session.meta.id)
    await this.store.removeProject(projectId)
    this.projectMemories.delete(projectId)
    this.syncedMemories.delete(projectId)
    this.memorySyncs.delete(projectId)
    this.approvals.clear(projectId)
    await fs.promises
      .rm(path.join(userDataPath(this.options.userData, 'data'), 'memory', 'projects', projectId), {
        recursive: true,
        force: true
      })
      .catch(() => undefined)
    await this.aiMemory.purgeProject(projectId)
    this.options.log?.(`projeto ${project.name} (${projectId}) excluído com memória e sessões`)
  }

  memoryRoot(projectId: string): string {
    this.requireProject(projectId)
    return this.memoryForProject(projectId).root
  }

  /** One Markdown bundle with every memory page; used by the Exportar button. */
  async memoryExportMarkdown(projectId: string): Promise<{ path: string; markdown: string; pages: number }> {
    this.requireProject(projectId)
    const memory = this.memoryForProject(projectId)
    const pages = await this.memoryList(projectId)
    const chunks: string[] = [`# AI-Memory — ${projectId}`, '']
    for (const page of pages) {
      const full = await this.memoryRead(projectId, page.slug)
      if (!full) continue
      chunks.push(`<!-- slug: ${full.slug} -->`, `# ${full.title}`, '', full.body.trim(), '')
    }
    return { path: memory.root, markdown: chunks.join('\n'), pages: pages.length }
  }

  /** Imports Markdown files as memory pages (one page per file). */
  async memoryImportMarkdown(projectId: string, files: Array<{ name: string; content: string }>): Promise<number> {
    this.requireProject(projectId)
    const memory = this.memoryForProject(projectId)
    let imported = 0
    for (const file of files) {
      const raw = file.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
      if (!raw.trim()) continue
      const heading = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim()
      const title = heading || file.name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'Memória importada'
      const body = heading ? raw.replace(/^#\s+.+\n?/, '').trim() : raw.trim()
      const page = await memory.writePage({ title, body, tags: ['importado'], source: 'import' })
      await this.aiMemory
        .writePage(projectId, {
          path: `pages/${page.slug}.md`,
          title: page.title,
          body,
          tags: page.tags,
          tier: 'semantic'
        })
        .catch(() => undefined)
      imported++
    }
    return imported
  }
}

/* ------------------------------- helpers -------------------------------- */

const AI_PAGE_PREFIX = 'ai:'

function aiPageId(pagePath: string): string {
  return `${AI_PAGE_PREFIX}${pagePath}`
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10)
}

function graphKeywords(text: string, limit = 10): string[] {
  const counts = new Map<string, number>()
  for (const word of text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9_]+/)) {
    if (word.length < 4 || /^\d+$/.test(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word)
}

/** Human-readable execution log of one turn, used in the AI-Memory page. */
function renderTurnTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') {
        const args = JSON.stringify(part.args ?? {}).replace(/\s+/g, ' ').slice(0, 900)
        lines.push(`### Ferramenta: ${part.name}`, '', '```json', args, '```', '')
      } else if (part.type === 'tool_result') {
        const text = (part.text ?? '').replace(/```/g, '``\u200b`').slice(0, 4_000)
        lines.push(`**Resultado de ${part.name}:** ${part.ok ? 'ok' : 'falhou'}`, '', text || '(vazio)', '')
      }
    }
  }
  return lines.join('\n').trim()
}

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
    .register(...mcpTools)
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

  // Full skills shipped with the app (qa-total and future ones). Copy once;
  // the user's edits in %APPDATA% are never overwritten.
  const bundled = resourcePath('skills')
  if (!bundled) return
  let entries: fs.Dirent[] = []
  try {
    entries = await fs.promises.readdir(bundled, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const target = path.join(dir, entry.name)
    if (fs.existsSync(path.join(target, 'SKILL.md'))) continue
    try {
      fs.cpSync(path.join(bundled, entry.name), target, { recursive: true, force: false, errorOnExist: false })
    } catch {
      /* a locked skill must not block startup */
    }
  }
}
