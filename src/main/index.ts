import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, powerSaveBlocker, session as electronSession, shell, type IpcMainInvokeEvent } from 'electron'
import { Orchestrator } from './orchestrator.js'
import { DictationController } from './dictation.js'
import { SttService } from './stt.js'
import { defaultSettings } from './settings.js'
import { TerminalManager, availableShells } from './terminal.js'
import { ComputerOverlay } from './computer-overlay.js'
import { detectDevServers, startDevServer } from './preview.js'
import { searchProjectFiles, writeProjectFile } from './project-files.js'
import { backgroundProcessOutput, listBackgroundProcesses, stopBackgroundProcess } from '../core/tools/shell.js'
import { gitFileDiff, gitStatus } from '../core/git/service.js'
import { Scheduler, type ScheduledTask } from '../core/scheduler/scheduler.js'
import { CH, type AppVersions, type CreateSessionInput, type PluginCatalogEntry, type ProviderPresetInfo, type SttStartOptions } from '../shared/api.js'
import {
  AGENT_MODES,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type AppSettings,
  type HarnessEvent,
  type HooksConfig,
  type ImagePart,
  type ModelCompat,
  type PermissionMode
} from '../shared/types.js'
import { PROVIDER_PRESETS } from '../core/providers/presets.js'
import { HOOK_EVENTS, normalizeHookDefinition } from '../core/hooks/runner.js'
import { normalizeMcpServerSettings } from '../core/mcp/client.js'

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
let orchestrator: Orchestrator | null = null
const terminals = new TerminalManager((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.terminalEvent, event)
})
const stt = new SttService({
  emit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.sttEvent, event)
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

/** Filesystem reads from the renderer are limited to registered roots. */
function knownRoot(root: string): string {
  if (!orchestrator) throw new Error('aplicativo ainda inicializando')
  const resolved = path.resolve(root)
  const policy = orchestrator.settings.get().policy
  const candidates = [
    ...orchestrator.store.listProjects().map((project) => project.path),
    ...(policy.allowedRoots ?? [])
  ]
  const allowed = candidates.some((candidate) => path.resolve(candidate).toLowerCase() === resolved.toLowerCase())
  if (!allowed) throw new Error('diretório não registrado como projeto')
  return resolved
}

/** Like knownRoot, but also accepts folders inside a registered root (worktrees, subfolders). */
function insideKnownRoot(target: string): string {
  if (!orchestrator) throw new Error('aplicativo ainda inicializando')
  const resolved = path.resolve(target)
  const lower = resolved.toLowerCase()
  const policy = orchestrator.settings.get().policy
  const roots = [...orchestrator.store.listProjects().map((project) => project.path), ...(policy.allowedRoots ?? [])]
  const inside = roots.some((root) => {
    const base = path.resolve(root).toLowerCase()
    return lower === base || lower.startsWith(`${base}${path.sep}`)
  })
  if (!inside) throw new Error('caminho fora das raízes permitidas')
  return resolved
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'readonly' || value === 'ask' || value === 'accept-edits' || value === 'auto'
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
      const kind = provider.kind === 'anthropic' || provider.kind === 'mock' ? provider.kind : 'openai'
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
        inputCostPerMTok: Number(provider.inputCostPerMTok) || undefined,
        outputCostPerMTok: Number(provider.outputCostPerMTok) || undefined,
        temperature: provider.temperature === undefined || provider.temperature === null ? undefined : Number(provider.temperature),
        maxOutputTokens: Number(provider.maxOutputTokens) > 0 ? Math.min(1_000_000, Number(provider.maxOutputTokens)) : undefined,
        compat: sanitizeCompat(provider.compat)
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
      maxTokens: Math.max(10_000, Math.min(200_000_000, Number(limits.maxTokens) || 3_000_000)),
      maxCostUsd: Math.max(0, Math.min(10_000, Number(limits.maxCostUsd) || 10)),
      maxParallelTools: Math.max(1, Math.min(16, Number(limits.maxParallelTools) || 4))
    }
  }

  if (Array.isArray(input.mcpServers)) {
    patch.mcpServers = input.mcpServers.slice(0, 20).map((server) => normalizeMcpServerSettings(server))
  }

  if (input.theme === 'light' || input.theme === 'dark') patch.theme = input.theme
  if (typeof input.autoAgents === 'boolean') patch.autoAgents = input.autoAgents
  if (typeof input.useAllModels === 'boolean') patch.useAllModels = input.useAllModels

  if (input.voice && typeof input.voice === 'object') {
    const model = String(input.voice.model ?? 'base')
    const language = String(input.voice.language ?? 'pt')
    const shortcut = typeof input.voice.shortcut === 'string' ? input.voice.shortcut.trim().slice(0, 40) : 'Control+Alt+Space'
    patch.voice = {
      model: /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(model) ? model : 'base',
      language: /^([a-z]{2,3}|auto)$/.test(language) ? language : 'pt',
      shortcut: /^[A-Za-z0-9+ ]{3,40}$/.test(shortcut) ? shortcut : 'Control+Alt+Space',
      mode: input.voice.mode === 'hold' ? 'hold' : 'toggle',
      polish: Boolean(input.voice.polish),
      insert: input.voice.insert === 'composer' ? 'composer' : 'focused'
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

function broadcast(event: HarnessEvent): void {
  if (event.type === 'turn_end') scheduledTurns.get(event.sessionId)?.(event.stopReason)
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

  mainWindow.on('maximize', () => mainWindow?.webContents.send('forja:window-state', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('forja:window-state', false))

  mainWindow.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    closing = true
    void cleanup().finally(() => mainWindow?.destroy())
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
}

/* ------------------------------------------------------------------ */
/* Scheduled tasks                                                     */
/* ------------------------------------------------------------------ */

/**
 * Runs one scheduled task: a new Code session in the task's project with the
 * task prompt. Resolves only when the turn ends, so the scheduler never runs
 * the same task twice at once.
 */
async function runScheduledTask(task: ScheduledTask): Promise<{ sessionId?: string }> {
  if (!orchestrator) throw new Error('aplicativo ainda inicializando')
  const settings = orchestrator.settings
  const project = orchestrator.store.listProjects().find((item) => item.id === task.projectId)
  if (!project) throw new Error('o projeto desta tarefa não está mais registrado')
  const provider =
    (task.providerId ? settings.providerConfig(task.providerId) : undefined) ?? settings.providerConfig(settings.get().defaultProviderId)
  if (!provider) throw new Error('nenhum provedor configurado')
  const meta = await orchestrator.createSession({
    projectId: project.id,
    cwd: project.path,
    mode: task.mode ?? 'code',
    surface: 'code',
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
  if (input.providerId !== undefined) out.providerId = optStr(input.providerId, 'providerId', 60) || undefined
  if (input.model !== undefined) out.model = optStr(input.model, 'model', 200) || undefined
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
  handle(CH.appVersions, async (): Promise<AppVersions> => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  }))

  handle(CH.appPresets, async (): Promise<ProviderPresetInfo[]> =>
    Object.entries(PROVIDER_PRESETS).map(([key, preset]) => ({ key, ...preset }))
  )
  handle(CH.appSettings, async () => need().settings.get())
  handle(CH.appUpdateSettings, async (raw) => {
    const patch = sanitizeSettingsPatch(raw)
    const next = await need().settings.update(patch)
    need().settingsChanged()
    if (patch.mcpServers) await need().restartMcp()
    if (patch.voice) dictation.register(next.voice?.shortcut ?? 'Control+Alt+Space')
    return next
  })
  handle(CH.appSetSecret, async (providerId, value) => {
    const orchestratorRef = need()
    const id = str(providerId, 'providerId', 60)
    if (!orchestratorRef.settings.providerConfig(id)) throw new Error('provedor não encontrado')
    await orchestratorRef.settings.setSecret(id, str(value, 'chave', 4000))
    orchestratorRef.settingsChanged()
    return true
  })
  handle(CH.appClearSecret, async (providerId) => {
    const orchestratorRef = need()
    await orchestratorRef.settings.clearSecret(str(providerId, 'providerId', 60))
    orchestratorRef.settingsChanged()
    return true
  })
  handle(CH.appTestProvider, async (providerId) => need().testProvider(str(providerId, 'providerId', 60)))
  handle(CH.appSkills, async () =>
    need().skills.list().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source
    }))
  )
  handle(CH.appDiscoverModels, async (providerId) => need().discoverModels(str(providerId, 'providerId', 60)))
  handle(CH.appRememberModel, async (providerId, model) => {
    const id = str(providerId, 'providerId', 60)
    const value = str(model, 'model', 200)
    await need().settings.update({ lastModel: { providerId: id, model: value } })
    return true
  })
  handle(CH.appMcpPresets, async () => need().mcpPresets())
  handle(CH.appMcpCatalog, async () => need().mcpCatalog())
  handle(CH.appPluginCatalog, async () => pluginCatalog())
  handle(CH.appAgents, async (cwd) => need().listAgents(cwd ? str(cwd, 'cwd', 1000) : undefined))
  handle(CH.appImportClaude, async () => need().importClaudeCatalog())
  handle(CH.appMcpInstall, async (id, env, headers) =>
    need().installMcp({ id: str(id, 'id', 200), env: env as Record<string, string> | undefined, headers: headers as Record<string, string> | undefined })
  )
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
  handle(CH.projectsRemove, async (projectId) => {
    await need().store.removeProject(str(projectId, 'projectId', 80))
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
    const cwd = knownRoot(str(input.cwd, 'cwd', 1000))
    const mode = AGENT_MODES.includes(input.mode) ? input.mode : 'code'
    const surface =
      input.surface === 'chat' || input.surface === 'cowork' || input.surface === 'code'
        ? input.surface
        : 'code'
    const project = need()
      .store.listProjects()
      .find((item) => path.resolve(item.path).toLowerCase() === cwd.toLowerCase())
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
    const state = await need().store.loadSession(str(sessionId, 'sessionId', 80))
    if (!state) throw new Error('sessão não encontrada')
    return state
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
  handle(CH.sessionsSend, async (sessionId, text, images) => {
    const id = str(sessionId, 'sessionId', 80)
    const message = typeof text === 'string' ? text.slice(0, 200_000) : ''
    const parts = toImages(images)
    if (!message.trim() && !parts?.length) throw new Error('mensagem vazia')
    await need().startSend(id, message, parts)
    return true
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
  handle(CH.sttStop, async () => stt.stop())
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
    need().memoryDelete(str(projectId, 'projectId', 80), str(slug, 'slug', 80))
  )
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

  handle(CH.approvalsResolve, async (approvalId, approved, always) => {
    need().resolveApproval(str(approvalId, 'approvalId', 80), Boolean(approved), Boolean(always))
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
      log: (message) => log('orchestrator', message)
    })
    try {
      await orchestrator.init()
      for (const change of orchestrator.settings.migrations) log('settings', `migração: ${change}`)
    } catch (err) {
      log('init', err)
      dialog.showErrorBox(
        'Openclod Desktop - falha na inicialização',
        `Não foi possível iniciar o harness.\n\n${(err as Error).message}\n\nLog: ${logFile()}`
      )
    }
    registerIpc()
    createWindow()
    dictation.register(orchestrator?.settings.get().voice?.shortcut ?? 'Control+Alt+Space')

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
  })

  app.on('before-quit', (event) => {
    if (cleanedUp) return
    event.preventDefault()
    closing = true
    void cleanup().finally(() => app.exit(0))
  })
}
