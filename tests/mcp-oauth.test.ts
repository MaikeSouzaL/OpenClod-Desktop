import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: (...args: unknown[]) => openExternal(...args) }, safeStorage: {} }))

const { McpOAuthManager, OAuthSetupError, authServerMetadataUrls, resourceMetadataOf, scopesOf, registrationFailure } = await import('../src/main/mcp-oauth')
const { MCP_OAUTH_CALLBACK_PORT, MCP_OAUTH_REDIRECT_URI } = await import('../src/shared/mcp-connectors')

let dataDir: string
let server: http.Server
let base: string
let tokenRequests: URLSearchParams[] = []

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-oauth-'))
  tokenRequests = []
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', base)
    const json = (body: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read:jira:agent-interface', 'write:jira:agent-interface', 'offline_access']
      })
    }
    if (url.pathname === '/custom-prm') {
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['prm:scope']
      })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        token_endpoint_auth_methods_supported: ['none']
      })
    }
    if (url.pathname === '/register') {
      return json({
        client_id: 'client-openclod',
        client_secret: 'secret-openclod',
        token_endpoint_auth_method: 'none'
      })
    }
    if (url.pathname === '/token') {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        tokenRequests.push(new URLSearchParams(body))
        json({ access_token: 'access-123', refresh_token: 'refresh-456', expires_in: 3600 })
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  openExternal.mockImplementation(async (raw: string) => {
    const authorization = new URL(raw)
    const redirect = authorization.searchParams.get('redirect_uri')!
    const state = authorization.searchParams.get('state')!
    await fetch(`${redirect}?code=auth-code-1&state=${encodeURIComponent(state)}`)
  })
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dataDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('MCP OAuth', () => {
  it('discovers the provider, registers, completes PKCE and exchanges the token', async () => {
    const manager = new McpOAuthManager(dataDir)
    const token = await manager.authorize('demo', `${base}/mcp`)
    expect(token).toBe('access-123')
    expect(openExternal).toHaveBeenCalledTimes(1)
    const authorization = new URL(openExternal.mock.calls[0][0] as string)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorization.searchParams.get('resource')).toBe(`${base}/mcp`)
    expect(authorization.searchParams.get('scope')).toContain('read:jira:agent-interface')
    expect(authorization.searchParams.get('scope')).toContain('offline_access')
    expect(tokenRequests[0].get('code')).toBe('auth-code-1')
    expect(tokenRequests[0].get('code_verifier')).toBeTruthy()
    expect(tokenRequests[0].get('grant_type')).toBe('authorization_code')
    expect(tokenRequests[0].get('resource')).toBe(`${base}/mcp`)

    // A second call reuses the cached token instead of reopening the browser.
    expect(await manager.authorize('demo', `${base}/mcp`)).toBe('access-123')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('exposes a valid token without opening the browser', async () => {
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${base}/mcp`)
    expect(await manager.token('demo')).toBe('access-123')
    expect(await manager.token('missing')).toBeNull()
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('forces a fresh browser flow when the user asks to reconnect', async () => {
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${base}/mcp`)
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(await manager.reauthorize('demo', `${base}/mcp`)).toBe('access-123')
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('honours the 401 challenge resource_metadata and scope', async () => {
    const manager = new McpOAuthManager(dataDir)
    const challenge = `Bearer resource_metadata="${base}/custom-prm", scope="challenge:read"`
    expect(await manager.authorize('challenge', `${base}/mcp`, challenge)).toBe('access-123')
    const authorization = new URL(openExternal.mock.calls[0][0] as string)
    expect(authorization.searchParams.get('scope')).toBe('challenge:read')
  })

  it('stores the token encrypted when the OS cipher is available', async () => {
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8'),
      decryptString: (data: Buffer) => Buffer.from(data.toString('utf8'), 'base64').toString('utf8')
    }
    const manager = new McpOAuthManager(dataDir, crypto)
    expect(await manager.authorize('demo', `${base}/mcp`)).toBe('access-123')

    const raw = fs.readFileSync(path.join(dataDir, 'mcp-oauth.json'))
    expect(raw.toString('utf8')).not.toContain('access-123')
    expect(raw.toString('utf8')).not.toContain('refresh-456')

    const reloaded = new McpOAuthManager(dataDir, crypto)
    expect(await reloaded.authorize('demo', `${base}/mcp`)).toBe('access-123')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* Full fake OAuth server: issuer paths, DCR, PKCE check, refresh, revocation, no-DCR connectors     */
/* ------------------------------------------------------------------------------------------------ */

type MetadataForm = 'oauth-insertion' | 'oauth-append' | 'oidc-insertion' | 'oidc-append'

interface FakeOptions {
  /** Path of the issuer (`/tenant/v1`); empty means the issuer is the origin. */
  issuerPath?: string
  /** Which well-known spellings answer 200 (the others 404). */
  forms?: MetadataForm[]
  dcr?: boolean
  /** Status of POST /register when dcr is on (200 registers). */
  registerStatus?: number
  revocation?: boolean
  userinfo?: 'ok' | 'error'
  prmScopes?: string[]
  asScopes?: string[]
  /** `expires_in` of the first token (seconds). */
  firstLifetime?: number
  /** `expires_in` of refreshed tokens (seconds). */
  refreshedLifetime?: number
  refreshDelayMs?: number
  refreshFails?: boolean
  /** `token_endpoint_auth_methods_supported` of the authorization server (default: only `none`). */
  authMethods?: string[]
  /** A confidential client: the token endpoint refuses (401 invalid_client) unless this secret is presented. */
  confidential?: { secret: string }
  /**
   * The protected-resource document lives at `path` (not at the RFC's well-known paths, which answer 404) and only the 401
   * of an unauthenticated request to /mcp says where: with a quoted or a `bare` URL, to the POST or (`viaGet`) to the
   * legacy SSE GET, whose POST answers 405.
   */
  announcePrm?: { path: string; bare?: boolean; viaGet?: boolean }
  /** What POST /register answers instead of the default (status `registerStatus`, default 400). */
  registerError?: { body: string; contentType?: string }
  /** POST /register refuses (400 invalid_redirect_uri) a redirect URI whose host is one of these (CoinDesk: only localhost). */
  rejectRedirectHosts?: string[]
  /** ...with a vague 400 that does not say why (Jasper: "Invalid client registration data") instead of invalid_redirect_uri. */
  vagueRefusal?: boolean
}

interface Seen {
  method: string
  path: string
  form: URLSearchParams | null
  json: Record<string, unknown> | null
  headers: http.IncomingHttpHeaders
  /** When the request arrived (ms). */
  at: number
}

interface FakeAuth {
  base: string
  seen: Seen[]
  /** code -> what the authorize step recorded (for the PKCE check at the token endpoint) */
  challenges: Map<string, { challenge: string; clientId: string }>
  tokenCalls(grant: string): Seen[]
  close(): Promise<void>
}

async function startFakeAuth(options: FakeOptions = {}): Promise<FakeAuth> {
  const seen: Seen[] = []
  const challenges = new Map<string, { challenge: string; clientId: string }>()
  const state = { base: '', issued: 0, refreshes: 0 }
  const issuerPath = options.issuerPath ?? ''
  const forms = options.forms ?? ['oauth-insertion']
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', state.base)
        const type = String(request.headers['content-type'] ?? '')
        const form = type.includes('x-www-form-urlencoded') ? new URLSearchParams(raw) : null
        const json = type.includes('json') && raw ? (JSON.parse(raw) as Record<string, unknown>) : null
        seen.push({ method: request.method ?? 'GET', path: url.pathname, form, json, headers: request.headers, at: Date.now() })
        const send = (status: number, body: unknown): void => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(body))
        }
        const issuer = `${state.base}${issuerPath}`
        const metadata = {
          issuer,
          authorization_endpoint: `${state.base}/authorize`,
          token_endpoint: `${state.base}/token`,
          ...(options.dcr ? { registration_endpoint: `${state.base}/register` } : {}),
          ...(options.revocation ? { revocation_endpoint: `${state.base}/revoke` } : {}),
          ...(options.userinfo ? { userinfo_endpoint: `${state.base}/userinfo` } : {}),
          ...(options.asScopes ? { scopes_supported: options.asScopes } : {}),
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: options.authMethods ?? ['none']
        }
        const metadataPaths: Record<MetadataForm, string> = {
          'oauth-insertion': `/.well-known/oauth-authorization-server${issuerPath}`,
          'oauth-append': `${issuerPath}/.well-known/oauth-authorization-server`,
          'oidc-insertion': `/.well-known/openid-configuration${issuerPath}`,
          'oidc-append': `${issuerPath}/.well-known/openid-configuration`
        }
        if (forms.some((form) => metadataPaths[form] === url.pathname)) return send(200, metadata)
        if (options.announcePrm) {
          const announce = options.announcePrm
          if (url.pathname === announce.path) {
            return send(200, { resource: `${state.base}/mcp`, authorization_servers: [issuer], scopes_supported: ['listed:read'] })
          }
          if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
            response.writeHead(404).end()
            return
          }
          if (url.pathname === '/mcp') {
            if ((request.method === 'GET') === Boolean(announce.viaGet)) {
              const target = `${state.base}${announce.path}`
              response.writeHead(401, { 'www-authenticate': `Bearer ${announce.bare ? `resource_metadata=${target}` : `resource_metadata="${target}"`}, scope="announced:read"` })
            } else {
              response.writeHead(405)
            }
            response.end()
            return
          }
        }
        if (url.pathname === '/.well-known/oauth-protected-resource') {
          return send(200, {
            resource: `${state.base}/mcp`,
            authorization_servers: [issuer],
            ...(options.prmScopes ? { scopes_supported: options.prmScopes } : {})
          })
        }
        if (url.pathname === '/register') {
          const requested = (json?.redirect_uris as string[] | undefined)?.[0]
          if (options.dcr && requested && options.rejectRedirectHosts?.includes(new URL(requested).hostname)) {
            if (options.vagueRefusal) return send(400, { statusCode: '400', errors: ['Invalid client registration data'] })
            return send(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be absolute https URIs (http allowed only for localhost)' })
          }
          if (options.dcr && options.registerError) {
            response.writeHead(options.registerStatus ?? 400, { 'content-type': options.registerError.contentType ?? 'application/json' })
            response.end(options.registerError.body)
            return
          }
          if (!options.dcr || (options.registerStatus ?? 200) !== 200) return send(options.registerStatus ?? 404, { error: 'invalid_client_metadata' })
          return send(200, { client_id: 'dcr-client', token_endpoint_auth_method: 'none' })
        }
        if (url.pathname === '/userinfo') {
          if (options.userinfo !== 'ok' || request.headers.authorization !== 'Bearer access-1') return send(500, { error: 'boom' })
          return send(200, { email: 'ana@example.com', sub: 'user-1' })
        }
        if (url.pathname === '/revoke') return send(200, {})
        if (url.pathname === '/token' && form) {
          const grant = form.get('grant_type')
          if (options.confidential) {
            // post: client_secret in the body; basic: Authorization header with id:secret
            const header = String(request.headers.authorization ?? '')
            const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : ''
            const presented = form.get('client_secret') ?? (decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : '')
            if (presented !== options.confidential.secret) return send(401, { error: 'invalid_client', error_description: 'segredo recusado' })
          }
          if (grant === 'authorization_code') {
            const known = challenges.get(form.get('code') ?? '')
            const verifier = form.get('code_verifier') ?? ''
            const hashed = crypto.createHash('sha256').update(verifier).digest('base64url')
            if (!known || known.challenge !== hashed || known.clientId !== form.get('client_id')) {
              return send(400, { error: 'invalid_grant', error_description: 'PKCE ou client não confere' })
            }
            state.issued += 1
            return send(200, {
              access_token: `access-${state.issued}`,
              refresh_token: `refresh-${state.issued}`,
              expires_in: options.firstLifetime ?? 3600,
              scope: form.get('scope') ?? undefined
            })
          }
          if (grant === 'refresh_token') {
            if (options.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs))
            if (options.refreshFails) return send(400, { error: 'invalid_grant' })
            state.issued += 1
            return send(200, {
              access_token: `access-${state.issued}`,
              refresh_token: `refresh-${state.issued}`,
              expires_in: options.refreshedLifetime ?? 3600
            })
          }
        }
        response.writeHead(404).end()
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  state.base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return {
    base: state.base,
    seen,
    challenges,
    tokenCalls: (grant) => seen.filter((entry) => entry.path === '/token' && entry.form?.get('grant_type') === grant),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('MCP OAuth against a full fake authorization server', () => {
  let auth: FakeAuth
  let redirects: string[]
  let wrongStateStatuses: number[]

  /** Plays the browser: records what authorize received and returns to the redirect URI. */
  function browser(
    current: FakeAuth,
    behavior: { error?: string; description?: string; wrongStateFirst?: boolean } = {}
  ): void {
    let counter = 0
    openExternal.mockImplementation(async (raw: string) => {
      const authorization = new URL(raw)
      const redirect = authorization.searchParams.get('redirect_uri')!
      const state = authorization.searchParams.get('state')!
      redirects.push(redirect)
      const code = `code-${++counter}`
      current.challenges.set(code, {
        challenge: authorization.searchParams.get('code_challenge')!,
        clientId: authorization.searchParams.get('client_id')!
      })
      if (behavior.wrongStateFirst) wrongStateStatuses.push((await fetch(`${redirect}?code=${code}&state=forged`)).status)
      const query = behavior.error
        ? `error=${behavior.error}${behavior.description ? `&error_description=${encodeURIComponent(behavior.description)}` : ''}&state=${encodeURIComponent(state)}`
        : `code=${code}&state=${encodeURIComponent(state)}`
      await fetch(`${redirect}?${query}`)
    })
  }

  beforeEach(() => {
    redirects = []
    wrongStateStatuses = []
  })

  afterEach(async () => {
    await auth?.close()
  })

  it('lists both spellings of an issuer with a path, plus OpenID discovery', () => {
    expect(authServerMetadataUrls('https://auth.example.com/tenant/v1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant/v1',
      'https://auth.example.com/tenant/v1/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration/tenant/v1',
      'https://auth.example.com/tenant/v1/.well-known/openid-configuration'
    ])
    expect(authServerMetadataUrls('https://auth.example.com/')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration'
    ])
    expect(authServerMetadataUrls('não é url')).toEqual([])
  })

  it.each<MetadataForm>(['oauth-insertion', 'oauth-append', 'oidc-insertion', 'oidc-append'])(
    'finds the metadata of an issuer with a path (%s) and completes the login with a PKCE-checked exchange',
    async (form) => {
      auth = await startFakeAuth({ issuerPath: '/tenant/v1', forms: [form], dcr: true })
      browser(auth)
      const manager = new McpOAuthManager(dataDir)
      expect(await manager.authorize('demo', `${auth.base}/mcp`)).toBe('access-1')
      // The server verified sha256(code_verifier) === code_challenge and the client id of the registration.
      expect(auth.tokenCalls('authorization_code')).toHaveLength(1)
      expect(auth.seen.filter((entry) => entry.path === '/register')[0].json).toMatchObject({
        client_name: 'Openclod Desktop',
        grant_types: ['authorization_code', 'refresh_token']
      })
    }
  )

  it('asks for the announced scopes plus offline_access, and sends the RFC 8707 resource everywhere', async () => {
    auth = await startFakeAuth({ dcr: true, prmScopes: ['read', 'write'], asScopes: ['read', 'write', 'offline_access'], revocation: true })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`)
    const authorizeUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authorizeUrl.searchParams.get('scope')).toBe('read write offline_access')
    expect(authorizeUrl.searchParams.get('resource')).toBe(`${auth.base}/mcp`)
    expect(auth.tokenCalls('authorization_code')[0].form?.get('resource')).toBe(`${auth.base}/mcp`)
  })

  it('narrows to the 401 challenge scope and still adds offline_access when the server offers it', async () => {
    auth = await startFakeAuth({ dcr: true, asScopes: ['a', 'b', 'offline_access'] })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`, 'Bearer scope="a b"')
    expect(new URL(openExternal.mock.calls[0][0] as string).searchParams.get('scope')).toBe('a b offline_access')
  })

  it('uses the connector scopes only when the server announces none', async () => {
    auth = await startFakeAuth({ dcr: true })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`, undefined, { scopes: 'contacts.read deals.read' })
    expect(new URL(openExternal.mock.calls[0][0] as string).searchParams.get('scope')).toBe('contacts.read deals.read')
  })

  it('refreshes silently, rotates the refresh token and shows the expiry', async () => {
    auth = await startFakeAuth({ dcr: true, firstLifetime: 1, refreshedLifetime: 1 })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    expect(await manager.authorize('demo', `${auth.base}/mcp`)).toBe('access-1')
    // 1 s lifetime is inside the 30 s safety margin: the next use refreshes without opening the browser.
    expect(await manager.token('demo')).toBe('access-2')
    expect(auth.tokenCalls('refresh_token')[0].form?.get('refresh_token')).toBe('refresh-1')
    expect(auth.tokenCalls('refresh_token')[0].form?.get('resource')).toBe(`${auth.base}/mcp`)
    expect(await manager.token('demo')).toBe('access-3')
    expect(auth.tokenCalls('refresh_token')[1].form?.get('refresh_token')).toBe('refresh-2')
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(manager.status('demo').expiresAt).toBeGreaterThan(Date.now())
  })

  it('runs one refresh at a time per server', async () => {
    auth = await startFakeAuth({ dcr: true, firstLifetime: 1, refreshDelayMs: 80 })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`)
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => manager.token('demo')))
    expect(new Set(tokens)).toEqual(new Set(['access-2']))
    expect(auth.tokenCalls('refresh_token')).toHaveLength(1)
  })

  it('drops a grant the server declared dead (invalid_grant) so the connector asks for a new login', async () => {
    auth = await startFakeAuth({ dcr: true, firstLifetime: 1, refreshFails: true })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`)
    expect(await manager.token('demo')).toBeNull()
    expect(manager.status('demo').total).toBe(0)
    expect(await new McpOAuthManager(dataDir).token('demo')).toBeNull()
  })

  it('revokes the token at the server when it offers a revocation endpoint, and forgets the grant', async () => {
    auth = await startFakeAuth({ dcr: true, revocation: true })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`)
    expect(await manager.revoke('demo')).toMatchObject({ revoked: true, supported: true })
    const revoked = auth.seen.filter((entry) => entry.path === '/revoke')
    expect(revoked.map((entry) => entry.form?.get('token_type_hint'))).toEqual(['refresh_token', 'access_token'])
    expect(revoked[0].form?.get('token')).toBe('refresh-1')
    expect(revoked[0].form?.get('client_id')).toBe('dcr-client')
    expect(await manager.token('demo')).toBeNull()
  })

  it('forgets the grant locally even when the server has no revocation endpoint', async () => {
    auth = await startFakeAuth({ dcr: true })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`)
    expect(await manager.revoke('demo')).toMatchObject({ revoked: false, supported: false })
    expect(manager.status('demo').total).toBe(0)
    expect(await manager.revoke('never-connected')).toEqual({ revoked: false, supported: false })
  })

  it('uses the public client id of the connector when the server has no dynamic registration', async () => {
    auth = await startFakeAuth({ dcr: false })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    expect(await manager.authorize('demo', `${auth.base}/mcp`, undefined, { clientId: 'openclod-public' })).toBe('access-1')
    expect(auth.seen.some((entry) => entry.path === '/register')).toBe(false)
    expect(new URL(openExternal.mock.calls[0][0] as string).searchParams.get('client_id')).toBe('openclod-public')
    const exchange = auth.tokenCalls('authorization_code')[0].form!
    expect(exchange.get('client_id')).toBe('openclod-public')
    expect(exchange.has('client_secret')).toBe(false)
    expect(exchange.get('code_verifier')).toBeTruthy()
  })

  it('explains what to do when there is neither dynamic registration nor a client id', async () => {
    auth = await startFakeAuth({ dcr: false })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    const error = await manager.authorize('demo', `${auth.base}/mcp`).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OAuthSetupError)
    expect((error as Error).message).toBe(
      'este conector não aceita registro dinâmico; use uma chave de API (se houver) ou peça um client id'
    )
    const hint = (error as InstanceType<typeof OAuthSetupError>).hint
    expect(hint).toMatch(/client ID/)
    // The hint carries the exact return URL to register.
    const redirectUri = (error as InstanceType<typeof OAuthSetupError>).redirectUri!
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(hint).toContain(redirectUri)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a registration endpoint that refuses us with the same guidance', async () => {
    auth = await startFakeAuth({ dcr: true, registerStatus: 403 })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    const error = (await manager.authorize('demo', `${auth.base}/mcp`).catch((err: unknown) => err)) as InstanceType<typeof OAuthSetupError>
    expect(error.message).toContain('não aceita registro dinâmico')
    expect(error.message).toContain('403')
    expect(error.hint).toBeTruthy()
  })

  it('retries a refused 127.0.0.1 return URL as localhost, logs in through it and exchanges the token with that same URL (CoinDesk, DevRev, Pitchbook...)', async () => {
    auth = await startFakeAuth({ dcr: true, rejectRedirectHosts: ['127.0.0.1'] })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    expect(await manager.authorize('demo', `${auth.base}/mcp`)).toBe('access-1')
    const hosts = auth.seen.filter((entry) => entry.path === '/register').map((entry) => new URL((entry.json!.redirect_uris as string[])[0]).hostname)
    expect(hosts).toEqual(['127.0.0.1', 'localhost'])
    expect(redirects).toHaveLength(1)
    expect(redirects[0]).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    expect(new URL(openExternal.mock.calls[0][0] as string).searchParams.get('redirect_uri')).toBe(redirects[0])
    expect(auth.tokenCalls('authorization_code')[0].form!.get('redirect_uri')).toBe(redirects[0])
  })

  it('also retries as localhost when the 400 does not say why (Jasper: "Invalid client registration data"), but not when it blames another field', async () => {
    auth = await startFakeAuth({ dcr: true, rejectRedirectHosts: ['127.0.0.1'], vagueRefusal: true })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    expect(await manager.authorize('demo', `${auth.base}/mcp`)).toBe('access-1')
    expect(redirects[0]).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    await auth.close()
    for (const reason of ['client_name must be at most 39 characters', 'dynamic client registration is disabled', 'scope not allowed']) {
      auth = await startFakeAuth({ dcr: true, registerStatus: 400, registerError: { body: JSON.stringify({ error: 'invalid_client_metadata', error_description: reason }) } })
      await manager.authorize(`other-${reason.length}`, `${auth.base}/mcp`).catch(() => undefined)
      expect(auth.seen.filter((entry) => entry.path === '/register')).toHaveLength(1)
      await auth.close()
    }
    auth = await startFakeAuth({ dcr: false })
  })

  it('does not retry as localhost for a refusal that is not about the return URL, and lists both refusals when localhost fails too', async () => {
    auth = await startFakeAuth({ dcr: true, registerStatus: 403 })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`).catch(() => undefined)
    expect(auth.seen.filter((entry) => entry.path === '/register')).toHaveLength(1)

    await auth.close()
    auth = await startFakeAuth({ dcr: true, rejectRedirectHosts: ['127.0.0.1', 'localhost'] })
    const error = (await manager.authorize('demo', `${auth.base}/mcp`).catch((err: unknown) => err)) as InstanceType<typeof OAuthSetupError>
    expect(auth.seen.filter((entry) => entry.path === '/register')).toHaveLength(2)
    expect(error.message).toContain('não aceita registro dinâmico')
    expect(error.message).toContain('com localhost:')
    // The hint still names the fixed URL the user would register in their own OAuth app.
    expect(error.hint).toContain(error.redirectUri!)
    expect(error.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('begin() returns the login page at once and finishes in the background', async () => {
    auth = await startFakeAuth({ dcr: true })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    openExternal.mockImplementation(async (raw: string) => {
      const authorization = new URL(raw)
      auth.challenges.set('late-code', {
        challenge: authorization.searchParams.get('code_challenge')!,
        clientId: authorization.searchParams.get('client_id')!
      })
      // The user takes a while: the callback only arrives after begin() has returned.
      void gate.then(() =>
        fetch(`${authorization.searchParams.get('redirect_uri')}?code=late-code&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`)
      )
    })
    const manager = new McpOAuthManager(dataDir)
    const session = await manager.begin('demo', `${auth.base}/mcp`)
    expect(session.authUrl).toContain('/authorize?')
    expect(manager.status('demo').total).toBe(0)
    release()
    await expect(session.completion).resolves.toBe('access-1')
    expect(manager.status('demo').total).toBe(1)
  })

  it('ignores a callback that does not carry our state and keeps waiting', async () => {
    auth = await startFakeAuth({ dcr: true })
    browser(auth, { wrongStateFirst: true })
    const manager = new McpOAuthManager(dataDir)
    expect(await manager.authorize('demo', `${auth.base}/mcp`)).toBe('access-1')
    expect(wrongStateStatuses).toEqual([400])
  })

  it('treats access_denied as a cancel and any other provider error as a failure', async () => {
    auth = await startFakeAuth({ dcr: true })
    const manager = new McpOAuthManager(dataDir)
    browser(auth, { error: 'access_denied' })
    expect(await manager.authorize('demo', `${auth.base}/mcp`)).toBeNull()
    browser(auth, { error: 'server_error', description: 'falha interna do provedor' })
    await expect(manager.authorize('demo', `${auth.base}/mcp`)).rejects.toThrow(/falha interna do provedor/)
  })

  it('keeps the previous grant when a new login is cancelled', async () => {
    auth = await startFakeAuth({ dcr: true })
    const manager = new McpOAuthManager(dataDir)
    browser(auth)
    await manager.authorize('demo', `${auth.base}/mcp`)
    browser(auth, { error: 'access_denied' })
    expect(await manager.reauthorize('demo', `${auth.base}/mcp`)).toBeNull()
    expect(await manager.token('demo')).toBe('access-1')
  })

  it('gives up after the consent timeout and lets the caller cancel', async () => {
    auth = await startFakeAuth({ dcr: true })
    openExternal.mockImplementation(async () => undefined)
    const quick = new McpOAuthManager(dataDir, undefined, { flowTimeoutMs: 120 })
    const timedOut = await quick.begin('demo', `${auth.base}/mcp`)
    await expect(timedOut.completion).resolves.toBeNull()

    const manager = new McpOAuthManager(dataDir)
    const waiting = await manager.begin('demo', `${auth.base}/mcp`)
    manager.cancel('demo')
    await expect(waiting.completion).resolves.toBeNull()
  })

  it('still returns the login page when no browser can be opened', async () => {
    auth = await startFakeAuth({ dcr: true })
    openExternal.mockRejectedValue(new Error('sem navegador padrão'))
    const manager = new McpOAuthManager(dataDir)
    const session = await manager.begin('demo', `${auth.base}/mcp`)
    expect(session.authUrl).toContain('redirect_uri=')
    session.cancel()
    await expect(session.completion).resolves.toBeNull()
  })

  it('falls back to another callback port when the preferred one is busy', async () => {
    auth = await startFakeAuth({ dcr: true })
    browser(auth)
    const blocker = http.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busy = (blocker.address() as { port: number }).port
    try {
      const manager = new McpOAuthManager(dataDir)
      expect(await manager.authorize('demo', `${auth.base}/mcp`, undefined, { callbackPort: busy })).toBe('access-1')
      expect(redirects[0]).not.toContain(`:${busy}/`)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
    // A free preferred port is honoured (static clients registered with a fixed redirect URI).
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const free = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const second = new McpOAuthManager(dataDir)
    await second.authorize('other', `${auth.base}/mcp`, undefined, { callbackPort: free })
    expect(redirects[1]).toBe(`http://127.0.0.1:${free}/callback`)
  })

  it('records the account when the server exposes userinfo and never fails without it', async () => {
    auth = await startFakeAuth({ dcr: true, userinfo: 'ok' })
    browser(auth)
    const manager = new McpOAuthManager(dataDir)
    await manager.authorize('demo', `${auth.base}/mcp`)
    expect(manager.status('demo').account).toBe('ana@example.com')
    await auth.close()

    auth = await startFakeAuth({ dcr: true, userinfo: 'error' })
    browser(auth)
    const other = new McpOAuthManager(dataDir)
    expect(await other.authorize('flaky', `${auth.base}/mcp`)).toBe('access-1')
    expect(other.status('flaky').account).toBeUndefined()
  })

  /**
   * Mercado Pago (measured against https://mcp.mercadopago.com/mcp): one protected-resource document per path with its own
   * issuer (`.../mcp`) and a path-scoped registration endpoint (`/oauth/register/mcp`), plus a generic document at the root
   * whose registration endpoint (`/oauth/register`) answers 400 "register path not found in URI".
   */
  async function startPathScoped(options: { pathIssuerReachable: boolean }): Promise<FakeAuth & { registrations: string[] }> {
    const registrations: string[] = []
    const seen: Seen[] = []
    const challenges = new Map<string, { challenge: string; clientId: string }>()
    let origin = ''
    const server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        const url = new URL(request.url ?? '/', origin)
        const form = String(request.headers['content-type'] ?? '').includes('x-www-form-urlencoded') ? new URLSearchParams(raw) : null
        seen.push({ method: request.method ?? 'GET', path: url.pathname, form, json: null, headers: request.headers, at: Date.now() })
        const send = (status: number, body: unknown): void => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(body))
        }
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          return send(200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/mcp`], scopes_supported: ['offline_access', 'write', 'read'] })
        }
        if (url.pathname === '/.well-known/oauth-protected-resource') {
          return send(200, { resource: origin, authorization_servers: [origin] })
        }
        if (url.pathname === '/.well-known/oauth-authorization-server/mcp' && options.pathIssuerReachable) {
          return send(200, {
            issuer: `${origin}/mcp`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/oauth/register/mcp`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none']
          })
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          return send(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/oauth/register`,
            scopes_supported: [],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none']
          })
        }
        if (url.pathname === '/oauth/register') {
          registrations.push(url.pathname)
          return send(400, { message: 'MCP name not found or invalid: register path not found in URI', error: 'bad_request' })
        }
        if (url.pathname === '/oauth/register/mcp') {
          registrations.push(url.pathname)
          // Like the real one: an empty client_secret for a public client.
          return send(201, { client_id: 'mp-client', client_secret: '', scope: 'offline_access write read' })
        }
        if (url.pathname === '/token' && form?.get('grant_type') === 'authorization_code') {
          const known = challenges.get(form.get('code') ?? '')
          const hashed = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
          if (!known || known.challenge !== hashed) return send(400, { error: 'invalid_grant' })
          return send(200, { access_token: 'mp-access', refresh_token: 'mp-refresh', expires_in: 3600 })
        }
        response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    return {
      base: origin,
      seen,
      challenges,
      registrations,
      tokenCalls: (grant) => seen.filter((entry) => entry.path === '/token' && entry.form?.get('grant_type') === grant),
      close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('prefers the path-scoped protected-resource document and registers at its own endpoint (Mercado Pago)', async () => {
    const mp = await startPathScoped({ pathIssuerReachable: true })
    auth = mp
    browser(mp)
    const manager = new McpOAuthManager(dataDir)
    expect(await manager.authorize('mp', `${mp.base}/mcp`)).toBe('mp-access')
    expect(mp.registrations).toEqual(['/oauth/register/mcp'])
    const authorizeUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authorizeUrl.searchParams.get('scope')).toBe('offline_access write read')
    expect(authorizeUrl.searchParams.get('resource')).toBe(`${mp.base}/mcp`)
    expect(authorizeUrl.searchParams.get('client_id')).toBe('mp-client')
  })

  it('falls back to the root document when the path-scoped issuer is unreachable, and reports a refused registration with guidance', async () => {
    const mp = await startPathScoped({ pathIssuerReachable: false })
    auth = mp
    browser(mp)
    const manager = new McpOAuthManager(dataDir)
    // The root document's registration endpoint refuses us: the user gets the guidance, not a crash.
    const error = (await manager.authorize('mp', `${mp.base}/mcp`).catch((err: unknown) => err)) as InstanceType<typeof OAuthSetupError>
    expect(error).toBeInstanceOf(OAuthSetupError)
    expect(error.message).toContain('registro dinâmico')
    expect(mp.registrations).toEqual(['/oauth/register'])
  })

  it('never writes tokens, codes or client ids to the console while logging in', async () => {
    auth = await startFakeAuth({ dcr: true, revocation: true })
    browser(auth)
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
    try {
      const manager = new McpOAuthManager(dataDir)
      await manager.authorize('demo', `${auth.base}/mcp`)
      await manager.revoke('demo')
      const printed = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')
      expect(printed).not.toMatch(/access-1|refresh-1|code-1/)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* Fixed return URL, the user's own OAuth app, and the dry run                                       */
/* ------------------------------------------------------------------------------------------------ */

async function freePort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe("fixed return URL and the user's own OAuth app (oauth-static)", () => {
  let auth: FakeAuth
  let port: number
  let redirects: string[]

  function browser(current: FakeAuth, behavior: { error?: string; description?: string } = {}): void {
    let counter = 0
    openExternal.mockImplementation(async (raw: string) => {
      const authorization = new URL(raw)
      const redirect = authorization.searchParams.get('redirect_uri')!
      redirects.push(redirect)
      const code = `code-${++counter}`
      current.challenges.set(code, {
        challenge: authorization.searchParams.get('code_challenge')!,
        clientId: authorization.searchParams.get('client_id')!
      })
      const state = encodeURIComponent(authorization.searchParams.get('state')!)
      const query = behavior.error
        ? `error=${behavior.error}${behavior.description ? `&error_description=${encodeURIComponent(behavior.description)}` : ''}&state=${state}`
        : `code=${code}&state=${state}`
      await fetch(`${redirect}?${query}`)
    })
  }

  beforeEach(async () => {
    redirects = []
    port = await freePort()
  })

  afterEach(async () => {
    await auth?.close()
  })

  it('prefers one fixed loopback port, the same the contract tells the interface to show', () => {
    expect(MCP_OAUTH_CALLBACK_PORT).toBe(38565)
    expect(MCP_OAUTH_REDIRECT_URI).toBe('http://127.0.0.1:38565/callback')
    expect(new McpOAuthManager(dataDir).preferredRedirectUri).toBe(MCP_OAUTH_REDIRECT_URI)
    expect(new McpOAuthManager(dataDir, undefined, { callbackPort: 4242 }).preferredRedirectUri).toBe('http://127.0.0.1:4242/callback')
  })

  it('logs in on exactly the preferred return URL, and says when it had to use another port', async () => {
    auth = await startFakeAuth({ dcr: false })
    browser(auth)
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const session = await manager.begin('app', `${auth.base}/mcp`, undefined, { clientId: 'app-1' })
    expect(session.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
    expect(session.redirectUriFallback).toBe(false)
    expect(new URL(session.authUrl).searchParams.get('redirect_uri')).toBe(session.redirectUri)
    await expect(session.completion).resolves.toBe('access-1')
    expect(auth.tokenCalls('authorization_code')[0].form?.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`)

    // Busy: the login still works on another port, flagged so the interface can warn.
    const blocker = http.createServer()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
    try {
      const other = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
      const fallback = await other.begin('app2', `${auth.base}/mcp`, undefined, { clientId: 'app-1' })
      expect(fallback.redirectUriFallback).toBe(true)
      expect(fallback.redirectUri).not.toBe(`http://127.0.0.1:${port}/callback`)
      await expect(fallback.completion).resolves.toBe('access-2')
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it.each([['client_secret_post'], ['client_secret_basic']])('sends the client secret the way the server lists (%s), also when refreshing', async (method) => {
    auth = await startFakeAuth({ dcr: false, authMethods: [method], confidential: { secret: 'secret-of-app-1' }, firstLifetime: 1 })
    browser(auth)
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const options = { clientId: 'app-1', clientSecret: 'secret-of-app-1' }
    expect(await manager.authorize('app', `${auth.base}/mcp`, undefined, options)).toBe('access-1')
    const exchange = auth.tokenCalls('authorization_code')[0]
    if (method === 'client_secret_post') {
      expect(exchange.form?.get('client_secret')).toBe('secret-of-app-1')
      expect(exchange.headers.authorization).toBeUndefined()
    } else {
      expect(exchange.form?.has('client_secret')).toBe(false)
      expect(exchange.headers.authorization).toBe(`Basic ${Buffer.from('app-1:secret-of-app-1').toString('base64')}`)
    }
    // The refresh (the 1 s token is already stale) authenticates the same way, without asking the user again.
    expect(await manager.token('app')).toBe('access-2')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('does not send a secret to a server that only knows public clients', async () => {
    auth = await startFakeAuth({ dcr: false, authMethods: ['none'] })
    browser(auth)
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    await manager.authorize('app', `${auth.base}/mcp`, undefined, { clientId: 'app-1', clientSecret: 'never-sent-value' })
    const exchange = auth.tokenCalls('authorization_code')[0]
    expect(exchange.form?.has('client_secret')).toBe(false)
    expect(exchange.headers.authorization).toBeUndefined()
  })

  it('explains a rejected client id or return URL and names the exact URL to register', async () => {
    auth = await startFakeAuth({ dcr: false })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })

    // The provider sends the user back with the error.
    browser(auth, { error: 'invalid_request', description: 'redirect_uri não está na lista do aplicativo' })
    const sent = await manager.begin('app', `${auth.base}/mcp`, undefined, { clientId: 'app-1' })
    const first = (await sent.completion.catch((err: unknown) => err)) as InstanceType<typeof OAuthSetupError>
    expect(first).toBeInstanceOf(OAuthSetupError)
    expect(first.message).toBe(`client id inválido ou URL de retorno não cadastrada: cadastre exatamente http://127.0.0.1:${port}/callback`)
    expect(first.hint).toContain(`http://127.0.0.1:${port}/callback`)
    expect(first.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)

    // The token endpoint refuses the client (wrong secret).
    await auth.close()
    auth = await startFakeAuth({ dcr: false, authMethods: ['client_secret_post'], confidential: { secret: 'the-right-one' } })
    browser(auth)
    const second = (await manager
      .authorize('app', `${auth.base}/mcp`, undefined, { clientId: 'app-1', clientSecret: 'a-wrong-one' })
      .catch((err: unknown) => err)) as InstanceType<typeof OAuthSetupError>
    expect(second.message).toContain('client id inválido ou URL de retorno não cadastrada: cadastre exatamente http://127.0.0.1:')
    expect(second.hint).toContain('confira o client ID e o segredo')
    expect(JSON.stringify([second.message, second.hint])).not.toContain('a-wrong-one')

    // A dynamically registered client has nothing to register: the generic provider error stays.
    await auth.close()
    auth = await startFakeAuth({ dcr: true })
    browser(auth, { error: 'invalid_request', description: 'redirect_uri não está na lista do aplicativo' })
    const dynamic = (await manager.authorize('app', `${auth.base}/mcp`).catch((err: unknown) => err)) as Error
    expect(dynamic.message).toMatch(/^o provedor recusou o login/)
  })
})

describe('dry run (prepareAuthorization)', () => {
  let auth: FakeAuth
  let port: number

  beforeEach(async () => {
    port = await freePort()
  })

  afterEach(async () => {
    await auth?.close()
  })

  it('walks discovery, a throw-away registration and the authorization URL without opening, listening or storing', async () => {
    auth = await startFakeAuth({ dcr: true, prmScopes: ['read'], asScopes: ['read', 'offline_access'] })
    const opener = vi.fn()
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port, openUrl: opener })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)

    expect(report.ok).toBe(true)
    expect(report.steps.map((step) => [step.step, step.ok])).toEqual([
      ['discovery', true],
      ['registration', true],
      ['authorize-url', true]
    ])
    expect(report.steps.every((step) => step.ms >= 0 && step.detail.length > 10)).toBe(true)
    expect(report.steps[0].detail).toContain('registro dinâmico: sim')
    expect(report.client).toBe('dynamic')
    expect(report.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
    expect(report.scope).toBe('read offline_access')
    const url = new URL(report.authUrl!)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('redirect_uri')).toBe(report.redirectUri)
    expect(url.searchParams.get('resource')).toBe(`${auth.base}/mcp`)
    expect(url.searchParams.get('client_id')).toBe('dcr-client')

    // One registration attempt, under a name that says it is a connectivity test.
    const registrations = auth.seen.filter((entry) => entry.path === '/register')
    expect(registrations).toHaveLength(1)
    expect(registrations[0].json?.client_name).toBe('Openclod Desktop teste')
    // Some servers cap client_name (Shippo: 39 characters) and some take only letters, digits, hyphens and spaces
    // (Calendly): the test name is short and plain.
    expect(String(registrations[0].json?.client_name).length).toBeLessThanOrEqual(39)
    expect(String(registrations[0].json?.client_name)).toMatch(/^[A-Za-z0-9 -]+$/)
    // No browser, no token traffic, nothing stored, and nothing listens on the callback port.
    expect(opener).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(auth.seen.some((entry) => entry.path === '/token')).toBe(false)
    expect(manager.status('demo').total).toBe(0)
    const probe = http.createServer()
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  it('registers with localhost when the server refuses the 127.0.0.1 return URL, and the authorization URL carries what was registered', async () => {
    auth = await startFakeAuth({ dcr: true, rejectRedirectHosts: ['127.0.0.1'] })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(report.ok).toBe(true)
    expect(report.redirectUri).toBe(`http://localhost:${port}/callback`)
    expect(new URL(report.authUrl!).searchParams.get('redirect_uri')).toBe(report.redirectUri)
    expect(report.steps[1].detail).toContain(`127.0.0.1 foi recusado como URL de retorno, registrado com http://localhost:${port}/callback`)
    expect(auth.seen.filter((entry) => entry.path === '/register')).toHaveLength(2)
    expect(manager.status('demo').total).toBe(0)
  })

  it('uses a client id that is given instead of registering', async () => {
    auth = await startFakeAuth({ dcr: true, authMethods: ['client_secret_post'] })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`, { clientId: 'app-1', clientSecret: 'secret-xyz-123' })
    expect(report.ok).toBe(true)
    expect(report.client).toBe('provided')
    expect(report.steps[1].detail).toBe('client id informado (com segredo); registro dinâmico dispensado')
    expect(new URL(report.authUrl!).searchParams.get('client_id')).toBe('app-1')
    expect(auth.seen.some((entry) => entry.path === '/register')).toBe(false)
    expect(JSON.stringify(report)).not.toContain('secret-xyz-123')
  })

  it('reports where it stopped, with the guidance, when nothing can register a client', async () => {
    auth = await startFakeAuth({ dcr: false })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(report.ok).toBe(false)
    expect(report.steps.map((step) => [step.step, step.ok])).toEqual([
      ['discovery', true],
      ['registration', false]
    ])
    expect(report.authUrl).toBeUndefined()
    expect(report.error).toContain('não aceita registro dinâmico')
    expect(report.hint).toContain(`http://127.0.0.1:${port}/callback`)
    expect(report.client).toBeUndefined()

    // A registration endpoint that refuses us is a failed step with its status, never an exception.
    await auth.close()
    auth = await startFakeAuth({ dcr: true, registerStatus: 403 })
    const refused = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(refused.ok).toBe(false)
    expect(refused.steps[1]).toMatchObject({ step: 'registration', ok: false })
    expect(refused.steps[1].detail).toContain('403')
  })

  it('asks the server for its 401 when the well-known paths find nothing, and follows a bare resource_metadata URL (Bill, Guidepoint, American Express)', async () => {
    auth = await startFakeAuth({ dcr: true, announcePrm: { path: '/gateway/prm-document', bare: true } })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port, openUrl: vi.fn() })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(report.ok).toBe(true)
    expect(report.steps.map((step) => [step.step, step.ok])).toEqual([
      ['discovery', true],
      ['registration', true],
      ['authorize-url', true]
    ])
    // The scope the 401 announced wins over the document's list.
    expect(report.scope).toBe('announced:read')
    const probes = auth.seen.filter((entry) => entry.path === '/mcp')
    expect(probes).toHaveLength(1)
    expect(probes[0].method).toBe('POST')
    expect(String(probes[0].headers.accept)).toContain('text/event-stream')
    expect(probes[0].headers.authorization).toBeUndefined()
    expect(probes[0].json).toMatchObject({ method: 'initialize' })
  })

  it('also follows a quoted resource_metadata that the legacy SSE GET announces (the POST answers 405)', async () => {
    auth = await startFakeAuth({ dcr: true, announcePrm: { path: '/sse-docs/prm', viaGet: true } })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port, openUrl: vi.fn() })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(report.ok).toBe(true)
    expect(auth.seen.filter((entry) => entry.path === '/mcp').map((entry) => entry.method)).toEqual(['POST', 'GET'])
  })

  it('does not ask for a 401 when the well-known document already answers, nor when the 401 was already given', async () => {
    auth = await startFakeAuth({ dcr: true })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port, openUrl: vi.fn() })
    expect((await manager.prepareAuthorization('demo', `${auth.base}/mcp`)).ok).toBe(true)
    expect(auth.seen.some((entry) => entry.path === '/mcp')).toBe(false)
    await auth.close()
    auth = await startFakeAuth({ dcr: true, announcePrm: { path: '/gateway/prm-document' } })
    const challenge = `Bearer resource_metadata="${auth.base}/gateway/prm-document"`
    expect((await manager.prepareAuthorization('demo', `${auth.base}/mcp`, { challenge })).ok).toBe(true)
    expect(auth.seen.some((entry) => entry.path === '/mcp')).toBe(false)
  })

  it('gives up with the usual message when the 401 announces nothing either', async () => {
    auth = await startFakeAuth({ forms: [] })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(report.ok).toBe(false)
    expect(report.error).toBe('servidor MCP não publicou metadados OAuth')
  })

  it('says what the registration endpoint answered, not only the status (invalid_redirect_uri, a WAF page, plain text)', async () => {
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    auth = await startFakeAuth({
      dcr: true,
      registerStatus: 400,
      registerError: { body: JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'redirect_uri must use https\nand a registered host' }) }
    })
    const described = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(described.steps[1]).toMatchObject({ step: 'registration', ok: false })
    expect(described.steps[1].detail).toContain('registro OAuth 400 (invalid_redirect_uri): redirect_uri must use https and a registered host')
    expect(described.hint).toContain(`http://127.0.0.1:${port}/callback`)

    await auth.close()
    auth = await startFakeAuth({ dcr: true, registerStatus: 403, registerError: { body: '<!DOCTYPE html><html><head><title>Just a moment...</title>', contentType: 'text/html' } })
    expect((await manager.prepareAuthorization('demo', `${auth.base}/mcp`)).steps[1].detail).toContain('registro OAuth 403: página HTML (provável bloqueio de WAF/CDN)')

    await auth.close()
    auth = await startFakeAuth({ dcr: true, registerStatus: 404, registerError: { body: 'Not Found', contentType: 'text/plain' } })
    expect((await manager.prepareAuthorization('demo', `${auth.base}/mcp`)).steps[1].detail).toContain('registro OAuth 404: Not Found')
  })

  it('reads resource_metadata and scope from a challenge, quoted or bare, and never takes them from another parameter', () => {
    expect(resourceMetadataOf('Bearer resource_metadata="https://a.example/prm", scope="x y"')).toBe('https://a.example/prm')
    expect(resourceMetadataOf('Bearer resource_metadata=https://apigw.example/dining/.well-known/oauth-protected-resource')).toBe(
      'https://apigw.example/dining/.well-known/oauth-protected-resource'
    )
    expect(resourceMetadataOf('Bearer realm="OAuth", error="invalid_token", RESOURCE_METADATA = "https://a.example/prm"')).toBe('https://a.example/prm')
    expect(resourceMetadataOf('Basic realm="x"')).toBeUndefined()
    expect(resourceMetadataOf(undefined)).toBeUndefined()
    expect(scopesOf('Bearer resource_metadata="https://a/prm", scope="mcp:read mcp:write"')).toEqual(['mcp:read', 'mcp:write'])
    expect(scopesOf('Bearer scope=mcp:tools, error="invalid_token"')).toEqual(['mcp:tools'])
    expect(scopesOf('Bearer error_description="the scope is wrong"')).toEqual([])
    expect(scopesOf(undefined)).toEqual([])
  })

  it('registrationFailure keeps it short and never echoes more than the first 160 characters', async () => {
    const long = 'x'.repeat(500)
    const text = await registrationFailure(new Response(long, { status: 500, headers: { 'content-type': 'text/plain' } }))
    expect(text.startsWith('registro OAuth 500: xxx')).toBe(true)
    expect(text.length).toBeLessThan(200)
    expect(await registrationFailure(new Response('', { status: 502 }))).toBe('registro OAuth 502')
  })

  it('says why a registration endpoint that answers 200 with an error body refused us (Cloze: unapproved_software_statement)', async () => {
    auth = await startFakeAuth({ dcr: true, registerStatus: 200, registerError: { body: JSON.stringify({ error: 'unapproved_software_statement', error_description: 'This client is not approved. Contact support.' }) } })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(report.ok).toBe(false)
    expect(report.steps[1].detail).toContain('registro OAuth sem client_id (unapproved_software_statement): This client is not approved. Contact support.')
  })

  it('registrationFailure reads the other shapes servers use for the reason: message, and a field-by-field errors object (Calendly)', async () => {
    const calendly = await registrationFailure(
      new Response(JSON.stringify({ error: 'invalid_client_metadata', errors: { name: ['may only contain alphanumeric characters, hyphens, and spaces.'] } }), { status: 400 })
    )
    expect(calendly).toContain('registro OAuth 400 (invalid_client_metadata): ')
    expect(calendly).toContain('may only contain alphanumeric characters')
    expect(await registrationFailure(new Response(JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'dynamic client registration is disabled' }), { status: 400 }))).toBe(
      'registro OAuth 400: dynamic client registration is disabled'
    )
  })

  it('never throws: an unreachable or non-OAuth server is a failed discovery step', async () => {
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    auth = await startFakeAuth({ forms: [] })
    const none = await manager.prepareAuthorization('demo', `${auth.base}/mcp`)
    expect(none.ok).toBe(false)
    expect(none.steps).toHaveLength(1)
    expect(none.steps[0]).toMatchObject({ step: 'discovery', ok: false })
    expect(none.error).toBe('servidor MCP não publicou metadados OAuth')

    expect((await manager.prepareAuthorization('demo', 'não é uma url')).error).toBe('URL do conector inválida')
    expect((await manager.prepareAuthorization('demo', 'http://example.com/mcp')).steps[0].detail).toBe('a URL do conector não usa HTTPS')
    const closed = await freePort()
    const down = await manager.prepareAuthorization('demo', `http://127.0.0.1:${closed}/mcp`)
    expect(down.ok).toBe(false)
  })

  it('spaces its requests to one host when asked (a polite scan)', async () => {
    auth = await startFakeAuth({ dcr: true })
    const manager = new McpOAuthManager(dataDir, undefined, { callbackPort: port })
    const report = await manager.prepareAuthorization('demo', `${auth.base}/mcp`, { minIntervalMs: 120 })
    expect(report.ok).toBe(true)
    const times = auth.seen.map((entry) => entry.at)
    expect(times.length).toBeGreaterThanOrEqual(3)
    for (let index = 1; index < times.length; index++) expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(100)
  })

  it('does not need Electron to load: no static import of it, the opener is injected', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'mcp-oauth.ts'), 'utf8')
    expect(source).not.toMatch(/^import\s[^\n]*from 'electron'/m)
    expect(source).toMatch(/openUrl\?:/)
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* oauth-static connector end to end: ConnectorService + the real manager + the fake OAuth server    */
/* ------------------------------------------------------------------------------------------------ */

