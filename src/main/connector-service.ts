import fs from 'node:fs'
import path from 'node:path'
import type {
  ConnectInput,
  ConnectorAuth,
  ConnectorCategory,
  ConnectorCredential,
  ConnectorDirectory,
  ConnectorState,
  ConnectorTool,
  ConnectResult,
  DirectoryConnector,
  ToolPolicy
} from '../shared/mcp-connectors.js'
import type { McpServerSettings } from '../shared/types.js'
import type { McpClient } from '../core/mcp/client.js'
import { hintForMcpError } from '../core/mcp/hints.js'
import { resolveToolPolicy, type McpToolAnnotations } from '../core/mcp/policy.js'
import { MCP_CATALOG, buildCatalogServer, catalogEntry, type McpCatalogEntry } from '../core/mcp/catalog.js'
import { resourcePath } from '../core/util/resources.js'
import { OAuthSetupError, type McpOAuthManager, type OAuthStartOptions } from './mcp-oauth.js'
import { deriveCredentials, isMaskedSecret, isSecretName } from './mcp-secrets.js'
import type { SettingsStore } from './settings.js'

/** Servers a user may keep configured (each connector is one). */
export const MAX_MCP_SERVERS = 100

const CATEGORY_OF_CATALOG: Record<McpCatalogEntry['category'], ConnectorCategory> = {
  atlassian: 'produtividade',
  productivity: 'produtividade',
  development: 'desenvolvimento',
  database: 'dados',
  browser: 'desenvolvimento',
  desktop: 'produtividade',
  documents: 'documentos',
  observability: 'nuvem-infra',
  design: 'design',
  cloud: 'nuvem-infra',
  communication: 'comunicacao'
}

/** Entry name of settings.mcpServers for a directory id (same rule the catalog install uses). */
export function serverNameFor(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
}

/** The start time a user may ask for: 5 s to 10 min, whole milliseconds; anything else means "the default". */
function cleanStartTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(Math.min(600_000, Math.max(5_000, value)))
}

function hostOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/** The curated catalog (src/core/mcp/catalog.ts) as a directory entry; used until resources/mcp-directory.json exists. */
export function catalogToDirectory(entry: McpCatalogEntry): DirectoryConnector {
  const credentials: ConnectorCredential[] = [
    ...(entry.env ?? []).map((item) => ({
      key: item.key,
      label: item.label,
      where: 'env' as const,
      required: item.required,
      secret: item.secret,
      example: item.example
    })),
    ...(entry.headers ?? []).map((item) => ({
      key: item.key,
      label: item.label,
      where: 'header' as const,
      required: item.required,
      secret: item.secret,
      example: item.example
    }))
  ]
  const remote = entry.transport !== 'stdio'
  const needsCredentials = credentials.some((item) => item.required)
  const auth: ConnectorAuth = entry.oauth
    ? 'oauth'
    : remote
      ? needsCredentials || entry.basicAuth
        ? 'api-key'
        : 'none'
      : needsCredentials
        ? 'local-env'
        : 'none'
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: CATEGORY_OF_CATALOG[entry.category] ?? 'outros',
    kind: remote ? 'remote' : 'local',
    transport: entry.transport,
    url: entry.url,
    command: entry.command,
    args: entry.args,
    auth,
    credentials: credentials.length ? credentials : undefined,
    tools: [],
    approvalTools: entry.approvalTools,
    docs: entry.docs,
    notes: entry.notes,
    iconDomain: hostOf(entry.docs) ?? hostOf(entry.url),
    source: 'openclod-catalog'
  }
}

const AUTHS = new Set<ConnectorAuth>(['oauth', 'oauth-static', 'api-key', 'local-env', 'none', 'unknown'])

/** The directory file is data from outside the process: keep only well-formed entries and fill the optional fields. */
function sanitizeEntry(raw: unknown): DirectoryConnector | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<DirectoryConnector>
  if (typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string') return null
  const transport = item.transport === 'http' || item.transport === 'sse' || item.transport === 'stdio' ? item.transport : null
  if (!transport) return null
  // A remote entry may have no public URL (the directory lists it without one): the user supplies it when connecting.
  if (transport === 'stdio' && typeof item.command !== 'string') return null
  return {
    ...item,
    id: item.id.trim(),
    name: item.name,
    description: typeof item.description === 'string' ? item.description : '',
    category: item.category ?? 'outros',
    kind: transport === 'stdio' ? 'local' : 'remote',
    transport,
    auth: item.auth && AUTHS.has(item.auth) ? item.auth : 'unknown',
    tools: Array.isArray(item.tools) ? item.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    source: item.source === 'claude-directory' ? 'claude-directory' : 'openclod-catalog'
  } as DirectoryConnector
}

/**
 * What a tool does today, as shown in the connector settings. It is the very rule the harness enforces
 * (src/core/mcp/policy.ts), so the screen never promises something the runner will not do.
 */
export function effectiveToolPolicy(
  config: Pick<McpServerSettings, 'toolPolicy' | 'approvalTools' | 'includeTools' | 'excludeTools'>,
  name: string,
  annotations?: McpToolAnnotations
): ToolPolicy {
  return resolveToolPolicy(config, name, annotations).policy
}

const UNAUTHORIZED =
  /\b401\b|unauthori[sz]ed|unauthenticated|invalid[_ -]?token|authentication (?:required|failed)|token.{0,24}(?:expired|revoked|invalid)|api token|www-authenticate/i

