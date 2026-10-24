/**
 * IPC contract between renderer, preload and main process.
 * No Electron or Node imports allowed here.
 */

import type {
  AgentMode,
  AgentsListing,
  AppSettings,
  CapabilityReport,
  FileChange,
  HarnessEvent,
  ImagePart,
  McpServerSettings,
  Project,
  ProviderConfig,
  ReasoningEffort,
  SessionMeta,
  SessionState,
  SessionSummary,
  SessionSurface,
  SkillInfo
} from './types.js'

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface CreateSessionInput {
  projectId: string
  cwd: string
  mode: AgentMode
  surface?: SessionSurface
  providerId: string
  model: string
  title?: string
}

export interface FileNode {
  path: string
  dir: boolean
  size: number
}

export interface ProviderPresetInfo {
  key: string
  kind: ProviderConfig['kind']
  label: string
  baseUrl: string
  model: string
  contextWindow: number
  supportsVision: boolean
  apiKeyEnv?: string
  local?: boolean
  docs?: string
  models?: string[]
}

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
  platform: string
}

export interface ScreenshotResult {
  image: string
  width: number
  height: number
}

export type TerminalShell = 'powershell' | 'cmd' | 'bash'

export interface TerminalInfo {
  id: string
  title: string
  shell: TerminalShell
  cwd: string
  pid: number
  sessionId?: string
  createdAt: number
  exited: boolean
  exitCode?: number
}

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }

export interface FileSearchHit {
  path: string
  line: number
  text: string
}

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechange'

export interface GitFileEntry {
  path: string
  oldPath?: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface GitStatusInfo {
  isRepo: boolean
  root?: string
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileEntry[]
}

export interface GitDiffResult {
  diff: string
  truncated: boolean
}

export interface DevServerCandidate {
  name: string
  command: string
  port?: number
  url?: string
  source: 'package.json' | 'launch.json'
}

export interface DevServerDetection {
  candidates: DevServerCandidate[]
  saved?: string
  launchFile: string
}

export interface DevServerStart {
  url: string | null
  terminalId: string
}

export interface BackgroundTaskInfo {
  sessionId: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  exitCode: number | null
}

export interface ModelDiscovery {
  models: Array<{ id: string; contextWindow?: number; supportsVision?: boolean; supportsTools?: boolean }>
  source: 'ollama' | 'lmstudio' | 'openai' | 'anthropic'
  error?: string
}

export interface McpPresetEntry {
  id: string
  label: string
  description: string
  /** Entry to append to settings.mcpServers; null when it cannot be built on this machine. */
  server: McpServerSettings | null
  unavailableReason?: string
}

/** Catalog card shown under Personalização → Conectores → Descobrir. */
export interface McpCatalogInfo {
  id: string
  name: string
  description: string
  category: string
  transport: 'stdio' | 'http' | 'sse'
  needs: string[]
  oauth: boolean
  docs?: string
  installed: boolean
}

/** One entry from the bundled Claude plugins marketplace snapshot. */
export interface PluginCatalogEntry {
  name: string
  category: string | null
  description: string
  homepage: string | null
}

/** Result of importing the user's Claude Desktop/Code catalog. */
export interface ClaudeImportInfo {
  skills: number
  agents: number
  mcp: number
  imported: number
  mcpNames: string[]
  plugins: number
  sources: string[]
  warnings: string[]
}

export type ScheduleSpec =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'once'; at: string }

export interface ScheduledTaskInfo {
  id: string
  name: string
  prompt: string
  projectId: string
  cwd: string
  mode?: AgentMode
  providerId?: string
  model?: string
  schedule: ScheduleSpec
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastStatus?: 'ok' | 'error' | 'missed' | 'running'
  lastError?: string
  lastSessionId?: string
  nextRunAt?: number
}

export interface ScheduledTaskInput {
  name: string
  prompt: string
  projectId: string
  mode?: AgentMode
  providerId?: string
  model?: string
  schedule: ScheduleSpec
  enabled?: boolean
}

