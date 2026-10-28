/**
 * Pure helpers of the "Conectores" screen (the connector directory, like the one Claude shows): search, category
 * counts, ordering, monograms, labels and form validation. No DOM and no React, so every rule can be tested.
 *
 * The directory is data from outside the process (resources/mcp-directory.json, refined by other tools): every
 * optional field may be missing, so nothing here assumes more than `id`, `name` and `transport`.
 */
import type {
  ConnectInput,
  ConnectorAuth,
  ConnectorCategory,
  ConnectorCredential,
  ConnectorKind,
  ConnectorProbe,
  ConnectorState,
  ConnectorStatus,
  ConnectorTool,
  DirectoryConnector,
  ToolPolicy
} from '../../../shared/mcp-connectors'
import type { McpServerSettings } from '../../../shared/types'

/* --------------------------------- text --------------------------------- */

/** Lower case without accents, so "calendario" finds "Calendário". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/* ------------------------------- categories ------------------------------ */

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  produtividade: 'Produtividade',
  desenvolvimento: 'Desenvolvimento',
  comunicacao: 'Comunicação',
  design: 'Design',
  dados: 'Dados',
  financas: 'Finanças',
  'vendas-crm': 'Vendas e CRM',
  marketing: 'Marketing',
  suporte: 'Suporte',
  documentos: 'Documentos',
  'nuvem-infra': 'Nuvem e infraestrutura',
  'seguranca-compliance': 'Segurança e conformidade',
  pesquisa: 'Pesquisa',
  viagens: 'Viagens',
  'saude-ciencia': 'Saúde e ciência',
  midia: 'Mídia',
  rh: 'RH',
  juridico: 'Jurídico',
  outros: 'Outros'
}

/** The pseudo-category of servers the user added by hand. */
export const CUSTOM_CATEGORY = 'personalizado'

export function categoryLabel(category: string): string {
  if (category === CUSTOM_CATEGORY) return 'Personalizados'
  const known = (CATEGORY_LABELS as Record<string, string>)[category]
  if (known) return known
  const text = category.replace(/[-_]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Outros'
}

/* ---------------------------------- rows --------------------------------- */

/** Ids of well-known services, in the order they are shown first. */
export const POPULAR_IDS: readonly string[] = [
  'atlassian',
  'github',
  'slack',
  'notion',
  'linear',
  'google-drive',
  'google-calendar',
  'gmail',
  'figma-remote',
  'figma',
  'asana-remote',
  'asana',
  'sentry',
  'stripe-remote',
  'stripe',
  'vercel',
  'supabase-remote',
  'supabase',
  'canva',
  'hubspot',
  'intercom',
  'zapier',
  'cloudflare-developer-platform',
  'context7',
  'playwright'
]

export function popularRank(id: string): number {
  return POPULAR_IDS.indexOf(id)
}

/** One thing the screen can show: a directory entry or a server added by hand, with its live state. */
export interface ConnectorRow {
  /** Directory id (or the server name of a custom connector). */
  id: string
  name: string
  description: string
  category: string
  auth: ConnectorAuth
  kind: ConnectorKind
  transport: 'http' | 'sse' | 'stdio'
  /** URL without query string or credentials; never a secret. */
  endpoint?: string
  entry?: DirectoryConnector
  state: ConnectorState
  /** Added by hand (no directory entry behind it). */
  custom: boolean
  /** Position in POPULAR_IDS, or -1. */
  popular: number
  toolCount: number
  /** Folded text the search looks at. */
  search: string
  nameFolded: string
}

/** The address of a server for display: origin and path only (a query string may carry a token). */
export function endpointDisplay(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return undefined
  }
}

function commandName(command: string | undefined): string {
  const base = (command ?? '').split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat)$/i, '')
}

