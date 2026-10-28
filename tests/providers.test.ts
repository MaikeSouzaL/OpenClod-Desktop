import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderHttpError, postStream, readSse } from '../src/core/providers/http'
import { OpenAICompatibleProvider, parseArgs, toOpenAIMessages } from '../src/core/providers/openai'
import { ScriptedProvider } from './support/scripted-provider'
import type {
  Message,
  ModelRequest,
  ProviderConfig,
  ProviderEvent,
  ToolCall
} from '../src/shared/types'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.()
          server.close(() => resolve())
        })
    )
  )
})

interface LocalServer {
  url: string
  hits: () => number
}

async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<LocalServer> {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, hits: () => hits }
}

function sseResponse(res: http.ServerResponse, frames: string[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  for (const frame of frames) res.write(frame)
  res.end()
}

function userMessage(text = 'oi'): Message {
  return { id: 'm1', role: 'user', ts: 1, parts: [{ type: 'text', text }] }
}

function request(messages: Message[] = [userMessage()]): ModelRequest {
  return { system: 'sistema', messages, tools: [] }
}

function providerConfig(baseUrl: string): ProviderConfig {
  return {
    id: 'local-test',
    kind: 'openai',
    label: 'Local Test',
    baseUrl,
    model: 'fake-model',
    contextWindow: 32_000,
    supportsVision: false,
    supportsTools: true,
    temperature: 0.1
  }
}

async function collect(provider: { stream(req: ModelRequest): AsyncGenerator<ProviderEvent> }, req: ModelRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const event of provider.stream(req)) events.push(event)
  return events
}

describe('readSse (SSE framing)', () => {
  async function framesFrom(chunks: string[]) {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
    const frames = []
    for await (const frame of readSse(body)) frames.push(frame)
    return frames
  }

  it('joins multi-line data, keeps events, skips comments and handles CRLF', async () => {
    const frames = await framesFrom([
      ': keepalive\r\n\r\n',
      'event: delta\r\n',
      'data: line one\r\n',
      'data: line two\r\n\r\n',
      'data: [DONE]\r\n\r\n'
    ])
    expect(frames).toEqual([
      { event: 'delta', data: 'line one\nline two' },
      { event: undefined, data: '[DONE]' }
    ])
  })

  it('reassembles frames split across arbitrary byte boundaries', async () => {
    const frames = await framesFrom(['data: {"a"', ':1}\n\ndata: {"b":2}\n\n'])
    expect(frames.map((f) => f.data)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('ignores comment-only blocks and blank data', async () => {
    expect(await framesFrom([': ping\n\n\n\n'])).toEqual([])
  })
})

describe('OpenAICompatibleProvider streaming', () => {
  it('parses text, reasoning, tool calls, usage and [DONE]', async () => {
    const server = await serve((_req, res) => {
      sseResponse(res, [
        'data: {"id":"1","choices":[{"delta":{"reasoning_content":"pensando"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":"Olá"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":" mundo"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"id":"1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
        'data: [DONE]\n\n'
      ])
    })

    const provider = new OpenAICompatibleProvider(providerConfig(`${server.url}/v1`), 'test-key')
    const events = await collect(provider, request())

    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')
    expect(text).toBe('Olá mundo')
    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'pensando' })
    expect(events).toContainEqual({ type: 'tool_call_start', id: 'call_1', name: 'read_file' })
    expect(events).toContainEqual({
      type: 'usage',
      usage: { input: 11, output: 7, cachedInput: 3 }
    })

    const end = events.at(-1)
    expect(end).toMatchObject({ type: 'end', stopReason: 'tool_use' })
    if (end?.type !== 'end') throw new Error('missing end event')
    expect(end.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }])
    expect(server.hits()).toBe(1)
  })

  it('synthesizes usage when the stream omits it', async () => {
    const server = await serve((_req, res) => {
      sseResponse(res, [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    })
    const provider = new OpenAICompatibleProvider(providerConfig(`${server.url}/v1`), 'test-key')
    const events = await collect(provider, request())
    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toBeDefined()
    if (usage?.type === 'usage') {
      expect(usage.usage.input).toBeGreaterThan(0)
      expect(usage.usage.output).toBe(1)
    }
    expect(events.at(-1)).toMatchObject({ type: 'end', stopReason: 'stop' })
  })

  it('surfaces an in-stream error as a retryable end event', async () => {
    const server = await serve((_req, res) => {
      sseResponse(res, ['data: {"error":{"message":"rate limited"}}\n\n'])
    })
    const provider = new OpenAICompatibleProvider(providerConfig(`${server.url}/v1`), 'test-key')
    const events = await collect(provider, request())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'end',
      stopReason: 'error',
      error: 'rate limited',
      retryable: true
    })
  })

  it('throws a non-retryable ProviderHttpError for a 400 response', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"bad request"}')
    })
    const provider = new OpenAICompatibleProvider(providerConfig(`${server.url}/v1`), 'test-key')
    await expect(collect(provider, request())).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 400
    })
    expect(server.hits()).toBe(1)
  })

  it('succeeds without any real API key (local fallback credentials)', async () => {
    const server = await serve((req, res) => {
      expect(req.headers.authorization).toMatch(/^Bearer /)
      sseResponse(res, ['data: {"choices":[{"delta":{"content":"sem chave"}}]}\n\n', 'data: [DONE]\n\n'])
    })
    const provider = new OpenAICompatibleProvider(providerConfig(server.url))
    const events = await collect(provider, request())
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'sem chave')).toBe(true)
  })
})

