import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { MCP_OAUTH_CALLBACK_PORT } from '../shared/mcp-connectors.js'
import type { SecretCrypto } from './settings.js'

/**
 * Interactive OAuth 2.1 for remote MCP servers.
 *
 * Implements the flow MCP servers announce in `WWW-Authenticate`:
 * protected-resource metadata -> authorization-server metadata -> dynamic
 * client registration (or a public client id from the connector directory)
 * -> authorization code + PKCE (S256) -> local callback -> token exchange.
 * Tokens are cached per server, refreshed silently (one refresh at a time) and
 * revoked when the server offers a revocation endpoint.
 *
 * A user can always bypass this by putting a static bearer token in the
 * server's headers in Configurações. OAuth is started explicitly (connector
 * connect or the "Entrar com OAuth" button) and silently refreshed afterwards;
 * when an OAuth token exists it takes precedence over a configured
 * Authorization header, so a leftover Basic token cannot block the login.
 * Nothing here logs a token, a code or a client secret.
 *
 * Nothing at module level needs Electron: the browser opener is injected (`openUrl`, by default Electron's
 * `shell.openExternal`, loaded only when a login really opens a page), so a plain Node script can import this module and
 * run `prepareAuthorization` (a dry run that opens nothing) with the very same code the app uses.
 */

interface OAuthRecord {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
  resource?: string
  scope?: string
  /** RFC 7009 endpoint, used when the connector is disconnected. */
  revocationEndpoint?: string
  /** Account the grant belongs to (userinfo / id_token), for display only. */
  account?: string
}

interface AuthServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  userinfo_endpoint?: string
  scopes_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?: string[]
}

interface Discovery extends AuthServerMetadata {
  /** Canonical resource identifier from protected-resource metadata. */
  resource: string
  /** Scopes the resource (or the challenge) announced; empty when nobody did. */
  announced: string[]
}

interface Registration {
  clientId: string
  clientSecret?: string
  tokenEndpointAuthMethod: string
}

/** What a connector knows beyond what the server publishes. */
export interface OAuthStartOptions {
  /** Client id of an OAuth app registered for Openclod (the user's own, or the directory's); beats dynamic registration. */
  clientId?: string
  /**
   * Secret of that app when it is a confidential client. It is sent the way the server's token endpoint asks
   * (`client_secret_post` or `client_secret_basic`); a server that only knows public clients ignores it.
   */
  clientSecret?: string
  /** Scopes to ask when the server does not publish any (space separated). */
  scopes?: string
  /** Preferred loopback port for the callback; another one is used when it is busy. Default: the fixed port of the app. */
  callbackPort?: number
}

/** A login that was started: the page opened in the browser and the promise of its result. */
export interface OAuthSession {
  /** Authorization page (also opened in the browser; shown so the user can open it by hand). */
  authUrl: string
  /** The exact return URL of this login (what an OAuth app has to have registered). */
  redirectUri: string
  /** The preferred port was busy, so `redirectUri` is NOT the fixed one: an app registered with the fixed URL will refuse it. */
  redirectUriFallback: boolean
  /** Access token; null when the user denied, cancelled or the wait timed out. Rejects when the exchange fails. */
  completion: Promise<string | null>
  cancel(): void
}

/** A failure the user can act on, with the fix to show next to it. */
export class OAuthSetupError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** The return URL involved, when the failure is about it (shown so the user can register it). */
    readonly redirectUri?: string
  ) {
    super(message)
    this.name = 'OAuthSetupError'
  }
}

export const NO_DYNAMIC_REGISTRATION_ERROR =
  'este conector não aceita registro dinâmico; use uma chave de API (se houver) ou peça um client id'

/** What to do when the server has no dynamic registration and no client id is known. */
export function noDynamicRegistrationHint(redirectUri: string): string {
  return (
    'O servidor exige um aplicativo OAuth já registrado. Se o serviço oferece chave de API/token, conecte por ela. ' +
    `Caso contrário crie um aplicativo OAuth no serviço, cadastre exatamente esta URL de retorno: ${redirectUri} ` +
    'e informe o client ID (e o segredo, se houver) ao conectar.'
  )
}

/** The server refused our client id or our return URL (the user's app is missing the URL, or the id is wrong). */
export function clientRejected(redirectUri: string, detail?: string): OAuthSetupError {
  return new OAuthSetupError(
    `client id inválido ou URL de retorno não cadastrada: cadastre exatamente ${redirectUri}`,
    `No aplicativo OAuth do serviço, cadastre exatamente esta URL de retorno: ${redirectUri} ` +
      '(http, 127.0.0.1, a porta e /callback, sem nada a mais) e confira o client ID e o segredo informados.' +
      (detail ? ` Resposta do servidor: ${detail.slice(0, 200)}` : ''),
    redirectUri
  )
}

const CLIENT_REJECTED_CODES = /^(?:invalid_client|unauthorized_client|redirect_uri_mismatch|invalid_redirect_uri)$/i
const MENTIONS_REDIRECT = /redirect[_\s-]?uri|callback url|return url/i

/** Whether an OAuth error (code + description) means "the client id or the return URL is not what the app registered". */
function isClientRejection(error: string | undefined, description: string | undefined): boolean {
  return Boolean((error && CLIENT_REJECTED_CODES.test(error)) || (description && MENTIONS_REDIRECT.test(description)))
}

const FLOW_TIMEOUT_MS = 300_000
const REFRESH_SKEW_MS = 30_000

