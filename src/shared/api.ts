/**
 * IPC contract between renderer, preload and main process.
 * No Electron or Node imports allowed here.
 */

import type {
  AgentMode,
  AgentsListing,
  AppSettings,
  CapabilityReport,
  ContextBreakdown,
  FileChange,
  HarnessEvent,
  ImagePart,
  McpServerSettings,
  Project,
  ProviderConfig,
  QuestionAnswer,
  ReasoningEffort,
  SessionMeta,
  SessionState,
  SessionSummary,
  SessionSurface,
  SkillInfo
} from './types.js'
import {
  MCP_CONNECTOR_CHANNELS,
  type ConnectInput,
  type ConnectorDirectory,
  type ConnectorState,
  type ConnectorTool,
  type ConnectResult,
  type ToolPolicy
} from './mcp-connectors.js'
import type {
  LlamaCppLogInfo,
  LlamaCppProfile,
  LlamaCppStatusInfo,
  LlamaBuildDownloadInfo,
  LlamaDownloadInfo,
  LlamaHubFilesInfo,
  LlamaHubListInfo,
  LlamaLocalModel,
  LlamaMachineInfo,
  LlamaModelInfo,
  LlamaOptionsInfo
} from './llamacpp.js'

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

export interface WorktreeInfo {
  path: string
  head?: string
  branch?: string
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  prunableReason?: string
  isMain: boolean
}

export type ActivitySeverity = 'info' | 'success' | 'warning' | 'error'

export interface ActivityItem {
  id: string
  sessionId?: string
  createdAt: number
  updatedAt: number
  type: string
  severity: ActivitySeverity
  title: string
  detail: string
  read: boolean
  archived: boolean
  count: number
  actionRequired?: boolean
  actionable?: 'session' | 'tool' | 'approval' | 'settings' | 'log' | 'memory'
  metadata?: Record<string, unknown>
}

export interface CustomCommandInfo {
  name: string
  description: string
  argumentHint?: string
  /** `app`: shipped with Openclod (resources/commands); a user or project command with the same name replaces it. */
  source: 'projeto' | 'usuario' | 'app'
}

/* ------------------------------------------------------------------ */
/* Improvement review ("Revisão de melhorias")                          */
/* ------------------------------------------------------------------ */

export type ImprovementCategory = 'limitation' | 'tool' | 'permission' | 'budget' | 'cost' | 'workflow' | 'memory'
export type ImprovementSeverity = 'high' | 'medium' | 'low'

/** One evidence-backed observation the harness derived without any model. */
export interface ImprovementFinding {
  id: string
  category: ImprovementCategory
  severity: ImprovementSeverity
  title: string
  /** What was observed, with counts and session ids. */
  evidence: string
  /** The change that would address it. Never applied automatically. */
  suggestion: string
}

export interface ImprovementReviewInfo {
  id: string
  projectId: string
  projectName: string
  startedAt: number
  finishedAt?: number
  state: 'running' | 'done' | 'error' | 'cancelled'
  /** 'manual' from the button, 'schedule' from Agendados. */
  trigger: 'manual' | 'schedule'
  /** True when a model wrote the analysis; false for the automatic evidence report. */
  usedAi: boolean
  model?: string
  /** Memory page holding the report. */
  slug?: string
  title?: string
  /** First lines of the report, for lists. */
  summary?: string
  findings: number
  periodDays: number
  /** Human-readable step while running. */
  step?: string
  /** Why the AI analysis was skipped or failed (the automatic report is still saved). */
  note?: string
  error?: string
}

export interface ImprovementStatusInfo {
  /** The review running right now (any project), if any. */
  current: ImprovementReviewInfo | null
  /** The most recent finished review of the requested project. */
  last: ImprovementReviewInfo | null
  /** Recent reviews of the requested project, newest first. */
  history: ImprovementReviewInfo[]
  /** Weekly schedule in Agendados for the requested project. */
  weekly: { enabled: boolean; taskId?: string; nextRunAt?: number }
  /** Provider an AI analysis would use (its evidence leaves the machine), if one is configured. */
  aiProvider?: { id: string; label: string; model: string }
}

export interface ImprovementStartOptions {
  /** Ask the configured model to write the analysis (default true when a provider is available). */
  useAi?: boolean
  /** Look-back window in days (default 30, 1-180). */
  days?: number
}

export interface BackupStatsInfo {
  version: number
  createdAt: string
  appVersion?: string
  files: number
  bytes: number
  sha256: string
  /** Left out on purpose: audit journals and anything that looks like a secret. */
  skipped?: string[]
}

export interface BackupFileInfo {
  path: string
  stats: BackupStatsInfo
}

export interface BackupRestoreInfo extends BackupFileInfo {
  preRestore: BackupStatsInfo
  restoredFiles: number
  restartRecommended: boolean
}

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ObservabilityEventInfo {
  id: string
  ts: number
  type: string
  level: ObservabilityLevel
  sessionId?: string
  turnId?: string
  toolCallId?: string
  name?: string
  ok?: boolean
  durationMs?: number
  detail?: string
  metadata?: Record<string, unknown>
}

export interface ToolMetricInfo {
  name: string
  total: number
  failures: number
  totalMs: number
  averageMs: number
  maxMs: number
}

export interface ObservabilitySnapshotInfo {
  startedAt: number
  updatedAt: number
  uptimeMs: number
  eventCount: number
  sessionCount: number
  turnCount: number
  failedTurns: number
  toolCalls: number
  failedToolCalls: number
  approvalRequests: number
  blockedAudits: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  activeTurns: number
  activeTools: number
  tools: ToolMetricInfo[]
}

