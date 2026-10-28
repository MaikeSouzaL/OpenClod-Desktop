import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, session as electronSession, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { Orchestrator } from './orchestrator.js'
import type { ColabHost } from './colab.js'
import { expandCommand, loadCustomCommands, matchCustomCommand } from '../core/commands/library.js'
import { DictationController } from './dictation.js'
import { SttService } from './stt.js'
import { TtsService } from './tts.js'
import { defaultSettings } from './settings.js'
import { TerminalManager, availableShells } from './terminal.js'
import type { TerminalRunner } from '../core/terminal/runner.js'
import { ComputerOverlay } from './computer-overlay.js'
import { detectDevServers, startDevServer } from './preview.js'
import { searchProjectFiles, writeProjectFile } from './project-files.js'
import { backgroundProcessOutput, listBackgroundProcesses, stopBackgroundProcess } from '../core/tools/shell.js'
import { createWorktree, gitFileDiff, gitStatus, listWorktrees, removeWorktree } from '../core/git/service.js'
import { Scheduler, scheduledSession, type ScheduledTask } from '../core/scheduler/scheduler.js'
import { CH, type AppVersions, type CreateSessionInput, type PluginCatalogEntry, type ProviderPresetInfo, type ProviderUsageInfo, type SttStartOptions } from '../shared/api.js'
import {
  AGENT_MODES,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type AppSettings,
  type HarnessEvent,
  type HooksConfig,
  type ImagePart,
  type ModelCompat,
  type PermissionMode,
  type QuestionAnswer
} from '../shared/types.js'
import { PROVIDER_PRESETS } from '../core/providers/presets.js'
import { HOOK_EVENTS, normalizeHookDefinition } from '../core/hooks/runner.js'
import { normalizeMcpServerSettings } from '../core/mcp/client.js'
import type { ToolPolicy } from '../shared/mcp-connectors.js'
import { MAX_MCP_SERVERS } from './connector-service.js'
import { clearSettingsBackups, listSettingsBackups } from './settings-backups.js'
import { connectInputFrom } from './connector-input.js'
import { chromeCompanionStatus, exportChromeExtension, installChromeCompanion, openChromeExtensions, syncStableExtension } from './chrome/install.js'
import { compareVersions } from './chrome/package.js'
import { environmentSpawn } from '../core/tools/shell.js'
import { ActivityStore } from './activity-store.js'
import { ProviderUsageStore } from './provider-usage.js'
import { createImprovementService, improvementStatus, setWeeklyReview, startOptions } from './improvement.js'
import type { ImprovementService } from '../core/improvements/service.js'
import { BackupService } from '../core/backup/service.js'
import { ObservabilityService } from '../core/observability/service.js'
import { ConfigTransferService } from '../core/config/transfer.js'
import { notificationForEvent } from './notifications.js'
import { checkForUpdate, downloadUpdate } from './updater.js'

app.setName('Openclod Desktop')
app.setAppUserModelId('com.openclod.desktop')

/**
 * The app was previously branded Forja. Move the old profile (settings,
 * encrypted keys, sessions, project memory) to the new folder once, so a
 * rename never loses the user's work. A running old instance can lock the
 * folder; in that case copy instead of rename and leave the old copy intact.
 */
function migrateLegacyProfile(): void {
  try {
    const appData = app.getPath('appData')
    const legacy = path.join(appData, 'Forja')
    const next = path.join(appData, 'Openclod Desktop')
    if (fs.existsSync(next) || !fs.existsSync(legacy)) return
    try {
      fs.renameSync(legacy, next)
    } catch {
      fs.cpSync(legacy, next, { recursive: true })
    }
  } catch {
    /* startup must continue even if the old profile cannot be moved */
  }
}
migrateLegacyProfile()

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let orchestrator: Orchestrator | null = null
const terminals = new TerminalManager((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.terminalEvent, event)
})
// Lets the agent's run_in_terminal run commands in the session's VISIBLE terminal (opening one if needed).
const terminalRunner: TerminalRunner = {
  run: ({ sessionId, command, cwd, shell, timeoutMs, interrupt }) => {
    const info = terminals.ensureSessionTerminal({ sessionId, cwd, shell })
    return terminals.run(info.id, command, { timeoutMs, interrupt })
  }
}
const stt = new SttService({
  emit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.sttEvent, event)
  },
  log: (scope, message) => log(scope, message)
})
const tts = new TtsService({
  emit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.ttsEvent, event)
  },
  log: (scope, message) => log(scope, message)
})
const computerOverlay = new ComputerOverlay()
const dictation = new DictationController({
  getSettings: () => orchestrator?.settings.get() ?? defaultSettings(),
  sendToRenderer: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  },
  isOpenclodFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  polish: (text) => (orchestrator ? orchestrator.polishText(text) : Promise.resolve(text)),
  log: (scope, message) => log(scope, message)
})
let closing = false
let keepAwakeId: number | null = null
let scheduler: Scheduler | null = null
let activityStore: ActivityStore | null = null
let providerUsageStore: ProviderUsageStore | null = null
let observabilityStore: ObservabilityService | null = null
let improvementService: ImprovementService | null = null
/** Scheduled runs waiting for their turn_end, keyed by session id. */
const scheduledTurns = new Map<string, (stopReason: string) => void>()
/** Partition shared by every browser-pane <webview>; isolated from the app session. */
const PREVIEW_PARTITION = 'persist:forja-preview'
let cleanedUp = false

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

function logFile(): string {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'main.log')
  } catch {
    return path.join(app.getPath('temp'), 'forja-main.log')
  }
}

function log(scope: string, message: unknown): void {
  const line = `${new Date().toISOString()} [${scope}] ${
    message instanceof Error ? `${message.message}\n${message.stack ?? ''}` : String(message)
  }\n`
  try {
    fs.appendFileSync(logFile(), line, 'utf8')
  } catch {
    /* logging must never crash the app */
  }
  const level = scope === 'uncaught' || scope === 'unhandledRejection' ? 'error' : 'info'
  observabilityStore?.recordLog(scope, message, level)
  if (isDev) process.stdout.write(line)
}

process.on('uncaughtException', (err) => log('uncaught', err))
process.on('unhandledRejection', (reason) => log('unhandledRejection', reason))

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

function str(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`campo inválido: ${field}`)
  return value.slice(0, max)
}

/**
 * What the Google Colab button does on the user's computer: show the notebook in Explorer, copy its path, open Colab in the
 * default browser. With OPENCLOD_E2E_OPEN_LOG=<file> (set only by scripts/ui-colab.cjs) it records each of these actions as a
 * JSON line instead, so an automated run never opens the user's browser or changes their clipboard.
 */
function colabHost(): ColabHost {
  const notebookDir = process.env.OPENCLOD_COLAB_DIR || path.join(app.getPath('documents'), 'Openclod', 'Colab')
  const record = process.env.OPENCLOD_E2E_OPEN_LOG
  if (record) {
    const note = (kind: string, target: string): void => {
      fs.appendFileSync(record, `${JSON.stringify({ kind, target })}\n`)
    }
    return { notebookDir, openUrl: (url) => note('url', url), revealFile: (file) => note('reveal', file), copyText: (text) => note('copy', text) }
  }
  return {
    notebookDir,
    openUrl: (url) => shell.openExternal(url),
    revealFile: (file) => shell.showItemInFolder(file),
    copyText: (text) => clipboard.writeText(text)
  }
}

function optStr(value: unknown, field: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`campo inválido: ${field}`)
  return value.slice(0, max)
}

function toImages(value: unknown): ImagePart[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('imagens inválidas')
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp'])
  return value.slice(0, 6).map((item) => {
    const image = item as ImagePart
    if (
      !image ||
      image.type !== 'image' ||
      !allowed.has(image.mediaType) ||
      typeof image.data !== 'string' ||
      image.data.length > 12_000_000
    ) {
      throw new Error('imagem inválida ou grande demais (máx. 6 imagens, ~9 MB cada)')
    }
    return { type: 'image', mediaType: image.mediaType, data: image.data, label: image.label?.slice(0, 80) }
  })
}

/** The bundled snapshot of Anthropic's official Claude plugins marketplace. */
function pluginCatalog(): PluginCatalogEntry[] {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'resources', 'catalog', 'claude-plugins-official.json'),
    path.join(app.getAppPath(), 'resources', 'catalog', 'claude-plugins-official.json'),
    path.join(process.cwd(), 'resources', 'catalog', 'claude-plugins-official.json')
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { plugins?: PluginCatalogEntry[] }
      if (Array.isArray(parsed.plugins)) return parsed.plugins
    } catch {
      /* try the next location */
    }
  }
  return []
}

/** Resolve Windows 8.3 aliases, symlinks and case differences once for path checks. */
function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

/** Filesystem reads from the renderer are limited to registered roots. */
function knownRoot(root: string): string {
  if (!orchestrator) throw new Error('aplicativo ainda inicializando')
  const resolved = canonicalPath(root)
  const policy = orchestrator.settings.get().policy
  const candidates = [
    ...orchestrator.store.listProjects().map((project) => project.path),
    ...(policy.allowedRoots ?? [])
  ]
  const allowed = candidates.some((candidate) => canonicalPath(candidate).toLowerCase() === resolved.toLowerCase())
  if (!allowed) throw new Error('diretório não registrado como projeto')
  return resolved
}

/** Like knownRoot, but also accepts folders inside a registered root (worktrees, subfolders). */
function insideKnownRoot(target: string): string {
  if (!orchestrator) throw new Error('aplicativo ainda inicializando')
  const resolved = canonicalPath(target)
  const policy = orchestrator.settings.get().policy
  const roots = [...orchestrator.store.listProjects().map((project) => project.path), ...(policy.allowedRoots ?? [])]
  const inside = roots.some((root) => {
    const relative = path.relative(canonicalPath(root), resolved)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  })
  if (!inside) throw new Error('caminho fora das raízes permitidas')
  return resolved
}

/**
 * What the Settings form shows for a provider that is being edited (address, kind, model): "Detectar modelos" and "Testar" use
 * it instead of the saved card, so they ask the server the user typed. Anything else in the object is dropped.
 */
