/**
 * Contract of the "Conectores" feature (the connector directory, like the one Claude shows), shared by the
 * main process, the renderer and the tests. Types only: no logic here.
 *
 * Vocabulary
 *  - directory entry: something the user can connect (a remote MCP of the Claude connector directory, or a local
 *    server of Openclod's own catalog). It is DATA (resources/mcp-directory.json), not an installed server.
 *  - installed server: an entry of settings.mcpServers. A directory entry becomes one when the user connects it.
 *  - connector state: what the app knows right now about a directory entry (is it installed, connected, in need of login).
 */

/** How the connector authenticates. `oauth` = browser login with dynamic client registration + PKCE. */
export type ConnectorAuth =
  /** OAuth 2.1 in the browser; the server accepts dynamic client registration (RFC 7591) and PKCE. */
  | 'oauth'
  /** OAuth, but the server only accepts a pre-registered client id (needs `oauthClientId`). */
  | 'oauth-static'
  /** The user pastes an API key / token that goes in a header (Authorization: Bearer ..., X-Api-Key, ...). */
  | 'api-key'
  /** Local server (stdio) that reads credentials from environment variables. */
  | 'local-env'
  /** No authentication at all. */
  | 'none'
  /** Not probed or not conclusive. */
  | 'unknown'

export type ConnectorKind = 'remote' | 'local'

export type ConnectorCategory =
  | 'produtividade'
  | 'desenvolvimento'
  | 'comunicacao'
  | 'design'
  | 'dados'
  | 'financas'
  | 'vendas-crm'
  | 'marketing'
  | 'suporte'
  | 'documentos'
  | 'nuvem-infra'
  | 'seguranca-compliance'
  | 'pesquisa'
  | 'viagens'
  | 'saude-ciencia'
  | 'midia'
  | 'rh'
  | 'juridico'
  | 'outros'

/** One credential the user has to provide (api-key / local-env connectors). */
export interface ConnectorCredential {
  /** Environment variable name, or header name for `where: 'header'`. */
  key: string
  label: string
  where: 'env' | 'header'
  required?: boolean
  /** Shown masked and stored in the OS vault, never in settings.json. */
  secret?: boolean
  /** Prefix added in front of the value in the header, e.g. "Bearer ". */
  prefix?: string
  example?: string
  help?: string
}

/** What probing the endpoint (no credentials) showed. Recorded by scripts/mcp-probe, shown in the UI. */
export interface ConnectorProbe {
  checkedAt: number
  reachable: boolean
  httpStatus?: number
  /** 401 with `WWW-Authenticate: Bearer resource_metadata=...` (or a protected-resource document). */
  resourceMetadata?: boolean
  /** The authorization server advertises a registration endpoint. */
  dynamicRegistration?: boolean
  pkceS256?: boolean
  /** `initialize` succeeded without credentials. */
  openAccess?: boolean
  /** Streamable HTTP ("http") or legacy SSE answered. */
  transportOk?: 'http' | 'sse'
  note?: string
}

export interface DirectoryConnector {
  /** Stable slug, unique inside the directory (also the default server name once installed). */
  id: string
  name: string
  description: string
  category: ConnectorCategory
  kind: ConnectorKind
  transport: 'http' | 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  auth: ConnectorAuth
  /** For `oauth-static`: the public client id registered for Openclod, when one exists. */
  oauthClientId?: string
  /** OAuth scopes to request (space separated) when the server does not publish them. */
  oauthScopes?: string
  credentials?: ConnectorCredential[]
  /** Names of some of the tools (a preview; the full list comes from the live server). */
  tools: string[]
  toolCount?: number
  /** Tool name patterns (`*` and `?`) that always ask for approval (writes, deletes, sends). */
  approvalTools?: string[]
  docs?: string
  notes?: string
  /** Id of this entry in Anthropic's connector directory (when it comes from there). */
  directoryUuid?: string
  /** Domain of the vendor: seeds the monogram colour and keys the bundled logo (connector-icons/); Openclod does NOT fetch third-party icons at runtime. */
  iconDomain?: string
  probe?: ConnectorProbe
  source: 'claude-directory' | 'openclod-catalog'
}

export interface ConnectorDirectory {
  generatedAt: number
  entries: DirectoryConnector[]
}

export type ConnectorStatus =
  | 'not-installed'
  | 'connecting'
  | 'connected'
  | 'needs-auth'
  | 'error'
  | 'disabled'

export interface ConnectorState {
  /** Directory id (or the server name for custom connectors). */
  id: string
  /** Name of the entry in settings.mcpServers, when installed. */
  serverName?: string
  status: ConnectorStatus
  /** One line for the card: "21 ferramentas", "Precisa entrar com sua conta", the error... */
  detail?: string
  toolCount?: number
  /** Account the OAuth token belongs to, when known. */
  connectedAs?: string
  tokenExpiresAt?: number
  lastError?: string
  /** A hint for the user/agent when the error has a known fix (e.g. "use OAuth instead of API token"). */
  hint?: string
  /**
   * OAuth connectors (`oauth`, `oauth-static`): the exact return URL the login uses, `http://127.0.0.1:<port>/callback`.
   * Show it as "cadastre esta URL de retorno no seu aplicativo": providers such as Slack, Google and GitHub only accept
   * the URL registered in the OAuth app. It is the fixed one (MCP_OAUTH_REDIRECT_URI) unless that port was busy during a
   * login in progress, in which case this is the other URL that login uses and `hint` says so.
   */
  redirectUri?: string
  /**
   * OAuth client the next connect/login will use, when one is known: the user's own app (`source: 'user'`, kept in the
   * OS vault; the secret never comes back, only whether there is one) or the directory's public client id.
   * Reconnecting reuses it without asking again; absent means the user still has to provide one (`oauth-static`).
   */
  oauthClient?: { clientId: string; hasSecret: boolean; source: 'user' | 'directory' }
}