export interface McpOAuthOptions {
  /** How long the consent screen may stay open (default 5 minutes). */
  flowTimeoutMs?: number
  /**
   * Opens the authorization page in the user's browser. Default: Electron's `shell.openExternal`, loaded on demand.
   * A script outside Electron passes its own (or never opens anything: `prepareAuthorization` does not need it).
   */
  openUrl?: (url: string) => Promise<unknown> | unknown
  /** Preferred loopback port of the callback (default: the fixed port of the app, see MCP_OAUTH_CALLBACK_PORT). */
  callbackPort?: number
  /** HTTP client for discovery and registration (default: global fetch). */
  fetch?: typeof fetch
}

/** Options of the dry run: `prepareAuthorization`. */
export interface OAuthPrepareOptions extends OAuthStartOptions {
  /** The 401 challenge (`WWW-Authenticate`) the server sent, when known. */
  challenge?: string
  /** Minimum time between two requests to the same host (a polite scan of many servers). Default 0. */
  minIntervalMs?: number
  /** Deadline of the dynamic registration request (default 8 s; a real login allows 15 s). */
  registrationTimeoutMs?: number
}

export interface OAuthPrepareStep {
  step: 'discovery' | 'registration' | 'authorize-url'
  ok: boolean
  ms: number
  detail: string
}

/** What the dry run found out; never throws, a failure is a step with `ok: false`. */
export interface OAuthPreparation {
  ok: boolean
  server: string
  /** The authorization page that a real login would open (PKCE included); never opened by the dry run. */
  authUrl?: string
  steps: OAuthPrepareStep[]
  error?: string
  hint?: string
  /** The return URL the authorization request carries (the fixed one; nothing listens on it during a dry run). */
  redirectUri: string
  /** Where the client id came from: given (the user's or the directory's) or registered dynamically for this test. */
  client?: 'provided' | 'dynamic'
  scope?: string
}

// Short and plain on purpose: some servers cap client_name (Shippo: 39 characters) and some only take letters, digits,
// hyphens and spaces (Calendly: "may only contain alphanumeric characters, hyphens, and spaces"); a name with
// parentheses or accents made them refuse the registration for that alone.
const DRY_RUN_CLIENT_NAME = 'Openclod Desktop teste'
const CLIENT_NAME = 'Openclod Desktop'

/** Electron's opener, loaded only when a page really has to be opened (never at import time). */
async function electronOpen(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

/** `fetch` that keeps at least `minIntervalMs` between two requests to the same host. */
function politeFetch(base: typeof fetch, minIntervalMs: number): typeof fetch {
  if (!(minIntervalMs > 0)) return base
  const last = new Map<string, number>()
  const turn = new Map<string, Promise<void>>()
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host
    const previous = turn.get(host) ?? Promise.resolve()
    const mine = previous.then(async () => {
      const wait = (last.get(host) ?? 0) + minIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      last.set(host, Date.now())
    })
    turn.set(host, mine)
    await mine
    return base(input, init)
  }) as typeof fetch
}

export class McpOAuthManager {
  private records = new Map<string, OAuthRecord>()
  private loaded = false
  private readonly file: string
  private readonly flowTimeoutMs: number
  private readonly openUrl: (url: string) => Promise<unknown> | unknown
  private readonly callbackPort: number
  private readonly http: typeof fetch
  /** One refresh at a time per server: a burst of 401s must not burn the refresh token twice. */
  private refreshing = new Map<string, Promise<string | null>>()
  /** Login screens waiting for the user, per server (a new login replaces the previous one). */
  private flows = new Map<string, () => void>()