function providerDraft(raw: unknown): { baseUrl?: string; kind?: 'openai' | 'anthropic'; model?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as { baseUrl?: unknown; kind?: unknown; model?: unknown }
  const draft: { baseUrl?: string; kind?: 'openai' | 'anthropic'; model?: string } = {}
  if (typeof input.baseUrl === 'string' && /^https?:\/\//i.test(input.baseUrl.trim())) draft.baseUrl = input.baseUrl.trim().slice(0, 500)
  if (input.kind === 'anthropic' || input.kind === 'openai') draft.kind = input.kind
  if (typeof input.model === 'string' && input.model.trim()) draft.model = input.model.trim().slice(0, 200)
  return Object.keys(draft).length ? draft : undefined
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'readonly' || value === 'ask' || value === 'accept-edits' || value === 'auto' || value === 'unrestricted'
}

/**
 * The renderer is the only trusted client, but a compromised renderer must not
 * be able to write arbitrary settings. Only known keys survive.
 */
function sanitizeSettingsPatch(raw: unknown): Partial<AppSettings> {
  if (!raw || typeof raw !== 'object') throw new Error('configurações inválidas')
  const input = raw as Partial<AppSettings>
  const patch: Partial<AppSettings> = {}

  if (Array.isArray(input.providers)) {
    patch.providers = input.providers.slice(0, 40).map((provider) => {
      if (!provider || typeof provider.id !== 'string') throw new Error('provedor inválido')
      const kind = provider.kind === 'anthropic' ? 'anthropic' : 'openai'
      const apiKeyRef = typeof provider.apiKeyRef === 'string' ? provider.apiKeyRef : ''
      if (apiKeyRef && !/^(env|secret):/.test(apiKeyRef)) {
        throw new Error('chaves de API devem ser gravadas pelo cofre do sistema, não em settings.json')
      }
      return {
        id: provider.id.slice(0, 60),
        kind,
        label: String(provider.label ?? provider.id).slice(0, 80),
        baseUrl: String(provider.baseUrl ?? '').slice(0, 500),
        model: String(provider.model ?? '').slice(0, 200),
        apiKeyRef: apiKeyRef.slice(0, 200),
        contextWindow: Math.max(1000, Math.min(4_000_000, Number(provider.contextWindow) || 32_000)),
        supportsVision: Boolean(provider.supportsVision),
        supportsTools: provider.supportsTools !== false,
        // OpenRouter exposes ~300 models; keep the whole catalog so the
        // searchable model menu can show every option.
        models: Array.isArray(provider.models)
          ? provider.models.slice(0, 1000).map((model) => String(model).slice(0, 200)).filter(Boolean)
          : [],
        // Which of those models read images (from "Detectar modelos"); empty means the provider flag decides.
        visionModels: Array.isArray(provider.visionModels)
          ? provider.visionModels.slice(0, 1000).map((model) => String(model).slice(0, 200)).filter(Boolean)
          : undefined,
        inputCostPerMTok: Number(provider.inputCostPerMTok) || undefined,
        outputCostPerMTok: Number(provider.outputCostPerMTok) || undefined,
        cachedInputCostPerMTok: Number(provider.cachedInputCostPerMTok) || undefined,
        temperature: provider.temperature === undefined || provider.temperature === null ? undefined : Number(provider.temperature),
        maxOutputTokens: Number(provider.maxOutputTokens) > 0 ? Math.min(1_000_000, Number(provider.maxOutputTokens)) : undefined,
        compat: sanitizeCompat(provider.compat),
        effortLevels: Array.isArray(provider.effortLevels)
          ? [...new Set(provider.effortLevels.filter((level): level is ReasoningEffort => REASONING_EFFORTS.includes(level)))].slice(0, 5)
          : undefined,
        defaultEffort:
          REASONING_EFFORTS.includes(provider.defaultEffort as ReasoningEffort)
            ? (provider.defaultEffort as ReasoningEffort)
            : undefined
      }
    })
  }

  if (typeof input.defaultProviderId === 'string') patch.defaultProviderId = input.defaultProviderId.slice(0, 60)

  if (input.policy && typeof input.policy === 'object') {
    const policy = input.policy
    patch.policy = {
      mode: isPermissionMode(policy.mode) ? policy.mode : 'auto',
      blockedCommands: Array.isArray(policy.blockedCommands)
        ? policy.blockedCommands.slice(0, 100).map((command) => String(command).slice(0, 200))
        : [],
      allowedRoots: Array.isArray(policy.allowedRoots)
        ? policy.allowedRoots.slice(0, 20).map((root) => path.resolve(String(root)))
        : [],
      allowNetwork: Boolean(policy.allowNetwork),
      allowComputerControl: Boolean(policy.allowComputerControl),
      fullAccess: policy.fullAccess !== false,
      shellTimeoutSec: Math.max(5, Math.min(3600, Number(policy.shellTimeoutSec) || 300))
    }
    if (policy.rules && typeof policy.rules === 'object') {
      const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.slice(0, 300).map((rule) => String(rule).trim().slice(0, 500)).filter(Boolean) : []
      patch.policy.rules = { allow: list(policy.rules.allow), ask: list(policy.rules.ask), deny: list(policy.rules.deny) }
    }
  }

  if (input.hooks !== undefined) patch.hooks = sanitizeHooks(input.hooks)
  if (typeof input.importClaudeSettings === 'boolean') patch.importClaudeSettings = input.importClaudeSettings

  if (input.limits && typeof input.limits === 'object') {
    const limits = input.limits
    patch.limits = {
      maxIterations: Math.max(1, Math.min(400, Number(limits.maxIterations) || 60)),
      maxToolCalls: Math.max(1, Math.min(4000, Number(limits.maxToolCalls) || 400)),
      maxWallClockMs: Math.max(30_000, Math.min(8 * 3600_000, Number(limits.maxWallClockMs) || 45 * 60_000)),
      maxTokens: Number.isFinite(Number(limits.maxTokens))
        ? Math.max(0, Math.min(200_000_000, Number(limits.maxTokens)))
        : 0,
      maxCostUsd: Number.isFinite(Number(limits.maxCostUsd))
        ? Math.max(0, Math.min(10_000, Number(limits.maxCostUsd)))
        : 10,
      maxParallelTools: Math.max(1, Math.min(16, Number(limits.maxParallelTools) || 4))
    }
  }

  if (Array.isArray(input.mcpServers)) {
    patch.mcpServers = input.mcpServers.slice(0, MAX_MCP_SERVERS).map((server) => normalizeMcpServerSettings(server))
  }

  if (input.theme === 'light' || input.theme === 'dark') patch.theme = input.theme
  if (typeof input.profileName === 'string') patch.profileName = input.profileName.trim().slice(0, 80)
  if (typeof input.autoAgents === 'boolean') patch.autoAgents = input.autoAgents
  if (typeof input.useAllModels === 'boolean') patch.useAllModels = input.useAllModels
  const providerIds = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.map((item) => String(item).slice(0, 60)).filter(Boolean))].slice(0, 60) : []
  if (Array.isArray(input.fallbackOrder)) patch.fallbackOrder = providerIds(input.fallbackOrder)
  if (Array.isArray(input.fallbackExclude)) patch.fallbackExclude = providerIds(input.fallbackExclude)
  if (input.fallbackModels && typeof input.fallbackModels === 'object' && !Array.isArray(input.fallbackModels)) {
    // The models ticked for each provider. An empty list is kept (it means "none of this provider"); names are trimmed and capped.
    const ticked: Record<string, string[]> = {}
    for (const [id, models] of Object.entries(input.fallbackModels).slice(0, 60)) {
      if (!Array.isArray(models)) continue
      ticked[String(id).slice(0, 60)] = [...new Set(models.map((model) => String(model).trim().slice(0, 200)).filter(Boolean))].slice(0, 1000)
    }
    patch.fallbackModels = ticked
  }
  if (input.visionModel === null) patch.visionModel = undefined
  else if (input.visionModel && typeof input.visionModel === 'object') {
    const providerId = String(input.visionModel.providerId ?? '').slice(0, 60)
    const model = String(input.visionModel.model ?? '').slice(0, 200)
    patch.visionModel = providerId && model ? { providerId, model } : undefined
  }

  if (input.selfRepair && typeof input.selfRepair === 'object') {
    patch.selfRepair = {
      enabled: input.selfRepair.enabled === true,
      repoPath: typeof input.selfRepair.repoPath === 'string' ? input.selfRepair.repoPath.trim().slice(0, 1000) : '',
      restartAfterRepair: input.selfRepair.restartAfterRepair === true
    }
  }

  if (input.notifications && typeof input.notifications === 'object') {
    const value = input.notifications
    const time = (candidate: unknown): string | undefined =>
      typeof candidate === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(candidate.trim()) ? candidate.trim() : undefined
    patch.notifications = {
      desktop: value.desktop !== false,
      turnFinished: value.turnFinished !== false,
      failures: value.failures !== false,
      approvals: value.approvals !== false,
      minimumSeverity:
        value.minimumSeverity === 'info' || value.minimumSeverity === 'warning' || value.minimumSeverity === 'error'
          ? value.minimumSeverity
          : 'success',
      quietStart: time(value.quietStart),
      quietEnd: time(value.quietEnd)
    }
  }

  if (input.updates && typeof input.updates === 'object') {
    patch.updates = {
      feedUrl: typeof input.updates.feedUrl === 'string' ? input.updates.feedUrl.trim().slice(0, 1_000) : '',
      autoCheck: Boolean(input.updates.autoCheck)
    }
  }

  if (input.browser && typeof input.browser === 'object') {
    patch.browser = {
      mode:
        input.browser.mode === 'chrome-existing' || input.browser.mode === 'playwright'
          ? input.browser.mode
          : 'auto',
      groupBySession: input.browser.groupBySession !== false,
      fallbackToManaged: input.browser.fallbackToManaged !== false
    }
  }

  if (Array.isArray(input.environments)) {
    patch.environments = input.environments.slice(0, 12).map((raw, index) => {
      const entry = (raw ?? {}) as unknown as Record<string, unknown>
      const kind = ['local', 'wsl', 'ssh', 'cloud'].includes(String(entry.kind)) ? (entry.kind as 'local' | 'wsl' | 'ssh' | 'cloud') : 'local'
      return {
        id: String(entry.id || `env-${index}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40),
        label: String(entry.label || entry.id || `Ambiente ${index + 1}`).slice(0, 60),
        kind,
        command: typeof entry.command === 'string' ? entry.command.trim().slice(0, 500) : undefined,
        remoteCwd: typeof entry.remoteCwd === 'string' ? entry.remoteCwd.trim().slice(0, 500) : undefined,
        distro: typeof entry.distro === 'string' ? entry.distro.trim().slice(0, 80) : undefined
      }
    })
  }

  if (input.voice && typeof input.voice === 'object') {
    const model = String(input.voice.model ?? 'base')
    const language = String(input.voice.language ?? 'pt')
    const shortcut = typeof input.voice.shortcut === 'string' ? input.voice.shortcut.trim().slice(0, 40) : ''
    const ttsRate = Number(input.voice.ttsRate)
    const ttsVolume = Number(input.voice.ttsVolume)
    patch.voice = {
      model: /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(model) ? model : 'base',
      language: /^([a-z]{2,3}|auto)$/.test(language) ? language : 'pt',
      shortcut: shortcut && /^[A-Za-z0-9+ ]{3,40}$/.test(shortcut) ? shortcut : '',
      overlay: Boolean(input.voice.overlay),
      mode: input.voice.mode === 'hold' ? 'hold' : 'toggle',
      polish: Boolean(input.voice.polish),
      insert: input.voice.insert === 'composer' ? 'composer' : 'focused',
      ttsProvider: input.voice.ttsProvider === 'windows' ? 'windows' : 'edge',
      ttsVoice: typeof input.voice.ttsVoice === 'string' ? input.voice.ttsVoice.trim().slice(0, 200) : '',
      ttsRate: Math.max(-10, Math.min(10, Math.round(Number.isFinite(ttsRate) ? ttsRate : 0))),
      ttsVolume: Math.max(0, Math.min(100, Math.round(Number.isFinite(ttsVolume) ? ttsVolume : 100)))
    }
  }
  return patch
}

function sanitizeCompat(raw: unknown): ModelCompat | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as ModelCompat
  const out: ModelCompat = {}
  if (typeof input.omitTemperature === 'boolean') out.omitTemperature = input.omitTemperature
  if (input.maxTokensField === 'max_tokens' || input.maxTokensField === 'max_completion_tokens') out.maxTokensField = input.maxTokensField
  if (typeof input.echoReasoning === 'boolean') out.echoReasoning = input.echoReasoning
  if (typeof input.promptCaching === 'boolean') out.promptCaching = input.promptCaching
  if (typeof input.reasoningEffort === 'boolean') out.reasoningEffort = input.reasoningEffort
  return Object.keys(out).length ? out : undefined
}

/** Hooks run commands, so only the documented shape survives. */
function sanitizeHooks(raw: unknown): HooksConfig {
  if (!raw || typeof raw !== 'object') return {}
  const out: HooksConfig = {}
  for (const event of HOOK_EVENTS) {
    const matchers = (raw as Record<string, unknown>)[event]
    if (!Array.isArray(matchers)) continue
    out[event] = matchers.slice(0, 50).map((entry) => {
      const matcher = entry as { matcher?: unknown; hooks?: unknown }
      return {
        matcher: typeof matcher.matcher === 'string' ? matcher.matcher.slice(0, 300) : undefined,
        hooks: (Array.isArray(matcher.hooks) ? matcher.hooks : []).slice(0, 20).flatMap((hook) => {
          const definition = normalizeHookDefinition(hook)
          return definition ? [definition] : []
        })
      }
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* IPC plumbing                                                        */
/* ------------------------------------------------------------------ */

function trustedSender(event: { sender: { id: number } }): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<T> = (...args: any[]) => Promise<T> | T

function handle(channel: string, fn: Handler<unknown>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) {
      log('ipc', `origem não autorizada em ${channel}`)
      return { ok: false, error: 'origem não autorizada' }
    }
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('ipc', `${channel}: ${message}`)
      return { ok: false, error: message }
    }
  })
}

/**
 * First run of the usage store: attribute each existing session's cumulative
 * usage to its current provider. Approximate for sessions that switched
 * providers mid-way, but far better than starting every counter at zero.
 */
function seedProviderUsage(): void {
  if (!providerUsageStore || providerUsageStore.list().length) return
  const dir = path.join(app.getPath('userData'), 'data', 'sessions')
  const totals = new Map<string, ProviderUsageInfo>()
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))
  } catch {
    return
  }
  for (const entry of entries) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')) as {
        meta?: { providerId?: string; model?: string }
        usage?: { input?: number; output?: number; cachedInput?: number; costUsd?: number }
        messages?: Array<{ usage?: unknown }>
      }
      const providerId = state.meta?.providerId
      const usage = state.usage
      if (!providerId || !usage) continue
      const input = Math.max(0, Number(usage.input) || 0)
      const output = Math.max(0, Number(usage.output) || 0)
      if (!input && !output) continue
      const current = totals.get(providerId) ?? {
        providerId,
        label: providerId,
        input: 0,
        output: 0,
        cachedInput: 0,
        costUsd: 0,
        calls: 0,
        lastModel: state.meta?.model,
        updatedAt: Date.now()
      }
      current.input += input
      current.output += output
      current.cachedInput += Math.max(0, Number(usage.cachedInput) || 0)
      current.costUsd += Math.max(0, Number(usage.costUsd) || 0)
      current.calls += (state.messages ?? []).filter((message) => message.usage).length
      current.lastModel = state.meta?.model || current.lastModel
      current.updatedAt = Date.now()
      totals.set(providerId, current)
    } catch {
      /* skip corrupt session file */
    }
  }
  if (totals.size) providerUsageStore.seed([...totals.values()])
}

let selfRepairActive: string | null = null
const selfRepairSeen = new Map<string, number>()

/** Extracts a limitation report from the auto card or a successful report_limitation tool. */
function limitationFromEvent(
  event: HarnessEvent
): { report: Extract<HarnessEvent, { type: 'limitation' }>['report']; sessionId: string } | null {
  if (event.type === 'limitation') return { report: event.report, sessionId: event.sessionId }
  if (event.type === 'tool_end' && event.name === 'report_limitation' && event.ok) {
    const raw = event.data?.limitation
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    if (typeof value.title !== 'string' || typeof value.error !== 'string') return null
    return {
      report: {
        title: value.title,
        goal: typeof value.goal === 'string' ? value.goal : '',
        error: value.error,
        difficulty: typeof value.difficulty === 'string' ? value.difficulty : '',
        suggestion: typeof value.suggestion === 'string' ? value.suggestion : '',
        workaround: typeof value.workaround === 'string' ? value.workaround : undefined,
        severity: value.severity === 'degraded' ? 'degraded' : 'blocked'
      },
      sessionId: event.sessionId
    }
  }
  return null
}

function insidePath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Opt-in self-evolution: a real harness limitation opens a separate session in
 * the harness source checkout. That session fixes the code and runs
 * scripts/self-build.mjs; this process only restarts after HARNESS_OK.
 */
async function maybeStartSelfRepair(
  report: Extract<HarnessEvent, { type: 'limitation' }>['report'],
  sessionId: string
): Promise<void> {
  const harness = orchestrator
  if (!harness) return
  const config = harness.settings.get().selfRepair
  if (!config?.enabled || !config.repoPath) return
  if (selfRepairActive) return
  const repo = path.resolve(config.repoPath)
  if (!fs.existsSync(path.join(repo, 'package.json'))) {
    log('self-repair', `repositório inválido: ${repo}`)
    return
  }
  const source = harness.store.getSession(sessionId)
  if (source && insidePath(repo, source.meta.cwd)) return
  const key = `${report.title}|${report.error}`.slice(0, 500)
  const now = Date.now()
  if ((selfRepairSeen.get(key) ?? 0) > now - 10 * 60_000) return
  selfRepairSeen.set(key, now)

  try {
    const project = await harness.addProject(repo, 'Openclod Harness')
    const settings = harness.settings.get()
    const preferredId = source?.meta.providerId ?? settings.lastModel?.providerId ?? settings.defaultProviderId
    const providerConfig =
      (preferredId ? harness.settings.providerConfig(preferredId) : undefined) ??
      harness.settings.providerConfig(settings.defaultProviderId)
    if (!providerConfig) {
      log('self-repair', 'nenhum provedor configurado')
      return
    }
    const model =
      providerConfig.id === source?.meta.providerId && source?.meta.model
        ? source.meta.model
        : providerConfig.model
    const meta = await harness.createSession({
      projectId: project.id,
      cwd: repo,
      mode: 'code',
      surface: 'code',
      providerId: providerConfig.id,
      model,
      title: `Auto-correção: ${report.title}`.slice(0, 80)
    })
    if (providerConfig.defaultEffort) await harness.setEffort(meta.id, providerConfig.defaultEffort)
    selfRepairActive = meta.id
    const prompt = [
      'Você é o engenheiro responsável pelo próprio harness Openclod Desktop.',
      'O harness detectou uma limitação real enquanto trabalhava para o usuário.',
      '',
      '## Limitação',
      `Título: ${report.title}`,
      `Objetivo: ${report.goal}`,
      `Erro observado: ${report.error}`,
      `Dificuldade: ${report.difficulty}`,
      `Solução sugerida: ${report.suggestion}`,
      report.workaround ? `Contorno: ${report.workaround}` : '',
      '',
      `Repositório do harness: ${repo}`,
      '',
      '## Tarefa',
      '1. Investigue a causa raiz no código do Openclod, não no projeto do usuário.',
      '2. Implemente a correção mínima e segura, com contrato/erro claro.',
      '3. Rode `npm run typecheck` e os testes relevantes; corrija o que falhar.',
      '4. Não rode build nem self-build: o harness compila depois que o usuário autorizar o reinício.',
      '5. Termine com um resumo curto do que foi corrigido e dos arquivos alterados, seguido de uma linha exata: HARNESS_OK',
      'Se não conseguir, explique o bloqueio e marque o passo como blocked. Não reinicie o app manualmente.'
    ].filter(Boolean).join('\n')
    void harness.startSend(meta.id, prompt).catch((err) => log('self-repair', err))
    log('self-repair', `sessão ${meta.id} iniciada para: ${report.title}`)
    if (Notification.isSupported()) {
      new Notification({
        title: 'Openclod — auto-correção iniciada',
        body: `${report.title} — a sessão de engenharia está trabalhando no harness.`,
        icon: resolveIcon()
      }).show()
    }
  } catch (err) {
    log('self-repair', err)
  }
}

interface PendingSelfRepair {
  version: 1
  repoPath: string
  sessionId: string
  summary: string
  files: string[]
  requestedAt: number
}

function pendingSelfRepairFile(): string {
  return path.join(app.getPath('userData'), 'data', 'self-repair-pending.json')
}

function readPendingSelfRepair(): PendingSelfRepair | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingSelfRepairFile(), 'utf8')) as PendingSelfRepair
    return parsed?.version === 1 && parsed.repoPath ? parsed : null
  } catch {
    return null
  }
}

function writePendingSelfRepair(pending: PendingSelfRepair): void {
  const file = pendingSelfRepairFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(pending, null, 2), 'utf8')
}

function clearPendingSelfRepair(): void {
  try {
    fs.unlinkSync(pendingSelfRepairFile())
  } catch {
    /* already gone */
  }
}

/** Builds in a fresh staging folder; the running app.asar is never overwritten. */
function runSelfBuild(repoPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = path.join(repoPath, 'scripts', 'self-build.mjs')
    if (!fs.existsSync(script)) {
      reject(new Error(`script de build não encontrado: ${script}`))
      return
    }
    const child = spawn(process.execPath, [script], {
      cwd: repoPath,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-40_000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', reject)
    child.on('exit', (code) => {
      const match = /SELF_BUILD_STAGING=(.+)/.exec(output)
      if (code === 0 && match) {
        resolve(match[1].trim())
        return
      }
      reject(new Error(`self-build falhou (exit ${code ?? '?'})\n${output.slice(-4_000)}`))
    })
  })
}

function relaunchFromStaging(staging: string): void {
  const executable = path.join(staging, 'Openclod Desktop.exe')
  if (!fs.existsSync(executable)) {
    dialog.showErrorBox('Openclod — atualização', `Executável do staging não encontrado:\n${executable}`)
    return
  }
  void cleanup().finally(() => {
    app.relaunch({ execPath: executable, args: process.argv.slice(1) })
    app.exit(0)
  })
}

async function compileAndRestartSelfRepair(repoPath: string, summary: string, files: string[]): Promise<void> {
  try {
    mainWindow?.setProgressBar(2, { mode: 'indeterminate' })
    if (Notification.isSupported()) {
      new Notification({
        title: 'Openclod — compilando atualização',
        body: 'O harness está compilando; o app reinicia quando terminar.',
        icon: resolveIcon()
      }).show()
    }
    const staging = await runSelfBuild(repoPath)
    clearPendingSelfRepair()
    log('self-repair', `staging pronto: ${staging}`)
    relaunchFromStaging(staging)
  } catch (err) {
    mainWindow?.setProgressBar(-1)
    writePendingSelfRepair({
      version: 1,
      repoPath,
      sessionId: selfRepairActive ?? '',
      summary,
      files,
      requestedAt: Date.now()
    })
    dialog.showErrorBox(
      'Openclod — falha ao compilar a correção',
      `${(err as Error).message}\n\nAs correções ficaram pendentes; o app tentará de novo na próxima abertura.`
    )
    log('self-repair', err)
  }
}

async function finishSelfRepair(sessionId: string, stopReason: string): Promise<void> {
  if (selfRepairActive !== sessionId) return
  selfRepairActive = null
  if (stopReason === 'error') {
    log('self-repair', 'sessão de correção terminou com erro; app mantido aberto')
    return
  }
  const state = orchestrator?.store.getSession(sessionId)
  const text =
    state?.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.parts)
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n') ?? ''
  if (!text.includes('HARNESS_OK')) {
    log('self-repair', 'correção terminou sem HARNESS_OK; app mantido aberto')
    return
  }
  const settings = orchestrator?.settings.get().selfRepair
  const repoPath = settings?.repoPath ?? ''
  const summary = text.replace(/\bHARNESS_OK\b/g, '').trim().slice(0, 2_000) || 'Correção aplicada pelo agente.'
  const files = (state?.changes ?? []).map((change) => change.path).slice(0, 20)
  const detail = [
    'O harness se auto-corrigiu e há atualizações para aplicar.',
    '',
    '## O que foi melhorado',
    summary,
    '',
    files.length ? `## Arquivos alterados\n${files.map((file) => `- ${file}`).join('\n')}` : '',
    '',
    'Para aplicar, o Openclod precisa compilar e reiniciar. Se você escolher “Reiniciar depois”, a compilação e o reinício acontecem na próxima abertura.'
  ].filter(Boolean).join('\n')
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Openclod Desktop — atualizações do harness',
    message: 'O harness tem uma correção pronta para aplicar.',
    detail: detail.slice(0, 20_000),
    buttons: ['Compilar e reiniciar agora', 'Reiniciar depois'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  if (result.response === 0) {
    await compileAndRestartSelfRepair(repoPath, summary, files)
    return
  }
  writePendingSelfRepair({
    version: 1,
    repoPath,
    sessionId,
    summary,
    files,
    requestedAt: Date.now()
  })
  if (Notification.isSupported()) {
    new Notification({
      title: 'Openclod — correções pendentes',
      body: 'A compilação e o reinício serão feitos na próxima abertura do app.',
      icon: resolveIcon()
    }).show()
  }
}

/** On the next start, a deferred self-repair compiles and relaunches automatically. */
async function applyPendingSelfRepair(): Promise<void> {
  const pending = readPendingSelfRepair()
  if (!pending) return
  const settings = orchestrator?.settings.get().selfRepair
  if (!settings?.enabled) return
  if (!settings.restartAfterRepair) {
    log('self-repair', 'há correções pendentes; ative “Aplicar automaticamente” em Configurações → Harness')
    return
  }
  if (Notification.isSupported()) {
    new Notification({
      title: 'Openclod — aplicando correções pendentes',
      body: 'O harness vai compilar e reiniciar para aplicar a atualização.',
      icon: resolveIcon()
    }).show()
  }
  try {
    const staging = await runSelfBuild(pending.repoPath)
    clearPendingSelfRepair()
    relaunchFromStaging(staging)
  } catch (err) {
    log('self-repair', err)
    dialog.showErrorBox(
      'Openclod — correções pendentes',
      `Não foi possível compilar as correções pendentes:\n${(err as Error).message}\n\nElas continuam salvas para a próxima abertura.`
    )
  }
}

function broadcast(event: HarnessEvent): void {
  if (event.type === 'turn_end') scheduledTurns.get(event.sessionId)?.(event.stopReason)
  if (event.type === 'turn_end' && event.sessionId === selfRepairActive) {
    void finishSelfRepair(event.sessionId, event.stopReason)
  }
  const limitation = limitationFromEvent(event)
  if (limitation) void maybeStartSelfRepair(limitation.report, limitation.sessionId)
  // Live command output is UI-only; recording it would evict useful events.
  if (event.type !== 'tool_progress') {
    observabilityStore?.record(event)
    activityStore?.record(event)
  }
  if (event.type === 'usage') providerUsageStore?.record(event)
  const notificationPreferences = orchestrator?.settings.get().notifications
  if (notificationPreferences && Notification.isSupported() && !mainWindow?.isFocused()) {
    const notification = notificationForEvent(event, notificationPreferences)
    if (notification) {
      const nativeNotification = new Notification({
        title: notification.title,
        body: notification.body,
        silent: notification.severity === 'info'
      })
      nativeNotification.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      })
      nativeNotification.show()
    }
  }
  // Orange desktop border + mascot while any agent is using Computer Use.
  computerOverlay.handle(event)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CH.event, event)
  }
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function resolveIcon(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(process.resourcesPath, 'icon.png')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

/**
 * Older builds installed an "Electron.lnk" with the same AppUserModelID as
 * Openclod. Windows optimistically uses that shortcut for the taskbar icon,
 * so the app kept showing the Electron atom even with the right exe icon.
 * Remove only the exact legacy shortcut; never touch unrelated Start Menu
 * entries.
 */
function removeLegacyElectronShortcut(): void {
  if (process.platform !== 'win32') return
  const shortcut = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Electron.lnk'
  )
  if (!fs.existsSync(shortcut)) return
  try {
    const details = shell.readShortcutLink(shortcut)
    if (details.appUserModelId !== 'com.openclod.desktop') return
    const target = details.target.replace(/\//g, '\\').toLowerCase()
    if (!/\\electron\.exe$/.test(target) && !/\\node_modules\\electron\\dist\\electron\.exe$/.test(target)) return
    fs.unlinkSync(shortcut)
    log('shortcut', `atalho legado removido para corrigir o ícone da barra de tarefas: ${shortcut}`)
  } catch (err) {
    log('shortcut', err)
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Tray icon next to the clock while Openclod is running. */
function createTray(): void {
  if (tray) return
  const iconPath = resolveIcon()
  if (!iconPath) return
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return
  try {
    tray = new Tray(image.resize({ width: 32, height: 32 }))
    tray.setToolTip('Openclod Desktop')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Openclod', click: () => showMainWindow() },
        { type: 'separator' },
        { label: 'Sair', click: () => app.quit() }
      ])
    )
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
    log('tray', 'ícone da bandeja criado')
  } catch (err) {
    log('tray', err)
    tray = null
  }
}

/** Custom slash commands visible from a folder: the user's own, then the project's `.claude/commands` and `.forja/commands`. */
function customCommandsFor(cwd: string): ReturnType<typeof loadCustomCommands> {
  return loadCustomCommands([
    { dir: path.join(app.getPath('userData'), 'commands'), source: 'usuario' },
    { dir: path.join(cwd, '.claude', 'commands'), source: 'projeto' },
    { dir: path.join(cwd, '.forja', 'commands'), source: 'projeto' }
  ])
}

let mainLoopWatch: ReturnType<typeof setInterval> | null = null

/**
 * Logs when the main process event loop stalls (a heavy synchronous call, a huge JSON parse...). Every window
 * freeze looks the same from the outside; this separates "the main process was blocked" from "the renderer was".
 */
function startMainLoopWatch(): void {
  if (mainLoopWatch) return
  let last = Date.now()
  mainLoopWatch = setInterval(() => {
    const now = Date.now()
    const stalled = now - last - 1000
    last = now
    if (stalled > 3000) log('main', `o processo principal ficou ${Math.round(stalled / 1000)} s sem responder`)
  }, 1000)
  mainLoopWatch.unref?.()
}

function createWindow(): void {
  const icon = resolveIcon()
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0a0c0f',
    title: 'Openclod Desktop',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Dictation must keep the microphone and audio worklet alive when the
      // window is in the background (the user is typing in another app).
      backgroundThrottling: false,
      devTools: true,
      webviewTag: true
    }
  })

  // The browser pane embeds <webview>; lock every guest down before it attaches.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete (webPreferences as { preload?: string }).preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    const src = params.src ?? ''
    if (params.partition !== PREVIEW_PARTITION || (src && src !== 'about:blank' && !/^https?:\/\//i.test(src))) {
      log('webview', `bloqueado: partição ${params.partition ?? '-'} src ${src.slice(0, 120)}`)
      event.preventDefault()
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // http is allowed so the browser pane can hand localhost previews to the default browser.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    const sameDocument = current && url.split('#')[0] === current.split('#')[0]
    if (!sameDocument) {
      event.preventDefault()
      if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') mainWindow?.webContents.toggleDevTools()
    if (input.control && input.shift && input.key.toLowerCase() === 'i') mainWindow?.webContents.toggleDevTools()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer', `processo finalizado: ${details.reason} (${details.exitCode})`)
  })

  // A frozen window used to leave nothing in the log. These lines say WHEN it stopped answering and for how long,
  // and (below) whether the main process itself was the one blocked.
  let unresponsiveSince = 0
  mainWindow.webContents.on('unresponsive', () => {
    unresponsiveSince = Date.now()
    log('renderer', 'a interface parou de responder')
  })
  mainWindow.webContents.on('responsive', () => {
    log('renderer', `a interface voltou a responder${unresponsiveSince ? ` após ${Math.round((Date.now() - unresponsiveSince) / 1000)} s` : ''}`)
    unresponsiveSince = 0
  })
  startMainLoopWatch()

  mainWindow.on('maximize', () => mainWindow?.webContents.send('forja:window-state', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('forja:window-state', false))

  mainWindow.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    closing = true
    // Disappear at once: the shutdown behind it (MCP servers, sidecars) can take a few seconds and must not look
    // like a frozen window. It gets a deadline, and the process leaves even if something refuses to stop.
    mainWindow?.hide()
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 8_000))
    void Promise.race([cleanup(), deadline]).finally(() => {
      mainWindow?.destroy()
      setTimeout(() => app.exit(0), 3_000).unref()
    })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  terminals.killAll()
  stt.dispose()
  tts.dispose()
  dictation.dispose()
  computerOverlay.dispose()
  scheduler?.stop()
  if (keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId)
  try {
    await orchestrator?.flushAll()
  } catch (err) {
    log('cleanup', err)
  }
  try {
    await orchestrator?.shutdown()
  } catch (err) {
    log('cleanup', err)
  }
  try {
    await activityStore?.flush()
  } catch (err) {
    log('cleanup.activity', err)
  }
  try {
    await providerUsageStore?.flush()
  } catch (err) {
    log('cleanup.providerUsage', err)
  }
  try {
    await observabilityStore?.flush()
  } catch (err) {
    log('cleanup.observability', err)
  }
}

