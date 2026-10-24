import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: (...args: unknown[]) => openExternal(...args) } }))

const { McpOAuthManager } = await import('../src/main/mcp-oauth')

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
      return json({ resource: `${base}/mcp`, authorization_servers: [base] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`
      })
    }
    if (url.pathname === '/register') {
      return json({ client_id: 'client-openclod' })
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
    expect(tokenRequests[0].get('code')).toBe('auth-code-1')
    expect(tokenRequests[0].get('code_verifier')).toBeTruthy()
    expect(tokenRequests[0].get('grant_type')).toBe('authorization_code')

    // A second call reuses the cached token instead of reopening the browser.
    expect(await manager.authorize('demo', `${base}/mcp`)).toBe('access-123')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