/** Per-tool permission, like Claude's connector settings: always allow, ask every time, never. */
export type ToolPolicy = 'allow' | 'ask' | 'deny'

export interface ConnectorTool {
  name: string
  description: string
  policy: ToolPolicy
  /** From the MCP tool annotations (readOnlyHint / destructiveHint), when the server sends them. */
  readOnly?: boolean
  destructive?: boolean
}

export interface ConnectInput {
  /** Values for the entry's `credentials` (api-key / local-env). Secrets go to the vault. */
  credentials?: Record<string, string>
  /**
   * Custom connector: the user supplies these. For a directory entry that has no public URL, `url` (and `headers`)
   * complete the entry; `name` is then ignored. Two kinds: a remote server (`url`, `transport`, `headers`) or a
   * program that runs on this computer and speaks MCP over stdio (`command`, `args`, `env`, `cwd`).
   */
  custom?: {
    name: string
    /** Remote server: its address (https://, or http:// for this computer). Left out for a local program. */
    url?: string
    transport?: 'http' | 'sse'
    headers?: Record<string, string>
    /** Local program: what to run (`npx`, `uvx`, `node`, a full path). Setting it makes the connector a local one. */
    command?: string
    /** One element per argument; there is no shell, so no quoting. */
    args?: string[]
    /** Environment variables. A value that looks like a credential (KEY, TOKEN, SECRET, PASSWORD…) goes to the vault. */
    env?: Record<string, string>
    /** Working folder (absolute, must exist); absent = the app's own. */
    cwd?: string
    /** How long the server may take to start, in ms (5 s to 10 min); absent = the default of 30 s. */
    startTimeoutMs?: number
  }
  /**
   * With `custom`: edit the connector of that name instead of adding one. It must exist and must not come from the
   * directory. Values still showing the mask (`••••••`, as `maskedMcpSettings` returns them) keep what the vault has;
   * anything else replaces it. The tool permissions the user chose are kept.
   */
  update?: boolean
  /**
   * The user's own OAuth app: client id (public) and, for a confidential client, the secret. The secret goes to the OS
   * vault (`mcp:<servidor>.oauth_client_secret`), never to settings.json. Required for `oauth-static` entries when the
   * directory has no `oauthClientId`; optional replacement for `oauth` entries (instead of dynamic registration).
   * Once saved it is reused by later connects, so it does not have to be sent again.
   */
  oauthClient?: { clientId: string; clientSecret?: string }
  /**
   * Rehearsal of an OAuth login: discovery, client choice (one dynamic registration when no client id is known) and the
   * authorization URL, WITHOUT opening a browser, listening on the callback port, installing anything or storing
   * anything. The report is in `ConnectResult.dryRun`. `minIntervalMs` spaces the requests to the same host.
   */
  dryRun?: boolean | { minIntervalMs?: number }
}

/** One step of an OAuth rehearsal. */
export interface OAuthDryRunStep {
  step: 'discovery' | 'registration' | 'authorize-url'
  ok: boolean
  ms: number
  detail: string
}

export interface OAuthDryRun {
  ok: boolean
  /** The authorization page a real login would open (never opened by the rehearsal). */
  authUrl?: string
  steps: OAuthDryRunStep[]
  error?: string
  hint?: string
  /** The return URL carried by the authorization request. */
  redirectUri: string
  /** Where the client id came from: the user's (`user`), the directory's, a throw-away dynamic registration, or none. */
  client: 'user' | 'directory' | 'dynamic' | 'none'
  scope?: string
}

export interface ConnectResult {
  state: ConnectorState
  /** OAuth: the login page that was opened in the browser (shown so the user can open it by hand). */
  authUrl?: string
  /** Present when `input.dryRun` was set: what the rehearsal found. `state` is then the unchanged current state. */
  dryRun?: OAuthDryRun
}

/**
 * Fixed loopback port of the OAuth callback, and the return URL it makes. FIXED on purpose: Slack, Google, GitHub and
 * most providers accept only the exact return URL registered in the OAuth app, so the user registers this URL once. A
 * random port per login (fine for dynamic registration, which registers whatever URL it is given) would break them.
 */
export const MCP_OAUTH_CALLBACK_PORT = 38565
export const MCP_OAUTH_REDIRECT_URI = `http://127.0.0.1:${MCP_OAUTH_CALLBACK_PORT}/callback`

/** IPC channel names (merged into CH in shared/api.ts). */
export const MCP_CONNECTOR_CHANNELS = {
  directory: 'mcpc:directory',
  states: 'mcpc:states',
  connect: 'mcpc:connect',
  disconnect: 'mcpc:disconnect',
  tools: 'mcpc:tools',
  setToolPolicy: 'mcpc:setToolPolicy',
  reload: 'mcpc:reload',
  maskedSettings: 'mcpc:maskedSettings'
} as const