/* ------------------------------------------------------------------ */
/* Scheduled tasks                                                     */
/* ------------------------------------------------------------------ */

/**
 * Runs one scheduled task: a new session in the task's project (Cowork or Code,
 * as the task says) with the task prompt. Resolves only when the turn ends, so
 * the scheduler never runs the same task twice at once.
 */
async function runScheduledTask(task: ScheduledTask): Promise<{ sessionId?: string }> {
  if (!orchestrator) throw new Error('aplicativo ainda inicializando')
  if (task.action === 'improvement-review') {
    // Built-in job: no session, no tools. It reads logs and writes one memory page plus an Activity note.
    if (!improvementService) throw new Error('revisão de melhorias indisponível')
    const result = await improvementService.begin(task.projectId, { useAi: task.actionOptions?.useAi, days: task.actionOptions?.days }, 'schedule').done
    if (result.state === 'error') throw new Error(result.error ?? 'a revisão de melhorias falhou')
    if (result.state === 'cancelled') throw new Error('a revisão de melhorias foi cancelada')
    return {}
  }
  const settings = orchestrator.settings
  const project = orchestrator.store.listProjects().find((item) => item.id === task.projectId)
  if (!project) throw new Error('o projeto desta tarefa não está mais registrado')
  const provider =
    (task.providerId ? settings.providerConfig(task.providerId) : undefined) ?? settings.providerConfig(settings.get().defaultProviderId)
  if (!provider) throw new Error('nenhum provedor configurado')
  const { surface, mode } = scheduledSession(task)
  const meta = await orchestrator.createSession({
    projectId: project.id,
    cwd: project.path,
    mode,
    surface,
    providerId: provider.id,
    model: (task.model || provider.model).trim(),
    title: `Agendada: ${task.name}`.slice(0, 120)
  })
  broadcast({ type: 'session_start', sessionId: meta.id })
  const finished = new Promise<string>((resolve) => scheduledTurns.set(meta.id, resolve))
  try {
    await orchestrator.send(meta.id, task.prompt, undefined, true)
    const stopReason = await Promise.race([finished, new Promise<string>((resolve) => setTimeout(() => resolve('unknown'), 2000))])
    if (stopReason === 'error') throw new Error('o turno terminou com erro; abra a sessão para ver o motivo')
  } finally {
    scheduledTurns.delete(meta.id)
  }
  if (Notification.isSupported()) {
    new Notification({ title: 'Openclod Desktop - tarefa agendada concluída', body: task.name, silent: true }).show()
  }
  return { sessionId: meta.id }
}