export function looksUnauthorized(error: string | null | undefined): boolean {
  return Boolean(error && UNAUTHORIZED.test(error))
}

function hasStaticCredentialHeader(server: McpServerSettings): boolean {
  return Object.entries(server.headers ?? {}).some(([key, value]) => Boolean(value) && isSecretName(key))
}

/** What the user can do about an error, in pt-BR. The core's table (hintForMcpError) wins; this covers a failed login. */
function hintFor(server: McpServerSettings, error: string, context: { oauthCapable: boolean }): string | undefined {
  const known = hintForMcpError(server.name, server, error)
  if (known) return known
  if (looksUnauthorized(error)) {
    return context.oauthCapable
      ? 'Entre com sua conta para autorizar este conector.'
      : 'O servidor exige credencial. Informe a chave de API do serviço.'
  }
  return undefined
}

export interface ConnectorDeps {
  settings: SettingsStore
  oauth: McpOAuthManager
  /** Live MCP clients by server name. */
  clients(): ReadonlyMap<string, McpClient>
  /** Restarts one MCP server (or all of them when no name is given); serialized by the orchestrator. A server that is no longer configured is just stopped. */
  restart(serverName?: string): Promise<void>
  /** Rebuilds the tool registry after a policy change. */
  refreshTools(): void
  /** Tells the interface that connectors changed (`settings_changed`, scope `mcp`). */
  emitChanged(): void
  /** Credentials a server needed that the vault did not have at the last start. */
  secretIssues(): ReadonlyMap<string, string[]>
  /** Last 401 challenge seen per server. */
  challenge(serverName: string): string | undefined
  /** Test hook: where the directory comes from. Defaults to resources/mcp-directory.json. */
  loadDirectoryFile?: () => unknown
  log?: (message: string) => void
}

/** An OAuth client a login can use, and whose it is. */
interface UsableClient {
  clientId: string
  clientSecret?: string
  source: 'user' | 'directory'
}

/** The user's OAuth app as typed: trimmed, bounded, and refused when it cannot be an id. */
function cleanClient(raw: ConnectInput['oauthClient']): { clientId: string; clientSecret?: string } | undefined {
  if (!raw) return undefined
  const clientId = String(raw.clientId ?? '').trim()
  if (!clientId) throw new Error('informe o client ID do aplicativo OAuth')
  if (clientId.length > 500 || /\s/.test(clientId)) throw new Error('client ID inválido: sem espaços e com até 500 caracteres')
  const clientSecret = String(raw.clientSecret ?? '').trim().slice(0, 2000)
  return { clientId, ...(clientSecret ? { clientSecret } : {}) }
}

interface Built {
  server: McpServerSettings
  missing: string[]
  /** env/header names that must go to the vault even if their name does not look secret. */
  secretKeys: Set<string>
}

/**
 * The connector directory, the state of each connector and the connect / disconnect / tool policy actions.
 * Credentials go straight to the vault (settings.json keeps `${secret:...}` references) and OAuth runs in the
 * background so the interface gets the login URL immediately.
 */
export class ConnectorService {
  private cache: { mtimeMs: number; directory: ConnectorDirectory } | null = null
  /** Logins waiting for the user, per server: the login page, the exact return URL and how it was reached. */
  private pendingAuth = new Map<string, { authUrl: string; redirectUri: string; fallback: boolean; staticClient: boolean }>()
  /** Last failure of a connect/login per server, shown until the next success. */
  private failures = new Map<string, { error: string; hint?: string }>()

  constructor(private readonly deps: ConnectorDeps) {}

  /* ------------------------------- directory ------------------------------ */

  directory(): ConnectorDirectory {
    const catalog = MCP_CATALOG.map(catalogToDirectory)
    let file: ConnectorDirectory | null = null
    try {
      if (this.deps.loadDirectoryFile) {
        file = this.fromFile(this.deps.loadDirectoryFile())
      } else {
        const location = resourcePath('mcp-directory.json')
        if (location) {
          const mtimeMs = fs.statSync(location).mtimeMs
          if (this.cache?.mtimeMs === mtimeMs) return this.cache.directory
          file = this.fromFile(JSON.parse(fs.readFileSync(location, 'utf8')))
          if (file) {
            const merged = this.withCatalog(file, catalog)
            this.cache = { mtimeMs, directory: merged }
            return merged
          }
        }
      }
    } catch (err) {
      this.deps.log?.(`diretório de conectores ilegível: ${(err as Error).message}`)
    }
    return file ? this.withCatalog(file, catalog) : { generatedAt: Date.now(), entries: catalog }
  }

  private fromFile(raw: unknown): ConnectorDirectory | null {
    if (!raw || typeof raw !== 'object') return null
    const parsed = raw as { generatedAt?: unknown; entries?: unknown }
    if (!Array.isArray(parsed.entries)) return null
    const entries = parsed.entries.map(sanitizeEntry).filter((entry): entry is DirectoryConnector => entry !== null)
    return { generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(), entries }
  }

  /** Entries of Openclod's own catalog that the file does not list stay connectable. */
  private withCatalog(file: ConnectorDirectory, catalog: DirectoryConnector[]): ConnectorDirectory {
    const known = new Set(file.entries.map((entry) => entry.id))
    return { generatedAt: file.generatedAt, entries: [...file.entries, ...catalog.filter((entry) => !known.has(entry.id))] }
  }

  private entryById(id: string): DirectoryConnector | undefined {
    return this.directory().entries.find((entry) => entry.id === id)
  }

  /* -------------------------------- states -------------------------------- */

