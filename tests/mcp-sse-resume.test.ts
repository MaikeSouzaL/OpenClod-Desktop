import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClient } from '../src/core/mcp/client'
import { SseParser } from '../src/core/mcp/sse'

describe('SseParser', () => {
  it('keeps the last event id from event to event and reads retry', () => {
    const parser = new SseParser()
    const events = parser.push('id: 7\nretry: 1500\ndata: a\n\ndata: b\n\n')
    expect(events.map((event) => [event.data, event.id])).toEqual([
      ['a', '7'],
      ['b', undefined]
    ])
    // The event without its own id does not erase where the stream is.
    expect(parser.lastEventId).toBe('7')
    expect(parser.retryMs).toBe(1500)
    parser.push('retry: lento\nid: x\u0000y\ndata: c\n\n')
    expect(parser.retryMs).toBe(1500)
    expect(parser.lastEventId).toBe('7')
  })
})

/**
 * A Streamable HTTP server whose answer to tools/call is an SSE stream that drops after the first event; a GET with
 * `Last-Event-ID` resumes it and delivers the answer.
 */
async function droppingServer(): Promise<{ url: string; resumes: Array<string | undefined>; close(): Promise<void> }> {
  const resumes: Array<string | undefined> = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      resumes.push(req.headers['last-event-id'] as string | undefined)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`id: 2\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: pendingId, result: { content: [{ type: 'text', text: 'retomado' }] } })}\n\n`)
      return
    }
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string }
      if (message.id === undefined) return void res.writeHead(202).end()
      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cai', version: '1' } } }))
      }
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'lento', description: 'x', inputSchema: { type: 'object' } }] } }))
      }
      if (message.method === 'tools/call') {
        pendingId = message.id
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`retry: 50\nid: 1\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.id, progress: 1, message: 'metade' } })}\n\n`)
        // The connection drops before the answer.
        setTimeout(() => res.socket?.destroy(), 30)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
    })
  })
  let pendingId = 0
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, resumes, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step().catch(() => undefined)
})

describe('Streamable HTTP resumability', () => {
  it('resumes a dropped answer stream with Last-Event-ID instead of failing the call', async () => {
    const server = await droppingServer()
    cleanup.push(server.close)
    const client = new McpClient({ name: 'cai', type: 'http', url: server.url, command: '', args: [] })
    cleanup.push(() => client.stop(200))
    await client.start(10_000)
    const result = await client.callTool('lento', {}, 10_000)
    expect(result).toMatchObject({ ok: true, text: 'retomado' })
    expect(server.resumes).toEqual(['1'])
  })
})
