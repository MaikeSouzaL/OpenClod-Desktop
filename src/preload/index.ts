import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH, type OpenclodApi, type IpcResult, type SttEvent, type TerminalEvent, type TtsState } from '../shared/api.js'
import type { HarnessEvent } from '../shared/types.js'

function call<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

const api: OpenclodApi = {
  app: {
    capabilities: () => call(CH.appCapabilities),
    providerUsage: () => call(CH.appProviderUsage),
    presets: () => call(CH.appPresets),
    settings: () => call(CH.appSettings),
    updateSettings: (patch) => call(CH.appUpdateSettings, patch),
    setSecret: (providerId, value) => call(CH.appSetSecret, providerId, value),
    clearSecret: (providerId) => call(CH.appClearSecret, providerId),
    testProvider: (providerId, draft) => call(CH.appTestProvider, providerId, draft),
    versions: () => call(CH.appVersions),
    backupExport: () => call(CH.appBackupExport),
    backupInspect: () => call(CH.appBackupInspect),
    backupRestore: () => call(CH.appBackupRestore),
    observability: (filters) => call(CH.appObservability, filters),
    exportDiagnostics: () => call(CH.appDiagnosticsExport),
    exportConfiguration: () => call(CH.appConfigExport),
    importConfiguration: () => call(CH.appConfigImport),
    checkForUpdates: () => call(CH.appUpdateCheck),
    downloadUpdate: () => call(CH.appUpdateDownload),
    skills: () => call(CH.appSkills),
    notify: (title, body) => call(CH.appNotify, title, body),
    createSkill: (name, description, body) => call(CH.appCreateSkill, name, description, body),
    discoverModels: (providerId, draft) => call(CH.appDiscoverModels, providerId, draft),
    colabPrepare: () => call(CH.colabPrepare),
    colabInspect: (code) => call(CH.colabInspect, code),
    colabConnect: (code) => call(CH.colabConnect, code),
    colabStatus: (fresh) => call(CH.colabStatus, fresh),
    colabDisconnect: () => call(CH.colabDisconnect),
    colabRevealNotebook: () => call(CH.colabReveal),
    colabStartDrag: () => ipcRenderer.send(CH.colabDragStart),
    llamacppStatus: () => call(CH.llamacppStatus),
    llamacppSetProfile: (patch) => call(CH.llamacppSetProfile, patch),
    llamacppPickModel: () => call(CH.llamacppPickModel),
    llamacppModels: () => call(CH.llamacppModels),
    llamacppPickFolder: () => call(CH.llamacppPickFolder),
    llamacppHubList: () => call(CH.llamacppHubList),
    llamacppHubRefresh: () => call(CH.llamacppHubRefresh),
    llamacppHubSearch: (query) => call(CH.llamacppHubSearch, query),
    llamacppHubFiles: (repo) => call(CH.llamacppHubFiles, repo),
    llamacppDownload: (repo, name) => call(CH.llamacppDownload, repo, name),
    llamacppDownloadStatus: () => call(CH.llamacppDownloadStatus),
    llamacppDownloadCancel: () => call(CH.llamacppDownloadCancel),
    llamacppOptions: () => call(CH.llamacppOptions),
    llamacppProfileAction: (action) => call(CH.llamacppProfileAction, action),
    llamacppMachine: () => call(CH.llamacppMachine),
    llamacppBuildInstall: (kind, tag) => call(CH.llamacppBuildInstall, kind, tag),
    llamacppBuildStatus: () => call(CH.llamacppBuildStatus),
    llamacppBuildCancel: () => call(CH.llamacppBuildCancel),
    llamacppBuildSelect: (id) => call(CH.llamacppBuildSelect, id),
    llamacppBuildRemove: (id) => call(CH.llamacppBuildRemove, id),
    llamacppStart: () => call(CH.llamacppStart),
    llamacppStop: () => call(CH.llamacppStop),
    llamacppLog: (since) => call(CH.llamacppLog, since),
    rememberModel: (providerId, model) => call(CH.appRememberModel, providerId, model),
    mcpPresets: () => call(CH.appMcpPresets),
    mcpCatalog: () => call(CH.appMcpCatalog),
    installMcp: (id, env, headers) => call(CH.appMcpInstall, id, env, headers),
    mcpOAuthStatus: (serverName) => call(CH.appMcpOAuthStatus, serverName),
    authorizeMcp: (serverName) => call(CH.appMcpOAuthAuthorize, serverName),
    connectorDirectory: () => call(CH.mcpcDirectory),
    connectorStates: () => call(CH.mcpcStates),
    connectConnector: (id, input) => call(CH.mcpcConnect, id, input),
    disconnectConnector: (id) => call(CH.mcpcDisconnect, id),
    connectorTools: (serverName) => call(CH.mcpcTools, serverName),
    setToolPolicy: (serverName, tool, policy) => call(CH.mcpcSetToolPolicy, serverName, tool, policy),
    reloadMcp: () => call(CH.mcpcReload),
    maskedMcpSettings: () => call(CH.mcpcMaskedSettings),
    mcpBackups: () => call(CH.appMcpBackups),
    clearMcpBackups: () => call(CH.appMcpBackupsClear),
    importClaude: () => call(CH.appImportClaude),
  claudeStatus: () => call(CH.appClaudeStatus),
  claudeLogin: () => call(CH.appClaudeLogin),
    pluginCatalog: () => call(CH.appPluginCatalog),
    plugins: () => call(CH.appPlugins),
    installLocalPlugin: () => call(CH.appPluginInstallLocal),
    setPluginEnabled: (pluginId, enabled) => call(CH.appPluginSetEnabled, pluginId, enabled),
    removePlugin: (pluginId) => call(CH.appPluginRemove, pluginId),
    pluginDiagnostics: () => call(CH.appPluginDiagnostics),
    agents: (cwd) => call(CH.appAgents, cwd),
    openSkillsFolder: () => call(CH.appOpenSkills),
    chromeCompanion: () => call(CH.appChromeCompanion),
    installChromeCompanion: () => call(CH.appChromeInstall),
    openChromeExtensions: () => call(CH.appChromeExtensions),
    exportChromeExtension: () => call(CH.appChromeExport),
    revealChromeExtension: () => call(CH.appChromeReveal),
    environmentCheck: (environmentId) => call(CH.appEnvironmentCheck, environmentId),
    activity: (filters) => call(CH.activityList, filters),
    setActivityRead: (itemId, read) => call(CH.activityRead, itemId, read),
    archiveActivity: (itemId, archived) => call(CH.activityArchive, itemId, archived),
    clearActivity: (archivedOnly) => call(CH.activityClear, archivedOnly)
  },
  paths: {
    fromFile: (file) => webUtils.getPathForFile(file),
    pickFolder: () => call(CH.pathsPickFolder)
  },
  projects: {
    list: () => call(CH.projectsList),
    add: (folder, name) => call(CH.projectsAdd, folder, name),
    remove: (projectId) => call(CH.projectsRemove, projectId),
    delete: (projectId) => call(CH.projectsDelete, projectId),
    pick: () => call(CH.projectsPick),
    ensureDefault: () => call(CH.projectsEnsureDefault),
    setModel: (projectId, providerId, model) => call(CH.projectsSetModel, projectId, providerId, model)
  },
  sessions: {
    list: () => call(CH.sessionsList),
    create: (input) => call(CH.sessionsCreate, input),
    get: (sessionId) => call(CH.sessionsGet, sessionId),
    delete: (sessionId) => call(CH.sessionsDelete, sessionId),
    rename: (sessionId, title) => call(CH.sessionsRename, sessionId, title),
    send: (sessionId, text, images, mode) => call(CH.sessionsSend, sessionId, text, images, mode),
    abort: (sessionId) => call(CH.sessionsAbort, sessionId),
    resumePlan: (sessionId, itemId) => call(CH.sessionsResumePlan, sessionId, itemId),
    discardPlan: (sessionId) => call(CH.sessionsDiscardPlan, sessionId),
    setMode: (sessionId, mode) => call(CH.sessionsSetMode, sessionId, mode),
    setModel: (sessionId, providerId, model) => call(CH.sessionsSetModel, sessionId, providerId, model),
    setEffort: (sessionId, effort) => call(CH.sessionsSetEffort, sessionId, effort),
  setEnvironment: (sessionId, environmentId) => call(CH.sessionsSetEnvironment, sessionId, environmentId),
    export: (sessionId) => call(CH.sessionsExport, sessionId),
    import: (json) => call(CH.sessionsImport, json),
    archive: (sessionId, archived) => call(CH.sessionsArchive, sessionId, archived),
    compact: (sessionId) => call(CH.sessionsCompact, sessionId),
    contextBreakdown: (sessionId) => call(CH.sessionsContextBreakdown, sessionId),
    rewind: (sessionId, messageId, restoreFiles) => call(CH.sessionsRewind, sessionId, messageId, restoreFiles),
    fork: (sessionId, messageId) => call(CH.sessionsFork, sessionId, messageId)
  },
  files: {
    tree: (root, depth) => call(CH.filesTree, root, depth),
    read: (root, relative) => call(CH.filesRead, root, relative),
    changes: (sessionId) => call(CH.filesChanges, sessionId),
    screenshot: () => call(CH.filesScreenshot),
    reveal: (target) => call(CH.filesReveal, target),
    write: (root, relative, content) => call(CH.filesWrite, root, relative, content),
    search: (root, query) => call(CH.filesSearch, root, query)
  },
  git: {
    status: (root) => call(CH.gitStatus, root),
    diff: (root, path, staged) => call(CH.gitDiff, root, path, staged),
    listWorktrees: (root) => call(CH.gitWorktreesList, root),
    createWorktree: (root, branch, baseRef) => call(CH.gitWorktreeCreate, root, branch, baseRef),
    removeWorktree: (root, path) => call(CH.gitWorktreeRemove, root, path)
  },
  preview: {
    detect: (root) => call(CH.previewDetect, root),
    start: (root, name, sessionId) => call(CH.previewStart, root, name, sessionId)
  },
  tasks: {
    list: (sessionId) => call(CH.tasksList, sessionId),
    output: (sessionId, pid) => call(CH.tasksOutput, sessionId, pid),
    stop: (sessionId, pid) => call(CH.tasksStop, sessionId, pid)
  },
  stt: {
    status: () => call(CH.sttStatus),
    start: (options) => call(CH.sttStart, options),
    preload: (options) => call(CH.sttPreload, options),
    stop: () => call(CH.sttStop),
    audio: (pcm) => ipcRenderer.send(CH.sttAudio, pcm),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SttEvent): void => callback(payload)
      ipcRenderer.on(CH.sttEvent, listener)
      return () => ipcRenderer.removeListener(CH.sttEvent, listener)
    }
  },
  tts: {
    voices: (provider) => call(CH.ttsVoices, provider),
    status: () => call(CH.ttsStatus),
    speak: (options) => call(CH.ttsSpeak, options),
    stop: () => call(CH.ttsStop),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TtsState): void => callback(payload)
      ipcRenderer.on(CH.ttsEvent, listener)
      return () => ipcRenderer.removeListener(CH.ttsEvent, listener)
    }
  },
  dictation: {
    onToggle: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(CH.dictationToggle, listener)
      return () => ipcRenderer.removeListener(CH.dictationToggle, listener)
    },
    onComposerInsert: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { text?: string }): void => {
        if (typeof payload?.text === 'string') callback(payload.text)
      }
      ipcRenderer.on(CH.dictationComposer, listener)
      return () => ipcRenderer.removeListener(CH.dictationComposer, listener)
    },
    state: (state) => ipcRenderer.send(CH.dictationState, state),
    insert: (text) => call(CH.dictationInsert, text)
  },
  commands: {
    list: (cwd) => call(CH.commandsList, cwd)
  },
  improvements: {
    status: (projectId) => call(CH.improvementsStatus, projectId),
    start: (projectId, options) => call(CH.improvementsStart, projectId, options),
    cancel: () => call(CH.improvementsCancel),
    setWeekly: (projectId, enabled, options) => call(CH.improvementsWeekly, projectId, enabled, options)
  },
  memory: {
    status: (projectId) => call(CH.memoryStatus, projectId),
    list: (projectId) => call(CH.memoryList, projectId),
    read: (projectId, slug) => call(CH.memoryRead, projectId, slug),
    delete: (projectId, slug) => call(CH.memoryDelete, projectId, slug),
    invalidate: (projectId, slug, reason) => call(CH.memoryInvalidate, projectId, slug, reason),
    open: (projectId) => call(CH.memoryOpen, projectId),
    recall: (projectId, query, limit) => call(CH.memoryRecall, projectId, query, limit),
    aiStatus: () => call(CH.memoryAiStatus),
    graph: (projectId, query) => call(CH.memoryGraph, projectId, query ?? ''),
    exportMarkdown: (projectId) => call(CH.memoryExport, projectId),
    importMarkdown: (projectId) => call(CH.memoryImport, projectId),
    importZip: (projectId) => call(CH.memoryImportZip, projectId),
    files: (projectId) => call(CH.memoryFiles, projectId),
    fileThumb: (projectId, slug) => call(CH.memoryFileThumb, projectId, slug),
    openFile: (projectId, slug) => call(CH.memoryOpenFile, projectId, slug),
    addFiles: (projectId, pick) => call(CH.memoryAddFiles, projectId, pick),
    addStatus: (projectId) => call(CH.memoryAddStatus, projectId)
  },
  power: {
    keepAwake: (enabled) => call(CH.powerKeepAwake, enabled),
    state: () => call(CH.powerState)
  },
  schedules: {
    list: () => call(CH.schedulesList),
    create: (input) => call(CH.schedulesCreate, input),
    update: (taskId, patch) => call(CH.schedulesUpdate, taskId, patch),
    remove: (taskId) => call(CH.schedulesRemove, taskId),
    runNow: (taskId) => call(CH.schedulesRunNow, taskId)
  },
  approvals: {
    resolve: (approvalId, approved, always, reason) => call(CH.approvalsResolve, approvalId, approved, always, reason),
    saved: () => call(CH.approvalsSaved),
    revoke: (projectId, rule, effect) => call(CH.approvalsRevoke, projectId, rule, effect)
  },
  questions: {
    answer: (questionId, answers) => call(CH.questionsAnswer, questionId, answers)
  },
  inbox: {
    list: (sessionId) => call(CH.inboxList, sessionId),
    add: (sessionId, text, images, mode, origin) => call(CH.inboxAdd, sessionId, text, images, mode, origin),
    remove: (sessionId, itemId) => call(CH.inboxRemove, sessionId, itemId),
    clear: (sessionId) => call(CH.inboxClear, sessionId)
  },
  mcp: {
    restart: () => call(CH.mcpRestart)
  },
  terminal: {
    shells: () => call(CH.terminalShells),
    list: () => call(CH.terminalList),
    create: (input) => call(CH.terminalCreate, input),
    snapshot: (terminalId) => call(CH.terminalSnapshot, terminalId),
    kill: (terminalId) => call(CH.terminalKill, terminalId),
    write: (terminalId, data) => ipcRenderer.send(CH.terminalWrite, terminalId, data),
    resize: (terminalId, cols, rows) => ipcRenderer.send(CH.terminalResize, terminalId, cols, rows),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalEvent): void => callback(payload)
      ipcRenderer.on(CH.terminalEvent, listener)
      return () => ipcRenderer.removeListener(CH.terminalEvent, listener)
    }
  },
  window: {
    minimize: () => ipcRenderer.send(CH.winMinimize),
    maximize: () => ipcRenderer.send(CH.winMaximize),
    close: () => ipcRenderer.send(CH.winClose),
    isMaximized: () => ipcRenderer.invoke(CH.winIsMaximized) as Promise<boolean>
  },
  events: {
    on: (callback: (event: HarnessEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: HarnessEvent): void => callback(payload)
      ipcRenderer.on(CH.event, listener)
      return () => ipcRenderer.removeListener(CH.event, listener)
    }
  }
}

contextBridge.exposeInMainWorld('openclod', api)