  private servers(): McpServerSettings[] {
    return this.deps.settings.get().mcpServers ?? []
  }

  /** Which installed server stands for each directory entry: same name first, then same URL. */
  private matches(entries: DirectoryConnector[], servers: McpServerSettings[]): Map<string, McpServerSettings> {
    const out = new Map<string, McpServerSettings>()
    const taken = new Set<string>()
    for (const entry of entries) {
      const server = servers.find((item) => item.name === serverNameFor(entry.id))
      if (server) {
        out.set(entry.id, server)
        taken.add(server.name)
      }
    }
    const normal = (url: string | undefined): string => (url ?? '').trim().replace(/\/+$/, '').toLowerCase()
    // A URL shared by several entries (Atlassian OAuth and API token) says nothing about which one a server is.
    const urlCount = new Map<string, number>()
    for (const entry of entries) if (entry.url) urlCount.set(normal(entry.url), (urlCount.get(normal(entry.url)) ?? 0) + 1)
    for (const entry of entries) {
      if (out.has(entry.id) || !entry.url || (urlCount.get(normal(entry.url)) ?? 0) > 1) continue
      const server = servers.find((item) => !taken.has(item.name) && item.url && normal(item.url) === normal(entry.url))
      if (server) {
        out.set(entry.id, server)
        taken.add(server.name)
      }
    }
    return out
  }

  private serverFor(id: string): McpServerSettings | undefined {
    const servers = this.servers()
    const entries = this.directory().entries
    const byEntry = this.matches(entries, servers).get(id)
    return byEntry ?? servers.find((server) => server.name === id)
  }

  states(): ConnectorState[] {
    const servers = this.servers()
    const entries = this.directory().entries
    const matched = this.matches(entries, servers)
    const claimed = new Set([...matched.values()].map((server) => server.name))
    const states = entries.map((entry) => this.stateOf(entry.id, matched.get(entry.id), entry))
    // Servers added by hand (custom connectors, imports): the id is the server name.
    for (const server of servers) if (!claimed.has(server.name)) states.push(this.stateOf(server.name, server, undefined))
    return states
  }

  stateById(id: string): ConnectorState {
    return this.stateOf(id, this.serverFor(id), this.entryById(id))
  }

  private stateOf(id: string, server: McpServerSettings | undefined, entry: DirectoryConnector | undefined): ConnectorState {
    return this.withOAuthInfo(this.baseState(id, server, entry), server, entry)
  }

  /** OAuth connectors also tell the interface which return URL to register and which client id will be used. */
  private withOAuthInfo(state: ConnectorState, server: McpServerSettings | undefined, entry: DirectoryConnector | undefined): ConnectorState {
    const pending = server ? this.pendingAuth.get(server.name) : undefined
    if (!pending && entry?.auth !== 'oauth' && entry?.auth !== 'oauth-static') return state
    const next: ConnectorState = { ...state, redirectUri: pending?.redirectUri ?? this.deps.oauth.preferredRedirectUri }
    if (pending?.fallback && pending.staticClient) {
      // The fixed port was busy: an app registered with the fixed URL will refuse this login's URL.
      next.hint =
        `A porta fixa estava ocupada, então este login usa ${pending.redirectUri}. Se o seu aplicativo OAuth só tem ` +
        `${this.deps.oauth.preferredRedirectUri} cadastrada, feche o programa que usa a porta e conecte de novo.`
    }
    const client = this.clientFor(server?.name ?? serverNameFor(entry?.id ?? state.id), entry)
    if (client) next.oauthClient = { clientId: client.clientId, hasSecret: Boolean(client.clientSecret), source: client.source }
    return next
  }

  private baseState(id: string, server: McpServerSettings | undefined, entry: DirectoryConnector | undefined): ConnectorState {
    if (!server) return { id, status: 'not-installed' }
    const name = server.name
    const base = { id, serverName: name }
    if (!server.enabled) return { ...base, status: 'disabled', detail: 'Desativado' }

    const login = this.deps.oauth.status(name)
    const tokenExpiresAt = login.expiresAt
    const connectedAs = login.account
    const issues = this.deps.secretIssues().get(name)
    if (issues?.length) {
      return {
        ...base,
        status: 'needs-auth',
        detail: 'Credencial ausente do cofre',
        lastError: `credencial ausente do cofre do sistema: ${issues.join(', ')}`,
        hint: 'O cofre não tem o valor guardado para este conector. Desconecte e conecte de novo informando a credencial.'
      }
    }
    if (this.pendingAuth.has(name)) {
      return { ...base, status: 'connecting', detail: 'Aguardando você concluir o login no navegador' }
    }
    const client = this.deps.clients().get(name)
    const failure = this.failures.get(name)
    const staticAuth = hasStaticCredentialHeader(server)
    const oauthCapable = !staticAuth && (entry ? entry.auth === 'oauth' || entry.auth === 'oauth-static' || entry.auth === 'unknown' : Boolean(server.url))
    if (!client && failure) {
      // A login that did not finish: the server was never started, so there is no client error to show.
      return { ...base, status: oauthCapable ? 'needs-auth' : 'error', detail: failure.error.slice(0, 160), lastError: failure.error.slice(0, 400), hint: failure.hint }
    }
    if (!client || client.state === 'starting') return { ...base, status: 'connecting', detail: 'Conectando…' }
    if (client.state === 'ready') {
      const toolCount = client.toolsList().length
      return {
        ...base,
        status: 'connected',
        detail: `${toolCount} ${toolCount === 1 ? 'ferramenta' : 'ferramentas'}`,
        toolCount,
        connectedAs,
        tokenExpiresAt
      }
    }

    const error = client.lastError ?? failure?.error ?? 'servidor parado'
    const hint = (client.lastError ? undefined : failure?.hint) ?? hintFor(server, error, { oauthCapable })
    // The client retries a lost connection by itself (backoff); an authentication failure is not worth retrying.
    if ((client.reconnectAttempt ?? 0) > 0 && !looksUnauthorized(error)) {
      return { ...base, status: 'connecting', detail: `Reconectando… (tentativa ${client.reconnectAttempt})`, lastError: error.slice(0, 400), hint }
    }
    if (looksUnauthorized(error)) {
      return {
        ...base,
        status: 'needs-auth',
        detail: staticAuth ? 'Credencial recusada pelo servidor' : oauthCapable ? 'Precisa entrar com sua conta' : 'Precisa de credencial',
        lastError: error.slice(0, 400),
        hint,
        connectedAs,
        tokenExpiresAt
      }
    }
    return { ...base, status: 'error', detail: error.slice(0, 160), lastError: error.slice(0, 400), hint }
  }

