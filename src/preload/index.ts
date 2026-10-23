import { contextBridge, ipcRenderer } from 'electron'
import { CH, type ForjaApi, type IpcResult, type SttEvent, type TerminalEvent } from '../shared/api.js'
import type { HarnessEvent } from '../shared/types.js'

function call<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

const api: ForjaApi = {
  app: {
    capabilities: () => call(CH.appCapabilities),
    presets: () => call(CH.appPresets),
    settings: () => call(CH.appSettings),
    updateSettings: (patch) => call(CH.appUpdateSettings, patch),
    setSecret: (providerId, value) => call(CH.appSetSecret, providerId, value),
    clearSecret: (providerId) => call(CH.appClearSecret, providerId),
    testProvider: (providerId) => call(CH.appTestProvider, providerId),
    versions: () => call(CH.appVersions),
    skills: () => call(CH.appSkills),
    notify: (title, body) => call(CH.appNotify, title, body),
    createSkill: (name, description, body) => call(CH.appCreateSkill, name, description, body),
    discoverModels: (providerId) => call(CH.appDiscoverModels, providerId),
    mcpPresets: () => call(CH.appMcpPresets),
    openSkillsFolder: () => call(CH.appOpenSkills)
  },
  projects: {
    list: () => call(CH.projectsList),
    add: (folder, name) => call(CH.projectsAdd, folder, name),
    remove: (projectId) => call(CH.projectsRemove, projectId),
    pick: () => call(CH.projectsPick)
  },
  sessions: {
    list: () => call(CH.sessionsList),
    create: (input) => call(CH.sessionsCreate, input),
    get: (sessionId) => call(CH.sessionsGet, sessionId),
    delete: (sessionId) => call(CH.sessionsDelete, sessionId),
    rename: (sessionId, title) => call(CH.sessionsRename, sessionId, title),
    send: (sessionId, text, images) => call(CH.sessionsSend, sessionId, text, images),
    abort: (sessionId) => call(CH.sessionsAbort, sessionId),
    setMode: (sessionId, mode) => call(CH.sessionsSetMode, sessionId, mode),
    setModel: (sessionId, providerId, model) => call(CH.sessionsSetModel, sessionId, providerId, model),
    setEffort: (sessionId, effort) => call(CH.sessionsSetEffort, sessionId, effort),
    export: (sessionId) => call(CH.sessionsExport, sessionId),
    import: (json) => call(CH.sessionsImport, json),
    archive: (sessionId, archived) => call(CH.sessionsArchive, sessionId, archived),
    compact: (sessionId) => call(CH.sessionsCompact, sessionId)
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
    diff: (root, path, staged) => call(CH.gitDiff, root, path, staged)
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
    stop: () => call(CH.sttStop),
    audio: (pcm) => ipcRenderer.send(CH.sttAudio, pcm),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SttEvent): void => callback(payload)
      ipcRenderer.on(CH.sttEvent, listener)
      return () => ipcRenderer.removeListener(CH.sttEvent, listener)
    }
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
    resolve: (approvalId, approved, always) => call(CH.approvalsResolve, approvalId, approved, always)
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

contextBridge.exposeInMainWorld('forja', api)