  constructor(
    private readonly dataDir: string,
    private readonly crypto?: SecretCrypto,
    options: McpOAuthOptions = {}
  ) {
    this.file = path.join(dataDir, 'mcp-oauth.json')
    this.flowTimeoutMs = options.flowTimeoutMs ?? FLOW_TIMEOUT_MS
    this.openUrl = options.openUrl ?? electronOpen
    this.callbackPort = options.callbackPort ?? MCP_OAUTH_CALLBACK_PORT
    this.http = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /**
   * The return URL every login prefers: `http://127.0.0.1:<fixed port>/callback`. The port is FIXED on purpose: Slack,
   * Google, GitHub and most providers only accept the exact return URL registered in the OAuth app, so a random port
   * per login (what dynamic registration tolerates) would make a registered app unusable. Another port is used only
   * when this one is busy, and then the session says so (`redirectUriFallback`).
   */
  get preferredRedirectUri(): string {
    return `http://127.0.0.1:${this.callbackPort}/callback`
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.file)
      let text = raw.toString('utf8')
      if (this.crypto?.isEncryptionAvailable()) {
        try {
          text = this.crypto.decryptString(raw)
        } catch {
          // Older builds wrote plain JSON; keep reading it and re-encrypt on save.
        }
      }
      const parsed = JSON.parse(text) as Record<string, OAuthRecord>
      for (const [name, record] of Object.entries(parsed)) if (record?.accessToken) this.records.set(name, record)
    } catch {
      /* first run */
    }
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const text = `${JSON.stringify(Object.fromEntries(this.records.entries()), null, 2)}\n`
    const data = this.crypto?.isEncryptionAvailable() ? this.crypto.encryptString(text) : Buffer.from(text, 'utf8')
    fs.writeFileSync(`${this.file}.tmp`, data, { mode: 0o600 })
    fs.renameSync(`${this.file}.tmp`, this.file)
  }

  private static usable(record: OAuthRecord): boolean {
    return !record.expiresAt || record.expiresAt - REFRESH_SKEW_MS > Date.now()
  }

  /** Returns a valid access token, refreshing or starting the browser flow. */
  async authorize(
    serverName: string,
    resourceUrl: string,
    challenge?: string,
    options?: OAuthStartOptions
  ): Promise<string | null> {
    this.load()
    const current = this.records.get(serverName)
    if (current && McpOAuthManager.usable(current)) return current.accessToken
    if (current?.refreshToken) {
      const refreshed = await this.refresh(serverName, current).catch(() => null)
      if (refreshed) return refreshed
    }
    return (await this.begin(serverName, resourceUrl, challenge, options)).completion
  }

  /**
   * Starts the browser login and returns as soon as the page is open (`authUrl`), without waiting for the user.
   * The stored grant is replaced only when the new login succeeds, so cancelling keeps the previous one.
   */
  async begin(
    serverName: string,
    resourceUrl: string,
    challenge?: string,
    options: OAuthStartOptions = {}
  ): Promise<OAuthSession> {
    this.load()
    this.flows.get(serverName)?.() // a second login for the same server replaces the first
    const discovered = await this.discover(resourceUrl, challenge, options)
    return this.startFlow(serverName, discovered, options)
  }

  /**
   * Dry run of `begin`: discovery, the client choice (a dynamic registration only when nobody brought a client id: ONE
   * attempt, short deadline, under a client name that says it is a connectivity test) and the authorization URL with
   * PKCE. It opens no browser, listens on no port and stores nothing (a registered client id is thrown away), so it can
   * be pointed at hundreds of servers. It never throws: every failure is a step with `ok: false`.
   */
  async prepareAuthorization(serverName: string, resourceUrl: string, options: OAuthPrepareOptions = {}): Promise<OAuthPreparation> {
    const http = politeFetch(this.http, options.minIntervalMs ?? 0)
    const redirectUri = this.preferredRedirectUri
    const steps: OAuthPrepareStep[] = []
    const report: OAuthPreparation = { ok: false, server: serverName, steps, redirectUri }
    const run = async <T>(step: OAuthPrepareStep['step'], work: () => Promise<{ value: T; detail: string }>): Promise<T | null> => {
      const started = Date.now()
      try {
        const { value, detail } = await work()
        steps.push({ step, ok: true, ms: Date.now() - started, detail })
        return value
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        steps.push({ step, ok: false, ms: Date.now() - started, detail: message })
        report.error = message
        if (err instanceof OAuthSetupError && err.hint) report.hint = err.hint
        return null
      }
    }

    try {
      new URL(resourceUrl)
    } catch {
      steps.push({ step: 'discovery', ok: false, ms: 0, detail: 'URL do conector inválida' })
      report.error = 'URL do conector inválida'
      return report
    }
    const metadata = await run('discovery', async () => {
      if (!isSecure(resourceUrl)) throw new OAuthSetupError('a URL do conector não usa HTTPS')
      const found = await this.discover(resourceUrl, options.challenge, options, http)
      assertSecureEndpoints(found)
      const pkce = found.code_challenge_methods_supported?.includes('S256') ? 'PKCE S256 anunciado' : 'PKCE S256 não anunciado'
      const shown = found.announced.slice(0, 6).join(' ')
      const scopes = found.announced.length ? `${shown}${found.announced.length > 6 ? ` (+${found.announced.length - 6})` : ''}` : '(nenhum anunciado)'
      return {
        value: found,
        detail: `servidor de autorização em ${new URL(found.authorization_endpoint).host}; ${pkce}; registro dinâmico: ${found.registration_endpoint ? 'sim' : 'não'}; escopos: ${scopes}`
      }
    })
    if (!metadata) return report
    report.scope = metadata.announced.join(' ') || undefined

    const chosen = await run('registration', async () => {
      const picked = await chooseClient(metadata, options, redirectUri, http, {
        clientName: DRY_RUN_CLIENT_NAME,
        timeoutMs: options.registrationTimeoutMs ?? 8_000
      })
      const host = metadata.registration_endpoint ? new URL(metadata.registration_endpoint).host : ''
      return {
        value: picked,
        detail:
          picked.source === 'provided'
            ? `client id informado${picked.client.clientSecret ? ' (com segredo)' : ''}; registro dinâmico dispensado`
            : `cliente registrado dinamicamente em ${host} (descartado: nada é guardado)${picked.redirectUri !== redirectUri ? `; ${new URL(redirectUri).hostname} foi recusado como URL de retorno, registrado com ${picked.redirectUri}` : ''}`
      }
    })
    if (!chosen) return report
    report.client = chosen.source
    report.redirectUri = chosen.redirectUri

    const authUrl = await run('authorize-url', async () => {
      const verifier = base64url(crypto.randomBytes(48))
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
      const built = buildAuthorizationUrl(metadata, chosen.client.clientId, chosen.redirectUri, challenge, base64url(crypto.randomBytes(24)), report.scope)
      const target = new URL(built)
      return { value: built, detail: `${target.origin}${target.pathname} com PKCE S256 e resource ${metadata.resource}` }
    })
    if (!authUrl) return report
    report.authUrl = authUrl
    report.ok = true
    return report
  }

  async logout(serverName: string): Promise<void> {
    this.load()
    this.cancel(serverName)
    this.records.delete(serverName)
    this.save()
  }

  /** Abandons the login screen of this server, if one is waiting. */
  cancel(serverName: string): void {
    this.flows.get(serverName)?.()
  }

  /**
   * Disconnect: revokes the token at the server when it offers a revocation endpoint (RFC 7009, best effort),
   * then forgets the grant locally. The local grant is removed even when revocation is unavailable or fails.
   */
  async revoke(serverName: string): Promise<{ revoked: boolean; supported: boolean; detail?: string }> {
    this.load()
    this.cancel(serverName)
    const record = this.records.get(serverName)
    this.records.delete(serverName)
    this.save()
    if (!record) return { revoked: false, supported: false }
    if (!record.revocationEndpoint || !isSecure(record.revocationEndpoint)) return { revoked: false, supported: false }
    const targets: Array<[string, string]> = []
    if (record.refreshToken) targets.push([record.refreshToken, 'refresh_token'])
    targets.push([record.accessToken, 'access_token'])
    let revoked = false
    let detail: string | undefined
    for (const [token, hint] of targets) {
      try {
        const body = new URLSearchParams({ token, token_type_hint: hint, client_id: record.clientId })
        const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
        applyClientAuth(headers, body, record.clientId, record.clientSecret, record.tokenEndpointAuthMethod)
        const response = await fetch(record.revocationEndpoint, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000)
        })
        if (response.ok) revoked = true
        else detail = `o servidor respondeu ${response.status} à revogação`
      } catch (err) {
        detail = `revogação indisponível: ${(err as Error).message}`
      }
    }
    return { revoked, supported: true, detail: revoked ? undefined : detail }
  }

  /**
   * Explicit "Entrar com OAuth": run the browser flow again, so a token with missing scopes or a changed account
   * can be replaced. If the user cancels, the previous grant stays.
   */
  async reauthorize(
    serverName: string,
    resourceUrl: string,
    challenge?: string,
    options?: OAuthStartOptions
  ): Promise<string | null> {
    return (await this.begin(serverName, resourceUrl, challenge, options)).completion
  }

  status(serverName?: string): { total: number; connected: number; expiresAt?: number; account?: string } {
    this.load()
    const records = serverName
      ? [this.records.get(serverName)].filter((record): record is OAuthRecord => Boolean(record))
      : [...this.records.values()]
    const connected = records.filter((record) => McpOAuthManager.usable(record) || record.refreshToken)
    return {
      total: records.length,
      connected: connected.length,
      expiresAt: serverName ? records[0]?.expiresAt : undefined,
      account: serverName ? records[0]?.account : undefined
    }
  }

  /** A token usable right now, refreshing it when needed; never opens a browser. */
  async token(serverName: string): Promise<string | null> {
    this.load()
    const record = this.records.get(serverName)
    if (!record) return null
    if (McpOAuthManager.usable(record)) return record.accessToken
    if (record.refreshToken) return this.refresh(serverName, record).catch(() => null)
    return null
  }

  private refresh(serverName: string, record: OAuthRecord): Promise<string | null> {
    const running = this.refreshing.get(serverName)
    if (running) return running
    const run = this.doRefresh(serverName, record).finally(() => this.refreshing.delete(serverName))
    this.refreshing.set(serverName, run)
    return run
  }

  private async doRefresh(serverName: string, stale: OAuthRecord): Promise<string | null> {
    // A refresh that just finished may already have renewed it.
    const record = this.records.get(serverName) ?? stale
    if (McpOAuthManager.usable(record)) return record.accessToken
    if (!record.refreshToken || !isSecure(record.tokenEndpoint)) return null
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      client_id: record.clientId,
      ...(record.resource ? { resource: record.resource } : {}),
      ...(record.scope ? { scope: record.scope } : {})
    })
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    }
    applyClientAuth(headers, body, record.clientId, record.clientSecret, record.tokenEndpointAuthMethod)
    const response = await fetch(record.tokenEndpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(20_000)
    })
    const token = (await response.json().catch(() => ({}))) as TokenResponse
    if (!response.ok) {
      // The grant is dead (revoked, expired, rotated elsewhere): drop it so the connector asks for a new login.
      if (token.error === 'invalid_grant' || token.error === 'invalid_client') {
        this.records.delete(serverName)
        this.save()
      }
      return null
    }
    if (!token.access_token) return null
    const next: OAuthRecord = {
      ...record,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? record.refreshToken,
      expiresAt: expiryOf(token.expires_in),
      scope: token.scope ?? record.scope
    }
    this.records.set(serverName, next)
    this.save()
    return next.accessToken
  }

  /**
   * The `WWW-Authenticate` a server sends to a request without credentials (an `initialize` POST, then the legacy SSE GET
   * for a server whose POST is 404/405/400). Nothing is stored and the answer's body is dropped; undefined when the
   * server sends no challenge or cannot be reached.
   */
  private async probeChallenge(resourceUrl: string, http: typeof fetch): Promise<string | undefined> {
    if (!isSecure(resourceUrl)) return undefined
    const requests: Array<RequestInit> = [
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openclod', version: '0.1.0' } }
        })
      },
      { method: 'GET', headers: { accept: 'text/event-stream' } }
    ]
    for (const [index, init] of requests.entries()) {
      try {
        const response = await http(resourceUrl, { ...init, signal: AbortSignal.timeout(8_000) })
        await response.body?.cancel().catch(() => undefined)
        const header = response.headers.get('www-authenticate')
        if (header) return header
        // Only a POST the server does not take (404/405/400) is worth repeating as the old SSE transport's GET.
        if (index === 0 && ![400, 404, 405].includes(response.status)) return undefined
      } catch {
        return undefined
      }
    }
    return undefined
  }

  private async discover(
    resourceUrl: string,
    challenge: string | undefined,
    options: OAuthStartOptions,
    http: typeof fetch = this.http
  ): Promise<Discovery> {
    const resource = new URL(resourceUrl)
    const origin = resource.origin
    const path = resource.pathname.replace(/\/+$/, '')
    const fromChallenge = resourceMetadataOf(challenge)
    const candidates = unique(
      [
        fromChallenge,
        // RFC 9728: the well-known segment is inserted before the resource path; the root form is the fallback.
        path ? `${origin}/.well-known/oauth-protected-resource${path}` : undefined,
        `${origin}/.well-known/oauth-protected-resource`
      ].filter((value): value is string => Boolean(value))
    )

    let challengeScopes = scopesOf(challenge)
    const configured = (options.scopes ?? '').split(/\s+/).filter(Boolean)

    /** Finds the authorization server's metadata for one protected-resource document (or for the bare origin). */
    const attempt = async (known: { authServers: string[]; resource: string; scopes: string[] }): Promise<Discovery | null> => {
      for (const issuer of known.authServers) {
        for (const url of authServerMetadataUrls(issuer)) {
          if (!isSecure(url)) continue
          try {
            const response = await http(url, { signal: AbortSignal.timeout(8_000) })
            if (!response.ok) continue
            const metadata = (await response.json()) as AuthServerMetadata
            if (!metadata.authorization_endpoint || !metadata.token_endpoint) continue
            const advertised = metadata.code_challenge_methods_supported
            if (Array.isArray(advertised) && advertised.length && !advertised.includes('S256')) {
              throw new OAuthSetupError('o servidor OAuth não aceita PKCE S256, que o Openclod exige')
            }
            // Announced scopes win (the 401 challenge narrows them); then the connector's own; the server-wide list is the last resort.
            const announced = challengeScopes.length ? challengeScopes : known.scopes
            let scopes = announced.length ? announced : configured.length ? configured : metadata.scopes_supported ?? []
            const offersOffline = [...(metadata.scopes_supported ?? []), ...known.scopes].includes('offline_access')
            if (offersOffline && !scopes.includes('offline_access')) scopes = [...scopes, 'offline_access']
            return { ...metadata, resource: known.resource, announced: unique(scopes) }
          } catch (err) {
            if (err instanceof OAuthSetupError) throw err
            /* try the next well-known document */
          }
        }
      }
      return null
    }

    /** One protected-resource document (RFC 9728) and, through it, the authorization server's metadata. */
    const viaDocument = async (url: string): Promise<Discovery | null> => {
      if (!isSecure(url)) return null
      let document: { authorization_servers?: string[]; resource?: string; scopes_supported?: string[] }
      try {
        const response = await http(url, { signal: AbortSignal.timeout(8_000) })
        if (!response.ok) return null
        document = (await response.json()) as typeof document
      } catch {
        return null
      }
      if (!document.authorization_servers?.length) return null
      return attempt({
        authServers: document.authorization_servers,
        resource: document.resource ?? resourceUrl,
        scopes: document.scopes_supported ?? []
      })
    }

    // A server can publish several protected-resource documents (Mercado Pago: one per path with its own issuer and
    // registration endpoint, and a generic one at the root that points to a registration endpoint that refuses us).
    // They are tried in specificity order and the first one whose authorization server answers wins.
    for (const url of candidates) {
      const found = await viaDocument(url)
      if (found) return found
    }
    // The RFC's well-known paths found nothing. A gateway in front of the MCP host, or a server that mounts its metadata
    // elsewhere, says where it is only in the 401 of an unauthenticated request (Bill, Guidepoint, Haloo, iSolved, Morning
    // Consult, American Express...), and the first connection of a connector has no 401 yet: ask for it, like the client does.
    if (!fromChallenge) {
      const announced = await this.probeChallenge(resourceUrl, http)
      const url = resourceMetadataOf(announced)
      const probedScopes = scopesOf(announced)
      if (probedScopes.length && !challengeScopes.length) challengeScopes = probedScopes
      if (url && !candidates.includes(url)) {
        const found = await viaDocument(url)
        if (found) return found
      }
    }
    // No usable protected-resource metadata: the server may be its own authorization server.
    const direct = await attempt({ authServers: [origin], resource: resourceUrl, scopes: [] })
    if (direct) return direct
    throw new OAuthSetupError(
      'servidor MCP não publicou metadados OAuth',
      'Confira a URL do conector ou use uma chave de API, se o serviço oferecer.'
    )
  }

  private async startFlow(serverName: string, metadata: Discovery, options: OAuthStartOptions): Promise<OAuthSession> {
    assertSecureEndpoints(metadata)
    const callback = await openCallback(options.callbackPort ?? this.callbackPort)
    try {
      const verifier = base64url(crypto.randomBytes(48))
      const codeChallenge = base64url(crypto.createHash('sha256').update(verifier).digest())
      const state = base64url(crypto.randomBytes(24))
      const scope = metadata.announced.length ? metadata.announced.join(' ') : undefined

      // A client id the connector brings (the user's own OAuth app, or the directory's) beats dynamic registration.
      const { client: registration, redirectUri } = await chooseClient(metadata, options, callback.redirectUri, this.http, {
        clientName: CLIENT_NAME,
        timeoutMs: 15_000
      })
      const staticClient = Boolean(options.clientId)
      // `redirectUri` is the callback URL unless the server refused 127.0.0.1 at registration and took localhost instead
      // (the same listener answers both): the authorization request and the token exchange must repeat what was registered.
      const authUrl = buildAuthorizationUrl(metadata, registration.clientId, redirectUri, codeChallenge, state, scope)

      const waiting = callback.wait(state, this.flowTimeoutMs)
      const cancel = (): void => callback.cancel()
      this.flows.set(serverName, cancel)
      const forget = (): void => {
        if (this.flows.get(serverName) === cancel) this.flows.delete(serverName)
      }
      // No default browser must not abort the login: the page is returned so the user can open it by hand.
      await Promise.resolve(this.openUrl(authUrl)).catch(() => undefined)

      const completion = (async (): Promise<string | null> => {
        try {
          const result = await waiting
          if (!result) return null
          if (result.error) {
            if (result.error === 'access_denied') return null
            // The provider sent the user back saying our client or return URL is not what the app registered.
            if (staticClient && isClientRejection(result.error, result.error_description)) {
              throw clientRejected(callback.redirectUri, result.error_description ?? result.error)
            }
            throw new OAuthSetupError(`o provedor recusou o login: ${result.error_description ?? result.error}`)
          }
          return await this.exchange(serverName, metadata, registration, redirectUri, verifier, result.code!, scope, staticClient)
        } finally {
          forget()
        }
      })()
      // The caller may abandon the session (UI closed); a rejection must not become an unhandled one.
      completion.catch(() => undefined)
      return { authUrl, redirectUri, redirectUriFallback: callback.fallback, completion, cancel }
    } catch (err) {
      callback.cancel()
      throw err
    }
  }

  private async exchange(
    serverName: string,
    metadata: Discovery,
    registration: Registration,
    redirectUri: string,
    verifier: string,
    code: string,
    requestedScope: string | undefined,
    staticClient: boolean
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: registration.clientId,
      code_verifier: verifier,
      resource: metadata.resource
    })
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    }
    applyClientAuth(headers, body, registration.clientId, registration.clientSecret, registration.tokenEndpointAuthMethod)
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(20_000)
    })
    const token = (await response.json().catch(() => ({}))) as TokenResponse
    if (!response.ok || !token.access_token) {
      if (staticClient && isClientRejection(token.error, token.error_description)) {
        throw clientRejected(redirectUri, token.error_description ?? token.error)
      }
      throw new OAuthSetupError(`troca do código OAuth falhou: ${token.error_description ?? token.error ?? response.status}`)
    }
    const record: OAuthRecord = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiryOf(token.expires_in),
      tokenEndpoint: metadata.token_endpoint,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
      resource: metadata.resource,
      scope: token.scope ?? requestedScope,
      revocationEndpoint: metadata.revocation_endpoint,
      account: await fetchAccount(metadata.userinfo_endpoint, token.access_token, token.id_token)
    }
    this.records.set(serverName, record)
    this.save()
    return record.accessToken
  }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
  error_description?: string
}

