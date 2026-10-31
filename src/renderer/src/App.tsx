import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type {
  AgentMode,
  AppSettings,
  ApprovalRequest,
  BudgetInfo,
  CapabilityReport,
  FileChange,
  HarnessEvent,
  ImagePart,
  PermissionMode,
  Project,
  QuestionAnswer,
  QuestionRequest,
  ReasoningEffort,
  RunState,
  SessionState,
  SessionSummary,
  SessionSurface,
  SkillInfo,
  Usage
} from '../../shared/types'
import { DEFAULT_LOOP_BUDGET, defaultAgentMode } from '../../shared/types'
import type { AppVersions, ProviderPresetInfo } from '../../shared/api'
import { billableTokens } from '../../shared/limits'
import { Sidebar, type SidebarPage } from './components/Sidebar'
import { ProjectsPage } from './components/ProjectsPage'
import { ScheduledPage } from './components/ScheduledPage'
import { CustomizePage, type CustomizeTab } from './components/CustomizePage'
import type { SettingsTab } from './components/SettingsDialog'
import { Transcript } from './components/Transcript'
import { Composer, type ProviderMenuState, type QueuedMessage } from './components/Composer'
import { describeFailure } from '../../core/providers/health'
import { ApprovalDock } from './components/ApprovalDock'
import { QuestionDock } from './components/QuestionDock'
import { BudgetDock } from './components/BudgetDock'
import { SessionPanel, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, type PanelLayout } from './components/SessionPanel'
import { PlanDock } from './components/PlanDock'
import { LoopDock } from './components/LoopDock'
import { reduceActivity, type ActivityState } from './lib/activity'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SettingsDialog } from './components/SettingsDialog'
import { DictationHost } from './components/DictationHost'
import { HomeView } from './components/HomeView'
import { CoworkView } from './components/CoworkView'
import { MemoryPage } from './components/MemoryPage'
import { ArtifactsPage, DesignPage, DispatchPage, MorePage } from './components/MorePages'
import { OpenclodMark, MenuPopover, Titlebar, type MenuItem, type PanelTab } from './components/Chrome'
import { WorktreeDialog } from './components/WorktreeDialog'
import { RewindDialog } from './components/RewindDialog'
import { ActivityPage } from './components/ActivityPage'
import { Icon } from './components/Icons'
import { errorMessage, unwrap } from './lib/api'
import { cancelDictation } from './lib/dictation-store'
import { lastRequestTokens, shortPath } from './lib/format'
import type { LiveTool, LogEntry } from './lib/types'

const BUSY_STATES: RunState[] = ['thinking', 'streaming', 'tool', 'waiting_approval']

function normalizeState(state: RunState): RunState {
  return BUSY_STATES.includes(state) ? 'idle' : state
}

function mergeMessage(
  messages: SessionState['messages'],
  message: SessionState['messages'][number]
): SessionState['messages'] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index === -1) return [...messages, message]
  const next = [...messages]
  next[index] = message
  return next
}

const LAYOUT_KEY = 'openclod.panel.layout'
const EFFORT_KEY = 'openclod.effort'

function loadEffort(): ReasoningEffort | null {
  try {
    const value = localStorage.getItem(EFFORT_KEY)
    return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' ? value : null
  } catch {
    return null
  }
}

function loadLayout(): PanelLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<PanelLayout>
    return {
      side: raw.side === 'left' ? 'left' : 'right',
      maximized: false,
      width: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Number(raw.width) || 600))
    }
  } catch {
    return { side: 'right', maximized: false, width: 600 }
  }
}

/** Keys typed inside the terminal, the code editor or a web page belong to them. */
function inEmbeddedSurface(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.xterm, .cm-editor, .browser-pane'))
}

function logId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function slug(text: string): string {
  return text.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'sessao'
}

