import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo, Socket } from 'node:net'

/**
 * Fake MCP server over HTTP for the tests: Streamable HTTP (JSON or SSE answers, sessions, 404 on an expired
 * session, GET notification stream, DELETE) and the legacy HTTP+SSE transport, with an optional 401 challenge
 * (resource_metadata) or the Atlassian "API token" refusal. Test double only; never part of the app.
 */

export interface FakeMcpOptions {
  name?: string
  version?: string
  versions?: string[]
  pageSize?: number
  toolCount?: number
  only?: string[] | null
  resources?: boolean
  prompts?: boolean
  listChanged?: boolean
  instructions?: string
  initializeDelayMs?: number
  hangOnInitialize?: boolean
  failInitialize?: { code: number; message: string; data?: unknown } | null
  forceVersion?: string | null
  alwaysError?: string | null
  extraTools?: Array<Record<string, unknown>>
  capabilities?: Record<string, unknown>
  [key: string]: unknown
}

export interface FakeHttpOptions extends FakeMcpOptions {
  /** How POST answers travel: one JSON body (default) or an SSE stream. */
  responseMode?: 'json' | 'sse'
  /** Issue an Mcp-Session-Id on initialize and require it afterwards. */
  sessions?: boolean
  /** Speak the legacy HTTP+SSE transport (GET /sse + POST /messages); POST on /mcp answers 405. */
  legacySse?: boolean
  /** Answer 401 + `WWW-Authenticate: Bearer resource_metadata=...` unless this bearer token is presented. */
  requireToken?: string
  /** Answer 401 "You don't have permission to connect via API token" to any request carrying Authorization. */
  rejectApiToken?: boolean
  /** Offer the GET notification stream (otherwise GET answers 405). */
  listenStream?: boolean
  /** Answer 500 to the first N requests (transient failure). */
  failFirst?: number
  /** Listen on this port (to bring a server back where a closed one used to be). */
  port?: number
}

export interface RecordedRequest {
  method: string
  rpc: string
  sessionId: string
  authorization: string
  protocolVersion: string
  accept: string
  params?: Record<string, unknown>
}

export interface FakeHttpMcp {
  url: string
  port: number
  requests: RecordedRequest[]
  state: { calls: Array<{ name: string; args: Record<string, unknown> }>; methods: string[]; negotiated: string | null; clientCapabilities: Record<string, unknown> | null }
  /** Makes every known session id answer 404 from now on. */
  expireSessions(): void
  /** Pushes a notification on the GET stream(s) / legacy stream(s). */
  pushNotification(method: string, params?: unknown): void
  /** Number of open GET/legacy streams. */
  openStreams(): number
  /** Drops every open connection without answering. */
  killConnections(): void
  close(): Promise<void>
}

interface FakeCore {
  state: FakeHttpMcp['state'] & { cancelled: unknown[]; tools: unknown[] }
  handle(
    message: Record<string, unknown>,
    ctx: {
      notify(method: string, params: unknown): void
      sendRequest(method: string, params: unknown): Promise<unknown>
      die?: () => void
    }
  ): Promise<Record<string, unknown> | null>
}

const nodeRequire = createRequire(import.meta.url)
const { createFakeMcp } = nodeRequire('./fake-mcp-core.cjs') as { createFakeMcp(options?: object): FakeCore }

