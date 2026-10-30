import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  CapabilityReport,
  ContextBreakdown,
  FileChange,
  HarnessEvent,
  ImagePart,
  Message,
  McpServerSettings,
  Project,
  ProviderConfig,
  ProviderErrorKind,
  QuestionAnswer,
  QuestionRequest,
  RunState,
  SessionMeta,
  SessionState,
  ToolResult
} from '../shared/types.js'
import { DEFAULT_LIMITS } from '../shared/types.js'
import { SessionStore } from '../core/session/store.js'
import { FileTracker } from '../core/session/tracker.js'
import { SettingsStore } from './settings.js'
import { ColabService, type ColabHost } from './colab.js'
import { LlamaCppService } from './llamacpp/service.js'
import { LLAMACPP_PROVIDER_ID } from '../shared/llamacpp.js'
import type { MemoryAddJobInfo, MemoryFileInfo } from '../shared/api.js'
import { SkillLibrary } from '../core/skills/library.js'
import { MemoryStore } from '../core/memory/store.js'
import { ProjectMemory } from '../core/memory/project.js'
import { memoryScopeId } from '../core/memory/scope.js'
import { relatedDurable } from '../core/memory/pack.js'
import { BrowserLayer } from '../core/browser/layer.js'
import { ComputerLayer } from '../core/computer/layer.js'
import { ToolRegistry } from '../core/tools/registry.js'
import { lazyTools } from '../core/tools/lazy.js'
import { createAgentRegistry, type AgentRegistry } from '../core/agents/registry.js'
import { writeAgentFile } from '../core/agents/loader.js'
import { agentForgeTools } from '../core/agents/tools.js'
import { spawnAgent, type AgentRuntimeEnv } from '../core/agents/runtime.js'
import { fsTools } from '../core/tools/fs.js'
import { applyPatchTool } from '../core/tools/apply-patch.js'
import { searchTools } from '../core/tools/search.js'
import { shellTools, killSessionProcesses } from '../core/tools/shell.js'
import { gitTools } from '../core/tools/git.js'
import { terminalTools } from '../core/tools/terminal.js'
import type { TerminalRunner } from '../core/terminal/runner.js'
import { webTools } from '../core/tools/web.js'
import { browserTools } from '../core/tools/browser.js'
import { computerTools } from '../core/tools/computer.js'
import { planTools } from '../core/tools/plan.js'
import { limitationTools } from '../core/tools/limitations.js'
import { askTools } from '../core/tools/ask.js'
import { projectMemoryTools } from '../core/memory/tools.js'
import { SessionRunner } from '../core/agent/runner.js'
import type { RunnerSnapshot, SendOptions } from '../core/agent/runner.js'
import { discardedPlanNotice } from '../core/agent/plan-control.js'
import { createProvider, hasCredentials, resolveApiKey } from '../core/providers/index.js'
import { errorKindOf } from '../core/providers/http.js'
import { describeFailure, isAccountLevelKind } from '../core/providers/health.js'
import { ProviderReserve } from './reserve.js'
import { WorkspaceGuard } from '../core/security/policy.js'
import { mergeRules, rulesForApproval } from '../core/security/rules.js'
import { HookRunner } from '../core/hooks/runner.js'
import { ApprovalStore, loadProjectSettings, mergeHooks } from '../core/config/project.js'
import { McpClient, normalizeMcpServerSettings, type McpServerConfig } from '../core/mcp/client.js'
import { buildCatalogServer, catalogEntry, searchMcpCatalog, MCP_CATALOG } from '../core/mcp/catalog.js'
import { installFromRegistry, searchMcpRegistry } from '../core/mcp/registry.js'
import type { McpReloadReport, McpToolService, ToolDef } from '../core/tools/types.js'
import { createMcpTools } from '../core/tools/mcp.js'
import { buildMcpToolDefs, type McpSkippedTool } from '../core/mcp/tools.js'
import { hintForMcpError } from '../core/mcp/hints.js'
import { DEFAULT_START_TIMEOUT_MS, MIN_LISTING_TIMEOUT_MS } from '../core/mcp/limits.js'
import type { ResolvedToolPolicy } from '../core/mcp/policy.js'
import { rewindMessages } from '../core/session/rewind.js'
import { captureGitFileCheckpoint, restoreGitFileCheckpoint } from '../core/session/checkpoint.js'
import { describeToolchains, toolchains } from '../core/util/toolchains.js'
import { ensureProjectInstructions } from '../core/agent/context.js'
import { resourcePath } from '../core/util/resources.js'
import { expandCommand, loadCustomCommands, matchCustomCommand, slashWord, type CustomCommand } from '../core/commands/library.js'
import { listMcpPresets, type McpPresetInfo } from '../core/mcp/presets.js'
import { discoverForProvider, type DiscoveryResult } from '../core/providers/discovery.js'
import { importClaudeCatalog, type ClaudeImportReport } from './claude-import.js'
import { AiMemoryService } from './ai-memory.js'
import { InboxStore } from './inbox.js'
import { McpOAuthManager, OAuthSetupError } from './mcp-oauth.js'
import { ConnectorService, MAX_MCP_SERVERS } from './connector-service.js'
import { externalAgentTools, killExternalAgentProcesses } from '../core/tools/external-agent.js'
import { codeIntelligenceTools } from '../core/tools/code-intelligence.js'
import { documentTools } from '../core/tools/documents.js'
import { mediaTools } from '../core/tools/media.js'
import { memoryFileTools } from '../core/memory/file-tools.js'
import {
  addMemoryFile,
  collectFiles as collectMemoryFiles,
  findFilePaths,
  findMemoryFile,
  listMemoryFiles,
  memoryFileIndex,
  memoryFileThumb,
  type MemoryFileIndexEntry
} from '../core/memory/files.js'
import { describeImage } from '../core/vision/relay.js'
import { findMediaPaths } from '../core/media/paths.js'
import { ingestToMemory, loadSheetImages } from '../core/media/memory.js'
import { imageTools } from '../core/tools/images.js'
import { PluginManager } from '../core/plugins/manager.js'
import { id } from '../core/util/ids.js'
import { ChromeBridge } from './chrome/bridge.js'
import { graphSourceOf, prepareMemoryGraphAsync, selectMemoryGraph, type PreparedMemoryGraph } from '../core/memory/graph.js'
import type { AgentDefinition, AgentsListing, PolicyConfig, ReasoningEffort } from '../shared/types.js'
import type {
  ConnectInput,
  ConnectorDirectory,
  ConnectorState,
  ConnectorTool,
  ConnectResult,
  ToolPolicy
} from '../shared/mcp-connectors.js'

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
  sessionId: string
  signature: string
  request: ApprovalRequest
}

interface PendingQuestion {
  resolve: (answers: QuestionAnswer[] | null) => void
  timer: NodeJS.Timeout
  sessionId: string
}

export interface OrchestratorOptions {
  userData: string
  broadcast: (event: HarnessEvent) => void
  /** Optional log sink (the main process writes to %APPDATA%\Openclod\logs\main.log). */
  log?: (message: string) => void
  /** Wait before the automatic second attempt at a server that ran out of start time (3 s; tests shorten it). */
  mcpStartRetryDelayMs?: number
  /** What the Google Colab feature needs from Electron (open the browser, show a file, copy text). Tests omit it: nothing is opened. */
  colabHost?: ColabHost
  /** Runs commands in the visible integrated terminal (node-pty lives in Electron). Tests omit it: run_in_terminal says it is unavailable. */
  terminalRunner?: TerminalRunner
}

/** The ways a server's start can run out of time (the client's own timeouts and the orchestrator's last-resort guard). */
const MCP_START_TIMEOUT = /timeout de MCP|não terminou de iniciar/

export class Orchestrator {
  readonly store: SessionStore
  readonly settings: SettingsStore
  readonly computer: ComputerLayer
  readonly skills: SkillLibrary
  readonly aiMemory: AiMemoryService
  readonly inbox: InboxStore
  readonly plugins: PluginManager
  private readonly oauth: McpOAuthManager
  /** Connector directory, states and connect/disconnect (Personalização → Conectores). */
  readonly connectors: ConnectorService
  /** Last 401 challenge per server, reused when the user starts OAuth manually. */
  private mcpChallenges = new Map<string, string>()
  /** Credentials a server needed that the vault did not have at the last start (never the values). */
  private mcpSecretIssues = new Map<string, string[]>()
  private baseRegistry: ToolRegistry
  private mcpClients = new Map<string, McpClient>()
  private mcpReloadAt = new Map<string, number>()
  /** Pending automatic second attempts at starting a server that ran out of time (cleared on shutdown). */
  private mcpStartRetries = new Map<string, NodeJS.Timeout>()
  private runners = new Map<string, SessionRunner>()
  private trackers = new Map<string, FileTracker>()
  private browsers = new Map<string, BrowserLayer>()
  private memories = new Map<string, MemoryStore>()
  private projectMemories = new Map<string, ProjectMemory>()
  /** Each project's graph, until its memory changes (the key says which version of the memory it was built from). */
  private readonly memoryGraphs = new Map<string, { key: string; prepared: PreparedMemoryGraph }>()
  /** The AI-Memory sidecar's graph of each project, refreshed in the background. */
  private readonly sidecarGraphs = new Map<string, { at: number; graph: import('./ai-memory.js').AiMemoryGraph | null; loading?: boolean }>()
  /** Projects whose native wiki was already mirrored into AI-Memory this run. */
  private syncedMemories = new Set<string>()
  /** Mirror of each project's wiki into the AI-Memory index: pages copied so far, of how many, and whether it is running. */
  private memorySyncState = new Map<string, { done: number; total: number; running: boolean }>()
  /** In-flight mirror, shared by concurrent list/status/runner calls. */
  private memorySyncs = new Map<string, Promise<void>>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, PendingApproval>()
  private pendingQuestions = new Map<string, PendingQuestion>()
  private sessionAllow = new Map<string, Set<string>>()
  private sessionPolicies = new Map<string, PolicyConfig>()
  private sessionHooks = new Map<string, HookRunner>()
  private pluginSkillRoots = new Set<string>()
  /** Live subagents per user session, so aborting the session can also stop their processes. */
  private agentChildren = new Map<string, Set<string>>()
  private readonly approvals: ApprovalStore
  private eventQueue: Promise<void> = Promise.resolve()
  private readonly probeBrowser = new BrowserLayer()
  readonly chromeBridge: ChromeBridge
  /** Which provider takes over when the one in use cannot answer, and what is known about which ones work. */
  readonly reserve: ProviderReserve
  /** Settings → Provedores → Google Colab (GPU): notebook, connection code, link health. */
  readonly colab: ColabService
  /** The local engine: llama.cpp's own server, started by the app (no Ollama to run). */
  readonly llamacpp: LlamaCppService

  constructor(private readonly options: OrchestratorOptions) {
    this.store = new SessionStore(userDataPath(options.userData, 'data'))
    this.settings = new SettingsStore(userDataPath(options.userData, 'config'))
    this.reserve = new ProviderReserve({ settings: () => this.settings.get(), resolver: () => this.settings.resolver() })
    this.colab = new ColabService({
      settings: this.settings,
      health: this.reserve.health,
      host: options.colabHost ?? {
        notebookDir: path.join(options.userData, 'colab'),
        openUrl: () => undefined,
        revealFile: () => undefined,
        copyText: () => undefined
      },
      // Idle sessions are rebuilt with the new provider list; the interface reloads the settings (and the model picker).
      emitChanged: () => {
        this.settingsChanged()
        this.onEvent({ type: 'settings_changed', sessionId: '', scope: 'general' })
      },
      log: (message) => this.options.log?.(message)
    })
    this.llamacpp = new LlamaCppService({
      settings: this.settings,
      health: this.reserve.health,
      userData: options.userData,
      // Same as the Colab: idle sessions are rebuilt with the new provider list and the screens reload it.
      emitChanged: () => {
        this.settingsChanged()
        this.onEvent({ type: 'settings_changed', sessionId: '', scope: 'general' })
      },
      log: (message) => this.options.log?.(message)
    })
    this.approvals = new ApprovalStore(path.join(userDataPath(options.userData, 'data'), 'permissions'))
    this.computer = new ComputerLayer()
    this.skills = new SkillLibrary([])
    this.aiMemory = new AiMemoryService(path.join(userDataPath(options.userData, 'data'), 'ai-memory'))
    this.inbox = new InboxStore(path.join(userDataPath(options.userData, 'data'), 'inbox'))
    this.plugins = new PluginManager(path.join(options.userData, 'plugins'))
    this.oauth = new McpOAuthManager(
      path.join(userDataPath(options.userData, 'data'), 'oauth'),
      this.settings.secretCrypto
    )
    this.connectors = new ConnectorService({
      settings: this.settings,
      oauth: this.oauth,
      clients: () => this.mcpClients,
      // One connector changes (connect, login done, disconnect): only its server restarts, the others keep running.
      restart: (serverName) => (serverName ? this.startMcpServers(serverName) : this.restartMcp()),
      refreshTools: () => this.rebuildRegistry(),
      emitChanged: () => this.onEvent({ type: 'settings_changed', sessionId: '', scope: 'mcp' }),
      secretIssues: () => this.mcpSecretIssues,
      challenge: (serverName) => this.mcpChallenges.get(serverName),
      log: (message) => this.options.log?.(message)
    })
    this.chromeBridge = new ChromeBridge(options.userData)
    // The Stop button of the Chrome extension ends the turn like the Stop button of the app does.
    this.chromeBridge.onStop((sessionId) => {
      this.options.log?.(`Parar pelo Chrome: sessão ${sessionId}`)
      void this.abort(sessionId).catch(() => undefined)
    })
    this.baseRegistry = buildBaseRegistry()
  }