export interface SttModelInfo {
  id: string
  sizeMB: number
}

export interface SttStatusInfo {
  /** The embedded Python runtime, the sidecar script and at least one model are present. */
  available: boolean
  /** Why it is not available, in pt-BR. */
  reason?: string
  models: SttModelInfo[]
  device?: string
  /** True while the recognition process is running. */
  running: boolean
}

export interface SttReady {
  model: string
  device: string
  computeType?: string
  loadMs: number
}

/** Live results of the speech recognizer. `partial` replaces the previous partial of the same utterance. */
export type SttEvent =
  | { type: 'partial'; utterance: number; text: string }
  | { type: 'final'; utterance: number; text: string; language?: string }
  | { type: 'level'; rms: number }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'exit' }

export interface SttStartOptions {
  model?: string
  /** ISO code ("pt", "en"…) or "auto". */
  language?: string
}

/** State of the global dictation flow (shortcut -> microphone -> insertion). */
export interface DictationState {
  phase: 'idle' | 'loading' | 'listening' | 'processing' | 'error'
  /** 0..1, for the pill meter. */
  level?: number
  /** Best partial text so far. */
  text?: string
  error?: string
}

/* Per-project long-term memory (markdown wiki + handoffs, no LLM required). */

export interface MemoryPageInfo {
  slug: string
  title: string
  tags: string[]
  pinned: boolean
  updated: string
  summary: string
  /** `wiki` (native markdown) or `ai-memory` (indexed page). */
  source?: 'wiki' | 'ai-memory'
  /** AI-Memory page path when `source` is `ai-memory`. */
  path?: string
}

export interface MemoryStatsInfo {
  root: string
  pages: number
  pinned: number
  openHandoffs: number
  updatedAt?: string
  /** Pages currently returned by the AI-Memory index (native + transcripts). */
  indexed?: number
  /** Whether the AI-Memory sidecar answered. */
  aiRunning?: boolean
}

export interface MemoryPageContent {
  slug: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  created: string
  updated: string
  source: string
}

export interface CreateTerminalInput {
  cwd: string
  cols: number
  rows: number
  shell?: TerminalShell
  sessionId?: string
}