  /* -------------------------------- connect ------------------------------- */

  async connect(id: string, input: ConnectInput = {}): Promise<ConnectResult> {
    const entry = this.entryById(id)
    if (!entry && !input.custom) throw new Error(`conector "${id}" não encontrado no diretório`)
    if (input.update) {
      if (!input.custom) throw new Error('informe a configuração do conector a editar')
      return this.updateCustom(input.custom)
    }
    if (input.dryRun) {
      return this.rehearse(entry, input, typeof input.dryRun === 'object' ? input.dryRun.minIntervalMs : undefined)
    }
    // The directory lists some remote connectors without a public URL: the user brings it (input.custom.url) when connecting.
    if (entry && entry.transport !== 'stdio' && !entry.url && !/^https?:\/\//i.test(input.custom?.url ?? '')) {
      return {
        state: {
          id: entry.id,
          status: 'needs-auth',
          detail: 'Informe a URL do servidor MCP',
          lastError: 'este conector não tem endereço público no diretório',
          hint: entry.notes ?? 'Peça ao serviço a URL do servidor MCP e informe-a ao conectar.'
        }
      }
    }
    const supplied = cleanClient(input.oauthClient)
    const clientName = entry ? serverNameFor(entry.id) : serverNameFor(input.custom?.name ?? '')
    // The client of the login: the app the user just typed, else the one saved earlier, else the directory's own.
    const usable: UsableClient | undefined = supplied ? { ...supplied, source: 'user' } : this.clientFor(clientName, entry)
    if (entry?.auth === 'oauth-static' && !usable) {
      // The server does not register clients by itself: nothing is installed until the user brings an OAuth app.
      const redirectUri = this.deps.oauth.preferredRedirectUri
      return {
        state: {
          id: entry.id,
          status: 'needs-auth',
          detail: 'Informe o client ID do aplicativo OAuth',
          lastError: 'este conector exige um aplicativo OAuth próprio: o servidor não aceita registro dinâmico',
          hint:
            `Crie um aplicativo OAuth no serviço, cadastre exatamente esta URL de retorno: ${redirectUri} ` +
            'e informe o client ID (e o segredo, se houver). Se o serviço oferece chave de API, conecte por ela.',
          redirectUri
        }
      }
    }
    const built = entry ? this.buildFromEntry(entry, input.credentials ?? {}, input.custom) : this.buildCustom(input.custom!)
    const stateId = entry ? entry.id : built.server.name
    if (built.missing.length) {
      return {
        state: {
          id: stateId,
          status: 'needs-auth',
          detail: `Faltam credenciais: ${built.missing.join(', ')}`,
          lastError: `faltam credenciais obrigatórias: ${built.missing.join(', ')}`,
          hint: 'Preencha os campos obrigatórios; os valores vão para o cofre do sistema, nunca para o arquivo de configuração.'
        }
      }
    }

    const existing = this.servers().find((server) => server.name === built.server.name)
    const server = await this.vaultMarkedSecrets(built, existing)
    const others = this.servers().filter((item) => item.name !== server.name)
    if (!existing && others.length >= MAX_MCP_SERVERS) throw new Error(`limite de ${MAX_MCP_SERVERS} conectores atingido`)
    await this.deps.settings.update({ mcpServers: [...others, server] })
    this.failures.delete(server.name)

    const oauthFirst = entry?.auth === 'oauth' || entry?.auth === 'oauth-static'
    const mayNeedLogin = oauthFirst || ((!entry || entry.auth === 'unknown') && !hasStaticCredentialHeader(server))
    const options: OAuthStartOptions = { clientId: usable?.clientId, clientSecret: usable?.clientSecret, scopes: entry?.oauthScopes }
    const login = Boolean(server.url) && mayNeedLogin
    let authUrl: string | undefined
    try {
      // The user's own app is kept (id and secret in the vault) so reconnecting does not ask for it again.
      if (supplied && login) await this.saveClient(server.name, supplied)
      if (login && oauthFirst && !(await this.deps.oauth.token(server.name))) {
        // Registered first, so the card shows it while the user is at the consent screen.
        authUrl = await this.startLogin(server, options)
        this.deps.emitChanged()
        return { state: this.stateById(stateId), authUrl }
      }
      await this.deps.restart(server.name)
      if (login && !oauthFirst) {
        const state = this.stateOf(stateId, this.serverFor(stateId), entry)
        if (state.status === 'needs-auth') authUrl = await this.startLogin(server, options)
      }
    } catch (err) {
      return this.rollback(stateId, server, existing, err)
    }
    this.deps.emitChanged()
    return { state: this.stateById(stateId), ...(authUrl ? { authUrl } : {}) }
  }