  /**
   * Effective policy and hooks for a session: app settings + project
   * `.openclod/settings*.json` (+ `.claude/` when enabled) + "always allow"
   * choices saved for the project.
   */
  private sessionConfig(state: SessionState): { policy: PolicyConfig; hooks: HookRunner } {    const settings = this.settings.get()
    const project = loadProjectSettings(state.meta.cwd, { importClaude: settings.importClaudeSettings })
    const policy: PolicyConfig = {
      ...settings.policy,
      rules: mergeRules(settings.policy.rules, project.rules, this.approvals.rules(state.meta.projectId))
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
    await this.plugins.init()
    await this.store.init()
    await this.chromeBridge.start().catch((err) => this.options.log?.(`ponte Chrome: ${(err as Error).message}`))

    // What the inboxes kept from before the restart: queued prompts go to the composer's queue of their session,
    // steers already delivered into a turn are dropped.
    for (const sessionId of this.inbox.sessions()) {
      const recovered = this.inbox.recover(sessionId)
      if (recovered.handedOver) this.options.log?.(`fila de ${sessionId}: ${recovered.handedOver} mensagem(ns) da fila voltaram para o compositor`)
    }

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
    await this.refreshPluginSkills()

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

    // MCP servers connect in the background (in parallel, each with its own start timeout):
    // a slow `npx` download or an unreachable remote server must never delay the window.
    // The panel shows each one as "starting" until it answers.
    void this.startMcpServers().catch((err) => this.options.log?.(`MCP: ${(err as Error).message}`))
    this.rebuildRegistry()
    // The AI-Memory sidecar indexes every project's wiki. Start it in the
    // background: a missing binary or a slow model must never delay the UI.
    void this.aiMemory.start().catch((err) => this.options.log?.(`ai-memory: ${(err as Error).message}`))
    void toolchains() // warm the cache; the probes spawn processes
    this.startServiceWatchdog()
  }

  /**
   * The services' watchdog: every minute it checks what the sessions depend on and fixes what is stuck by itself. The
   * AI-Memory sidecar that stopped answering is restarted; MCP servers that dropped are reconnected by their own clients,
   * and a stuck tool call is stopped by the runner's watchdog (which restarts its MCP server).
   */
  private serviceWatch: NodeJS.Timeout | null = null
  private serviceCheckRunning = false

  private startServiceWatchdog(): void {
    if (this.serviceWatch) return
    this.serviceWatch = setInterval(() => {
      if (this.serviceCheckRunning) return
      this.serviceCheckRunning = true
      void this.aiMemory
        .selfCheck()
        .then((outcome) => {
          if (outcome === 'missed') this.options.log?.('vigia: AI-Memory não respondeu à checagem de saúde')
          if (outcome === 'restarted') this.options.log?.('vigia: AI-Memory parou de responder e foi reiniciado')
          if (outcome === 'restart-failed') this.options.log?.('vigia: AI-Memory parou de responder e não voltou ao reiniciar')
        })
        .catch(() => undefined)
        .finally(() => {
          this.serviceCheckRunning = false
        })
    }, 60_000)
    this.serviceWatch.unref?.()
  }

  /* ------------------------------- registry ------------------------------ */

  private rebuildRegistry(): void {
    const next = buildBaseRegistry((server, tool) => this.mcpClients.get(server)?.policyFor(tool))
    for (const tool of this.plugins.toolDefs()) if (!next.get(tool.name)) next.register(tool)
    // Every tool of every connected MCP server is a tool of its own (mcp__server__tool).
    for (const tool of this.mcpDirectTools()) if (!next.get(tool.name)) next.register(tool)
    // Mutate the existing registry instead of replacing it: an active runner
    // keeps its reference, so tools installed mid-turn become visible on the
    // very next model iteration.
    this.baseRegistry.replaceAll(next.list())
  }

  /** Tools skipped at the last rebuild because the server's schema cannot be offered to a model API. */
  private mcpSkipped: McpSkippedTool[] = []
  private mcpRefreshTimer: NodeJS.Timeout | null = null

  /**
   * First-class tools for the connected servers. The saved settings are the source of truth for the per-tool
   * policy (include/exclude/approval/toolPolicy): every rebuild copies them to the live clients, so changing a
   * policy never needs a reconnection.
   */
  private mcpDirectTools(): ToolDef[] {
    const stored = this.settings.get().mcpServers ?? []
    for (const [name, client] of this.mcpClients) {
      const settings = stored.find((item) => item.name === name)
      if (!settings) continue
      client.setPolicy({
        includeTools: settings.includeTools,
        excludeTools: settings.excludeTools,
        approvalTools: settings.approvalTools,
        toolPolicy: settings.toolPolicy
      })
    }
    const build = buildMcpToolDefs({
      hosts: [...this.mcpClients.values()],
      settings: (name) => stored.find((item) => item.name === name),
      getHost: (name) => this.mcpClients.get(name)
    })
    this.mcpSkipped = build.skipped
    return build.tools
  }

  /** Coalesces the bursts of state changes (start, reconnect, list_changed) into one rebuild and one UI refresh. */
  private scheduleMcpRefresh(): void {
    if (this.mcpRefreshTimer) return
    this.mcpRefreshTimer = setTimeout(() => {
      this.mcpRefreshTimer = null
      try {
        this.rebuildRegistry()
        this.onEvent({ type: 'settings_changed', sessionId: '', scope: 'mcp' })
      } catch (err) {
        this.options.log?.(`MCP: ${(err as Error).message}`)
      }
    }, 120)
    this.mcpRefreshTimer.unref?.()
  }

  async installPlugin(sourceDir: string) {
    const plugin = await this.plugins.installDirectory(sourceDir)
    this.rebuildRegistry()
    await this.refreshPluginSkills()
    return plugin
  }

  async setPluginEnabled(pluginId: string, enabled: boolean) {
    const plugin = await this.plugins.setEnabled(pluginId, enabled)
    this.rebuildRegistry()
    await this.refreshPluginSkills()
    return plugin
  }

  async removePlugin(pluginId: string) {
    const removed = await this.plugins.remove(pluginId)
    this.rebuildRegistry()
    await this.refreshPluginSkills()
    return removed
  }

  private async refreshPluginSkills(): Promise<void> {
    for (const root of this.pluginSkillRoots) this.skills.removeRoot(root)
    this.pluginSkillRoots.clear()
    for (const root of this.plugins.skillRoots()) {
      this.skills.addRoot(root, 'usuario')
      this.pluginSkillRoots.add(root)
    }
    await this.skills.reload()
  }

  /** Serialized: a restart waits for the previous start/stop to settle instead of racing it. */
  private mcpStart: Promise<void> = Promise.resolve()

  private startMcpServers(only?: string, attempt = 0): Promise<void> {
    const run = this.mcpStart.then(() => this.doStartMcpServers(only, attempt))
    this.mcpStart = run.catch(() => undefined)
    return run
  }

  /**
   * Stops and starts the servers from the saved settings: all of them, or only `only`. Each server starts on its own
   * with its own deadline (`startTimeoutMs`), so one that hangs neither blocks the others nor the serialized chain of
   * restarts: it ends as `error` with the cause. The registry is rebuilt as servers settle, so the tools of the fast
   * ones are usable while a slow one is still starting.
   */
  private async doStartMcpServers(only?: string, attempt = 0): Promise<void> {
    const doomed = only
      ? [this.mcpClients.get(only)].filter((client): client is McpClient => Boolean(client))
      : [...this.mcpClients.values()]
    await Promise.all(doomed.map((client) => client.stop().catch(() => undefined)))
    if (only) this.mcpClients.delete(only)
    else this.mcpClients.clear()

    const enabled = (this.settings.get().mcpServers ?? []).filter((config) => config.enabled)
    const servers = only ? enabled.filter((config) => config.name === only) : enabled
    if (only) this.mcpSecretIssues.delete(only)
    else this.mcpSecretIssues.clear()
    await Promise.allSettled(servers.map((stored) => this.startMcpServer(stored, attempt)))
    this.rebuildRegistry()
  }

  private async startMcpServer(stored: McpServerSettings, attempt = 0): Promise<void> {
    // settings.json only holds `${secret:...}` references; the client gets the real values (never logged).
    const { server: config, missing } = this.settings.resolveMcpServer(stored)
    const oauthToken = await this.oauth.token(config.name).catch(() => null)
    const client = new McpClient({
      ...(config as McpServerConfig),
      ...(oauthToken ? { oauthToken } : {}),
      // Connection lost mid-session (HTTP/SSE stopped answering, stdio process died): retry with exponential
      // backoff (1 s, 2 s, 4 s, 8 s, 16 s) and show it in the connector state.
      reconnect: {},
      onUnauthorized: async (challenge) => {
        if (!config.url) return null
        if (challenge) this.mcpChallenges.set(config.name, challenge)
        // Refresh a stored token silently. Opening a consent screen is an
        // explicit action (authorizeMcp), so app startup never blocks on it.
        return this.oauth.token(config.name).catch(() => null)
      },
      // The client already reloaded its own lists (debounced): only this server's tools change, nothing restarts.
      onToolsChanged: (kind) => {
        this.options.log?.(`MCP ${config.name}: ${kind ?? 'ferramentas'} atualizadas (list_changed)`)
        this.scheduleMcpRefresh()
      },
      onStateChange: () => this.scheduleMcpRefresh()
    })
    // Registered before it answers so the panel can show it as "starting".
    this.mcpClients.set(config.name, client)
    if (missing.length) {
      // A credential the vault no longer has: never start the server with half of its credentials.
      const names = missing.map((inner) => {
        const key = inner.slice(inner.indexOf('.') + 1)
        try {
          return decodeURIComponent(key)
        } catch {
          return key
        }
      })
      this.mcpSecretIssues.set(config.name, names)
      client.state = 'error'
      client.lastError = `credencial ausente do cofre: ${names.join(', ')}`
      return
    }
    const startMs = typeof config.startTimeoutMs === 'number' && config.startTimeoutMs > 0 ? config.startTimeoutMs : DEFAULT_START_TIMEOUT_MS
    const startedAt = Date.now()
    let guard: NodeJS.Timeout | undefined
    try {
      // The client bounds its own start (the handshake, then at least MIN_LISTING_TIMEOUT_MS per listing); this is
      // the last line of defence against a start that never returns, so it must outlast that.
      await Promise.race([
        client.start(startMs),
        new Promise<never>((_, reject) => {
          guard = setTimeout(
            () => reject(new Error(`o servidor MCP ${config.name} não terminou de iniciar em ${Math.round(startMs / 1000)} s`)),
            startMs + MIN_LISTING_TIMEOUT_MS + 5_000
          )
        })
      ])
      // How long each server really takes to come up is what tells a slow machine from a broken server.
      this.options.log?.(`MCP ${config.name}: pronto em ${((Date.now() - startedAt) / 1000).toFixed(1)} s (${client.exposedToolsList().length} ferramenta(s))`)
    } catch (err) {
      const message = (err as Error).message
      if (client.state === 'starting') {
        await client.stop().catch(() => undefined)
        client.state = 'error'
      }
      client.lastError = message
      this.options.log?.(`MCP ${config.name}: ${message.slice(0, 300)}`)
      if (attempt === 0 && MCP_START_TIMEOUT.test(message)) this.retryMcpStartOnce(config.name, client)
    } finally {
      if (guard) clearTimeout(guard)
    }
    this.scheduleMcpRefresh()
  }

  /**
   * A server that ran out of time on its first start gets one more attempt, in the background. The machine is at its
   * busiest right after the app opens (a dozen servers, the voice engine, the memory service) and the first attempt
   * already warmed what `uvx`/`npx` download on first use, so the second one usually fits: `jira` took 18 s cold and 8 s
   * warm. Auth failures, a crash or a missing command are not retried. If the user reconnects, reloads or disables the
   * server meanwhile, its client was replaced and nothing happens.
   */
  private retryMcpStartOnce(name: string, failed: McpClient): void {
    const previous = this.mcpStartRetries.get(name)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.mcpStartRetries.delete(name)
      if (this.mcpClients.get(name) !== failed || failed.state !== 'error') return
      this.options.log?.(`MCP ${name}: nova tentativa de partida (a primeira esgotou o prazo)`)
      void this.startMcpServers(name, 1).catch((err) => this.options.log?.(`MCP ${name}: ${(err as Error).message}`))
    }, this.options.mcpStartRetryDelayMs ?? 3_000)
    timer.unref?.()
    this.mcpStartRetries.set(name, timer)
  }

  async restartMcp(): Promise<void> {
    await this.startMcpServers()
  }

  /**
   * Restarts the servers from the saved settings (all, or only `server`) and rebuilds their tools. This is what
   * `mcp_reload` runs. Unlike `restartMcp`, it reports what each server ended up as.
   */
  async reloadMcpServers(server?: string): Promise<McpReloadReport> {
    const configured = this.settings.get().mcpServers ?? []
    if (server && !configured.some((config) => config.name === server)) return { servers: [] }
    await this.startMcpServers(server)
    const names = server ? [server] : configured.filter((config) => config.enabled).map((config) => config.name)
    return {
      servers: names.map((name) => {
        const client = this.mcpClients.get(name)
        const enabled = configured.find((config) => config.name === name)?.enabled !== false
        return {
          name,
          state: enabled ? (client?.state ?? 'stopped') : 'disabled',
          tools: client?.exposedToolsList().length ?? 0,
          error: client?.lastError ?? undefined,
          hint: client?.describe().hint
        }
      })
    }
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
    // A new conversation does not start on a provider the harness already knows cannot answer (no balance, refused key)
    // while another one works: asking it would only cost a failed request before the switch.
    const wanted = this.settings.providerConfig(input.providerId)
    if (wanted) {
      const start = this.reserve.startingPoint({ ...wanted, model: input.model || wanted.model })
      if (start.movedFrom) {
        this.options.log?.(
          `nova conversa: ${start.movedFrom.config.label} ${start.movedFrom.missingKey ? 'não tem chave configurada' : `está indisponível (${describeFailure(start.movedFrom.kind)})`}; começa em ${start.config.label}/${start.config.model}`
        )
        input = { ...input, providerId: start.config.id, model: start.config.model }
      }
    }
    return this.store.createSession(input)
  }

  /** Logs any step of starting a turn that takes more than a second: a slow start must leave a trace. */
  private async slowStep<T>(label: string, work: Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      return await work
    } finally {
      const ms = Date.now() - started
      if (ms > 1_000) this.options.log?.(`iniciar turno: "${label}" levou ${(ms / 1000).toFixed(1)} s`)
    }
  }

  async ensureRunner(sessionId: string): Promise<SessionRunner> {
    const existing = this.runners.get(sessionId)
    if (existing) return existing

    const state = await this.slowStep('carregar a sessão', this.store.loadSession(sessionId))
    if (!state) throw new Error(`sessão não encontrada: ${sessionId}`)
    ensureProjectInstructions(state.meta.cwd)
    const settings = this.settings.get()
    const providerConfig =
      this.settings.providerConfig(state.meta.providerId) ??
      settings.providers.find((p) => p.id === settings.defaultProviderId) ??
      settings.providers[0]
    if (!providerConfig) throw new Error('nenhum provedor configurado')
    // The session's own provider, unless it has no key or the harness already knows it cannot answer (no balance, refused
    // key...) and another one works: then the session starts there, and the conversation says so.
    const start = this.reserve.startingPoint({ ...providerConfig, model: state.meta.model || providerConfig.model })
    // llama.cpp (local) is started by the app: a session on it starts the server and waits for the model to load.
    const activeConfig =
      start.config.id === LLAMACPP_PROVIDER_ID ? await this.slowStep('iniciar o llama.cpp', this.llamacpp.ensureReady(start.config)) : start.config
    if (!hasCredentials(activeConfig, this.settings.resolver())) {
      throw new Error(
        `o provedor "${activeConfig.label}" não tem credencial configurada. Abra Configurações → Provedores.`
      )
    }
    if (start.movedFrom) this.announceStartMove(sessionId, state, start.movedFrom, activeConfig)
    const provider = createProvider(activeConfig, this.settings.resolver())
    const fallback = this.reserve.chainFor(activeConfig)
    const tracker = this.trackers.get(sessionId) ?? new FileTracker(state.meta.cwd)
    if (state.changes?.length) tracker.restore(state.changes)
    this.trackers.set(sessionId, tracker)

    const browserSettings = settings.browser ?? { mode: 'auto' as const, groupBySession: true }
    const browser = this.browsers.get(sessionId) ?? new BrowserLayer({
      sessionId,
      chrome: this.chromeBridge,
      mode: browserSettings.mode,
      groupBySession: browserSettings.groupBySession,
      fallbackToManaged: browserSettings.fallbackToManaged
    })
    this.browsers.set(sessionId, browser)

    // A memória é escopada por projeto no modo Code/Cowork e por SESSÃO nos chats do Início (cada chat tem a sua).
    const memoryScope = memoryScopeId(state.meta)
    const memory =
      this.memories.get(sessionId) ??
      new MemoryStore(path.join(userDataPath(this.options.userData, 'data'), 'memory', `${memoryScope}.json`))
    this.memories.set(sessionId, memory)

    // One markdown wiki per memory scope (per project in Code/Cowork; per chat session on Início),
    // shared by every agent and model working in that scope.
    const projectMemory =
      this.projectMemories.get(memoryScope) ??
      new ProjectMemory(path.join(userDataPath(this.options.userData, 'data'), 'memory', 'projects', memoryScope))
    this.projectMemories.set(memoryScope, projectMemory)
    // Split legacy session logs and build the per-subject index before the
    // runner reads the briefing.
    await this.slowStep('memória do projeto (init)', projectMemory.init())
    // Copying every wiki page into AI-Memory is two HTTP calls per page: minutes on a project with dozens of pages.
    // It used to run HERE, so the first message after every app start sat in the composer until it finished.
    // It runs in the background now; recall still works from what AI-Memory already has.
    this.syncNativeToAiInBackground(memoryScope)

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
    const branch = await this.slowStep('ramo do git', gitBranch(state.meta.cwd))
    const { policy: sessionPolicy, hooks } = this.sessionConfig(state)
    const policy: PolicyConfig = settings.policy.mode === 'unrestricted'
      ? { ...sessionPolicy, ...effectivePolicy }
      : sessionPolicy
    this.sessionPolicies.set(sessionId, policy)
    this.sessionHooks.set(sessionId, hooks)

    const agents = this.agentRegistryFor(state.meta.cwd)
    const toolchainText = describeToolchains(await this.slowStep('detectar ferramentas instaladas', toolchains()))
    const agentEnv = this.agentEnv(agents, toolchainText)
    const runner = new SessionRunner({
      sessionId,
      cwd: state.meta.cwd,
      mode: state.meta.mode,
      provider,
      providerConfig: activeConfig,
      fallback,
      health: this.reserve.health,
      vision: { candidates: () => this.reserve.visionCandidates() },
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
        aiMemory: this.aiMemory,
        terminal: this.options.terminalRunner,
        // memory_file: pictures saved in the memory are described by the first model that reads images.
        describeImage: (image, question) => describeImage({ candidates: this.reserve.visionCandidates(), image, question })
      },
      projectId: memoryScope,
      project: {
        name: project?.name ?? path.basename(state.meta.cwd),
        branch: branch ?? undefined,
        isGitRepo: Boolean(branch)
      },
      hooks,
      toolOutputDir: this.toolOutputDir(),
      systemExtra: toolchainText,
      emit: (event) => this.onEvent(event),
      approve: (request) => this.approve(request),
      ask: (request) => this.askQuestions(request),
      agents,
      autoAgents: Boolean(settings.autoAgents),
      selfReview: settings.selfReview !== false,
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

  /** Sessions whose runner must be rebuilt once the turn that is running now ends. */
  private pendingDrops = new Set<string>()

  /**
   * Model, mode, effort and environment changes must not kill a turn in progress: the new value is
   * saved at once and the runner is rebuilt (so it is picked up) as soon as the turn ends.
   */
  private dropRunnerWhenIdle(sessionId: string): void {
    const runner = this.runners.get(sessionId)
    if (runner?.busy) this.pendingDrops.add(sessionId)
    else this.dropRunner(sessionId)
  }

  /* -------------------------------- agents -------------------------------- */

  private userAgentsDir(): string {
    return path.join(this.options.userData, 'agents')
  }

  /**
   * Built-in agents plus the user's (`<userData>/agents`) and the project's (`.openclod/agents`);
   * `.claude/agents` too when the Claude settings import is on. Cheap, so it is re-read whenever a runner is built.
   */
  agentRegistryFor(cwd?: string): AgentRegistry {
    return createAgentRegistry({
      userDir: this.userAgentsDir(),
      cwd,
      importClaude: Boolean(this.settings.get().importClaudeSettings),
      bundledDir: resourcePath('agents') ?? undefined
    })
  }

  /** Every agent the folder `cwd` can use (hidden utilities included, flagged `hidden`) plus the files that failed to load. */
  listAgents(cwd?: string): AgentsListing {
    return this.agentRegistryFor(cwd).listing()
  }

  /**
   * Writes a new agent file (`user`: <userData>/agents, `project`: <cwd>/.openclod/agents) and refreshes idle
   * sessions so their next turn sees it. Throws a readable error for invalid input or an existing name.
   */
  createAgent(input: { scope: 'user' | 'project'; cwd?: string; agent: AgentDefinition; overwrite?: boolean }): { path: string; listing: AgentsListing } {
    if (input.scope === 'project' && !input.cwd) throw new Error('informe a pasta do projeto para criar um agente de projeto')
    const dir = input.scope === 'project' ? path.join(input.cwd as string, '.openclod', 'agents') : this.userAgentsDir()
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
    const dir = scope === 'project' ? path.join(cwd as string, '.openclod', 'agents') : this.userAgentsDir()
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
   * A session that starts on another provider than the one it was saved with (the saved one is known to be down): saves
   * the new provider on the session, tells the composer, and, when the session already has a history, leaves a line in the
   * conversation. An empty session only gets the new provider (a first message is what names it and starts its history).
   */
  private announceStartMove(
    sessionId: string,
    state: SessionState,
    from: { config: ProviderConfig; kind: ProviderErrorKind; missingKey?: boolean },
    to: ProviderConfig
  ): void {
    const why = from.missingKey ? 'não tem chave configurada' : `está indisponível (${from.kind}: ${describeFailure(from.kind)})`
    const text =
      `${from.config.label}/${from.config.model} ${why}; ` +
      `esta conversa continua com ${to.label}/${to.model}. A conversa, o plano e a memória do projeto foram preservados.`
    // onEvent saves the new provider/model on the session for every model_switch.
    this.onEvent({
      type: 'model_switch',
      sessionId,
      from: { providerId: from.config.id, label: from.config.label, model: from.config.model },
      to: { providerId: to.id, label: to.label, model: to.model },
      reason: from.kind
    })
    if (!state.messages.length) return
    const message: Message = {
      id: id('msg'),
      role: 'system',
      ts: Date.now(),
      parts: [{ type: 'text', text }],
      notice: { kind: 'model_switch', level: 'warn' }
    }
    state.messages.push(message)
    this.onEvent({ type: 'message', sessionId, message })
    this.onEvent({ type: 'notice', sessionId, level: 'warn', desktop: false, text })
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
      // The embedded engine comes before the local servers the user has to install and run.
      [LLAMACPP_PROVIDER_ID]: 6,
      ollama: 7,
      lmstudio: 8
    }
    const providers = settings.providers
      .filter((provider) => hasCredentials(provider, resolver))
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
          groupBySession: browser.groupBySession,
          fallbackToManaged: browser.fallbackToManaged
        })
      },
      emit: (event) => this.onEvent(event),
      approve: (request) => this.approve(request),
      toolOutputDir: this.toolOutputDir(),
      // A specialist agent whose provider runs out of credit moves to the next one that works, like the session itself.
      reserve: {
        chainFor: (config) => this.reserve.chainFor(config),
        health: this.reserve.health,
        visionCandidates: () => this.reserve.visionCandidates()
      },
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
  /**
   * Slash commands visible from a folder: the ones that ship with the app (resources/commands), then the user's, then the
   * project's `.claude/commands` and `.openclod/commands` (a later one with the same name wins).
   */
  commandsFor(cwd: string): CustomCommand[] {
    const bundled = resourcePath('commands')
    return loadCustomCommands([
      ...(bundled ? [{ dir: bundled, source: 'app' as const }] : []),
      { dir: path.join(this.options.userData, 'commands'), source: 'usuario' },
      { dir: path.join(cwd, '.claude', 'commands'), source: 'projeto' },
      { dir: path.join(cwd, '.openclod', 'commands'), source: 'projeto' }
    ])
  }

  /**
   * `/nome argumentos` before it reaches the model: a command becomes its text (with `@arquivo` files and its
   * `allowed-tools`), `/skill argumentos` asks for that skill, and any other `/palavra` is refused as an unknown command
   * instead of being sent as a prompt. A path (`/usr/bin/x`) is not a command.
   */
  expandSlash(sessionId: string, text: string): { text: string; allowedTools?: string[] } {
    const word = slashWord(text)
    const cwd = this.store.getSession(sessionId)?.meta.cwd
    if (!word || !cwd) return { text }
    const commands = this.commandsFor(cwd)
    const match = matchCustomCommand(text, commands)
    if (match) {
      return {
        text: expandCommand(match.command, match.args, { cwd }),
        ...(match.command.allowedTools ? { allowedTools: match.command.allowedTools } : {})
      }
    }
    const skill = this.skills.list().find((item) => item.name.toLowerCase() === word.name)
    if (skill) return { text: `Use a skill "${skill.name}" para esta tarefa: ${word.args}`.trim() }
    const known = commands.map((command) => `/${command.name}`).slice(0, 20).join(', ')
    throw new Error(
      `comando desconhecido: /${word.name}.${known ? ` Comandos disponíveis: ${known}.` : ''} Os da interface (/novo, /compactar...) são escolhidos no menu que abre ao digitar "/".`
    )
  }

  async send(sessionId: string, text: string, images?: ImagePart[], keepTitle = false): Promise<void> {
    const slash = this.expandSlash(sessionId, text)
    text = slash.text
    const runner = await this.ensureRunner(sessionId)
    if (runner.messages.length === 0 && !keepTitle) {
      const title = text.replace(/\s+/g, ' ').slice(0, 60)
      await this.store.patchMeta(sessionId, { title })
    }
    const messageId = id('msg')
    await this.captureFileCheckpoint(sessionId, messageId)
    await runner.send(text, { images, messageId, prepare: this.mediaPrepare(sessionId, text), prepareLabel: 'media_ingest', allowedTools: slash.allowedTools })
    await this.captureTurnMemory(sessionId, runner, text)
  }

  /**
   * Starts a turn and returns as soon as it is accepted. The renderer must not
   * wait for the whole turn (which can take minutes); progress arrives as
   * events. Failures before the turn starts are thrown here.
   */
  async startSend(sessionId: string, text: string, images?: ImagePart[], mode: 'steer' | 'queue' | 'auto' = 'auto'): Promise<void> {
    // A slash command is expanded here, so every way in (the composer, scheduled tasks, the queue) gets the same.
    const slash = this.expandSlash(sessionId, text)
    text = slash.text
    const runner = await this.ensureRunner(sessionId)
    if (runner.busy) {
      const item = this.inbox.add(sessionId, { text, images, mode: mode === 'steer' ? 'steer' : 'queue' })
      // A steer delivered into the running turn now lives in the conversation, not in the inbox. If the turn ended in
      // the meantime it waits in the queue instead.
      if (item.mode === 'steer') {
        this.inbox.remove(sessionId, item.id)
        if (!runner.steer(text)) this.inbox.add(sessionId, { text, images, mode: 'queue' })
      }
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
    // Nothing running: a "queue" message is simply sent now (keeping a copy in the inbox made the drain after this
    // turn send it a second time).
    if (runner.messages.length === 0) {
      const title = text.replace(/\s+/g, ' ').slice(0, 60)
      await this.store.patchMeta(sessionId, { title })
    }
    const messageId = id('msg')
    await this.captureFileCheckpoint(sessionId, messageId)
    void runner
      .send(text, { images, messageId, prepare: this.mediaPrepare(sessionId, text), prepareLabel: 'media_ingest', allowedTools: slash.allowedTools })
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
        const messageId = id('msg')
        await this.captureFileCheckpoint(sessionId, messageId)
        await runner.send(next.text, { images: next.images, messageId, prepare: this.mediaPrepare(sessionId, next.text), prepareLabel: 'media_ingest' })
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

  /**
   * Audio and video the USER attached or named in the message are processed before the first model call: transcript,
   * frames, contact sheets and the text on the frames go into the project's memory (src/core/media), and the model gets a
   * short digest with the slugs of the pages to open. No interface: the file goes in, the knowledge stays. Only paths in
   * the user's own text count, never in tool output. Returns nothing for a message without media.
   */
  private mediaPrepare(sessionId: string, text: string): SendOptions['prepare'] | undefined {
    const files = findMediaPaths(text).filter((file) => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })
    if (!files.length) return undefined
    const meta = this.store.getSession(sessionId)?.meta
    if (!meta) return undefined
    const memoryScope = memoryScopeId(meta)
    return async ({ signal, progress }) => {
      const memory = this.memoryForProject(memoryScope)
      const digests: string[] = []
      const images: ImagePart[] = []
      // A few notices, not a flood: one per phase, and at most one every few seconds within a phase.
      let lastAt = 0
      let lastPhase = ''
      const note = (message: string): void => {
        const phase = message.split(':')[0]
        if (phase === lastPhase && Date.now() - lastAt < 6_000) return
        lastPhase = phase
        lastAt = Date.now()
        progress(message)
      }
      for (const [index, file] of files.entries()) {
        progress(`Processando ${path.basename(file)}${files.length > 1 ? ` (${index + 1} de ${files.length})` : ''}: transcrição, frames e memória…`)
        try {
          const result = await ingestToMemory({
            file,
            memory,
            mirror: async (draft) => {
              await this.aiMemory.writePage(memoryScope, { path: `pages/${draft.slug}.md`, title: draft.title, body: draft.body, tags: draft.tags, tier: 'semantic' })
            },
            signal,
            onProgress: note
          })
          digests.push(result.digest)
          images.push(...loadSheetImages(result.dir, result.manifest, 2))
          progress(`${path.basename(file)} processado: ${result.manifest.frames.length} frames, ${result.manifest.transcript.segments.length} trechos de fala, ${result.plan.parts.length} parte(s) na memória.`)
        } catch (error) {
          if (signal.aborted) throw error
          digests.push(`Não consegui processar ${path.basename(file)}: ${(error as Error).message}`)
          progress(`Não consegui processar ${path.basename(file)}: ${(error as Error).message}`)
        }
      }
      return { text: `<midia-processada>\n${digests.join('\n\n')}\n</midia-processada>`, images: images.slice(0, 3) }
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

  private checkpointRoot(): string {
    return path.join(userDataPath(this.options.userData, 'data'), 'checkpoints')
  }

  private async captureFileCheckpoint(sessionId: string, messageId: string): Promise<void> {
    try {
      const cwd = this.store.getSession(sessionId)?.meta.cwd
      if (!cwd) return
      const checkpoint = await captureGitFileCheckpoint(cwd, path.join(this.checkpointRoot(), sessionId, messageId))
      if (!checkpoint) return
    } catch (error) {
      this.onEvent({
        type: 'notice',
        sessionId,
        level: 'warn',
        text: `checkpoint de arquivos indisponível: ${(error as Error).message}`
      })
    }
  }

  /**
   * Deterministic memory capture after every turn. The agent can still write
   * curated pages/handoffs, but a model that never calls memory_page still
   * leaves a durable session record in the project wiki.
   */
  /** Turn memory being written right now, per session: discarding a plan waits for it, or it would write the capsule back. */
  private readonly memoryWrites = new Map<string, Promise<void>>()

  private async captureTurnMemory(sessionId: string, runner: SessionRunner, userText: string): Promise<void> {
    const write = this.writeTurnMemory(sessionId, runner, userText)
    this.memoryWrites.set(sessionId, write)
    try {
      await write
    } finally {
      if (this.memoryWrites.get(sessionId) === write) this.memoryWrites.delete(sessionId)
    }
  }

  /**
   * Pictures pasted in the user's message (with the description the vision relay already wrote, when there is one) and
   * the files whose absolute path the user wrote go into the project memory, linked to the turn and the session pages.
   */
  private async keepTurnFiles(memory: ProjectMemory, message: Message | undefined, userText: string, links: string[], title: string): Promise<void> {
    const describe = (image: ImagePart, question?: string) => describeImage({ candidates: this.reserve.visionCandidates(), image, question })
    const pictures = (message?.parts ?? []).filter((part): part is ImagePart & { type: 'image' } => part.type === 'image').slice(0, 8)
    const named = findFilePaths(userText).filter((file) => {
      try {
        const stat = fs.statSync(file)
        return stat.isFile() && stat.size <= 100 * 1024 * 1024
      } catch {
        return false
      }
    })
    if (!pictures.length && !named.length) return
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    let temp = ''
    try {
      for (const [index, picture] of pictures.entries()) {
        temp ||= await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openclod-memoria-'))
        const ext = picture.mediaType === 'image/png' ? 'png' : picture.mediaType === 'image/webp' ? 'webp' : 'jpg'
        const file = path.join(temp, `imagem-${index + 1}.${ext}`)
        await fs.promises.writeFile(file, Buffer.from(picture.data, 'base64'))
        await addMemoryFile(file, {
          memory,
          name: `${picture.label?.trim() || `imagem da conversa ${stamp}${pictures.length > 1 ? ` (${index + 1})` : ''}`}.${ext}`.replace(/(\.\w+)\.\w+$/, '$1'),
          origin: `colada na conversa "${title}" em ${stamp}`,
          ...(picture.description ? { description: picture.description, describedBy: picture.describedBy ?? 'relé de visão' } : { describe }),
          question: userText.slice(0, 300),
          links,
          tags: ['conversa']
        })
      }
      for (const file of named) await addMemoryFile(file, { memory, describe, question: userText.slice(0, 300), links, tags: ['conversa'] })
    } catch (err) {
      this.options.log?.(`memória: não guardei os arquivos da conversa: ${(err as Error).message}`)
    } finally {
      if (temp) await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async writeTurnMemory(sessionId: string, runner: SessionRunner, userText: string): Promise<void> {
    try {
      const state = await this.store.loadSession(sessionId)
      if (!state) return
      const memoryScope = memoryScopeId(state.meta)
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
      const memory = this.memoryForProject(memoryScope)
      const captured = await memory.rememberTurn({
        sessionTitle: state.meta.title,
        sessionId,
        turnId: lastUser?.id,
        userText,
        assistantText,
        tools,
        files
      })
      if (!captured) return
      // What the user brought to the conversation stays with it: pasted pictures and the files named in the message become
      // pages of the memory, linked to this turn and this session (in the background: nothing here waits for it).
      void this.keepTurnFiles(memory, lastUser, userText, [captured.turn.slug, captured.session.slug], state.meta.title)

      // One small AI-Memory page per turn plus a session index page. The old
      // `s/<hash>.md` transcript is intentionally not written anymore: search
      // must return the relevant turn, not a giant session dump.
      for (const summary of [captured.turn, captured.session]) {
        const page = await memory.readPage(summary.slug)
        if (!page) continue
        const pagePath = `pages/${summary.slug}.md`
        const related = page.body.includes('## Relacionados')
          ? ''
          : await this.aiMemory
              .relatedMarkdown(memoryScope, `${page.title}\n${page.body}`, pagePath, 4)
              .catch(() => '')
        await this.aiMemory.writePage(memoryScope, {
          path: pagePath,
          title: page.title,
          body: related ? `${page.body}\n\n## Relacionados\n\n${related}` : page.body,
          tags: page.tags,
          pinned: page.pinned,
          tier: summary.kind === 'turn' ? 'episodic' : 'semantic'
        })
      }
      // Remove the previous monolithic session transcript from the index once
      // the atomic pages exist. It is redundant and would dominate recall.
      if (lastUser) {
        const legacyPath = `s/${shortHash(sessionId)}.md`
        await this.aiMemory.deletePage(memoryScope, legacyPath).catch(() => false)
      }

      // The continuity capsule: one page per session saying where the work stands (objective, plan, next step, files),
      // so another model in another session can "continue de onde paramos" without being told anything again.
      try {
        const text = (message: Message | undefined): string => message?.parts.find((part) => part.type === 'text')?.text ?? ''
        const firstUser = messages.find((message) => message.role === 'user' && !message.hidden)
        const summary = messages.find((message) => message.role === 'user' && message.hidden && text(message).startsWith('[Contexto compactado'))
        const capsule = await memory.recordState({
          sessionTitle: state.meta.title,
          sessionId,
          provider: this.settings.providerConfig(state.meta.providerId)?.label ?? state.meta.providerId,
          model: state.meta.model,
          runState: runner.state,
          firstRequest: text(firstUser) || userText,
          lastRequest: userText,
          result: assistantText,
          plan: runner.plan,
          files,
          summary: summary ? text(summary) : undefined
        })
        const page = await memory.readPage(capsule.summary.slug)
        if (page) {
          await this.aiMemory.writePage(memoryScope, {
            path: `pages/${capsule.summary.slug}.md`,
            title: page.title,
            body: page.body,
            tags: page.tags,
            pinned: page.pinned,
            tier: 'semantic'
          })
        }
      } catch (err) {
        this.options.log?.(`cápsula de continuidade da sessão ${sessionId} falhou: ${(err as Error).message}`)
      }
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
    for (const [questionId, pending] of [...this.pendingQuestions.entries()]) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pendingQuestions.delete(questionId)
      this.onEvent({ type: 'question_resolved', sessionId, id: questionId, answers: [] })
      pending.resolve(null)
    }
    this.onEvent({ type: 'status', sessionId, state: 'cancelled' })
  }

  /**
   * ▶ on a plan step after the turn stopped: that step becomes the interrupted active one (the runner's `<retomada>`
   * notice then makes the model reopen it) and a visible message starts the turn that continues from it.
   */
  async resumePlan(sessionId: string, itemId: string): Promise<void> {
    const runner = await this.ensureRunner(sessionId)
    if (runner.busy) throw new Error('a sessão ainda está trabalhando; pare o turno antes de retomar')
    const item = runner.resumePlanFrom(itemId)
    if (!item) throw new Error('esse passo não pode ser retomado (não está no plano ou já foi concluído)')
    await this.startSend(sessionId, `Continue a partir do passo: ${item.text}`)
  }

  /**
   * 🗑 on the plan dock: the user gave up. Stops the turn, empties the queue so nothing starts the work again, clears the
   * plan (with a hidden note so the next turn does not pick it up from the history) and forgets the session's
   * continuity capsule, so no other session is offered this work to "continue de onde paramos". There is no undo.
   */
  async discardPlan(sessionId: string): Promise<{ capsules: number }> {
    const state = await this.store.loadSession(sessionId)
    if (!state) throw new Error('sessão não encontrada')
    this.inbox.clear(sessionId)
    const live = this.runners.get(sessionId)
    if (live?.busy) {
      await this.abort(sessionId)
      const deadline = Date.now() + 15_000
      while (live.busy) {
        if (Date.now() > deadline) throw new Error('o turno não parou a tempo; tente descartar de novo')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    // The stopped turn still writes its memory (and the capsule) after it ends: wait, then remove what it wrote.
    await this.memoryWrites.get(sessionId)?.catch(() => undefined)
    const runner = this.runners.get(sessionId)
    if (runner) {
      runner.discardPlan()
    } else if (state.plan?.length) {
      const next: SessionState = { ...state, plan: [], messages: [...state.messages, discardedPlanNotice(state.plan)] }
      await this.store.saveSession(next)
      this.onEvent({ type: 'plan', sessionId, items: [] })
    }
    const capsules = await this.forgetContinuity(state.meta)
    return { capsules }
  }

  /** Deletes the continuity capsule(s) of one session from the native wiki and from the AI-Memory index. */
  private async forgetContinuity(meta: SessionMeta): Promise<number> {
    const memoryScope = memoryScopeId(meta)
    const memory = this.memoryForProject(memoryScope)
    const capsules = (await memory.listPages()).filter((page) => page.tags.includes('estado') && page.context === `sessao:${meta.id}`)
    for (const page of capsules) {
      await memory.deletePage(page.slug)
      await this.aiMemory.deletePage(memoryScope, `pages/${page.slug}.md`).catch(() => false)
    }
    return capsules.length
  }

  async setMode(sessionId: string, mode: SessionMeta['mode']): Promise<void> {
    this.dropRunnerWhenIdle(sessionId)
    await this.store.patchMeta(sessionId, { mode })
  }

  async setEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
    this.dropRunnerWhenIdle(sessionId)
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
    this.dropRunnerWhenIdle(sessionId)
    await this.store.patchMeta(sessionId, { environment: profile.id })
  }

  async setModel(sessionId: string, providerId: string, model: string): Promise<void> {
    this.dropRunnerWhenIdle(sessionId)
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
    await fs.promises.rm(path.join(this.checkpointRoot(), sessionId), { recursive: true, force: true }).catch(() => undefined)
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

  /**
   * Measured size of what the next request of a session carries. Only a session that already has a runner (it had a turn
   * since the app opened) can say: building one just to look would create files in the project and start the browser
   * layer, so a panel that is only being read gets `null` and shows its own estimate.
   */
  contextBreakdown(sessionId: string): ContextBreakdown | null {
    return this.runners.get(sessionId)?.contextBreakdown() ?? null
  }

  async compactSession(sessionId: string): Promise<SessionState | null> {
    const state = this.store.getSession(sessionId)
    if (!state) return null
    const runner = this.runners.get(sessionId)
    if (!runner) throw new Error('a sessão ainda não tem um executor ativo; envie uma mensagem primeiro')
    await runner.compactNow()
    return this.store.getSession(sessionId)
  }

  /** Conversation rewind. File edits stay on disk by design and remain visible in Alterações. */
  async rewindSession(sessionId: string, messageId: string, restoreFiles = false): Promise<SessionState | null> {
    const state = await this.store.loadSession(sessionId)
    if (!state) return null
    const runner = this.runners.get(sessionId)
    if (runner?.busy) throw new Error('pare o turno atual antes de voltar a uma mensagem')
    const messages = rewindMessages(state.messages, messageId)
    if (restoreFiles) {
      const source = [...messages].reverse().find((message) => {
        if (message.role !== 'user' || message.hidden) return false
        return fs.existsSync(path.join(this.checkpointRoot(), sessionId, message.id, 'checkpoint.json'))
      })
      if (!source) throw new Error('este ponto não possui checkpoint de arquivos Git')
      const checkpointDir = path.join(this.checkpointRoot(), sessionId, source.id)
      const restored = await restoreGitFileCheckpoint(state.meta.cwd, checkpointDir)
      this.onEvent({
        type: 'notice',
        sessionId,
        level: 'warn',
        text: `Arquivos restaurados ao checkpoint. O estado anterior à restauração foi preservado em ${restored.recoveryDir}`
      })
    }
    const next: SessionState = {
      ...state,
      messages,
      plan: [],
      approvals: [],
      state: 'idle'
    }
    if (runner) {
      runner.messages = messages
      runner.plan = []
      runner.state = 'idle'
    }
    await this.store.saveSession(next)
    return this.store.getSession(sessionId)
  }

  /** Branches a conversation into a new session without mutating the original. */
  async forkSession(sessionId: string, messageId: string): Promise<SessionState | null> {
    const state = await this.store.loadSession(sessionId)
    if (!state) return null
    const runner = this.runners.get(sessionId)
    if (runner?.busy) throw new Error('pare o turno atual antes de criar um chat lateral')
    const messages = rewindMessages(state.messages, messageId)
    const created = await this.store.createSession({
      projectId: state.meta.projectId,
      cwd: state.meta.cwd,
      mode: state.meta.mode,
      surface: state.meta.surface,
      providerId: state.meta.providerId,
      model: state.meta.model,
      title: `${state.meta.title.slice(0, 104)} · lateral`
    })
    const next: SessionState = {
      ...state,
      meta: {
        ...created,
        environment: state.meta.environment,
        effort: state.meta.effort
      },
      messages,
      plan: [],
      changes: [],
      approvals: [],
      usage: { input: 0, output: 0 },
      state: 'idle'
    }
    await this.store.saveSession(next)
    return this.store.getSession(created.id)
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
    // Everything stops in parallel and each part gets a deadline. It used to be one after the other with no limit:
    // with a dozen MCP servers (each one has to exit) closing the window took a minute or never finished.
    const within = (work: Promise<unknown>, ms: number): Promise<unknown> =>
      Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))])
    for (const timer of this.mcpStartRetries.values()) clearTimeout(timer)
    this.mcpStartRetries.clear()
    if (this.serviceWatch) clearInterval(this.serviceWatch)
    this.serviceWatch = null
    // Sessions whose runner was dropped by a settings change still get SessionEnd.
    const sessions = [...new Set([...this.runners.keys(), ...this.sessionHooks.keys()])]
    await within(Promise.all(sessions.map((sessionId) => this.dispose(sessionId, 'app_quit'))), 4_000)
    await Promise.all([
      ...[...this.mcpClients.values()].map((client) => within(client.stop(), 4_000)),
      within(this.aiMemory.stop(), 4_000),
      within(this.computer.close(), 4_000),
      within(this.chromeBridge.stop(), 2_000)
    ])
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

  /** Approvals still waiting for the user in this session (survive switching to another session and back). */
  pendingApprovals(sessionId: string): ApprovalRequest[] {
    return [...this.pending.values()].filter((item) => item.sessionId === sessionId).map((item) => item.request)
  }

  /**
   * What the session's runner holds right now (messages, plan, usage, run state). The stored copy is written
   * a fraction of a second after each change, so a reader that asks right after an event would see an older one.
   */
  liveSnapshot(sessionId: string): RunnerSnapshot | undefined {
    const runner = this.runners.get(sessionId)
    return runner ? runner.snapshot() : undefined
  }

  /** The "Permitir sempre" / "Negar sempre" choices saved per project (Configurações → Permissões). */
  savedApprovals(): Array<{ projectId: string; projectName: string; allow: string[]; deny: string[] }> {
    const projects = this.store.listProjects()
    return this.approvals
      .projects()
      .map((projectId) => ({ projectId, ...this.approvals.rules(projectId) }))
      .filter((item) => item.allow.length || item.deny.length)
      .map((item) => ({ ...item, projectName: projects.find((project) => project.id === item.projectId)?.name ?? item.projectId }))
  }

  /** Takes back one saved choice; the sessions of that project stop using it at once. */
  revokeApproval(projectId: string, rule: string, effect: 'allow' | 'deny'): boolean {
    const removed = this.approvals.remove(projectId, rule, effect)
    for (const [sessionId, policy] of this.sessionPolicies) {
      if (this.store.getSession(sessionId)?.meta.projectId !== projectId || !policy.rules) continue
      policy.rules[effect] = policy.rules[effect].filter((item) => item !== rule)
      // The exact call allowed for the rest of the session goes too.
      if (effect === 'allow') this.sessionAllow.delete(sessionId)
    }
    return removed
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
      // Without a preview the rule would cover every use of the tool. A command is saved by the words that name the
      // operation (`git commit -m x` → `Bash(git commit:*)`), one rule per command of a chain; a patch one per file.
      if (projectId && pending.request.risk !== 'destructive' && pending.request.preview) {
        for (const rule of rulesForApproval(pending.request.tool, pending.request.preview)) {
          try {
            this.approvals.add(projectId, rule)
            this.sessionPolicies.get(pending.sessionId)?.rules?.allow.push(rule)
          } catch {
            /* session-level allow still applies */
          }
        }
      }
    }
    // "Negar sempre": the exact call is refused from now on in this project, without asking.
    if (!approved && always && pending.request.preview) {
      const projectId = this.store.getSession(pending.sessionId)?.meta.projectId
      for (const rule of rulesForApproval(pending.request.tool, pending.request.preview, undefined, 'deny')) {
        try {
          if (projectId) this.approvals.add(projectId, rule, 'deny')
          this.sessionPolicies.get(pending.sessionId)?.rules?.deny.push(rule)
        } catch {
          /* this answer still denies */
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

  /* ------------------------------- questions ----------------------------- */

  /** Shows the questions above the composer and waits for the user (10 min). */
  async askQuestions(request: QuestionRequest): Promise<QuestionAnswer[] | null> {
    this.onEvent({ type: 'question_request', sessionId: request.sessionId, request })
    void this.sessionHooks
      .get(request.sessionId)
      ?.run('Notification', {
        message: `O Openclod precisa de uma resposta: ${request.questions.map((question) => question.header).join(', ')}`.slice(0, 500)
      })
      .catch(() => undefined)
    return new Promise<QuestionAnswer[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(request.id)
        this.onEvent({ type: 'question_resolved', sessionId: request.sessionId, id: request.id, answers: [] })
        resolve(null)
      }, 9 * 60 * 1000)
      this.pendingQuestions.set(request.id, { resolve, timer, sessionId: request.sessionId })
    })
  }

  /** Called by the renderer; false means the question expired or belongs to another session. */
  resolveQuestions(questionId: string, answers: QuestionAnswer[]): boolean {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pendingQuestions.delete(questionId)
    this.onEvent({ type: 'question_resolved', sessionId: pending.sessionId, id: questionId, answers })
    pending.resolve(answers)
    return true
  }

  /* ------------------------------- events -------------------------------- */

  private onEvent(event: HarnessEvent): void {
    this.options.broadcast(event)
    // Live output can fire every 600 ms; it is useful in the UI, not in the
    // durable event journal (which would grow without bound).
    if (event.type !== 'tool_progress') {
      this.eventQueue = this.eventQueue
        .then(() => this.store.appendEvent(event.sessionId, event))
        .catch(() => undefined)
    }

    if (event.type === 'status') {
      const existing = this.store.getSession(event.sessionId)
      if (existing) existing.state = event.state
    }
    if (event.type === 'model_switch') {
      // The session lives on the new model from now on: the runner that is rebuilt after a settings save or a restart
      // starts there instead of asking the exhausted provider again, and the composer shows it.
      this.options.log?.(
        `sessão ${event.sessionId}: ${event.from.label}/${event.from.model} → ${event.to.label}/${event.to.model} (${event.reason})`
      )
      void this.store.patchMeta(event.sessionId, { providerId: event.to.providerId, model: event.to.model }).catch(() => undefined)
    }
    if (event.type === 'turn_end' && this.pendingDrops.delete(event.sessionId)) {
      // The turn is over: rebuild the runner so the model/mode chosen meanwhile takes effect.
      setTimeout(() => {
        const runner = this.runners.get(event.sessionId)
        if (runner && !runner.busy) this.dropRunner(event.sessionId)
      }, 0)
    }
  }

  private persist(sessionId: string, snapshot: RunnerSnapshot): void {
    const existingTimer = this.persistTimers.get(sessionId)
    if (existingTimer) clearTimeout(existingTimer)
    const timer = setTimeout(() => {
      this.persistTimers.delete(sessionId)
      void this.flush(sessionId, snapshot).catch((err) =>
        this.options.log?.(`não consegui salvar a sessão ${sessionId}: ${(err as Error).message}`)
      )
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
          resources: client.resourcesList(),
          prompts: client.promptsList(),
          error: client.lastError ?? undefined
        }
      }),
      providers: settings.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        configured: hasCredentials(provider, this.settings.resolver()),
        unavailable: this.reserve.statusOf(provider.id)
      })),
      toolchains: await toolchains(),
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`
    }
  }

  /** Lists the models a saved provider serves (Ollama, LM Studio, OpenAI-compatible, Anthropic). */
  async discoverModels(providerId: string, draft?: Partial<Pick<ProviderConfig, 'baseUrl' | 'kind' | 'model'>>): Promise<DiscoveryResult> {
    const saved = this.settings.providerConfig(providerId)
    if (!saved) throw new Error('provedor não encontrado')
    // The form may hold an address that is not saved yet: ask THAT server (the key is the one in the vault).
    const config = { ...saved, ...draft }
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
    const challenge = this.mcpChallenges.get(serverName)
    let token: string | null
    try {
      // The directory may bring a public client id / scopes for servers without dynamic registration.
      token = await this.oauth.reauthorize(serverName, config.url, challenge, this.connectors.oauthOptions(serverName))
    } catch (err) {
      // Setup failures carry a fix the user can act on (no dynamic registration, no OAuth metadata...).
      if (err instanceof OAuthSetupError && err.hint) throw new Error(`${err.message}. ${err.hint}`)
      throw err
    }
    if (!token) return { connected: false, detail: 'O provedor não concluiu o login OAuth.' }
    this.connectors.loginFinished(serverName)
    await this.startMcpServers(serverName)
    const client = this.mcpClients.get(serverName)
    return client?.state === 'ready'
      ? { connected: true, detail: 'Login OAuth concluído; conector reiniciado.' }
      : {
          connected: false,
          detail: `Login OAuth concluído, mas o conector não ficou pronto: ${client?.lastError ?? 'sem detalhes'}`
        }
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

  /* ----------------- connectors (Personalização → Conectores) ---------------- */

  connectorDirectory(): ConnectorDirectory {
    return this.connectors.directory()
  }

  connectorStates(): ConnectorState[] {
    return this.connectors.states()
  }

  connectConnector(id: string, input?: ConnectInput): Promise<ConnectResult> {
    return this.connectors.connect(id, input)
  }

  disconnectConnector(id: string): Promise<ConnectorState> {
    return this.connectors.disconnect(id)
  }

  connectorTools(serverName: string): ConnectorTool[] {
    return this.connectors.tools(serverName)
  }

  setToolPolicy(serverName: string, tool: string, policy: ToolPolicy): Promise<ConnectorTool[]> {
    return this.connectors.setToolPolicy(serverName, tool, policy)
  }

  reloadMcp(): Promise<ConnectorState[]> {
    return this.connectors.reload()
  }

  /** `mcpServers` with every credential masked, for the JSON editor in Configurações → MCP. */
  maskedMcpSettings(): McpServerSettings[] {
    return this.connectors.maskedSettings()
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
    await this.settings.update({ mcpServers: merged.slice(0, MAX_MCP_SERVERS), claudeCatalogImported: true })
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
      install: async (request) => {
        let input = request
        let server: McpServerSettings | null = null
        let missing: string[] = []
        let needsOAuth = false
        let error: string | undefined
        // `reuse_credentials_from`: another server lends its credentials inside the app; the values never reach the model.
        let reused: string[] = []
        if (input.reuseCredentialsFrom) {
          try {
            const entry = !input.url && !input.command ? catalogEntry(input.id) : null
            const blank = (record: Record<string, string> | undefined): string[] =>
              Object.entries(record ?? {}).filter(([, value]) => !value?.trim()).map(([key]) => key)
            const filled = (record: Record<string, string> | undefined): Record<string, string> =>
              Object.fromEntries(Object.entries(record ?? {}).filter(([, value]) => value?.trim()))
            const lent = this.connectors.reuseCredentials(
              input.reuseCredentialsFrom,
              entry
                ? {
                    // Only what the server requires: optional extras (a second product's token) stay the user's choice.
                    env: (entry.env ?? []).filter((item) => item.required).map((item) => item.key),
                    headers: (entry.headers ?? []).filter((item) => item.required).map((item) => item.key)
                  }
                : { env: blank(input.env), headers: blank(input.headers) }
            )
            input = { ...input, env: { ...lent.env, ...filled(input.env) }, headers: { ...lent.headers, ...filled(input.headers) } }
            reused = lent.keys
          } catch (err) {
            return { ok: false, error: (err as Error).message }
          }
        }

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

        const reusedKeys = reused.length ? reused : undefined
        if (!server) return { ok: false, missing, needsOAuth, error: error ?? 'servidor não encontrado no catálogo nem no registro', reused: reusedKeys }

        const current = this.settings.get().mcpServers ?? []
        const next = [...current.filter((item) => item.name !== server!.name), server].slice(-MAX_MCP_SERVERS)
        await this.settings.update({ mcpServers: next })
        this.onEvent({ type: 'settings_changed', sessionId: '', scope: 'mcp' })
        // Only the new/changed server restarts: the other servers keep running (and a hung one cannot delay this).
        await this.startMcpServers(server.name)
        const client = this.mcpClients.get(server.name)
        // An OAuth connector gets its login screen right away (in the background), like connecting it in Conectores.
        if (needsOAuth && server.url && client?.state !== 'ready') {
          void this.connectors.beginLogin(server.name).catch((err) => this.options.log?.(`login OAuth de ${server!.name}: ${(err as Error).message}`))
        }
        return {
          ok: Boolean(client?.state === 'ready') || Boolean(needsOAuth),
          name: server.name,
          state: client?.state ?? 'stopped',
          tools: client?.exposedToolsList().map((tool) => tool.name) ?? [],
          needsOAuth,
          error: client?.lastError ?? undefined,
          reused: reusedKeys
        }
      },
      list: () => {
        const configs = this.settings.get().mcpServers ?? []
        return configs.map((config) => {
          const client = this.mcpClients.get(config.name)
          const exposed = this.baseRegistry.list().filter((tool) => tool.mcp?.server === config.name)
          return {
            name: config.name,
            state: config.enabled ? (client?.state ?? 'stopped') : 'disabled',
            transport: client?.transport ?? config.type ?? 'stdio',
            tools: client?.exposedToolsList().map((tool) => tool.name) ?? [],
            resources: client?.resourcesList() ?? [],
            prompts: client?.promptsList() ?? [],
            resourceTemplates: client?.resourceTemplatesList() ?? [],
            error: client?.lastError ?? undefined,
            hint: client?.describe().hint,
            hidden: client?.hiddenToolCount || undefined,
            deferred: exposed.filter((tool) => tool.mcp?.deferred).length || undefined,
            skipped: this.mcpSkipped.filter((item) => item.server === config.name).map((item) => ({ tool: item.tool, reason: item.reason })),
            reconnect: client?.reconnectAttempt
              ? `reconectando (tentativa ${client.reconnectAttempt}${client.state === 'error' ? ', aguardando' : ''})`
              : undefined
          }
        })
      },
      policy: (server, tool) => this.mcpClients.get(server)?.policyFor(tool),
      hint: (server, message) => {
        const config = (this.settings.get().mcpServers ?? []).find((item) => item.name === server)
        return hintForMcpError(server, config, message)
      },
      reload: (server) => this.reloadMcpServers(server),
      catalog: () => {
        const configs = this.settings.get().mcpServers ?? []
        return [...this.mcpClients.entries()].map(([name, client]) => {
          const config = configs.find((item) => item.name === name)
          return {
            name,
            state: client.state,
            transport: config?.type ?? (config?.url ? 'http' : 'stdio'),
            tools: client.exposedToolsList().map((tool) => ({
              name: tool.name,
              description: tool.description
            })),
            error: client.lastError ?? undefined
          }
        })
      },
      schema: (server, tool) => {
        const client = this.mcpClients.get(server)
        const hit = client?.exposedToolsList().find((item) => item.name === tool)
        return hit
          ? { name: hit.name, description: hit.description, inputSchema: hit.inputSchema }
          : undefined
      },
      call: async (server, tool, args, signal, options) => {
        const client = this.mcpClients.get(server)
        if (!client) throw new Error(`servidor MCP "${server}" não está disponível`)
        return client.callTool(tool, args, undefined, signal, options)
      },
      readResource: async (server, uri) => {
        const client = this.mcpClients.get(server)
        if (!client) throw new Error(`servidor MCP "${server}" não está disponível`)
        return client.readResource(uri)
      },
      getPrompt: async (server, name, args = {}) => {
        const client = this.mcpClients.get(server)
        if (!client) throw new Error(`servidor MCP "${server}" não está disponível`)
        return client.getPrompt(name, args)
      }
    }
  }

  async testProvider(providerId: string, draft?: Partial<Pick<ProviderConfig, 'baseUrl' | 'kind' | 'model'>>): Promise<{ ok: boolean; detail: string }> {
    const saved = this.settings.providerConfig(providerId)
    if (!saved) return { ok: false, detail: 'provedor não encontrado' }
    // The form may hold an address or a model that is not saved yet: test what the user is looking at.
    const config = { ...saved, ...draft }
    if (!hasCredentials(config, this.settings.resolver())) {
      return { ok: false, detail: 'sem credencial configurada' }
    }
    const provider = createProvider(config, this.settings.resolver())
    let text = ''
    let error: string | undefined
    let kind: ProviderErrorKind | undefined
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
        if (event.type === 'end' && event.stopReason === 'error') {
          error = event.error
          kind = event.errorKind
        }
      }
      clearTimeout(timer)
    } catch (err) {
      error = (err as Error).message
      kind = errorKindOf(err)
    }
    if (error) {
      // What the test found is what the sessions would find: remember it, so Settings shows it and the reserve skips it.
      if (kind && isAccountLevelKind(kind)) this.reserve.health.mark(config, kind)
      return { ok: false, detail: error }
    }
    const answer = text.trim()
    if (!answer) return { ok: false, detail: 'o provedor respondeu sem texto; aumente o limite ou verifique o modelo' }
    this.reserve.health.clear(providerId)
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
      settings.providers.find((provider) => hasCredentials(provider, this.settings.resolver()))
    if (!config || !hasCredentials(config, this.settings.resolver())) return raw

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

  /* ------------------------- improvement review -------------------------- */

  /** Default provider with a credential; real models only, since a mock would write a fake analysis. */
  private analysisProviderConfig(): ProviderConfig | undefined {
    const settings = this.settings.get()
    const config =
      this.settings.providerConfig(settings.defaultProviderId) ??
      settings.providers.find((provider) => hasCredentials(provider, this.settings.resolver()))
    if (!config || !hasCredentials(config, this.settings.resolver())) return undefined
    return config
  }

  /** What an AI analysis would use (the evidence leaves the machine for this provider). */
  improvementProvider(): { id: string; label: string; model: string } | undefined {
    const config = this.analysisProviderConfig()
    return config ? { id: config.id, label: config.label, model: config.model } : undefined
  }

  /**
   * One tool-less call: the analyst can neither read nor change anything, it
   * only turns the evidence it is given into text.
   */
  async improvementAnalyze(system: string, prompt: string, signal: AbortSignal): Promise<string> {
    const config = this.analysisProviderConfig()
    if (!config) throw new Error('nenhum provedor com credencial configurada')
    const provider = createProvider(config, this.settings.resolver())
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 120_000)
    let out = ''
    let error: string | undefined
    try {
      for await (const event of provider.stream({
        system,
        messages: [{ id: id('msg'), role: 'user', ts: Date.now(), parts: [{ type: 'text', text: prompt }] }],
        tools: [],
        maxTokens: 3_000,
        temperature: 0.2,
        signal: controller.signal
      })) {
        if (event.type === 'text_delta') out += event.text
        if (event.type === 'end' && event.stopReason === 'error') error = event.error
      }
    } catch (err) {
      if (timedOut) throw new Error('o modelo não respondeu em 120 s')
      throw err
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    if (timedOut) throw new Error('o modelo não respondeu em 120 s')
    if (error) throw new Error(error)
    return out
  }

  /** System prompt of the `improvement-analyst` agent; a user file with that name overrides the built-in. */
  improvementAnalystPrompt(fallback: string): string {
    return this.agentRegistryFor().get('improvement-analyst')?.systemPrompt || fallback
  }

  /** Everything the review reads about one project, in the shape `collectEvidence` expects. */
  async improvementSessions(projectId: string): Promise<Array<{ id: string; title: string; updatedAt: number; providerId: string; model: string }>> {
    this.requireProject(projectId)
    return (await this.store.listSessions())
      .filter((summary) => summary.meta.projectId === projectId)
      .map((summary) => ({ id: summary.meta.id, title: summary.meta.title, updatedAt: summary.meta.updatedAt, providerId: summary.meta.providerId, model: summary.meta.model }))
  }

  /** Writes the report as a wiki page (source of truth) and mirrors it into AI-Memory like `memory_page` does. */
  async improvementSavePage(
    projectId: string,
    review: { slug: string; title: string; body: string; tags: string[]; summary: string },
    usedAi: boolean
  ): Promise<void> {
    this.requireProject(projectId)
    const memory = this.memoryForProject(projectId)
    await memory.init()
    const page = await memory.writePage({
      slug: review.slug,
      title: review.title,
      body: review.body,
      tags: review.tags,
      source: 'improvement-review',
      memoryType: 'fact',
      confidence: usedAi ? 'inferred' : 'observed',
      context: 'Revisão de melhorias: sugestões a partir dos logs do projeto. Nada foi aplicado.'
    })
    if (!this.aiMemory.available) return
    const related = await this.aiMemory
      .relatedMarkdown(projectId, `${page.title}\n${review.body}`, `pages/${page.slug}.md`, 4)
      .catch(() => '')
    await this.aiMemory
      .writePage(projectId, {
        path: `pages/${page.slug}.md`,
        title: page.title,
        body: `${review.body}${related ? `\n\n## Relacionados\n\n${related}` : ''}`,
        tags: page.tags,
        pinned: page.pinned,
        tier: 'semantic'
      })
      .catch(() => undefined)
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
    const shot = await this.computer.captureScreen(1400, { monitor: 0 })
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

  /** Changes the default model of one project; other projects are untouched. */
  async setProjectModel(projectId: string, providerId: string, model: string): Promise<Project> {
    this.requireProject(projectId)
    if (!this.settings.providerConfig(providerId)) throw new Error('provedor não encontrado')
    const updated = await this.store.setProjectModel(projectId, providerId, model)
    if (!updated) throw new Error('projeto não encontrado')
    return updated
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
  /** Fire and forget: failures are logged, nothing waits for it. */
  private syncNativeToAiInBackground(projectId: string): void {
    void this.syncNativeToAi(projectId).catch((err) =>
      this.options.log?.(`sincronização da memória nativa com AI-Memory falhou: ${(err as Error).message}`)
    )
  }

  private async syncNativeToAi(projectId: string): Promise<void> {
    if (this.syncedMemories.has(projectId) || !this.aiMemory.available) return
    const running = this.memorySyncs.get(projectId)
    if (running) return running
    const task = this.doSyncNativeToAi(projectId)
      .then((outcome) => {
        // Only a pass that reached the end counts as synced. A pass that stopped at its time budget goes on by itself a
        // moment later (it used to wait for the next start of the app: ~15 pages per launch, never the whole wiki); one
        // that failed tries again in 30 s. One retry waits per project, however many screens ask meanwhile.
        if (outcome === 'complete') {
          this.syncedMemories.add(projectId)
          // A pass where nothing changed is cheap: two minutes later the next call checks again for pages written since.
          setTimeout(() => this.syncedMemories.delete(projectId), 120_000).unref?.()
          return
        }
        this.syncedMemories.add(projectId)
        setTimeout(() => {
          this.syncedMemories.delete(projectId)
          this.syncNativeToAiInBackground(projectId)
        }, outcome === 'paused' ? 3_000 : 30_000).unref?.()
      })
      .finally(() => {
        this.memorySyncs.delete(projectId)
      })
    this.memorySyncs.set(projectId, task)
    return task
  }

  /** Whether the whole wiki is in the index, the pass stopped at its time budget, or it failed. */
  private async doSyncNativeToAi(projectId: string): Promise<'complete' | 'paused' | 'failed'> {
    const startedAt = Date.now()
    // Pages already copied (by content fingerprint) are skipped, so only the first sync is long.
    const cacheFile = path.join(userDataPath(this.options.userData, 'data'), 'memory', 'projects', projectId, 'ai-sync.json')
    let copied: Record<string, string> = {}
    try {
      copied = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8')) as Record<string, string>
    } catch {
      /* first run */
    }
    const saveCache = async (): Promise<void> => {
      await fs.promises.writeFile(cacheFile, JSON.stringify(copied), 'utf8').catch(() => undefined)
    }
    const state = { done: 0, total: 0, running: true }
    this.memorySyncState.set(projectId, state)
    try {
      const native = await this.memoryForProject(projectId).listPages()
      state.total = native.length
      if (!native.length) return 'complete'
      const indexed = await this.aiMemory.recent(projectId, 100)
      // If AI-Memory lost its index (fresh data folder) the cache would hide that: start over.
      if (!indexed.length) copied = {}
      // The old monolithic `s/<hash>.md` transcripts are replaced by per-turn
      // pages. Delete them so recall does not keep loading a giant file.
      for (const hit of indexed) {
        if (hit.path.startsWith('s/')) {
          await this.aiMemory.deletePage(projectId, hit.path).catch(() => false)
        }
      }
      let done = 0
      let paused = false
      const live = new Set(native.map((summary) => `pages/${summary.slug}.md`))
      state.done = Object.keys(copied).filter((key) => live.has(key)).length
      const copyOne = async (summary: (typeof native)[number]): Promise<void> => {
        // A long first sync is spread over several passes instead of hammering the sidecar for minutes.
        if (paused || Date.now() - startedAt > 60_000) {
          paused = true
          return
        }
        const path = `pages/${summary.slug}.md`
        const page = await this.memoryForProject(projectId).readPage(summary.slug)
        if (!page) return
        // Legacy session transcript pages are replaced by the atomic turn
        // notes; any remaining one is not a useful graph node.
        if (summary.tags.includes('sessao') && summary.tags.includes('automatico')) {
          await this.aiMemory.deletePage(projectId, path).catch(() => false)
          return
        }
        const fingerprint = crypto.createHash('sha1').update(JSON.stringify([page.title, page.body, page.tags, page.pinned, summary.tags])).digest('hex')
        if (copied[path] === fingerprint) return
        // Not in the cache: the index may have it already (the import writes each page there, an earlier cache was lost).
        // A read costs milliseconds, a write seconds (the sidecar commits its whole wiki to git on every write): the same
        // text is recorded as copied instead of written again.
        if (copied[path] === undefined) {
          const indexed = await this.aiMemory.readPage(projectId, path).catch(() => null)
          if (indexed && sameIndexedText(indexed.body, page.body)) {
            copied[path] = fingerprint
            done++
            state.done++
            if (done % 25 === 0) await saveCache()
            return
          }
        }
        // Neighbours from the wiki's own index (in process, instant): asking the sidecar for them cost a full-text search
        // of seconds per page, which is what kept a 2000-page project from ever reaching the index.
        const related = page.body.includes('## Relacionados')
          ? []
          : relatedDurable(native, { slug: summary.slug, title: page.title, tags: page.tags, hint: page.body.slice(0, 300) }, { limit: 4 })
        const written = await this.aiMemory
          .writePage(projectId, {
            path,
            title: page.title,
            body: related.length
              ? `${page.body}\n\n## Relacionados\n\n${related.map((item) => `- [[pages/${item.slug}.md]] — ${item.title}`).join('\n')}`
              : page.body,
            tags: page.tags,
            pinned: page.pinned,
            tier: summary.tags.includes('turno') ? 'episodic' : 'semantic'
          })
          .then(() => true, () => false)
        if (written) {
          const fresh = copied[path] === undefined
          copied[path] = fingerprint
          done++
          if (fresh) state.done++
          if (done % 25 === 0) await saveCache()
        }
      }
      // Three writes at a time: the sidecar serializes its own commits, so more only queues.
      let next = 0
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (next < native.length && !paused) await copyOne(native[next++])
        })
      )
      if (paused) this.options.log?.(`sincronização com AI-Memory: ${state.done} de ${state.total} páginas no índice; continua em seguida`)
      // A page that left the wiki (archived hub, deleted page) must not stay searchable in the index.
      for (const mirrored of Object.keys(copied)) {
        if (live.has(mirrored)) continue
        await this.aiMemory.deletePage(projectId, mirrored).catch(() => false)
        delete copied[mirrored]
      }
      await saveCache()
      return paused ? 'paused' : 'complete'
    } catch (err) {
      this.options.log?.(`sincronização da memória nativa com AI-Memory falhou: ${(err as Error).message}`)
      return 'failed'
    } finally {
      state.running = false
    }
  }

  async memoryStats(
    projectId: string
  ): Promise<
    Awaited<ReturnType<ProjectMemory['stats']>> & {
      indexed?: number
      aiRunning?: boolean
      indexSync?: { done: number; total: number; running: boolean }
      files?: Record<string, number>
      fileIndex?: Record<string, MemoryFileIndexEntry>
    }
  > {
    this.requireProject(projectId)
    this.syncNativeToAiInBackground(projectId)
    const stats = await this.memoryForProject(projectId).stats()
    // The real number of pages the index holds for the project (it used to be the length of a "recent" list capped at 100).
    // Only from a sidecar that is already up: the screen must not wait for it to start (that takes half a minute on a
    // big index), the background sync starts it.
    const indexed = this.aiMemory.status().running ? await this.aiMemory.pageCount(projectId).catch(() => undefined) : undefined
    const sync = this.memorySyncState.get(projectId)
    const fileIndex = await memoryFileIndex(this.memoryForProject(projectId).root)
    return {
      ...stats,
      ...(indexed !== undefined ? { indexed } : {}),
      aiRunning: this.aiMemory.status().running,
      ...(sync ? { indexSync: { ...sync } } : {}),
      files: Object.fromEntries(Object.entries(fileIndex).map(([kind, entry]) => [kind, entry.total])),
      fileIndex
    }
  }

  /* ------------------------------ files in the memory ------------------------------ */

  /** Files kept in the project memory (pictures, PDFs, documents...), newest first. */
  memoryFiles(projectId: string): MemoryFileInfo[] {
    this.requireProject(projectId)
    return listMemoryFiles(this.memoryForProject(projectId).root).map((meta) => ({
      slug: meta.slug,
      kind: meta.kind,
      name: meta.name,
      bytes: meta.bytes,
      added: meta.added,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.describedBy ? { describedBy: meta.describedBy } : {}),
      ...(meta.width && meta.height ? { width: meta.width, height: meta.height } : {}),
      ...(meta.pages ? { pages: meta.pages } : {}),
      textChars: meta.textChars,
      tags: meta.tags,
      links: meta.links,
      thumb: Boolean(meta.thumb)
    }))
  }

  /** The thumbnail of a file in the memory, as a data URL (null when it has none). */
  memoryFileThumb(projectId: string, slug: string): string | null {
    this.requireProject(projectId)
    const thumb = memoryFileThumb(this.memoryForProject(projectId).root, slug)
    return thumb ? `data:${thumb.mediaType};base64,${thumb.data}` : null
  }

  /** The copy kept in the memory (or the original, for a file too big to copy). */
  memoryFilePath(projectId: string, slug: string): string {
    this.requireProject(projectId)
    const found = findMemoryFile(this.memoryForProject(projectId).root, slug)
    if (!found) throw new Error('arquivo não encontrado na memória')
    return found.meta.stored ? path.join(found.dir, found.meta.stored) : found.meta.source
  }

  private memoryJobs = new Map<string, MemoryAddJobInfo>()

  memoryAddStatus(projectId: string): MemoryAddJobInfo | null {
    const job = this.memoryJobs.get(projectId)
    return job ? { ...job, failed: [...job.failed] } : null
  }

  /**
   * Memória → Adicionar arquivos/pasta: saves the chosen files (a folder with its subfolders) into the project memory in
   * the background. Pictures are described by the first model that reads images; the screen polls memoryAddStatus.
   */
  memoryAddFiles(projectId: string, paths: string[]): MemoryAddJobInfo {
    this.requireProject(projectId)
    if (this.memoryJobs.get(projectId)?.active) throw new Error('Já há arquivos sendo guardados nesta memória.')
    const job: MemoryAddJobInfo = { active: true, done: 0, total: 0, current: 'procurando os arquivos…', added: 0, cached: 0, described: 0, failed: [] }
    this.memoryJobs.set(projectId, job)
    const memory = this.memoryForProject(projectId)
    void (async () => {
      try {
        const files: string[] = []
        for (const given of paths) {
          const stat = await fs.promises.stat(given).catch(() => null)
          if (!stat) job.failed.push(`${given}: não encontrado`)
          else if (stat.isDirectory()) files.push(...(await collectMemoryFiles(given, { recursive: true, limit: 5_000 - files.length })))
          else files.push(given)
          if (files.length >= 5_000) break
        }
        job.total = files.length
        for (const file of files) {
          job.current = path.basename(file)
          try {
            const result = await addMemoryFile(file, {
              memory,
              describe: (image, question) => describeImage({ candidates: this.reserve.visionCandidates(), image, question }),
              onProgress: (text) => (job.current = text)
            })
            if (result.cached) job.cached++
            else job.added++
            if (result.meta.description) job.described++
          } catch (err) {
            job.failed.push(`${path.basename(file)}: ${(err as Error).message}`)
          }
          job.done++
        }
      } finally {
        job.active = false
        job.current = ''
        this.options.log?.(`memória: ${job.added} arquivo(s) guardado(s), ${job.cached} já estava(m), ${job.failed.length} falha(s)`)
        // The new pages go into the long-term index now, not two minutes from now.
        this.syncedMemories.delete(projectId)
        this.syncNativeToAiInBackground(projectId)
      }
    })()
    return { ...job }
  }

  /**
   * Native wiki pages plus AI-Memory pages that are not a session transcript
   * and have no native twin. Session transcripts stay out of the page grid (a
   * long project would drown it); they are still searchable by the agent and
   * available through `memory_recall`.
   */
  async memoryList(projectId: string): Promise<Awaited<ReturnType<ProjectMemory['listPages']>>> {
    this.requireProject(projectId)
    this.syncNativeToAiInBackground(projectId)
    const native = await this.memoryForProject(projectId).listPages()
    // Pages only the index has, when it is already up: the list never waits for the sidecar to start.
    const indexed = this.aiMemory.status().running ? await this.aiMemory.recent(projectId, 100).catch(() => []) : []
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
    const memory = this.memoryForProject(projectId)
    await memory.init()
    return memory.readPage(slug)
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

  async memoryInvalidate(projectId: string, slug: string, reason = '') {
    this.requireProject(projectId)
    if (slug.startsWith(AI_PAGE_PREFIX)) throw new Error('páginas importadas do AI-Memory não possuem metadados editáveis; use Excluir')
    return this.memoryForProject(projectId).invalidatePage(slug, reason)
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
  async memoryGraph(projectId: string, query = ''): Promise<import('./ai-memory.js').AiMemoryGraph> {
    this.requireProject(projectId)
    this.syncNativeToAiInBackground(projectId)
    // The wiki's in-memory index has what the graph needs (title, tags, words, links): no page is read from disk. Reading
    // and comparing every page of a 4600-page memory froze the main process for over a minute.
    const summaries = await this.memoryForProject(projectId).listPages()
    // The sidecar's own graph is fetched in the background and used once it arrives: the screen never waits for it.
    this.refreshSidecarGraph(projectId)
    const sidecar = this.sidecarGraphs.get(projectId)
    let newest = ''
    let slugChars = 0
    for (const summary of summaries) {
      if (summary.updated > newest) newest = summary.updated
      slugChars += summary.slug.length
    }
    const key = `${summaries.length}:${slugChars}:${newest}:${sidecar?.at ?? 0}`
    let cached = this.memoryGraphs.get(projectId)
    if (cached?.key !== key) {
      const native = new Set(summaries.map((summary) => summary.slug))
      const titles = new Set(summaries.map((summary) => summary.title.trim().toLowerCase()))
      // A sidecar path is the native page it mirrors (`pages/<slug>.md`) or a page only the index has (opened as `ai:`).
      const idOf = (pagePath: string): string => {
        const slug = /^pages\/(.+)\.md$/i.exec(pagePath)?.[1]
        return slug && native.has(slug) ? slug : native.has(pagePath) ? pagePath : `${AI_PAGE_PREFIX}${pagePath}`
      }
      const sources = summaries.map(graphSourceOf)
      for (const node of sidecar?.graph?.nodes ?? []) {
        const id = idOf(node.path)
        if (native.has(id) || titles.has(node.title.trim().toLowerCase())) continue
        sources.push({
          slug: id,
          title: node.title,
          tags: node.tags,
          updated: node.updated,
          terms: graphKeywords(`${node.title} ${node.tags.join(' ')}`, 24),
          kind: node.kind
        })
        native.add(id)
      }
      const extraEdges = (sidecar?.graph?.edges ?? []).map((edge) => ({ ...edge, source: idOf(edge.source), target: idOf(edge.target) }))
      // Built in slices of a few ms (the main process keeps answering) and kept until the memory changes: a search only
      // picks nodes from it.
      cached = { key, prepared: await prepareMemoryGraphAsync(sources, extraEdges) }
      this.memoryGraphs.set(projectId, cached)
    }
    const graph = selectMemoryGraph(cached.prepared, { limit: MEMORY_GRAPH_LIMIT, query })
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      total: graph.total,
      truncated: graph.nodes.length < graph.total,
      source: sidecar?.graph?.nodes.length ? 'ai-memory' : 'native'
    }
  }

  /** The sidecar's graph of the project, fetched at most every two minutes and only from a sidecar already up. */
  private refreshSidecarGraph(projectId: string): void {
    const current = this.sidecarGraphs.get(projectId)
    if (!this.aiMemory.status().running || current?.loading || (current && Date.now() - current.at < 120_000)) return
    this.sidecarGraphs.set(projectId, { at: current?.at ?? 0, graph: current?.graph ?? null, loading: true })
    void this.aiMemory
      .graph(projectId)
      .catch(() => null)
      .then((graph) => this.sidecarGraphs.set(projectId, { at: Date.now(), graph: graph ?? current?.graph ?? null }))
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
    this.memoryGraphs.delete(projectId)
    this.sidecarGraphs.delete(projectId)
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
    await memory.init()
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
/** Nodes the graph shows at once; the others are reached by searching (the most connected and recent come first). */
const MEMORY_GRAPH_LIMIT = 900

function aiPageId(pagePath: string): string {
  return `${AI_PAGE_PREFIX}${pagePath}`
}

/** The index holds the page's text (plus, maybe, the "Relacionados" links the sync appends): the same text, already there. */
function sameIndexedText(indexed: string, native: string): boolean {
  const flat = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const mine = flat(native)
  return Boolean(mine) && flat(indexed).startsWith(mine.slice(0, 4_000))
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

function userDataPath(base: string, child: string): string {
  return path.join(base, child)
}

function buildBaseRegistry(mcpPolicy?: (server: string, tool: string) => ResolvedToolPolicy | undefined): ToolRegistry {
  return new ToolRegistry()
    .register(...fsTools)
    .register(applyPatchTool)
    .register(...searchTools)
    .register(...shellTools)
    .register(...terminalTools)
    .register(...gitTools)
    .register(...webTools)
    .register(...browserTools)
    .register(...computerTools)
    .register(...createMcpTools(mcpPolicy))
    .register(...lazyTools)
    .register(...planTools)
    .register(...limitationTools)
    .register(...askTools)
    .register(...projectMemoryTools)
    .register(...memoryFileTools)
    .register(...agentForgeTools)
    .register(...externalAgentTools)
    .register(...codeIntelligenceTools)
    .register(...documentTools)
    .register(...mediaTools)
    .register(...imageTools)
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