function expiryOf(expiresIn: number | string | undefined): number | undefined {
  const seconds = Number(expiresIn)
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1_000 : undefined
}

/** Client authentication of the token/revocation endpoints (none = public client). */
function applyClientAuth(
  headers: Record<string, string>,
  body: URLSearchParams,
  clientId: string,
  clientSecret: string | undefined,
  method: string | undefined
): void {
  if (!clientSecret) return
  if (method === 'client_secret_post') body.set('client_secret', clientSecret)
  if (method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }
}

/**
 * `resource_metadata` of a `WWW-Authenticate` challenge (RFC 9728 §5.1). Quoted, as the RFC writes it, or bare, as some
 * gateways send it (`Bearer resource_metadata=https://host/.well-known/...`).
 */
export function resourceMetadataOf(challenge: string | undefined): string | undefined {
  const match = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,;"]+))/i.exec(challenge ?? '')
  return match?.[1] ?? match?.[2]
}

/** `scope` of a `WWW-Authenticate` challenge, quoted or bare. */
export function scopesOf(challenge: string | undefined): string[] {
  const match = /(?:^|[,\s])scope\s*=\s*(?:"([^"]+)"|([^\s,;"]+))/i.exec(challenge ?? '')
  return (match?.[1] ?? match?.[2] ?? '').split(/\s+/).filter(Boolean)
}

