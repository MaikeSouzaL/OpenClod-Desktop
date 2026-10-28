import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  AppSettings,
  CapabilityReport,
  HooksConfig,
  NotificationPreferences,
  PermissionMode,
  PolicyConfig,
  ProviderConfig,
  ReasoningEffort
} from '../../../shared/types'
import { AGENT_MODES, REASONING_EFFORTS } from '../../../shared/types'
import { effortLevelsFor } from '../../../shared/reasoning'
import { modelSeesImages, orderedProviders, reserveModels } from '../../../core/providers/order'
import { describeFailure } from '../../../core/providers/health'
import type {
  AppVersions,
  BackupFileInfo,
  BackupRestoreInfo,
  ChromeCompanionInfo,
  ConfigExportInfo,
  ConfigImportInfo,
  UpdateCheckInfo,
  UpdateDownloadInfo,
  MemoryPageContent,
  MemoryPageInfo,
  MemoryStatsInfo,
  ProviderPresetInfo,
  ProviderUsageInfo,
  SettingsBackupInfo,
  SttStatusInfo,
  TtsVoiceInfo
} from '../../../shared/api'
import { Icon } from './Icons'
import { MODE_LABELS, formatTokens } from '../lib/format'
import { billableTokens } from '../../../shared/limits'
import { errorMessage, unwrap } from '../lib/api'
import { promptText } from '../lib/prompt'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { ColabCard } from './ColabCard'
import { ProviderLogo } from './ProviderLogo'
import { ProviderTile } from './ProviderTile'

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Extra',
  max: 'Máximo'
}

/** Models drawn per provider in "Ordem da reserva" (a catalog of hundreds is searched, not scrolled). */
const RESERVE_MODELS_SHOWN = 200

function sttDeviceLabel(device?: string): string {
  if (device === 'cuda') return 'GPU CUDA'
  if (device === 'cpu') return 'CPU'
  return 'automático'
}

export type SettingsTab = 'providers' | 'appearance' | 'voice' | 'policy' | 'memory' | 'mcp' | 'backup' | 'harness' | 'diagnostics' | 'about'
type Tab = SettingsTab

const PERMISSION_CHOICES: Array<{ id: PermissionMode; title: string; detail: string; tone?: 'warn' }> = [
  { id: 'readonly', title: 'Somente leitura', detail: 'Lê e investiga. Nega escrita, execução e controle de interface.' },
  { id: 'ask', title: 'Perguntar', detail: 'Leituras passam; escrita, comandos e ações sensíveis pedem aprovação.' },
  { id: 'accept-edits', title: 'Aceitar edições', detail: 'Edita arquivos sem perguntar. Comandos e ações externas ainda pedem aprovação.' },
  {
    id: 'auto',
    title: 'Automático',
    detail: 'Padrão. Edita, executa e navega sem pedir; operações destrutivas e arquivos de segredo pedem confirmação.',
    tone: 'warn'
  },
  {
    id: 'unrestricted',
    title: 'Ultrarrestrito',
    detail: 'Sem bloqueios do harness: comandos, confirmações, regras e restrições de diretório são removidos. Use com responsabilidade.',
    tone: 'warn'
  }
]

interface SettingsDialogProps {
  open: boolean
  settings: AppSettings
  presets: ProviderPresetInfo[]
  capabilities: CapabilityReport | null
  versions: AppVersions | null
  onClose(): void
  onSave(patch: Partial<AppSettings>): Promise<void>
  onRefreshCapabilities(): Promise<void>
  /** Tab shown when the dialog opens (e.g. "mcp" from the Customize page). */
  initialTab?: SettingsTab
  /** Active project, used by the Memory tab. */
  memoryProjectId?: string
  /** Closes this dialog and opens Personalização → Conectores (the MCP tab points there). */
  onOpenConnectors?(): void
}