function customRow(state: ConnectorState, server: McpServerSettings | undefined): ConnectorRow {
  const name = state.serverName ?? state.id
  const remote = Boolean(server?.url) || server?.type === 'http' || server?.type === 'sse'
  const endpoint = endpointDisplay(server?.url)
  const transport: ConnectorRow['transport'] = server?.type === 'sse' ? 'sse' : remote ? 'http' : server ? 'stdio' : 'http'
  const where = remote ? (endpoint ? new URL(endpoint).host : 'servidor remoto') : commandName(server?.command)
  const description = remote
    ? `Conector personalizado em ${where}.`
    : where
      ? `Servidor MCP local (${where}) adicionado por você.`
      : 'Servidor MCP adicionado por você.'
  return {
    id: state.id,
    name,
    description,
    category: CUSTOM_CATEGORY,
    auth: 'unknown',
    kind: remote ? 'remote' : 'local',
    transport,
    endpoint,
    state,
    custom: true,
    popular: -1,
    toolCount: state.toolCount ?? 0,
    search: fold(`${name} ${description} personalizado`),
    nameFolded: fold(name)
  }
}

function entryRow(entry: DirectoryConnector, state: ConnectorState): ConnectorRow {
  const tools = Array.isArray(entry.tools) ? entry.tools : []
  const description = typeof entry.description === 'string' ? entry.description : ''
  const category = typeof entry.category === 'string' && entry.category ? entry.category : 'outros'
  return {
    id: entry.id,
    name: entry.name || entry.id,
    description,
    category,
    auth: entry.auth ?? 'unknown',
    kind: entry.kind ?? (entry.transport === 'stdio' ? 'local' : 'remote'),
    transport: entry.transport,
    endpoint: endpointDisplay(entry.url),
    entry,
    state,
    custom: false,
    popular: popularRank(entry.id),
    toolCount: state.toolCount ?? entry.toolCount ?? tools.length,
    search: fold([entry.name, entry.id, description, categoryLabel(category), tools.join(' ')].join(' ')),
    nameFolded: fold(entry.name || entry.id)
  }
}

/**
 * Joins the directory with the live states. A state with no directory entry is a connector added by hand;
 * `servers` (the masked `mcpServers`) tells what kind of server it is.
 */
export function buildRows(entries: readonly DirectoryConnector[], states: readonly ConnectorState[], servers: readonly McpServerSettings[] = []): ConnectorRow[] {
  const byId = new Map(states.map((state) => [state.id, state]))
  const rows: ConnectorRow[] = []
  const known = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || known.has(entry.id)) continue
    known.add(entry.id)
    rows.push(entryRow(entry, byId.get(entry.id) ?? { id: entry.id, status: 'not-installed' }))
  }
  for (const state of states) {
    if (known.has(state.id)) continue
    known.add(state.id)
    const server = servers.find((item) => item.name === (state.serverName ?? state.id))
    rows.push(customRow(state, server))
  }
  return rows
}

function sameState(a: ConnectorState, b: ConnectorState): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.serverName === b.serverName &&
    a.detail === b.detail &&
    a.toolCount === b.toolCount &&
    a.connectedAs === b.connectedAs &&
    a.tokenExpiresAt === b.tokenExpiresAt &&
    a.lastError === b.lastError &&
    a.hint === b.hint
  )
}

/**
 * Reuses the previous row object when nothing about it changed, so a state refresh (every 1.5 s while a login is
 * pending) re-renders only the cards that actually changed.
 */
export function stabilizeRows(previous: readonly ConnectorRow[], next: readonly ConnectorRow[]): ConnectorRow[] {
  const before = new Map(previous.map((row) => [row.id, row]))
  return next.map((row) => {
    const old = before.get(row.id)
    return old && old.entry === row.entry && old.custom === row.custom && old.description === row.description && old.endpoint === row.endpoint && sameState(old.state, row.state)
      ? old
      : row
  })
}

/* -------------------------- status, filters, order ------------------------- */

export type StatusFilter = 'all' | 'connected' | 'available' | 'needs-login'
export type SortMode = 'popular' | 'name' | 'tools'

export const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'connected', label: 'Conectados' },
  { id: 'available', label: 'Disponíveis' },
  { id: 'needs-login', label: 'Precisam de login' }
]

export const SORT_MODES: ReadonlyArray<{ id: SortMode; label: string }> = [
  { id: 'popular', label: 'Populares primeiro' },
  { id: 'name', label: 'Nome (A–Z)' },
  { id: 'tools', label: 'Mais ferramentas' }
]

export function isInstalled(row: ConnectorRow): boolean {
  return row.state.status !== 'not-installed'
}