export async function startFakeHttpMcp(options: FakeHttpOptions = {}): Promise<FakeHttpMcp> {
  const core = createFakeMcp(options)
  const requests: RecordedRequest[] = []
  const sockets = new Set<Socket>()
  const streams = new Set<http.ServerResponse>()
  const legacy = new Map<string, http.ServerResponse>()
  const sessions = new Set<string>()
  let sessionCounter = 0
  let failures = options.failFirst ?? 0
  let origin = ''

  const serverRequestWaiters = new Map<string | number, (value: unknown) => void>()
  let serverRequestId = 0

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => void route(req, res, url, body))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const header = (req: http.IncomingMessage, name: string): string => String(req.headers[name] ?? '')

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string): Promise<void> {
    const sessionId = header(req, 'mcp-session-id')
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null
    } catch {
      parsed = null
    }
    requests.push({
      method: req.method ?? '',
      rpc: String(parsed?.method ?? ''),
      sessionId,
      authorization: header(req, 'authorization'),
      protocolVersion: header(req, 'mcp-protocol-version'),
      accept: header(req, 'accept'),
      params: (parsed?.params as Record<string, unknown> | undefined) ?? undefined
    })

    // Authentication.
    if (options.rejectApiToken && header(req, 'authorization')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: "You don't have permission to connect via API token. The token is missing the scope claim." }))
      return
    }
    if (options.requireToken && header(req, 'authorization') !== `Bearer ${options.requireToken}`) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
      })
      res.end('{"error":"invalid_token"}')
      return
    }
    if (failures > 0) {
      failures--
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('transient failure')
      return
    }

    // Legacy HTTP+SSE transport.
    if (options.legacySse) {
      if (req.method === 'GET' && url.pathname === '/sse') return openLegacyStream(res)
      if (req.method === 'POST' && url.pathname === '/messages') return legacyPost(res, url, parsed)
      res.writeHead(405).end()
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }

    if (req.method === 'GET') {
      if (!options.listenStream) {
        res.writeHead(405).end()
        return
      }
      if (options.sessions && !sessions.has(sessionId)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(': stream open\n\n')
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }

    if (req.method === 'DELETE') {
      sessions.delete(sessionId)
      res.writeHead(200).end()
      return
    }

    if (req.method !== 'POST' || !parsed) {
      res.writeHead(400).end()
      return
    }

    // Session handling.
    const isInitialize = parsed.method === 'initialize'
    if (options.sessions && !isInitialize && !sessions.has(sessionId)) {
      res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' } }))
      return
    }

    // Responses to server -> client requests (elicitation).
    if (parsed.id !== undefined && parsed.method === undefined) {
      const waiter = serverRequestWaiters.get(parsed.id as string | number)
      serverRequestWaiters.delete(parsed.id as string | number)
      waiter?.(parsed.result ?? { error: parsed.error })
      res.writeHead(202).end()
      return
    }

    const isRequest = parsed.id !== undefined && parsed.id !== null
    const sse = options.responseMode === 'sse'
    const newSession = isInitialize && options.sessions ? `sess-${++sessionCounter}` : ''
    const sessionHeaders: Record<string, string> = newSession ? { 'mcp-session-id': newSession } : {}
    let streaming = false
    const writeEvent = (message: unknown): void => {
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...sessionHeaders })
        streaming = true
      }
      res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    }

    const ctx = {
      notify: (method: string, params: unknown): void => {
        if (sse && isRequest) writeEvent({ jsonrpc: '2.0', method, params })
        else broadcast({ jsonrpc: '2.0', method, params })
      },
      sendRequest: (method: string, params: unknown): Promise<unknown> =>
        new Promise((resolve) => {
          const id = `srv-${++serverRequestId}`
          serverRequestWaiters.set(id, resolve)
          const message = { jsonrpc: '2.0', id, method, params }
          if (sse && isRequest) writeEvent(message)
          else broadcast(message)
        })
    }

    const response = await core.handle(parsed, ctx)
    if (!isRequest) {
      res.writeHead(202).end()
      return
    }
    if (!response) {
      // The server chose not to answer (hang): close the connection when the client gives up.
      if (streaming) res.end()
      return
    }
    if (newSession && !response.error) sessions.add(newSession)
    if (sse) {
      writeEvent(response)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', ...sessionHeaders })
    res.end(JSON.stringify(response))
  }

  function broadcast(message: unknown): void {
    for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    for (const stream of legacy.values()) stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }

  function openLegacyStream(res: http.ServerResponse): void {
    const id = `L${legacy.size + 1}`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`)
    legacy.set(id, res)
    res.on('close', () => legacy.delete(id))
  }

  function legacyPost(res: http.ServerResponse, url: URL, parsed: Record<string, unknown> | null): void {
    const stream = legacy.get(url.searchParams.get('sessionId') ?? '')
    if (!stream || !parsed) {
      res.writeHead(400).end()
      return
    }
    res.writeHead(202, { 'content-type': 'text/plain' }).end('Accepted')
    if (parsed.id !== undefined && parsed.method === undefined) {
      const waiter = serverRequestWaiters.get(parsed.id as string | number)
      serverRequestWaiters.delete(parsed.id as string | number)
      waiter?.(parsed.result ?? { error: parsed.error })
      return
    }
    const ctx = {
      notify: (method: string, params: unknown): void => {
        stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`)
      },
      sendRequest: (method: string, params: unknown): Promise<unknown> =>
        new Promise((resolve) => {
          const id = `srv-${++serverRequestId}`
          serverRequestWaiters.set(id, resolve)
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n\n`)
        })
    }
    void core.handle(parsed, ctx).then((response) => {
      if (response) stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`)
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${port}`

  return {
    url: options.legacySse ? `${origin}/sse` : `${origin}/mcp`,
    port,
    requests,
    state: core.state,
    expireSessions: () => sessions.clear(),
    pushNotification: (method, params) => broadcast({ jsonrpc: '2.0', method, params: params ?? {} }),
    openStreams: () => streams.size + legacy.size,
    killConnections: () => {
      for (const socket of sockets) socket.destroy()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of [...streams, ...legacy.values()]) stream.end()
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}
