import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import type {
  AgentMode,
  EnvironmentProfile,
  ImagePart,
  PermissionMode,
  ProviderConfig,
  ReasoningEffort,
  RunState,
  SessionState,
  SkillInfo
} from '../../../shared/types'
import type { CustomCommandInfo } from '../../../shared/api'
import { Icon } from './Icons'
import { MenuPopover, type MenuItem } from './Chrome'
import { effortLevelsFor } from '../../../shared/reasoning'
import { formatTokens } from '../lib/format'
import { stopDictation, toggleDictation, useDictationSnapshot } from '../lib/dictation-store'
import {
  addPathAttachments,
  isInlineText,
  pathPromptBlock,
  type IncomingPath,
  type PathAttachment
} from '../lib/path-attachments'

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  readonly: 'Somente leitura',
  ask: 'Perguntar',
  'accept-edits': 'Aceitar edições',
  auto: 'Automático',
  // The mode with NO harness protection: named as in Claude Code, never as a "restricted" mode.
  unrestricted: 'Ignorar permissões'
}

const PERMISSION_HINTS: Record<PermissionMode, string> = {
  readonly: 'Só lê e pesquisa; nada é alterado.',
  ask: 'Pede aprovação para editar arquivos e rodar comandos.',
  'accept-edits': 'Edita arquivos sem perguntar; comandos ainda pedem aprovação.',
  auto: 'Executa sem perguntar; operações destrutivas e arquivos de segredo ainda pedem confirmação.',
  unrestricted: 'Sem bloqueios do harness; confirmações, blocklist e restrições de diretório desativadas.'
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Extra',
  max: 'Máximo'
}

const EFFORT_HINTS: Record<ReasoningEffort, string> = {
  low: 'Respostas rápidas, pouco raciocínio',
  medium: 'Equilíbrio para o dia a dia',
  high: 'Raciocínio mais profundo',
  xhigh: 'Tarefas longas de código e agentes',
  max: 'Máxima profundidade; mais lento e caro'
}

const BUSY_STATES: RunState[] = ['thinking', 'streaming', 'tool', 'waiting_approval']

const MAX_FILES = 8
const MAX_TEXT_BYTES = 320_000

export interface QueuedMessage {
  id: string
  text: string
  images: ImagePart[]
}

interface TextAttachment {
  id: string
  name: string
  size: number
  text: string
  truncated: boolean
}

interface BuiltinCommand {
  id: string
  label: string
  hint: string
  icon: 'plus' | 'settings' | 'image' | 'download' | 'refresh' | 'archive' | 'trash' | 'info' | 'sparkles'
}

const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { id: 'new', label: '/novo', hint: 'Nova sessão no projeto atual', icon: 'plus' },
  { id: 'compact', label: '/compactar', hint: 'Resumir o contexto da sessão', icon: 'refresh' },
  { id: 'export', label: '/exportar', hint: 'Baixar a sessão em JSON', icon: 'download' },
  { id: 'archive', label: '/arquivar', hint: 'Arquivar esta sessão', icon: 'archive' },
  { id: 'clear-queue', label: '/limpar-fila', hint: 'Esvaziar a fila de mensagens', icon: 'trash' },
  { id: 'theme', label: '/tema', hint: 'Alternar claro e escuro', icon: 'image' },
  { id: 'settings', label: '/config', hint: 'Abrir configurações', icon: 'settings' },
  { id: 'skills', label: '/skills', hint: 'Listar skills instaladas', icon: 'sparkles' }
]

/** What the model menu needs to know about a provider besides its models. */
export interface ProviderMenuState {
  /** Has a key (or needs none). Without one its models are not offered: sending would only fail. */
  ready: boolean
  /** Why the harness is working around it right now ("sem saldo ou cota"...), when it is. */
  failure?: string
}