function toTaskInput(raw: unknown, partial: boolean): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new Error('tarefa inválida')
  const input = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (input.name !== undefined || !partial) out.name = str(input.name, 'nome', 120)
  if (input.prompt !== undefined || !partial) out.prompt = str(input.prompt, 'instrução', 20_000)
  if (input.projectId !== undefined || !partial) {
    const projectId = str(input.projectId, 'projeto', 80)
    const project = orchestrator?.store.listProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('projeto não encontrado')
    out.projectId = project.id
    out.cwd = project.path
  }
  if (input.schedule !== undefined || !partial) out.schedule = input.schedule
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled)
  if (input.mode !== undefined) out.mode = AGENT_MODES.includes(input.mode as never) ? input.mode : 'code'
  if (input.surface !== undefined) out.surface = input.surface === 'cowork' ? 'cowork' : 'code'
  if (input.providerId !== undefined) out.providerId = optStr(input.providerId, 'providerId', 60) || undefined
  if (input.model !== undefined) out.model = optStr(input.model, 'model', 200) || undefined
  if (input.priority !== undefined) out.priority = input.priority === 'high' || input.priority === 'low' ? input.priority : 'normal'
  if (input.maxRetries !== undefined) out.maxRetries = Math.max(0, Math.min(5, Math.round(Number(input.maxRetries) || 0)))
  if (input.retryDelayMs !== undefined) out.retryDelayMs = Math.max(0, Math.min(300_000, Math.round(Number(input.retryDelayMs) || 0)))
  if (input.action !== undefined) out.action = input.action === 'improvement-review' ? input.action : undefined
  if (input.actionOptions !== undefined) {
    const options = input.actionOptions && typeof input.actionOptions === 'object' ? (input.actionOptions as Record<string, unknown>) : {}
    out.actionOptions = {
      ...(typeof options.useAi === 'boolean' ? { useAi: options.useAi } : {}),
      ...(typeof options.days === 'number' && Number.isInteger(options.days) ? { days: options.days } : {})
    }
  }
  return out
}