export interface HealthComponentInfo {
  id: string
  label: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

export interface ObservabilityViewInfo {
  snapshot: ObservabilitySnapshotInfo
  health: { status: 'ok' | 'warn' | 'error'; components: HealthComponentInfo[] }
  events: ObservabilityEventInfo[]
}

export interface DiagnosticExportInfo {
  path: string
  bytes: number
  sha256: string
  createdAt: string
}

export interface ConfigExportInfo {
  path: string
  bytes: number
  sha256: string
  createdAt: string
  warnings: string[]
}

export interface ConfigImportInfo {
  path: string
  createdAt: string
  providers: number
  environments: number
  mcpServers: number
  mergedSensitiveFields: number
  warnings: string[]
}

export interface UpdateAssetInfo {
  url: string
  sha256: string
  size: number
  platform: string
}

export interface UpdateCheckInfo {
  configured: boolean
  currentVersion: string
  latestVersion?: string
  available: boolean
  notes?: string
  publishedAt?: string
  asset?: UpdateAssetInfo
  detail: string
}

export interface UpdateDownloadInfo {
  path: string
  bytes: number
  sha256: string
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
  visionModels?: string[]
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
  | { type: 'created'; info: TerminalInfo }
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

/** The fields of a provider card that change what a request goes to, as typed in the Settings form. */
export interface ProviderDraft {
  baseUrl?: string
  kind?: ProviderConfig['kind']
  model?: string
}

export interface ModelDiscovery {
  models: Array<{ id: string; contextWindow?: number; supportsVision?: boolean; supportsTools?: boolean }>
  source: 'ollama' | 'lmstudio' | 'openai' | 'anthropic'
  error?: string
}

/* ---- Settings → Provedores → Google Colab (GPU) ---- */

/** The button: the notebook was written, and these are the steps to show. */
export interface ColabPrepareInfo {
  /** Full path of the .ipynb the user uploads to Colab. */
  path: string
  /** The file name and size, for the tile the user drags into Colab. */
  fileName: string
  sizeBytes: number
  folder: string
  url: string
  version: string
  steps: string[]
  /** What could be done on the user's behalf: Colab opened in the browser, the folder shown, the path copied. */
  opened: { colab: boolean; folder: boolean; clipboard: boolean }
}

/** What the confirmation shows before a pasted connection code is used. Never carries the key. */
export interface ColabPreview {
  host: string
  hostKind: 'trycloudflare' | 'loopback' | 'other'
  model: string
  gpu: string
  vramMiB?: number
  vision: boolean
  tools: boolean
  contextWindow: number
  notebookVersion: string
  engine?: string
  createdAt?: number
  /** The server module in the notebook is the one this build ships. */
  verified: boolean
  /** A Colab provider already exists: connecting replaces its address and key. */
  replacesExisting: boolean
  warnings: string[]
}

export type ColabInspectResult = { ok: true; preview: ColabPreview } | { ok: false; error: string }

/** `conectado` the server answered; `caiu` session ended or tunnel down; `chave` the notebook restarted with another key. */
export type ColabStateName = 'nao-conectado' | 'conectado' | 'caiu' | 'chave' | 'erro'

export interface ColabStatusInfo {
  state: ColabStateName
  detail: string
  checkedAt: number
  providerId: string
  host?: string
  model?: string
  gpu?: string
  notebookVersion?: string
  vision?: boolean
  contextWindow?: number
  connectedAt?: number
  latencyMs?: number
}

export interface ColabConnectResult {
  ok: boolean
  error?: string
  status?: ColabStatusInfo
}

export interface McpPresetEntry {
  id: string
  label: string
  description: string
  /** Entry to append to settings.mcpServers; null when it cannot be built on this machine. */
  server: McpServerSettings | null
  unavailableReason?: string
}

/** A `settings.json.bak-*` copy in the config folder (made before MCP credentials moved to the system vault). */
export interface SettingsBackupInfo {
  /** File name only (the folder is the app's config folder). */
  name: string
  bytes: number
  modifiedAt: number
  /** The copy still has an MCP credential in plain text (or could not be read, which is treated the same way). */
  mayHaveSecrets: boolean
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

export interface PluginToolInfo {
  key: string
  name: string
  description: string
  risk: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  author?: string
  apiVersion: string
  installed: boolean
  enabled: boolean
  initialized: boolean
  dependencies: string[]
  dependents: string[]
  tools: PluginToolInfo[]
  permissions: string[]
  errors: string[]
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
  /** Where each run's session opens. Missing means `code`, what tasks did before this field existed. */
  surface?: 'cowork' | 'code'
  providerId?: string
  model?: string
  schedule: ScheduleSpec
  enabled: boolean
  createdAt: number
  updatedAt: number
  priority?: 'low' | 'normal' | 'high'
  maxRetries?: number
  retryDelayMs?: number
  /** Built-in job instead of a prompt session; `prompt` then only describes it. */
  action?: 'improvement-review'
  actionOptions?: { useAi?: boolean; days?: number }
  runHistory?: Array<{
    id: string
    trigger: 'schedule' | 'manual'
    attempt: number
    status: 'ok' | 'error'
    startedAt: number
    finishedAt: number
    dueAt?: number
    late?: boolean
    sessionId?: string
    error?: string
  }>
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
  surface?: 'cowork' | 'code'
  providerId?: string
  model?: string
  schedule: ScheduleSpec
  enabled?: boolean
  priority?: 'low' | 'normal' | 'high'
  maxRetries?: number
  retryDelayMs?: number
  action?: 'improvement-review'
  actionOptions?: { useAi?: boolean; days?: number }
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
  /** CPU fallback threads; ignored when CUDA is available. */
  cpu_threads?: number
}

export interface TtsVoiceInfo {
  /** Runtime that produces this voice. */
  provider: 'windows' | 'edge'
  /** Stable identifier passed back to tts.speak. */
  id: string
  /** Name shown in the interface. */
  displayName: string
  /** Backwards-compatible alias of `id`. */
  name: string
  culture: string
  gender: string
  age: string
  categories?: string[]
  personalities?: string[]
}

export interface TtsSpeakOptions {
  text: string
  provider?: 'windows' | 'edge'
  voice?: string
  rate?: number
  volume?: number
}

export interface TtsSpeakResult {
  provider: 'windows' | 'edge'
  /** MP3 bytes for voices synthesized outside the main process. */
  audioBase64?: string
  mediaType?: 'audio/mpeg'
  fallbackReason?: string
  /** The request was replaced by a newer one, or stopped, while the voice was being made: nothing to play. */
  cancelled?: boolean
}

export type TtsState =
  | { phase: 'idle' }
  | { phase: 'synthesizing'; text?: string }
  | { phase: 'speaking'; text?: string }
  | { phase: 'error'; error: string }

export interface ProviderUsageInfo {
  providerId: string
  label: string
  /** Full prompt tokens, including cache hits. */
  input: number
  output: number
  cachedInput: number
  /** Cost accumulated with the provider rates at call time. */
  costUsd: number
  calls: number
  lastModel?: string
  updatedAt: number
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
  /** Words of the whole page (normalized, no accents) the wiki indexes: the screen's search looks at them too. */
  terms?: string[]
  /** `wiki` (native markdown) or `ai-memory` (indexed page). */
  source?: 'wiki' | 'ai-memory'
  /** AI-Memory page path when `source` is `ai-memory`. */
  path?: string
  memoryType?: 'decision' | 'preference' | 'convention' | 'solution' | 'pending' | 'fact'
  confidence?: 'observed' | 'inferred' | 'suggested'
  status?: 'active' | 'superseded' | 'invalidated'
  evidence?: string[]
  context?: string
  supersedes?: string
  supersededBy?: string
  possibleConflicts?: string[]
}

export interface MemoryStatsInfo {
  root: string
  pages: number
  pinned: number
  openHandoffs: number
  updatedAt?: string
  /** Pages the AI-Memory index holds for the project (wiki pages, turns and media). */
  indexed?: number
  /** Whether the AI-Memory sidecar answered. */
  aiRunning?: boolean
  /** The wiki being copied into the index: pages copied so far, of how many, and whether a pass is running. */
  indexSync?: { done: number; total: number; running: boolean }
  /** Files kept in the memory, by kind (imagem, pdf, documento, planilha, apresentacao, texto, codigo, audio, video, arquivo). */
  files?: Record<string, number>
  /** The same files with how many have their text or description in the index (found by the agent at any time) and how many lost the file on disk. */
  fileIndex?: Record<string, { total: number; indexed: number; missing: number }>
  conflicts?: number
  superseded?: number
  invalidated?: number
}

/** A file kept in the project memory (Memória → Arquivos; the agent's memory_file). */
export interface MemoryFileInfo {
  slug: string
  /** imagem, pdf, documento, planilha, apresentacao, texto, codigo, audio, video, arquivo */
  kind: string
  name: string
  bytes: number
  added: string
  description?: string
  describedBy?: string
  width?: number
  height?: number
  pages?: number
  textChars: number
  tags: string[]
  links: string[]
  /** It has a thumbnail (memory.fileThumb). */
  thumb: boolean
}

/** Saving files into the memory in the background (Memória → Adicionar arquivos/pasta). */
export interface MemoryAddJobInfo {
  active: boolean
  done: number
  total: number
  current: string
  added: number
  cached: number
  described: number
  failed: string[]
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
  /** Explicit wikilinks found in the markdown, represented by page id. */
  links?: string[]
  memoryType?: 'decision' | 'preference' | 'convention' | 'solution' | 'pending' | 'fact'
  confidence?: 'observed' | 'inferred' | 'suggested'
  status?: 'active' | 'superseded' | 'invalidated'
  evidence?: string[]
  context?: string
  supersedes?: string
  supersededBy?: string
  possibleConflicts?: string[]
}

export interface MemoryGraphNodeInfo {
  id: string
  path: string
  title: string
  kind: 'session' | 'page' | 'fact'
  tags: string[]
  updated: string
  degree: number
  terms: string[]
  /** Text used by quick search in the graph (bounded excerpt of the full page). */
  summary?: string
  status?: 'active' | 'superseded' | 'invalidated'
}

export interface MemoryGraphEdgeInfo {
  source: string
  target: string
  kind: 'link' | 'tag' | 'term'
  weight: number
}

export interface MemoryGraphInfo {
  nodes: MemoryGraphNodeInfo[]
  edges: MemoryGraphEdgeInfo[]
  /** Pages there are (or that match the search) before the graph's limit; `truncated` when some are left out. */
  total?: number
  truncated: boolean
  source: 'ai-memory' | 'native'
}

export interface CreateTerminalInput {
  cwd: string
  cols: number
  rows: number
  shell?: TerminalShell
  sessionId?: string
}

/** State of the Chrome integration shown in Settings → Navegador. */
export interface ChromeCompanionInfo {
  installed: boolean
  /** Folder to load in chrome://extensions. */
  extensionPath: string
  hostPath: string
  manifestPath: string
  chromePath?: string
  detail: string
  extensionConnected?: boolean
  /** Version running inside Chrome (from its hello message). */
  extensionVersion?: string
  /** Version bundled with this app. */
  bundledVersion?: string
  /** Chrome runs an older extension than the bundled one: reload it in chrome://extensions. */
  extensionOutdated?: boolean
}

export const CH = {
  appCapabilities: 'app:capabilities',
  appProviderUsage: 'app:providerUsage',
  appPresets: 'app:presets',
  appSettings: 'app:settings',
  appUpdateSettings: 'app:updateSettings',
  appSetSecret: 'app:setSecret',
  appClearSecret: 'app:clearSecret',
  appTestProvider: 'app:testProvider',
  appVersions: 'app:versions',
  appBackupExport: 'app:backup:export',
  appBackupInspect: 'app:backup:inspect',
  appBackupRestore: 'app:backup:restore',
  appObservability: 'app:observability',
  appDiagnosticsExport: 'app:diagnostics:export',
  appConfigExport: 'app:config:export',
  appConfigImport: 'app:config:import',
  appUpdateCheck: 'app:update:check',
  appUpdateDownload: 'app:update:download',
  appSkills: 'app:skills',
  appNotify: 'app:notify',
  appCreateSkill: 'app:createSkill',
  appDiscoverModels: 'app:discoverModels',
  colabPrepare: 'colab:prepare',
  colabInspect: 'colab:inspect',
  colabConnect: 'colab:connect',
  colabStatus: 'colab:status',
  colabDisconnect: 'colab:disconnect',
  colabReveal: 'colab:reveal',
  colabDragStart: 'colab:drag-start',
  llamacppStatus: 'llamacpp:status',
  llamacppSetProfile: 'llamacpp:set-profile',
  llamacppPickModel: 'llamacpp:pick-model',
  llamacppModels: 'llamacpp:models',
  llamacppPickFolder: 'llamacpp:pick-folder',
  llamacppHubList: 'llamacpp:hub-list',
  llamacppHubRefresh: 'llamacpp:hub-refresh',
  llamacppHubSearch: 'llamacpp:hub-search',
  llamacppHubFiles: 'llamacpp:hub-files',
  llamacppDownload: 'llamacpp:download',
  llamacppDownloadStatus: 'llamacpp:download-status',
  llamacppDownloadCancel: 'llamacpp:download-cancel',
  llamacppOptions: 'llamacpp:options',
  llamacppProfileAction: 'llamacpp:profile-action',
  llamacppMachine: 'llamacpp:machine',
  llamacppBuildInstall: 'llamacpp:build-install',
  llamacppBuildStatus: 'llamacpp:build-status',
  llamacppBuildCancel: 'llamacpp:build-cancel',
  llamacppBuildSelect: 'llamacpp:build-select',
  llamacppBuildRemove: 'llamacpp:build-remove',
  llamacppStart: 'llamacpp:start',
  llamacppStop: 'llamacpp:stop',
  llamacppLog: 'llamacpp:log',
  appRememberModel: 'app:rememberModel',
  appMcpPresets: 'app:mcpPresets',
  appMcpCatalog: 'app:mcpCatalog',
  appMcpBackups: 'app:mcpBackups',
  appMcpBackupsClear: 'app:mcpBackupsClear',
  appMcpInstall: 'app:mcpInstall',
  appMcpOAuthStatus: 'app:mcpOAuthStatus',
  appMcpOAuthAuthorize: 'app:mcpOAuthAuthorize',
  // Conectores (diretório, estados, conectar/desconectar, política por ferramenta); nomes do contrato em mcp-connectors.ts.
  mcpcDirectory: MCP_CONNECTOR_CHANNELS.directory,
  mcpcStates: MCP_CONNECTOR_CHANNELS.states,
  mcpcConnect: MCP_CONNECTOR_CHANNELS.connect,
  mcpcDisconnect: MCP_CONNECTOR_CHANNELS.disconnect,
  mcpcTools: MCP_CONNECTOR_CHANNELS.tools,
  mcpcSetToolPolicy: MCP_CONNECTOR_CHANNELS.setToolPolicy,
  mcpcReload: MCP_CONNECTOR_CHANNELS.reload,
  mcpcMaskedSettings: MCP_CONNECTOR_CHANNELS.maskedSettings,
  appChromeCompanion: 'app:chromeCompanion',
  appChromeInstall: 'app:chromeInstall',
  appChromeExtensions: 'app:chromeExtensions',
  appChromeExport: 'app:chromeExport',
  appChromeReveal: 'app:chromeReveal',
  appEnvironmentCheck: 'app:environmentCheck',
  activityList: 'activity:list',
  activityRead: 'activity:read',
  activityArchive: 'activity:archive',
  activityClear: 'activity:clear',
  improvementsStatus: 'improvements:status',
  improvementsStart: 'improvements:start',
  improvementsCancel: 'improvements:cancel',
  improvementsWeekly: 'improvements:weekly',
  commandsList: 'commands:list',
  appImportClaude: 'app:importClaude',
  appClaudeStatus: 'app:claudeStatus',
  appClaudeLogin: 'app:claudeLogin',
  appPluginCatalog: 'app:pluginCatalog',
  appPlugins: 'app:plugins',
  appPluginInstallLocal: 'app:plugin:installLocal',
  appPluginSetEnabled: 'app:plugin:setEnabled',
  appPluginRemove: 'app:plugin:remove',
  appPluginDiagnostics: 'app:plugin:diagnostics',
  appAgents: 'app:agents',
  appOpenSkills: 'app:openSkills',

  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsRemove: 'projects:remove',
  projectsDelete: 'projects:delete',
  projectsPick: 'projects:pick',
  projectsSetModel: 'projects:setModel',
  pathsPickFolder: 'paths:pickFolder',
  projectsEnsureDefault: 'projects:ensureDefault',

  sessionsList: 'sessions:list',
  sessionsCreate: 'sessions:create',
  sessionsGet: 'sessions:get',
  sessionsDelete: 'sessions:delete',
  sessionsRename: 'sessions:rename',
  sessionsSend: 'sessions:send',
  sessionsAbort: 'sessions:abort',
  sessionsResumePlan: 'sessions:resumePlan',
  sessionsDiscardPlan: 'sessions:discardPlan',
  sessionsSetMode: 'sessions:setMode',
  sessionsSetModel: 'sessions:setModel',
  sessionsSetEffort: 'sessions:setEffort',
  sessionsSetEnvironment: 'sessions:setEnvironment',
  sessionsExport: 'sessions:export',
  sessionsImport: 'sessions:import',
  sessionsArchive: 'sessions:archive',
  sessionsCompact: 'sessions:compact',
  sessionsContextBreakdown: 'sessions:contextBreakdown',
  sessionsRewind: 'sessions:rewind',
  sessionsFork: 'sessions:fork',
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
  gitWorktreesList: 'git:worktrees:list',
  gitWorktreeCreate: 'git:worktree:create',
  gitWorktreeRemove: 'git:worktree:remove',

  previewDetect: 'preview:detect',
  previewStart: 'preview:start',

  tasksList: 'tasks:list',
  tasksOutput: 'tasks:output',
  tasksStop: 'tasks:stop',

  powerKeepAwake: 'power:keepAwake',
  sttStatus: 'stt:status',
  sttStart: 'stt:start',
  sttPreload: 'stt:preload',
  sttStop: 'stt:stop',
  sttAudio: 'stt:audio',
  sttEvent: 'openclod:stt',
  ttsVoices: 'tts:voices',
  ttsStatus: 'tts:status',
  ttsSpeak: 'tts:speak',
  ttsStop: 'tts:stop',
  ttsEvent: 'openclod:tts',
  dictationToggle: 'openclod:dictation:toggle',
  dictationState: 'dictation:state',
  dictationInsert: 'dictation:insert',
  dictationComposer: 'openclod:dictation:composer',
  memoryStatus: 'memory:status',
  memoryList: 'memory:list',
  memoryRead: 'memory:read',
  memoryDelete: 'memory:delete',
  memoryInvalidate: 'memory:invalidate',
  memoryOpen: 'memory:open',
  memoryExport: 'memory:export',
  memoryImport: 'memory:import',
  memoryImportZip: 'memory:importZip',
  memoryRecall: 'memory:recall',
  memoryAiStatus: 'memory:aiStatus',
  memoryGraph: 'memory:graph',
  memoryFiles: 'memory:files',
  memoryFileThumb: 'memory:fileThumb',
  memoryOpenFile: 'memory:openFile',
  memoryAddFiles: 'memory:addFiles',
  memoryAddStatus: 'memory:addStatus',
  powerState: 'power:state',

  schedulesList: 'schedules:list',
  schedulesCreate: 'schedules:create',
  schedulesUpdate: 'schedules:update',
  schedulesRemove: 'schedules:remove',
  schedulesRunNow: 'schedules:runNow',

  approvalsResolve: 'approvals:resolve',
  approvalsSaved: 'approvals:saved',
  approvalsRevoke: 'approvals:revoke',
  questionsAnswer: 'questions:answer',
  mcpRestart: 'mcp:restart',

  terminalShells: 'terminal:shells',
  terminalList: 'terminal:list',
  terminalCreate: 'terminal:create',
  terminalSnapshot: 'terminal:snapshot',
  terminalKill: 'terminal:kill',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalEvent: 'openclod:terminal',

  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',

  event: 'openclod:event'
} as const

export interface OpenclodApi {
  app: {
    capabilities(): Promise<IpcResult<CapabilityReport>>
    /** Tokens and cost accumulated per provider across all sessions. */
    providerUsage(): Promise<IpcResult<ProviderUsageInfo[]>>
    presets(): Promise<IpcResult<ProviderPresetInfo[]>>
    settings(): Promise<IpcResult<AppSettings>>
    updateSettings(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
    setSecret(providerId: string, value: string): Promise<IpcResult<boolean>>
    clearSecret(providerId: string): Promise<IpcResult<boolean>>
    /** `draft`: what the form shows now (address, kind, model), for a provider whose edits are not saved yet. */
    testProvider(providerId: string, draft?: ProviderDraft): Promise<IpcResult<{ ok: boolean; detail: string }>>
    versions(): Promise<IpcResult<AppVersions>>
    /** Writes a checksummed, compressed bundle excluding secrets. */
    backupExport(): Promise<IpcResult<BackupFileInfo | null>>
    /** Selects and validates a bundle without restoring it. */
    backupInspect(): Promise<IpcResult<BackupFileInfo | null>>
    /** Creates a safety bundle, then restores projects, sessions, settings and knowledge. */
    backupRestore(): Promise<IpcResult<BackupRestoreInfo | null>>
    /** Correlated, sanitized runtime events, metrics and component health. */
    observability(filters?: { query?: string; level?: string; type?: string; sessionId?: string; limit?: number }): Promise<IpcResult<ObservabilityViewInfo>>
    /** Writes a compressed diagnostic bundle without credentials or project file contents. */
    exportDiagnostics(): Promise<IpcResult<DiagnosticExportInfo | null>>
    /** Exports portable settings without credentials, secret env values or headers. */
    exportConfiguration(): Promise<IpcResult<ConfigExportInfo | null>>
    /** Validates and applies a portable configuration while preserving local secrets. */
    importConfiguration(): Promise<IpcResult<ConfigImportInfo | null>>
    checkForUpdates(): Promise<IpcResult<UpdateCheckInfo>>
    downloadUpdate(): Promise<IpcResult<UpdateDownloadInfo | null>>
    skills(): Promise<IpcResult<SkillInfo[]>>
    notify(title: string, body: string): Promise<IpcResult<boolean>>
    createSkill(name: string, description: string, body: string): Promise<IpcResult<SkillInfo>>
    /** `draft`: what the form shows now (address, kind), so "Detectar modelos" asks the server the user typed, not the saved one. */
    discoverModels(providerId: string, draft?: ProviderDraft): Promise<IpcResult<ModelDiscovery>>
    /** Google Colab (GPU): writes the notebook, shows it in Explorer, copies its path and opens Colab in the browser. */
    colabPrepare(): Promise<IpcResult<ColabPrepareInfo>>
    /** Reads a pasted connection code WITHOUT saving or contacting anything: what to confirm (host, model, GPU, vision). */
    colabInspect(code: string): Promise<IpcResult<ColabInspectResult>>
    /** Validates the code again, asks the server, stores the key in the vault and creates/updates the `colab` provider. */
    colabConnect(code: string): Promise<IpcResult<ColabConnectResult>>
    /** Live health of the connected server (`fresh` skips the 4 s cache). */
    colabStatus(fresh?: boolean): Promise<IpcResult<ColabStatusInfo>>
    /** Removes the `colab` provider and its key. */
    colabDisconnect(): Promise<IpcResult<ColabStatusInfo>>
    /** Shows the notebook written by `colabPrepare` in Explorer again (false: nothing was prepared yet). */
    colabRevealNotebook(): Promise<IpcResult<boolean>>
    /**
     * Starts a native drag of that notebook file, so the user can drop it on Colab's upload area. Fire-and-forget: Electron only
     * allows it while the page's `dragstart` is running, and the main process, not the page, decides which file it is.
     */
    colabStartDrag(): void
    /** The embedded llama.cpp: build, server state, model and the options of the next run. */
    llamacppStatus(): Promise<IpcResult<LlamaCppStatusInfo>>
    /**
     * Saves options of the next run; a new model is read (and refused when it is not a chat GGUF) and option values are
     * checked against the build's help right away. `extraText` = the extra arguments as typed (split without a shell).
     */
    llamacppSetProfile(patch: Partial<LlamaCppProfile> & { extraText?: string }): Promise<IpcResult<LlamaCppStatusInfo>>
    /** Windows file picker for a .gguf; null when cancelled. The model is not saved: call llamacppSetProfile with it. */
    llamacppPickModel(): Promise<IpcResult<LlamaModelInfo | null>>
    /** The GGUFs on this computer (Ollama, LM Studio, Hugging Face cache, downloads, added folders). */
    llamacppModels(): Promise<IpcResult<LlamaLocalModel[]>>
    /** Windows folder picker for the model search; null when cancelled. The folder is not saved: add it to `folders`. */
    llamacppPickFolder(): Promise<IpcResult<string | null>>
    /** Hugging Face models for this computer (the list is cached for 12 h and fetched again in the background). */
    llamacppHubList(): Promise<IpcResult<LlamaHubListInfo>>
    llamacppHubRefresh(): Promise<IpcResult<LlamaHubListInfo>>
    /** Free-text search on Hugging Face, for what the list does not have. */
    llamacppHubSearch(query: string): Promise<IpcResult<LlamaHubListInfo>>
    /** The repository's real files, with exact sizes and the suggested one. */
    llamacppHubFiles(repo: string): Promise<IpcResult<LlamaHubFilesInfo>>
    /** Downloads the file (and the repository's vision projector) in the background; the profile then uses it. */
    llamacppDownload(repo: string, name: string): Promise<IpcResult<LlamaDownloadInfo>>
    llamacppDownloadStatus(): Promise<IpcResult<LlamaDownloadInfo>>
    llamacppDownloadCancel(): Promise<IpcResult<LlamaDownloadInfo>>
    /** Every option of the running build (from its --help), grouped, and the next command line. */
    llamacppOptions(): Promise<IpcResult<LlamaOptionsInfo>>
    /** Perfis: select, create (copy of the current), rename (`to`) or delete. */
    llamacppProfileAction(action: { kind: 'select' | 'create' | 'rename' | 'delete'; name: string; to?: string }): Promise<IpcResult<LlamaCppStatusInfo>>
    /** Versões: the NVIDIA cards, the CUDA their driver runs and the build to suggest. */
    llamacppMachine(): Promise<IpcResult<LlamaMachineInfo>>
    /** Downloads an official build from GitHub (`tag` = "newest" for the newest one that has it). */
    llamacppBuildInstall(kind: string, tag: string): Promise<IpcResult<LlamaBuildDownloadInfo>>
    llamacppBuildStatus(): Promise<IpcResult<LlamaBuildDownloadInfo>>
    llamacppBuildCancel(): Promise<IpcResult<LlamaBuildDownloadInfo>>
    llamacppBuildSelect(id: string): Promise<IpcResult<LlamaCppStatusInfo>>
    llamacppBuildRemove(id: string): Promise<IpcResult<LlamaCppStatusInfo>>
    /** Starts llama-server with the saved model; it becomes the `llamacpp` provider once it answers. */
    llamacppStart(): Promise<IpcResult<LlamaCppStatusInfo>>
    llamacppStop(): Promise<IpcResult<LlamaCppStatusInfo>>
    /** Server log lines after `since` (the `seq` of the last read). */
    llamacppLog(since?: number): Promise<IpcResult<LlamaCppLogInfo>>
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
    mcpOAuthStatus(serverName?: string): Promise<IpcResult<{ available: boolean; connected: boolean; server?: string; expiresAt?: number; detail: string }>>
    authorizeMcp(serverName: string): Promise<IpcResult<{ connected: boolean; detail: string }>>
    /** The connector directory (resources/mcp-directory.json, plus Openclod's own catalog). Data, not installed servers. */
    connectorDirectory(): Promise<IpcResult<ConnectorDirectory>>
    /** Live state of every directory entry and of every custom server; cheap, call it again on `settings_changed` scope `mcp`. */
    connectorStates(): Promise<IpcResult<ConnectorState[]>>
    /**
     * Installs and connects a directory entry (`id`) or a custom connector (`input.custom`). Credentials go to the OS vault.
     * OAuth connectors return at once with `authUrl` (already opened in the browser); the result arrives as a `settings_changed` event.
     * `input.oauthClient` brings the user's own OAuth app (required for `oauth-static` entries without a directory client id;
     * the secret goes to the vault and later connects reuse it). The return URL to register is `state.redirectUri`
     * (fixed: MCP_OAUTH_REDIRECT_URI). `input.dryRun` rehearses the login without opening or saving anything (`result.dryRun`).
     */
    connectConnector(id: string, input?: ConnectInput): Promise<IpcResult<ConnectResult>>
    /** Removes the connector, revokes its OAuth token when the server allows it and deletes its credentials from the vault. */
    disconnectConnector(id: string): Promise<IpcResult<ConnectorState>>
    /** Live tools of a connected server with the current permission of each one. */
    connectorTools(serverName: string): Promise<IpcResult<ConnectorTool[]>>
    /** Saves one tool's permission; `'*'` sets all tools of the server. Returns the updated tool list. */
    setToolPolicy(serverName: string, tool: string, policy: ToolPolicy): Promise<IpcResult<ConnectorTool[]>>
    /** Restarts the MCP servers and returns the new states. */
    reloadMcp(): Promise<IpcResult<ConnectorState[]>>
    /** `mcpServers` for the JSON editor with every credential masked; saving it back through `updateSettings` keeps the stored secrets. */
    maskedMcpSettings(): Promise<IpcResult<McpServerSettings[]>>
    /** `settings.json.bak-*` copies in the config folder; an old one can still hold MCP credentials in plain text. */
    mcpBackups(): Promise<IpcResult<SettingsBackupInfo[]>>
    /** Deletes every `settings.json.bak-*` file of the config folder (and nothing else). Returns how many were removed. */
    clearMcpBackups(): Promise<IpcResult<{ removed: number }>>
    /** Copies skills, agents and MCP servers from Claude Desktop/Code. */
    importClaude(): Promise<IpcResult<ClaudeImportInfo>>
    /** Authentication state of the local Claude Code CLI. */
    claudeStatus(): Promise<IpcResult<{ loggedIn: boolean; method?: string; account?: string; raw?: string }>>
    /** Opens a terminal running `claude auth login`; the user completes the browser step. */
    claudeLogin(): Promise<IpcResult<boolean>>
    /** The 315-plugin marketplace snapshot bundled with the app. */
    pluginCatalog(): Promise<IpcResult<PluginCatalogEntry[]>>
    plugins(): Promise<IpcResult<PluginInfo[]>>
    installLocalPlugin(): Promise<IpcResult<PluginInfo | null>>
    setPluginEnabled(pluginId: string, enabled: boolean): Promise<IpcResult<PluginInfo>>
    removePlugin(pluginId: string): Promise<IpcResult<boolean>>
    pluginDiagnostics(): Promise<IpcResult<PluginInfo[]>>
    /** Built-in + imported agents available to a project. */
    agents(cwd?: string): Promise<IpcResult<AgentsListing>>
    openSkillsFolder(): Promise<IpcResult<boolean>>
    chromeCompanion(): Promise<IpcResult<ChromeCompanionInfo>>
    /** Installs the native-messaging host and prepares the unpacked extension. */
    installChromeCompanion(): Promise<IpcResult<ChromeCompanionInfo>>
    /** Opens chrome://extensions so the user confirms the local extension once. */
    openChromeExtensions(): Promise<IpcResult<ChromeCompanionInfo>>
    /** Packs the extension into a .zip (manifest at the root) on the Desktop and returns where it went. */
    exportChromeExtension(): Promise<IpcResult<{ path: string; bytes: number; files: number; version: string }>>
    /** Opens the folder of the extension in the file manager (the folder to load in chrome://extensions). */
    revealChromeExtension(): Promise<IpcResult<boolean>>
    /** Runs a real command in the selected environment and returns its output. */
    environmentCheck(environmentId: string): Promise<IpcResult<{ ok: boolean; kind: string; detail: string; stdout: string; stderr: string; exitCode: number | null }>>
    activity(filters?: { query?: string; type?: string; severity?: string; archived?: boolean; limit?: number }): Promise<IpcResult<ActivityItem[]>>
    setActivityRead(itemId: string, read: boolean): Promise<IpcResult<boolean>>
    archiveActivity(itemId: string, archived: boolean): Promise<IpcResult<boolean>>
    clearActivity(archivedOnly?: boolean): Promise<IpcResult<number>>
  }
  paths: {
    /**
     * Absolute path of a `File` dropped or picked in the renderer. Electron 32+
     * removed `File.path`, so the preload resolves it with `webUtils`.
     */
    fromFile(file: File): string
    /** Directory picker for a folder the agent should study (not a project). */
    pickFolder(): Promise<IpcResult<string | null>>
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
    /** Stores the default LLM for this project only, not for other projects. */
    setModel(projectId: string, providerId: string, model: string): Promise<IpcResult<Project>>
  }
  sessions: {
    list(): Promise<IpcResult<SessionSummary[]>>
    create(input: CreateSessionInput): Promise<IpcResult<SessionMeta>>
    get(sessionId: string): Promise<IpcResult<SessionState>>
    delete(sessionId: string): Promise<IpcResult<boolean>>
    rename(sessionId: string, title: string): Promise<IpcResult<SessionState>>
    send(sessionId: string, text: string, images?: ImagePart[], mode?: 'steer' | 'queue' | 'auto'): Promise<IpcResult<boolean>>
    abort(sessionId: string): Promise<IpcResult<boolean>>
    /** ▶ on a plan step after the turn stopped: reopens that step and starts a turn that continues from it. */
    resumePlan(sessionId: string, itemId: string): Promise<IpcResult<boolean>>
    /** 🗑 on the plan dock: stops the turn, empties the queue, clears the plan and forgets the session's continuity capsule. No undo. */
    discardPlan(sessionId: string): Promise<IpcResult<{ capsules: number }>>
    setMode(sessionId: string, mode: AgentMode): Promise<IpcResult<boolean>>
    setModel(sessionId: string, providerId: string, model: string): Promise<IpcResult<boolean>>
    /** null restores the model's own default depth. */
    setEffort(sessionId: string, effort: ReasoningEffort | null): Promise<IpcResult<boolean>>
    setEnvironment(sessionId: string, environmentId: string): Promise<IpcResult<boolean>>
    export(sessionId: string): Promise<IpcResult<string>>
    import(json: string): Promise<IpcResult<SessionMeta>>
    archive(sessionId: string, archived: boolean): Promise<IpcResult<SessionMeta>>
    compact(sessionId: string): Promise<IpcResult<SessionState>>
    /** Measured size of what the next request carries; null while the session has no runner yet (no turn so far). */
    contextBreakdown(sessionId: string): Promise<IpcResult<ContextBreakdown | null>>
    /** Keeps the conversation through one message and discards everything after it. */
    rewind(sessionId: string, messageId: string, restoreFiles?: boolean): Promise<IpcResult<SessionState>>
    /** Creates an independent side chat containing the history through one message. */
    fork(sessionId: string, messageId: string): Promise<IpcResult<SessionState>>
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
    listWorktrees(root: string): Promise<IpcResult<WorktreeInfo[]>>
    createWorktree(root: string, branch: string, baseRef?: string): Promise<IpcResult<WorktreeInfo>>
    removeWorktree(root: string, path: string): Promise<IpcResult<WorktreeInfo>>
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
    /** Loads the model without starting a session; the mic click then reuses it. */
    preload(options?: SttStartOptions): Promise<IpcResult<SttReady | null>>
    /** Flushes the last utterance and resets the stream, keeping the model loaded. */
    stop(): Promise<IpcResult<boolean>>
    /** 16 kHz mono little-endian int16 samples. Fire and forget. */
    audio(pcm: ArrayBuffer): void
    onEvent(callback: (event: SttEvent) => void): () => void
  }
  tts: {
    voices(provider?: 'windows' | 'edge'): Promise<IpcResult<TtsVoiceInfo[]>>
    status(): Promise<IpcResult<TtsState & { available: boolean }>>
    speak(options: TtsSpeakOptions): Promise<IpcResult<TtsSpeakResult>>
    stop(): Promise<IpcResult<boolean>>
    onEvent(callback: (event: TtsState) => void): () => void
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
  commands: {
    /** Custom slash commands (markdown templates) visible from a project folder. */
    list(cwd: string): Promise<IpcResult<CustomCommandInfo[]>>
  }
  improvements: {
    status(projectId: string): Promise<IpcResult<ImprovementStatusInfo>>
    /** Starts a review and returns at once; follow it with `status`. Only one runs at a time. */
    start(projectId: string, options?: ImprovementStartOptions): Promise<IpcResult<ImprovementReviewInfo>>
    cancel(): Promise<IpcResult<boolean>>
    /** Creates, enables or pauses the weekly review of a project in Agendados. */
    setWeekly(projectId: string, enabled: boolean, options?: { useAi?: boolean }): Promise<IpcResult<ImprovementStatusInfo['weekly']>>
  }
  memory: {
    status(projectId: string): Promise<IpcResult<MemoryStatsInfo>>
    list(projectId: string): Promise<IpcResult<MemoryPageInfo[]>>
    read(projectId: string, slug: string): Promise<IpcResult<MemoryPageContent | null>>
    delete(projectId: string, slug: string): Promise<IpcResult<boolean>>
    /** Marks a memory as invalid without deleting its evidence or history. */
    invalidate(projectId: string, slug: string, reason?: string): Promise<IpcResult<MemoryPageInfo | null>>
    /** Opens the project's memory folder in Explorer. */
    open(projectId: string): Promise<IpcResult<boolean>>
    /** Bounded recall from the project's AI-Memory index. */
    recall(projectId: string, query: string, limit?: number): Promise<IpcResult<{ text: string; hits: number }>>
    /** Sidecar status (binary, server, port, last error). */
    aiStatus(): Promise<IpcResult<{ available: boolean; running: boolean; root: string; port?: number; error?: string }>>
    /** Obsidian-style graph: explicit + semantic connections for one project. */
    /** The most connected pages, or with `query` the pages that match it and their linked neighbours. */
    graph(projectId: string, query?: string): Promise<IpcResult<MemoryGraphInfo>>
    /** Saves every page as one Markdown bundle; returns the chosen path. */
    exportMarkdown(projectId: string): Promise<IpcResult<string | null>>
    /** Imports all .md files from a chosen folder as memory pages. */
    importMarkdown(projectId: string): Promise<IpcResult<number>>
    /** Imports Markdown files from a Claude-style ZIP without extracting outside a temp folder. */
    importZip(projectId: string): Promise<IpcResult<number>>
    /** Files kept in the memory (pictures with their description, PDFs, documents...). */
    files(projectId: string): Promise<IpcResult<MemoryFileInfo[]>>
    /** A file's thumbnail as a data URL; null when it has none. */
    fileThumb(projectId: string, slug: string): Promise<IpcResult<string | null>>
    /** Opens the copy kept in the memory with the default program. */
    openFile(projectId: string, slug: string): Promise<IpcResult<boolean>>
    /** Windows picker (files, or one folder with its subfolders); saves them in the background. Null when cancelled. */
    addFiles(projectId: string, pick: 'files' | 'folder'): Promise<IpcResult<MemoryAddJobInfo | null>>
    addStatus(projectId: string): Promise<IpcResult<MemoryAddJobInfo | null>>
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
    /** `always` with approved = "Permitir sempre"; with approved false = "Negar sempre" (saved for the project). */
    resolve(approvalId: string, approved: boolean, always?: boolean, reason?: string): Promise<IpcResult<boolean>>
    /** The "Permitir sempre" / "Negar sempre" choices saved per project. */
    saved(): Promise<IpcResult<Array<{ projectId: string; projectName: string; allow: string[]; deny: string[] }>>>
    /** Takes back one saved choice; false when it was not there. */
    revoke(projectId: string, rule: string, effect: 'allow' | 'deny'): Promise<IpcResult<boolean>>
  }
  questions: {
    /** Answers a pending ask_user request; false when it expired or belongs to another session. */
    answer(questionId: string, answers: QuestionAnswer[]): Promise<IpcResult<boolean>>
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