export const CH = {
  appCapabilities: 'app:capabilities',
  appPresets: 'app:presets',
  appSettings: 'app:settings',
  appUpdateSettings: 'app:updateSettings',
  appSetSecret: 'app:setSecret',
  appClearSecret: 'app:clearSecret',
  appTestProvider: 'app:testProvider',
  appVersions: 'app:versions',
  appSkills: 'app:skills',
  appNotify: 'app:notify',
  appCreateSkill: 'app:createSkill',
  appDiscoverModels: 'app:discoverModels',
  appRememberModel: 'app:rememberModel',
  appMcpPresets: 'app:mcpPresets',
  appMcpCatalog: 'app:mcpCatalog',
  appMcpInstall: 'app:mcpInstall',
  appImportClaude: 'app:importClaude',
  appPluginCatalog: 'app:pluginCatalog',
  appAgents: 'app:agents',
  appOpenSkills: 'app:openSkills',

  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsRemove: 'projects:remove',
  projectsDelete: 'projects:delete',
  projectsPick: 'projects:pick',
  projectsEnsureDefault: 'projects:ensureDefault',

  sessionsList: 'sessions:list',
  sessionsCreate: 'sessions:create',
  sessionsGet: 'sessions:get',
  sessionsDelete: 'sessions:delete',
  sessionsRename: 'sessions:rename',
  sessionsSend: 'sessions:send',
  sessionsAbort: 'sessions:abort',
  sessionsSetMode: 'sessions:setMode',
  sessionsSetModel: 'sessions:setModel',
  sessionsSetEffort: 'sessions:setEffort',
  sessionsExport: 'sessions:export',
  sessionsImport: 'sessions:import',
  sessionsArchive: 'sessions:archive',
  sessionsCompact: 'sessions:compact',
  inboxList: 'inbox:list',
  inboxAdd: 'inbox:add',
  inboxRemove: 'inbox:remove',
  inboxClear: 'inbox:clear',

  filesTree: 'files:tree',
  filesRead: 'files:read',
  filesChanges: 'files:changes',
  filesScreenshot: 'files:screenshot',
  filesReveal: 'files:reveal',
  filesWrite: 'files:write',
  filesSearch: 'files:search',

  gitStatus: 'git:status',
  gitDiff: 'git:diff',

  previewDetect: 'preview:detect',
  previewStart: 'preview:start',

  tasksList: 'tasks:list',
  tasksOutput: 'tasks:output',
  tasksStop: 'tasks:stop',

  powerKeepAwake: 'power:keepAwake',
  sttStatus: 'stt:status',
  sttStart: 'stt:start',
  sttStop: 'stt:stop',
  sttAudio: 'stt:audio',
  sttEvent: 'forja:stt',
  dictationToggle: 'forja:dictation:toggle',
  dictationState: 'dictation:state',
  dictationInsert: 'dictation:insert',
  dictationComposer: 'forja:dictation:composer',
  memoryStatus: 'memory:status',
  memoryList: 'memory:list',
  memoryRead: 'memory:read',
  memoryDelete: 'memory:delete',
  memoryOpen: 'memory:open',
  memoryExport: 'memory:export',
  memoryImport: 'memory:import',
  memoryRecall: 'memory:recall',
  memoryAiStatus: 'memory:aiStatus',
  powerState: 'power:state',

  schedulesList: 'schedules:list',
  schedulesCreate: 'schedules:create',
  schedulesUpdate: 'schedules:update',
  schedulesRemove: 'schedules:remove',
  schedulesRunNow: 'schedules:runNow',

  approvalsResolve: 'approvals:resolve',
  mcpRestart: 'mcp:restart',

  terminalShells: 'terminal:shells',
  terminalList: 'terminal:list',
  terminalCreate: 'terminal:create',
  terminalSnapshot: 'terminal:snapshot',
  terminalKill: 'terminal:kill',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalEvent: 'forja:terminal',

  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',

  event: 'forja:event'
} as const

