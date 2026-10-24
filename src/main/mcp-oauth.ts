import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { shell } from 'electron'

/**
 * Interactive OAuth 2.1 for remote MCP servers.
 *
 * Implements the flow MCP servers announce in `WWW-Authenticate`:
 * protected-resource metadata -> authorization-server metadata -> dynamic
 * client registration -> authorization code + PKCE (S256) -> local callback ->
 * token exchange. Tokens are cached per server and refreshed when possible.
 *
 * A user can always bypass this by putting a static bearer token in the
 * server's headers in Configurações; OAuth is only attempted for servers that
 * answer 401 and need it.
 */

interface OAuthRecord {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenEndpoint: string
  clientId: string
  resource?: string
  scope?: string
}

interface AuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
}

const FLOW_TIMEOUT_MS = 180_000

export class McpOAuthManager {
  private records = new Map<string, OAuthRecord>()
  private loaded = false
  private readonly file: string

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, 'mcp-oauth.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, OAuthRecord>
      for (const [name, record] of Object.entries(raw)) if (record?.accessToken) this.records.set(name, record)
    } catch {
      /* first run */
    }
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const payload = Object.fromEntries(this.records.entries())
    fs.writeFileSync(`${this.file}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(`${this.file}.tmp`, this.file)
  }

  /** Returns a valid access token, refreshing or starting the browser flow. */
  async authorize(serverName: string, resourceUrl: string, challenge?: string): Promise<string | null> {
    this.load()
    const current = this.records.get(serverName)
    if (current && (!current.expiresAt || current.expiresAt - 30_000 > Date.now())) return current.accessToken
    if (current?.refreshToken) {
      const refreshed = await this.refresh(serverName, current).catch(() => null)
      if (refreshed) return refreshed
    }
    const discovered = await this.discover(resourceUrl, challenge).catch(() => null)
    if (!discovered) return null
    return this.runFlow(serverName, resourceUrl, discovered)
  }

  async logout(serverName: string): Promise<void> {
    this.load()
    this.records.delete(serverName)
    this.save()
  }

  private async refresh(serverName: string, record: OAuthRecord): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken ?? '',
      client_id: record.clientId,
      ...(record.resource ? { resource: record.resource } : {})
    })
    const response = await fetch(record.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) return null
    const token = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!token.access_token) return null
    const next: OAuthRecord = {
      ...record,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? record.refreshToken,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1_000 : undefined
    }
    this.records.set(serverName, next)
    this.save()
    return next.accessToken
  }

  private async discover(resourceUrl: string, challenge?: string): Promise<AuthServerMetadata & { resourceMetadata?: string }> {
    const origin = new URL(resourceUrl).origin
    const fromChallenge = /resource_metadata="([^"]+)"/i.exec(challenge ?? '')?.[1]
    const candidates = [
      fromChallenge,
      `${origin}/.well-known/oauth-protected-resource`,
      `${origin}/.well-known/oauth-protected-resource${new URL(resourceUrl).pathname}`
    ].filter((value): value is string => Boolean(value))

    let authServers: string[] = []
    for (const url of candidates) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
        if (!response.ok) continue
        const metadata = (await response.json()) as { authorization_servers?: string[]; resource?: string }
        if (metadata.authorization_servers?.length) {
          authServers = metadata.authorization_servers
          break
        }
      } catch {
        /* try the next location */
      }
    }
    if (!authServers.length) authServers = [origin]

    for (const issuer of authServers) {
      const base = issuer.replace(/\/+$/, '')
      const urls = [
        `${base}/.well-known/oauth-authorization-server`,
        `${base}/.well-known/openid-configuration`
      ]
      for (const url of urls) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
          if (!response.ok) continue
          const metadata = (await response.json()) as AuthServerMetadata
          if (metadata.authorization_endpoint && metadata.token_endpoint) return metadata
        } catch {
          /* try the next well-known document */
        }
      }
    }
    throw new Error('servidor MCP não publicou metadados OAuth')
  }

  private async runFlow(serverName: string, resourceUrl: string, metadata: AuthServerMetadata): Promise<string | null> {
    const port = await freePort()
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const verifier = base64url(crypto.randomBytes(48))
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
    const state = base64url(crypto.randomBytes(24))
    const scope = metadata.scopes_supported?.includes('mcp') ? 'mcp' : undefined

    const registration = metadata.registration_endpoint
      ? await registerClient(metadata.registration_endpoint, redirectUri).catch(() => null)
      : null
    if (!registration) throw new Error('o servidor OAuth não aceitou registro dinâmico de cliente')
    const clientId = registration.client_id

    const authorizationUrl = new URL(metadata.authorization_endpoint)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', clientId)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('code_challenge', challenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('resource', resourceUrl)
    if (scope) authorizationUrl.searchParams.set('scope', scope)

    const callback = waitForCallback(port, state)
    await shell.openExternal(authorizationUrl.toString())
    const code = await callback
    if (!code) return null

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: resourceUrl
    })
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000)
    })
    const token = (await response.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }
    if (!response.ok || !token.access_token) {
      throw new Error(`troca do código OAuth falhou: ${token.error_description ?? token.error ?? response.status}`)
    }
    const record: OAuthRecord = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1_000 : undefined,
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      resource: resourceUrl,
      scope
    }
    this.records.set(serverName, record)
    this.save()
    return record.accessToken
  }
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<{ client_id: string }> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Openclod Desktop',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`registro OAuth ${response.status}`)
  const body = (await response.json()) as { client_id?: string }
  if (!body.client_id) throw new Error('registro OAuth sem client_id')
  return { client_id: body.client_id }
}

function waitForCallback(port: number, expectedState: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      resolve(value)
    }
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('not found')
        return
      }
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Openclod Desktop</title><body style="font-family:system-ui;background:#111;color:#eee;padding:40px"><h2>${
          error ? 'Login não concluído' : 'Login concluído'
        }</h2><p>${error ? escapeHtml(error) : 'Pode fechar esta aba e voltar ao Openclod.'}</p><script>setTimeout(()=>window.close(),1200)</script></body>`
      )
      if (state !== expectedState || error || !code) {
        finish(null)
        return
      }
      finish(code)
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1')
    const timer = setTimeout(() => finish(null), FLOW_TIMEOUT_MS)
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))))
    })
  })
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}