function needScheduler(): Scheduler {
  if (!scheduler) throw new Error('agendador indisponível')
  return scheduler
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                        */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  const need = (): Orchestrator => {
    if (!orchestrator) throw new Error('aplicativo ainda inicializando')
    return orchestrator
  }

  handle(CH.appCapabilities, async () => need().capabilities())
  handle(CH.appProviderUsage, async () => providerUsageStore?.list() ?? [])
  handle(CH.appVersions, async (): Promise<AppVersions> => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  }))

  handle(CH.appBackupExport, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const options = {
      title: 'Exportar backup do Openclod',
      defaultPath: path.join(app.getPath('documents'), `openclod-backup-${stamp}.openclod-backup.json.gz`),
      filters: [{ name: 'Backup do Openclod', extensions: ['gz'] }]
    }
    const chosen = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return null
    const service = new BackupService(app.getPath('userData'), app.getVersion())
    return { path: chosen.filePath, stats: await service.create(chosen.filePath) }
  })

  handle(CH.appBackupInspect, async () => {
    const options = {
      title: 'Inspecionar backup do Openclod',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Backup do Openclod', extensions: ['gz'] }]
    }
    const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const file = chosen.filePaths[0]
    const service = new BackupService(app.getPath('userData'), app.getVersion())
    return { path: file, stats: await service.inspect(file) }
  })

  handle(CH.appBackupRestore, async () => {
    const options = {
      title: 'Restaurar backup do Openclod',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Backup do Openclod', extensions: ['gz'] }]
    }
    const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const file = chosen.filePaths[0]
    const service = new BackupService(app.getPath('userData'), app.getVersion())
    const stats = await service.inspect(file)
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Restaurar backup',
          message: `Restaurar ${stats.files} arquivo(s) deste backup?`,
          detail: `Criado em ${new Date(stats.createdAt).toLocaleString('pt-BR')}.\nUm pré-backup do estado atual será criado antes da restauração.`,
          buttons: ['Restaurar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
      : await dialog.showMessageBox({
          type: 'warning',
          title: 'Restaurar backup',
          message: `Restaurar ${stats.files} arquivo(s) deste backup?`,
          detail: 'Um pré-backup do estado atual será criado antes da restauração.',
          buttons: ['Restaurar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
    if (confirmation.response !== 0) return null
    const restored = await service.restore(file)
    await need().settings.init()
    need().settingsChanged()
    await need().restartMcp()
    return {
      path: file,
      stats: restored.stats,
      preRestore: restored.preRestore,
      restoredFiles: restored.files,
      restartRecommended: true
    }
  })

  handle(CH.appObservability, async (raw) => {
    if (!observabilityStore) throw new Error('observabilidade ainda inicializando')
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const capabilities = await need().capabilities()
    const health: import('../shared/api.js').HealthComponentInfo[] = [
      { id: 'core', label: 'Núcleo do agente', status: orchestrator ? 'ok' : 'error', detail: orchestrator ? 'Orchestrator inicializado.' : 'Orchestrator indisponível.' },
      ...(() => {
        const probe = path.join(app.getPath('userData'), `.diagnostic-write-${process.pid}`)
        try {
          fs.writeFileSync(probe, 'ok', 'utf8')
          fs.rmSync(probe, { force: true })
          return [{ id: 'storage', label: 'Armazenamento', status: 'ok' as const, detail: 'Diretório de dados gravável.' }]
        } catch (error) {
          return [{ id: 'storage', label: 'Armazenamento', status: 'error' as const, detail: `Falha de escrita: ${(error as Error).message}` }]
        }
      })(),
      { id: 'browser', label: 'Navegador', status: capabilities.browser.available ? 'ok' : 'warn', detail: capabilities.browser.detail },
      { id: 'computer', label: 'Computer Use', status: capabilities.computer.available ? 'ok' : 'warn', detail: capabilities.computer.detail },
      {
        id: 'mcp',
        label: 'Servidores MCP',
        status: capabilities.mcp.some((server) => server.state === 'error') ? 'warn' : 'ok',
        detail: capabilities.mcp.length ? capabilities.mcp.map((server) => `${server.name}: ${server.state}`).join(' · ') : 'Nenhum servidor conectado.'
      },
      {
        id: 'providers',
        label: 'Provedores',
        status: capabilities.providers.some((provider) => provider.configured) ? 'ok' : 'warn',
        detail: `${capabilities.providers.filter((provider) => provider.configured).length}/${capabilities.providers.length} configurado(s).`
      }
    ]
    return observabilityStore.view(health, {
      query: typeof input.query === 'string' ? input.query.slice(0, 200) : undefined,
      level: typeof input.level === 'string' ? input.level.slice(0, 20) : undefined,
      type: typeof input.type === 'string' ? input.type.slice(0, 60) : undefined,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId.slice(0, 80) : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined
    })
  })

  handle(CH.appDiagnosticsExport, async () => {
    if (!observabilityStore) throw new Error('observabilidade ainda inicializando')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const options = {
      title: 'Exportar diagnóstico do Openclod',
      defaultPath: path.join(app.getPath('documents'), `openclod-diagnostics-${stamp}.json.gz`),
      filters: [{ name: 'Diagnóstico do Openclod', extensions: ['gz'] }]
    }
    const chosen = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return null
    await observabilityStore.flush()
    const settings = need().settings.get()
    let logExcerpt = ''
    try {
      const raw = await fs.promises.readFile(logFile(), 'utf8')
      logExcerpt = raw.slice(-200_000)
    } catch {
      logExcerpt = ''
    }
    const info = await observabilityStore.exportDiagnostic(chosen.filePath, {
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`
      },
      settings: {
        theme: settings.theme,
        profileName: settings.profileName,
        defaultProviderId: settings.defaultProviderId,
        permissionMode: settings.policy.mode,
        providerIds: settings.providers.map((provider) => provider.id),
        mcpServerCount: settings.mcpServers?.length ?? 0,
        environmentKinds: (settings.environments ?? []).map((environment) => environment.kind)
      },
      capabilities: await need().capabilities(),
      mainLogTail: logExcerpt
    })
    log('diagnostics', `pacote exportado: ${info.bytes} bytes, sha256 ${info.sha256}`)
    return info
  })

  handle(CH.appConfigExport, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const options = {
      title: 'Exportar configuração segura',
      defaultPath: path.join(app.getPath('documents'), `openclod-config-${stamp}.json`),
      filters: [{ name: 'Configuração do Openclod', extensions: ['json'] }]
    }
    const chosen = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return null
    return new ConfigTransferService().create(chosen.filePath, need().settings.get())
  })

  handle(CH.appConfigImport, async () => {
    const options = {
      title: 'Importar configuração validada',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Configuração do Openclod', extensions: ['json'] }]
    }
    const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const service = new ConfigTransferService()
    const inspected = await service.inspect(chosen.filePaths[0])
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Importar configuração',
          message: 'Aplicar a configuração selecionada?',
          detail: 'Provedores, permissões, ambientes, MCP, hooks e preferências serão atualizados. Segredos locais não são importados nem apagados.',
          buttons: ['Aplicar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
      : await dialog.showMessageBox({
          type: 'warning',
          title: 'Importar configuração',
          message: 'Aplicar a configuração selecionada?',
          buttons: ['Aplicar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
    if (confirmation.response !== 0) return null
    const current = need().settings.get()
    const importedServers = Array.isArray(inspected.settings.mcpServers) ? inspected.settings.mcpServers : []
    const sensitive = service.mergeSensitiveMcp(current.mcpServers ?? [], importedServers)
    const rawPatch = { ...inspected.settings, mcpServers: sensitive.servers }
    const patch = sanitizeSettingsPatch(rawPatch)
    const next = await need().settings.update(patch)
    need().settingsChanged()
    if (patch.mcpServers) await need().restartMcp()
    if (patch.voice) dictation.register(next.voice?.shortcut ?? '')
    const warnings = [...inspected.warnings]
    if (sensitive.mergedFields) warnings.push(`${sensitive.mergedFields} valor(es) sensível(is) preservado(s) de servidores MCP locais`)
    log('config', `importados ${patch.providers?.length ?? 0} provedores e ${patch.mcpServers?.length ?? 0} servidores MCP`)
    return {
      path: inspected.path,
      createdAt: inspected.createdAt,
      providers: patch.providers?.length ?? 0,
      environments: patch.environments?.length ?? 0,
      mcpServers: patch.mcpServers?.length ?? 0,
      mergedSensitiveFields: sensitive.mergedFields,
      warnings
    }
  })

  handle(CH.appUpdateCheck, async () => {
    const feed = need().settings.get().updates?.feedUrl || process.env.OPENCLOD_UPDATE_MANIFEST_URL
    const result = await checkForUpdate(app.getVersion(), feed)
    log('updates', result.detail)
    return result
  })

  handle(CH.appUpdateDownload, async () => {
    const feed = need().settings.get().updates?.feedUrl || process.env.OPENCLOD_UPDATE_MANIFEST_URL
    const result = await checkForUpdate(app.getVersion(), feed)
    if (!result.available || !result.asset) throw new Error(result.detail)
    const filename = path.basename(new URL(result.asset.url).pathname) || `Openclod-${result.latestVersion}.exe`
    const options = {
      title: 'Baixar atualização verificada',
      defaultPath: path.join(app.getPath('downloads'), filename)
    }
    const chosen = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return null
    const downloaded = await downloadUpdate(result.asset, chosen.filePath)
    log('updates', `pacote ${result.latestVersion} baixado e verificado: ${downloaded.sha256}`)
    return downloaded
  })

  handle(CH.appPresets, async (): Promise<ProviderPresetInfo[]> =>
    Object.entries(PROVIDER_PRESETS).map(([key, preset]) => ({ key, ...preset }))
  )
  handle(CH.appSettings, async () => need().settings.get())
  handle(CH.appUpdateSettings, async (raw) => {
    const patch = sanitizeSettingsPatch(raw)
    const next = await need().settings.update(patch)
    // The provider list was saved (a key, a model, a new provider): forget which ones were known to be down, so the
    // next request asks them again instead of trusting an old failure.
    if (patch.providers) need().reserve.health.clear()
    // Browser target changes must reconstruct idle runners, otherwise they
    // would keep the BrowserLayer created under the previous mode.
    need().settingsChanged()
    if (patch.mcpServers) await need().restartMcp()
    if (patch.voice) dictation.register(next.voice?.shortcut ?? '')
    return next
  })
  handle(CH.appSetSecret, async (providerId, value) => {
    const orchestratorRef = need()
    const id = str(providerId, 'providerId', 60)
    if (!orchestratorRef.settings.providerConfig(id)) throw new Error('provedor não encontrado')
    await orchestratorRef.settings.setSecret(id, str(value, 'chave', 4000))
    // A new key may be the recharge: what was learned about this provider no longer holds.
    orchestratorRef.reserve.health.clear(id)
    orchestratorRef.settingsChanged()
    return true
  })
  handle(CH.appClearSecret, async (providerId) => {
    const orchestratorRef = need()
    await orchestratorRef.settings.clearSecret(str(providerId, 'providerId', 60))
    orchestratorRef.reserve.health.clear(str(providerId, 'providerId', 60))
    orchestratorRef.settingsChanged()
    return true
  })
  handle(CH.appTestProvider, async (providerId, draft) => need().testProvider(str(providerId, 'providerId', 60), providerDraft(draft)))
  handle(CH.appSkills, async () =>
    need().skills.list().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source
    }))
  )
  handle(CH.appDiscoverModels, async (providerId, draft) => need().discoverModels(str(providerId, 'providerId', 60), providerDraft(draft)))
  // Google Colab (GPU). The pasted code holds the access key: it is only passed along, never logged.
  handle(CH.colabPrepare, async () => need().colab.prepare())
  handle(CH.colabInspect, async (code) => need().colab.inspect(str(code, 'code', 8192)))
  handle(CH.colabConnect, async (code) => need().colab.connect(str(code, 'code', 8192)))
  handle(CH.colabStatus, async (fresh) => need().colab.status({ fresh: fresh === true }))
  handle(CH.colabDisconnect, async () => need().colab.disconnect())
  handle(CH.colabReveal, async () => need().colab.revealNotebook())
  // The card shows the notebook as a file the user drags into Colab's upload area. Electron only starts a native drag while the
  // page's `dragstart` is running, so this is a plain `send` (no reply). The file is the one `prepare` wrote: the page never names a path.
  ipcMain.on(CH.colabDragStart, (event) => {
    try {
      const file = need().colab.notebookFile()
      if (!file) return
      const record = process.env.OPENCLOD_E2E_OPEN_LOG
      if (record) {
        fs.appendFileSync(record, `${JSON.stringify({ kind: 'drag', target: file })}\n`)
        return
      }
      const iconPath = resolveIcon()
      const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
      event.sender.startDrag({ file, icon: image.isEmpty() ? image : image.resize({ width: 64, height: 64 }) })
    } catch (err) {
      log('colab', err)
    }
  })
  handle(CH.appRememberModel, async (providerId, model) => {
    const id = str(providerId, 'providerId', 60)
    const value = str(model, 'model', 200)
    await need().settings.update({ lastModel: { providerId: id, model: value } })
    return true
  })
  handle(CH.appMcpPresets, async () => need().mcpPresets())
  handle(CH.appMcpCatalog, async () => need().mcpCatalog())
  handle(CH.appPluginCatalog, async () => pluginCatalog())
  handle(CH.appPlugins, async () => need().plugins.list())
  handle(CH.appPluginDiagnostics, async () => need().plugins.diagnostics())
  handle(CH.appPluginInstallLocal, async () => {
    const options = {
      title: 'Instalar plugin local',
      properties: ['openDirectory'] as Array<'openDirectory'>
    }
    const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return null
    const plugin = await need().installPlugin(chosen.filePaths[0])
    log('plugins', `plugin instalado: ${plugin.id} ${plugin.version}`)
    return plugin
  })
  handle(CH.appPluginSetEnabled, async (pluginId, enabled) => {
    const plugin = await need().setPluginEnabled(str(pluginId, 'pluginId', 64), Boolean(enabled))
    log('plugins', `plugin ${plugin.id}: ${plugin.enabled ? 'ativado' : 'desativado'}`)
    return plugin
  })
  handle(CH.appPluginRemove, async (pluginId) => need().removePlugin(str(pluginId, 'pluginId', 64)))
  handle(CH.appAgents, async (cwd) => need().listAgents(cwd ? str(cwd, 'cwd', 1000) : undefined))
  handle(CH.appImportClaude, async () => need().importClaudeCatalog())
  handle(CH.appClaudeStatus, async () => {
    const raw = await new Promise<string>((resolve) => {
      execFile('cmd.exe', ['/d', '/s', '/c', 'claude auth status --json'], { timeout: 20_000, windowsHide: true }, (_error, stdout) =>
        resolve(String(stdout ?? ''))
      )
    })
    const text = raw.replace(/\u0000/g, '').trim()
    try {
      const parsed = JSON.parse(text) as { loggedIn?: boolean; authMethod?: string; account?: string }
      return { loggedIn: Boolean(parsed.loggedIn), method: parsed.authMethod, account: parsed.account, raw: text.slice(0, 800) }
    } catch {
      return { loggedIn: false, raw: text.slice(0, 800) }
    }
  })
  handle(CH.appClaudeLogin, async () => {
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', 'cmd.exe', '/k', 'claude auth login'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }).unref()
    return true
  })
  handle(CH.appMcpInstall, async (id, env, headers) =>
    need().installMcp({ id: str(id, 'id', 200), env: env as Record<string, string> | undefined, headers: headers as Record<string, string> | undefined })
  )
  handle(CH.appMcpOAuthStatus, async (serverName) =>
    need().mcpOAuthStatus(serverName ? str(serverName, 'serverName', 80) : undefined)
  )
  handle(CH.appMcpOAuthAuthorize, async (serverName) =>
    need().authorizeMcp(str(serverName, 'serverName', 80))
  )

  /* Conectores: diretório, estados, conectar/desconectar, política por ferramenta (contrato em shared/mcp-connectors.ts). */
  handle(CH.mcpcDirectory, async () => need().connectorDirectory())
  handle(CH.mcpcStates, async () => need().connectorStates())
  handle(CH.mcpcConnect, async (id, input) => {
    const connectorId = str(id, 'id', 120)
    const result = await need().connectConnector(connectorId, connectInputFrom(input))
    log('mcp', `conector ${connectorId}: ${result.dryRun ? `ensaio ${result.dryRun.ok ? 'ok' : 'falhou'}` : result.state.status}${result.authUrl ? ' (login aberto no navegador)' : ''}`)
    return result
  })
  handle(CH.mcpcDisconnect, async (id) => need().disconnectConnector(str(id, 'id', 120)))
  handle(CH.mcpcTools, async (serverName) => need().connectorTools(str(serverName, 'serverName', 80)))
  handle(CH.mcpcSetToolPolicy, async (serverName, tool, policy) => {
    if (policy !== 'allow' && policy !== 'ask' && policy !== 'deny') throw new Error('campo inválido: policy')
    return need().setToolPolicy(str(serverName, 'serverName', 80), str(tool, 'tool', 200), policy as ToolPolicy)
  })
  handle(CH.mcpcReload, async () => need().reloadMcp())
  handle(CH.mcpcMaskedSettings, async () => need().maskedMcpSettings())
  // Old `settings.json.bak-*` copies can still hold MCP credentials in plain text: list them, and delete only those on request.
  handle(CH.appMcpBackups, async () => listSettingsBackups(path.join(app.getPath('userData'), 'config')))
  handle(CH.appMcpBackupsClear, async () => {
    const removed = await clearSettingsBackups(path.join(app.getPath('userData'), 'config'))
    log('mcp', `${removed} cópia(s) antiga(s) do settings.json apagada(s)`)
    return { removed }
  })
  /**
   * `installed` only proves the native host/files exist. Merge the live bridge
   * so Settings can say whether Chrome actually loaded and connected the
   * extension instead of showing a false "installed" state.
   */
  const chromeCompanionReport = async () => {
    const status = chromeCompanionStatus()
    const live = orchestrator
      ? await orchestrator.chromeBridge.status().catch(() => null)
      : null
    const connected = Boolean(live?.attached)
    const outdated = Boolean(
      connected && live?.extensionVersion && status.bundledVersion && compareVersions(live.extensionVersion, status.bundledVersion) < 0
    )
    return {
      ...status,
      extensionConnected: connected,
      extensionVersion: live?.extensionVersion,
      extensionOutdated: outdated,
      detail: !status.installed
        ? status.detail
        : outdated
          ? `A extensão no Chrome é a v${live?.extensionVersion}, mas o app traz a v${status.bundledVersion}. Abra chrome://extensions e clique em recarregar (↻) na extensão Openclod.`
          : connected
            ? `Host nativo e extensão${live?.extensionVersion ? ` ${live.extensionVersion}` : ''} conectados.`
            : 'Host nativo instalado, mas nenhuma extensão Openclod está conectada. Carregue a extensão em chrome://extensions.'
    }
  }
  handle(CH.appChromeCompanion, async () => chromeCompanionReport())
  handle(CH.appChromeInstall, async () => {
    await installChromeCompanion()
    return chromeCompanionReport()
  })
  handle(CH.appChromeExtensions, async () => {
    await openChromeExtensions()
    return chromeCompanionReport()
  })
  handle(CH.appChromeExport, async () => exportChromeExtension())
  handle(CH.appChromeReveal, async () => {
    const folder = chromeCompanionStatus().extensionPath
    if (!folder || !fs.existsSync(folder)) throw new Error('a pasta da extensão não existe')
    const error = await shell.openPath(folder)
    if (error) throw new Error(error)
    return true
  })
  handle(CH.appEnvironmentCheck, async (environmentId) => {
    const id = str(environmentId, 'environmentId', 60)
    const profile = (need().settings.get().environments ?? []).find((item) => item.id === id)
    if (!profile) throw new Error('ambiente não encontrado')
    const command = process.platform === 'win32' ? 'echo openclod-env-ok && cd' : 'printf "openclod-env-ok\\n" && pwd'
    const spec = environmentSpawn(command, process.cwd(), profile)
    return new Promise<{ ok: boolean; kind: string; detail: string; stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
      execFile(spec.file, spec.args, { cwd: process.cwd(), shell: spec.shell, timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
        const code = typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : error ? 1 : 0
        resolve({
          ok: !error && String(stdout).includes('openclod-env-ok'),
          kind: profile.kind,
          detail: error ? (error as Error).message : `Resposta real recebida de ${profile.label}.`,
          stdout: String(stdout).slice(0, 4_000),
          stderr: String(stderr).slice(0, 2_000),
          exitCode: code
        })
      })
    })
  })
  handle(CH.activityList, async (filters) => {
    if (!activityStore) return []
    const input = filters && typeof filters === 'object' ? filters as Record<string, unknown> : {}
    return activityStore.list({
      query: typeof input.query === 'string' ? input.query.slice(0, 200) : undefined,
      type: typeof input.type === 'string' ? input.type.slice(0, 60) : undefined,
      severity: typeof input.severity === 'string' ? input.severity.slice(0, 30) : undefined,
      archived: input.archived === true,
      limit: typeof input.limit === 'number' ? input.limit : undefined
    })
  })
  handle(CH.activityRead, async (itemId, read) =>
    activityStore?.setRead(str(itemId, 'itemId', 120), Boolean(read)) ?? false
  )
  handle(CH.activityArchive, async (itemId, archived) =>
    activityStore?.archive(str(itemId, 'itemId', 120), Boolean(archived)) ?? false
  )
  handle(CH.activityClear, async (archivedOnly) => activityStore?.clear(archivedOnly !== false) ?? 0)

  const needImprovements = (): ImprovementService => {
    if (!improvementService) throw new Error('revisão de melhorias indisponível')
    return improvementService
  }
  const knownProject = (raw: unknown) => {
    const projectId = str(raw, 'projectId', 80)
    const project = need().store.listProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('projeto não encontrado')
    return project
  }
  handle(CH.improvementsStatus, async (projectId) => improvementStatus(needImprovements(), need(), scheduler, knownProject(projectId).id))
  handle(CH.improvementsStart, async (projectId, options) => needImprovements().start(knownProject(projectId).id, startOptions(options), 'manual'))
  handle(CH.improvementsCancel, async () => needImprovements().cancel())
  handle(CH.improvementsWeekly, async (projectId, enabled, options) => {
    const project = knownProject(projectId)
    const useAi = options && typeof options === 'object' && typeof (options as { useAi?: unknown }).useAi === 'boolean' ? (options as { useAi: boolean }).useAi : undefined
    return setWeeklyReview(needScheduler(), project, Boolean(enabled), useAi)
  })
  handle(CH.appCreateSkill, async (rawName, rawDescription, rawBody) => {
    const name = str(rawName, 'nome', 64).trim()
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) throw new Error('nome da skill: use letras minúsculas, números e hífens (2 a 63 caracteres)')
    const description = str(rawDescription, 'descrição', 400).replace(/\s+/g, ' ').trim()
    const body = typeof rawBody === 'string' ? rawBody.slice(0, 100_000) : ''
    const dir = path.join(app.getPath('userData'), 'skills', name)
    if (fs.existsSync(dir)) throw new Error(`já existe uma skill chamada "${name}"`)
    fs.mkdirSync(dir, { recursive: true })
    const skill = ['---', `name: ${name}`, `description: ${description}`, '---', '', body.trim(), ''].join('\n')
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill, 'utf8')
    await need().skills.reload()
    return { name, description, source: 'usuario' as const }
  })
  handle(CH.appOpenSkills, async () => {
    const dir = path.join(app.getPath('userData'), 'skills')
    fs.mkdirSync(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
    return true
  })
  handle(CH.appNotify, async (title, body) => {
    if (!Notification.isSupported()) return false
    const icon = resolveIcon()
    new Notification({
      title: str(title, 'title', 120),
      body: optStr(body, 'body', 400) ?? '',
      silent: false,
      ...(icon ? { icon } : {})
    }).show()
    return true
  })

  handle(CH.projectsList, async () => need().store.listProjects())
  handle(CH.projectsAdd, async (folder, name) => {
    const target = path.resolve(str(folder, 'pasta', 1000))
    const stat = fs.statSync(target, { throwIfNoEntry: false })
    if (!stat?.isDirectory()) throw new Error('a pasta selecionada não existe')
    return need().addProject(target, optStr(name, 'nome', 120))
  })
  handle(CH.projectsSetModel, async (projectId, providerId, model) =>
    need().setProjectModel(
      str(projectId, 'projectId', 80),
      str(providerId, 'providerId', 60),
      str(model, 'model', 200)
    )
  )
  handle(CH.projectsRemove, async (projectId) => {
    await need().store.removeProject(str(projectId, 'projectId', 80))
    return true
  })
  handle(CH.projectsDelete, async (projectId) => {
    await need().deleteProject(str(projectId, 'projectId', 80))
    return true
  })
  handle(CH.projectsPick, async () => {
    const options = {
      title: 'Escolha a pasta do projeto',
      properties: ['openDirectory' as const, 'dontAddToRecent' as const]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })
  handle(CH.pathsPickFolder, async () => {
    const options = {
      title: 'Anexar pasta para o agente estudar',
      properties: ['openDirectory' as const, 'dontAddToRecent' as const]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })
  handle(CH.projectsEnsureDefault, async () => {
    // The user's desktop is the neutral fallback for Chat/Cowork. Openclod never
    // makes its own data folder the agent's working root.
    const dir = app.getPath('desktop')
    fs.mkdirSync(dir, { recursive: true })
    return need().addProject(dir, 'Área de Trabalho')
  })

  handle(CH.sessionsList, async () => need().store.listSessions())
  handle(CH.sessionsCreate, async (raw) => {
    const input = raw as CreateSessionInput
    if (!input || typeof input !== 'object') throw new Error('entrada inválida')
    const cwd = insideKnownRoot(str(input.cwd, 'cwd', 1000))
    const mode = AGENT_MODES.includes(input.mode) ? input.mode : 'code'
    const surface =
      input.surface === 'chat' || input.surface === 'cowork' || input.surface === 'code'
        ? input.surface
        : 'code'
    const projects = need().store.listProjects()
    const contains = (base: string, target: string): boolean => {
      const relative = path.relative(canonicalPath(base), canonicalPath(target))
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    }
    const requested = projects.find((item) => item.id === input.projectId)
    const project =
      requested && contains(requested.path, cwd)
        ? requested
        : projects
            .filter((item) => contains(item.path, cwd))
            .sort((a, b) => canonicalPath(b.path).length - canonicalPath(a.path).length)[0]
    if (!project) throw new Error('projeto não registrado; adicione a pasta primeiro')
    const providerId = str(input.providerId, 'providerId', 60)
    const provider = need().settings.providerConfig(providerId)
    if (!provider) throw new Error('provedor não encontrado')
    return need().createSession({
      projectId: project.id,
      cwd,
      mode,
      surface,
      providerId,
      model: (optStr(input.model, 'model', 200) || provider.model).trim(),
      title: optStr(input.title, 'title', 120)
    })
  })
  handle(CH.sessionsGet, async (sessionId) => {
    const id = str(sessionId, 'sessionId', 80)
    const state = await need().store.loadSession(id)
    if (!state) throw new Error('sessão não encontrada')
    // The stored copy lags behind the live runner: report what is pending and running right now.
    const live = need().liveSnapshot(id)
    return { ...state, ...(live ? { messages: live.messages, plan: live.plan, usage: live.usage, state: live.state } : {}), approvals: need().pendingApprovals(id) }
  })
  handle(CH.sessionsDelete, async (sessionId) => {
    await need().deleteSession(str(sessionId, 'sessionId', 80))
    return true
  })
  handle(CH.sessionsRename, async (sessionId, title) => {
    const state = await need().renameSession(str(sessionId, 'sessionId', 80), str(title, 'title', 120))
    if (!state) throw new Error('sessão não encontrada')
    return state
  })
  handle(CH.sessionsSend, async (sessionId, text, images, mode) => {
    const id = str(sessionId, 'sessionId', 80)
    let message = typeof text === 'string' ? text.slice(0, 200_000) : ''
    const parts = toImages(images)
    if (!message.trim() && !parts?.length) throw new Error('mensagem vazia')
    // `/nome argumentos` runs a custom command (a markdown template) instead of sending the literal text.
    if (message.startsWith('/')) {
      const cwd = need().store.getSession(id)?.meta.cwd
      const match = cwd ? matchCustomCommand(message, customCommandsFor(cwd)) : null
      if (match) message = expandCommand(match.command, match.args)
    }
    await need().startSend(id, message, parts, mode === 'steer' || mode === 'queue' ? mode : 'auto')
    return true
  })
  handle(CH.commandsList, async (cwd) => {
    const folder = str(cwd, 'cwd', 4096)
    return customCommandsFor(folder).map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      source: command.source
    }))
  })
  handle(CH.sessionsAbort, async (sessionId) => {
    await need().abort(str(sessionId, 'sessionId', 80))
    return true
  })
  handle(CH.sessionsSetMode, async (sessionId, mode) => {
    if (!AGENT_MODES.includes(mode as never)) throw new Error('modo inválido')
    await need().setMode(str(sessionId, 'sessionId', 80), mode as never)
    return true
  })
  handle(CH.sessionsSetEffort, async (sessionId, effort) => {
    if (effort !== null && !REASONING_EFFORTS.includes(effort as never)) throw new Error('nível de esforço inválido')
    await need().setEffort(str(sessionId, 'sessionId', 80), (effort as ReasoningEffort | null) ?? null)
    return true
  })
  handle(CH.sessionsSetEnvironment, async (sessionId, environmentId) => {
    await need().setEnvironment(str(sessionId, 'sessionId', 80), str(environmentId, 'environmentId', 60))
    return true
  })
  handle(CH.sessionsSetModel, async (sessionId, providerId, model) => {
    await need().setModel(
      str(sessionId, 'sessionId', 80),
      str(providerId, 'providerId', 60),
      str(model, 'model', 200)
    )
    return true
  })
  handle(CH.sessionsExport, async (sessionId) => {
    const json = await need().store.exportSession(str(sessionId, 'sessionId', 80))
    if (!json) throw new Error('sessão não encontrada')
    return json
  })
  handle(CH.sessionsImport, async (json) => need().store.importSession(str(json, 'json', 60_000_000)))
  handle(CH.sessionsArchive, async (sessionId, archived) => {
    const state = await need().archiveSession(str(sessionId, 'sessionId', 80), Boolean(archived))
    if (!state) throw new Error('sessão não encontrada')
    return state
  })
  handle(CH.sessionsCompact, async (sessionId) => {
    const state = await need().compactSession(str(sessionId, 'sessionId', 80))
    if (!state) throw new Error('sessão não encontrada')
    return state
  })
  handle(CH.sessionsContextBreakdown, async (sessionId) => need().contextBreakdown(str(sessionId, 'sessionId', 80)))
  handle(CH.sessionsRewind, async (sessionId, messageId, restoreFiles) => {
    const state = await need().rewindSession(
      str(sessionId, 'sessionId', 80),
      str(messageId, 'messageId', 120),
      Boolean(restoreFiles)
    )
    if (!state) throw new Error('sessão não encontrada')
    return state
  })
  handle(CH.sessionsFork, async (sessionId, messageId) => {
    const state = await need().forkSession(
      str(sessionId, 'sessionId', 80),
      str(messageId, 'messageId', 120)
    )
    if (!state) throw new Error('sessão não encontrada')
    return state
  })

  handle(CH.filesTree, async (root, depth) => {
    const safeRoot = knownRoot(str(root, 'root', 1000))
    const level = Math.max(1, Math.min(4, Number(depth) || 2))
    return need().tree(safeRoot, level)
  })
  handle(CH.filesRead, async (root, relative) => {
    const safeRoot = knownRoot(str(root, 'root', 1000))
    return need().readProjectFile(safeRoot, str(relative, 'relative', 1000))
  })
  handle(CH.filesChanges, async (sessionId) => need().changes(str(sessionId, 'sessionId', 80)))
  handle(CH.filesScreenshot, async () => need().screenshot())
  handle(CH.filesReveal, async (target) => {
    const resolved = path.resolve(str(target, 'caminho', 1000))
    const policy = need().settings.get().policy
    const roots = [
      ...need().store.listProjects().map((project) => project.path),
      ...(policy.allowedRoots ?? [])
    ].map((root) => path.resolve(root).toLowerCase())
    const inside = roots.some((root) => resolved.toLowerCase() === root || resolved.toLowerCase().startsWith(`${root}${path.sep}`))
    if (!inside) throw new Error('caminho fora das raízes permitidas')
    if (!fs.existsSync(resolved)) throw new Error('caminho não existe')
    if (fs.statSync(resolved).isDirectory()) await shell.openPath(resolved)
    else shell.showItemInFolder(resolved)
    return true
  })

  handle(CH.filesWrite, async (root, relative, content) => {
    const safeRoot = knownRoot(str(root, 'root', 1000))
    if (typeof content !== 'string') throw new Error('conteúdo inválido')
    return writeProjectFile(safeRoot, str(relative, 'relative', 1000), content)
  })
  handle(CH.filesSearch, async (root, query) => {
    const safeRoot = knownRoot(str(root, 'root', 1000))
    return searchProjectFiles(safeRoot, str(query, 'busca', 200))
  })

  handle(CH.previewDetect, async (root) => detectDevServers(knownRoot(str(root, 'root', 1000))))
  handle(CH.previewStart, async (root, name, sessionId) =>
    startDevServer(terminals, knownRoot(str(root, 'root', 1000)), str(name, 'nome', 80), str(sessionId, 'sessionId', 80))
  )

  handle(CH.gitStatus, async (root) => gitStatus(insideKnownRoot(str(root, 'root', 1000))))
  handle(CH.gitDiff, async (root, file, staged) => {
    const result = await gitFileDiff(insideKnownRoot(str(root, 'root', 1000)), str(file, 'arquivo', 1000), { staged: Boolean(staged) })
    return { diff: result.diff, truncated: result.truncated }
  })
  handle(CH.gitWorktreesList, async (root) => listWorktrees(knownRoot(str(root, 'root', 1000))))
  handle(CH.gitWorktreeCreate, async (root, branch, baseRef) => {
    const base = optStr(baseRef, 'baseRef', 200)?.trim()
    return createWorktree(knownRoot(str(root, 'root', 1000)), {
      branch: str(branch, 'branch', 200),
      ...(base ? { baseRef: base } : {})
    })
  })
  handle(CH.gitWorktreeRemove, async (root, worktreePath) =>
    removeWorktree(knownRoot(str(root, 'root', 1000)), str(worktreePath, 'worktreePath', 1200))
  )

  handle(CH.schedulesList, async () => needScheduler().list())
  handle(CH.schedulesCreate, async (raw) => needScheduler().create(toTaskInput(raw, false) as never))
  handle(CH.schedulesUpdate, async (taskId, raw) => needScheduler().update(str(taskId, 'id', 80), toTaskInput(raw, true) as never))
  handle(CH.schedulesRemove, async (taskId) => needScheduler().remove(str(taskId, 'id', 80)))
  handle(CH.schedulesRunNow, async (taskId) => needScheduler().runNow(str(taskId, 'id', 80)))

  handle(CH.tasksList, async (sessionId) => listBackgroundProcesses(optStr(sessionId, 'sessionId', 80) || undefined))
  handle(CH.tasksOutput, async (sessionId, pid) => {
    const output = backgroundProcessOutput(str(sessionId, 'sessionId', 80), Number(pid))
    if (output === null) throw new Error('processo não encontrado')
    return output
  })
  handle(CH.tasksStop, async (sessionId, pid) => stopBackgroundProcess(str(sessionId, 'sessionId', 80), Number(pid)))

  handle(CH.sttStatus, async () => stt.status())
  handle(CH.sttStart, async (options) => stt.start((options ?? {}) as SttStartOptions))
  handle(CH.sttPreload, async (options) => stt.preload((options ?? {}) as SttStartOptions))
  handle(CH.sttStop, async () => stt.stop())
  handle(CH.ttsVoices, async (provider) => tts.listVoices(provider === 'windows' || provider === 'edge' ? provider : undefined))
  handle(CH.ttsStatus, async () => tts.status())
  handle(CH.ttsSpeak, async (options) => {
    const input = options && typeof options === 'object' ? options as { text?: unknown; provider?: unknown; voice?: unknown; rate?: unknown; volume?: unknown } : {}
    return tts.speak({
      text: str(input.text, 'texto', 20_000),
      provider: input.provider === 'windows' ? 'windows' : 'edge',
      voice: typeof input.voice === 'string' ? input.voice.slice(0, 200) : undefined,
      rate: Number(input.rate) || 0,
      volume: input.volume === undefined ? 100 : Number(input.volume)
    })
  })
  handle(CH.ttsStop, async () => tts.stop())
  handle(CH.dictationInsert, async (text) => {
    const raw = str(text, 'texto', 20_000)
    const polished = await dictation.polish(raw)
    return dictation.insert(polished)
  })
  ipcMain.on(CH.dictationState, (event, raw) => {
    if (!trustedSender(event) || !raw || typeof raw !== 'object') return
    const state = raw as { phase?: unknown; level?: unknown; text?: unknown; error?: unknown }
    const phase =
      state.phase === 'loading' || state.phase === 'listening' || state.phase === 'processing' || state.phase === 'error'
        ? state.phase
        : 'idle'
    dictation.update({
      phase,
      level: Number(state.level) || 0,
      text: typeof state.text === 'string' ? state.text.slice(0, 2000) : undefined,
      error: typeof state.error === 'string' ? state.error.slice(0, 500) : undefined
    })
  })

  handle(CH.memoryStatus, async (projectId) => need().memoryStats(str(projectId, 'projectId', 80)))
  handle(CH.memoryList, async (projectId) => need().memoryList(str(projectId, 'projectId', 80)))
  handle(CH.memoryRead, async (projectId, slug) =>
    need().memoryRead(str(projectId, 'projectId', 80), str(slug, 'slug', 80))
  )
  handle(CH.memoryDelete, async (projectId, slug) =>
    need().memoryDelete(str(projectId, 'projectId', 80), str(slug, 'slug', 200))
  )
  handle(CH.memoryInvalidate, async (projectId, slug, reason) =>
    need().memoryInvalidate(
      str(projectId, 'projectId', 80),
      str(slug, 'slug', 200),
      typeof reason === 'string' ? reason.slice(0, 1_000) : ''
    )
  )
  handle(CH.memoryRecall, async (projectId, query, limit) =>
    need().memoryRecall(
      str(projectId, 'projectId', 80),
      str(query, 'query', 300),
      typeof limit === 'number' ? Math.min(20, Math.max(1, limit)) : 8
    )
  )
  handle(CH.memoryAiStatus, async () => need().aiMemoryStatus())
  handle(CH.memoryGraph, async (projectId) => need().memoryGraph(str(projectId, 'projectId', 80)))
  handle(CH.memoryExport, async (projectId) => {
    const id = str(projectId, 'projectId', 80)
    const bundle = await need().memoryExportMarkdown(id)
    const options = {
      title: 'Exportar AI-Memory',
      defaultPath: `openclod-memory-${id}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const chosen =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return null
    fs.writeFileSync(chosen.filePath, bundle.markdown, 'utf8')
    return chosen.filePath
  })
  handle(CH.memoryImport, async (projectId) => {
    const id = str(projectId, 'projectId', 80)
    const options = {
      title: 'Importar memória (pasta com arquivos .md)',
      properties: ['openDirectory'] as Array<'openDirectory'>
    }
    const chosen =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return 0
    const dir = chosen.filePaths[0]
    const files: Array<{ name: string; content: string }> = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      files.push({ name: entry.name, content: fs.readFileSync(path.join(dir, entry.name), 'utf8') })
    }
    return need().memoryImportMarkdown(id, files)
  })
  handle(CH.memoryImportZip, async (projectId) => {
    const id = str(projectId, 'projectId', 80)
    const options = {
      title: 'Importar memória (ZIP Markdown)',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Memória Markdown', extensions: ['zip'] }]
    }
    const chosen =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
    if (chosen.canceled || !chosen.filePaths[0]) return 0
    const zip = path.resolve(chosen.filePaths[0])
    const stat = fs.statSync(zip)
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('ZIP inválido ou maior que 100 MB')
    const extraction = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'openclod-memory-'))
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:OPENCLOD_MEMORY_ZIP -DestinationPath $env:OPENCLOD_MEMORY_DIR -Force'
        ], {
          windowsHide: true,
          timeout: 60_000,
          env: { ...process.env, OPENCLOD_MEMORY_ZIP: zip, OPENCLOD_MEMORY_DIR: extraction }
        }, (error) => error ? reject(new Error(`falha ao abrir ZIP: ${error.message}`)) : resolve())
      })
      const files: Array<{ name: string; content: string }> = []
      const visit = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          const relative = path.relative(extraction, full)
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue
          if (entry.isDirectory()) {
            visit(full)
            continue
          }
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          const content = fs.readFileSync(full, 'utf8')
          if (content.length <= 1_000_000) files.push({ name: relative, content })
          if (files.length >= 2_000) return
        }
      }
      visit(extraction)
      return need().memoryImportMarkdown(id, files)
    } finally {
      await fs.promises.rm(extraction, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  handle(CH.memoryOpen, async (projectId) => {
    const root = need().memoryRoot(str(projectId, 'projectId', 80))
    fs.mkdirSync(root, { recursive: true })
    const error = await shell.openPath(root)
    if (error) throw new Error(error)
    return true
  })
  ipcMain.on(CH.sttAudio, (event, pcm) => {
    if (!trustedSender(event)) return
    if (pcm instanceof ArrayBuffer) {
      stt.audio(pcm)
      return
    }
    if (ArrayBuffer.isView(pcm)) stt.audio(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  })

  handle(CH.powerState, async () => keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId))
  handle(CH.powerKeepAwake, async (enabled) => {
    if (enabled) {
      if (keepAwakeId === null || !powerSaveBlocker.isStarted(keepAwakeId)) {
        keepAwakeId = powerSaveBlocker.start('prevent-app-suspension')
      }
    } else if (keepAwakeId !== null) {
      if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId)
      keepAwakeId = null
    }
    return keepAwakeId !== null
  })

  handle(CH.approvalsResolve, async (approvalId, approved, always, reason) => {
    need().resolveApproval(
      str(approvalId, 'approvalId', 80),
      Boolean(approved),
      Boolean(always),
      typeof reason === 'string' ? reason.slice(0, 1_000) : ''
    )
    return true
  })
  handle(CH.questionsAnswer, async (questionId, answers) => {
    const rows = Array.isArray(answers) ? answers : []
    const clean: QuestionAnswer[] = rows.slice(0, 12).map((row) => {
      const value = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
      const header = typeof value.header === 'string' && value.header.trim() ? value.header.slice(0, 120) : 'Pergunta'
      const list = Array.isArray(value.answers) ? value.answers : []
      const attachments = Array.isArray(value.attachments) ? value.attachments : []
      const files = attachments
        .slice(0, 8)
        .map((entry) => {
          const item = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
          const filePath = typeof item.path === 'string' ? item.path.trim() : ''
          if (!filePath) return null
          return {
            name:
              typeof item.name === 'string' && item.name.trim()
                ? item.name.trim().slice(0, 200)
                : filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath,
            path: filePath.slice(0, 2_000),
            kind: (item.kind === 'folder' ? 'folder' : 'file') as 'file' | 'folder'
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      return {
        header,
        answers: list
          .filter((answer): answer is string => typeof answer === 'string' && Boolean(answer.trim()))
          .slice(0, 20)
          .map((answer) => answer.slice(0, 1_000)),
        ...(files.length ? { attachments: files } : {})
      }
    })
    return need().resolveQuestions(str(questionId, 'questionId', 80), clean)
  })
  handle(CH.inboxList, async (sessionId) => need().inboxList(str(sessionId, 'sessionId', 80)))
  handle(CH.inboxAdd, async (sessionId, text, images, mode, origin) =>
    need().inboxAdd(
      str(sessionId, 'sessionId', 80),
      str(text, 'texto', 200_000),
      toImages(images),
      mode === 'steer' ? 'steer' : 'queue',
      origin === 'ui' ? 'ui' : 'agent'
    )
  )
  handle(CH.inboxRemove, async (sessionId, itemId) =>
    need().inboxRemove(str(sessionId, 'sessionId', 80), str(itemId, 'itemId', 80))
  )
  handle(CH.inboxClear, async (sessionId) => {
    need().inboxClear(str(sessionId, 'sessionId', 80))
    return true
  })
  handle(CH.mcpRestart, async () => {
    await need().restartMcp()
    return true
  })

  handle(CH.terminalShells, async () => availableShells())
  handle(CH.terminalList, async () => terminals.list())
  handle(CH.terminalCreate, async (raw) => {
    const input = (raw ?? {}) as Record<string, unknown>
    const cwd = insideKnownRoot(str(input.cwd, 'cwd', 1000))
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('a pasta do terminal não existe')
    const shell = input.shell === 'cmd' || input.shell === 'bash' || input.shell === 'powershell' ? input.shell : undefined
    return terminals.create({
      cwd,
      cols: Number(input.cols),
      rows: Number(input.rows),
      shell,
      sessionId: optStr(input.sessionId, 'sessionId', 80)
    })
  })
  handle(CH.terminalSnapshot, async (terminalId) => terminals.snapshot(str(terminalId, 'terminalId', 80)))
  handle(CH.terminalKill, async (terminalId) => {
    terminals.kill(str(terminalId, 'terminalId', 80))
    return true
  })
  ipcMain.on(CH.terminalWrite, (event, terminalId, data) => {
    if (!trustedSender(event) || typeof terminalId !== 'string' || typeof data !== 'string') return
    try {
      terminals.write(terminalId, data.slice(0, 1_000_000))
    } catch (err) {
      log('terminal', err)
    }
  })
  ipcMain.on(CH.terminalResize, (event, terminalId, cols, rows) => {
    if (!trustedSender(event) || typeof terminalId !== 'string') return
    try {
      terminals.resize(terminalId, Number(cols), Number(rows))
    } catch (err) {
      log('terminal', err)
    }
  })

  ipcMain.on(CH.winMinimize, (event) => {
    if (trustedSender(event)) mainWindow?.minimize()
  })
  ipcMain.on(CH.winMaximize, (event) => {
    if (!trustedSender(event) || !mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(CH.winClose, (event) => {
    if (trustedSender(event)) mainWindow?.close()
  })
  ipcMain.handle(CH.winIsMaximized, (event) => {
    if (!trustedSender(event)) return false
    return mainWindow?.isMaximized() ?? false
  })
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void contents.loadURL(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!/^(https?:|about:blank)/i.test(url)) event.preventDefault()
    })
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    // The app window may use the microphone (dictation); nothing else gets device access.
    const appSession = electronSession.defaultSession
    const isAppContents = (contents: Electron.WebContents | null): boolean =>
      Boolean(contents && mainWindow && !mainWindow.isDestroyed() && contents.id === mainWindow.webContents.id)
    appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
        callback(isAppContents(contents) && types.length > 0 && types.every((type) => type === 'audio'))
        return
      }
      callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
    })
    appSession.setPermissionCheckHandler((contents, permission) =>
      permission === 'media' ? isAppContents(contents) : permission === 'clipboard-sanitized-write' || permission === 'fullscreen'
    )
    const preview = electronSession.fromPartition(PREVIEW_PARTITION)
    // Pages shown in the browser pane get no device or notification access.
    preview.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'))
    preview.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
    orchestrator = new Orchestrator({
      userData: app.getPath('userData'),
      broadcast,
      log: (message) => log('orchestrator', message),
      colabHost: colabHost(),
      terminalRunner
    })
    orchestrator.chromeBridge.appVersion = app.getVersion()
    // A new app version may ship a newer extension: refresh the stable copy Chrome has loaded, then let the
    // bridge ask an outdated extension to reload itself from that copy.
    syncStableExtension()
    orchestrator.chromeBridge.expectedExtensionVersion = chromeCompanionStatus().bundledVersion ?? ''
    activityStore = new ActivityStore(path.join(app.getPath('userData'), 'data', 'activity'))
    await activityStore.init()
    providerUsageStore = new ProviderUsageStore(path.join(app.getPath('userData'), 'data'))
    await providerUsageStore.init()
    seedProviderUsage()
    observabilityStore = new ObservabilityService(path.join(app.getPath('userData'), 'data', 'observability'))
    await observabilityStore.init()
    observabilityStore.recordLog('startup', 'Openclod inicializando')
    try {
      await orchestrator.init()
      for (const change of orchestrator.settings.migrations) log('settings', `migração: ${change}`)
      const updateSettings = orchestrator.settings.get().updates
      if (updateSettings?.autoCheck && updateSettings.feedUrl && Notification.isSupported()) {
        void checkForUpdate(app.getVersion(), updateSettings.feedUrl).then((update) => {
          if (!update.available) return
          const notification = new Notification({
            title: `Openclod ${update.latestVersion} disponível`,
            body: 'Abra Configurações → Sobre para baixar e verificar o instalador.'
          })
          notification.show()
        }).catch((error) => log('updates', error))
      }
    } catch (err) {
      log('init', err)
      dialog.showErrorBox(
        'Openclod Desktop - falha na inicialização',
        `Não foi possível iniciar o harness.\n\n${(err as Error).message}\n\nLog: ${logFile()}`
      )
    }
    improvementService = createImprovementService({
      orchestrator: () => orchestrator,
      activity: () => activityStore,
      observability: () => observabilityStore,
      usage: () => providerUsageStore,
      dataDir: path.join(app.getPath('userData'), 'data'),
      log: (message) => log('improvements', message)
    })
    await improvementService.init()
    registerIpc()
    removeLegacyElectronShortcut()
    createWindow()
    createTray()
    void applyPendingSelfRepair()
    dictation.register(orchestrator?.settings.get().voice?.shortcut ?? '')

    try {
      scheduler = new Scheduler(path.join(app.getPath('userData'), 'schedules.json'))
      await scheduler.start((task) => runScheduledTask(task))
    } catch (err) {
      log('scheduler', err)
    }

    try {
      globalShortcut.register('Control+Alt+F', () => {
        if (!mainWindow) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      })
    } catch (err) {
      log('shortcut', err)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  })

  app.on('before-quit', (event) => {
    if (cleanedUp) return
    event.preventDefault()
    closing = true
    tray?.destroy()
    tray = null
    void cleanup().finally(() => app.exit(0))
  })
}