interface ComposerProps {
  session: SessionState | null
  providers: ProviderConfig[]
  /** State of each provider by id; unknown providers are offered as they are. */
  providerStates?: Record<string, ProviderMenuState>
  providerId: string
  model: string
  mode: AgentMode
  permissionMode: PermissionMode
  runState: RunState
  variant: 'home' | 'chat' | 'cowork'
  queued: QueuedMessage[]
  skills: SkillInfo[]
  contextPercent: number
  /** Prompt size of the last call; not the cumulative session usage. */
  contextUsed: number
  /** Tokens counted against the turn budget (fresh input + output). */
  turnTokens: number
  turnLimit: number
  /** null = the model's own default depth. */
  effort: ReasoningEffort | null
  /** Execution environments available for this session. */
  environments?: EnvironmentProfile[]
  environmentId?: string
  workspaceName?: string
  seed?: { id: string; text: string; sessionId?: string | null }
  /** Text dictated by the global shortcut; inserted at the caret. */
  insert?: { id: string; text: string; sessionId?: string | null }
  onSend(text: string, images: ImagePart[]): Promise<boolean>
  onQueue(text: string, images: ImagePart[]): void
  /** Sending while busy: interrupts the running turn and handles this message next. */
  onInterruptSend(text: string, images: ImagePart[]): void
  /** Injects a queued prompt into the running turn instead of waiting for it. */
  onSendQueued(id: string): void
  onRemoveQueued(id: string): void
  onCommand(id: string): void
  onStop(): void
  onModeChange(mode: AgentMode): void
  onModelChange(providerId: string, model: string): void
  onEffortChange(effort: ReasoningEffort | null): void
  onPermissionChange(mode: PermissionMode): void
  onEnvironmentChange?(environmentId: string): void
  /** Home only: switch between plain Chat and Cowork without leaving Início. */
  onSurfaceChange?(mode: 'chat' | 'cowork'): void
  onOpenSettings(): void
  onAddProject(): void
}

let attachmentSeq = 0

function nextId(): string {
  attachmentSeq += 1
  return `att_${Date.now().toString(36)}_${attachmentSeq}`
}