const { ConnectorService } = await import('../src/main/connector-service')
const { SettingsStore } = await import('../src/main/settings')

describe('oauth-static connector end to end (the real manager against the fake server)', () => {
  const fakeCrypto = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (data: Buffer) => Buffer.from(data.toString('utf8').slice(4), 'base64').toString('utf8')
  }
  const SECRET = 'slackish-app-secret-0123456789'
  let auth: FakeAuth
  let settingsDir: string
  let port: number

  /** The user's browser: the provider's page is skipped and the user is sent back to the return URL. */
  function approve(current: FakeAuth, behavior: { error?: string; description?: string } = {}): void {
    let counter = 0
    openExternal.mockImplementation(async (raw: string) => {
      const authorization = new URL(raw)
      const code = `code-${++counter}`
      current.challenges.set(code, {
        challenge: authorization.searchParams.get('code_challenge')!,
        clientId: authorization.searchParams.get('client_id')!
      })
      const state = encodeURIComponent(authorization.searchParams.get('state')!)
      const query = behavior.error
        ? `error=${behavior.error}&error_description=${encodeURIComponent(behavior.description ?? '')}&state=${state}`
        : `code=${code}&state=${state}`
      await fetch(`${authorization.searchParams.get('redirect_uri')}?${query}`)
    })
  }

  async function harness() {
    const store = new SettingsStore(settingsDir, fakeCrypto)
    await store.init()
    const oauth = new McpOAuthManager(path.join(settingsDir, 'oauth'), fakeCrypto, { callbackPort: port })
    const restarted: Array<string | undefined> = []
    const entry = {
      id: 'slackish',
      name: 'Slackish',
      description: 'Mensagens',
      category: 'comunicacao',
      kind: 'remote',
      transport: 'http',
      url: `${auth.base}/mcp`,
      auth: 'oauth-static',
      tools: [],
      source: 'claude-directory'
    }
    const service = new ConnectorService({
      settings: store,
      oauth,
      clients: () => new Map(),
      restart: async (name?: string) => void restarted.push(name),
      refreshTools: () => undefined,
      emitChanged: () => undefined,
      secretIssues: () => new Map(),
      challenge: () => undefined,
      loadDirectoryFile: () => ({ entries: [entry] })
    })
    return { store, oauth, service, restarted }
  }

  /** Every file of the config and OAuth folders, as text. */
  function everythingOnDisk(): string {
    const files: string[] = []
    const walk = (folder: string): void => {
      for (const name of fs.readdirSync(folder)) {
        const full = path.join(folder, name)
        if (fs.statSync(full).isDirectory()) walk(full)
        else files.push(fs.readFileSync(full, 'utf8'))
      }
    }
    walk(settingsDir)
    return files.join('\n')
  }

  beforeEach(async () => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-static-'))
    port = await freePort()
  })

  afterEach(async () => {
    await auth?.close()
    fs.rmSync(settingsDir, { recursive: true, force: true })
  })

  it('without a client id it explains what to register and touches nothing', async () => {
    auth = await startFakeAuth({ dcr: false })
    const { service, store, oauth } = await harness()
    const result = await service.connect('slackish')
    expect(result.state).toMatchObject({ status: 'needs-auth', detail: 'Informe o client ID do aplicativo OAuth', redirectUri: `http://127.0.0.1:${port}/callback` })
    expect(result.state.hint).toContain(`cadastre exatamente esta URL de retorno: http://127.0.0.1:${port}/callback`)
    expect(store.get().mcpServers).toEqual([])
    expect(auth.seen).toEqual([])
    expect(openExternal).not.toHaveBeenCalled()
    expect(oauth.status('slackish').total).toBe(0)
  })

  it('with the user\'s app it authorizes, the secret stays in the vault and never reaches a file or a log', async () => {
    auth = await startFakeAuth({ dcr: false, authMethods: ['client_secret_post'], confidential: { secret: SECRET } })
    approve(auth)
    const { service, store, oauth, restarted } = await harness()
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
    try {
      const result = await service.connect('slackish', { oauthClient: { clientId: 'app-1', clientSecret: SECRET } })
      expect(result.state).toMatchObject({ id: 'slackish', status: 'connecting', redirectUri: `http://127.0.0.1:${port}/callback`, oauthClient: { clientId: 'app-1', hasSecret: true, source: 'user' } })
      const authorizeUrl = new URL(result.authUrl!)
      expect(authorizeUrl.searchParams.get('client_id')).toBe('app-1')
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`)
      expect(auth.seen.some((entry) => entry.path === '/register')).toBe(false)

      await vi.waitFor(() => expect(restarted).toEqual(['slackish']))
      expect(await oauth.token('slackish')).toBe('access-1')
      expect(auth.tokenCalls('authorization_code')[0].form?.get('client_secret')).toBe(SECRET)

      expect(store.mcpSecretValue('slackish', 'oauth_client_secret')).toBe(SECRET)
      expect(everythingOnDisk()).not.toContain(SECRET)
      expect(JSON.stringify(service.states())).not.toContain(SECRET)
      expect(spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')).not.toContain(SECRET)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })

  it('reconnecting reuses the saved app without asking again', async () => {
    auth = await startFakeAuth({ dcr: false, authMethods: ['client_secret_post'], confidential: { secret: SECRET } })
    approve(auth)
    const { service, oauth, restarted } = await harness()
    await service.connect('slackish', { oauthClient: { clientId: 'app-1', clientSecret: SECRET } })
    await vi.waitFor(() => expect(restarted).toHaveLength(1))

    await oauth.logout('slackish')
    const again = await service.connect('slackish')
    expect(again.state.oauthClient).toEqual({ clientId: 'app-1', hasSecret: true, source: 'user' })
    await vi.waitFor(() => expect(restarted).toHaveLength(2))
    const exchanges = auth.tokenCalls('authorization_code')
    expect(exchanges).toHaveLength(2)
    expect(exchanges[1].form?.get('client_id')).toBe('app-1')
    expect(exchanges[1].form?.get('client_secret')).toBe(SECRET)
  })

  it('shows the exact URL to register when the provider sends the user back refusing the client', async () => {
    auth = await startFakeAuth({ dcr: false })
    approve(auth, { error: 'invalid_request', description: 'redirect_uri não cadastrada' })
    const { service, restarted } = await harness()
    await service.connect('slackish', { oauthClient: { clientId: 'app-1' } })
    await vi.waitFor(() => expect(service.stateById('slackish').status).toBe('needs-auth'))
    const state = service.stateById('slackish')
    expect(state.lastError).toBe(`client id inválido ou URL de retorno não cadastrada: cadastre exatamente http://127.0.0.1:${port}/callback`)
    expect(state.hint).toContain(`http://127.0.0.1:${port}/callback`)
    expect(state.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
    expect(restarted).toEqual([])
  })

  it('a wrong secret is explained the same way, without echoing it', async () => {
    auth = await startFakeAuth({ dcr: false, authMethods: ['client_secret_post'], confidential: { secret: SECRET } })
    approve(auth)
    const { service } = await harness()
    await service.connect('slackish', { oauthClient: { clientId: 'app-1', clientSecret: 'a-wrong-secret-value' } })
    await vi.waitFor(() => expect(service.stateById('slackish').status).toBe('needs-auth'))
    const state = service.stateById('slackish')
    expect(state.lastError).toContain('client id inválido ou URL de retorno não cadastrada')
    expect(JSON.stringify(state)).not.toContain('a-wrong-secret-value')
  })

  it('rehearses the connector against the fake server: nothing is opened, installed or stored', async () => {
    auth = await startFakeAuth({ dcr: true })
    const { service, store, oauth } = await harness()
    const result = await service.connect('slackish', { dryRun: true })
    expect(result.dryRun).toMatchObject({ ok: true, client: 'dynamic', redirectUri: `http://127.0.0.1:${port}/callback` })
    expect(result.dryRun?.steps.map((step) => step.step)).toEqual(['discovery', 'registration', 'authorize-url'])
    expect(openExternal).not.toHaveBeenCalled()
    expect(store.get().mcpServers).toEqual([])
    expect(oauth.status('slackish').total).toBe(0)
    expect(result.state).toMatchObject({ id: 'slackish', status: 'not-installed' })
  })
})
