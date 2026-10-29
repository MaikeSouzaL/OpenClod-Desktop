import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverForProvider, discoverModels, inferDiscoveryKind, openAiModelsUrl } from '../src/core/providers/discovery'

/**
 * Discovery talks to throwaway local HTTP servers that imitate the shape of
 * Ollama, LM Studio, OpenAI-compatible and Anthropic model listings. Nothing
 * here reaches the network.
 */

interface Recorded {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: unknown
}

interface Fake {
  url: string
  requests: Recorded[]
}

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

type Reply = (req: Recorded, res: http.ServerResponse) => void

async function serve(reply: Reply): Promise<Fake> {
  const requests: Recorded[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw || undefined
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        /* keep raw */
      }
      const recorded: Recorded = { method: req.method ?? 'GET', path: req.url ?? '', headers: req.headers, body }
      requests.push(recorded)
      reply(recorded, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests }
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const pathOf = (req: Recorded): string => req.path.split('?')[0]

describe('discoverModels: Ollama', () => {
  const SHOW: Record<string, unknown> = {
    'llama3:8b': { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 } },
    'nomic-embed-text': { capabilities: ['embedding'], model_info: { 'bert.context_length': 2048 } },
    'qwen3-vl:8b': {
      capabilities: ['completion', 'tools', 'vision'],
      model_info: { 'qwen3vl.context_length': 262144 },
      // The Modelfile's num_ctx is what Ollama really allocates.
      parameters: 'temperature 0.7\nnum_ctx 16384'
    }
  }

  function ollama(): Promise<Fake> {
    return serve((req, res) => {
      if (req.method === 'GET' && pathOf(req) === '/api/tags') {
        return json(res, { models: Object.keys(SHOW).map((name) => ({ name, model: name, digest: 'x', size: 1 })) })
      }
      if (req.method === 'POST' && pathOf(req) === '/api/show') {
        const model = (req.body as { model: string }).model
        return SHOW[model] ? json(res, SHOW[model]) : json(res, { error: 'model not found' }, 404)
      }
      json(res, { error: 'not found' }, 404)
    })
  }

  it('lists chat models with context window and capabilities, skipping embedding models', async () => {
    const fake = await ollama()
    // The OpenAI-compatible base URL (/v1) is what users have configured.
    const result = await discoverModels({ kind: 'ollama', baseUrl: `${fake.url}/v1` })

    expect(result.error).toBeUndefined()
    expect(result.source).toBe('ollama')
    expect(result.models).toEqual([
      { id: 'llama3:8b', contextWindow: 8192, supportsVision: false, supportsTools: true },
      { id: 'qwen3-vl:8b', contextWindow: 16384, supportsVision: true, supportsTools: true }
    ])
    expect(fake.requests.map((r) => `${r.method} ${pathOf(r)}`)).toEqual(
      expect.arrayContaining(['GET /api/tags', 'POST /api/show'])
    )
    expect(fake.requests.filter((r) => pathOf(r) === '/api/show')).toHaveLength(3)
    expect(fake.requests[0].headers.authorization).toBeUndefined()
  })

  it('derives the root from a base URL with a path prefix and sends the Bearer key', async () => {
    const fake = await serve((req, res) => {
      if (pathOf(req) === '/proxy/api/tags') return json(res, { models: [{ name: 'phi4', model: 'phi4' }] })
      if (pathOf(req) === '/proxy/api/show') return json(res, { capabilities: ['completion'], model_info: { 'phi3.context_length': 16384 } })
      json(res, {}, 404)
    })
    const result = await discoverModels({ kind: 'ollama', baseUrl: `${fake.url}/proxy/v1/`, apiKey: 'sekret-123' })

    expect(result.models).toEqual([{ id: 'phi4', contextWindow: 16384, supportsVision: false, supportsTools: false }])
    expect(fake.requests.every((r) => r.headers.authorization === 'Bearer sekret-123')).toBe(true)
  })

  it('keeps a model when /api/show fails for it, and bounds the show concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const names = Array.from({ length: 10 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const fake = await serve((req, res) => {
      if (pathOf(req) === '/api/tags') return json(res, { models: names.map((name) => ({ name, model: name })) })
      inFlight++
      peak = Math.max(peak, inFlight)
      setTimeout(() => {
        inFlight--
        const model = (req.body as { model: string }).model
        if (model === 'm03') return json(res, { error: 'boom' }, 500)
        json(res, { capabilities: ['completion'], model_info: { 'x.context_length': 4096 } })
      }, 40)
    })
    const result = await discoverModels({ kind: 'ollama', baseUrl: fake.url })

    expect(result.error).toBeUndefined()
    expect(result.models.map((m) => m.id)).toEqual(names)
    expect(result.models.find((m) => m.id === 'm03')).toEqual({ id: 'm03' })
    expect(result.models.find((m) => m.id === 'm04')?.contextWindow).toBe(4096)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('reports a refused connection in Portuguese instead of throwing', async () => {
    const fake = await serve((_req, res) => json(res, {}))
    const url = fake.url
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()))

    const result = await discoverModels({ kind: 'ollama', baseUrl: `${url}/v1` })
    expect(result.models).toEqual([])
    expect(result.source).toBe('ollama')
    expect(result.error).toMatch(/Não foi possível conectar/)
  })
})