export function Composer({
  session,
  providers,
  providerStates,
  providerId,
  model,
  mode,
  permissionMode,
  runState,
  variant,
  queued,
  skills,
  contextPercent,
  contextUsed,
  turnTokens,
  turnLimit,
  workspaceName,
  seed,
  insert,
  onSend,
  onQueue,
  onInterruptSend,
  onSendQueued,
  onRemoveQueued,
  onCommand,
  onStop,
  onModeChange,
  onModelChange,
  onEffortChange,
  onPermissionChange,
  effort,
  environments = [],
  environmentId,
  onEnvironmentChange,
  onOpenSettings,
  onAddProject,
  onSurfaceChange
}: ComposerProps): ReactElement {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImagePart[]>([])
  const [documents, setDocuments] = useState<TextAttachment[]>([])
  const [attachedPaths, setAttachedPaths] = useState<PathAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [effortOpen, setEffortOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [localError, setLocalError] = useState('')
  const [seedId, setSeedId] = useState<string | null>(null)
  const [insertId, setInsertId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const dictation = useDictationSnapshot()
  const busy = BUSY_STATES.includes(runState) || sending
  const provider = providers.find((item) => item.id === providerId) ?? providers[0]
  const modelLabel = model || provider?.model || 'modelo'
  const attachments = images.length + documents.length + attachedPaths.length
  const dictationActive =
    dictation.phase === 'loading' || dictation.phase === 'listening' || dictation.phase === 'stopping'
  const dictated =
    dictation.phase === 'listening' || dictation.phase === 'stopping' ? dictation.text.trim() : ''
  // Live speech is shown in the textarea without touching `text`; the final
  // text is inserted at the caret when dictation stops.
  const shownText = dictated
    ? `${text}${text && !/\s$/.test(text) ? ' ' : ''}${dictated}`
    : text

  const slashQuery = text.startsWith('/') && !text.includes('\n') && !text.includes(' ') ? text.slice(1).toLowerCase() : null
  const commands = useMemo(
    () => (slashQuery === null ? [] : BUILTIN_COMMANDS.filter((command) => command.id.includes(slashQuery) || command.label.includes(slashQuery))),
    [slashQuery]
  )
  // Custom commands (markdown templates in .claude/commands, .openclod/commands or the user's commands folder).
  const [customCommands, setCustomCommands] = useState<CustomCommandInfo[]>([])
  const commandsCwd = session?.meta.cwd ?? ''
  useEffect(() => {
    if (!commandsCwd) {
      setCustomCommands([])
      return
    }
    let cancelled = false
    void window.openclod.commands.list(commandsCwd).then((result) => {
      if (!cancelled) setCustomCommands(result.ok ? result.value : [])
    })
    return () => {
      cancelled = true
    }
  }, [commandsCwd, session?.meta.id])
  const customMatches = useMemo(
    () => (slashQuery === null ? [] : customCommands.filter((command) => command.name.includes(slashQuery) || command.description.toLowerCase().includes(slashQuery)).slice(0, 12)),
    [customCommands, slashQuery]
  )
  const skillMatches = useMemo(
    () =>
      slashQuery === null
        ? []
        : skills.filter(
            (skill) =>
              skill.name.toLowerCase().includes(slashQuery) ||
              skill.description.toLowerCase().includes(slashQuery)
          ).slice(0, 8),
    [skills, slashQuery]
  )
  const slashRows = commands.length + customMatches.length + skillMatches.length
  const slashOpen = slashQuery !== null && slashRows > 0

  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(220, Math.max(variant === 'home' ? 28 : 24, node.scrollHeight))}px`
  }, [shownText, variant])

  // While dictating, keep the caret blinking at the end of the live text.
  // Only do this when the composer already owns focus, so the global shortcut
  // used in another app never steals focus from that app.
  useEffect(() => {
    if (!dictationActive) return
    const node = textareaRef.current
    if (!node || document.activeElement !== node) return
    const end = node.value.length
    node.setSelectionRange(end, end)
  }, [shownText, dictationActive])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [session?.meta.id])

  useEffect(() => {
    if (!seed || seed.id === seedId) return
    // A seed created for another session/project must not leak into this one.
    if ((seed.sessionId ?? null) !== (session?.meta.id ?? null)) return
    setSeedId(seed.id)
    setText(seed.text)
    textareaRef.current?.focus()
  }, [seed, seedId, session?.meta.id])

  // Global dictation: insert at the caret instead of replacing what the user typed.
  useEffect(() => {
    if (!insert || insert.id === insertId) return
    if ((insert.sessionId ?? null) !== (session?.meta.id ?? null)) return
    setInsertId(insert.id)
    const addition = insert.text
    const node = textareaRef.current
    if (!node) {
      setText((current) => (current ? `${current} ${addition}` : addition))
      return
    }
    const start = node.selectionStart ?? text.length
    const end = node.selectionEnd ?? start
    setText(`${text.slice(0, start)}${addition}${text.slice(end)}`)
    requestAnimationFrame(() => {
      node.focus()
      const caret = start + addition.length
      node.setSelectionRange(caret, caret)
    })
  }, [insert, insertId, text, session?.meta.id])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery])

  const composed = (): { text: string; images: ImagePart[] } => {
    const blocks = documents
      .map(
        (doc) =>
          `\n\n<anexo nome="${doc.name.replace(/"/g, '')}"${doc.truncated ? ' truncado="true"' : ''}>\n\`\`\`\n${doc.text}\n\`\`\`\n</anexo>`
      )
      .join('')
    return { text: `${text}${blocks}${pathPromptBlock(attachedPaths)}`.trim(), images }
  }

  const submit = async (): Promise<void> => {
    stopDictation()
    const payload = composed()
    if ((!payload.text && !payload.images.length) || busy || dictationActive) return
    setSending(true)
    // Feedback first: the box empties the moment the user sends, and gets its content back if the app refuses the
    // message. It used to stay full until the main process answered, which looked like a frozen app whenever
    // starting the turn took a while.
    const snapshot = { text, images, documents, attachedPaths }
    setText('')
    setImages([])
    setDocuments([])
    setAttachedPaths([])
    let accepted = false
    try {
      accepted = await onSend(payload.text, payload.images)
    } finally {
      if (!accepted) {
        setText((current) => (current ? current : snapshot.text))
        setImages((current) => (current.length ? current : snapshot.images))
        setDocuments((current) => (current.length ? current : snapshot.documents))
        setAttachedPaths((current) => (current.length ? current : snapshot.attachedPaths))
      }
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const queue = (): void => {
    stopDictation()
    const payload = composed()
    if ((!payload.text && !payload.images.length) || dictationActive) return
    onQueue(payload.text, payload.images)
    setText('')
    setImages([])
    setDocuments([])
    setAttachedPaths([])
    textareaRef.current?.focus()
  }

  /** Enviar com um turno em andamento: interrompe o turno atual e atende esta mensagem em seguida. */
  const interruptSend = (): void => {
    stopDictation()
    const payload = composed()
    if ((!payload.text && !payload.images.length) || dictationActive) return
    onInterruptSend(payload.text, payload.images)
    setText('')
    setImages([])
    setDocuments([])
    setAttachedPaths([])
    textareaRef.current?.focus()
  }

  const selectSlash = (row: number): void => {
    if (row < commands.length) {
      const command = commands[row]
      setText('')
      onCommand(command.id)
      return
    }
    const custom = customMatches[row - commands.length]
    if (custom) {
      setText(`/${custom.name} `)
      textareaRef.current?.focus()
      return
    }
    const skill = skillMatches[row - commands.length - customMatches.length]
    if (!skill) return
    setText(`Use a skill "${skill.name}" para esta tarefa: `)
    textareaRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While dictating, Enter must not send and the slash menu must stay closed.
    if (dictationActive) return
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex((value) => (value + 1) % slashRows)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex((value) => (value - 1 + slashRows) % slashRows)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.ctrlKey)) {
        event.preventDefault()
        selectSlash(slashIndex)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setText('')
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      // Ocupado + Enter simples → interrompe o turno e atende esta mensagem. Ctrl+Enter sempre enfileira.
      if (busy && !event.ctrlKey) interruptSend()
      else if (event.ctrlKey || busy) queue()
      else void submit()
    }
  }

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    setLocalError('')
    const room = MAX_FILES - attachments
    if (room <= 0) {
      setLocalError(`Máximo de ${MAX_FILES} anexos por mensagem.`)
      return
    }
    const list = Array.from(files).slice(0, room)
    /** Absolute path when the file came from the OS; empty for clipboard blobs. */
    const pathOf = (file: File): string => {
      try {
        return window.openclod.paths.fromFile(file)
      } catch {
        return ''
      }
    }
    /** Binaries and oversized text are attached by path, never decoded. */
    const references: IncomingPath[] = []

    for (const file of list) {
      const path = pathOf(file)
      if (file.type.startsWith('image/')) {
        if (file.size <= 12_000_000) {
          const result = await new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result ?? ''))
            reader.readAsDataURL(file)
          })
          const [header, data] = result.split(',')
          if (!data) continue
          const mediaType = (header.match(/data:(image\/[a-z+]+)/)?.[1] ?? 'image/png') as ImagePart['mediaType']
          setImages((current) => [...current.slice(0, MAX_FILES - 1), { type: 'image', mediaType, data, label: file.name }])
          continue
        }
        if (path) {
          references.push({ path, kind: 'file' })
          continue
        }
        setLocalError(`${file.name}: imagem maior que 12 MB e sem caminho acessível.`)
        continue
      }

      const text = isInlineText(file.name, file.type)
      if (text && file.size <= MAX_TEXT_BYTES * 4) {
        const raw = await file.text()
        const truncated = raw.length > MAX_TEXT_BYTES
        setDocuments((current) => [
          ...current.slice(0, MAX_FILES - 1),
          { id: nextId(), name: file.name, size: file.size, text: truncated ? raw.slice(0, MAX_TEXT_BYTES) : raw, truncated }
        ])
        continue
      }

      if (path) {
        references.push({ path, kind: 'file' })
        continue
      }
      setLocalError(
        text
          ? `${file.name}: texto grande demais para embutir e sem caminho acessível.`
          : `${file.name}: arraste este arquivo do Explorer para anexar pelo caminho.`
      )
    }

    if (references.length) addPaths(references)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = event.clipboardData.files
    if (files.length) void addFiles(files)
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  const addPaths = (incoming: IncomingPath[]): void => {
    setLocalError('')
    if (!incoming.length) return
    if (attachments >= MAX_FILES) {
      setLocalError(`Máximo de ${MAX_FILES} anexos por mensagem.`)
      return
    }
    // Functional update: a mixed drop can add a folder and a file in the same
    // pass, and both must survive the other's stale closure.
    setAttachedPaths((current) => {
      const room = MAX_FILES - (images.length + documents.length + current.length)
      if (room <= 0) return current
      return addPathAttachments(current, incoming, current.length + room)
    })
  }

  const pickFolder = async (): Promise<void> => {
    const result = await window.openclod.paths.pickFolder()
    if (!result.ok) {
      setLocalError(result.error)
      return
    }
    if (result.value) addPaths([{ path: result.value, kind: 'folder' }])
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragActive(false)
    const items = Array.from(event.dataTransfer.items ?? [])
    const incoming: IncomingPath[] = []
    const dropped: File[] = []
    for (const item of items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      let directory = false
      try {
        directory = item.webkitGetAsEntry()?.isDirectory === true
      } catch {
        /* older Chromium: fall back to the File itself */
      }
      if (directory) {
        let path = ''
        try {
          path = file ? window.openclod.paths.fromFile(file) : ''
        } catch {
          /* the preload bridge may reject synthetic File objects */
        }
        if (path) incoming.push({ path, kind: 'folder' })
        else setLocalError('Não foi possível ler o caminho da pasta arrastada.')
        continue
      }
      if (file) dropped.push(file)
    }
    // Some drag sources only fill `files`; only used when `items` is empty.
    if (!items.length && event.dataTransfer.files.length) dropped.push(...Array.from(event.dataTransfer.files))
    if (incoming.length) addPaths(incoming)
    if (dropped.length) void addFiles(dropped)
  }

  const modelItems: MenuItem[] = []
  const query = modelQuery.trim().toLowerCase()
  for (const item of providers) {
    const list = item.models?.length ? item.models : [item.model]
    const state = providerStates?.[item.id]
    // A provider without a key cannot answer: one line that opens Settings instead of models that fail on send.
    // (The one the session is on stays listed, so the menu never hides what is selected.)
    if (state && !state.ready && item.id !== provider?.id) {
      if (query && !item.label.toLowerCase().includes(query)) continue
      modelItems.push({
        id: `${item.id}::nokey`,
        label: `${item.label} · sem chave — configurar`,
        heading: item.label,
        icon: 'cpu',
        onSelect: onOpenSettings
      })
      continue
    }
    const matched = query
      ? list.filter((candidate) => candidate.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
      : list
    matched.forEach((candidate, index) => {
      modelItems.push({
        id: `${item.id}::${candidate}`,
        label: candidate,
        heading: index === 0 ? (state?.failure ? `${item.label} · ${state.failure}` : item.label) : undefined,
        checked: item.id === provider?.id && candidate === modelLabel,
        icon: index === 0 ? 'cpu' : undefined,
        onSelect: () => onModelChange(item.id, candidate)
      })
    })
  }
  modelItems.push({ id: 'sep', separator: true })
  modelItems.push({ id: 'settings', label: 'Configurar modelos…', icon: 'settings', onSelect: onOpenSettings })

  const effortLevels = effortLevelsFor(
    provider?.kind ?? 'openai',
    modelLabel,
    Boolean(provider?.compat?.reasoningEffort),
    provider?.effortLevels
  )
  const effortItems: MenuItem[] = effortLevels.length
    ? [
        {
          id: 'effort-auto',
          label: 'Automático',
          heading: 'Esforço de raciocínio',
          icon: 'gauge',
          checked: effort === null,
          onSelect: () => onEffortChange(null)
        },
        ...effortLevels.map((level) => ({
          id: `effort-${level}`,
          label: `${EFFORT_LABELS[level]} · ${EFFORT_HINTS[level]}`,
          checked: effort === level,
          onSelect: () => onEffortChange(level)
        }))
      ]
    : [{ id: 'effort-none', label: 'Este modelo não expõe esforço de raciocínio', heading: 'Esforço de raciocínio', icon: 'gauge', disabled: true }]

  const activeEnvironment = environments.find((environment) => environment.id === (environmentId ?? 'local'))

  const permissionItems: MenuItem[] = (['readonly', 'ask', 'accept-edits', 'auto', 'unrestricted'] as PermissionMode[]).map((candidate, index) => ({
    id: `perm-${candidate}`,
    label: `${PERMISSION_LABELS[candidate]} · ${PERMISSION_HINTS[candidate]}`,
    heading: index === 0 ? 'Permissões' : undefined,
    icon: candidate === 'auto' || candidate === 'unrestricted' ? 'alert' : 'shield',
    checked: permissionMode === candidate,
    onSelect: () => onPermissionChange(candidate)
  }))

  const environmentItems: MenuItem[] = environments.map((environment, index) => ({
    id: `env-${environment.id}`,
    label: `${environment.label} · ${environment.kind === 'local' ? 'nesta máquina' : environment.kind === 'wsl' ? 'WSL' : environment.kind === 'ssh' ? `SSH${environment.command ? ` (${environment.command})` : ''}` : 'nuvem'}`,
    heading: index === 0 ? 'Ambiente de execução' : undefined,
    icon: environment.kind === 'local' ? 'terminal' : 'globe',
    checked: (environmentId ?? 'local') === environment.id,
    onSelect: () => onEnvironmentChange?.(environment.id)
  }))

  const modeItems: MenuItem[] = [
    {
      id: 'mode-ask',
      label: 'Conversar',
      heading: 'Modo do agente',
      icon: 'message',
      checked: mode === 'ask',
      onSelect: () => onModeChange('ask')
    },
    { id: 'mode-plan', label: 'Planejar', icon: 'list', checked: mode === 'plan', onSelect: () => onModeChange('plan') },
    { id: 'mode-code', label: 'Código', icon: 'code', checked: mode === 'code', onSelect: () => onModeChange('code') },
    { id: 'mode-debug', label: 'Depurar', icon: 'hammer', checked: mode === 'debug', onSelect: () => onModeChange('debug') },
    { id: 'mode-review', label: 'Revisar', icon: 'eye', checked: mode === 'review', onSelect: () => onModeChange('review') },
    { id: 'mode-computer', label: 'Computer Use', icon: 'monitor', checked: mode === 'computer', onSelect: () => onModeChange('computer') },
    { id: 'mode-web', label: 'Navegar', icon: 'globe', checked: mode === 'web', onSelect: () => onModeChange('web') },
    { id: 'mode-loop', label: 'Código Loop Engineering', icon: 'refresh', checked: mode === 'loop', onSelect: () => onModeChange('loop') },
    { id: 'mode-rea', label: 'REA Engineering', icon: 'cpu', checked: mode === 'rea', onSelect: () => onModeChange('rea') }
  ]

  const attachItems: MenuItem[] = [
    { id: 'file', label: 'Anexar arquivo de qualquer tipo', icon: 'paperclip', onSelect: () => fileRef.current?.click() },
    { id: 'folder', label: 'Anexar pasta para o agente estudar', icon: 'folder', onSelect: () => void pickFolder() },
    { id: 'project', label: 'Abrir pasta de projeto', icon: 'folderOpen', onSelect: onAddProject },
    { id: 'sep1', separator: true },
    ...modeItems,
    { id: 'sep2', separator: true },
    { id: 'settings', label: 'Configurações', icon: 'settings', shortcut: 'Ctrl+,', onSelect: onOpenSettings }
  ]

  const placeholder =
    variant === 'home'
      ? 'Como posso ajudar você hoje?'
      : variant === 'cowork'
        ? busy
          ? 'Enter interrompe e envia · Ctrl+Enter enfileira'
          : 'Descreva a tarefa que o Openclod deve executar'
        : busy
          ? 'Enter interrompe e envia · Ctrl+Enter enfileira'
          : 'Digite / para comandos'

  return (
    <div className={`composer-dock is-${variant}`}>
      {queued.length ? (
        <div className="queue-bar">
          <span className="queue-label">
            <Icon name="clock" size={12} /> Na fila ({queued.length})
          </span>
          {queued.map((item) => (
            <span key={item.id} className="queue-chip" title={item.text}>
              <span>{item.text.replace(/\s+/g, ' ').slice(0, 60) || 'anexo'}</span>
              <button
                type="button"
                className="queue-send"
                onClick={() => onSendQueued(item.id)}
                title="Enviar agora para a IA"
              >
                <Icon name="send" size={10} />
              </button>
              <button type="button" onClick={() => onRemoveQueued(item.id)} title="Remover da fila">
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={`composer ${busy ? 'busy' : ''} ${dragActive ? 'is-drag' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        {attachments ? (
          <div className="attach-row">
            {attachedPaths.map((item) => (
              <div key={item.id} className={`attach file kind-${item.kind}`} title={item.path}>
                <Icon name={item.kind === 'folder' ? 'folder' : 'fileCode'} size={16} />
                <span className="attach-name">{item.name}</span>
                <span className="attach-size">{item.kind === 'folder' ? 'pasta' : 'arquivo'}</span>
                <button
                  type="button"
                  title={`Remover ${item.path}`}
                  onClick={() => setAttachedPaths((current) => current.filter((entry) => entry.id !== item.id))}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
            {images.map((image, index) => (
              <div key={`img-${index}`} className="attach image">
                <img src={`data:${image.mediaType};base64,${image.data}`} alt={image.label ?? 'anexo'} />
                <button
                  type="button"
                  title="Remover"
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
            {documents.map((doc) => (
              <div key={doc.id} className="attach file">
                <Icon name="fileCode" size={16} />
                <span className="attach-name" title={doc.name}>{doc.name}</span>
                <span className="attach-size">{Math.max(1, Math.round(doc.size / 1024))} kB</span>
                <button
                  type="button"
                  title="Remover"
                  onClick={() => setDocuments((current) => current.filter((item) => item.id !== doc.id))}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="composer-input">
          <textarea
            ref={textareaRef}
            value={shownText}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            readOnly={dictation.phase === 'listening' || dictation.phase === 'stopping'}
            spellCheck={false}
            rows={1}
            aria-label="Mensagem"
          />

          {slashOpen ? (
            <div className="slash-menu" role="listbox" aria-label="Comandos">
              {commands.length ? <div className="slash-head">Comandos</div> : null}
              {commands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={slashIndex === index}
                  className={`slash-row ${slashIndex === index ? 'active' : ''}`}
                  onMouseEnter={() => setSlashIndex(index)}
                  onClick={() => selectSlash(index)}
                >
                  <Icon name={command.icon} size={14} />
                  <span className="slash-label">{command.label}</span>
                  <span className="slash-hint">{command.hint}</span>
                </button>
              ))}
              {customMatches.length ? <div className="slash-head">Comandos do projeto</div> : null}
              {customMatches.map((custom, offset) => {
                const index = commands.length + offset
                return (
                  <button
                    key={`custom-${custom.name}`}
                    type="button"
                    role="option"
                    aria-selected={slashIndex === index}
                    className={`slash-row ${slashIndex === index ? 'active' : ''}`}
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => selectSlash(index)}
                  >
                    <Icon name="terminal" size={14} />
                    <span className="slash-label">/{custom.name}</span>
                    <span className="slash-hint">{custom.argumentHint ? `${custom.argumentHint} · ` : ''}{custom.description || custom.source}</span>
                  </button>
                )
              })}
              {skillMatches.length ? <div className="slash-head">Skills</div> : null}
              {skillMatches.map((skill, offset) => {
                const index = commands.length + customMatches.length + offset
                return (
                  <button
                    key={`skill-${skill.name}`}
                    type="button"
                    role="option"
                    aria-selected={slashIndex === index}
                    className={`slash-row ${slashIndex === index ? 'active' : ''}`}
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => selectSlash(index)}
                  >
                    <Icon name="sparkles" size={14} />
                    <span className="slash-label">/{skill.name}</span>
                    <span className="slash-hint">{skill.description || skill.source}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        <div className="composer-bar">
          <div className="composer-left">
            <div className="composer-attach">
              <button
                type="button"
                className={`round-btn ${attachOpen ? 'is-active' : ''}`}
                title="Adicionar arquivo ou imagem"
                onClick={() => setAttachOpen((value) => !value)}
              >
                <Icon name="plus" size={18} />
              </button>
              {attachOpen ? (
                <MenuPopover items={attachItems} onClose={() => setAttachOpen(false)} className="attach-menu" />
              ) : null}
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={onFileChange}
              />
            </div>

            {variant === 'cowork' && workspaceName ? (
              <span className="composer-workspace" title={workspaceName}>
                <Icon name="folder" size={13} />
                <span>{workspaceName}</span>
              </span>
            ) : null}

            {onSurfaceChange && !session ? (
              <div className="surface-switch" role="group" aria-label="Tipo de conversa">
                <button
                  type="button"
                  className={variant === 'home' ? 'active' : ''}
                  onClick={() => onSurfaceChange('chat')}
                >
                  Chat
                </button>
                <button
                  type="button"
                  className={variant === 'cowork' ? 'active' : ''}
                  onClick={() => onSurfaceChange('cowork')}
                >
                  Cowork
                </button>
              </div>
            ) : null}
          </div>

          <div className="composer-right">
            <div className="composer-model">
              <button
                type="button"
                className={`model-btn effort-btn ${effort ? 'is-set' : ''}`}
                disabled={busy}
                onClick={() => setEffortOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={effortOpen}
                title={
                  effortLevels.length
                    ? `Esforço de raciocínio: ${effort ? EFFORT_LABELS[effort] : 'automático'} — clique para escolher`
                    : 'Este modelo não expõe esforço de raciocínio'
                }
              >
                <Icon name="gauge" size={12} />
                <span>{effort ? EFFORT_LABELS[effort] : 'Auto'}</span>
                {effortLevels.length ? <Icon name="chevronDown" size={10} /> : null}
              </button>
              {effortOpen ? <MenuPopover items={effortItems} onClose={() => setEffortOpen(false)} align="right" className="model-menu" /> : null}
            </div>
            <div className="composer-model">
              <button
                type="button"
                className="model-btn"
                onClick={() => {
                  setModelOpen((value) => !value)
                  setModelQuery('')
                }}
                title="Escolher modelo"
              >
                <span className="model-short">{modelLabel}</span>
                <Icon name="chevronDown" size={11} />
              </button>
              {modelOpen ? (
                <MenuPopover
                  items={modelItems}
                  onClose={() => {
                    setModelOpen(false)
                    setModelQuery('')
                  }}
                  align="right"
                  className="model-menu"
                  header={
                    <div className="menu-search-wrap">
                      <input
                        className="menu-search"
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder="Buscar modelo (ex.: free, kimi, qwen)…"
                        spellCheck={false}
                        autoFocus
                      />
                    </div>
                  }
                />
              ) : null}
            </div>
            <div className="context-wrap">
              <button type="button" className="round-btn context-btn" title={`${contextPercent}% da janela de contexto em uso`}>
                <span className="context-ring" style={{ ['--pct' as string]: `${Math.max(2, Math.min(100, contextPercent))}%` }} />
              </button>
              <div className="context-popover" role="tooltip">
                <div className="context-popover-head">
                  <span>Contexto</span>
                  <strong>{contextPercent}% usado</strong>
                </div>
                <div className="context-bar">
                  <span style={{ width: `${Math.max(1, Math.min(100, contextPercent))}%` }} />
                </div>
                <div className="context-popover-foot">
                  <span>{Math.round(contextUsed / 1000)}k usados</span>
                  <span>
                    {Math.max(0, Math.round(((provider?.contextWindow ?? 0) - contextUsed) / 1000))}k livres
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              className={`round-btn mic-btn state-${dictation.phase}`}
              style={{ ['--level' as string]: dictation.level.toFixed(2) }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                // The mic button must not keep focus: the user wants the caret
                // blinking in the input while the live transcript arrives.
                const node = textareaRef.current
                node?.focus()
                const end = node?.value.length ?? 0
                node?.setSelectionRange(end, end)
                toggleDictation()
              }}
              disabled={dictation.phase === 'stopping'}
              aria-pressed={dictation.phase === 'listening'}
              title={
                dictation.phase === 'listening'
                  ? 'Parar o ditado (Esc ou clique no microfone)'
                  : dictation.phase === 'loading'
                    ? 'Carregando o modelo de voz… (clique para cancelar)'
                    : 'Clique para ditar pelo microfone'
              }
            >
              {dictation.phase === 'loading' ? <span className="spinner tiny" /> : <Icon name={dictation.phase === 'listening' ? 'audioLines' : 'mic'} size={16} />}
            </button>
            {busy ? (
              <button type="button" className="send-btn stop" onClick={onStop} title="Parar">
                <Icon name="stop" size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                onClick={() => void submit()}
                disabled={(!text.trim() && !attachments) || dictationActive}
                title="Enviar (Enter) · Ctrl+Enter adiciona à fila"
              >
                <Icon name="arrowUp" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      {localError || dictation.error ? <div className="composer-error">{localError || dictation.error}</div> : null}

      <div className="composer-meta">
        <span className="composer-permission-wrap">
          <button type="button" className="composer-permission" title="Modo de permissão" onClick={() => setPermissionOpen((value) => !value)}>
            <span className={`perm-dot mode-${permissionMode}`} />
            {PERMISSION_LABELS[permissionMode]}
          </button>
          {permissionOpen ? <MenuPopover items={permissionItems} onClose={() => setPermissionOpen(false)} className="permission-menu" /> : null}
        </span>
        {environments.length ? (
          <span className="composer-permission-wrap">
            <button type="button" className="composer-permission" title="Ambiente de execução" onClick={() => setEnvironmentOpen((value) => !value)}>
              <Icon name="globe" size={11} />
              {activeEnvironment?.label ?? 'Local'}
            </button>
            {environmentOpen ? <MenuPopover items={environmentItems} onClose={() => setEnvironmentOpen(false)} className="permission-menu" /> : null}
          </span>
        ) : null}
        <span className="composer-hint">
          {dictation.phase === 'listening' ? (
            <em className="listening-note">
              <span className="listening-dot" /> Ouvindo… fale normalmente · clique no microfone para parar e inserir
            </em>
          ) : (
            <>
              <span className="hint-provider">{provider?.label ?? 'provedor'}</span>
              <span className="hint-sep">·</span>
              {Math.round((provider?.contextWindow ?? 0) / 1000)}k
              <span className="hint-sep">·</span>
              {contextPercent}%
              {turnLimit > 0 ? (
                <>
                  <span className="hint-sep">·</span>
                  <span
                    className={turnTokens / turnLimit > 0.8 ? 'turn-warn' : undefined}
                    title="Tokens do turno (entrada não cacheada + saída) / limite"
                  >
                    turno {formatTokens(turnTokens)}/{formatTokens(turnLimit)}
                  </span>
                </>
              ) : null}
            </>
          )}
        </span>
      </div>
    </div>
  )
}