export function matchesStatus(row: ConnectorRow, filter: StatusFilter): boolean {
  switch (filter) {
    case 'connected':
      return row.state.status === 'connected'
    case 'available':
      return !isInstalled(row)
    case 'needs-login':
      return row.state.status === 'needs-auth'
    default:
      return true
  }
}

export function queryTokens(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

/** Every word of the query must appear in the name, description, id, category or tool names. */
export function matchesQuery(row: ConnectorRow, query: string): boolean {
  const tokens = queryTokens(query)
  return tokens.every((token) => row.search.includes(token))
}

export interface ConnectorFilters {
  query: string
  /** A category key, or 'all'. */
  category: string
  status: StatusFilter
}

export function filterRows(rows: readonly ConnectorRow[], filters: ConnectorFilters): ConnectorRow[] {
  return rows.filter(
    (row) => (filters.category === 'all' || row.category === filters.category) && matchesStatus(row, filters.status) && matchesQuery(row, filters.query)
  )
}

/** How many rows each category would show with the current search and status (the category itself is ignored). */
export function categoryCounts(rows: readonly ConnectorRow[], filters: Pick<ConnectorFilters, 'query' | 'status'>): Array<{ category: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!matchesStatus(row, filters.status) || !matchesQuery(row, filters.query)) continue
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, label: categoryLabel(category), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'pt-BR'))
}

const STATUS_ORDER: Record<ConnectorStatus, number> = {
  connected: 0,
  connecting: 1,
  'needs-auth': 2,
  error: 3,
  disabled: 4,
  'not-installed': 5
}

/** 0 = the name is the query, 1 = starts with it, 2 = a word of the name starts with it, 3 = contains it, 4 = only elsewhere. */
export function relevance(row: ConnectorRow, query: string): number {
  const q = fold(query).trim()
  if (!q) return 0
  const name = row.nameFolded
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (name.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) return 2
  if (name.includes(q) || row.id.includes(q)) return 3
  return 4
}

function byName(a: ConnectorRow, b: ConnectorRow): number {
  return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })
}

/** Connected first, then (by the chosen mode) popular, alphabetical or richest; a search ranks the best name matches first. */
export function sortRows(rows: readonly ConnectorRow[], mode: SortMode = 'popular', query = ''): ConnectorRow[] {
  return [...rows].sort((a, b) => {
    const status = STATUS_ORDER[a.state.status] - STATUS_ORDER[b.state.status]
    if (status) return status
    if (query.trim()) {
      const score = relevance(a, query) - relevance(b, query)
      if (score) return score
    }
    if (mode === 'tools') {
      const tools = b.toolCount - a.toolCount
      if (tools) return tools
    }
    if (mode === 'popular') {
      const pa = a.popular < 0 ? Number.MAX_SAFE_INTEGER : a.popular
      const pb = b.popular < 0 ? Number.MAX_SAFE_INTEGER : b.popular
      if (pa !== pb) return pa - pb
    }
    return byName(a, b)
  })
}

/* --------------------------------- labels -------------------------------- */

export type Tone = 'ok' | 'warn' | 'bad' | 'busy' | 'muted' | 'accent'

export interface Badge {
  label: string
  tone: Tone
  title?: string
}

/** The authentication seals of a card. */
export function authBadges(row: Pick<ConnectorRow, 'auth' | 'kind' | 'custom' | 'entry'>): Badge[] {
  const out: Badge[] = []
  if (row.custom) return [{ label: 'Personalizado', tone: 'muted' }]
  if (row.kind === 'local') out.push({ label: 'Local', tone: 'muted', title: 'Roda no seu computador' })
  switch (row.auth) {
    case 'oauth':
      out.push({ label: 'Login com sua conta', tone: 'accent' })
      break
    case 'oauth-static':
      out.push({ label: 'Login com sua conta', tone: 'accent' })
      if (needsOAuthApp(row)) out.push({ label: 'Requer app OAuth seu', tone: 'warn', title: 'Você cadastra um aplicativo no painel de desenvolvedor do serviço e informa o Client ID' })
      break
    case 'api-key':
    case 'local-env':
      out.push({ label: 'Chave de API', tone: 'accent' })
      break
    case 'none':
      if (row.kind !== 'local') out.push({ label: 'Sem login', tone: 'ok' })
      break
    default:
      out.push({ label: 'Login a confirmar', tone: 'muted', title: 'Não foi possível confirmar como este serviço autentica' })
  }
  return out
}