  /**
   * Edits a connector the user added by hand: the same name gets a new configuration (a remote address and headers, or a
   * local program, its arguments, variables, folder and start time). A value still showing the mask keeps the credential
   * the vault holds. What the user chose elsewhere (tool permissions, filters) stays. The server restarts with it.
   */
  private async updateCustom(custom: NonNullable<ConnectInput['custom']>): Promise<ConnectResult> {
    const name = serverNameFor(custom.name || '')
    const existing = this.servers().find((server) => server.name === name)
    if (!existing) throw new Error(`o conector "${custom.name}" não está instalado`)
    const fromDirectory = [...this.matches(this.directory().entries, this.servers()).values()].some((server) => server.name === name)
    if (fromDirectory) throw new Error('este conector vem do diretório: para mudar a credencial, conecte-o de novo pela tela dele')
    const built = this.buildCustom({ ...custom, name })
    const server = await this.vaultMarkedSecrets(built, existing, { replaceTuning: true })
    if (existing.enabled === false) server.enabled = false
    await this.deps.settings.update({ mcpServers: this.servers().map((item) => (item.name === name ? server : item)) })
    this.failures.delete(name)
    try {
      await this.deps.restart(name)
    } catch (err) {
      this.deps.log?.(`conector ${name}: não foi possível reiniciar depois da edição: ${(err as Error).message}`)
    }
    this.deps.emitChanged()
    return { state: this.stateById(name) }
  }

  /** A first connection that could not even start: nothing half-installed is left behind. */
  private async rollback(
    stateId: string,
    server: McpServerSettings,
    existing: McpServerSettings | undefined,
    err: unknown
  ): Promise<ConnectResult> {
    const error = err instanceof Error ? err.message : String(err)
    const hint = err instanceof OAuthSetupError ? err.hint : undefined
    if (!existing) {
      await this.deps.settings.update({ mcpServers: this.servers().filter((item) => item.name !== server.name) }).catch(() => undefined)
      await this.deps.settings.clearMcpSecrets(server.name).catch(() => undefined)
      await this.deps.restart(server.name).catch(() => undefined)
    }
    this.deps.emitChanged()
    const redirectUri = err instanceof OAuthSetupError ? err.redirectUri : undefined
    return {
      state: { id: stateId, status: 'error', detail: error.slice(0, 160), lastError: error.slice(0, 400), hint, ...(redirectUri ? { redirectUri } : {}) }
    }
  }

  /** Opens the login and finishes it in the background: success restarts the server, failure becomes the card's error. */
  private async startLogin(server: McpServerSettings, options: OAuthStartOptions): Promise<string> {
    const session = await this.deps.oauth.begin(server.name, server.url!, this.deps.challenge(server.name), options)
    const staticClient = Boolean(options.clientId)
    this.pendingAuth.set(server.name, {
      authUrl: session.authUrl,
      redirectUri: session.redirectUri,
      fallback: session.redirectUriFallback,
      staticClient
    })
    void session.completion
      .then(async (token) => {
        this.pendingAuth.delete(server.name)
        if (token) {
          this.failures.delete(server.name)
          await this.deps.restart(server.name)
        } else {
          this.failures.set(server.name, {
            error: 'o login não foi concluído (cancelado, negado ou expirou)',
            // A provider that does not accept the client or the return URL usually just shows its own error page.
            hint: staticClient
              ? `Se o provedor mostrou erro de URL de retorno ou de client ID, cadastre exatamente ${session.redirectUri} no aplicativo OAuth, confira o client ID e use "Conectar" de novo.`
              : 'Use "Conectar" de novo para abrir o login outra vez.'
          })
        }
      })
      .catch((err: unknown) => {
        this.pendingAuth.delete(server.name)
        this.failures.set(server.name, {
          error: err instanceof Error ? err.message : String(err),
          hint: err instanceof OAuthSetupError ? err.hint : undefined
        })
      })
      .finally(() => this.deps.emitChanged())
    return session.authUrl
  }

