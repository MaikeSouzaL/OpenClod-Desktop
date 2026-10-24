import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClient, parseRpcResponse } from '../src/core/mcp/client'

let server: http.Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
    server = null
  })
})

describe('MCP over Streamable HTTP', () => {
  it('initializes, echoes the session id, lists tools over SSE and calls one', async () => {
    const seen: Array<{ method: string; session?: string; auth?: string }> = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const message = JSON.parse(body || '{}') as { id?: number; method?: string; params?: { name?: string } }
        seen.push({
          method: message.method ?? req.method ?? '',
          session: String(req.headers['mcp-session-id'] ?? ''),
          auth: String(req.headers.authorization ?? '')
        })
        if (req.method === 'DELETE') {
          res.writeHead(200).end()
          return
        }
        if (message.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-42' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05' } }))
          return
        }
        if (message.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: [
                  { name: 'search', description: 'busca', inputSchema: { type: 'object', properties: {} } },
                  { name: 'create', description: 'cria', inputSchema: { type: 'object', properties: {} } }
                ]
              }
            })}\n\n`
          )
          return
        }
        if (message.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: `ok:${message.params?.name}` }] }
            })
          )
          return
        }
        res.writeHead(202).end()
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    const client = new McpClient({
      name: 'fake-remote',
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer test-token' },
      command: '',
      args: [],
      enabled: true
    })

    await client.start()
    expect(client.state).toBe('ready')
    expect(client.toolsList().map((tool) => tool.name)).toEqual(['search', 'create'])
    const result = await client.callTool('create', { title: 'x' })
    expect(result).toMatchObject({ ok: true, text: 'ok:create' })
    expect(seen.find((entry) => entry.method === 'initialize')?.auth).toBe('Bearer test-token')
    expect(seen.filter((entry) => entry.method !== 'initialize').every((entry) => entry.session === 'sess-42')).toBe(true)

    await client.stop()
    expect(await client.callTool('create', {}).catch((err: Error) => err.message)).toContain('não iniciado')
  })

  it('surfaces an HTTP error with the method and status', async () => {
    server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"missing token"}')
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    const client = new McpClient({
      name: 'denied',
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      command: '',
      args: [],
      enabled: true,
      startTimeoutMs: 5000
    })
    await expect(client.start()).rejects.toThrow(/HTTP 401/)
    expect(client.state).toBe('error')
    expect(client.lastError).toContain('401')
  })

  it('parses JSON and SSE bodies and ignores unrelated events', () => {
    expect(parseRpcResponse('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}', 3)).toMatchObject({ id: 3 })
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}',
      ''
    ].join('\n')
    expect(parseRpcResponse(sse, 7)).toMatchObject({ id: 7, result: { tools: [] } })
    expect(parseRpcResponse('not-json', 1)).toBeNull()
  })
})