describe('discoverModels: LM Studio', () => {
  it('reads /api/v1/models, using the loaded context when an instance is loaded', async () => {
    const fake = await serve((req, res) => {
      if (pathOf(req) !== '/api/v1/models') return json(res, {}, 404)
      json(res, {
        models: [
          {
            type: 'llm',
            key: 'qwen/qwen3-coder-30b',
            display_name: 'Qwen3 Coder',
            loaded_instances: [{ config: { context_length: 32768 } }, { config: { context_length: 16384 } }],
            max_context_length: 262144,
            capabilities: { vision: false, trained_for_tool_use: true }
          },
          {
            type: 'llm',
            key: 'google/gemma-3-12b',
            loaded_instances: [],
            max_context_length: 131072,
            capabilities: { vision: true, trained_for_tool_use: false }
          },
          { type: 'embedding', key: 'text-embedding-nomic', loaded_instances: [], max_context_length: 2048 }
        ]
      })
    })
    const result = await discoverModels({ kind: 'lmstudio', baseUrl: `${fake.url}/v1` })

    expect(result.error).toBeUndefined()
    expect(result.source).toBe('lmstudio')
    expect(result.models).toEqual([
      { id: 'google/gemma-3-12b', contextWindow: 131072, supportsVision: true, supportsTools: false },
      { id: 'qwen/qwen3-coder-30b', contextWindow: 16384, supportsVision: false, supportsTools: true }
    ])
    expect(fake.requests).toHaveLength(1)
  })

  it('falls back to <baseUrl>/models when the native endpoint does not exist', async () => {
    const fake = await serve((req, res) => {
      if (pathOf(req) === '/v1/models') return json(res, { object: 'list', data: [{ id: 'old-model' }, { id: 'another' }] })
      json(res, { error: 'Unexpected endpoint' }, 404)
    })
    const result = await discoverModels({ kind: 'lmstudio', baseUrl: `${fake.url}/v1` })

    expect(result.models).toEqual([{ id: 'another' }, { id: 'old-model' }])
    expect(fake.requests.map(pathOf)).toEqual(['/api/v1/models', '/v1/models'])
  })

  it('does not try the fallback after an authorization failure', async () => {
    const fake = await serve((_req, res) => json(res, { error: 'no' }, 401))
    const result = await discoverModels({ kind: 'lmstudio', baseUrl: `${fake.url}/v1`, apiKey: 'bad' })

    expect(result.models).toEqual([])
    expect(result.error).toMatch(/Acesso negado \(HTTP 401\)/)
    expect(fake.requests).toHaveLength(1)
  })
})

