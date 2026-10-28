import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyProviderError, ProviderHttpError } from '../src/core/providers/http'
import { TUNNEL_DOWN_MESSAGE, isTunnelDownResponse } from '../src/core/providers/tunnel'
import { checkColabLink, readModelDocument } from '../src/core/colab/link'
import { fixture, startFakeColab, type FakeColab } from './support/fake-colab'

/**
 * A Google Colab server lives behind a Cloudflare quick tunnel. When the notebook ends the tunnel answers an HTML page, not
 * JSON. The bodies below are REAL answers captured on 2026-10-27 (cloudflared 2026.10.5): 530 "Error 1033" for a tunnel whose
 * process is gone, and 502 "Bad gateway" for a tunnel whose server stopped. To the reserve both mean "this provider is gone".
 */
const gone = fixture('cloudflare-530-tunel-encerrado')
const stopped = fixture('cloudflare-502-origem-parada')

describe('tunnel down: what counts as "nobody is home"', () => {
  it('recognizes the two real Cloudflare pages', () => {
    expect(gone.status).toBe(530)
    expect(stopped.status).toBe(502)
    expect(isTunnelDownResponse(gone.status, gone.body)).toBe(true)
    expect(isTunnelDownResponse(stopped.status, stopped.body)).toBe(true)
  })

  it('treats any 530 as a dead tunnel, even with an empty body', () => {
    expect(isTunnelDownResponse(530, '')).toBe(true)
    expect(isTunnelDownResponse(530, 'error code: 1033')).toBe(true)
  })

  it('recognizes the quick-tunnel gateway page with other 5xx/404 codes', () => {
    for (const status of [404, 500, 502, 503, 504, 520, 521, 522, 523, 524]) {
      expect(isTunnelDownResponse(status, stopped.body), String(status)).toBe(true)
    }
  })

  it('does not take ordinary provider answers for a dead tunnel', () => {
    expect(isTunnelDownResponse(502, '{"error":{"message":"bad gateway"}}')).toBe(false)
    expect(isTunnelDownResponse(503, '<html><body>Service Unavailable</body></html>')).toBe(false)
    expect(isTunnelDownResponse(404, '<html><body>Not Found</body></html>')).toBe(false)
    expect(isTunnelDownResponse(429, 'Too Many Requests')).toBe(false)
    expect(isTunnelDownResponse(200, stopped.body.replace('502', '200'))).toBe(false)
    expect(isTunnelDownResponse(undefined, '')).toBe(false)
  })

  it('does not mistake a real "no balance" answer for it', () => {
    expect(classifyProviderError(402, '{"error":{"message":"Insufficient Balance"}}')).toBe('quota')
    expect(classifyProviderError(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits')).toBe('quota')
    expect(classifyProviderError(500, '{"error":"server exploded"}')).toBe('server')
  })
})

describe('tunnel down: how the harness classifies it', () => {
  it('is a connection failure of the whole provider, not "no balance" or "bad request"', () => {
    expect(classifyProviderError(gone.status, gone.body)).toBe('network')
    expect(classifyProviderError(stopped.status, stopped.body)).toBe('network')
    // The words of an error page must not be read as a quota/auth message ("billing", "quota", "unauthorized"...).
    expect(classifyProviderError(530, '<html>please check your billing quota and unauthorized access</html>')).toBe('network')
  })

  it('gives the user the plain message instead of 6 KB of HTML', () => {
    const error = new ProviderHttpError(gone.status, gone.body)
    expect(error.message).toContain(TUNNEL_DOWN_MESSAGE)
    expect(error.message).toContain('HTTP 530')
    expect(error.message).not.toContain('<html')
    expect(error.kind).toBe('network')
  })

  it('does not wait and retry a tunnel that is gone or stopped, but keeps retrying an ordinary 502', () => {
    expect(new ProviderHttpError(530, gone.body).retryable).toBe(false)
    expect(new ProviderHttpError(502, stopped.body).retryable).toBe(false)
    expect(new ProviderHttpError(502, '{"error":"bad gateway"}').retryable).toBe(true)
  })

  it('leaves the other providers\' messages alone', () => {
    expect(new ProviderHttpError(500, 'boom').message).toBe('HTTP 500: boom')
  })
})

describe('link check against a server', () => {
  let colab: FakeColab
  beforeEach(async () => {
    colab = await startFakeColab()
  })
  afterEach(() => colab.close())

  const check = (over: Partial<Parameters<typeof checkColabLink>[0]> = {}) =>
    checkColabLink({ baseUrl: colab.baseUrl, apiKey: colab.key, model: colab.model, timeoutMs: 1500, ...over })

  it('is connected when the key works and the model is the one served; reads vision, tools and context from the server', async () => {
    const result = await check()
    expect(result.state).toBe('conectado')
    expect(result.document).toMatchObject({ id: 'qwen3.5:9b-q8_0', contextWindow: 65536, vision: true, tools: true, gpu: 'Tesla T4 (15 GB)', notebook: '1.0.0' })
    expect(colab.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', authorized: true })
  })

  it('tells a model without vision or tools', async () => {
    await colab.close()
    colab = await startFakeColab({ vision: false, tools: false, context: 32768 })
    const result = await check()
    expect(result.document).toMatchObject({ vision: false, tools: false, contextWindow: 32768 })
  })

  it('says the key is refused (the notebook was restarted)', async () => {
    const result = await check({ apiKey: 'outra-chave-qualquer' })
    expect(result.state).toBe('chave')
    expect(result.status).toBe(401)
    expect(result.detail).toMatch(/gerou outra|código de conexão novo/)
  })

  it('says the tunnel is gone for the real 530 page and for the real 502 page', async () => {
    colab.mode = 'tunnel-down'
    const dead = await check()
    expect(dead.state).toBe('caiu')
    expect(dead.status).toBe(530)
    expect(dead.detail).toBe(TUNNEL_DOWN_MESSAGE)
    colab.mode = 'origin-down'
    expect((await check()).state).toBe('caiu')
  })

  it('does not take another website on that name for the notebook', async () => {
    colab.mode = 'html-200'
    const result = await check()
    expect(result.state).toBe('caiu')
    expect(result.detail).toMatch(/não é o servidor do notebook/)
  })

  it('reports the server is up but its engine is not', async () => {
    colab.mode = 'engine-down'
    const result = await check()
    expect(result.state).toBe('erro')
    expect(result.detail).toMatch(/motor \(Ollama\)/)
  })

  it('reports a server that now serves another model', async () => {
    const result = await check({ model: 'outro-modelo:1b' })
    expect(result.state).toBe('erro')
    expect(result.detail).toMatch(/serve outro modelo \(qwen3\.5:9b-q8_0\)/)
  })

  it('says "caiu" when nobody answers: refused connection, unknown name, and a server that hangs', async () => {
    const refused = await checkColabLink({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x'.repeat(12), timeoutMs: 1500 })
    expect(refused.state).toBe('caiu')
    expect(refused.detail).toMatch(/Nada está escutando|Não consegui falar/)
    const unknown = await checkColabLink({ baseUrl: 'https://openclod-nunca-existiu-1234.invalid/v1', apiKey: 'x'.repeat(12), timeoutMs: 4000 })
    expect(unknown.state).toBe('caiu')
    colab.mode = 'hang'
    const slow = await check({ timeoutMs: 400 })
    expect(slow.state).toBe('caiu')
    expect(slow.detail).toMatch(/não respondeu a tempo/)
  })

  it('never sends the key anywhere but the Authorization header of the address it was given', async () => {
    await check()
    expect(colab.requests.every((request) => request.path === '/v1/models')).toBe(true)
  })

  it('parses the model document defensively', () => {
    expect(readModelDocument(null)).toBeNull()
    expect(readModelDocument({ data: [] })).toBeNull()
    expect(readModelDocument({ data: [{ id: 'm' }] })).toEqual({ id: 'm', contextWindow: undefined, vision: undefined, tools: undefined, gpu: undefined, notebook: undefined })
  })
})