describe('postStream retry handling', () => {
  it('retries a 500 and then succeeds, reporting the retry', async () => {
    const server = await serve((_req, res) => {
      if (server.hits() === 1) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    const retries: Array<{ attempt: number; message: string; delayMs: number }> = []
    const response = await postStream({
      url: server.url,
      headers: {},
      body: { ping: true },
      maxAttempts: 2,
      baseDelayMs: 100,
      onRetry: (attempt, error, delayMs) => retries.push({ attempt, message: error.message, delayMs })
    })
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('ok')
    expect(server.hits()).toBe(2)
    expect(retries).toHaveLength(1)
    expect(retries[0].attempt).toBe(1)
    // exponential backoff with ±15% jitter
    expect(retries[0].delayMs).toBeGreaterThanOrEqual(85)
    expect(retries[0].delayMs).toBeLessThanOrEqual(115)
  })

  it('does not retry a 401 and exposes retryable=false', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
    })
    let caught: unknown
    try {
      await postStream({ url: server.url, headers: {}, body: {}, maxAttempts: 3 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProviderHttpError)
    expect((caught as ProviderHttpError).status).toBe(401)
    expect((caught as ProviderHttpError).retryable).toBe(false)
    expect(server.hits()).toBe(1)
  })

  it('aborts before issuing a request when the signal is already aborted', async () => {
    const server = await serve((_req, res) => res.end('never'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      postStream({ url: server.url, headers: {}, body: {}, signal: controller.signal })
    ).rejects.toThrow(/aborted/)
    expect(server.hits()).toBe(0)
  })
})

describe('OpenAI message conversion and arg parsing', () => {
  it('maps internal messages to the chat-completions shape', () => {
    const messages: Message[] = [
      userMessage('olá'),
      {
        id: 'a1',
        role: 'assistant',
        ts: 2,
        parts: [
          { type: 'text', text: 'lendo' },
          { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } }
        ]
      },
      {
        id: 't1',
        role: 'tool',
        ts: 3,
        parts: [{ type: 'tool_result', toolCallId: 'c1', name: 'read_file', ok: false, text: 'falhou' }]
      }
    ]
    const out = toOpenAIMessages('sistema', messages)
    expect(out[0]).toEqual({ role: 'system', content: 'sistema' })
    expect(out[1]).toEqual({ role: 'user', content: 'olá' })
    expect(out[2]).toMatchObject({
      role: 'assistant',
      content: 'lendo',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }
      ]
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ERRO: falhou' })
  })

  it('echoes reasoning_content on every assistant turn for DeepSeek V4', () => {
    const messages: Message[] = [
      userMessage('primeiro'),
      {
        id: 'a1',
        role: 'assistant',
        ts: 2,
        parts: [
          { type: 'reasoning', text: 'raciocínio antigo' },
          { type: 'text', text: 'resposta 1' }
        ]
      },
      userMessage('segundo'),
      {
        id: 'a2',
        role: 'assistant',
        ts: 4,
        parts: [{ type: 'text', text: 'resposta 2' }]
      }
    ]

    const out = toOpenAIMessages('', messages, true, true)
    expect(out[1]).toMatchObject({ role: 'assistant', reasoning_content: 'raciocínio antigo' })
    // DeepSeek rejects a missing reasoning_content even when the reasoning was empty.
    expect(out[3]).toMatchObject({ role: 'assistant', reasoning_content: '' })

    // Other thinking providers keep the tighter current-turn echo.
    const loopOnly = toOpenAIMessages('', messages, true, false)
    expect(loopOnly[1].reasoning_content).toBeUndefined()
    expect(loopOnly[3].reasoning_content).toBeUndefined()
  })

  it('drops empty assistant turns and never sends nil tool content', () => {
    // DeepSeek answers "Invalid message content type: <nil>" when a failed
    // turn (no text, no tool calls) is replayed or a tool result is empty.
    const messages: Message[] = [
      userMessage('oi'),
      { id: 'a1', role: 'assistant', ts: 2, parts: [{ type: 'reasoning', text: 'pensando' }] },
      { id: 'a2', role: 'assistant', ts: 3, parts: [{ type: 'text', text: '   ' }], error: 'HTTP 400' },
      {
        id: 'a3',
        role: 'assistant',
        ts: 4,
        parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } }]
      },
      {
        id: 't1',
        role: 'tool',
        ts: 5,
        parts: [{ type: 'tool_result', toolCallId: 'c1', name: 'read_file', ok: true, text: '' }]
      }
    ]

    const out = toOpenAIMessages('', messages)

    expect(out.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(out[1]).toMatchObject({ role: 'assistant', content: null })
    expect(out[1].tool_calls).toHaveLength(1)
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '(sem saída)' })
  })

  it('rebuilds tool results immediately after every assistant tool_calls', () => {
    const messages: Message[] = [
      userMessage('faça'),
      {
        id: 'a1',
        role: 'assistant',
        ts: 2,
        parts: [
          { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } },
          { type: 'tool_call', id: 'c2', name: 'read_file', args: { path: 'b' } }
        ]
      },
      { id: 'u2', role: 'user', ts: 3, parts: [{ type: 'text', text: 'instrução no meio' }] },
      {
        id: 't1',
        role: 'tool',
        ts: 4,
        parts: [
          { type: 'tool_result', toolCallId: 'c1', name: 'read_file', ok: true, text: 'A' },
          { type: 'tool_result', toolCallId: 'c2', name: 'read_file', ok: true, text: 'B' }
        ]
      }
    ]
    const out = toOpenAIMessages('', messages)
    expect(out.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'A' })
    expect(out[3]).toMatchObject({ role: 'tool', tool_call_id: 'c2', content: 'B' })
  })

  it('synthesizes a missing result instead of leaving an orphan tool_call', () => {
    const messages: Message[] = [
      userMessage('faça'),
      {
        id: 'a1',
        role: 'assistant',
        ts: 2,
        parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } }]
      }
    ]
    const out = toOpenAIMessages('', messages)
    expect(out.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(String(out[2].content)).toMatch(/Resultado ausente/i)
  })

  it('parses JSON, repairs trailing commas and preserves raw payloads', () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 })
    expect(parseArgs('{"a":1,}')).toEqual({ a: 1 })
    expect(parseArgs('')).toEqual({})
    expect(parseArgs('{broken')).toEqual({ __raw: '{broken' })
  })
})