  /** Moves the credentials the directory marks as secret into the vault and swaps them for references. */
  private async vaultMarkedSecrets(
    built: Built,
    existing: McpServerSettings | undefined,
    options: { replaceTuning?: boolean } = {}
  ): Promise<McpServerSettings> {
    const server: McpServerSettings = { ...built.server }
    // Keep what the user tuned on a reconnect (tool policy, filters, timeouts); credentials come from the new values.
    // An edit of a hand-made connector states the folder and the start time itself: leaving them out removes them.
    if (existing) {
      for (const key of ['toolPolicy', 'includeTools', 'excludeTools', 'approvalTools', 'timeoutMs', 'startTimeoutMs', 'maxOutputTokens', 'alwaysLoad', 'cwd'] as const) {
        if (options.replaceTuning && (key === 'startTimeoutMs' || key === 'cwd')) continue
        if (server[key] === undefined && existing[key] !== undefined) (server as unknown as Record<string, unknown>)[key] = existing[key]
      }
    }
    const toVault: Record<string, string> = {}
    for (const section of ['env', 'headers'] as const) {
      for (const [key, value] of Object.entries(server[section] ?? {})) {
        // A value still showing the mask is the placeholder of a credential already in the vault: the settings store
        // restores it; it must never be saved as if it were the credential.
        if (built.secretKeys.has(key) && !isSecretName(key) && value.trim() && !isMaskedSecret(value)) toVault[key] = value
      }
    }
    if (!Object.keys(toVault).length) return server
    const refs = await this.deps.settings.setMcpSecrets(server.name, toVault)
    for (const section of ['env', 'headers'] as const) {
      const record = server[section]
      if (!record) continue
      server[section] = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, refs[key] ?? value]))
    }
    const swap = (text: string): string =>
      Object.entries(toVault).reduce((acc, [key, value]) => (value.length >= 8 && acc.includes(value) ? acc.split(value).join(refs[key]) : acc), text)
    if (server.args?.length) server.args = server.args.map(swap)
    if (server.url) server.url = swap(server.url)
    return server
  }

  private buildFromEntry(entry: DirectoryConnector, values: Record<string, string>, custom?: ConnectInput['custom']): Built {
    const name = serverNameFor(entry.id)
    const credentials = entry.credentials ?? []
    const secretKeys = new Set(
      credentials.filter((item) => item.secret ?? (item.where === 'header' || isSecretName(item.key))).map((item) => item.key)
    )
    const clean = (key: string): string => (values[key] ?? '').trim()

    const curated = entry.source === 'openclod-catalog' ? catalogEntry(entry.id) : null
    if (curated) {
      const env: Record<string, string> = {}
      const headers: Record<string, string> = {}
      for (const item of credentials) if (clean(item.key)) (item.where === 'header' ? headers : env)[item.key] = clean(item.key)
      const built = buildCatalogServer(curated, { env, headers, name })
      if (built.server) {
        // The Basic header composed from email + token is a credential too.
        if (curated.basicAuth) secretKeys.add('Authorization')
        return { server: built.server, missing: built.missing, secretKeys }
      }
      return { server: { name, command: '', args: [], enabled: true }, missing: built.missing, secretKeys }
    }

    const missing = credentials.filter((item) => item.required && !clean(item.key)).map((item) => item.key)
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    for (const item of credentials) {
      const value = clean(item.key)
      if (!value) continue
      if (item.where === 'header') headers[item.key] = `${item.prefix ?? ''}${value}`
      else env[item.key] = value
    }
    const substitute = (text: string): string => text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key: string) => env[key] ?? match)
    const server: McpServerSettings = {
      name,
      type: entry.transport,
      command: entry.command ?? '',
      args: (entry.args ?? []).map(substitute),
      enabled: true
    }
    if (entry.transport !== 'stdio') {
      server.command = ''
      server.args = []
      // An entry without a public URL takes the one the user typed.
      server.url = substitute(entry.url ?? custom?.url?.trim().slice(0, 2000) ?? '')
      for (const [key, value] of Object.entries(custom?.headers ?? {}).slice(0, 30)) {
        if (key.trim() && typeof value === 'string' && value.trim()) {
          headers[key.trim().slice(0, 120)] = value.slice(0, 4000)
          secretKeys.add(key.trim().slice(0, 120))
        }
      }
    }
    if (Object.keys(env).length) server.env = env
    if (Object.keys(headers).length) server.headers = headers
    if (entry.approvalTools?.length) server.approvalTools = [...entry.approvalTools]
    return { server, missing, secretKeys }
  }

  private buildCustom(custom: NonNullable<ConnectInput['custom']>): Built {
    const name = serverNameFor(custom.name || '')
    if (!name) throw new Error('informe um nome para o conector personalizado')
    if (typeof custom.command === 'string' && custom.command.trim()) return this.buildLocal(name, custom)
    if (!/^https?:\/\//i.test(custom.url ?? '')) throw new Error('a URL do conector deve começar com http:// ou https://')
    const headers = Object.fromEntries(
      Object.entries(custom.headers ?? {})
        .filter(([key, value]) => key.trim() && typeof value === 'string' && value.trim())
        .slice(0, 30)
        .map(([key, value]) => [key.trim().slice(0, 120), value.slice(0, 4000)])
    )
    const server: McpServerSettings = {
      name,
      type: custom.transport === 'sse' ? 'sse' : 'http',
      url: (custom.url ?? '').trim().slice(0, 2000),
      command: '',
      args: [],
      enabled: true
    }
    if (Object.keys(headers).length) server.headers = headers
    const startTimeoutMs = cleanStartTimeout(custom.startTimeoutMs)
    if (startTimeoutMs) server.startTimeoutMs = startTimeoutMs
    // Any header of a hand-made connector is treated as a credential: the user typed it for a reason.
    return { server, missing: [], secretKeys: new Set(Object.keys(headers)) }
  }

  /**
   * A program that runs on this computer and speaks MCP over stdio. There is no shell: `command` is the program and
   * each element of `args` is one argument, so there is no quoting to get wrong. Variables whose name looks like a
   * credential (KEY, TOKEN, SECRET, PASSWORD…) go to the vault when the settings are saved.
   */
  private buildLocal(name: string, custom: NonNullable<ConnectInput['custom']>): Built {
    const command = (custom.command ?? '').trim()
    if (command.length > 1000 || /[\u0000-\u001f]/.test(command)) throw new Error('o comando é inválido: use o nome do programa ou o caminho completo, em uma linha')
    const rawArgs = Array.isArray(custom.args) ? custom.args : []
    if (rawArgs.length > 100) throw new Error('são argumentos demais (o limite é 100)')
    const args = rawArgs.map((arg) => String(arg))
    if (args.some((arg) => arg.length > 4000 || arg.includes('\u0000'))) throw new Error('um argumento é grande demais ou tem caracteres inválidos')
    const env: Record<string, string> = {}
    const entries = Object.entries(custom.env ?? {}).filter(([key, value]) => key.trim() && typeof value === 'string' && value.trim())
    if (entries.length > 60) throw new Error('são variáveis de ambiente demais (o limite é 60)')
    for (const [rawKey, value] of entries) {
      const key = rawKey.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(key)) throw new Error(`o nome da variável “${key.slice(0, 40)}” é inválido: use letras, números e sublinhado`)
      env[key] = value.slice(0, 4000)
    }
    const cwd = (custom.cwd ?? '').trim()
    if (cwd) {
      if (!path.isAbsolute(cwd)) throw new Error('a pasta de trabalho deve ser um caminho completo, como C:\\projetos\\meu-servidor')
      let isFolder = false
      try {
        isFolder = fs.statSync(cwd).isDirectory()
      } catch {
        isFolder = false
      }
      if (!isFolder) throw new Error(`a pasta de trabalho não existe: ${cwd.slice(0, 200)}`)
    }
    const server: McpServerSettings = { name, command, args, enabled: true }
    if (Object.keys(env).length) server.env = env
    if (cwd) server.cwd = cwd
    const startTimeoutMs = cleanStartTimeout(custom.startTimeoutMs)
    if (startTimeoutMs) server.startTimeoutMs = startTimeoutMs
    return { server, missing: [], secretKeys: new Set() }
  }

  /* ------------------------------- disconnect ----------------------------- */

  async disconnect(id: string): Promise<ConnectorState> {
    const server = this.serverFor(id)
    if (!server) return { id, status: 'not-installed' }
    this.pendingAuth.delete(server.name)
    this.failures.delete(server.name)
    // Revoke while the grant still exists; the local copy goes away even if the server cannot revoke.
    const revoked = await this.deps.oauth.revoke(server.name).catch((err: unknown) => ({
      revoked: false,
      supported: false,
      detail: (err as Error).message
    }))
    await this.deps.settings.update({ mcpServers: this.servers().filter((item) => item.name !== server.name) })
    await this.deps.settings.clearMcpSecrets(server.name).catch((err: unknown) => {
      this.deps.log?.(`cofre: não foi possível limpar as credenciais de ${server.name}: ${(err as Error).message}`)
    })
    await this.deps.restart(server.name)
    this.deps.emitChanged()
    this.deps.log?.(`conector ${server.name} desconectado${revoked.supported ? (revoked.revoked ? ' (token revogado)' : ' (revogação falhou)') : ''}`)
    return { id, status: 'not-installed' }
  }

  /* ---------------------------------- tools ------------------------------- */

  tools(serverName: string): ConnectorTool[] {
    const config = this.servers().find((server) => server.name === serverName)
    const client = this.deps.clients().get(serverName)
    if (!config || !client) return []
    // Every tool the server offers (a denied one stays listed, so it can be allowed again), with the policy the runner enforces.
    return client.toolPolicies().map((tool) => ({
      name: tool.name,
      description: tool.description.replace(/\s+/g, ' ').slice(0, 400),
      policy: tool.policy.policy,
      ...(tool.annotations?.readOnlyHint !== undefined ? { readOnly: tool.annotations.readOnlyHint } : {}),
      ...(tool.annotations?.destructiveHint !== undefined ? { destructive: tool.annotations.destructiveHint } : {})
    }))
  }

  /**
   * Saves a per-tool permission. `'*'` sets the policy of every tool of the server (explicit per-tool choices are cleared,
   * like "set all" in Claude's connector settings).
   */
  async setToolPolicy(serverName: string, tool: string, policy: ToolPolicy): Promise<ConnectorTool[]> {
    if (!['allow', 'ask', 'deny'].includes(policy)) throw new Error(`política inválida: ${String(policy)}`)
    const name = tool.trim().slice(0, 200)
    if (!name) throw new Error('informe a ferramenta (ou * para todas)')
    const servers = this.servers()
    if (!servers.some((server) => server.name === serverName)) throw new Error(`servidor MCP "${serverName}" não está configurado`)
    const next = servers.map((server) => {
      if (server.name !== serverName) return server
      const toolPolicy: Record<string, ToolPolicy> = name === '*' ? { '*': policy } : { ...(server.toolPolicy ?? {}), [name]: policy }
      return { ...server, toolPolicy }
    })
    await this.deps.settings.update({ mcpServers: next })
    this.deps.refreshTools()
    this.deps.emitChanged()
    return this.tools(serverName)
  }

  async reload(): Promise<ConnectorState[]> {
    await this.deps.restart()
    this.deps.emitChanged()
    return this.states()
  }

  /** `mcpServers` for the JSON editor with every credential masked. */
  maskedSettings(): McpServerSettings[] {
    return this.deps.settings.maskedMcpServers()
  }

  /** OAuth extras of an installed server: the client saved for it (or the directory's) and the directory's scopes. */
  oauthOptions(serverName: string): OAuthStartOptions {
    const entries = this.directory().entries
    const entry = [...this.matches(entries, this.servers())].find(([, server]) => server.name === serverName)?.[0]
    const found = entries.find((item) => item.id === entry)
    const client = this.clientFor(serverName, found)
    return { clientId: client?.clientId, clientSecret: client?.clientSecret, scopes: found?.oauthScopes }
  }

  /**
   * The OAuth client a login will use: the user's own app saved for this server first, else the directory's public client
   * id. Id and secret live in the vault (`oauth_client_id`, `oauth_client_secret`, next to the server's other credentials):
   * the id is public, but keeping both together costs nothing and, unlike a field of settings.json, survives the JSON
   * editor, which only knows the fields of an MCP server.
   */
  private clientFor(serverName: string, entry: DirectoryConnector | undefined): UsableClient | undefined {
    const clientId = this.deps.settings.mcpSecretValue(serverName, 'oauth_client_id')
    if (clientId) return { clientId, clientSecret: this.deps.settings.mcpSecretValue(serverName, 'oauth_client_secret'), source: 'user' }
    if (entry?.oauthClientId) return { clientId: entry.oauthClientId, source: 'directory' }
    return undefined
  }

  private async saveClient(serverName: string, client: { clientId: string; clientSecret?: string }): Promise<void> {
    await this.deps.settings.setMcpSecrets(serverName, {
      oauth_client_id: client.clientId,
      ...(client.clientSecret ? { oauth_client_secret: client.clientSecret } : {})
    })
    // A new client without a secret must not keep the secret of the previous one.
    if (!client.clientSecret) await this.deps.settings.clearMcpSecret(serverName, 'oauth_client_secret')
  }

  /**
   * `connect` with `dryRun`: the OAuth rehearsal of a connector. Nothing is installed, saved or opened; the state
   * returned is the current one. See McpOAuthManager.prepareAuthorization.
   */
  private async rehearse(entry: DirectoryConnector | undefined, input: ConnectInput, minIntervalMs: number | undefined): Promise<ConnectResult> {
    const serverName = entry ? serverNameFor(entry.id) : serverNameFor(input.custom?.name ?? '')
    const state = this.stateById(entry ? entry.id : serverName)
    const redirectUri = this.deps.oauth.preferredRedirectUri
    const skip = (error: string, hint?: string): ConnectResult => ({
      state,
      dryRun: { ok: false, steps: [], error, ...(hint ? { hint } : {}), redirectUri, client: 'none' }
    })
    if (entry && entry.auth !== 'oauth' && entry.auth !== 'oauth-static' && entry.auth !== 'unknown') {
      return skip(`este conector não usa OAuth (autenticação: ${entry.auth})`)
    }
    const url = entry?.url ?? input.custom?.url
    if (!url || !/^https?:\/\//i.test(url)) return skip('este conector não tem URL pública para testar', entry?.notes)
    const supplied = cleanClient(input.oauthClient)
    const client: UsableClient | undefined = supplied ? { ...supplied, source: 'user' } : this.clientFor(serverName, entry)
    const report = await this.deps.oauth.prepareAuthorization(serverName, url, {
      clientId: client?.clientId,
      clientSecret: client?.clientSecret,
      scopes: entry?.oauthScopes,
      challenge: this.deps.challenge(serverName),
      minIntervalMs
    })
    return {
      state,
      dryRun: {
        ok: report.ok,
        ...(report.authUrl ? { authUrl: report.authUrl } : {}),
        steps: report.steps,
        ...(report.error ? { error: report.error } : {}),
        ...(report.hint ? { hint: report.hint } : {}),
        redirectUri: report.redirectUri,
        client: report.client === 'dynamic' ? 'dynamic' : report.client === 'provided' ? (client?.source ?? 'directory') : 'none',
        ...(report.scope ? { scope: report.scope } : {})
      }
    }
  }

  /** Opens the login of an installed OAuth connector in the background; a login already waiting is reused. */
  async beginLogin(serverName: string): Promise<string | undefined> {
    const server = this.servers().find((item) => item.name === serverName)
    if (!server?.url) return undefined
    const waiting = this.pendingAuth.get(serverName)
    if (waiting) return waiting.authUrl
    try {
      const authUrl = await this.startLogin(server, this.oauthOptions(serverName))
      this.deps.emitChanged()
      return authUrl
    } catch (err) {
      this.failures.set(serverName, {
        error: err instanceof Error ? err.message : String(err),
        hint: err instanceof OAuthSetupError ? err.hint : undefined
      })
      this.deps.emitChanged()
      throw err
    }
  }

  /** A manual login ("Entrar com OAuth") finished: forget the failure of an earlier attempt. */
  loginFinished(serverName: string): void {
    this.pendingAuth.delete(serverName)
    this.failures.delete(serverName)
  }

  /**
   * `mcp_install({ reuse_credentials_from })`: the credentials of an already configured server for the keys of the
   * new one, copied inside the app so the values never pass through the model. Basic auth (email:token) becomes email + token.
   */
  reuseCredentials(
    sourceName: string,
    target: { env: string[]; headers: string[] }
  ): { env: Record<string, string>; headers: Record<string, string>; keys: string[] } {
    const source = this.deps.settings.mcpCredentialSource(sourceName)
    if (!source) {
      const names = this.servers().map((server) => server.name)
      throw new Error(`servidor "${sourceName}" não está configurado${names.length ? `; configurados: ${names.join(', ')}` : ''}`)
    }
    const derived = deriveCredentials(source, [...target.env, ...target.headers])
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    for (const key of target.env) if (derived.values[key]) env[key] = derived.values[key]
    for (const key of target.headers) if (derived.values[key]) headers[key] = derived.values[key]
    return { env, headers, keys: [...Object.keys(env), ...Object.keys(headers)] }
  }
}