describe('discoverModels: OpenAI-compatible', () => {
  it('GETs <baseUrl>/models with a Bearer key and reads extra metadata when offered', async () => {
    const fake = await serve((req, res) => {
      if (pathOf(req) !== '/v1/models') return json(res, {}, 404)
      json(res, {
        object: 'list',
        data: [
          { id: 'zeta' },
          {
            id: 'anthropic/claude-sonnet',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'temperature']
          },
          { id: 'text-only', context_length: 32000, architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'] },
          { id: 'zeta' },
          { object: 'model' }
        ]
      })
    })
    const result = await discoverModels({ kind: 'openai', baseUrl: `${fake.url}/v1`, apiKey: 'sk-test' })

    expect(result.error).toBeUndefined()
    expect(result.source).toBe('openai')
    expect(result.models).toEqual([
      { id: 'anthropic/claude-sonnet', contextWindow: 200000, supportsVision: true, supportsTools: true },
      { id: 'text-only', contextWindow: 32000, supportsVision: false, supportsTools: false },
      { id: 'zeta' }
    ])
    expect(fake.requests[0].method).toBe('GET')
    expect(fake.requests[0].headers.authorization).toBe('Bearer sk-test')
  })

  it('sends no Authorization header without a key', async () => {
    const fake = await serve((_req, res) => json(res, { data: [{ id: 'm' }] }))
    await discoverModels({ kind: 'openai', baseUrl: fake.url })
    expect(fake.requests[0].headers.authorization).toBeUndefined()
    expect(fake.requests[0].path).toBe('/models')
  })

  it('maps HTTP failures to messages that never contain the API key', async () => {
    const key = 'sk-very-secret-key-123456'
    const fake = await serve((_req, res) => json(res, { error: { message: `Incorrect API key provided: ${key}` } }, 401))
    const result = await discoverModels({ kind: 'openai', baseUrl: `${fake.url}/v1`, apiKey: key })

    expect(result.models).toEqual([])
    expect(result.error).toMatch(/Acesso negado \(HTTP 401\)/)
    expect(result.error).not.toContain(key)
  })

  it('rejects bodies that are not a model list', async () => {
    const html = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>hello</html>')
    })
    const odd = await serve((_req, res) => json(res, { hello: 'world' }))

    expect((await discoverModels({ kind: 'openai', baseUrl: html.url })).error).toMatch(/não é JSON/)
    expect((await discoverModels({ kind: 'openai', baseUrl: odd.url })).error).toMatch(/sem lista de modelos/)
  })
})

describe('discoverModels: Anthropic', () => {
  it('sends x-api-key and anthropic-version, follows pagination and reads vision/context', async () => {
    const fake = await serve((req, res) => {
      if (pathOf(req) !== '/v1/models') return json(res, {}, 404)
      const after = new URL(req.path, 'http://x').searchParams.get('after_id')
      if (!after) {
        return json(res, {
          data: [
            { id: 'claude-sonnet-x', type: 'model', max_input_tokens: 1000000, capabilities: { image_input: { supported: true } } },
            { id: 'claude-haiku-x', type: 'model', max_input_tokens: 200000, capabilities: { image_input: { supported: false } } }
          ],
          has_more: true,
          last_id: 'claude-haiku-x'
        })
      }
      json(res, { data: [{ id: 'claude-legacy', type: 'model' }], has_more: false, last_id: 'claude-legacy' })
    })
    const result = await discoverModels({ kind: 'anthropic', baseUrl: `${fake.url}/v1`, apiKey: 'sk-ant-test' })

    expect(result.error).toBeUndefined()
    expect(result.source).toBe('anthropic')
    expect(result.models).toEqual([
      { id: 'claude-haiku-x', contextWindow: 200000, supportsVision: false },
      { id: 'claude-legacy' },
      { id: 'claude-sonnet-x', contextWindow: 1000000, supportsVision: true }
    ])
    expect(fake.requests).toHaveLength(2)
    for (const request of fake.requests) {
      expect(request.headers['x-api-key']).toBe('sk-ant-test')
      expect(request.headers['anthropic-version']).toBe('2023-06-01')
      expect(request.headers.authorization).toBeUndefined()
    }
    expect(fake.requests[1].path).toContain('after_id=claude-haiku-x')
  })

  it('adds /v1 when the base URL does not end with a version', async () => {
    const fake = await serve((req, res) => (pathOf(req) === '/v1/models' ? json(res, { data: [{ id: 'm' }] }) : json(res, {}, 404)))
    const result = await discoverModels({ kind: 'anthropic', baseUrl: fake.url, apiKey: 'k' })
    expect(result.models).toEqual([{ id: 'm' }])
  })
})