/** The service only accepts registered OAuth apps and the directory has none of Openclod's: the user brings a Client ID. */
export function needsOAuthApp(row: Pick<ConnectorRow, 'auth' | 'custom' | 'entry'>): boolean {
  return !row.custom && row.auth === 'oauth-static' && !row.entry?.oauthClientId
}

/** Fields the backend may accept in `ConnectInput` and the state before the shared contract lists them (read defensively). */
export interface OAuthClientInput {
  clientId: string
  clientSecret?: string
}
export type ConnectInputWithApp = ConnectInput & { oauthClient?: OAuthClientInput }

/** The exact return URL of the OAuth login (fixed port), when the main process reports it. */
export function redirectUriOf(source: unknown): string | undefined {
  const value = source && typeof source === 'object' ? (source as { redirectUri?: unknown }).redirectUri : undefined
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined
}

/** One or two sentences explaining how connecting works for this authentication type. */
export function authExplanation(row: Pick<ConnectorRow, 'auth' | 'kind' | 'custom' | 'entry'>): string {
  if (row.custom) return 'Conector adicionado por você. Se ele usa cabeçalhos de autenticação, os valores ficam no cofre do sistema.'
  switch (row.auth) {
    case 'oauth':
      return 'Você entra com a sua conta do serviço no navegador e autoriza o Openclod. Nenhuma senha passa por aqui e você pode revogar o acesso quando quiser.'
    case 'oauth-static':
      return needsOAuthApp(row)
        ? 'Este serviço exige um aplicativo OAuth cadastrado por você. Crie um no painel de desenvolvedor do serviço e informe o Client ID (e o Client Secret, se houver).'
        : 'Você entra com a sua conta do serviço no navegador. O Openclod já tem um aplicativo cadastrado neste serviço, então não precisa de mais nada.'
    case 'api-key':
      return 'Este serviço usa uma chave de API ou token. Informe-o abaixo: ele é guardado no cofre do sistema e nunca no arquivo de configuração.'
    case 'local-env':
      return 'Servidor local que roda no seu computador e lê credenciais de variáveis de ambiente. Os valores secretos vão para o cofre do sistema.'
    case 'none':
      return row.kind === 'local' ? 'Servidor local, sem login. Roda no seu computador.' : 'Este serviço não pede login: basta conectar.'
    default:
      return 'Não conseguimos confirmar como este serviço autentica. Ao conectar, o Openclod tenta e mostra o que o servidor pedir.'
  }
}

