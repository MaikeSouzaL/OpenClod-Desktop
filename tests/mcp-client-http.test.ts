import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClient, type McpProgress, type McpServerConfig } from '../src/core/mcp/client'
import { startFakeHttpMcp, type FakeHttpMcp, type FakeHttpOptions } from './support/fake-mcp-http'
import { waitFor } from './support/fake-mcp'

/**
 * The MCP client over the network: Streamable HTTP (JSON and SSE answers, sessions, GET stream), the legacy
 * HTTP+SSE transport and the failures real servers produce (401 challenge, "API token" refusal, expired session,
 * transient 5xx, a server that goes away and comes back).
 */
const servers: FakeHttpMcp[] = []
const clients: McpClient[] = []

async function serve(options: FakeHttpOptions = {}): Promise<FakeHttpMcp> {
  const server = await startFakeHttpMcp(options)
  servers.push(server)
  return server
}

function connect(server: FakeHttpMcp, extra: Partial<McpServerConfig> = {}): McpClient {
  const client = new McpClient({ name: 'remote', type: 'http', url: server.url, command: '', args: [], ...extra })
  clients.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop(200).catch(() => undefined)))
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
})

describe('Streamable HTTP', () => {
  it('sends the session id and the negotiated protocol version on every later request, and ends the session', async () => {
    const server = await serve({ sessions: true, only: ['echo'] })
    const client = connect(server)
    await client.start(10_000)
    expect(await client.callTool('echo', { text: 'oi' }, 5_000)).toMatchObject({ ok: true, text: 'echo:oi' })
    await client.stop()
    const later = server.requests.filter((request) => request.rpc !== 'initialize')
    expect(later.length).toBeGreaterThan(3)
    expect(later.every((request) => request.sessionId === 'sess-1')).toBe(true)
    expect(later.every((request) => request.protocolVersion === '2025-06-18')).toBe(true)
    expect(server.requests.find((request) => request.rpc === 'initialize')?.protocolVersion).toBe('')
    expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE', sessionId: 'sess-1' })
    expect(server.requests.every((request) => request.accept.includes('application/json') && request.accept.includes('text/event-stream') || request.method !== 'POST')).toBe(true)
  })

  it('advertises elicitation only when asked to, and exposes server info', async () => {
    const server = await serve({ only: ['echo'], instructions: 'Servidor de teste' })
    const client = connect(server)
    await client.start(10_000)
    expect(server.state.clientCapabilities).toEqual({ elicitation: {} })
    expect(client.describe()).toMatchObject({ transport: 'http', serverName: 'fake', protocolVersion: '2025-06-18', instructions: 'Servidor de teste' })
    const quiet = await serve({ only: ['echo'] })
    await connect(quiet, { elicitation: false }).start(10_000)
    expect(quiet.state.clientCapabilities).toEqual({})
  })

  it('streams progress to the caller when the server answers a call with SSE', async () => {
    const server = await serve({ responseMode: 'sse', only: ['progress_tool'] })
    const client = connect(server)
    await client.start(10_000)
    const seen: McpProgress[] = []
    const result = await client.callTool('progress_tool', { steps: 3 }, 10_000, undefined, { onProgress: (p) => seen.push(p) })
    expect(result.text).toBe('progress-done')
    expect(seen.map((p) => p.message)).toEqual(['passo 1', 'passo 2', 'passo 3'])
    // The token travels in _meta, and it is the request id.
    const call = server.requests.find((request) => request.rpc === 'tools/call')
    expect((call?.params?._meta as { progressToken?: number } | undefined)?.progressToken).toEqual(expect.any(Number))
  })

  it('answers an elicitation request that arrives inside the SSE stream of the call', async () => {
    const server = await serve({ responseMode: 'sse', only: ['ask_user'] })
    const client = connect(server)
    await client.start(10_000)
    const result = await client.callTool('ask_user', {}, 10_000, undefined, {
      onElicit: async () => ({ action: 'accept', content: { project: 'Alfa' } })
    })
    expect(result.text).toBe('elicit:{"action":"accept","content":{"project":"Alfa"}}')
  })

  it('tells the server when a call is cancelled and stops waiting', async () => {
    const server = await serve({ only: ['slow'] })
    const client = connect(server)
    await client.start(10_000)
    const controller = new AbortController()
    const pending = client.callTool('slow', { ms: 5_000 }, 20_000, controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/cancelada/)
    expect(await waitFor(() => server.requests.some((request) => request.rpc === 'notifications/cancelled'))).toBe(true)
    const cancel = server.requests.find((request) => request.rpc === 'notifications/cancelled')
    expect(cancel?.params).toMatchObject({ requestId: expect.any(Number), reason: expect.any(String) })
  })

  it('starts a new session once when the server forgets the old one (404)', async () => {
    const server = await serve({ sessions: true, only: ['echo'] })
    const client = connect(server)
    await client.start(10_000)
    server.expireSessions()
    expect(await client.callTool('echo', { text: 'depois' }, 5_000)).toMatchObject({ ok: true, text: 'echo:depois' })
    const initializes = server.requests.filter((request) => request.rpc === 'initialize')
    expect(initializes).toHaveLength(2)
    expect(initializes[1].sessionId).toBe('')
    const after = server.requests.slice(server.requests.indexOf(initializes[1]))
    expect(after.find((request) => request.rpc === 'tools/call')?.sessionId).toBe('sess-2')
  })

  it('opens the GET stream only when the server announces list changes, and reloads the tools it announces', async () => {
    const quiet = await serve({ listChanged: false, only: ['echo'], listenStream: true })
    await connect(quiet).start(10_000)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(quiet.requests.some((request) => request.method === 'GET')).toBe(false)

    const server = await serve({ listenStream: true, only: ['grow', 'echo'] })
    const changed: string[] = []
    const client = connect(server, { listChangedDebounceMs: 50, onToolsChanged: (kind) => changed.push(kind ?? '') })
    await client.start(10_000)
    expect(await waitFor(() => server.openStreams() === 1)).toBe(true)
    // The server pushes the notification on the GET stream (the call itself is answered as plain JSON).
    await client.callTool('grow', {}, 5_000)
    expect(await waitFor(() => client.toolsList().some((tool) => tool.name === 'late_tool'))).toBe(true)
    expect(changed).toEqual(['tools'])
    server.pushNotification('notifications/tools/list_changed')
    expect(await waitFor(() => changed.length === 2)).toBe(true)
  })

  it('does not insist on a GET stream the server refuses (405)', async () => {
    const server = await serve({ only: ['echo'] })
    const client = connect(server)
    await client.start(10_000)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const gets = server.requests.filter((request) => request.method === 'GET')
    expect(gets.length).toBeLessThanOrEqual(1)
    expect(client.state).toBe('ready')
  })
})