export default function App(): ReactElement {
  /* ------------------------------ data ------------------------------ */
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null)
  const [presets, setPresets] = useState<ProviderPresetInfo[]>([])
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])

  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [runState, setRunState] = useState<RunState>('idle')
  /** Latest run state for callbacks that must not close over a stale one. */
  const runStateRef = useRef<RunState>('idle')
  runStateRef.current = runState
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const [reasoning, setReasoning] = useState<Record<string, string>>({})
  const [tools, setTools] = useState<Record<string, LiveTool>>({})
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [question, setQuestion] = useState<QuestionRequest | null>(null)
  const [budget, setBudget] = useState<{ sessionId: string; info: BudgetInfo } | null>(null)
  const [turnUsage, setTurnUsage] = useState<Usage | null>(null)
  const [turnLimit, setTurnLimit] = useState(0)
  const [changes, setChanges] = useState<FileChange[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  /** What each session's agents are doing (commands, sub-agents); kept for every session while the app runs. */
  const [activityBySession, setActivityBySession] = useState<Record<string, ActivityState>>({})
  /** Sessions with a turn in progress, including the ones not on screen (sidebar dot). */
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set())
  const tasksAutoOpened = useRef<Set<string>>(new Set())
  const [queued, setQueued] = useState<QueuedMessage[]>([])

  /* ------------------------------- ui ------------------------------- */
  const [surface, setSurface] = useState<SessionSurface>('chat')
  const [composerSeed, setComposerSeed] = useState<{ id: string; text: string; sessionId: string | null } | undefined>(undefined)
  const [dictationInsert, setDictationInsert] = useState<{ id: string; text: string; sessionId: string | null } | undefined>(undefined)

  useEffect(
    () =>
      window.openclod.dictation.onComposerInsert((text) => {
        setDictationInsert({ id: logId(), text, sessionId: activeSessionRef.current })
      }),
    []
  )
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelTab, setPanelTab] = useState<PanelTab | null>(null)
  const [planFocus, setPlanFocus] = useState<string | null>(null)
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(loadLayout)
  /** Depth used by new sessions; each session keeps its own once created. */
  const [defaultEffort, setDefaultEffort] = useState<ReasoningEffort | null>(loadEffort)
  const defaultEffortRef = useRef(defaultEffort)
  defaultEffortRef.current = defaultEffort
  const [page, setPage] = useState<SidebarPage | null>(null)
  const [memoryGraphRequest, setMemoryGraphRequest] = useState(0)
  /** A page the Activity screen asked the Memory screen to open (a review report). */
  const [memoryOpen, setMemoryOpen] = useState<{ id: number; projectId: string; slug: string } | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined)
  /** A tab of Personalização that another screen asked for ("Abrir Conectores" in Configurações → MCP). */
  const [customizeOpenTab, setCustomizeOpenTab] = useState<{ tab: CustomizeTab; nonce: number } | null>(null)
  useEffect(() => {
    if (page !== 'customize') setCustomizeOpenTab(null)
  }, [page])
  const [keepAwake, setKeepAwake] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [worktreeProject, setWorktreeProject] = useState<Project | null>(null)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [titleMenuOpen, setTitleMenuOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState<{ level: 'info' | 'warn' | 'error'; text: string } | null>(null)

  const activeSessionRef = useRef<string | null>(null)
  /** Invalidates an older sessions.get/create response that resolves late. */
  const sessionEpoch = useRef(0)
  const projectsRef = useRef<Project[]>([])
  const sessionsRef = useRef<SessionSummary[]>([])
  const historyRef = useRef<{ ids: string[]; index: number }>({ ids: [], index: -1 })
  const queuedRef = useRef<QueuedMessage[]>([])
  const queueSessionRef = useRef<string | null>(null)
  const drainingRef = useRef(false)
  const importRef = useRef<HTMLInputElement>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  activeSessionRef.current = activeSessionId
  projectsRef.current = projects
  sessionsRef.current = sessions
  queuedRef.current = queued

  const pushLog = useCallback((level: LogEntry['level'], text: string) => {
    setLogs((current) => [...current.slice(-499), { id: logId(), ts: Date.now(), level, text }])
  }, [])

  const syncHistory = useCallback((): void => {
    const history = historyRef.current
    setCanBack(history.index > 0)
    setCanForward(history.index >= 0 && history.index < history.ids.length - 1)
  }, [])

  const rememberSession = useCallback(
    (sessionId: string): void => {
      const history = historyRef.current
      if (history.ids[history.index] === sessionId) return
      history.ids = [...history.ids.slice(0, history.index + 1), sessionId]
      history.index = history.ids.length - 1
      syncHistory()
    },
    [syncHistory]
  )

  const refreshCapabilities = useCallback(async (): Promise<void> => {
    try {
      setCapabilities(await unwrap(window.openclod.app.capabilities()))
    } catch {
      /* capabilities are informational */
    }
  }, [])

  const refreshSkills = useCallback(async (): Promise<void> => {
    try {
      setSkills(await unwrap(window.openclod.app.skills()))
    } catch {
      /* skills are optional */
    }
  }, [])

  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    try {
      const list = await unwrap(window.openclod.sessions.list())
      setSessions(list)
      return list
    } catch (err) {
      setError(errorMessage(err))
      return []
    }
  }, [])

  const clearSession = useCallback((): void => {
    // Also invalidates any request that is still in flight for the session
    // that is being left behind.
    sessionEpoch.current += 1
    activeSessionRef.current = null
    setActiveSessionId(null)
    setSession(null)
    setRunState('idle')
    setStreaming({})
    setReasoning({})
    setTools({})
    setApprovals([])
    setChanges([])
    setPanelTab(null)
  }, [])

  const applySession = useCallback((state: SessionState): void => {
    activeSessionRef.current = state.meta.id
    setActiveSessionId(state.meta.id)
    setSession(state)
    setRunState(normalizeState(state.state))
    setStreaming({})
    setReasoning({})
    setTools({})
    // Approvals still waiting in this session come back with it (they are no longer lost on a switch).
    setApprovals(state.approvals ?? [])
    setError('')
    setChanges(state.changes)
    setSurface(state.meta.surface ?? 'code')
    // The session carries its project id; matching by cwd fails for worktrees
    // and could leave the sidebar on project A while showing project B's chat.
    const project = projectsRef.current.find((item) => item.id === state.meta.projectId)
    if (project) setActiveProjectId(project.id)
  }, [])

  const openSession = useCallback(
    async (sessionId: string, options?: { record?: boolean }): Promise<SessionState | null> => {
      // Blank the transcript immediately: while the file is loading, the old
      // project's messages must not be visible or accept input.
      clearSession()
      const epoch = ++sessionEpoch.current
      try {
        const state = await unwrap(window.openclod.sessions.get(sessionId))
        // A slower request for the previous project must never replace the
        // session the user is looking at now.
        if (epoch !== sessionEpoch.current) return state
        applySession(state)
        if (options?.record !== false) rememberSession(sessionId)
        return state
      } catch (err) {
        if (epoch === sessionEpoch.current) setError(errorMessage(err))
        return null
      }
    },
    [applySession, rememberSession, clearSession]
  )

  const selectSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const summary = sessionsRef.current.find((item) => item.meta.id === sessionId)
      if (summary) setActiveProjectId(summary.meta.projectId)
      await openSession(sessionId)
    },
    [openSession]
  )

  const createSession = useCallback(
    async (project: Project, targetSurface: SessionSurface = surface, sessionCwd = project.path): Promise<SessionState | null> => {
      if (!settings) return null
      // Never keep project A's transcript visible while project B's session is
      // being created: the user could send A's text into B (or vice versa).
      if (!session || session.meta.projectId !== project.id) clearSession()
      const epoch = sessionEpoch.current
      // Each project remembers its own LLM. The global last model is only a
      // fallback for projects that never chose one.
      const preferred = project.model ?? settings.lastModel
      const provider =
        settings.providers.find((item) => item.id === preferred?.providerId) ??
        settings.providers.find((item) => item.id === settings.defaultProviderId) ??
        settings.providers[0]
      if (!provider) {
        setError('Nenhum provedor configurado. Abra as configurações.')
        setSettingsOpen(true)
        return null
      }
      const model = preferred?.providerId === provider.id && preferred.model ? preferred.model : provider.model
      try {
        const meta = await unwrap(
          window.openclod.sessions.create({
            projectId: project.id,
            cwd: sessionCwd,
            mode: defaultAgentMode(targetSurface),
            surface: targetSurface,
            providerId: provider.id,
            model
          })
        )
        // Provider/model default first; the global choice is only a fallback.
        const initialEffort = provider.defaultEffort ?? defaultEffortRef.current
        if (initialEffort) {
          await unwrap(window.openclod.sessions.setEffort(meta.id, initialEffort))
        }
        // A project that never chose a model adopts the one used by its first
        // session, so a later choice in another project cannot change it.
        if (!project.model) {
          try {
            const updated = await unwrap(window.openclod.projects.setModel(project.id, provider.id, model))
            setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
          } catch {
            /* the session still works with its own model */
          }
        }
        await refreshSessions()
        // The user switched project/session while this request was in flight:
        // keep the created session for the send that requested it, but do not
        // pull it into the screen that now belongs to another project.
        if (epoch !== sessionEpoch.current) {
          return {
            meta,
            messages: [],
            plan: [],
            changes: [],
            approvals: [],
            usage: { input: 0, output: 0 },
            state: 'idle'
          }
        }
        return await openSession(meta.id)
      } catch (err) {
        if (epoch === sessionEpoch.current) setError(errorMessage(err))
        return null
      }
    },
    [settings, surface, refreshSessions, openSession, clearSession, session?.meta.projectId]
  )

  /* --------------------------- initial load --------------------------- */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [projectList, sessionList, settingsValue, capabilityValue, presetList, versionValue] = await Promise.all([
          unwrap(window.openclod.projects.list()),
          unwrap(window.openclod.sessions.list()),
          unwrap(window.openclod.app.settings()),
          unwrap(window.openclod.app.capabilities()).catch(() => null),
          unwrap(window.openclod.app.presets()),
          unwrap(window.openclod.app.versions())
        ])
        if (cancelled) return
        setProjects(projectList)
        setSessions(sessionList)
        setSettings(settingsValue)
        setCapabilities(capabilityValue)
        setPresets(presetList)
        setVersions(versionValue)

        if (projectList[0]) setActiveProjectId(projectList[0].id)
        void refreshSkills()
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshSkills])

  /* ------------------------------- theme ------------------------------ */

  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [settings?.theme])

  /* ------------------------------ events ------------------------------ */

  useEffect(() => {
    const off = window.openclod.events.on((event: HarnessEvent) => {
      // Activity and the "working" dot are tracked for every session, not only the one on screen.
      if (event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'subagent' || event.type === 'turn_end' || event.type === 'status') {
        const at = Date.now()
        setActivityBySession((current) => {
          const before = current[event.sessionId] ?? []
          const after = reduceActivity(before, event, at)
          return after === before ? current : { ...current, [event.sessionId]: after }
        })
      }
      if (event.type === 'turn_start' || event.type === 'turn_end' || (event.type === 'status' && !['thinking', 'streaming', 'tool', 'waiting_approval'].includes(event.state))) {
        const busy = event.type === 'turn_start'
        setBusySessions((current) => {
          if (current.has(event.sessionId) === busy) return current
          const next = new Set(current)
          if (busy) next.add(event.sessionId)
          else next.delete(event.sessionId)
          return next
        })
        if (event.type === 'turn_start' && event.sessionId === activeSessionRef.current) {
          setTurnUsage(null)
          setBudget((current) => (current?.sessionId === event.sessionId ? null : current))
        }
      }
      // A model that ran out of balance/limit was replaced: the session (and so the model picker in the composer, the
      // context meter and the sidebar) shows the model that is answering now, not the one that failed.
      if (event.type === 'model_switch') {
        const follow = (meta: SessionState['meta']): SessionState['meta'] => ({ ...meta, providerId: event.to.providerId, model: event.to.model })
        setSessions((current) => current.map((item) => (item.meta.id === event.sessionId ? { ...item, meta: follow(item.meta) } : item)))
        if (event.sessionId === activeSessionRef.current) {
          setSession((current) => (current && current.meta.id === event.sessionId ? { ...current, meta: follow(current.meta) } : current))
        }
        // The provider that failed now shows why in Settings → Provedores.
        void window.openclod.app.capabilities().then((result) => {
          if (result.ok) setCapabilities(result.value)
        })
      }
      // The first time an agent is called in a session, show the tasks panel (as Claude Desktop does).
      if (event.type === 'subagent' && event.sessionId === activeSessionRef.current && !tasksAutoOpened.current.has(event.sessionId)) {
        tasksAutoOpened.current.add(event.sessionId)
        setPanelTab((current) => current ?? 'tasks')
      }
      // Sessions started in the background (scheduled tasks) must show up in the sidebar.
      if (event.type === 'session_start' || (event.type === 'turn_end' && event.sessionId !== activeSessionRef.current)) {
        void refreshSessions()
      }
      if (event.type === 'settings_changed') {
        void window.openclod.app.settings().then((result) => {
          if (result.ok) setSettings(result.value)
        })
        if (event.scope === 'mcp' || event.scope === 'browser') void refreshCapabilities()
      }
      if (event.sessionId !== activeSessionRef.current) return
      switch (event.type) {
        case 'turn_start':
          setRunState('thinking')
          break
        case 'text_delta':
          setStreaming((current) => ({ ...current, [event.messageId]: (current[event.messageId] ?? '') + event.text }))
          break
        case 'reasoning_delta':
          setReasoning((current) => ({
            ...current,
            [event.messageId]: (current[event.messageId] ?? '') + event.text
          }))
          break
        case 'message':
          setSession((current) =>
            current ? { ...current, messages: mergeMessage(current.messages, event.message) } : current
          )
          setStreaming((current) => {
            const next = { ...current }
            delete next[event.message.id]
            return next
          })
          setReasoning((current) => {
            const next = { ...current }
            delete next[event.message.id]
            return next
          })
          break
        case 'tool_start':
          setTools((current) => ({
            ...current,
            [event.toolCallId]: {
              id: event.toolCallId,
              name: event.name,
              args: event.args,
              running: true,
              startedAt: Date.now()
            }
          }))
          break
        case 'tool_progress':
          setTools((current) => {
            const previous = current[event.toolCallId]
            if (!previous) return current
            return {
              ...current,
              [event.toolCallId]: {
                ...previous,
                progress: event.text || previous.progress,
                text: event.text || previous.text,
                updatedAt: Date.now(),
                data: { ...(previous.data ?? {}), ...(event.data ?? {}) }
              }
            }
          })
          break
        case 'tool_end':
          setTools((current) => ({
            ...current,
            [event.toolCallId]: {
              id: event.toolCallId,
              name: event.name,
              args: current[event.toolCallId]?.args ?? {},
              summary: event.summary,
              ok: event.ok,
              text: event.text,
              files: event.files,
              data: event.data,
              running: false,
              startedAt: current[event.toolCallId]?.startedAt,
              progress: current[event.toolCallId]?.progress,
              updatedAt: current[event.toolCallId]?.updatedAt
            }
          }))
          break
        case 'status':
          setRunState(event.state)
          if (event.detail && event.state === 'error') setError(event.detail)
          break
        case 'plan':
          setSession((current) => (current ? { ...current, plan: event.items } : current))
          break
        case 'loop':
          setSession((current) => (current ? { ...current, loop: event.loop } : current))
          break
        case 'diff':
          setChanges(event.files)
          break
        case 'usage':
          setSession((current) => (current ? { ...current, usage: event.total } : current))
          if (event.sessionId === activeSessionRef.current) {
            if (event.turn) setTurnUsage(event.turn)
            if (event.limit !== undefined) setTurnLimit(event.limit)
          }
          break
        case 'budget':
          setBudget({ sessionId: event.sessionId, info: event.info })
          break
        case 'approval_request':
          setApprovals((current) => [...current.filter((item) => item.id !== event.request.id), event.request])
          if (document.hidden) {
            void window.openclod.app.notify('Openclod Desktop - aprovação necessária', event.request.title)
          }
          break
        case 'approval_resolved':
          setApprovals((current) => current.filter((item) => item.id !== event.id))
          break
        case 'question_request':
          setQuestion(event.request)
          if (document.hidden) {
            void window.openclod.app.notify(
              'Openclod Desktop - pergunta',
              'O agente precisa de mais contexto para continuar.'
            )
          }
          break
        case 'question_resolved':
          setQuestion((current) => (current?.id === event.id ? null : current))
          break
        case 'audit':
          pushLog(event.level === 'blocked' ? 'blocked' : event.level, event.message)
          break
        case 'notice':
          pushLog(event.level, event.text)
          if (event.level !== 'info') setToast({ level: event.level, text: event.text })
          break
        case 'turn_end':
          setRunState(event.stopReason === 'error' ? 'error' : 'done')
          setQuestion(null)
          void refreshSessions()
          if (document.hidden) {
            const title = sessionsRef.current.find((item) => item.meta.id === event.sessionId)?.meta.title ?? 'Openclod Desktop'
            void window.openclod.app.notify(
              event.stopReason === 'error' ? 'Openclod Desktop - turno com erro' : 'Openclod Desktop - turno concluído',
              event.error || title
            )
          }
          break
        default:
          break
      }
    })
    return off
  }, [pushLog, refreshSessions])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  /* --------------------------- panel layout --------------------------- */

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ side: panelLayout.side, width: panelLayout.width }))
    } catch {
      /* storage unavailable */
    }
  }, [panelLayout.side, panelLayout.width])

  useEffect(() => {
    setPlanFocus(null)
    setTurnUsage(null)
    setTurnLimit(0)
    setBudget(null)
  }, [session?.meta.id])

  useEffect(() => {
    void window.openclod.power.state().then((result) => result.ok && setKeepAwake(result.value))
  }, [])

  const toggleKeepAwake = useCallback(async (): Promise<void> => {
    try {
      setKeepAwake(await unwrap(window.openclod.power.keepAwake(!keepAwake)))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [keepAwake])

  /* --------------------------- window state --------------------------- */

  useEffect(() => {
    const check = (): void => {
      void window.openclod.window.isMaximized().then(setMaximized).catch(() => undefined)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /* ---------------------------- shortcuts ----------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (inEmbeddedSurface(event.target)) return
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (ctrl && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarOpen((value) => !value)
        return
      }
      if (ctrl && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        const project = projectsRef.current.find((item) => item.id === activeProjectId) ?? projectsRef.current[0]
        if (project) void createSession(project)
        return
      }
      if (ctrl && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        if (activeSessionRef.current) void exportSession(activeSessionRef.current)
        return
      }
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        // An open popover or dialog closes itself; Escape must not also close the panel.
        else if (document.querySelector('.menu-popover, .modal-backdrop')) return
        else if (panelTab) setPanelTab(null)
        else if (menuOpen || titleMenuOpen || optionsOpen) {
          setMenuOpen(false)
          setTitleMenuOpen(false)
          setOptionsOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, panelTab, menuOpen, titleMenuOpen, optionsOpen, activeProjectId, createSession])

  /* ------------------------------ actions ----------------------------- */

  const addProject = useCallback(async (): Promise<void> => {
    try {
      const folder = await unwrap(window.openclod.projects.pick())
      if (!folder) return
      const project = await unwrap(window.openclod.projects.add(folder))
      const list = await unwrap(window.openclod.projects.list())
      setProjects(list)
      setActiveProjectId(project.id)
      await createSession(project)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [createSession])

  const removeProject = useCallback(
    async (project: Project): Promise<void> => {
      try {
        await unwrap(window.openclod.projects.remove(project.id))
        const list = await unwrap(window.openclod.projects.list())
        setProjects(list)
        if (activeProjectId === project.id) {
          clearSession()
          setActiveProjectId(list[0]?.id ?? null)
        }
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [activeProjectId, clearSession]
  )

  const openMemoryGraph = useCallback((project: Project): void => {
    setPage('memory')
    setActiveProjectId(project.id)
    setMemoryGraphRequest((value) => value + 1)
  }, [])

  const deleteProject = useCallback(    async (project: Project): Promise<void> => {
      try {
        await unwrap(window.openclod.projects.delete(project.id))
        const [list, sessionList] = await Promise.all([
          unwrap(window.openclod.projects.list()),
          unwrap(window.openclod.sessions.list())
        ])
        setProjects(list)
        setSessions(sessionList)
        if (activeProjectId === project.id) {
          clearSession()
          setActiveProjectId(list[0]?.id ?? null)
        }
        setToast({ level: 'info', text: `Projeto ${project.name} excluído com sessões e memória.` })
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [activeProjectId, clearSession]
  )

  const selectProject = useCallback(
    async (project: Project): Promise<void> => {
      setActiveProjectId(project.id)
      // Clear first so a late response from the previous project cannot be
      // applied on top of this one.
      clearSession()
      const latest = sessionsRef.current.find(
        (item) => item.meta.projectId === project.id && (item.meta.surface ?? 'code') === surface
      )
      if (latest) await selectSession(latest.meta.id)
    },
    [selectSession, clearSession, surface]
  )

  const deleteSession = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await unwrap(window.openclod.sessions.delete(sessionId))
        const list = await refreshSessions()
        if (activeSessionRef.current === sessionId) {
          const project = projectsRef.current.find((item) => item.id === activeProjectId)
          const latest = project
            ? list.find(
                (item) =>
                  item.meta.projectId === project.id && (item.meta.surface ?? 'code') === surface
              )
            : undefined
          if (latest) await selectSession(latest.meta.id)
          else {
            clearSession()
          }
        }
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [activeProjectId, refreshSessions, selectSession, clearSession, surface]
  )

  const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    try {
      const state = await unwrap(window.openclod.sessions.rename(sessionId, title))
      setSessions((current) =>
        current.map((item) => (item.meta.id === sessionId ? { ...item, meta: state.meta } : item))
      )
      if (activeSessionRef.current === sessionId) {
        setSession((current) => (current ? { ...current, meta: state.meta } : current))
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const archiveSession = useCallback(
    async (sessionId: string, archived: boolean): Promise<void> => {
      try {
        await unwrap(window.openclod.sessions.archive(sessionId, archived))
        const list = await refreshSessions()
        setToast({ level: 'info', text: archived ? 'Sessão arquivada.' : 'Sessão restaurada.' })
        if (archived && activeSessionRef.current === sessionId) {
          const project = projectsRef.current.find((item) => item.id === activeProjectId)
          const latest = project
            ? list.find(
                (item) =>
                  !item.meta.archived &&
                  item.meta.projectId === project.id &&
                  (item.meta.surface ?? 'code') === surface
              )
            : undefined
          if (latest) await selectSession(latest.meta.id)
          else {
            clearSession()
          }
        }
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [activeProjectId, refreshSessions, selectSession, clearSession, surface]
  )

  const compactSession = useCallback(async (): Promise<void> => {
    const id = activeSessionRef.current
    if (!id) throw new Error('nenhuma sessão ativa')
    const state = await unwrap(window.openclod.sessions.compact(id))
    setSession(state)
    setToast({ level: 'info', text: 'Contexto compactado.' })
  }, [])

  const revealPath = useCallback(async (target: string): Promise<void> => {
    try {
      await unwrap(window.openclod.files.reveal(target))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const importSession = useCallback(
    async (file: File): Promise<void> => {
      try {
        const json = await file.text()
        const meta = await unwrap(window.openclod.sessions.import(json))
        await refreshSessions()
        await openSession(meta.id)
        setToast({ level: 'info', text: `Sessão "${meta.title}" importada.` })
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [refreshSessions, openSession]
  )

  const send = useCallback(
    async (text: string, images: ImagePart[], options?: { fresh?: boolean }): Promise<boolean> => {
      let target = activeSessionRef.current
      if (!target || options?.fresh) {
        let project = projectsRef.current.find((item) => item.id === activeProjectId) ?? null
        if (!project && surface === 'code') project = projectsRef.current[0] ?? null
        if (!project && surface === 'code') {
          setError('Abra uma pasta de projeto para começar no modo Code. O Chat e o Cowork funcionam sem projeto.')
          return false
        }
        if (!project) {
          // Home/Cowork work without a chosen project. The fallback root is the
          // user's Desktop (never Openclod's own data folder), and full access lets
          // the agent reach the rest of the computer.
          try {
            const ensured = await unwrap(window.openclod.projects.ensureDefault())
            project = ensured
            setProjects((current) => (current.some((item) => item.id === ensured.id) ? current : [ensured, ...current]))
          } catch (err) {
            setError(errorMessage(err))
            return false
          }
        }
        const created = await createSession(project)
        if (!created) return false
        target = created.meta.id
      }
      setError('')
      // Show "working" at once: the main process may need a few seconds to get the turn going (loading the session,
      // project memory...) and the user must see that the message was taken.
      const previousState = runStateRef.current
      setRunState('thinking')
      const slow = setTimeout(
        () => setToast({ level: 'info', text: 'Preparando a sessão… só demora assim na primeira mensagem depois de abrir o app.' }),
        4_000
      )
      try {
        const result = await window.openclod.sessions.send(target, text, images)
        if (!result.ok) {
          setRunState(previousState)
          setError(result.error)
          return false
        }
        return true
      } catch (err) {
        setRunState(previousState)
        setError(errorMessage(err))
        return false
      } finally {
        clearTimeout(slow)
      }
    },
    [activeProjectId, createSession, surface]
  )

  const stop = useCallback(async (): Promise<void> => {
    const id = activeSessionRef.current
    if (!id) return
    try {
      await unwrap(window.openclod.sessions.abort(id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const enqueue = useCallback((text: string, images: ImagePart[]): void => {
    if (!text.trim() && !images.length) return
    const localId = logId()
    setQueued((current) => [...current.slice(-24), { id: localId, text, images }])
    const sessionId = activeSessionRef.current
    if (!sessionId) return
    void window.openclod.inbox
      .add(sessionId, text, images, 'queue', 'ui')
      .then((result) => {
        if (!result.ok) return
        setQueued((current) => current.map((item) => (item.id === localId ? { ...item, id: result.value.id } : item)))
      })
      .catch(() => undefined)
  }, [])

  const removeQueued = useCallback((id: string): void => {
    setQueued((current) => current.filter((item) => item.id !== id))
    const sessionId = activeSessionRef.current
    if (sessionId) void window.openclod.inbox.remove(sessionId, id).catch(() => undefined)
  }, [])

  /**
   * Enviar com um turno em andamento: põe a mensagem na frente da fila e aborta o turno atual. Quando o turno
   * cancela, o dreno de fila (efeito abaixo) a envia como um novo turno — então o pedido do usuário é atendido
   * em vez de só esperar na fila, mesmo que o modelo tenha travado sem responder.
   */
  const interruptAndSend = useCallback(
    async (text: string, images: ImagePart[]): Promise<void> => {
      if (!text.trim() && !images.length) return
      const sessionId = activeSessionRef.current
      if (!sessionId) {
        void send(text, images, { fresh: true })
        return
      }
      const localId = logId()
      setQueued((current) => [{ id: localId, text, images }, ...current].slice(0, 25))
      void window.openclod.inbox
        .add(sessionId, text, images, 'queue', 'ui')
        .then((result) => {
          if (result.ok) setQueued((current) => current.map((item) => (item.id === localId ? { ...item, id: result.value.id } : item)))
        })
        .catch(() => undefined)
      await stop()
    },
    [send, stop]
  )

  /** Sends a queued prompt right away: inject as steer while busy, or start a turn. */
  const sendQueuedNow = useCallback(
    async (id: string): Promise<void> => {
      const item = queuedRef.current.find((entry) => entry.id === id)
      const sessionId = activeSessionRef.current
      if (!item || !sessionId || queueSessionRef.current !== sessionId) return
      const steer = BUSY_STATES.includes(runState)
      setQueued((current) => current.filter((entry) => entry.id !== id))
      try {
        await window.openclod.inbox.remove(sessionId, id).catch(() => undefined)
        const result = await window.openclod.sessions.send(sessionId, item.text, item.images, steer ? 'steer' : 'auto')
        if (!result.ok) throw new Error(result.error)
        if (steer) setToast({ level: 'info', text: 'Mensagem enviada ao turno em execução.' })
        else setRunState('thinking')
      } catch (err) {
        setQueued((current) =>
          queueSessionRef.current === sessionId
            ? [item, ...current.filter((entry) => entry.id !== item.id)]
            : current
        )
        setError(errorMessage(err))
      }
    },
    [runState]
  )

  useEffect(() => {
    if (drainingRef.current) return
    if (!['done', 'idle', 'error', 'cancelled'].includes(runState)) return
    const next = queuedRef.current[0]
    const sessionId = activeSessionRef.current
    if (!next || !sessionId || queueSessionRef.current !== sessionId) return
    drainingRef.current = true
    setQueued((current) => current.filter((item) => item.id !== next.id))
    void window.openclod.inbox.remove(sessionId, next.id).catch(() => undefined)
    void send(next.text, next.images)
      .then((ok) => {
        if (!ok && queueSessionRef.current === sessionId) {
          setQueued((current) => [next, ...current])
        }
      })
      .finally(() => {
        drainingRef.current = false
      })
  }, [runState, send])

  // Reinicia a fila da interface que sobreviveu a um fechamento do app.
  useEffect(() => {
    const sessionId = activeSessionId
    queueSessionRef.current = sessionId
    setQueued([])
    queuedRef.current = []
    if (!sessionId) return
    void window.openclod.inbox
      .list(sessionId)
      .then((result) => {
        if (!result.ok || queueSessionRef.current !== sessionId) return
        const pending = result.value
          .filter((item) => item.origin === 'ui' && item.mode === 'queue')
          .map((item) => ({ id: item.id, text: item.text, images: item.images }))
        if (pending.length) setQueued(pending)
      })
      .catch(() => undefined)
  }, [activeSessionId])

  // Drafts, seeded text, dictation and queued prompts belong to one session.
  // Never carry them into another project when the user switches.
  useEffect(() => {
    cancelDictation()
    setComposerSeed(undefined)
    setDictationInsert(undefined)
  }, [activeSessionId])

  const changeEnvironment = useCallback(async (environmentId: string): Promise<void> => {
    const id = activeSessionRef.current
    if (!id) return
    try {
      await unwrap(window.openclod.sessions.setEnvironment(id, environmentId))
      const patch = (meta: SessionState['meta']): SessionState['meta'] => ({ ...meta, environment: environmentId })
      setSession((current) => (current ? { ...current, meta: patch(current.meta) } : current))
      setSessions((current) => current.map((item) => (item.meta.id === id ? { ...item, meta: patch(item.meta) } : item)))
      setToast({ level: 'info', text: `Ambiente: ${environmentId}` })
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const changeMode = useCallback(async (agentMode: AgentMode): Promise<void> => {    const id = activeSessionRef.current
    if (!id) return
    try {
      await unwrap(window.openclod.sessions.setMode(id, agentMode))
      const patch = (meta: SessionState['meta']): SessionState['meta'] => ({ ...meta, mode: agentMode })
      setSession((current) => (current ? { ...current, meta: patch(current.meta) } : current))
      setSessions((current) =>
        current.map((item) => (item.meta.id === id ? { ...item, meta: patch(item.meta) } : item))
      )
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const changeModel = useCallback(async (providerId: string, model: string): Promise<void> => {
    const id = activeSessionRef.current
    const projectId = session?.meta.projectId ?? activeProjectId
    try {
      // Global fallback for projects that never chose a model.
      await unwrap(window.openclod.app.rememberModel(providerId, model))
      if (id) await unwrap(window.openclod.sessions.setModel(id, providerId, model))
      // The choice belongs to the project: switching to another project keeps
      // that project's own LLM.
      if (projectId) {
        const updated = await unwrap(window.openclod.projects.setModel(projectId, providerId, model))
        setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      }
      setSettings((current) => (current ? { ...current, lastModel: { providerId, model } } : current))
      if (!id) return
      const patch = (meta: SessionState['meta']): SessionState['meta'] => ({ ...meta, providerId, model })
      setSession((current) => (current ? { ...current, meta: patch(current.meta) } : current))
      setSessions((current) =>
        current.map((item) => (item.meta.id === id ? { ...item, meta: patch(item.meta) } : item))
      )
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [activeProjectId, session?.meta.projectId])

  const resolveApproval = useCallback(
    async (approvalId: string, approved: boolean, always: boolean, reason = ''): Promise<void> => {
      setApprovals((current) => current.filter((item) => item.id !== approvalId))
      try {
        await unwrap(window.openclod.approvals.resolve(approvalId, approved, always, reason))
        pushLog('info', `aprovação ${approved ? 'concedida' : 'negada'}${always ? ' (sempre nesta sessão)' : ''}`)
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [pushLog]
  )

  const answerQuestion = useCallback(
    async (questionId: string, answers: QuestionAnswer[]): Promise<void> => {
      setQuestion((current) => (current?.id === questionId ? null : current))
      try {
        await unwrap(window.openclod.questions.answer(questionId, answers))
        pushLog('info', answers.length ? 'respostas enviadas ao agente' : 'perguntas puladas')
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [pushLog]
  )

  const continueBudget = useCallback((): void => {
    setBudget(null)
    void send('continuar de onde parou', [])
  }, [send])

  const changeEffort = useCallback(
    async (next: ReasoningEffort | null): Promise<void> => {
      setDefaultEffort(next)
      try {
        if (next) localStorage.setItem(EFFORT_KEY, next)
        else localStorage.removeItem(EFFORT_KEY)
      } catch {
        /* storage unavailable */
      }
      if (!session) return
      try {
        await unwrap(window.openclod.sessions.setEffort(session.meta.id, next))
        setSession((current) => (current ? { ...current, meta: { ...current.meta, effort: next ?? undefined } } : current))
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [session]
  )

  const changePermission = useCallback(
    async (mode: PermissionMode): Promise<void> => {
      if (!settings) return
      try {
        await saveSettings({ policy: { ...settings.policy, mode } })
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings]
  )

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>): Promise<void> => {
      const before = session ? await unwrap(window.openclod.app.settings()).catch(() => null) : null
      const next = await unwrap(window.openclod.app.updateSettings(patch))
      setSettings(next)
      void refreshCapabilities()

      if (session && runState === 'idle') {
        const own = next.providers.find((item) => item.id === session.meta.providerId)
        const provider = own ?? next.providers.find((item) => item.id === next.defaultProviderId) ?? next.providers[0]
        // The session follows the model written in the provider's card only when the user just edited it (and the
        // session was on it), or when its provider is gone. Saving anything else must not undo the model picked in the
        // composer, nor the one a reserve switch moved the conversation to.
        const was = before?.providers.find((item) => item.id === session.meta.providerId)?.model
        const followsCard = !own || (was !== undefined && was !== provider?.model && session.meta.model === was)
        if (provider && followsCard && (provider.id !== session.meta.providerId || provider.model !== session.meta.model)) {
          await unwrap(window.openclod.sessions.setModel(session.meta.id, provider.id, provider.model))
          setSession((current) =>
            current
              ? { ...current, meta: { ...current.meta, providerId: provider.id, model: provider.model } }
              : current
          )
        }
      }
    },
    [session, runState, refreshCapabilities]
  )

  const refreshChanges = useCallback(async (): Promise<void> => {
    if (!activeSessionRef.current) return
    try {
      setChanges(await unwrap(window.openclod.files.changes(activeSessionRef.current)))
    } catch {
      /* informational */
    }
  }, [])

  useEffect(() => {
    if (runState === 'done' || runState === 'idle') void refreshChanges()
  }, [runState, refreshChanges])

  const exportSession = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const json = await unwrap(window.openclod.sessions.export(sessionId))
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const title = sessionsRef.current.find((item) => item.meta.id === sessionId)?.meta.title ?? 'sessao'
      link.download = `${slug(title)}.openclod.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const rewindConversation = useCallback(async (messageId: string, restoreFiles = false): Promise<boolean> => {
    const active = session
    if (!active) return false
    try {
      const state = await unwrap(window.openclod.sessions.rewind(active.meta.id, messageId, restoreFiles))
      applySession(state)
      setSessions((current) => current.map((item) => item.meta.id === state.meta.id ? { ...item, meta: state.meta } : item))
      setRewindOpen(false)
      setToast({ level: 'info', text: restoreFiles ? 'Conversa e checkpoint Git restaurados. Um backup do estado anterior foi criado.' : 'Conversa restaurada. Os arquivos atuais foram mantidos.' })
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    }
  }, [session, applySession])

  const forkConversation = useCallback(async (messageId: string): Promise<boolean> => {
    const active = session
    if (!active) return false
    try {
      const state = await unwrap(window.openclod.sessions.fork(active.meta.id, messageId))
      await refreshSessions()
      setActiveProjectId(state.meta.projectId)
      rememberSession(state.meta.id)
      await openSession(state.meta.id, { record: false })
      setRewindOpen(false)
      setToast({ level: 'info', text: 'Chat lateral criado com o contexto selecionado.' })
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    }
  }, [session, refreshSessions, rememberSession, openSession])

  const runCommand = useCallback(
    (command: string): void => {
      const id = activeSessionRef.current
      switch (command) {
        case 'new': {
          const project = projectsRef.current.find((item) => item.id === activeProjectId) ?? projectsRef.current[0]
          if (project) void createSession(project)
          else void addProject()
          break
        }
        case 'compact':
          void compactSession().catch((err) => setError(errorMessage(err)))
          break
        case 'export':
          if (id) void exportSession(id)
          else setToast({ level: 'info', text: 'Nenhuma sessão para exportar.' })
          break
        case 'archive':
          if (id) void archiveSession(id, true)
          else setToast({ level: 'info', text: 'Nenhuma sessão para arquivar.' })
          break
        case 'clear-queue':
          setQueued([])
          setToast({ level: 'info', text: 'Fila esvaziada.' })
          break
        case 'theme':
          if (settings) void saveSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
          break
        case 'settings':
          setSettingsOpen(true)
          break
        case 'skills':
          setToast({
            level: 'info',
            text: skills.length
              ? `${skills.length} skill(s): ${skills.map((skill) => skill.name).join(', ')}`
              : 'Nenhuma skill instalada em %APPDATA%\\Openclod Desktop\\skills.'
          })
          break
        default:
          break
      }
    },
    [
      activeProjectId,
      addProject,
      archiveSession,
      compactSession,
      createSession,
      exportSession,
      saveSettings,
      settings,
      skills
    ]
  )

  /* ------------------------------- nav -------------------------------- */

  const goBack = useCallback(async (): Promise<void> => {
    const history = historyRef.current
    if (history.index <= 0) return
    history.index -= 1
    syncHistory()
    await openSession(history.ids[history.index], { record: false })
  }, [openSession, syncHistory])

  const goForward = useCallback(async (): Promise<void> => {
    const history = historyRef.current
    if (history.index >= history.ids.length - 1) return
    history.index += 1
    syncHistory()
    await openSession(history.ids[history.index], { record: false })
  }, [openSession, syncHistory])

  const togglePanel = useCallback(
    (tab: PanelTab): void => {
      if (!activeSessionRef.current) {
        setToast({ level: 'info', text: 'Abra uma sessão para usar o painel lateral.' })
        return
      }
      setPanelTab((current) => (current === tab ? null : tab))
    },
    []
  )

  /** Clicking a plan step opens the right panel focused on that step. */
  const openPlanStep = useCallback((itemId: string): void => {
    setPlanFocus(itemId)
    setPanelTab('plan')
    setPanelLayout((current) => (current.side === 'right' ? current : { ...current, side: 'right' }))
  }, [])

  /** ▶ on a stopped plan step: the main process reopens that step and starts the turn that continues from it. */
  const resumePlanStep = useCallback(async (itemId: string): Promise<void> => {
    const id = activeSessionRef.current
    if (!id) return
    try {
      await unwrap(window.openclod.sessions.resumePlan(id, itemId))
      setRunState('thinking')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  /** 🗑 on the plan dock. The local queue goes too, or the drain would start the abandoned work again once the turn stops. */
  const discardPlan = useCallback(async (): Promise<void> => {
    const id = activeSessionRef.current
    if (!id) return
    setQueued([])
    queuedRef.current = []
    try {
      const result = await unwrap(window.openclod.sessions.discardPlan(id))
      setSession((current) => (current && current.meta.id === id ? { ...current, plan: [] } : current))
      setToast({
        level: 'info',
        text: result.capsules ? 'Plano descartado e apagado da memória da sessão.' : 'Plano descartado.'
      })
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const commitRename = useCallback((): void => {
    if (renaming && renameDraft.trim()) void renameSession(renaming, renameDraft.trim())
    setRenaming(null)
  }, [renaming, renameDraft, renameSession])

  /* ------------------------------- view ------------------------------- */

  const activeProject = projects.find((item) => item.id === activeProjectId) ?? null
  const selectedProviderId =
    session?.meta.providerId ??
    activeProject?.model?.providerId ??
    settings?.lastModel?.providerId ??
    settings?.defaultProviderId
  const provider =
    settings?.providers.find((item) => item.id === selectedProviderId) ??
    settings?.providers.find((item) => item.id === settings?.defaultProviderId) ??
    settings?.providers[0] ??
    null
  const providerConfigured = provider
    ? Boolean(capabilities?.providers.find((item) => item.id === provider.id)?.configured)
    : false
  const activeId = session?.meta.id ?? null
  const changeWork = useCallback(
    (next: ActivityState): void => {
      if (activeId) setActivityBySession((current) => ({ ...current, [activeId]: next }))
    },
    [activeId]
  )
  const work = session ? (activityBySession[session.meta.id] ?? []) : []
  const workAgents = work.filter((entry) => entry.kind === 'agent')
  const home = !session && surface === 'chat'
  const cowork = !session && surface === 'cowork'

  const recentTitle = useMemo(() => {
    const live = sessions.filter(
      (item) => !item.meta.archived && (item.meta.surface ?? 'code') === 'chat'
    )
    return [...live].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)[0]?.meta.title
  }, [sessions])

  const contextUsed = lastRequestTokens(session)
  const contextPercent = provider?.contextWindow
    ? Math.min(100, Math.round((contextUsed / provider.contextWindow) * 100))
    : 0

  const surfaceSessions = useMemo(
    () =>
      sessions.filter((item) => {
        const itemSurface = item.meta.surface ?? 'code'
        return surface === 'chat' ? itemSurface === 'chat' || itemSurface === 'cowork' : itemSurface === 'code'
      }),
    [sessions, surface]
  )

  // Which providers can answer right now: the model menu offers the ones with a key, and says why one is being avoided.
  const providerStates = useMemo((): Record<string, ProviderMenuState> | undefined => {
    if (!settings || !capabilities) return undefined
    const out: Record<string, ProviderMenuState> = {}
    for (const item of settings.providers) {
      const info = capabilities.providers.find((entry) => entry.id === item.id)
      const local = /127\.0\.0\.1|localhost/.test(item.baseUrl)
      out[item.id] = {
        ready: local || Boolean(info?.configured),
        failure: info?.unavailable ? describeFailure(info.unavailable.kind) : undefined
      }
    }
    return out
  }, [settings, capabilities])

  const composerNode = (
    <Composer
      // A draft/attachments/dictation belongs to one session. Remounting on
      // switch prevents project A's text from being sent to project B.
      key={session?.meta.id ?? `home:${activeProjectId ?? 'none'}:${surface}`}
      session={session}
      providers={settings?.providers ?? []}
      providerStates={providerStates}
      providerId={
        session?.meta.providerId ??
        activeProject?.model?.providerId ??
        settings?.lastModel?.providerId ??
        provider?.id ??
        ''
      }
      model={session?.meta.model ?? activeProject?.model?.model ?? settings?.lastModel?.model ?? provider?.model ?? ''}
      mode={session?.meta.mode ?? (surface === 'chat' ? defaultAgentMode('chat') : 'ask')}
      permissionMode={settings?.policy.mode ?? 'ask'}
      runState={runState}
      variant={session ? 'chat' : surface === 'cowork' ? 'cowork' : surface === 'chat' ? 'home' : 'chat'}
      queued={queued}
      skills={skills}
      contextPercent={contextPercent}
      contextUsed={contextUsed}
      turnTokens={turnUsage ? billableTokens(turnUsage) : 0}
      turnLimit={turnLimit}
      effort={session ? (session.meta.effort ?? null) : defaultEffort}
      environments={settings?.environments ?? []}
      environmentId={session?.meta.environment ?? 'local'}
      workspaceName={activeProject?.name}
      seed={composerSeed}
      insert={dictationInsert}
      onSend={(text, images) => send(text, images, { fresh: !session })}
      onQueue={enqueue}
      onInterruptSend={(text, images) => void interruptAndSend(text, images)}
      onSendQueued={(id) => void sendQueuedNow(id)}
      onRemoveQueued={removeQueued}
      onCommand={runCommand}
      onStop={() => void stop()}
      onModeChange={(agentMode) => void changeMode(agentMode)}
      onModelChange={(providerId, model) => void changeModel(providerId, model)}
      onEffortChange={(next) => void changeEffort(next)}
      onPermissionChange={(mode) => void changePermission(mode)}
      onEnvironmentChange={(environmentId) => void changeEnvironment(environmentId)}
      onSurfaceChange={(next) => {
        setPage(null)
        setSurface(next)
      }}
      onOpenSettings={() => setSettingsOpen(true)}
      onAddProject={() => void addProject()}
    />
  )

  const menuItems: MenuItem[] = [
    {
      id: 'new',
      label: 'Nova sessão',
      icon: 'plus',
      shortcut: 'Ctrl+N',
      disabled: !activeProject && !settings,
      onSelect: () => {
        const project = activeProject ?? projects[0]
        if (project) void createSession(project)
        else void addProject()
      }
    },
    { id: 'open', label: 'Abrir pasta de projeto…', icon: 'folderOpen', onSelect: () => void addProject() },
    { id: 'import', label: 'Importar sessão…', icon: 'download', onSelect: () => importRef.current?.click() },
    { id: 'sep-1', separator: true },
    ...(session
      ? ([
          { id: 'export', label: 'Exportar sessão', icon: 'download', shortcut: 'Ctrl+Shift+E', onSelect: () => void exportSession(session.meta.id) },
          { id: 'compact', label: 'Compactar contexto', icon: 'refresh', onSelect: () => void compactSession().catch((err) => setError(errorMessage(err))) },
          { id: 'rewind', label: 'Voltar conversa a uma mensagem', icon: 'rotate', onSelect: () => setRewindOpen(true) },
          { id: 'archive', label: 'Arquivar sessão', icon: 'archive', onSelect: () => void archiveSession(session.meta.id, true) },
          { id: 'panel', label: 'Painel lateral da sessão', icon: 'panelRight', onSelect: () => togglePanel('context') },
          { id: 'sep-2', separator: true }
        ] as MenuItem[])
      : []),
    { id: 'settings', label: 'Configurações', icon: 'settings', shortcut: 'Ctrl+,', onSelect: () => setSettingsOpen(true) },
    { id: 'shortcuts', label: 'Atalhos: Ctrl+B barra · Ctrl+N sessão · Ctrl+Alt+F janela', disabled: true }
  ]

  const titleItems: MenuItem[] = session
    ? [
        {
          id: 'rename',
          label: 'Renomear sessão',
          icon: 'pencil',
          onSelect: () => {
            setRenaming(session.meta.id)
            setRenameDraft(session.meta.title)
          }
        },
        { id: 'rewind', label: 'Voltar ou ramificar conversa', icon: 'rotate', onSelect: () => setRewindOpen(true) },
        { id: 'export', label: 'Exportar JSON', icon: 'download', onSelect: () => void exportSession(session.meta.id) },
        { id: 'sep', separator: true },
        {
          id: 'delete',
          label: 'Apagar sessão',
          icon: 'trash',
          danger: true,
          onSelect: () => {
            if (window.confirm(`Apagar a sessão "${session.meta.title}"?`)) void deleteSession(session.meta.id)
          }
        }
      ]
    : []

  const optionItems: MenuItem[] = session
    ? [
        { id: 'tasks', label: 'Tarefas em segundo plano', icon: 'logs', checked: panelTab === 'tasks', onSelect: () => togglePanel('tasks') },
        { id: 'rewind', label: 'Voltar conversa a uma mensagem', icon: 'rotate', onSelect: () => setRewindOpen(true) },
        {
          id: 'awake',
          label: keepAwake ? 'Manter computador ativo (ligado)' : 'Manter computador ativo',
          icon: 'eye',
          checked: keepAwake,
          onSelect: () => void toggleKeepAwake()
        },
        { id: 'sep0', separator: true },
        { id: 'context', label: 'Sessão', icon: 'panelRight', checked: panelTab === 'context', onSelect: () => togglePanel('context') },
        { id: 'plan', label: 'Plano', icon: 'list', checked: panelTab === 'plan', onSelect: () => togglePanel('plan') },
        { id: 'terminal', label: 'Terminal', icon: 'terminal', checked: panelTab === 'terminal', onSelect: () => togglePanel('terminal') },
        { id: 'changes', label: 'Alterações', icon: 'diff', checked: panelTab === 'changes', onSelect: () => togglePanel('changes') },
        { id: 'browser', label: 'Navegador', icon: 'globe', checked: panelTab === 'browser', onSelect: () => togglePanel('browser') },
        { id: 'files', label: 'Arquivos', icon: 'folder', checked: panelTab === 'files', onSelect: () => togglePanel('files') },
        { id: 'activity', label: 'Auditoria', icon: 'shield', checked: panelTab === 'activity', onSelect: () => togglePanel('activity') },
        { id: 'captures', label: 'Capturas de tela', icon: 'camera', checked: panelTab === 'captures', onSelect: () => togglePanel('captures') },
        { id: 'sep', separator: true },
        { id: 'export', label: 'Exportar sessão', icon: 'download', onSelect: () => void exportSession(session.meta.id) },
        { id: 'settings', label: 'Configurações', icon: 'settings', onSelect: () => setSettingsOpen(true) }
      ]
    : [
        { id: 'awake', label: 'Manter computador ativo', icon: 'eye', checked: keepAwake, onSelect: () => void toggleKeepAwake() },
        { id: 'sep', separator: true },
        { id: 'settings', label: 'Configurações', icon: 'settings', onSelect: () => setSettingsOpen(true) }
      ]

  const openSettingsAt = (tab: SettingsTab): void => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  const openConnectors = (): void => {
    setSettingsOpen(false)
    setSettingsTab(undefined)
    setCustomizeOpenTab({ tab: 'connectors', nonce: Date.now() })
    setPage('customize')
  }

  const pageNode: ReactNode =
    page === 'activity' ? (
      <ActivityPage
        projects={projects}
        activeProjectId={activeProjectId}
        onOpenSession={(sessionId) => { setPage(null); void selectSession(sessionId) }}
        onOpenMemory={(projectId, slug) => { setMemoryOpen({ id: Date.now(), projectId, slug }); setPage('memory') }}
      />
    ) : page === 'projects' ? (
      <ProjectsPage
        projects={projects}
        sessions={sessions}
        onOpen={(project) => {
          setPage(null)
          setSurface('code')
          void selectProject(project)
        }}
        onNewSession={(project) => {
          setPage(null)
          void createSession(project, 'code')
        }}
        onAdd={() => void addProject()}
        onReveal={(path) => void revealPath(path)}
        onRemove={(project) => void removeProject(project)}
        onDelete={(project) => void deleteProject(project)}
        onOpenGraph={openMemoryGraph}
        onWorktrees={(project) => setWorktreeProject(project)}
      />
    ) : page === 'memory' ? (
      <MemoryPage
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={(project) => void selectProject(project)}
        onAddProject={() => void addProject()}
        onOpenSettings={() => openSettingsAt('memory')}
        graphRequest={memoryGraphRequest}
        openRequest={memoryOpen}
        onOpenHandled={() => setMemoryOpen(null)}
      />
    ) : page === 'artifacts' ? (
      <ArtifactsPage
        projects={projects}
        activeProjectId={activeProjectId}
        sessions={sessions}
        onCreate={(prompt) => {
          setPage(null)
          setSurface('chat')
          setComposerSeed({ id: logId(), text: prompt, sessionId: activeSessionRef.current })
        }}
      />
    ) : page === 'design' ? (
      <DesignPage
        onCreate={(prompt) => {
          setPage(null)
          setSurface('chat')
          setComposerSeed({ id: logId(), text: prompt, sessionId: activeSessionRef.current })
        }}
      />
    ) : page === 'dispatch' ? (
      <DispatchPage
        projects={projects}
        activeProjectId={activeProjectId}
        keepAwake={keepAwake}
        onToggleKeepAwake={() => void toggleKeepAwake()}
        onOpenSettings={() => openSettingsAt('policy')}
      />
    ) : page === 'more' ? (
      <MorePage
        version={versions?.app ?? '0.1.0'}
        archivedCount={sessions.filter((session) => session.meta.archived).length}
        onOpenSettings={() => openSettingsAt('appearance')}
        onOpenMemory={() => setPage('memory')}
      />
    ) : page === 'scheduled' ? (
      <ScheduledPage
        projects={projects}
        activeProjectId={activeProjectId}
        onOpenSession={(id) => {
          setPage(null)
          void selectSession(id)
        }}
        onAddProject={() => void addProject()}
      />
    ) : page === 'customize' ? (
      <CustomizePage
        settings={settings}
        capabilities={capabilities}
        onOpenSettings={openSettingsAt}
        onRestartMcp={async () => {
          await window.openclod.mcp.restart()
          await refreshCapabilities()
        }}
        openTab={customizeOpenTab}
      />
    ) : null

  const body: ReactNode = pageNode ? pageNode : home ? (
    <HomeView
      project={activeProject}
      recentTitle={recentTitle}
      capabilities={capabilities}
      providerLabel={provider?.label ?? 'nenhum provedor'}
      model={provider?.model ?? ''}
      hasRealProvider={providerConfigured}
      profileName={settings?.profileName}
      composer={composerNode}
      onAddProject={() => void addProject()}
      onOpenSettings={() => setSettingsOpen(true)}
      onCapabilities={() => setSettingsOpen(true)}
      onOpenMemory={() => setPage('memory')}
    />
  ) : cowork ? (
    <CoworkView
      projects={projects}
      project={activeProject}
      capabilities={capabilities}
      providerLabel={provider?.label ?? 'nenhum provedor'}
      model={provider?.model ?? ''}
      hasRealProvider={providerConfigured}
      composer={composerNode}
      recent={sessions.filter((item) => (item.meta.surface ?? 'code') === 'cowork' && !item.meta.archived)}
      permissionMode={settings?.policy.mode ?? 'auto'}
      onPermissionChange={(mode) => void changePermission(mode)}
      onAddProject={() => void addProject()}
      onPickProject={(project) => {
        setActiveProjectId(project.id)
        clearSession()
      }}
      onOpenSession={(id) => {
        setPage(null)
        void selectSession(id)
      }}
      onClearActive={() => clearSession()}
      onSuggestion={(text) => setComposerSeed({ id: logId(), text, sessionId: activeSessionRef.current })}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  ) : session ? (
    <div className="chat-view">
      <div className="chat-scroll">
        <Transcript
          sessionId={session.meta.id}
          messages={session.messages}
          streaming={streaming}
          reasoning={reasoning}
          tools={tools}
          runState={runState}
          agents={workAgents}
          onOpenTasks={() => setPanelTab('tasks')}
        />
      </div>

      <BudgetDock
        info={budget && session && budget.sessionId === session.meta.id ? budget.info : null}
        onContinue={continueBudget}
        onClose={() => setBudget(null)}
      />
      <QuestionDock
        request={question && question.sessionId === session.meta.id ? question : null}
        onAnswer={(id, answers) => void answerQuestion(id, answers)}
        onSkip={(id) => void answerQuestion(id, [])}
      />
      <ApprovalDock approvals={approvals} onResolve={(id, approved, always, reason) => void resolveApproval(id, approved, always, reason)} />
      {session.meta.mode === 'loop' ? (
        <LoopDock loop={session.loop} running={BUSY_STATES.includes(runState)} budget={settings?.loopBudget ?? DEFAULT_LOOP_BUDGET} />
      ) : null}
      <PlanDock
        plan={session.plan}
        running={BUSY_STATES.includes(runState)}
        onOpenStep={openPlanStep}
        onResumeStep={resumePlanStep}
        onDiscard={discardPlan}
      />
      {composerNode}
    </div>
  ) : (
    <div className="workspace-empty">
      <span className="we-mark">
        <OpenclodMark size={34} />
      </span>
      <h1>Pronto para começar</h1>
      <p className="we-tagline">Código, terminal, navegador e Computer Use no Windows real.</p>
      <p className="we-text">
        Abra uma pasta de projeto ou escolha uma sessão na barra lateral. Toda ação sensível passa por aprovação e
        fica registrada na trilha de auditoria.
      </p>
      <div className="we-actions">
        <button type="button" className="btn primary" onClick={() => void addProject()}>
          <Icon name="folderOpen" size={14} /> Abrir pasta de projeto
        </button>
        {activeProject ? (
          <button type="button" className="btn subtle" onClick={() => void createSession(activeProject)}>
            <Icon name="plus" size={14} /> Nova sessão em {activeProject.name}
          </button>
        ) : null}
        <button type="button" className="btn ghost" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={14} /> Configurar provedor
        </button>
      </div>
      <div className="we-capabilities">
        <span className={capabilities?.computer.available ? 'on' : 'off'}>
          <Icon name="monitor" size={13} /> Computer Use {capabilities?.computer.available ? 'pronto' : 'indisponível'}
        </span>
        <span className={capabilities?.browser.available ? 'on' : 'off'}>
          <Icon name="globe" size={13} /> Navegador {capabilities?.browser.available ? 'pronto' : 'indisponível'}
        </span>
        <span className="on">
          <Icon name="shield" size={13} /> Política {settings?.policy.mode ?? 'ask'}
        </span>
      </div>
    </div>
  )

  return (
    <div
      className={`app-shell ${sidebarOpen ? '' : 'sidebar-closed'} ${panelTab ? 'panel-open' : ''} ${
        panelTab && panelLayout.maximized ? 'panel-maximized' : ''
      } panel-side-${panelLayout.side}`}
    >
      <DictationHost voice={settings?.voice} />
      <Titlebar
        home={!session}
        sidebarOpen={sidebarOpen}
        canBack={canBack}
        canForward={canForward}
        maximized={maximized}
        title={session?.meta.title ?? 'Openclod Desktop'}
        panelTab={panelTab}
        panelAvailable={Boolean(session)}
        menuOpen={menuOpen}
        titleMenuOpen={titleMenuOpen}
        optionsOpen={optionsOpen}
        onMenu={() => {
          setMenuOpen((value) => !value)
          setTitleMenuOpen(false)
          setOptionsOpen(false)
        }}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        onBack={() => void goBack()}
        onForward={() => void goForward()}
        onTitle={() => {
          setTitleMenuOpen((value) => !value)
          setMenuOpen(false)
          setOptionsOpen(false)
        }}
        onPanel={togglePanel}
        onOptions={() => {
          setOptionsOpen((value) => !value)
          setMenuOpen(false)
          setTitleMenuOpen(false)
        }}
        onMinimize={() => window.openclod.window.minimize()}
        onMaximize={() => window.openclod.window.maximize()}
        onClose={() => window.openclod.window.close()}
      />

      <div className="app-body">
        {sidebarOpen ? (
          <Sidebar
            mode={surface}
            page={page}
            onPage={(next) => {
              setPage((current) => (current === next ? null : next))
              setPanelTab(null)
            }}
            projects={projects}
            sessions={surfaceSessions}
            busy={busySessions}
            activeProjectId={activeProjectId}
            activeSessionId={activeSessionId}
            version={versions?.app ?? '0.1.0'}
            onMode={(next) => {
              if (next === surface) return
              setSurface(next)
              setPanelTab(null)
              setComposerSeed(undefined)
              clearSession()
            }}
            onSelectProject={(project) => void selectProject(project)}
            onSelectSession={(id) => {
              setPage(null)
              void selectSession(id)
            }}
            onNewSession={(project) => void createSession(project, surface)}
            onAddProject={() => void addProject()}
            onRemoveProject={(project) => void removeProject(project)}
            onDeleteProject={(project) => void deleteProject(project)}
            onOpenGraph={openMemoryGraph}
            onWorktrees={(project) => setWorktreeProject(project)}
            onDeleteSession={(id) => void deleteSession(id)}
            onRenameSession={(id, title) => void renameSession(id, title)}
            onArchiveSession={(id, archived) => void archiveSession(id, archived)}
            onExportSession={(id) => void exportSession(id)}
            onImportSession={() => importRef.current?.click()}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMenu={() => setMenuOpen(true)}
          />
        ) : null}

        <main className="workspace">
          <ErrorBoundary label="a área de trabalho" resetKey={activeSessionId ?? surface}>
            {body}
          </ErrorBoundary>
          {/* Inside the workspace so it centers over the chat column, like the composer. */}
          {error ? (
            <div className="error-bar" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
              <button type="button" className="icon-btn small" onClick={() => setError('')} title="Fechar">
                <Icon name="x" size={12} />
              </button>
            </div>
          ) : null}
        </main>

        {session && !home ? (
          <SessionPanel
            session={session}
            changes={changes}
            logs={logs}
            capabilities={capabilities}
            settings={settings}
            tab={panelTab}
            planFocus={planFocus}
            onPlanFocus={setPlanFocus}
            work={work}
            onWorkChange={changeWork}
            onStopTurn={() => void stop()}
            layout={panelLayout}
            onLayout={setPanelLayout}
            onClose={() => setPanelTab(null)}
            onClearLogs={() => setLogs([])}
            onTab={togglePanel}
            onCompact={compactSession}
            onReveal={(path) => void revealPath(path)}
            onOpenConnectors={openConnectors}
          />
        ) : null}
      </div>

      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void importSession(file)
          event.target.value = ''
        }}
      />

      {menuOpen ? (
        <div className="menu-anchor menu-anchor-left">
          <MenuPopover items={menuItems} onClose={() => setMenuOpen(false)} />
        </div>
      ) : null}

      {titleMenuOpen && session ? (
        <div className="menu-anchor menu-anchor-title">
          <MenuPopover
            items={titleItems}
            onClose={() => setTitleMenuOpen(false)}
            header={<span className="menu-heading">{session.meta.title}</span>}
          />
        </div>
      ) : null}

      {optionsOpen ? (
        <div className="menu-anchor menu-anchor-right">
          <MenuPopover items={optionItems} onClose={() => setOptionsOpen(false)} align="right" />
        </div>
      ) : null}

      {renaming ? (
        <div className="rename-pop" role="dialog" aria-label="Renomear sessão">
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenaming(null)
            }}
            spellCheck={false}
          />
          <button type="button" className="btn small primary" onClick={commitRename}>
            Salvar
          </button>
          <button type="button" className="btn small ghost" onClick={() => setRenaming(null)}>
            Cancelar
          </button>
        </div>
      ) : null}

      {settings ? (
        <SettingsDialog
          open={settingsOpen}
          settings={settings}
          presets={presets}
          capabilities={capabilities}
          versions={versions}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsTab(undefined)
          }}
          initialTab={settingsTab}
          onOpenConnectors={openConnectors}
          memoryProjectId={session?.meta.projectId ?? activeProject?.id}
          onSave={saveSettings}
          onRefreshCapabilities={refreshCapabilities}
        />
      ) : null}

      {worktreeProject ? (
        <WorktreeDialog
          project={worktreeProject}
          onClose={() => setWorktreeProject(null)}
          onOpenSession={async (worktree) => Boolean(await createSession(worktreeProject, surface, worktree.path))}
        />
      ) : null}

      {rewindOpen && session ? (
        <RewindDialog session={session} onClose={() => setRewindOpen(false)} onRewind={rewindConversation} onFork={forkConversation} />
      ) : null}

      {toast ? (
        <div className={`toast level-${toast.level}`}>
          <Icon name={toast.level === 'error' ? 'alert' : 'info'} size={14} />
          <span>{toast.text}</span>
          <button type="button" className="icon-btn small" onClick={() => setToast(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