/**
 * Where the authorization server's metadata may live for an issuer. An issuer with a path has two spellings:
 * RFC 8414 inserts the well-known segment before the path, and some servers (Atlassian) append it after.
 * OpenID Connect discovery is tried for both as well.
 */
export function authServerMetadataUrls(issuer: string): string[] {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    return []
  }
  const origin = url.origin
  const issuerPath = url.pathname.replace(/\/+$/, '')
  const base = `${origin}${issuerPath}`
  const list: string[] = []
  if (issuerPath) list.push(`${origin}/.well-known/oauth-authorization-server${issuerPath}`)
  list.push(`${base}/.well-known/oauth-authorization-server`)
  if (issuerPath) list.push(`${origin}/.well-known/openid-configuration${issuerPath}`)
  list.push(`${base}/.well-known/openid-configuration`)
  return unique(list)
}

function assertSecureEndpoints(metadata: AuthServerMetadata): void {
  if (!isSecure(metadata.authorization_endpoint) || !isSecure(metadata.token_endpoint)) {
    throw new OAuthSetupError('o authorization server anunciou endpoints sem HTTPS')
  }
  if (metadata.registration_endpoint && !isSecure(metadata.registration_endpoint)) {
    throw new OAuthSetupError('o registro dinâmico anunciou um endpoint sem HTTPS')
  }
}