export interface OpenclodApi {
  app: {
    capabilities(): Promise<IpcResult<CapabilityReport>>
    presets(): Promise<IpcResult<ProviderPresetInfo[]>>
    settings(): Promise<IpcResult<AppSettings>>
    updateSettings(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
    setSecret(providerId: string, value: string): Promise<IpcResult<boolean>>
    clearSecret(providerId: string): Promise<IpcResult<boolean>>
    testProvider(providerId: string): Promise<IpcResult<{ ok: boolean; detail: string }>>
    versions(): Promise<IpcResult<AppVersions>>
    skills(): Promise<IpcResult<SkillInfo[]>>
    notify(title: string, body: string): Promise<IpcResult<boolean>>
    createSkill(name: string, description: string, body: string): Promise<IpcResult<SkillInfo>>
    discoverModels(providerId: string): Promise<IpcResult<ModelDiscovery>>
    /** Remembers the last picked provider/model for new sessions and restarts. */
    rememberModel(providerId: string, model: string): Promise<IpcResult<boolean>>
    mcpPresets(): Promise<IpcResult<McpPresetEntry[]>>
    mcpCatalog(): Promise<IpcResult<McpCatalogInfo[]>>
    /** Installs a catalog/registry MCP and hot-reloads the tools. */
    installMcp(
      id: string,
      env?: Record<string, string>,
      headers?: Record<string, string>
    ): Promise<IpcResult<{ ok: boolean; name?: string; state?: string; tools?: string[]; missing?: string[]; needsOAuth?: boolean; error?: string }>>
    /** Copies skills, agents and MCP servers from Claude Desktop/Code. */
    importClaude(): Promise<IpcResult<ClaudeImportInfo>>
    /** The 315-plugin marketplace snapshot bundled with the app. */
    pluginCatalog(): Promise<IpcResult<PluginCatalogEntry[]>>
    /** Built-in + imported agents available to a project. */
    agents(cwd?: string): Promise<IpcResult<AgentsListing>>
    openSkillsFolder(): Promise<IpcResult<boolean>>
  }
  projects: {
    list(): Promise<IpcResult<Project[]>>
    add(folder: string, name?: string): Promise<IpcResult<Project>>
    remove(projectId: string): Promise<IpcResult<boolean>>
    /** Deletes sessions, native wiki and the AI-Memory index (not the folder). */
    delete(projectId: string): Promise<IpcResult<boolean>>
    pick(): Promise<IpcResult<string | null>>
    /** Returns the default workspace project used by Home when no project is open. */
    ensureDefault(): Promise<IpcResult<Project>>
  }
  sessions: {
    list(): Promise<IpcResult<SessionSummary[]>>
    create(input: CreateSessionInput): Promise<IpcResult<SessionMeta>>
    get(sessionId: string): Promise<IpcResult<SessionState>>
    delete(sessionId: string): Promise<IpcResult<boolean>>
    rename(sessionId: string, title: string): Promise<IpcResult<SessionState>>
    send(sessionId: string, text: string, images?: ImagePart[], mode?: 'steer' | 'queue' | 'auto'): Promise<IpcResult<boolean>>
    abort(sessionId: string): Promise<IpcResult<boolean>>
    setMode(sessionId: string, mode: AgentMode): Promise<IpcResult<boolean>>
    setModel(sessionId: string, providerId: string, model: string): Promise<IpcResult<boolean>>
    /** null restores the model's own default depth. */
    setEffort(sessionId: string, effort: ReasoningEffort | null): Promise<IpcResult<boolean>>
    export(sessionId: string): Promise<IpcResult<string>>
    import(json: string): Promise<IpcResult<SessionMeta>>
    archive(sessionId: string, archived: boolean): Promise<IpcResult<SessionMeta>>
    compact(sessionId: string): Promise<IpcResult<SessionState>>
  }
  files: {
    tree(root: string, depth?: number): Promise<IpcResult<FileNode[]>>
    read(root: string, relative: string): Promise<IpcResult<{ content: string; truncated: boolean }>>
    changes(sessionId: string): Promise<IpcResult<FileChange[]>>
    screenshot(): Promise<IpcResult<ScreenshotResult>>
    reveal(target: string): Promise<IpcResult<boolean>>
    write(root: string, relative: string, content: string): Promise<IpcResult<{ size: number }>>
    search(root: string, query: string): Promise<IpcResult<FileSearchHit[]>>
  }
  git: {
    status(root: string): Promise<IpcResult<GitStatusInfo>>
    diff(root: string, path: string, staged: boolean): Promise<IpcResult<GitDiffResult>>
  }
  preview: {
    detect(root: string): Promise<IpcResult<DevServerDetection>>
    start(root: string, name: string, sessionId: string): Promise<IpcResult<DevServerStart>>
  }
  tasks: {
    list(sessionId?: string): Promise<IpcResult<BackgroundTaskInfo[]>>
    output(sessionId: string, pid: number): Promise<IpcResult<string>>
    stop(sessionId: string, pid: number): Promise<IpcResult<boolean>>
  }
  stt: {
    status(): Promise<IpcResult<SttStatusInfo>>
    /** Loads the model and starts listening for audio (resolves when ready). */
    start(options?: SttStartOptions): Promise<IpcResult<SttReady>>
    /** Flushes what is left, then stops the recognizer. */
    stop(): Promise<IpcResult<boolean>>
    /** 16 kHz mono little-endian int16 samples. Fire and forget. */
    audio(pcm: ArrayBuffer): void
    onEvent(callback: (event: SttEvent) => void): () => void
  }
  dictation: {
    /** The global shortcut was pressed. */
    onToggle(callback: () => void): () => void
    /** Main asks the composer to insert the final text at the caret. */
    onComposerInsert(callback: (text: string) => void): () => void
    /** Renderer -> main: update the floating pill. */
    state(state: DictationState): void
    /** Renderer -> main: insert the final text into the focused target. */
    insert(text: string): Promise<IpcResult<boolean>>
  }
  memory: {
    status(projectId: string): Promise<IpcResult<MemoryStatsInfo>>
    list(projectId: string): Promise<IpcResult<MemoryPageInfo[]>>
    read(projectId: string, slug: string): Promise<IpcResult<MemoryPageContent | null>>
    delete(projectId: string, slug: string): Promise<IpcResult<boolean>>
    /** Opens the project's memory folder in Explorer. */
    open(projectId: string): Promise<IpcResult<boolean>>
    /** Bounded recall from the project's AI-Memory index. */
    recall(projectId: string, query: string, limit?: number): Promise<IpcResult<{ text: string; hits: number }>>
    /** Sidecar status (binary, server, port, last error). */
    aiStatus(): Promise<IpcResult<{ available: boolean; running: boolean; root: string; port?: number; error?: string }>>
    /** Saves every page as one Markdown bundle; returns the chosen path. */
    exportMarkdown(projectId: string): Promise<IpcResult<string | null>>
    /** Imports all .md files from a chosen folder as memory pages. */
    importMarkdown(projectId: string): Promise<IpcResult<number>>
  }
  power: {
    keepAwake(enabled: boolean): Promise<IpcResult<boolean>>
    state(): Promise<IpcResult<boolean>>
  }
  schedules: {
    list(): Promise<IpcResult<ScheduledTaskInfo[]>>
    create(input: ScheduledTaskInput): Promise<IpcResult<ScheduledTaskInfo>>
    update(taskId: string, patch: Partial<ScheduledTaskInput>): Promise<IpcResult<ScheduledTaskInfo>>
    remove(taskId: string): Promise<IpcResult<boolean>>
    runNow(taskId: string): Promise<IpcResult<ScheduledTaskInfo>>
  }
  approvals: {
    resolve(approvalId: string, approved: boolean, always?: boolean, reason?: string): Promise<IpcResult<boolean>>
  }
  inbox: {
    list(sessionId: string): Promise<IpcResult<Array<{ id: string; text: string; images: ImagePart[]; mode: 'steer' | 'queue'; origin: 'ui' | 'agent'; createdAt: number }>>>
    add(sessionId: string, text: string, images?: ImagePart[], mode?: 'steer' | 'queue', origin?: 'ui' | 'agent'): Promise<IpcResult<{ id: string; text: string; images: ImagePart[]; mode: 'steer' | 'queue'; origin: 'ui' | 'agent'; createdAt: number }>>
    remove(sessionId: string, itemId: string): Promise<IpcResult<boolean>>
    clear(sessionId: string): Promise<IpcResult<boolean>>
  }
  mcp: {
    restart(): Promise<IpcResult<boolean>>
  }
  terminal: {
    shells(): Promise<IpcResult<TerminalShell[]>>
    list(): Promise<IpcResult<TerminalInfo[]>>
    create(input: CreateTerminalInput): Promise<IpcResult<TerminalInfo>>
    snapshot(terminalId: string): Promise<IpcResult<string>>
    kill(terminalId: string): Promise<IpcResult<boolean>>
    /** Fire-and-forget: keystrokes must not wait for a round trip. */
    write(terminalId: string, data: string): void
    resize(terminalId: string, cols: number, rows: number): void
    onEvent(callback: (event: TerminalEvent) => void): () => void
  }
  window: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
  }
  events: {
    on(callback: (event: HarnessEvent) => void): () => void
  }
}