describe('ScriptedProvider', () => {
  it('exposes deterministic identity and says plainly it is a test double when out of script', async () => {
    const provider = new ScriptedProvider([])
    expect(provider.id).toBe('test-double')
    expect(provider.label).toBe('Duplo de teste')
    expect(provider.remaining).toBe(0)

    const events = await collect(provider, request())
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toContain('duplo de teste')
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'stop', toolCalls: [] })
  })

  it('streams text in deterministic chunks and records the request', async () => {
    const provider = new ScriptedProvider([{ text: 'abcdef', usage: { input: 2, output: 3 } }], 4)
    const req = request()
    const events = await collect(provider, req)
    expect(events).toEqual([
      { type: 'text_delta', text: 'abcd' },
      { type: 'text_delta', text: 'ef' },
      { type: 'usage', usage: { input: 2, output: 3 } },
      { type: 'end', stopReason: 'stop', toolCalls: [] }
    ])
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].system).toBe('sistema')
    // structuredClone: stored request is independent of the caller's object
    req.system = 'mutado'
    expect(provider.requests[0].system).toBe('sistema')
  })

  it('emits tool calls and defaults stopReason to tool_use', async () => {
    const calls: ToolCall[] = [{ id: 'c1', name: 'read_file', args: { path: 'a' } }]
    const provider = new ScriptedProvider([{ toolCalls: calls }])
    const events = await collect(provider, request())
    expect(events).toContainEqual({ type: 'tool_call_start', id: 'c1', name: 'read_file' })
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'tool_use', toolCalls: calls })
  })

  it('can emit an error end event or throw, and push() extends the queue', async () => {
    const provider = new ScriptedProvider([{ error: 'falha simulada', retryable: true }])
    const events = await collect(provider, request())
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      stopReason: 'error',
      error: 'falha simulada',
      retryable: true
    })

    provider.push({ text: 'depois' })
    expect(provider.remaining).toBe(1)
    const after = await collect(provider, request())
    expect(after.some((e) => e.type === 'text_delta' && e.text === 'depois')).toBe(true)

    const throwing = new ScriptedProvider([{ throw: 'explodiu' }])
    await expect(collect(throwing, request())).rejects.toThrow('explodiu')
    expect(throwing.remaining).toBe(0)
  })
})