/**
 * Which client the login uses: the one somebody brought (a user's own OAuth app, the directory's) or, when there is
 * none, a dynamically registered one. With no client id and no registration endpoint the login cannot start.
 */
async function chooseClient(
  metadata: Discovery,
  options: OAuthStartOptions,
  redirectUri: string,
  http: typeof fetch,
  registration: { clientName: string; timeoutMs: number }
): Promise<{ client: Registration; source: 'provided' | 'dynamic'; redirectUri: string }> {
  if (options.clientId) {
    const secret = options.clientSecret?.trim() || undefined
    // How a confidential client authenticates at the token endpoint: what the server lists, post first (the broadest);
    // a server that only lists public clients ('none') gets no secret.
    const methods = metadata.token_endpoint_auth_methods_supported ?? []
    let method = 'none'
    if (secret) {
      method =
        methods.length === 0 || methods.includes('client_secret_post')
          ? 'client_secret_post'
          : methods.includes('client_secret_basic')
            ? 'client_secret_basic'
            : 'none'
    }
    return {
      client: { clientId: options.clientId, clientSecret: method === 'none' ? undefined : secret, tokenEndpointAuthMethod: method },
      source: 'provided',
      redirectUri
    }
  }
  if (metadata.registration_endpoint) {
    const refusals: string[] = []
    // Dynamic registration registers whatever return URL it is given (the contract's fixed URL matters to the user's own
    // OAuth apps, not here). Many servers accept `http://localhost:<port>` and refuse the literal `http://127.0.0.1:<port>`
    // (CoinDesk: "http allowed only for localhost"; DevRev, Caisey, Eedi, eToro, Pitchbook, Tango...): the same listener
    // answers both, so a refused 127.0.0.1 is tried again once as localhost.
    for (const uri of [redirectUri, ...loopbackAlternatives(redirectUri)]) {
      try {
        const client = await registerClient(http, metadata.registration_endpoint, uri, metadata.token_endpoint_auth_methods_supported, registration)
        return { client, source: 'dynamic', redirectUri: uri }
      } catch (err) {
        refusals.push(uri === redirectUri ? (err as Error).message : `com ${new URL(uri).hostname}: ${(err as Error).message}`)
        if (!(err instanceof RegistrationRefused) || !err.aboutReturnUrl) break
      }
    }
    throw new OAuthSetupError(`${NO_DYNAMIC_REGISTRATION_ERROR} (${refusals.join('; ')})`, noDynamicRegistrationHint(redirectUri), redirectUri)
  }
  throw new OAuthSetupError(NO_DYNAMIC_REGISTRATION_ERROR, noDynamicRegistrationHint(redirectUri), redirectUri)
}