describe('authentication failures', () => {
  it('keeps the OAuth challenge in the error and turns it into a hint', async () => {
    const server = await serve({ requireToken: 'segredo' })
    const client = connect(server)
    await expect(client.start(10_000)).rejects.toThrow(/HTTP 401.*resource_metadata/)
    expect(client.state).toBe('error')
    expect(client.describe().hint).toContain('Entrar com OAuth')
  })

  it('connects once the OAuth token is supplied by the 401 handler', async () => {
    const server = await serve({ requireToken: 'segredo', only: ['echo'] })
    const challenges: Array<string | undefined> = []
    const client = connect(server, {
      onUnauthorized: async (challenge) => {
        challenges.push(challenge)
        return 'segredo'
      }
    })
    await client.start(10_000)
    expect(client.state).toBe('ready')
    expect(challenges).toHaveLength(1)
    expect(challenges[0]).toContain('resource_metadata')
  })

  it('explains the "API token" refusal of the Atlassian server', async () => {
    const server = await serve({ rejectApiToken: true })
    const client = connect(server, { url: server.url, headers: { Authorization: 'Basic abc' } })
    await expect(client.start(10_000)).rejects.toThrow(/API token/)
    const hint = client.describe().hint ?? ''
    expect(hint).toContain('Rovo MCP')
    expect(hint).toContain('Entrar com OAuth')
  })
})