export interface StatusChip {
  label: string
  tone: Tone
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** The status line of a card ("Conectado · 12 ferramentas"); null when the connector is not installed. */
export function statusChip(state: ConnectorState): StatusChip | null {
  switch (state.status) {
    case 'connected':
      return { label: typeof state.toolCount === 'number' ? `Conectado · ${plural(state.toolCount, 'ferramenta', 'ferramentas')}` : 'Conectado', tone: 'ok' }
    case 'connecting':
      return { label: 'Conectando…', tone: 'busy' }
    case 'needs-auth':
      return { label: 'Precisa entrar', tone: 'warn' }
    case 'error':
      return { label: 'Erro', tone: 'bad' }
    case 'disabled':
      return { label: 'Desativado', tone: 'muted' }
    default:
      return null
  }
}

export function primaryActionLabel(row: ConnectorRow): string {
  return isInstalled(row) ? 'Gerenciar' : 'Conectar'
}

/** `dd/mm` in the local time zone. */
export function formatDay(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`
}

export interface ProbeSummary {
  tone: Tone
  text: string
}

/** What the last probe of the endpoint (no credentials) showed, in plain words. */
export function probeSummary(probe: ConnectorProbe | undefined, auth?: ConnectorAuth): ProbeSummary | null {
  if (!probe || typeof probe.checkedAt !== 'number') return null
  const prefix = `Verificado em ${formatDay(probe.checkedAt)}:`
  if (!probe.reachable) {
    return { tone: 'bad', text: `${prefix} servidor não alcançável${probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ''}.` }
  }
  if (probe.openAccess) {
    // The server lists its tools without a login but running them needs one: never call that "no login".
    if (auth === 'oauth' || auth === 'oauth-static') {
      return { tone: 'ok', text: `${prefix} o servidor lista as ferramentas sem login, mas usá-las exige entrar com a sua conta.` }
    }
    return { tone: 'ok', text: `${prefix} acesso aberto, responde sem precisar de login.` }
  }
  if (probe.resourceMetadata) {
    if (probe.dynamicRegistration === false) {
      return { tone: 'warn', text: `${prefix} chega ao login, mas exige um aplicativo OAuth cadastrado por você.` }
    }
    if (probe.dynamicRegistration) {
      return { tone: 'ok', text: `${prefix} chega ao login e o Openclod consegue se cadastrar sozinho.` }
    }
    return { tone: 'ok', text: `${prefix} chega à tela de login (OAuth).` }
  }
  if (probe.httpStatus === 401) {
    return { tone: 'warn', text: `${prefix} o servidor pede credencial, mas não informa como entrar.` }
  }
  if (probe.httpStatus === 403) {
    return { tone: 'warn', text: `${prefix} o servidor recusou a verificação (possível bloqueio contra robôs).` }
  }
  if (probe.transportOk) {
    return { tone: 'ok', text: `${prefix} o servidor respondeu corretamente.` }
  }
  if (probe.httpStatus && probe.httpStatus >= 200 && probe.httpStatus < 400 && !probe.note) {
    return { tone: 'muted', text: `${prefix} o servidor responde, mas ainda não sabemos como ele autentica.` }
  }
  return { tone: 'muted', text: probe.note ? `${prefix} ${probe.note.replace(/\.$/, '')}.` : `${prefix} resposta inconclusiva.` }
}

/* ------------------------------ monogram / hue ----------------------------- */

/** Up to two letters: initials of the first two words (the text in parentheses is ignored). */
export function monogram(name: string): string {
  const clean = name.replace(/\([^)]*\)/g, ' ').trim()
  const words = clean.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = (word: string): string => Array.from(word)[0] ?? ''
  const text = words.length >= 2 ? letters(words[0]) + letters(words[1]) : letters(words[0] ?? '')
  return (text || '?').toLocaleUpperCase('pt-BR')
}

function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value >>> 0
}

/** One of twelve hues, always the same for the same seed (the icon domain, or the name). */
export function monogramHue(seed: string): number {
  return (hash(seed.trim().toLowerCase()) % 12) * 30 + 8
}

export function rowSeed(row: Pick<ConnectorRow, 'entry' | 'name'>): string {
  return row.entry?.iconDomain || row.name
}

/* --------------------------------- tools --------------------------------- */

export const POLICY_OPTIONS: ReadonlyArray<{ id: ToolPolicy; label: string; help: string }> = [
  { id: 'allow', label: 'Sempre permitir', help: 'Roda sem perguntar (quando a política do app permite).' },
  { id: 'ask', label: 'Perguntar', help: 'Pede a sua aprovação a cada uso.' },
  { id: 'deny', label: 'Bloquear', help: 'O agente não vê nem usa esta ferramenta.' }
]

export function policyLabel(policy: ToolPolicy): string {
  return POLICY_OPTIONS.find((option) => option.id === policy)?.label ?? policy
}

export type ToolKind = 'read' | 'write' | 'unknown'

/** From the MCP annotations the server sent; no annotation means we do not claim anything. */
export function toolKind(tool: Pick<ConnectorTool, 'readOnly' | 'destructive'>): ToolKind {
  if (tool.readOnly === true) return 'read'
  if (tool.readOnly === false || tool.destructive === true) return 'write'
  return 'unknown'
}

export function toolBadge(tool: Pick<ConnectorTool, 'readOnly' | 'destructive'>): Badge | null {
  const kind = toolKind(tool)
  if (kind === 'read') return { label: 'somente leitura', tone: 'ok' }
  if (kind === 'write') return { label: tool.destructive ? 'pode alterar ou apagar dados' : 'pode alterar dados', tone: 'warn' }
  return null
}

export function filterTools(tools: readonly ConnectorTool[], query: string): ConnectorTool[] {
  const tokens = queryTokens(query)
  if (!tokens.length) return [...tools]
  return tools.filter((tool) => {
    const text = fold(`${tool.name} ${tool.description}`)
    return tokens.every((token) => text.includes(token))
  })
}

export interface ToolGroup {
  kind: ToolKind
  label: string
  tools: ConnectorTool[]
}

/** Read-only tools, tools that change data, and the rest; empty groups are left out and a single group has no heading to show. */
export function groupTools(tools: readonly ConnectorTool[]): ToolGroup[] {
  const groups: ToolGroup[] = [
    { kind: 'read', label: 'Somente leitura', tools: [] },
    { kind: 'write', label: 'Podem alterar dados', tools: [] },
    { kind: 'unknown', label: 'Sem classificação do servidor', tools: [] }
  ]
  for (const tool of tools) groups.find((group) => group.kind === toolKind(tool))!.tools.push(tool)
  for (const group of groups) group.tools.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return groups.filter((group) => group.tools.length)
}

/** The policy shared by every tool, or 'mixed'. */
export function overallPolicy(tools: readonly ConnectorTool[]): ToolPolicy | 'mixed' {
  if (!tools.length) return 'ask'
  const first = tools[0].policy
  return tools.every((tool) => tool.policy === first) ? first : 'mixed'
}

export function policyCounts(tools: readonly ConnectorTool[]): Record<ToolPolicy, number> {
  const out: Record<ToolPolicy, number> = { allow: 0, ask: 0, deny: 0 }
  for (const tool of tools) out[tool.policy] += 1
  return out
}

/* --------------------------------- forms --------------------------------- */

/** Same rule as the main process uses for the name of the server (connector-service.ts `serverNameFor`). */
export function serverNameOf(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
}

export function isSecretField(field: ConnectorCredential): boolean {
  return field.secret ?? (field.where === 'header' || /token|key|secret|senha|password|authorization/i.test(field.key))
}

export function credentialFields(entry: DirectoryConnector | undefined): ConnectorCredential[] {
  return Array.isArray(entry?.credentials) ? entry!.credentials!.filter((field) => field && typeof field.key === 'string' && field.key) : []
}

export function missingCredentials(entry: DirectoryConnector | undefined, values: Record<string, string>): ConnectorCredential[] {
  return credentialFields(entry).filter((field) => field.required && !(values[field.key] ?? '').trim())
}

/** Only the filled fields, trimmed, ready for `connectConnector(id, { credentials })`. */
export function credentialValues(entry: DirectoryConnector | undefined, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of credentialFields(entry)) {
    const value = (values[field.key] ?? '').trim()
    if (value) out[field.key] = value
  }
  return out
}

/** The directory lists some remote servers without a public URL: the user brings it. */
export function needsEndpoint(entry: DirectoryConnector | undefined): boolean {
  return Boolean(entry && entry.transport !== 'stdio' && !entry.url)
}

export function isLocalAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** `https://` always; `http://` only for an address on this computer (a development server). */
export function validateUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return 'Informe a URL do servidor MCP.'
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'A URL não é válida. Exemplo: https://mcp.exemplo.com/mcp'
  }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && isLocalAddress(text)) return null
  return url.protocol === 'http:' ? 'Use https://. O http:// só é aceito para endereços deste computador (localhost).' : 'A URL deve começar com https://.'
}