/** `http://127.0.0.1:<port>/callback` also spelled with `localhost`; nothing else has an alternative. */
function loopbackAlternatives(redirectUri: string): string[] {
  try {
    const url = new URL(redirectUri)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return []
    url.hostname = 'localhost'
    return [url.toString()]
  } catch {
    return []
  }
}

/** A 400/422 whose text blames a field other than the return URL, or a policy; another spelling of the URL fixes none of these. */
const NOT_THE_RETURN_URL = /client[_ ]name|\bname\b|scope|grant|response_type|auth[_ ]method|software|jwks|logo|contacts|policy_uri|tos_uri|vendor|approved|disabled|limit/i

/**
 * A registration endpoint's refusal. `aboutReturnUrl`: a 400/422 that blames the return URL (`invalid_redirect_uri`,
 * "redirect_uri not allowed", "http allowed only for localhost", "UnsupportedRedirectError") or says nothing specific
 * ("Invalid client registration data" from Jasper, "Unable to register client" from Strava, whose only fault was the literal
 * 127.0.0.1): the only refusals another spelling of the same URL can fix. A 403, a 404, a 5xx, or a 400 that blames
 * another field (Mercado Pago: "MCP name not found", Calendly: client_name) is not.
 */
class RegistrationRefused extends Error {
  readonly aboutReturnUrl: boolean

  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RegistrationRefused'
    this.aboutReturnUrl =
      (status === 400 || status === 422) &&
      (/redirect|loopback|localhost|127\.0\.0\.1|allowed (?:host|domain)/i.test(message) || !NOT_THE_RETURN_URL.test(message))
  }
}

function buildAuthorizationUrl(
  metadata: Discovery,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  scope: string | undefined
): string {
  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('resource', metadata.resource)
  if (scope) url.searchParams.set('scope', scope)
  return url.toString()
}

async function registerClient(
  http: typeof fetch,
  registrationEndpoint: string,
  redirectUri: string,
  methods: string[] | undefined,
  options: { clientName: string; timeoutMs: number }
): Promise<Registration> {
  if (!isSecure(registrationEndpoint)) throw new Error('registro OAuth exige HTTPS')
  const supported = methods ?? []
  const method = supported.includes('none')
    ? 'none'
    : supported.includes('client_secret_post')
      ? 'client_secret_post'
      : supported.includes('client_secret_basic')
        ? 'client_secret_basic'
        : 'none'
  const response = await http(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: options.clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method
    }),
    signal: AbortSignal.timeout(options.timeoutMs)
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new RegistrationRefused(describeRegistration(response.status, text), response.status)
  let body: { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string } = {}
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    /* handled below */
  }
  // Some servers refuse with HTTP 200 and an error body (Cloze: {"error":"unapproved_software_statement", ...}).
  if (!body?.client_id) throw new Error(`registro OAuth sem client_id${describeRegistration(200, text).slice('registro OAuth 200'.length)}`)
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    tokenEndpointAuthMethod: body.token_endpoint_auth_method ?? method
  }
}