describe('legacy HTTP+SSE transport', () => {
  it('works when the setting says sse', async () => {
    const server = await serve({ legacySse: true, only: ['echo', 'progress_tool'] })
    const client = connect(server, { type: 'sse' })
    await client.start(10_000)
    expect(client.transport).toBe('sse')
    expect(client.toolsList().map((tool) => tool.name)).toEqual(['echo', 'progress_tool'])
    expect((await client.callTool('echo', { text: 'sse' }, 5_000)).text).toBe('echo:sse')
    const seen: McpProgress[] = []
    await client.callTool('progress_tool', { steps: 2 }, 5_000, undefined, { onProgress: (p) => seen.push(p) })
    expect(seen).toHaveLength(2)
    // Messages go to the endpoint the server announced, never to the stream URL.
    expect(server.requests.filter((request) => request.method === 'POST').every((request) => request.rpc !== '')).toBe(true)
  })

  it('is found by falling back when a server of the old transport is configured as plain http', async () => {
    const server = await serve({ legacySse: true, only: ['echo'] })
    const client = connect(server, { type: 'http' })
    await client.start(10_000)
    expect(client.state).toBe('ready')
    expect(client.transport).toBe('sse')
    expect((await client.callTool('echo', { text: 'x' }, 5_000)).text).toBe('echo:x')
    expect(server.requests[0]).toMatchObject({ method: 'POST', rpc: 'initialize' })
  })

  it('falls back to Streamable HTTP when sse is configured against a server that only speaks it', async () => {
    const server = await serve({ only: ['echo'] })
    const client = connect(server, { type: 'sse' })
    await client.start(10_000)
    expect(client.transport).toBe('http')
    expect((await client.callTool('echo', { text: 'y' }, 5_000)).text).toBe('echo:y')
  })

  it('says what each transport answered when neither works (a retired /sse endpoint)', async () => {
    const dead = http.createServer((req, res) => {
      req.resume()
      res.writeHead(req.method === 'GET' ? 410 : 405).end('Gone')
    })
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', () => resolve()))
    try {
      const { port } = dead.address() as AddressInfo
      const client = new McpClient({ name: 'old', type: 'sse', url: `http://127.0.0.1:${port}/sse`, command: '', args: [] })
      clients.push(client)
      await expect(client.start(10_000)).rejects.toThrow(/nenhum transporte MCP funcionou.*HTTP 410.*HTTP 405 em initialize/)
      expect(client.describe().hint).toContain('/mcp')
    } finally {
      await new Promise<void>((resolve) => dead.close(() => resolve()))
    }
  })

  it('reports the loss of the stream as a lost connection', async () => {
    const server = await serve({ legacySse: true, only: ['echo'] })
    const client = connect(server, { type: 'sse' })
    await client.start(10_000)
    await server.close()
    expect(await waitFor(() => client.state === 'error')).toBe(true)
    expect(client.lastError).toContain('conexão perdida')
  })
})