/**
 * What the "Conector personalizado" form holds. Two kinds of connector: a remote server (address, transport, headers)
 * or a program on this computer (command, arguments, variables, folder). The fields of the other kind are ignored.
 */
export interface CustomDraft {
  name: string
  /** Remote when absent. */
  mode?: 'remote' | 'local'
  url: string
  transport: 'http' | 'sse'
  headers: Array<{ name: string; value: string }>
  /** Local program: what to run. */
  command?: string
  /** One argument per line (there is no shell, so nothing to quote). */
  args?: string
  env?: Array<{ name: string; value: string }>
  /** Working folder; empty = the app's. */
  cwd?: string
  /** Seconds the server may take to start; empty = the default. */
  startTimeout?: string
}

export interface CustomErrors {
  name?: string
  url?: string
  headers?: string
  command?: string
  args?: string
  env?: string
  cwd?: string
  startTimeout?: string
}

/** Longest start time the form accepts, in seconds (the main process allows 10 min). */
export const START_TIMEOUT_RANGE = { min: 5, max: 600, fallback: 30 } as const

/** Arguments typed one per line: blank lines are dropped, nothing is quoted or split. */
export function parseArgLines(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function argLines(args: readonly string[] | undefined): string {
  return (args ?? []).join('\n')
}

/** A variable whose value should be hidden while typed (same idea as the vault: KEY, TOKEN, SECRET, PASSWORD…). */
export function isSecretVariable(name: string): boolean {
  return /key|token|secret|senha|password|authorization|bearer/i.test(name) && !/(?:max|min|limit|count|budget|ttl|expir\w*|timeout|size)[_-]?tokens?$|tokens?[_-]?(?:max|min|limit|count|budget|ttl|expir\w*|timeout|size|type)$/i.test(name)
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function pairProblem(pairs: ReadonlyArray<{ name: string; value: string }>, kind: 'cabeçalho' | 'variável', valid: RegExp): string | undefined {
  const half = pairs.find((pair) => Boolean(pair.name.trim()) !== Boolean(pair.value.trim()))
  if (half) {
    return half.name.trim()
      ? `Falta o valor ${kind === 'cabeçalho' ? 'do cabeçalho' : 'da variável'} “${half.name.trim()}”.`
      : `Há um valor ${kind === 'cabeçalho' ? 'de cabeçalho' : 'de variável'} sem nome.`
  }
  if (pairs.some((pair) => pair.name.trim() && !valid.test(pair.name.trim()))) {
    return kind === 'cabeçalho' ? 'O nome de um cabeçalho tem caracteres inválidos.' : 'O nome de uma variável deve ter só letras, números e sublinhado, sem começar por número.'
  }
  return undefined
}

export function validateCustom(draft: CustomDraft, existingNames: readonly string[] = []): CustomErrors {
  const errors: CustomErrors = {}
  const name = serverNameOf(draft.name.trim())
  if (!draft.name.trim()) errors.name = 'Dê um nome ao conector.'
  else if (!name.replace(/-/g, '')) errors.name = 'Use letras ou números no nome.'
  else if (existingNames.some((existing) => existing.toLowerCase() === name.toLowerCase())) errors.name = 'Já existe um conector com este nome.'
  if (draft.mode === 'local') {
    const command = (draft.command ?? '').trim()
    if (!command) errors.command = 'Informe o programa que inicia o servidor, como npx, uvx, node ou o caminho de um .exe.'
    else if (command.length > 1000 || /[\r\n\u0000]/.test(command)) errors.command = 'Use só o nome ou o caminho do programa, em uma linha. Os argumentos vão no campo abaixo.'
    const args = parseArgLines(draft.args)
    if (args.length > 100) errors.args = 'São argumentos demais (o limite é 100).'
    else if (args.some((arg) => arg.length > 4000)) errors.args = 'Um argumento é grande demais.'
    const env = pairProblem(draft.env ?? [], 'variável', VARIABLE_NAME)
    if (env) errors.env = env
    const cwd = (draft.cwd ?? '').trim()
    if (cwd && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(cwd)) errors.cwd = 'Use o caminho completo da pasta, como C:\\projetos\\meu-servidor.'
  } else {
    const url = validateUrl(draft.url)
    if (url) errors.url = url
    const headers = pairProblem(draft.headers, 'cabeçalho', /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/)
    if (headers) errors.headers = headers
  }
  const timeout = (draft.startTimeout ?? '').trim()
  if (timeout) {
    const seconds = Number(timeout)
    if (!Number.isInteger(seconds) || seconds < START_TIMEOUT_RANGE.min || seconds > START_TIMEOUT_RANGE.max) {
      errors.startTimeout = `Use um número inteiro de segundos, de ${START_TIMEOUT_RANGE.min} a ${START_TIMEOUT_RANGE.max}.`
    }
  }
  return errors
}

export function hasErrors(errors: CustomErrors): boolean {
  return Object.values(errors).some(Boolean)
}

function filledPairs(pairs: ReadonlyArray<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    if (pair.name.trim() && pair.value.trim()) out[pair.name.trim()] = pair.value.trim()
  }
  return out
}

/** The `custom` payload of `connectConnector('custom', …)`. */
export function customInput(draft: CustomDraft): NonNullable<ConnectInput['custom']> {
  const seconds = Number((draft.startTimeout ?? '').trim())
  const startTimeoutMs = (draft.startTimeout ?? '').trim() && Number.isFinite(seconds) ? { startTimeoutMs: Math.round(seconds * 1000) } : {}
  if (draft.mode === 'local') {
    const args = parseArgLines(draft.args)
    const env = filledPairs(draft.env ?? [])
    const cwd = (draft.cwd ?? '').trim()
    return {
      name: draft.name.trim(),
      command: (draft.command ?? '').trim(),
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...startTimeoutMs
    }
  }
  const headers = filledPairs(draft.headers)
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    transport: draft.transport,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...startTimeoutMs
  }
}