describe('discoverModels: failure handling', () => {
  it('times out quickly on a server that never answers', async () => {
    const fake = await serve(() => {
      /* never reply */
    })
    const started = Date.now()
    const result = await discoverModels({ kind: 'openai', baseUrl: fake.url }, { timeoutMs: 150 })

    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.models).toEqual([])
    expect(result.error).toMatch(/Tempo esgotado/)
  })

  it('returns an error for unusable base URLs without throwing', async () => {
    for (const baseUrl of ['', 'not a url', 'ftp://example.com', undefined as unknown as string]) {
      const result = await discoverModels({ kind: 'openai', baseUrl })
      expect(result.models).toEqual([])
      expect(result.error).toMatch(/URL base inválida/)
    }
  })

  it('uses an injected fetch and survives it throwing', async () => {
    const calls: string[] = []
    const ok: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ data: [{ id: 'from-stub' }] }), { status: 200 })
    }
    expect((await discoverModels({ kind: 'openai', baseUrl: 'http://stub.invalid/v1' }, { fetch: ok })).models).toEqual([{ id: 'from-stub' }])
    expect(calls).toEqual(['http://stub.invalid/v1/models'])

    const boom: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const failed = await discoverModels({ kind: 'ollama', baseUrl: 'http://stub.invalid' }, { fetch: boom })
    expect(failed.models).toEqual([])
    expect(failed.error).toMatch(/Não foi possível conectar/)
  })

  it('can be cancelled with a signal', async () => {
    const fake = await serve(() => {
      /* never reply */
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await discoverModels({ kind: 'openai', baseUrl: fake.url }, { signal: controller.signal, timeoutMs: 10_000 })
    expect(result.error).toMatch(/cancelada/)
  })
})

describe('discoverForProvider', () => {
  it('infers the protocol from the saved provider and forwards the resolved key', async () => {
    const fake = await serve((req, res) => {
      if (pathOf(req) === '/v1/models') return json(res, { data: [{ id: 'claude-x', max_input_tokens: 200000 }] })
      json(res, {}, 404)
    })
    const anthropic = await discoverForProvider({ kind: 'anthropic', baseUrl: `${fake.url}/v1` }, 'sk-ant-1')
    expect(anthropic).toEqual({ models: [{ id: 'claude-x', contextWindow: 200000 }], source: 'anthropic' })
    expect(fake.requests[0].headers['x-api-key']).toBe('sk-ant-1')

    // An empty resolved key means "no key": no Authorization header at all.
    const openai = await discoverForProvider({ kind: 'openai', baseUrl: `${fake.url}/v1` }, '')
    expect(openai.source).toBe('openai')
    expect(fake.requests[1].headers.authorization).toBeUndefined()
  })
})

describe('openAiModelsUrl', () => {
  it('lists most servers at <baseUrl>/models', () => {
    expect(openAiModelsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/models')
    expect(openAiModelsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/models')
  })

  it('points OpenCode at its /zen/v1/models catalog (the chat base returns 404 for /models)', () => {
    expect(openAiModelsUrl('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/zen/v1/models')
    expect(openAiModelsUrl('https://opencode.ai/inference/openai/v1')).toBe('https://opencode.ai/zen/v1/models')
  })

  it('falls back to the default when the base URL is not parseable', () => {
    expect(openAiModelsUrl('not a url')).toBe('not a url/models')
  })
})

describe('inferDiscoveryKind', () => {
  it('maps provider configs to a discovery protocol', () => {
    expect(inferDiscoveryKind({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe('anthropic')
    expect(inferDiscoveryKind({ kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' })).toBe('ollama')
    expect(inferDiscoveryKind({ kind: 'openai', baseUrl: 'http://localhost:1234/v1' })).toBe('lmstudio')
    expect(inferDiscoveryKind({ kind: 'openai', baseUrl: 'https://api.deepseek.com/v1' })).toBe('openai')
    expect(inferDiscoveryKind({ kind: 'ollama', baseUrl: 'http://example.com' })).toBe('ollama')
  })
})