export function SettingsDialog({
  open,
  settings,
  presets,
  capabilities,
  versions,
  onClose,
  onSave,
  onRefreshCapabilities,
  initialTab,
  memoryProjectId,
  onOpenConnectors
}: SettingsDialogProps): ReactElement | null {
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(settings.theme)
  const [profileName, setProfileName] = useState(settings.profileName ?? '')
  const [policy, setPolicy] = useState<PolicyConfig>(settings.policy)
  const [autoAgents, setAutoAgents] = useState(Boolean(settings.autoAgents))
  const [useAllModels, setUseAllModels] = useState(settings.useAllModels !== false)
  const [fallbackOrder, setFallbackOrder] = useState<string[]>(settings.fallbackOrder ?? [])
  const [fallbackExclude, setFallbackExclude] = useState<string[]>(settings.fallbackExclude ?? [])
  /** The models ticked for each provider in "Ordem da reserva" (no entry: only the provider's own model). */
  const [fallbackModels, setFallbackModels] = useState<Record<string, string[]>>(settings.fallbackModels ?? {})
  /** Providers whose model list is open in "Ordem da reserva", and the search typed in each. */
  const [openReserve, setOpenReserve] = useState<string[]>([])
  const [reserveSearch, setReserveSearch] = useState<Record<string, string>>({})
  /** `providerId::model` of the model that describes images for the ones that cannot read them; empty = automatic. */
  const [visionChoice, setVisionChoice] = useState(
    settings.visionModel ? `${settings.visionModel.providerId}::${settings.visionModel.model}` : ''
  )
  const [notifications, setNotifications] = useState<NotificationPreferences>({
    desktop: true,
    turnFinished: true,
    failures: true,
    approvals: true,
    minimumSeverity: 'success',
    quietStart: '22:00',
    quietEnd: '07:00'
  })
  const [limits, setLimits] = useState(settings.limits)
  const [blockedText, setBlockedText] = useState('')
  const [rootsText, setRootsText] = useState('')
  const [mcpBackups, setMcpBackups] = useState<SettingsBackupInfo[]>([])
  const [mcpBackupBusy, setMcpBackupBusy] = useState(false)
  const [rulesText, setRulesText] = useState({ allow: '', ask: '', deny: '' })
  const [environmentsText, setEnvironmentsText] = useState('[]')
  const [hooksText, setHooksText] = useState('{}')
  const [importClaude, setImportClaude] = useState(false)
  const [selfRepair, setSelfRepair] = useState<NonNullable<AppSettings['selfRepair']>>({
    enabled: false,
    repoPath: '',
    restartAfterRepair: true
  })
  const [voice, setVoice] = useState<NonNullable<AppSettings['voice']>>({
    model: 'base',
    language: 'pt',
    shortcut: '',
    overlay: false,
    mode: 'toggle',
    polish: false,
    insert: 'focused',
    ttsProvider: 'edge',
    ttsVoice: 'pt-BR-FranciscaNeural',
    ttsRate: 0,
    ttsVolume: 100
  })
  const [voiceStatus, setVoiceStatus] = useState<SttStatusInfo | null>(null)
  const [providerUsage, setProviderUsage] = useState<ProviderUsageInfo[]>([])
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceInfo[]>([])
  const [browserMode, setBrowserMode] = useState<NonNullable<AppSettings['browser']>['mode']>(settings.browser?.mode ?? 'auto')
  const [browserFallback, setBrowserFallback] = useState(settings.browser?.fallbackToManaged !== false)
  const [browserCompanion, setBrowserCompanion] = useState<ChromeCompanionInfo | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [environmentChecks, setEnvironmentChecks] = useState<Record<string, { ok: boolean; detail: string; stdout: string; stderr: string }>>({})
  const [checkingEnvironment, setCheckingEnvironment] = useState('')
  const [memoryStats, setMemoryStats] = useState<MemoryStatsInfo | null>(null)
  const [memoryPages, setMemoryPages] = useState<MemoryPageInfo[]>([])
  const [memoryPage, setMemoryPage] = useState<MemoryPageContent | null>(null)
  const [memoryNotice, setMemoryNotice] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupInfo, setBackupInfo] = useState<BackupFileInfo | null>(null)
  const [backupRestoreInfo, setBackupRestoreInfo] = useState<BackupRestoreInfo | null>(null)
  const [configExportInfo, setConfigExportInfo] = useState<ConfigExportInfo | null>(null)
  const [configImportInfo, setConfigImportInfo] = useState<ConfigImportInfo | null>(null)
  const [updateFeed, setUpdateFeed] = useState('')
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckInfo | null>(null)
  const [downloadedUpdate, setDownloadedUpdate] = useState<UpdateDownloadInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [keyStatus, setKeyStatus] = useState<Record<string, string>>({})
  const [testStatus, setTestStatus] = useState<Record<string, { state: string; detail: string }>>({})
  const [presetKey, setPresetKey] = useState('')
  const [testingAll, setTestingAll] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const ttsPreviewAudio = useRef<HTMLAudioElement | null>(null)

  const serverIds = useMemo(() => new Set(settings.providers.map((provider) => provider.id)), [settings.providers])

  useEffect(() => {
    if (open && initialTab) setTab(initialTab)
  }, [open, initialTab])

  // What this dialog edits. A refresh of settings that only touches other things (a connector starting, the last model
  // picked in the composer) must not throw away what is being typed here, such as the models "Detectar modelos" just found.
  const draftKey = useMemo(() => JSON.stringify({ ...settings, mcpServers: undefined, lastModel: undefined }), [settings])

  useEffect(() => {
    if (!open) return
    const ttsProvider = settings.voice?.ttsProvider ?? 'edge'
    const configuredTtsVoice = settings.voice?.ttsVoice ?? ''
    setProviders(structuredClone(settings.providers))
    setDefaultId(settings.defaultProviderId)
    setTheme(settings.theme)
    setProfileName(settings.profileName ?? '')
    setPolicy(structuredClone(settings.policy))
    setAutoAgents(Boolean(settings.autoAgents))
    setUseAllModels(settings.useAllModels !== false)
    setFallbackOrder(settings.fallbackOrder ?? [])
    setFallbackExclude(settings.fallbackExclude ?? [])
    setFallbackModels(structuredClone(settings.fallbackModels ?? {}))
    setVisionChoice(settings.visionModel ? `${settings.visionModel.providerId}::${settings.visionModel.model}` : '')
    setNotifications(settings.notifications ?? {
      desktop: true,
      turnFinished: true,
      failures: true,
      approvals: true,
      minimumSeverity: 'success',
      quietStart: '22:00',
      quietEnd: '07:00'
    })
    setLimits(structuredClone(settings.limits))
    setBlockedText(settings.policy.blockedCommands.join('\n'))
    setRootsText(settings.policy.allowedRoots.join('\n'))
    setRulesText({
      allow: (settings.policy.rules?.allow ?? []).join('\n'),
      ask: (settings.policy.rules?.ask ?? []).join('\n'),
      deny: (settings.policy.rules?.deny ?? []).join('\n')
    })
    setEnvironmentsText(JSON.stringify(settings.environments ?? [], null, 2))
    setHooksText(JSON.stringify(settings.hooks ?? {}, null, 2))
    setImportClaude(Boolean(settings.importClaudeSettings))
    setSelfRepair({
      enabled: settings.selfRepair?.enabled === true,
      repoPath: settings.selfRepair?.repoPath ?? '',
      restartAfterRepair: settings.selfRepair?.restartAfterRepair !== false
    })
    setBrowserMode(settings.browser?.mode ?? 'auto')
    setVoice({
      model: settings.voice?.model ?? 'base',
      language: settings.voice?.language ?? 'pt',
      shortcut: settings.voice?.shortcut ?? '',
      overlay: Boolean(settings.voice?.overlay),
      mode: settings.voice?.mode ?? 'toggle',
      polish: settings.voice?.polish ?? false,
      insert: settings.voice?.insert ?? 'focused',
      ttsProvider,
      ttsVoice: ttsProvider === 'edge' && !configuredTtsVoice.includes('Neural')
        ? 'pt-BR-FranciscaNeural'
        : configuredTtsVoice,
      ttsRate: settings.voice?.ttsRate ?? 0,
      ttsVolume: settings.voice?.ttsVolume ?? 100
    })
    void window.forja.stt.status().then((result) => setVoiceStatus(result.ok ? result.value : null))
    void window.forja.app.providerUsage().then((result) => setProviderUsage(result.ok ? result.value : []))
    void window.forja.tts.voices().then((result) => setTtsVoices(result.ok ? result.value : []))
    void window.forja.app.chromeCompanion().then((result) => setBrowserCompanion(result.ok ? result.value : null))
    setKeyDrafts({})
    setKeyStatus({})
    setTestStatus({})
    setError('')
    setNotice('')
    setBackupInfo(null)
    setBackupRestoreInfo(null)
    setConfigExportInfo(null)
    setConfigImportInfo(null)
    setUpdateFeed(settings.updates?.feedUrl ?? '')
    setAutoCheckUpdates(Boolean(settings.updates?.autoCheck))
    setUpdateInfo(null)
    setDownloadedUpdate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftKey])

  useEffect(() => {
    if (!open || tab !== 'memory' || !memoryProjectId) return
    let cancelled = false
    void (async () => {
      const [status, list] = await Promise.all([
        window.forja.memory.status(memoryProjectId),
        window.forja.memory.list(memoryProjectId)
      ])
      if (cancelled) return
      setMemoryStats(status.ok ? status.value : null)
      setMemoryPages(list.ok ? list.value : [])
    })()
    return () => {
      cancelled = true
    }
  }, [open, tab, memoryProjectId])

  // Old settings.json copies can still hold MCP credentials in plain text: look for them when the MCP tab is shown.
  useEffect(() => {
    if (!open || tab !== 'mcp') return
    let cancelled = false
    void window.forja.app.mcpBackups().then((result) => {
      if (!cancelled) setMcpBackups(result.ok ? result.value : [])
    })
    return () => {
      cancelled = true
    }
  }, [open, tab])

  if (!open) return null

  const usageByProvider = new Map(providerUsage.map((item) => [item.providerId, item]))
  const totalUsageTokens = providerUsage.reduce((total, item) => total + billableTokens(item), 0)
  const totalUsageCached = providerUsage.reduce((total, item) => total + item.cachedInput, 0)
  const totalUsageCost = providerUsage.reduce((total, item) => total + item.costUsd, 0)

  const selectedTtsProvider = voice.ttsProvider ?? 'edge'
  const selectedTtsVoices = ttsVoices.filter((item) => item.provider === selectedTtsProvider)

  const configured = (id: string): boolean =>
    Boolean(capabilities?.providers.find((provider) => provider.id === id)?.configured)

  /** What the harness is working around for this provider right now (no balance, key refused...), if anything. */
  const failureOf = (id: string): string | null => {
    const unavailable = capabilities?.providers.find((provider) => provider.id === id)?.unavailable
    return unavailable ? `${describeFailure(unavailable.kind)}${unavailable.cloud ? ' (modelos de nuvem)' : ''}` : null
  }

  /** Status shown next to a provider in the reserve list. */
  const reserveState = (provider: ProviderConfig): { label: string; tone: 'ok' | 'warn' | 'bad' } => {
    const failure = failureOf(provider.id)
    if (failure) return { label: failure, tone: 'bad' }
    const local = provider.id === 'ollama' || provider.id === 'lmstudio' || /127\.0\.0\.1|localhost/.test(provider.baseUrl)
    if (local) return { label: 'local', tone: 'ok' }
    return configured(provider.id) ? { label: 'pronto', tone: 'ok' } : { label: 'sem chave', tone: 'warn' }
  }

  /** Pings every provider of the reserve that can be asked (has a key or runs here) and lets the status show who answers. */
  const testReserve = async (): Promise<void> => {
    setTestingAll(true)
    try {
      for (const provider of orderedProviders(providers, fallbackOrder)) {
        if (fallbackExclude.includes(provider.id) || !serverIds.has(provider.id)) continue
        const local = /127\.0\.0\.1|localhost/.test(provider.baseUrl)
        if (!local && !configured(provider.id)) continue
        await testProvider(provider.id)
      }
      await onRefreshCapabilities()
    } finally {
      setTestingAll(false)
    }
  }

  const moveReserve = (id: string, delta: -1 | 1): void => {
    const order = orderedProviders(providers, fallbackOrder).map((provider) => provider.id)
    const from = order.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= order.length) return
    ;[order[from], order[to]] = [order[to], order[from]]
    setFallbackOrder(order)
  }

  /** Every model of a provider the user can tick for the reserve: its own first, then the ones "Detectar modelos" found. */
  const reserveModelList = (provider: ProviderConfig): string[] =>
    [...new Set([provider.model, ...(provider.models ?? [])].map((model) => model?.trim()).filter(Boolean))] as string[]

  /** The models of a provider that take part in the reserve right now (what is ticked, or just its own model). */
  const tickedModels = (provider: ProviderConfig): string[] => reserveModels(provider, fallbackModels[provider.id])

  const setTicked = (provider: ProviderConfig, next: string[]): void =>
    setFallbackModels((current) => ({ ...current, [provider.id]: next }))

  const toggleReserveOpen = (id: string): void =>
    setOpenReserve((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

  /** What the row says about the models: the one model, or how many. */
  const reserveSummary = (provider: ProviderConfig): string => {
    const picked = tickedModels(provider)
    if (!picked.length) return 'nenhum modelo marcado'
    return picked.length === 1 ? picked[0] : `${picked.length} modelos`
  }

  /** Models of this provider that read images, for the "describe images with" picker. */
  const visionModelsOf = (provider: ProviderConfig): string[] => {
    if (provider.visionModels?.length) return provider.visionModels
    return provider.supportsVision && provider.model ? [provider.model] : []
  }

  const updateProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setProviders((current) => current.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)))
  }

  const refreshUsage = async (): Promise<void> => {
    const result = await window.forja.app.providerUsage()
    setProviderUsage(result.ok ? result.value : [])
  }

  const availablePresets = presets.filter((preset) => !providers.some((provider) => provider.id === preset.key))

  const addPreset = (): void => {
    const key = presetKey || availablePresets[0]?.key
    const preset = presets.find((item) => item.key === key)
    if (!preset) return
    setProviders((current) => [
      ...current,
      {
        id: preset.key,
        kind: preset.kind,
        label: preset.label,
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKeyRef: preset.apiKeyEnv ? `env:${preset.apiKeyEnv}` : '',
        contextWindow: preset.contextWindow,
        supportsVision: preset.supportsVision,
        supportsTools: true,
        // The preset's own model list (and which of them read images), so the picker has them before "Detectar modelos".
        models: preset.models ? [...preset.models] : [preset.model],
        visionModels: preset.visionModels ? [...preset.visionModels] : undefined
      }
    ])
    setPresetKey('')
  }

  const addCustom = (): void => {
    let index = 1
    while (providers.some((provider) => provider.id === `custom-${index}`)) index++
    setProviders((current) => [
      ...current,
      {
        id: `custom-${index}`,
        kind: 'openai',
        label: `Personalizado ${index}`,
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'modelo',
        apiKeyRef: '',
        contextWindow: 32_000,
        supportsVision: false,
        supportsTools: true
      }
    ])
  }

  const removeProvider = (id: string): void => {
    if (providers.length <= 1) return
    const next = providers.filter((provider) => provider.id !== id)
    setProviders(next)
    if (defaultId === id) setDefaultId(next[0]?.id ?? '')
  }

  const saveKey = async (id: string): Promise<void> => {
    const value = (keyDrafts[id] ?? '').trim()
    if (!value) return
    setKeyStatus((current) => ({ ...current, [id]: 'salvando…' }))
    try {
      await unwrap(window.forja.app.setSecret(id, value))
      setKeyDrafts((current) => ({ ...current, [id]: '' }))
      setProviders((current) =>
        current.map((provider) => (provider.id === id ? { ...provider, apiKeyRef: `secret:${id}` } : provider))
      )
      setKeyStatus((current) => ({ ...current, [id]: 'chave salva no cofre do Windows' }))
      await onRefreshCapabilities()
    } catch (err) {
      setKeyStatus((current) => ({ ...current, [id]: errorMessage(err) }))
    }
  }

  const clearKey = async (id: string): Promise<void> => {
    try {
      await unwrap(window.forja.app.clearSecret(id))
      setKeyStatus((current) => ({ ...current, [id]: 'chave removida' }))
      await onRefreshCapabilities()
    } catch (err) {
      setKeyStatus((current) => ({ ...current, [id]: errorMessage(err) }))
    }
  }

  const testProvider = async (id: string): Promise<void> => {
    setTestStatus((current) => ({ ...current, [id]: { state: 'testando', detail: 'enviando um ping…' } }))
    try {
      // The address/model in the form, even if not saved yet: the test says what the user is looking at.
      const draft = providers.find((item) => item.id === id)
      const result = await unwrap(window.forja.app.testProvider(id, draft ? { baseUrl: draft.baseUrl, kind: draft.kind, model: draft.model } : undefined))
      setTestStatus((current) => ({ ...current, [id]: { state: result.ok ? 'ok' : 'erro', detail: result.detail } }))
      // The test teaches the harness which providers work (and forgets a failure that a recharge cured): show it.
      void onRefreshCapabilities()
    } catch (err) {
      setTestStatus((current) => ({ ...current, [id]: { state: 'erro', detail: errorMessage(err) } }))
    }
  }

  /** Asks the provider's own endpoint which models it serves and fills the model list. */
  const detectModels = async (id: string): Promise<void> => {
    setTestStatus((current) => ({ ...current, [id]: { state: 'detectando', detail: 'consultando os modelos do servidor…' } }))
    try {
      // Ask the server typed in the form, even if the address is not saved yet.
      const draft = providers.find((item) => item.id === id)
      const result = await unwrap(window.forja.app.discoverModels(id, draft ? { baseUrl: draft.baseUrl, kind: draft.kind } : undefined))
      if (result.error || !result.models.length) {
        setTestStatus((current) => ({ ...current, [id]: { state: 'erro', detail: result.error ?? 'o servidor não listou modelos' } }))
        return
      }
      const ids = result.models.map((model) => model.id)
      // Servers that say which models read images (OpenRouter, Ollama, LM Studio...) let the harness decide per model;
      // the ones that say nothing leave the provider's "suporta imagens" flag in charge.
      const tellsVision = result.models.some((model) => typeof model.supportsVision === 'boolean')
      updateProvider(id, {
        models: ids,
        visionModels: tellsVision ? result.models.filter((model) => model.supportsVision).map((model) => model.id) : undefined,
        ...(() => {
          const current = providers.find((item) => item.id === id)
          const hit = result.models.find((model) => model.id === current?.model)
          return hit?.contextWindow ? { contextWindow: hit.contextWindow } : {}
        })()
      })
      setTestStatus((current) => ({ ...current, [id]: { state: 'ok', detail: `${ids.length} modelo(s) detectado(s) (${result.source}). Salve para aplicar.` } }))
    } catch (err) {
      setTestStatus((current) => ({ ...current, [id]: { state: 'erro', detail: errorMessage(err) } }))
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    setNotice('')
    // `mcpServers` is not part of this dialog: the connectors are added, edited and removed in Personalização → Conectores,
    // so saving here never sends (or overwrites) them.
    let hooks: HooksConfig
    try {
      const parsed = JSON.parse(hooksText.trim() || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('a raiz deve ser um objeto')
      hooks = parsed as HooksConfig
    } catch (err) {
      setError(`Hooks inválidos: ${errorMessage(err)}`)
      setTab('policy')
      return
    }

    const lines = (text: string): string[] =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

    const nextPolicy: PolicyConfig = {
      ...policy,
      blockedCommands: lines(blockedText),
      allowedRoots: lines(rootsText),
      rules: { allow: lines(rulesText.allow), ask: lines(rulesText.ask), deny: lines(rulesText.deny) }
    }

    let environments: AppSettings['environments'] = []
    try {
      const parsed = JSON.parse(environmentsText) as unknown
      if (!Array.isArray(parsed)) throw new Error('use uma lista JSON')
      environments = parsed as AppSettings['environments']
    } catch (err) {
      setError(`Ambientes inválidos: ${errorMessage(err)}`)
      setTab('policy')
      return
    }

    setSaving(true)
    try {
      await onSave({
        providers,
        defaultProviderId: defaultId,
        theme,
        profileName,
        policy: nextPolicy,
        autoAgents,
        useAllModels,
        fallbackOrder,
        fallbackExclude,
        fallbackModels,
        // An empty pair means "automatic": the main process stores nothing for it.
        visionModel: visionChoice
          ? { providerId: visionChoice.split('::')[0], model: visionChoice.slice(visionChoice.indexOf('::') + 2) }
          : { providerId: '', model: '' },
        selfRepair,
        notifications,
        updates: { feedUrl: updateFeed.trim(), autoCheck: autoCheckUpdates },
        environments,
        limits,
        hooks,
        importClaudeSettings: importClaude,
        voice,
        browser: { mode: browserMode, groupBySession: settings.browser?.groupBySession !== false, fallbackToManaged: browserFallback }
      })
      setNotice('Configurações salvas.')
      setTimeout(() => setNotice(''), 2500)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const refreshMcpBackups = async (): Promise<void> => {
    const result = await window.forja.app.mcpBackups()
    setMcpBackups(result.ok ? result.value : [])
  }

  const clearMcpBackups = async (): Promise<void> => {
    setMcpBackupBusy(true)
    try {
      const { removed } = await unwrap(window.forja.app.clearMcpBackups())
      setNotice(`${removed} cópia(s) antiga(s) apagada(s).`)
      setTimeout(() => setNotice(''), 2500)
      await refreshMcpBackups()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setMcpBackupBusy(false)
    }
  }

  const refreshMemoryView = async (): Promise<void> => {
    if (!memoryProjectId) return
    const [status, list] = await Promise.all([
      window.forja.memory.status(memoryProjectId),
      window.forja.memory.list(memoryProjectId)
    ])
    setMemoryStats(status.ok ? status.value : null)
    setMemoryPages(list.ok ? list.value : [])
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Configurações">
        <header className="modal-head">
          <div>
            <h2>Configurações</h2>
            <p>Provedores, permissões e integrações do Openclod.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Fechar">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="settings-sheet">
          <nav className="settings-nav" aria-label="Seções das configurações">
            <button type="button" className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
              <Icon name="cpu" size={15} /> Provedores
            </button>
            <button type="button" className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>
              <Icon name="image" size={15} /> Aparência
            </button>
            <button type="button" className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}>
              <Icon name="mic" size={15} /> Voz
            </button>
            <button type="button" className={tab === 'policy' ? 'active' : ''} onClick={() => setTab('policy')}>
              <Icon name="shield" size={15} /> Permissões
            </button>
            <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
              <Icon name="archive" size={15} /> Memória
            </button>
            <button type="button" className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
              <Icon name="plug" size={15} /> MCP
            </button>
            <button type="button" className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>
              <Icon name="archive" size={15} /> Backup
            </button>
            <button type="button" className={tab === 'harness' ? 'active' : ''} onClick={() => setTab('harness')}>
              <Icon name="sparkles" size={15} /> Harness
            </button>
            <button type="button" className={tab === 'diagnostics' ? 'active' : ''} onClick={() => setTab('diagnostics')}>
              <Icon name="gauge" size={15} /> Diagnóstico
            </button>
            <button type="button" className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>
              <Icon name="spark" size={15} /> Sobre
            </button>
            <div className="settings-nav-foot">
              <span>Openclod Desktop</span>
              <em>v{versions?.app ?? '0.1.0'}</em>
            </div>
          </nav>

          <div className="modal-body">
          {error ? (
            <div className="inline-error">
              <Icon name="alert" size={14} /> {error}
            </div>
          ) : null}
          {notice ? <div className="inline-ok">{notice}</div> : null}

          {tab === 'providers' ? (
            <div className="providers">
              <div className="providers-toolbar">
                <p className="field-help">
                  A chave é cifrada com o DPAPI do Windows e nunca volta para a interface. Provedores locais
                  (Ollama/LM Studio) não precisam de chave.
                </p>
                <label className="check-line providers-fallback" title="Se o LLM em uso ficar sem saldo, bater o limite, recusar a chave ou cair, a conversa passa sozinha para o próximo da lista abaixo, com o mesmo histórico, plano e memória do projeto.">
                  <input
                    type="checkbox"
                    checked={useAllModels}
                    onChange={(event) => setUseAllModels(event.target.checked)}
                  />
                  Trocar sozinho para outro LLM quando um acabar (reserva)
                </label>
              </div>
              <p className="field-help">
                Quando o LLM da conversa ficar <strong>sem saldo</strong>, bater o limite, recusar a chave ou sair do ar,
                o Openclod passa a conversa para o próximo da lista abaixo que tenha chave e responda, sem perder a
                mensagem, o histórico, o plano nem a memória do projeto. A troca <strong>sempre é avisada na conversa</strong> e
                o seletor de modelo passa a mostrar o LLM novo; as conversas seguintes ficam nele e não tentam de novo o
                que acabou.
              </p>
              {useAllModels ? (
                <div className="reserve-box">
                  <strong className="reserve-title">Ordem da reserva</strong>
                  <p className="field-help">
                    Depois do LLM da conversa, o Openclod tenta estes, de cima para baixo. Só entram os que têm chave
                    (ou rodam neste computador) e respondem; um que acabou o saldo vai para o fim da fila e volta
                    sozinho depois de alguns minutos ou quando você salvar uma chave nova.
                  </p>
                  <ol className="reserve-list" aria-label="Ordem da reserva">
                    {orderedProviders(providers, fallbackOrder).map((provider, index, all) => {
                      const state = reserveState(provider)
                      const off = fallbackExclude.includes(provider.id)
                      const open = openReserve.includes(provider.id)
                      const models = reserveModelList(provider)
                      const picked = tickedModels(provider)
                      const query = (reserveSearch[provider.id] ?? '').trim().toLowerCase()
                      const visible = query ? models.filter((model) => model.toLowerCase().includes(query)) : models
                      const everyVisible = visible.length > 0 && visible.every((model) => picked.includes(model))
                      const someVisible = visible.some((model) => picked.includes(model))
                      return (
                        <li key={provider.id} className="reserve-item">
                        <div className={`reserve-row ${off ? 'is-off' : ''}`} data-provider={provider.id}>
                          <span className="reserve-pos">{index + 1}</span>
                          <label className="check-line reserve-name" title={off ? 'Fora da reserva' : 'Usado como reserva'}>
                            <input
                              type="checkbox"
                              checked={!off}
                              onChange={(event) =>
                                setFallbackExclude((current) =>
                                  event.target.checked ? current.filter((item) => item !== provider.id) : [...current, provider.id]
                                )
                              }
                            />
                            <strong>{provider.label}</strong>
                            <em>{reserveSummary(provider)}</em>
                          </label>
                          <button
                            type="button"
                            className={`reserve-expand ${open ? 'is-open' : ''}`}
                            aria-expanded={open}
                            aria-controls={`reserve-models-${provider.id}`}
                            aria-label={`Escolher os modelos de ${provider.label} na reserva`}
                            title="Escolher quais modelos deste provedor entram na reserva"
                            onClick={() => toggleReserveOpen(provider.id)}
                          >
                            <span>Modelos</span>
                            <Icon name="chevronDown" size={11} />
                          </button>
                          <span className={`reserve-status ${state.tone}`} title={testStatus[provider.id]?.detail}>{state.label}</span>
                          {testStatus[provider.id] && testStatus[provider.id].state !== 'testando' ? (
                            <span className={`reserve-test ${testStatus[provider.id].state === 'ok' ? 'ok' : 'bad'}`} title={testStatus[provider.id].detail}>
                              {testStatus[provider.id].state === 'ok' ? 'respondeu' : 'não respondeu'}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="icon-btn small"
                            aria-label={`Subir ${provider.label} na ordem`}
                            title="Subir"
                            disabled={index === 0}
                            onClick={() => moveReserve(provider.id, -1)}
                          >
                            <Icon name="arrowUp" size={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn small"
                            aria-label={`Descer ${provider.label} na ordem`}
                            title="Descer"
                            disabled={index === all.length - 1}
                            onClick={() => moveReserve(provider.id, 1)}
                          >
                            <Icon name="chevronDown" size={13} />
                          </button>
                        </div>
                        {open ? (
                          <div className="reserve-models" id={`reserve-models-${provider.id}`} data-provider-models={provider.id}>
                            <div className="reserve-models-head">
                              <label className="check-line reserve-all">
                                <input
                                  type="checkbox"
                                  checked={everyVisible}
                                  ref={(node) => {
                                    if (node) node.indeterminate = !everyVisible && someVisible
                                  }}
                                  disabled={!visible.length}
                                  onChange={(event) =>
                                    setTicked(
                                      provider,
                                      event.target.checked
                                        ? [...new Set([...picked, ...visible])]
                                        : picked.filter((model) => !visible.includes(model))
                                    )
                                  }
                                />
                                {query ? `Selecionar os ${visible.length} filtrados` : 'Selecionar todos'}
                              </label>
                              <span className="reserve-count">
                                {picked.length} de {models.length} marcados
                              </span>
                              {models.length > 8 ? (
                                <input
                                  className="reserve-search"
                                  value={reserveSearch[provider.id] ?? ''}
                                  onChange={(event) => setReserveSearch((current) => ({ ...current, [provider.id]: event.target.value }))}
                                  placeholder="Buscar modelo…"
                                  aria-label={`Buscar modelo de ${provider.label}`}
                                  spellCheck={false}
                                />
                              ) : null}
                            </div>
                            <ul className="reserve-model-list">
                              {visible.slice(0, RESERVE_MODELS_SHOWN).map((model) => (
                                <li key={model}>
                                  <label className="check-line">
                                    <input
                                      type="checkbox"
                                      data-model={model}
                                      checked={picked.includes(model)}
                                      onChange={(event) =>
                                        setTicked(provider, event.target.checked ? [...new Set([...picked, model])] : picked.filter((item) => item !== model))
                                      }
                                    />
                                    <span className="reserve-model-name">{model}</span>
                                    {model === provider.model ? <em>principal</em> : null}
                                    {modelSeesImages({ ...provider, model }) ? <em className="reserve-vision">imagens</em> : null}
                                  </label>
                                </li>
                              ))}
                            </ul>
                            {visible.length > RESERVE_MODELS_SHOWN ? (
                              <small className="field-help">Mostrando {RESERVE_MODELS_SHOWN} de {visible.length}: use a busca para achar os outros.</small>
                            ) : null}
                            {!picked.length ? (
                              <small className="field-help">Nenhum modelo marcado: este provedor fica fora da reserva.</small>
                            ) : null}
                            {picked.length > 12 ? (
                              <small className="field-help">A reserva tenta no máximo 40 modelos no total, de cima para baixo.</small>
                            ) : null}
                            <small className="field-help">Falta algum? Use "Detectar modelos" no cartão do provedor e salve.</small>
                          </div>
                        ) : null}
                        </li>
                      )
                    })}
                  </ol>
                  <div className="reserve-actions">
                    <button type="button" className="btn small subtle" onClick={() => void testReserve()} disabled={testingAll}>
                      <Icon name="plug" size={12} /> {testingAll ? 'Testando…' : 'Testar todos agora'}
                    </button>
                    <small className="field-help">
                      Envia um "ping" de poucos tokens a cada provedor da lista que tem chave e mostra quem responde e quem
                      está sem saldo.
                    </small>
                  </div>
                </div>
              ) : null}
              <label className="field vision-pick">
                <span>Modelo que descreve imagens para os LLMs que não enxergam</span>
                <select value={visionChoice} onChange={(event) => setVisionChoice(event.target.value)}>
                  <option value="">Automático (o primeiro da reserva que lê imagens)</option>
                  {providers.flatMap((provider) =>
                    visionModelsOf(provider).map((model) => (
                      <option key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>
                        {provider.label} · {model}
                      </option>
                    ))
                  )}
                </select>
                <small className="field-help">
                  Se o LLM da conversa não lê imagens (ou a reserva cai em um que não lê), um modelo que lê descreve
                  a imagem em texto e o LLM segue com a descrição.
                </small>
              </label>

              <div className="provider-usage-summary">
                <div>
                  <strong>Consumo por provedor</strong>
                  <span>
                    {totalUsageTokens
                      ? `${formatTokens(totalUsageTokens)} tokens${totalUsageCached ? ` (+${formatTokens(totalUsageCached)} em cache)` : ''}${totalUsageCost > 0 ? ` · US$ ${totalUsageCost.toFixed(2)}` : ''} desde o início`
                      : 'Nenhum consumo registrado ainda; as próximas chamadas aparecem aqui.'}
                  </span>
                </div>
                <button type="button" className="btn tiny ghost" onClick={() => void refreshUsage()}>
                  <Icon name="refresh" size={12} /> Atualizar
                </button>
              </div>

              {!selectedProvider ? (
                <ColabCard
                  provider={settings.providers.find((item) => item.id === 'colab')}
                  onChanged={onRefreshCapabilities}
                  onOpenProvider={(id) => setSelectedProvider(id)}
                />
              ) : null}

              {selectedProvider ? (
                <button type="button" className="btn ghost small provider-back" onClick={() => setSelectedProvider(null)}>
                  <Icon name="arrowLeft" size={14} /> Voltar para provedores
                </button>
              ) : (
                <div className="provider-grid pv-grid">
                  {providers.map((provider) => {
                    const local = provider.id === 'ollama' || provider.id === 'lmstudio' || /127\.0\.0\.1|localhost/.test(provider.baseUrl)
                    const failure = failureOf(provider.id)
                    const status = failure ?? (local ? 'local' : configured(provider.id) ? 'pronto' : 'sem chave')
                    const usage = usageByProvider.get(provider.id)
                    return (
                      <ProviderTile
                        key={provider.id}
                        id={provider.id}
                        label={provider.label}
                        model={provider.model}
                        status={status}
                        tone={failure ? 'bad' : status === 'pronto' || status === 'local' ? 'ok' : 'idle'}
                        modelCount={provider.models?.length}
                        usage={
                          usage
                            ? {
                                text: `${formatTokens(billableTokens(usage))} tokens${usage.costUsd > 0 ? ` · US$ ${usage.costUsd.toFixed(2)}` : ''}`,
                                title: `${formatTokens(usage.input)} entrada · ${formatTokens(usage.cachedInput)} cache · ${formatTokens(usage.output)} saída`
                              }
                            : undefined
                        }
                        isDefault={defaultId === provider.id}
                        onSelect={() => setSelectedProvider(provider.id)}
                      />
                    )
                  })}
                </div>
              )}

              {providers.map((provider) => selectedProvider === provider.id ? (
                <div key={provider.id} className={`provider-card ${defaultId === provider.id ? 'is-default' : ''}`}>
                  <div className="provider-head">
                    <label className="radio-line" title="Usar como provedor padrão">
                      <input
                        type="radio"
                        name="default-provider"
                        checked={defaultId === provider.id}
                        onChange={() => setDefaultId(provider.id)}
                      />
                      <ProviderLogo id={provider.id} label={provider.label} size={26} />
                      <strong>{provider.label}</strong>
                      <span className={`badge kind-${provider.kind}`}>{provider.kind}</span>
                      {configured(provider.id) ? <span className="badge ok">credencial ok</span> : null}
                    </label>
                    {providers.length > 1 && !provider.colab ? (
                      <button type="button" className="icon-btn small" title="Remover" onClick={() => removeProvider(provider.id)}>
                        <Icon name="trash" size={13} />
                      </button>
                    ) : null}
                  </div>

                  <div className="grid-2">
                    <label className="field">
                      <span>Modelo</span>
                      <input
                        value={provider.model}
                        onChange={(event) => updateProvider(provider.id, { model: event.target.value })}
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>Janela de contexto (tokens)</span>
                      <input
                        type="number"
                        min={1000}
                        value={provider.contextWindow}
                        onChange={(event) => updateProvider(provider.id, { contextWindow: Number(event.target.value) })}
                      />
                    </label>
                  </div>

                  <div className="provider-effort">
                    <span className="field-label">Esforço de raciocínio</span>
                    <div className="effort-levels">
                      {REASONING_EFFORTS.map((level) => (
                        <label key={level} className="check-line">
                          <input
                            type="checkbox"
                            checked={(provider.effortLevels ?? []).includes(level)}
                            onChange={(event) => {
                              const current = provider.effortLevels ?? []
                              const next = event.target.checked
                                ? [...current, level]
                                : current.filter((item) => item !== level)
                              updateProvider(provider.id, {
                                effortLevels: next.length
                                  ? REASONING_EFFORTS.filter((item) => next.includes(item))
                                  : undefined,
                                ...(provider.defaultEffort === level && !event.target.checked
                                  ? { defaultEffort: undefined }
                                  : {})
                              })
                            }}
                          />
                          {EFFORT_LABELS[level]}
                        </label>
                      ))}
                    </div>
                    <label className="field slim">
                      <span>Padrão para novas sessões</span>
                      <select
                        value={provider.defaultEffort ?? ''}
                        onChange={(event) =>
                          updateProvider(provider.id, {
                            defaultEffort: (event.target.value || undefined) as ReasoningEffort | undefined
                          })
                        }
                      >
                        <option value="">Automático</option>
                        {(provider.effortLevels?.length
                          ? provider.effortLevels
                          : effortLevelsFor(
                              provider.kind,
                              provider.model,
                              Boolean(provider.compat?.reasoningEffort),
                              provider.effortLevels
                            )
                        ).map((level) => (
                          <option key={level} value={level}>
                            {EFFORT_LABELS[level]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <small className="field-help">
                      Marque apenas os níveis que este provedor/modelo aceita. Vazio = detecção automática
                      (Anthropic e modelos OpenAI o-series/gpt-5). O esforço pode ser trocado por sessão no compositor.
                    </small>
                  </div>

                  <label className="field">
                    <span>Base URL</span>
                    <input
                      value={provider.baseUrl}
                      onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
                      spellCheck={false}
                      disabled={Boolean(provider.colab)}
                      title={provider.colab ? 'O endereço vem do código de conexão do Colab: cole um código novo para trocá-lo' : undefined}
                    />
                  </label>

                  <div className="inline-fields">
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={provider.supportsVision}
                        onChange={(event) => updateProvider(provider.id, { supportsVision: event.target.checked })}
                      />
                      suporta imagens
                    </label>
                    <label className="field slim">
                      <span>custo US$/Mtok (entrada)</span>
                      <input
                        type="number"
                        step="0.01"
                        value={provider.inputCostPerMTok ?? ''}
                        onChange={(event) =>
                          updateProvider(provider.id, {
                            inputCostPerMTok: event.target.value ? Number(event.target.value) : undefined
                          })
                        }
                      />
                    </label>
                    <label className="field slim">
                      <span>custo US$/Mtok (saída)</span>
                      <input
                        type="number"
                        step="0.01"
                        value={provider.outputCostPerMTok ?? ''}
                        onChange={(event) =>
                          updateProvider(provider.id, {
                            outputCostPerMTok: event.target.value ? Number(event.target.value) : undefined
                          })
                        }
                      />
                    </label>
                    <label className="field slim">
                      <span>custo US$/Mtok (cache)</span>
                      <input
                        type="number"
                        step="0.001"
                        value={provider.cachedInputCostPerMTok ?? ''}
                        onChange={(event) =>
                          updateProvider(provider.id, {
                            cachedInputCostPerMTok: event.target.value ? Number(event.target.value) : undefined
                          })
                        }
                      />
                    </label>
                  </div>

                  <div className="key-row">
                    {provider.colab ? (
                      <div className="field grow">
                        <span>Chave de API</span>
                        <small className="field-help">
                          Guardada no cofre do Windows e trocada junto com o endereço a cada código de conexão novo (cartão Google Colab, em
                          Provedores). Para remover este provedor e a chave, use <strong>Desconectar</strong> nesse cartão.
                        </small>
                      </div>
                    ) : (
                    <label className="field grow">
                      <span>
                        Chave de API {provider.apiKeyRef?.startsWith('env:') ? `(env ${provider.apiKeyRef.slice(4)})` : ''}
                      </span>
                      <input
                        type="password"
                        placeholder={configured(provider.id) ? '•••••••• (configurada)' : 'cole a chave aqui'}
                        value={keyDrafts[provider.id] ?? ''}
                        onChange={(event) =>
                          setKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))
                        }
                        spellCheck={false}
                        autoComplete="off"
                        disabled={!serverIds.has(provider.id)}
                        title={!serverIds.has(provider.id) ? 'Salve as configurações antes de gravar a chave' : undefined}
                      />
                    </label>
                    )}
                    <div className="key-actions">
                      {provider.colab ? null : (
                        <>
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => void saveKey(provider.id)}
                        disabled={!serverIds.has(provider.id) || !(keyDrafts[provider.id] ?? '').trim()}
                      >
                        <Icon name="key" size={12} /> Salvar chave
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => void clearKey(provider.id)}>
                        Limpar
                      </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn small subtle"
                        onClick={() => void testProvider(provider.id)}
                        disabled={!configured(provider.id)}
                      >
                        <Icon name="plug" size={12} /> Testar
                      </button>
                      {provider.colab ? null : (
                      <button
                        type="button"
                        className="btn small subtle"
                        onClick={() => void detectModels(provider.id)}
                        disabled={!serverIds.has(provider.id)}
                        title="Lista os modelos que este servidor oferece (Ollama, LM Studio, OpenAI-compatível, Anthropic)"
                      >
                        <Icon name="refresh" size={12} /> Detectar modelos
                      </button>
                      )}
                    </div>
                  </div>
                  {keyStatus[provider.id] ? <div className="field-note">{keyStatus[provider.id]}</div> : null}
                  {testStatus[provider.id] ? (
                    <div className={`field-note ${testStatus[provider.id].state === 'erro' ? 'bad' : testStatus[provider.id].state === 'ok' ? 'good' : ''}`}>
                      {testStatus[provider.id].state}: {testStatus[provider.id].detail}
                    </div>
                  ) : null}
                </div>
              ) : null)}

              {!selectedProvider ? <div className="add-provider">
                <select value={presetKey} onChange={(event) => setPresetKey(event.target.value)}>
                  <option value="">Adicionar preset…</option>
                  {availablePresets.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn small subtle" onClick={addPreset} disabled={!availablePresets.length}>
                  <Icon name="plus" size={12} /> Preset
                </button>
                <button type="button" className="btn small ghost" onClick={addCustom}>
                  <Icon name="plus" size={12} /> OpenAI-compatível
                </button>
              </div> : null}
            </div>
          ) : null}

          {tab === 'appearance' ? (
            <div className="appearance">
              <h3>Como o Claude deve chamar você?</h3>
              <p className="field-help">Aparece na saudação do Início. Deixe vazio para usar só o horário.</p>
              <label className="field">
                <input
                  value={profileName}
                  maxLength={80}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder="Seu nome ou apelido"
                />
              </label>
              <h3>Tema</h3>
              <p className="field-help">
                O tema vale para toda a interface e é salvo nas configurações. A prévia muda imediatamente ao salvar.
              </p>
              <div className="theme-grid">
                <button
                  type="button"
                  className={`theme-card ${theme === 'dark' ? 'active' : ''}`}
                  onClick={() => setTheme('dark')}
                  aria-pressed={theme === 'dark'}
                >
                  <span className="theme-preview dark">
                    <i className="tp-side" />
                    <i className="tp-main">
                      <b />
                      <b />
                      <b className="wide" />
                    </i>
                  </span>
                  <span className="theme-label">
                    <strong>Escuro</strong>
                    <em>Grafite e marfim</em>
                  </span>
                  {theme === 'dark' ? <Icon name="check" size={14} /> : null}
                </button>
                <button
                  type="button"
                  className={`theme-card ${theme === 'light' ? 'active' : ''}`}
                  onClick={() => setTheme('light')}
                  aria-pressed={theme === 'light'}
                >
                  <span className="theme-preview light">
                    <i className="tp-side" />
                    <i className="tp-main">
                      <b />
                      <b />
                      <b className="wide" />
                    </i>
                  </span>
                  <span className="theme-label">
                    <strong>Claro</strong>
                    <em>Papel e tinta</em>
                  </span>
                  {theme === 'light' ? <Icon name="check" size={14} /> : null}
                </button>
              </div>

              <h3>Densidade</h3>
              <p className="field-help">
                A interface usa densidade confortável, com linhas de 28 px na barra lateral e mensagens com respiro
                de leitura. Zoom: use Ctrl + + / Ctrl + − do sistema.
              </p>

              <h3>Movimento</h3>
              <p className="field-help">
                As animações respeitam a preferência “reduzir movimento” do Windows: o indicador de raciocínio e os
                spinners ficam estáticos quando ela está ativa.
              </p>

              <h3>Notificações</h3>
              <p className="field-help">
                O centro de Atividades registra tudo; estas opções controlam apenas as notificações do Windows quando o
                Openclod não está em primeiro plano.
              </p>
              <div className="toggles">
                <label className="check-line">
                  <input type="checkbox" checked={notifications.desktop} onChange={(event) => setNotifications((current) => ({ ...current, desktop: event.target.checked }))} />
                  Mostrar notificações do Windows
                </label>
                <label className="check-line">
                  <input type="checkbox" checked={notifications.turnFinished} onChange={(event) => setNotifications((current) => ({ ...current, turnFinished: event.target.checked }))} />
                  Tarefas concluídas
                </label>
                <label className="check-line">
                  <input type="checkbox" checked={notifications.failures} onChange={(event) => setNotifications((current) => ({ ...current, failures: event.target.checked }))} />
                  Falhas e erros
                </label>
                <label className="check-line">
                  <input type="checkbox" checked={notifications.approvals} onChange={(event) => setNotifications((current) => ({ ...current, approvals: event.target.checked }))} />
                  Aprovações necessárias
                </label>
              </div>
              <div className="grid-3">
                <label className="field">
                  <span>Prioridade mínima</span>
                  <select value={notifications.minimumSeverity} onChange={(event) => setNotifications((current) => ({ ...current, minimumSeverity: event.target.value as NotificationPreferences['minimumSeverity'] }))}>
                    <option value="info">Tudo</option>
                    <option value="success">Conclusões em diante</option>
                    <option value="warning">Avisos em diante</option>
                    <option value="error">Somente erros</option>
                  </select>
                </label>
                <label className="field">
                  <span>Silêncio a partir de</span>
                  <input type="time" value={notifications.quietStart ?? ''} onChange={(event) => setNotifications((current) => ({ ...current, quietStart: event.target.value || undefined }))} />
                </label>
                <label className="field">
                  <span>Silêncio até</span>
                  <input type="time" value={notifications.quietEnd ?? ''} onChange={(event) => setNotifications((current) => ({ ...current, quietEnd: event.target.value || undefined }))} />
                </label>
              </div>
            </div>
          ) : null}

          {tab === 'voice' ? (
            <div className="appearance">
              <h3>Ditado por voz</h3>
              <p className="field-help">
                O botão de microfone do compositor escreve o que você fala enquanto você fala. O reconhecimento roda
                <strong> neste computador</strong>, com o Whisper embutido no Openclod: nenhum áudio sai da máquina.
              </p>
              {voiceStatus ? (
                voiceStatus.available ? (
                  <>
                    <div className="field-note good">
                      Pronto em {sttDeviceLabel(voiceStatus.device)}. Modelos embutidos:{' '}
                      {voiceStatus.models.map((model) => `${model.id} (${model.sizeMB} MB)`).join(', ')}.
                    </div>
                    <small className="field-help">
                      A GPU NVIDIA (CUDA) é usada automaticamente quando disponível. Sem GPU ou sem driver
                      compatível, o motor cai para CPU sem interromper o ditado.
                    </small>
                  </>
                ) : (
                  <div className="field-note bad">{voiceStatus.reason ?? 'O reconhecimento de voz não está disponível.'}</div>
                )
              ) : (
                <div className="field-note">Verificando…</div>
              )}
              <div className="field-row">
                <label className="field">
                  <span>Modelo</span>
                  <select value={voice.model} onChange={(event) => setVoice((current) => ({ ...current, model: event.target.value }))}>
                    {(voiceStatus?.models.length ? voiceStatus.models.map((model) => model.id) : [voice.model]).map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                  <small>Maior = mais preciso e mais lento. “base” é um bom ponto de partida; “small” entende melhor o português.</small>
                </label>
                <label className="field">
                  <span>Idioma</span>
                  <select value={voice.language} onChange={(event) => setVoice((current) => ({ ...current, language: event.target.value }))}>
                    <option value="pt">Português</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                    <option value="fr">Français</option>
                    <option value="de">Deutsch</option>
                    <option value="it">Italiano</option>
                    <option value="auto">Detectar automaticamente</option>
                  </select>
                  <small>Fixar o idioma evita erros em frases curtas.</small>
                </label>
              </div>

              <h3>Fluxo estilo Wispr Flow</h3>
              <p className="field-help">
                O botão de microfone do compositor é o gatilho principal: clique para falar, clique de novo para
                inserir. Se quiser falar de qualquer aplicativo, configure um atalho global opcional abaixo — por
                padrão não há nenhum.
              </p>
              <div className="field-row">
                <label className="field">
                  <span>Atalho global do microfone (opcional)</span>
                  <input
                    value={voice.shortcut ?? ''}
                    onChange={(event) => setVoice((current) => ({ ...current, shortcut: event.target.value }))}
                    placeholder="vazio = sem atalho"
                    spellCheck={false}
                  />
                  <small>
                    O botão de microfone do compositor funciona sempre; este atalho é opcional. Deixe vazio
                    para não registrar nenhum. Exemplos: <code>Control+Alt+Space</code>,{' '}
                    <code>Control+Super</code> (Ctrl+Win). Evite atalhos já usados pelo Windows.
                  </small>
                </label>
                <label className="field">
                  <span>Inserir em</span>
                  <select
                    value={voice.insert ?? 'focused'}
                    onChange={(event) =>
                      setVoice((current) => ({ ...current, insert: event.target.value === 'composer' ? 'composer' : 'focused' }))
                    }
                  >
                    <option value="focused">Qualquer aplicativo em foco (estilo Wispr Flow)</option>
                    <option value="composer">Somente no compositor do Openclod</option>
                  </select>
                  <small>
                    Em “qualquer aplicativo”, o texto é colado com o clipboard e Ctrl+V. Em campos que bloqueiam colagem, use o
                    compositor.
                  </small>
                </label>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={Boolean(voice.overlay)}
                  onChange={(event) => setVoice((current) => ({ ...current, overlay: event.target.checked }))}
                />
                Mostrar a pílula flutuante durante o ditado (desligado: o texto aparece direto no campo)
              </label>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={Boolean(voice.polish)}
                  onChange={(event) => setVoice((current) => ({ ...current, polish: event.target.checked }))}
                />
                Polir o texto com o modelo antes de inserir (corrige pontuação e vícios; consome tokens e envia o texto ao provedor
                configurado)
              </label>
              <p className="field-help">
                <strong>Modo:</strong> alternar (uma vez para ouvir, outra para inserir). O modo “segurar para falar” exige um
                gancho de teclado nativo e será habilitado junto com o helper de entrada.
              </p>

              <h3>Leitura em voz alta</h3>
              <p className="field-help">
                Escolha as vozes neurais gratuitas da Microsoft Edge, mais naturais, ou a síntese instalada no Windows.
                A voz neural usa internet e cai automaticamente para a voz offline do Windows se o serviço não responder.
              </p>
              <div className="field-row">
                <label className="field">
                  <span>Mecanismo</span>
                  <select
                    value={selectedTtsProvider}
                    onChange={(event) => {
                      const provider = event.target.value as 'edge' | 'windows'
                      setVoice((current) => ({
                        ...current,
                        ttsProvider: provider,
                        ttsVoice: provider === 'edge' ? 'pt-BR-FranciscaNeural' : ''
                      }))
                    }}
                  >
                    <option value="edge">Neural online · grátis</option>
                    <option value="windows">Windows offline</option>
                  </select>
                  <small>{selectedTtsProvider === 'edge' ? 'Vozes naturais; requer internet.' : 'Funciona sem rede.'}</small>
                </label>
                <label className="field">
                  <span>Voz</span>
                  <select value={voice.ttsVoice ?? ''} onChange={(event) => setVoice((current) => ({ ...current, ttsVoice: event.target.value }))}>
                    {selectedTtsProvider === 'windows' ? <option value="">Voz padrão do Windows</option> : null}
                    {selectedTtsVoices.map((item) => (
                      <option key={`${item.provider}:${item.id}`} value={item.id}>{item.displayName}{item.culture ? ` · ${item.culture}` : ''}</option>
                    ))}
                  </select>
                  <small>{selectedTtsVoices.length ? `${selectedTtsVoices.length} voz(es) disponível(is).` : 'Nenhuma voz enumerada; será usada a voz padrão.'}</small>
                </label>
                <label className="field">
                  <span>Velocidade: {voice.ttsRate ?? 0}</span>
                  <input type="range" min={-10} max={10} step={1} value={voice.ttsRate ?? 0} onChange={(event) => setVoice((current) => ({ ...current, ttsRate: Number(event.target.value) }))} />
                  <small>-10 mais lento · 0 normal · 10 mais rápido</small>
                </label>
                <label className="field">
                  <span>Volume: {voice.ttsVolume ?? 100}%</span>
                  <input type="range" min={0} max={100} step={5} value={voice.ttsVolume ?? 100} onChange={(event) => setVoice((current) => ({ ...current, ttsVolume: Number(event.target.value) }))} />
                </label>
              </div>
              <div className="field-row">
                <button
                  type="button"
                  className="btn small subtle"
                  onClick={async () => {
                    setError('')
                    try {
                      ttsPreviewAudio.current?.pause()
                      const result = await unwrap(window.forja.tts.speak({
                        text: 'Olá! Esta é a voz selecionada no Openclod.',
                        provider: selectedTtsProvider,
                        voice: voice.ttsVoice,
                        rate: voice.ttsRate,
                        volume: voice.ttsVolume
                      }))
                      // Replaced by another test or stopped while the voice was being made: nothing to play or say.
                      if (result.cancelled) return
                      if (result.audioBase64) {
                        const audio = new Audio(`data:${result.mediaType ?? 'audio/mpeg'};base64,${result.audioBase64}`)
                        audio.volume = Math.max(0, Math.min(1, (voice.ttsVolume ?? 100) / 100))
                        ttsPreviewAudio.current = audio
                        await audio.play()
                      }
                      setNotice(result.fallbackReason
                        ? `Serviço neural indisponível; usei a voz offline do Windows (${result.fallbackReason}).`
                        : `Teste iniciado com ${result.provider === 'edge' ? 'a voz neural' : 'a voz do Windows'}.`)
                    } catch (err) {
                      setError(errorMessage(err))
                    }
                  }}
                >
                  <Icon name="audioLines" size={13} /> Testar voz
                </button>
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    ttsPreviewAudio.current?.pause()
                    void window.forja.tts.stop()
                    setNotice('')
                  }}
                >
                  <Icon name="stop" size={13} /> Parar teste
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'policy' ? (
            <div className="policy">
              <h3>Modo de permissão</h3>
              <div className="permission-grid">
                {PERMISSION_CHOICES.map((choice) => (
                  <label
                    key={choice.id}
                    className={`permission-card ${policy.mode === choice.id ? 'active' : ''} ${choice.tone ?? ''}`}
                  >
                    <input
                      type="radio"
                      name="permission-mode"
                      checked={policy.mode === choice.id}
                      onChange={() => setPolicy((current) => ({ ...current, mode: choice.id }))}
                    />
                    <strong>{choice.title}</strong>
                    <span>{choice.detail}</span>
                  </label>
                ))}
              </div>

              <div className="toggles">
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={policy.allowNetwork}
                    onChange={(event) => setPolicy((current) => ({ ...current, allowNetwork: event.target.checked }))}
                  />
                  Permitir ferramentas de rede (fetch, busca, navegador)
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={policy.allowComputerControl}
                    onChange={(event) =>
                      setPolicy((current) => ({ ...current, allowComputerControl: event.target.checked }))
                    }
                  />
                  Permitir controle real de mouse e teclado
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={policy.fullAccess !== false}
                    onChange={(event) => setPolicy((current) => ({ ...current, fullAccess: event.target.checked }))}
                  />
                  Acesso total ao computador (qualquer pasta, não só o projeto)
                </label>
                <p className="field-help">
                  Ligado por padrão: o agente abre arquivos e trabalha em qualquer pasta do computador, como um
                  operador humano. Comandos destrutivos e arquivos de segredo continuam pedindo confirmação. Desligue
                  para confinar leituras e escritas às raízes abaixo.
                </p>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={autoAgents}
                    onChange={(event) => setAutoAgents(event.target.checked)}
                  />
                  Modo equipe: dividir tarefas em vários agentes (o esforço Máximo ativa automaticamente)
                </label>
                <p className="field-help">
                  Com o controle desligado, o agente pode listar janelas, ler a árvore de acessibilidade e capturar
                  tela, mas não pode clicar, digitar ou arrastar. Com o modo equipe ligado, o agente principal pode
                  chamar especialistas em paralelo; se não houver um especialista para o assunto, ele chama
                  <code> agent-smith</code> para criar um novo agente permanente em <code>%APPDATA%\Openclod\agents</code>.
                </p>
              </div>

              <h3>Navegador do agente</h3>
              <p className="field-help">
                Use o Chrome que já está aberto e preserve a sessão, as abas e os logins. O Openclod cria um grupo de
                abas por sessão e reaproveita o navegador em vez de iniciar outro.
              </p>
              <div className="grid-3">
                {([
                  ['auto', 'Automático', 'Chrome existente quando conectado; Playwright como fallback.'],
                  ['chrome-existing', 'Chrome existente', 'Exige a extensão; usa somente o Chrome já aberto.'],
                  ['playwright', 'Playwright', 'Instância isolada, sem depender da extensão.']
                ] as const).map(([id, title, detail]) => (
                  <label key={id} className={`permission-card ${browserMode === id ? 'active' : ''}`}>
                    <input type="radio" name="browser-mode" checked={browserMode === id} onChange={() => setBrowserMode(id)} />
                    <strong>{title}</strong>
                    <span>{detail}</span>
                  </label>
                ))}
              </div>
              {browserMode === 'chrome-existing' ? (
                <label className="check-line">
                  <input type="checkbox" checked={browserFallback} onChange={(event) => setBrowserFallback(event.target.checked)} />
                  <span>Se a extensão não estiver conectada, abrir um Chromium isolado (sem seus logins) em vez de falhar.</span>
                </label>
              ) : null}
              <div className={`field-note chrome-status ${browserCompanion?.extensionConnected && !browserCompanion.extensionOutdated ? 'ok' : 'warn'}`}>
                {browserCompanion ? (
                  <>
                    <div>
                      <strong>Host nativo:</strong> {browserCompanion.installed ? 'instalado' : 'pendente'}
                    </div>
                    <div>
                      <strong>Extensão:</strong>{' '}
                      {browserCompanion.extensionConnected
                        ? `conectada${browserCompanion.extensionVersion ? ` (v${browserCompanion.extensionVersion})` : ''}`
                        : 'não conectada'}
                      {browserCompanion.bundledVersion ? ` · no app: v${browserCompanion.bundledVersion}` : ''}
                    </div>
                    <div className="chrome-path" title={browserCompanion.extensionPath}>
                      Pasta: <code>{browserCompanion.extensionPath}</code>
                    </div>
                    <div>{browserCompanion.detail}</div>
                  </>
                ) : (
                  'Verificando integração com o Chrome…'
                )}
              </div>
              <ol className="chrome-steps">
                <li>Clique em <strong>Instalar integração</strong>: copia a extensão para uma pasta estável e registra o host nativo (Chrome, Edge e Brave).</li>
                <li>Clique em <strong>Abrir extensões</strong>, ative o <em>Modo do desenvolvedor</em> e use <em>Carregar sem compactação</em> na pasta indicada (use <strong>Mostrar pasta</strong> ou <strong>Copiar caminho</strong>).</li>
                <li>Pronto: o status acima muda para <em>conectada</em> e o ícone do Openclod aparece na barra do Chrome. O Chrome só permite esta confirmação manual para extensões fora da loja.</li>
              </ol>
              <div className="inline-fields">
                <button
                  type="button"
                  className="btn small primary"
                  disabled={browserBusy}
                  onClick={async () => {
                    setBrowserBusy(true)
                    setError('')
                    try {
                      const status = await unwrap(window.forja.app.installChromeCompanion())
                      setBrowserCompanion(status)
                      await onRefreshCapabilities()
                      setNotice('Host nativo instalado. Carregue a extensão em chrome://extensions uma vez.')
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBrowserBusy(false)
                    }
                  }}
                >
                  <Icon name="download" size={12} /> Instalar integração
                </button>
                <button
                  type="button"
                  className="btn small subtle"
                  disabled={browserBusy}
                  onClick={async () => {
                    setBrowserBusy(true)
                    setError('')
                    try {
                      setBrowserCompanion(await unwrap(window.forja.app.chromeCompanion()))
                      await onRefreshCapabilities()
                      setNotice('Status do Chrome atualizado.')
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBrowserBusy(false)
                    }
                  }}
                >
                  <Icon name="refresh" size={12} /> Verificar conexão
                </button>
                <button
                  type="button"
                  className="btn small subtle"
                  disabled={browserBusy}
                  onClick={async () => {
                    setBrowserBusy(true)
                    setError('')
                    try {
                      setBrowserCompanion(await unwrap(window.forja.app.openChromeExtensions()))
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBrowserBusy(false)
                    }
                  }}
                >
                  <Icon name="external" size={12} /> Abrir extensões
                </button>
                <button
                  type="button"
                  className="btn small subtle"
                  disabled={browserBusy}
                  onClick={async () => {
                    setError('')
                    try {
                      await unwrap(window.forja.app.revealChromeExtension())
                    } catch (err) {
                      setError(errorMessage(err))
                    }
                  }}
                >
                  <Icon name="folder" size={12} /> Mostrar pasta
                </button>
                <button
                  type="button"
                  className="btn small subtle"
                  disabled={!browserCompanion?.extensionPath}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(browserCompanion?.extensionPath ?? '')
                      setNotice('Caminho da extensão copiado.')
                      setTimeout(() => setNotice(''), 2500)
                    } catch {
                      setError('Não consegui copiar; selecione o caminho mostrado acima.')
                    }
                  }}
                >
                  <Icon name="copy" size={12} /> Copiar caminho
                </button>
                <button
                  type="button"
                  className="btn small subtle"
                  disabled={browserBusy}
                  onClick={async () => {
                    setBrowserBusy(true)
                    setError('')
                    try {
                      const packed = await unwrap(window.forja.app.exportChromeExtension())
                      setNotice(`Extensão v${packed.version} exportada: ${packed.path}`)
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBrowserBusy(false)
                    }
                  }}
                >
                  <Icon name="download" size={12} /> Exportar .zip
                </button>
              </div>

              <div className="grid-2">
                <label className="field">
                  <span>Comandos bloqueados (um por linha)</span>
                  <textarea
                    rows={5}
                    value={blockedText}
                    onChange={(event) => setBlockedText(event.target.value)}
                    placeholder={'git push\nnpm publish\nrm -rf'}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>Raízes extras permitidas (uma por linha)</span>
                  <textarea
                    rows={5}
                    value={rootsText}
                    onChange={(event) => setRootsText(event.target.value)}
                    placeholder={'C:\\projetos\\outro-repo'}
                    spellCheck={false}
                  />
                </label>
              </div>

              <h3>Regras de permissão</h3>
              <p className="field-help">
                Mesma sintaxe do Claude Code, uma regra por linha: <code>Bash(npm test:*)</code>,{' '}
                <code>Edit(src/**)</code>, <code>Read(.env)</code>, <code>WebFetch(domain:docs.python.org)</code>. Negar
                vence perguntar, que vence permitir; as regras valem antes do modo. "Permitir sempre" numa aprovação
                grava uma regra para o projeto.
              </p>
              <div className="grid-3">
                {(['allow', 'ask', 'deny'] as const).map((kind) => (
                  <label className="field" key={kind}>
                    <span>{kind === 'allow' ? 'Permitir' : kind === 'ask' ? 'Perguntar' : 'Negar'}</span>
                    <textarea
                      rows={6}
                      value={rulesText[kind]}
                      onChange={(event) => setRulesText((current) => ({ ...current, [kind]: event.target.value }))}
                      placeholder={kind === 'allow' ? 'Bash(npm test:*)' : kind === 'ask' ? 'Bash(git push:*)' : 'Read(secrets/**)'}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>

              <h3>Ambientes de execução</h3>
              <p className="field-help">
                Lista JSON usada pelo seletor do composer. <code>local</code> roda nesta máquina; <code>wsl</code> usa
                o WSL (opcionalmente com <code>distro</code>); <code>ssh</code> e <code>cloud</code> usam um prefixo de
                comando, por exemplo <code>{'{"id":"prod","label":"Produção","kind":"ssh","command":"ssh deploy@host","remoteCwd":"/srv/app"}'}</code>.
                O comando real escolhido na sessão é envolvido por esse prefixo.
              </p>
              <label className="field">
                <span>Perfis (JSON)</span>
                <textarea
                  rows={9}
                  value={environmentsText}
                  onChange={(event) => setEnvironmentsText(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="environment-checks">
                {(settings.environments ?? []).map((environment) => {
                  const check = environmentChecks[environment.id]
                  return (
                    <div key={environment.id} className="field-note">
                      <strong>{environment.label}</strong> · {environment.kind}
                      {check ? (
                        <span className={check.ok ? 'good' : 'bad'}>
                          {' '}— {check.ok ? 'conexão real confirmada' : 'falhou'}: {check.detail}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="btn small subtle"
                        disabled={checkingEnvironment === environment.id}
                        onClick={async () => {
                          setCheckingEnvironment(environment.id)
                          try {
                            const result = await unwrap(window.forja.app.environmentCheck(environment.id))
                            setEnvironmentChecks((current) => ({ ...current, [environment.id]: result }))
                          } catch (err) {
                            setEnvironmentChecks((current) => ({
                              ...current,
                              [environment.id]: { ok: false, detail: errorMessage(err), stdout: '', stderr: '' }
                            }))
                          } finally {
                            setCheckingEnvironment('')
                          }
                        }}
                      >
                        <Icon name="plug" size={11} /> {checkingEnvironment === environment.id ? 'Testando…' : 'Testar conexão'}
                      </button>
                    </div>
                  )
                })}
              </div>

              <h3>Hooks</h3>
              <p className="field-help">
                Formato do Claude Code (<code>PreToolUse</code>, <code>PostToolUse</code>, <code>UserPromptSubmit</code>,{' '}
                <code>Stop</code>, <code>SessionStart</code>, <code>PreCompact</code>, <code>Notification</code>). O
                comando recebe o evento em JSON pela entrada padrão; código de saída 2 bloqueia. Hooks de projeto ficam
                em <code>.forja/settings.json</code>.
              </p>
              <label className="field">
                <span>Hooks do usuário (JSON)</span>
                <textarea
                  rows={8}
                  value={hooksText}
                  onChange={(event) => setHooksText(event.target.value)}
                  placeholder={'{\n  "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write ." }] }]\n}'}
                  spellCheck={false}
                />
              </label>
              <label className="check-line">
                <input type="checkbox" checked={importClaude} onChange={(event) => setImportClaude(event.target.checked)} />
                Ler também <code>.claude/settings.json</code> dos projetos (permissões e hooks do Claude Code)
              </label>
              <p className="field-help">
                Hooks de projeto executam comandos do repositório. Ligue só para projetos em que você confia.
              </p>

              <h3>Limites de execução</h3>
              <div className="grid-3">
                <label className="field">
                  <span>Iterações</span>
                  <input
                    type="number"
                    min={1}
                    value={limits.maxIterations}
                    onChange={(event) => setLimits({ ...limits, maxIterations: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Chamadas de ferramenta</span>
                  <input
                    type="number"
                    min={1}
                    value={limits.maxToolCalls}
                    onChange={(event) => setLimits({ ...limits, maxToolCalls: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Tempo máximo (min)</span>
                  <input
                    type="number"
                    min={1}
                    value={Math.round(limits.maxWallClockMs / 60_000)}
                    onChange={(event) => setLimits({ ...limits, maxWallClockMs: Number(event.target.value) * 60_000 })}
                  />
                </label>
                <label className="field">
                  <span>Tokens por turno (0 = automático)</span>
                  <input
                    type="number"
                    min={0}
                    step={100_000}
                    value={limits.maxTokens}
                    onChange={(event) => setLimits({ ...limits, maxTokens: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Custo máximo (US$)</span>
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    value={limits.maxCostUsd}
                    onChange={(event) => setLimits({ ...limits, maxCostUsd: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Ferramentas em paralelo</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={limits.maxParallelTools}
                    onChange={(event) => setLimits({ ...limits, maxParallelTools: Number(event.target.value) })}
                  />
                </label>
              </div>

              <p className="field-help">
                Tokens por turno conta entrada não cacheada + saída. 0 = automático: máx(6M, 10× a janela do
                modelo). Iterações, tempo e custo continuam valendo como limites independentes.
              </p>

              <p className="field-help">
                Modos de agente disponíveis no compositor:{' '}
                {AGENT_MODES.map((mode) => MODE_LABELS[mode]).join(' · ')}.
              </p>
            </div>
          ) : null}

          {tab === 'mcp' ? (
            <div className="mcp mcp-settings">
              <p className="field-help">
                Os conectores (servidores MCP) ficam em <strong>Personalização → Conectores</strong>, numa tela só: lá você
                conecta os do diretório, adiciona o seu por endereço ou por um programa deste computador, edita, vê as
                ferramentas, escolhe a permissão de cada uma e desconecta. Logins e chaves ficam no cofre do sistema, nunca
                nesta tela nem no arquivo de configuração. As ferramentas aparecem para o agente como{' '}
                <code>mcp__servidor__ferramenta</code>.
              </p>
              <div>
                <button type="button" className="btn primary" onClick={() => onOpenConnectors?.()} disabled={!onOpenConnectors}>
                  <Icon name="plug" size={13} /> Abrir Conectores
                </button>
              </div>
              {mcpBackups.some((backup) => backup.mayHaveSecrets) ? (
                <div className="cnx-callout tone-warn" role="alert" data-testid="mcp-backup-warning">
                  <Icon name="alert" size={15} />
                  <div>
                    <strong>Há cópias antigas do settings.json com segredos em texto puro</strong>
                    <p>
                      Antes de passar as chaves dos conectores para o cofre do sistema, o Openclod guardou uma cópia do arquivo:{' '}
                      {mcpBackups.filter((backup) => backup.mayHaveSecrets).map((backup) => backup.name).join(', ')}. Elas ainda
                      contêm as chaves antigas. Se os conectores já funcionam, você pode apagar essas cópias.
                    </p>
                    <div className="cnx-actions">
                      <button
                        type="button"
                        className="btn small danger"
                        disabled={mcpBackupBusy}
                        onClick={() => {
                          if (window.confirm('Apagar as cópias antigas do settings.json? As chaves que estão só nelas serão perdidas; as que já estão no cofre do sistema não mudam.')) void clearMcpBackups()
                        }}
                      >
                        <Icon name="trash" size={12} /> {mcpBackupBusy ? 'Apagando…' : 'Apagar cópias antigas'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'memory' ? (
            <div className="appearance">
              <h3>Memória de longo prazo</h3>
              <p className="field-help">
                Cada projeto tem a sua própria wiki markdown, independente do modelo ou provedor. O agente lê o briefing no
                início da sessão e usa <code>memory_brief</code>, <code>memory_page</code> e <code>memory_handoff</code> para
                consultar, gravar e passar o bastão. Tudo fica no disco local; nenhum texto é enviado a um serviço de memória.
              </p>

              {!memoryProjectId ? (
                <div className="field-note">Abra um projeto para ver e gerenciar a memória dele.</div>
              ) : (
                <>
                  <div className="field-note">
                    {memoryStats
                      ? `${memoryStats.pages} página(s) · ${memoryStats.pinned} fixada(s) · ${memoryStats.openHandoffs} handoff(s) aberto(s) · ${memoryStats.conflicts ?? 0} conflito(s) possível(is) · ${memoryStats.superseded ?? 0} substituída(s) · ${memoryStats.invalidated ?? 0} invalidada(s)`
                      : 'Carregando…'}
                  </div>
                  <div className="field-row">
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        if (!memoryProjectId) return
                        void window.forja.memory.open(memoryProjectId).then(() => setMemoryNotice('Pasta aberta no Explorer.'))
                      }}
                    >
                      <Icon name="folderOpen" size={14} /> Abrir pasta
                    </button>
                    <button type="button" className="btn ghost" onClick={() => void refreshMemoryView()}>
                      <Icon name="refresh" size={14} /> Atualizar
                    </button>
                  </div>
                  {memoryNotice ? <div className="field-note good">{memoryNotice}</div> : null}

                  <div className="memory-list">
                    {memoryPages.length ? (
                      memoryPages.map((page) => (
                        <div className="memory-row" key={page.slug}>
                          <button
                            type="button"
                            className="memory-title"
                            onClick={() => {
                              if (!memoryProjectId) return
                              void window.forja.memory.read(memoryProjectId, page.slug).then((result) => {
                                if (result.ok) setMemoryPage(result.value)
                              })
                            }}
                          >
                            {page.title}
                          </button>
                          {page.memoryType ? <span className={`memory-badge type-${page.memoryType}`}>{page.memoryType}</span> : null}
                          {page.status && page.status !== 'active' ? <span className={`memory-badge status-${page.status}`}>{page.status}</span> : null}
                          {page.possibleConflicts?.length ? <span className="memory-badge conflict">{page.possibleConflicts.length} conflito(s)</span> : null}
                          <span className="memory-meta">
                            {new Date(page.updated).toLocaleString('pt-BR')}
                            {page.pinned ? ' · fixada' : ''}
                            {page.confidence ? ` · ${page.confidence}` : ''}
                          </span>
                          {page.source !== 'ai-memory' && page.status !== 'invalidated' ? (
                            <button
                              type="button"
                              className="msg-action"
                              title="Invalidar sem apagar o histórico"
                              onClick={async () => {
                                if (!memoryProjectId) return
                                const reason = await promptText({
                                  title: 'Invalidar página',
                                  label: `Motivo para invalidar "${page.title}"`,
                                  initial: 'informação não é mais válida',
                                  confirmLabel: 'Invalidar'
                                })
                                if (reason === null) return
                                void window.forja.memory.invalidate(memoryProjectId, page.slug, reason).then(async (result) => {
                                  if (result.ok && result.value) {
                                    setMemoryNotice(`Página "${page.title}" invalidada; o histórico foi preservado.`)
                                    if (memoryPage?.slug === page.slug) {
                                      const refreshed = await window.forja.memory.read(memoryProjectId, page.slug)
                                      if (refreshed.ok) setMemoryPage(refreshed.value)
                                    }
                                    await refreshMemoryView()
                                  }
                                })
                              }}
                            >
                              <Icon name="x" size={13} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="msg-action"
                            title="Excluir página"
                            onClick={() => {
                              if (!memoryProjectId) return
                              if (!window.confirm(`Excluir a página "${page.title}"?`)) return
                              void window.forja.memory.delete(memoryProjectId, page.slug).then(async (result) => {
                                if (result.ok && result.value) {
                                  setMemoryNotice(`Página "${page.title}" excluída.`)
                                  if (memoryPage?.slug === page.slug) setMemoryPage(null)
                                  await refreshMemoryView()
                                }
                              })
                            }}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="field-note">
                        Ainda não há páginas. Peça ao agente para salvar uma decisão com <code>memory_page</code>.
                      </div>
                    )}
                  </div>

                  {memoryPage ? (
                    <div className="memory-preview">
                      <div className="memory-preview-head">
                        <strong>{memoryPage.title}</strong>
                        <span>{memoryPage.slug}</span>
                        {memoryPage.memoryType ? <span className="memory-badge">{memoryPage.memoryType}</span> : null}
                        {memoryPage.status && memoryPage.status !== 'active' ? <span className={`memory-badge status-${memoryPage.status}`}>{memoryPage.status}</span> : null}
                        <button type="button" className="icon-btn" title="Fechar" onClick={() => setMemoryPage(null)}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                      <pre>{memoryPage.body}</pre>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {tab === 'backup' ? (
            <div className="backup-center">
              <h3>Backup e restauração</h3>
              <p className="field-help">
                Um único arquivo compactado reúne projetos, sessões, preferências, memória, agentes, skills e rotinas.
                Chaves de API, tokens OAuth e o cofre DPAPI ficam de fora. Antes de qualquer restauração, o Openclod cria
                um backup completo do estado atual.
              </p>
              <div className="backup-hero">
                <span className="backup-hero-icon"><Icon name="shield" size={22} /></span>
                <span>
                  <strong>Backup com checksum SHA-256</strong>
                  <small>Formato versionado, arquivos e tamanho declarados e verificados na abertura.</small>
                </span>
              </div>
              <div className="backup-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={backupBusy}
                  onClick={async () => {
                    setBackupBusy(true)
                    setError('')
                    setNotice('')
                    setBackupRestoreInfo(null)
                    try {
                      const result = await unwrap(window.forja.app.backupExport())
                      if (result) {
                        setBackupInfo(result)
                        setNotice(`Backup criado: ${result.stats.files} arquivo(s), ${formatBytes(result.stats.bytes)}.`)
                      }
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBackupBusy(false)
                    }
                  }}
                >
                  <Icon name="download" size={14} /> {backupBusy ? 'Processando…' : 'Criar backup'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={backupBusy}
                  onClick={async () => {
                    setBackupBusy(true)
                    setError('')
                    setNotice('')
                    setBackupRestoreInfo(null)
                    try {
                      const result = await unwrap(window.forja.app.backupInspect())
                      if (result) {
                        setBackupInfo(result)
                        setNotice('Backup válido: checksum, versão e tamanho conferem.')
                      }
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBackupBusy(false)
                    }
                  }}
                >
                  <Icon name="search" size={14} /> Inspecionar
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={backupBusy}
                  onClick={async () => {
                    setBackupBusy(true)
                    setError('')
                    setNotice('')
                    try {
                      const result = await unwrap(window.forja.app.backupRestore())
                      if (result) {
                        setBackupInfo(result)
                        setBackupRestoreInfo(result)
                        setNotice(`Backup restaurado: ${result.restoredFiles} arquivo(s).`)
                      }
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBackupBusy(false)
                    }
                  }}
                >
                  <Icon name="archive" size={14} /> Restaurar
                </button>
              </div>
              {backupInfo ? (
                <div className="backup-details">
                  <dl className="about-grid">
                    <dt>Arquivo</dt>
                    <dd className="backup-path" title={backupInfo.path}>{backupInfo.path}</dd>
                    <dt>Criado em</dt>
                    <dd>{new Date(backupInfo.stats.createdAt).toLocaleString('pt-BR')}</dd>
                    <dt>Conteúdo</dt>
                    <dd>{backupInfo.stats.files} arquivo(s) · {formatBytes(backupInfo.stats.bytes)} descompactados</dd>
                    <dt>Versão</dt>
                    <dd>formato {backupInfo.stats.version} · Openclod {backupInfo.stats.appVersion ?? 'não informada'}</dd>
                    <dt>SHA-256</dt>
                    <dd className="backup-hash">{backupInfo.stats.sha256}</dd>
                  </dl>
                </div>
              ) : null}
              {backupRestoreInfo ? (
                <div className="backup-result">
                  <Icon name="checkCircle" size={15} />
                  <span>
                    Restaurado. Pré-backup criado com {backupRestoreInfo.preRestore.files} arquivo(s). Reinicie o
                    aplicativo para aplicar todas as preferências restauradas.
                  </span>
                </div>
              ) : null}

              <h4>Configuração portátil</h4>
              <p className="field-help">
                Exporta provedores, permissões, limites, ambientes, MCP, hooks e preferências em JSON validado.
                Credenciais, headers e valores sensíveis de ambiente são omitidos; na importação, segredos locais
                equivalentes são preservados.
              </p>
              <div className="backup-actions config-transfer-actions">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={backupBusy}
                  onClick={async () => {
                    setBackupBusy(true)
                    setError('')
                    setNotice('')
                    try {
                      const result = await unwrap(window.forja.app.exportConfiguration())
                      if (result) {
                        setConfigExportInfo(result)
                        setNotice(`Configuração exportada${result.warnings.length ? ` com ${result.warnings.length} campo(s) sensível(is) omitido(s)` : ''}.`)
                      }
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBackupBusy(false)
                    }
                  }}
                >
                  <Icon name="download" size={14} /> Exportar configuração
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={backupBusy}
                  onClick={async () => {
                    setBackupBusy(true)
                    setError('')
                    setNotice('')
                    try {
                      const result = await unwrap(window.forja.app.importConfiguration())
                      if (result) {
                        setConfigImportInfo(result)
                        await onSave({})
                        await onRefreshCapabilities()
                        setNotice(`Configuração importada: ${result.providers} provedor(es), ${result.mcpServers} servidor(es) MCP.`)
                      }
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setBackupBusy(false)
                    }
                  }}
                >
                  <Icon name="archive" size={14} /> Importar configuração
                </button>
              </div>
              {configExportInfo ? (
                <div className="field-note good">
                  {configExportInfo.path} · {formatBytes(configExportInfo.bytes)} · SHA-256 {configExportInfo.sha256.slice(0, 16)}…
                  {configExportInfo.warnings.length ? ` · ${configExportInfo.warnings.length} segredo(s) omitido(s)` : ''}
                </div>
              ) : null}
              {configImportInfo ? (
                <div className="field-note good">
                  Aplicado de {configImportInfo.path} · {configImportInfo.environments} ambiente(s) · {configImportInfo.mergedSensitiveFields} campo(s) sensível(is) local(is) preservado(s).
                  {configImportInfo.warnings.length ? <details><summary>{configImportInfo.warnings.length} aviso(s)</summary><pre>{configImportInfo.warnings.join('\n')}</pre></details> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'harness' ? (
            <div className="appearance">
              <h3>Auto-correção do harness</h3>
              <p className="field-help">
                Quando uma ferramenta ou o próprio harness falha, o agente pode abrir uma sessão de engenharia no
                código-fonte do Openclod, analisar a causa, corrigir, rodar typecheck/testes e recompilar. Desligado
                por padrão: com esta opção ativa, o agente pode alterar o harness sem pedir confirmação a cada passo.
              </p>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={selfRepair.enabled}
                  onChange={(event) => setSelfRepair((current) => ({ ...current, enabled: event.target.checked }))}
                />
                Permitir que o agente corrija e recompile o próprio harness
              </label>
              <label className="field">
                <span>Pasta do código-fonte do Openclod</span>
                <input
                  value={selfRepair.repoPath}
                  onChange={(event) => setSelfRepair((current) => ({ ...current, repoPath: event.target.value }))}
                  placeholder="C:\Users\Administrator\Desktop\Openclaudedescktop"
                  spellCheck={false}
                />
                <small>Precisa conter package.json e scripts/self-build.mjs.</small>
              </label>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={selfRepair.restartAfterRepair}
                  onChange={(event) =>
                    setSelfRepair((current) => ({ ...current, restartAfterRepair: event.target.checked }))
                  }
                />
                Aplicar automaticamente na próxima abertura as correções deixadas para “Reiniciar depois”
              </label>
              <p className="field-help">
                A sessão de correção roda no repositório do harness, não no projeto do usuário. Ela só reinicia
                quando o agente confirma que o build passou; se falhar, o app continua aberto com o relatório.
              </p>
            </div>
          ) : null}
          {tab === 'diagnostics' ? <DiagnosticsPanel /> : null}

          {tab === 'about' ? (
            <div className="about">
              <div className="about-mark">
                <Icon name="hammer" size={28} />
              </div>
              <h3>Openclod Desktop</h3>
              <p>
                Harness próprio em TypeScript, com ferramentas de código, navegador Playwright e Computer Use real no
                Windows. Interface e marca originais; algumas partes foram adaptadas de projetos MIT/Apache-2.0 (veja THIRD_PARTY_NOTICES.md). Nenhum código proprietário foi copiado.
              </p>
              <dl className="about-grid">
                <dt>Versão</dt>
                <dd>{versions?.app ?? '—'}</dd>
                <dt>Electron</dt>
                <dd>{versions?.electron ?? '—'}</dd>
                <dt>Chromium</dt>
                <dd>{versions?.chrome ?? '—'}</dd>
                <dt>Node</dt>
                <dd>{versions?.node ?? '—'}</dd>
                <dt>Plataforma</dt>
                <dd>{versions?.platform ?? '—'}</dd>
              </dl>
              <h4>Capacidades detectadas</h4>
              <ul className="cap-list">
                <li>
                  <Icon name="monitor" size={13} /> Computer Use:{' '}
                  {capabilities?.computer.available ? capabilities.computer.backend : 'indisponível'}
                  <em>{capabilities?.computer.detail}</em>
                </li>
                <li>
                  <Icon name="globe" size={13} /> Navegador: {capabilities?.browser.available ? 'disponível' : 'indisponível'}
                  <em>{capabilities?.browser.detail}</em>
                </li>
                <li>
                  <Icon name="mic" size={13} /> Voz (Whisper embutido): {voiceStatus ? (voiceStatus.available ? `pronto em ${sttDeviceLabel(voiceStatus.device)}` : 'indisponível') : '…'}
                  {voiceStatus && !voiceStatus.available && voiceStatus.reason ? <em>{voiceStatus.reason}</em> : null}
                </li>
                <li>
                  <Icon name="code" size={13} /> Toolchains da máquina:{' '}
                  {capabilities?.toolchains?.length ? capabilities.toolchains.map((item) => `${item.label} ${item.version}`).join(' · ') : 'nenhuma detectada'}
                  <em>Compiladores e runtimes dos seus projetos; o Openclod usa os que estiverem instalados.</em>
                </li>
                <li>
                  <Icon name="plug" size={13} /> Servidores MCP:{' '}
                  {capabilities?.mcp.length ? capabilities.mcp.map((server) => `${server.name} (${server.state})`).join(', ') : 'nenhum'}
                </li>
              </ul>
              <p className="field-help">
                Dados e sessões ficam em <code>%APPDATA%\Openclod</code> (sessions, config, logs). O código-fonte do projeto
                aberto nunca é copiado para fora dele, exceto o que o modelo recebe nas ferramentas.
              </p>
              <h4>Atualizações</h4>
              <p className="field-help">
                O manifesto e o instalador precisam usar HTTPS. O download só é aceito com tamanho e SHA-256 exatos;
                o Openclod não executa o instalador sozinho.
              </p>
              <label className="field">
                <span>URL do manifesto de atualização</span>
                <input value={updateFeed} onChange={(event) => setUpdateFeed(event.target.value)} placeholder="https://exemplo.com/openclod/latest.json" spellCheck={false} />
              </label>
              <label className="check-line">
                <input type="checkbox" checked={autoCheckUpdates} onChange={(event) => setAutoCheckUpdates(event.target.checked)} />
                Verificar ao abrir (a configuração é aplicada no próximo início)
              </label>
              <div className="backup-actions">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={updateBusy || !updateFeed.trim()}
                  onClick={async () => {
                    setUpdateBusy(true)
                    setError('')
                    setDownloadedUpdate(null)
                    try {
                      const result = await unwrap(window.forja.app.checkForUpdates())
                      setUpdateInfo(result)
                      setNotice(result.detail)
                    } catch (err) {
                      setError(errorMessage(err))
                    } finally {
                      setUpdateBusy(false)
                    }
                  }}
                >
                  <Icon name="refresh" size={13} /> {updateBusy ? 'Verificando…' : 'Verificar atualizações'}
                </button>
                {updateInfo?.available ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={updateBusy}
                    onClick={async () => {
                      setUpdateBusy(true)
                      setError('')
                      try {
                        const result = await unwrap(window.forja.app.downloadUpdate())
                        if (result) {
                          setDownloadedUpdate(result)
                          setNotice('Instalador baixado e verificado pelo SHA-256.')
                        }
                      } catch (err) {
                        setError(errorMessage(err))
                      } finally {
                        setUpdateBusy(false)
                      }
                    }}
                  >
                    <Icon name="download" size={13} /> Baixar e verificar
                  </button>
                ) : null}
              </div>
              {updateInfo?.available ? (
                <div className="field-note good">
                  Versão {updateInfo.latestVersion}: {updateInfo.notes ?? 'sem notas'} · {updateInfo.asset ? `${formatBytes(updateInfo.asset.size)} · SHA-256 ${updateInfo.asset.sha256.slice(0, 16)}…` : ''}
                </div>
              ) : null}
              {downloadedUpdate ? <div className="field-note good">{downloadedUpdate.path} · SHA-256 confirmado</div> : null}
            </div>
          ) : null}
          </div>
        </div>

        <footer className="modal-foot">
          <span className="footer-note">Alterações de política valem a partir do próximo turno.</span>
          <div>
            <button type="button" className="btn ghost" onClick={onClose}>
              Fechar
            </button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar alterações'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