/** The form of a server that already exists, to edit it. Credentials arrive masked (`maskedMcpSettings`) and go back masked. */
export function draftFromServer(server: McpServerSettings): CustomDraft {
  const remote = Boolean(server.url) || server.type === 'http' || server.type === 'sse'
  const pairs = (record: Record<string, string> | undefined): Array<{ name: string; value: string }> => Object.entries(record ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  return {
    name: server.name,
    mode: remote ? 'remote' : 'local',
    url: server.url ?? '',
    transport: server.type === 'sse' ? 'sse' : 'http',
    headers: pairs(server.headers),
    command: server.command ?? '',
    args: argLines(server.args),
    env: pairs(server.env),
    cwd: server.cwd ?? '',
    startTimeout: server.startTimeoutMs ? String(Math.round(server.startTimeoutMs / 1000)) : ''
  }
}

/** Notes of a directory entry without the "Sondagem: …" sentences the probe script appends (internal wording). */
export function cleanNotes(notes: string | undefined): string | undefined {
  if (typeof notes !== 'string') return undefined
  const text = notes.replace(/\s*Sondagem:[^.]*\.?/g, '').replace(/\s+/g, ' ').trim()
  return text ? text : undefined
}

/** A message from the main process as a sentence: first letter up, one final period. */
export function sentence(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  return clean ? `${clean.charAt(0).toLocaleUpperCase('pt-BR')}${clean.slice(1)}.` : ''
}

/** True when a login window may open (the link the main process gave us is an http(s) address). */
export function isOpenableLink(link: string | undefined): link is string {
  return Boolean(link && /^https?:\/\//i.test(link))
}

/** Which actions the detail offers for the current state. Pure so the flow can be tested. */
export interface DetailPlan {
  /** Show the credential / endpoint form. */
  form: boolean
  /** Show the one-click connect (login with the account, or no login). */
  oneClick: boolean
  /** The login is waiting for the user. */
  waiting: boolean
  /** Tools and per-tool permissions. */
  tools: boolean
  /** Can disconnect. */
  removable: boolean
}

export function detailPlan(row: ConnectorRow, hasLoginLink = false): DetailPlan {
  const status = row.state.status
  const installed = status !== 'not-installed'
  const needsForm = !row.custom && (credentialFields(row.entry).length > 0 || needsEndpoint(row.entry) || needsOAuthApp(row))
  // Credentials (or the user's own OAuth app) that can be wrong and are typed again after a refusal.
  const staticCredential = row.auth === 'api-key' || row.auth === 'local-env' || needsOAuthApp(row)
  // "Connecting" is also what a server that is simply starting shows; the login wait is the one with a link or the main process's wording.
  const waiting = status === 'connecting' && (hasLoginLink || /aguardando/i.test(row.state.detail ?? ''))
  return {
    // A form for the first connection, and again when the server refused the credential.
    form: needsForm && (!installed || ((status === 'needs-auth' || status === 'error') && staticCredential) || (needsEndpoint(row.entry) && status !== 'connected')),
    // A server added by hand cannot be rebuilt from a directory entry; it is reconnected or removed instead.
    oneClick: !row.custom && !needsForm && (!installed || status === 'needs-auth' || status === 'error'),
    waiting,
    tools: status === 'connected',
    removable: installed
  }
}