/**
 * Why a registration endpoint refused us: the status, the RFC 7591 error code, and what the server says about it
 * (`error_description`; for an answer that is not JSON, a short piece of the text, or "página HTML" when a WAF/CDN answered
 * instead of the server). Read defensively: the body can be anything.
 */
export async function registrationFailure(response: Response): Promise<string> {
  return describeRegistration(response.status, await response.text().catch(() => ''))
}

function describeRegistration(status: number, text: string): string {
  let code: unknown
  let description: unknown
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown; message?: unknown; errors?: unknown }
    code = parsed?.error
    // RFC 7591 says `error_description`; servers also use `message` or a field-by-field `errors` object (Calendly:
    // {"errors":{"name":["may only contain alphanumeric characters, hyphens, and spaces."]}}).
    description = parsed?.error_description ?? parsed?.message ?? (parsed?.errors !== undefined ? JSON.stringify(parsed.errors) : undefined)
  } catch {
    /* not JSON */
  }
  const known = typeof code === 'string' && /^[a-z_]{3,40}$/.test(code) ? ` (${code})` : ''
  let detail = ''
  if (typeof description === 'string' && description.trim()) detail = description
  else if (!known && text.trim()) detail = /^\s*(?:<!doctype|<html|<head|<\?xml)/i.test(text) ? 'página HTML (provável bloqueio de WAF/CDN)' : text
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160)
  return `registro OAuth ${status}${known}${detail ? `: ${detail}` : ''}`
}

/** Account label from OIDC userinfo or the id_token payload. Optional: never fails the login. */
async function fetchAccount(
  userinfoEndpoint: string | undefined,
  accessToken: string,
  idToken: string | undefined
): Promise<string | undefined> {
  const pick = (claims: Record<string, unknown> | undefined): string | undefined => {
    for (const key of ['email', 'preferred_username', 'username', 'name', 'sub']) {
      const value = claims?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120)
    }
    return undefined
  }
  if (userinfoEndpoint && isSecure(userinfoEndpoint)) {
    try {
      const response = await fetch(userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5_000)
      })
      if (response.ok) {
        const found = pick((await response.json()) as Record<string, unknown>)
        if (found) return found
      }
    } catch {
      /* optional */
    }
  }
  if (idToken) {
    try {
      const payload = idToken.split('.')[1]
      if (payload) return pick(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>)
    } catch {
      /* optional */
    }
  }
  return undefined
}

interface CallbackResult {
  code?: string
  error?: string
  error_description?: string
}

interface CallbackServer {
  redirectUri: string
  /** The preferred port could not be used, so `redirectUri` is not the fixed one. */
  fallback: boolean
  /** Resolves with the result of the request that carries `state`; null on timeout or cancel. */
  wait(state: string, timeoutMs: number): Promise<CallbackResult | null>
  cancel(): void
}

/** Loopback listener for the redirect. The preferred port is tried first; a busy port falls back to any free one. */
async function openCallback(preferredPort?: number): Promise<CallbackServer> {
  let expectedState = ''
  let settle: (value: CallbackResult | null) => void = () => undefined
  let timer: NodeJS.Timeout | undefined
  let done = false
  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    // `connection: close` on every answer: the next login reuses this same fixed port, and a browser that kept this
    // connection alive would send the next callback to a server that is already closed.
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404, { connection: 'close' }).end('not found')
      return
    }
    // Anything that does not carry our state (a stray request, an attacker) is ignored; the wait goes on.
    if (!expectedState || url.searchParams.get('state') !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('state inválido')
      return
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Openclod Desktop</title><body style="font-family:system-ui;background:#111;color:#eee;padding:40px"><h2>${
        error || !code ? 'Login não concluído' : 'Login concluído'
      }</h2><p>${error ? escapeHtml(error) : 'Pode fechar esta aba e voltar ao Openclod.'}</p><script>setTimeout(()=>window.close(),1200)</script></body>`
    )
    if (error || !code) {
      finish({ error: error ?? 'sem_codigo', error_description: url.searchParams.get('error_description') ?? undefined })
      return
    }
    finish({ code })
  }
  const server = http.createServer(handler)
  // The same answers on the IPv6 loopback, so a return URL spelled `localhost` (what dynamic registration may have to
  // use, see chooseClient) reaches us whichever address the browser resolves it to.
  const server6 = http.createServer(handler)
  // A socket error after the server is up must not become an uncaught exception.
  server.on('error', () => undefined)
  server6.on('error', () => undefined)
  const finish = (value: CallbackResult | null): void => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    server.close()
    server6.close()
    settle(value)
  }
  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
  let fallback = false
  try {
    if (preferredPort) await listen(preferredPort)
    else await listen(0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Busy (another login, another program) or reserved by the OS (Windows excluded port ranges): use any free port.
    if (!preferredPort || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error
    fallback = true
    await listen(0)
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    server.close()
    throw new Error('sem porta livre para o retorno do login')
  }
  // Best effort: no IPv6 loopback, or the port busy there, only means `localhost` resolves to 127.0.0.1.
  await new Promise<void>((resolve) => {
    server6.once('error', () => resolve())
    server6.listen(port, '::1', () => resolve())
  })
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    fallback,
    wait: (state, timeoutMs) =>
      new Promise((resolve) => {
        if (done) {
          resolve(null)
          return
        }
        expectedState = state
        settle = resolve
        timer = setTimeout(() => finish(null), timeoutMs)
      }),
    cancel: () => finish(null)
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** OAuth metadata and token endpoints must be HTTPS; loopback HTTP is for tests. */
function isSecure(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}