describe('transient failures and reconnection', () => {
  it('retries a first connection that fails with a 5xx', async () => {
    const server = await serve({ failFirst: 2, only: ['echo'] })
    const client = connect(server)
    await client.start(10_000)
    expect(client.state).toBe('ready')
    expect(server.requests.filter((request) => request.rpc === 'initialize').length).toBe(3)
  })

  it('gives up with the HTTP error after three attempts', async () => {
    const server = await serve({ failFirst: 50, only: ['echo'] })
    const client = connect(server)
    await expect(client.start(10_000)).rejects.toThrow(/HTTP 500/)
    expect(server.requests.filter((request) => request.rpc === 'initialize').length).toBe(3)
  })

  it('does not retry a refusal (4xx)', async () => {
    const server = await serve({ requireToken: 'x' })
    await expect(connect(server).start(10_000)).rejects.toThrow(/HTTP 401/)
    expect(server.requests.filter((request) => request.rpc === 'initialize').length).toBe(1)
  })

  it('notices a server that went away, retries with backoff and recovers when it is back', async () => {
    const first = await serve({ only: ['echo', 'plain'] })
    const port = first.port
    const states: string[] = []
    const client = connect(first, {
      reconnect: { baseDelayMs: 100, maxDelayMs: 300, maxAttempts: 8 },
      onStateChange: (c) => states.push(`${c.state}:${c.reconnectAttempt}`)
    })
    await client.start(10_000)
    await first.close()
    // `plain` declares no hint, so it is not repeated: the call fails at once.
    await expect(client.callTool('plain', {}, 5_000)).rejects.toThrow(/falha de rede|indisponível|conexão/)
    expect(client.state === 'error' || client.state === 'starting').toBe(true)
    expect(await waitFor(() => client.reconnectAttempt >= 1)).toBe(true)
    expect(client.describe().hint).toContain('Sem conexão')

    servers.push(await startFakeHttpMcp({ only: ['echo', 'plain'], port }))
    expect(await waitFor(() => client.state === 'ready', 10_000)).toBe(true)
    expect(client.reconnectAttempt).toBe(0)
    expect(states.some((entry) => entry.startsWith('error:'))).toBe(true)
    expect((await client.callTool('echo', { text: 'voltou' }, 5_000)).text).toBe('echo:voltou')
  })

  it('repeats a read-only call once on the new connection when the connection dropped under it', async () => {
    const first = await serve({ only: ['slow', 'echo'], sessions: false })
    const port = first.port
    const client = connect(first, { reconnect: { baseDelayMs: 100, maxAttempts: 8 } })
    await client.start(10_000)
    const pending = client.callTool('slow', { ms: 1_500 }, 20_000)
    setTimeout(() => {
      first.killConnections()
    }, 150)
    setTimeout(() => {
      void first.close().then(async () => {
        servers.push(await startFakeHttpMcp({ only: ['slow', 'echo'], port }))
      })
    }, 250)
    const result = await pending
    expect(result).toMatchObject({ ok: true, text: 'slow-done' })
  })
})

/** Failures that the connector test (scripts/mcp-connectors-test.ts) found against real servers. */
describe('what real connectors answered', () => {
  it('accepts a server that answers a NEWER protocol revision than the one offered (Square answers 2025-11-25)', async () => {
    const server = await serve({ only: ['echo'], forceVersion: '2025-11-25' })
    const client = connect(server)
    await client.start(10_000)
    expect(client.state).toBe('ready')
    expect(client.describe().protocolVersion).toBe('2025-11-25')
    expect(await client.callTool('echo', { text: 'oi' }, 5_000)).toMatchObject({ ok: true, text: 'echo:oi' })
    expect(server.requests.filter((request) => request.rpc !== 'initialize' && request.method === 'POST').every((request) => request.protocolVersion === '2025-11-25')).toBe(true)
  })

  it('still refuses a revision it has never heard of', async () => {
    const server = await serve({ only: ['echo'], forceVersion: '2099-01-01' })
    const client = connect(server)
    await expect(client.start(10_000)).rejects.toThrow(/versão de protocolo MCP não suportada.*2025-11-25/)
  })

  it('says what a CDN answered when the POST ends on an HTML page instead of JSON-RPC (Akamai in front of Credit Karma)', async () => {
    const html = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/mcp') {
          res.writeHead(302, { location: '/Error_Page.htm?ref=18.d1' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!DOCTYPE html><html><head><title>Access Denied</title></head><body>blocked</body></html>')
      })
    })
    await new Promise<void>((resolve) => html.listen(0, '127.0.0.1', () => resolve()))
    const { port } = html.address() as AddressInfo
    const client = new McpClient({ name: 'cdn', type: 'http', url: `http://127.0.0.1:${port}/mcp`, command: '', args: [] })
    clients.push(client)
    const error = await client.start(5_000).then(
      () => '',
      (err: Error) => err.message
    )
    await new Promise<void>((resolve) => html.close(() => resolve()))
    expect(error).toContain('resposta MCP inválida para initialize')
    expect(error).toContain('HTTP 200')
    expect(error).toContain('text/html')
    expect(error).toContain('redirecionado para')
    expect(error).toContain('página HTML')
  })
})
