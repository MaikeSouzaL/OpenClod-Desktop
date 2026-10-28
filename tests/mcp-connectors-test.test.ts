import { describe, expect, it } from 'vitest'
import type { DirectoryConnector } from '../src/shared/mcp-connectors'
import {
  TEST_USER_AGENT,
  blockedReason,
  classifyRemote,
  createThrottledFetch,
  mergeRecords,
  parseClientError,
  pickSafeTool,
  retryAfterMs,
  summarize,
  type ConnectorTestRecord,
  type DryRunFacts
} from '../scripts/lib/mcp-connectors-test-core'
import { buildReport } from '../scripts/lib/mcp-connectors-test-report'

const okDry: DryRunFacts = {
  ok: true,
  steps: [
    { step: 'discovery', ok: true, ms: 10, detail: 'servidor de autorização em auth.exemplo.com; PKCE S256 anunciado; registro dinâmico: sim; escopos: read' },
    { step: 'registration', ok: true, ms: 10, detail: 'cliente registrado dinamicamente' },
    { step: 'authorize-url', ok: true, ms: 1, detail: 'https://auth.exemplo.com/authorize com PKCE S256' }
  ]
}

const noDcrDry: DryRunFacts = {
  ok: false,
  error: 'este conector não aceita registro dinâmico; use uma chave de API (se houver) ou peça um client id',
  steps: [
    { step: 'discovery', ok: true, ms: 10, detail: 'servidor de autorização em accounts.exemplo.com; PKCE S256 anunciado; registro dinâmico: não; escopos: read' },
    { step: 'registration', ok: false, ms: 0, detail: 'este conector não aceita registro dinâmico' }
  ]
}

describe('parseClientError', () => {
  it('le o status HTTP e o desafio anexado pelo cliente', () => {
    const parsed = parseClientError('HTTP 401 em initialize: {"error":"invalid_token"} [desafio: Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"]')
    expect(parsed.httpStatus).toBe(401)
    expect(parsed.unauthorized).toBe(true)
    expect(parsed.challenge).toContain('resource_metadata')
    expect(parsed.network).toBeUndefined()
  })

  it('distingue as falhas de rede', () => {
    expect(parseClientError('falha de rede em initialize: fetch failed (ENOTFOUND)').network).toBe('dns')
    expect(parseClientError('falha de rede em initialize: fetch failed (ECONNREFUSED)').network).toBe('refused')
    expect(parseClientError('timeout de MCP x.initialize (20000ms)').network).toBe('timeout')
    expect(parseClientError('falha de rede em initialize: fetch failed (CERT_HAS_EXPIRED)').network).toBe('tls')
    expect(parseClientError('falha de rede em initialize: fetch failed (UND_ERR_SOCKET)').network).toBe('reset')
  })

  it('reconhece a pagina de desafio de um WAF, mas nao um 401 com Bearer', () => {
    expect(parseClientError('HTTP 403 em initialize: <!DOCTYPE html><html><head><title>Just a moment...</title>').waf).toBe(true)
    expect(parseClientError('HTTP 403 em initialize: <html>Forbidden [desafio: Bearer realm="x"]').waf).toBe(false)
    expect(parseClientError('HTTP 401 em initialize: {"error":"x"}').waf).toBe(false)
  })

  it('reconhece os dois transportes que falharam e a versao de protocolo', () => {
    expect(parseClientError('nenhum transporte MCP funcionou neste endereço: HTTP 404; HTTP 404').noTransport).toBe(true)
    expect(parseClientError('versão de protocolo MCP não suportada: o servidor respondeu 2030-01-01').protocol).toBe(true)
  })
})

describe('pickSafeTool', () => {
  const readOnly = { readOnlyHint: true }

  it('so aceita ferramenta somente-leitura, sem argumentos obrigatorios e sem cara de dado pessoal', () => {
    const tool = pickSafeTool([
      { name: 'delete_all', annotations: { destructiveHint: true } },
      { name: 'search', inputSchema: { required: ['q'] }, annotations: readOnly },
      { name: 'get_profile', annotations: readOnly },
      { name: 'listOrders', annotations: readOnly },
      { name: 'unmarked' },
      { name: 'list_categories', inputSchema: { type: 'object', properties: {} }, annotations: readOnly }
    ])
    expect(tool?.name).toBe('list_categories')
  })

  it('prefere as ferramentas de informacao geral e devolve null quando nenhuma serve', () => {
    expect(
      pickSafeTool([
        { name: 'compute', annotations: readOnly },
        { name: 'get_status', annotations: readOnly }
      ])?.name
    ).toBe('get_status')
    expect(pickSafeTool([{ name: 'get_my_notes', annotations: readOnly }, { name: 'write', annotations: { readOnlyHint: false } }])).toBeNull()
    expect(pickSafeTool([{ name: 'get_info', description: 'Returns your private data', annotations: readOnly }])).toBeNull()
  })

  it('nunca escolhe uma ferramenta com nome de acao, mesmo anotada somente-leitura (connect_with_expert, book_*)', () => {
    expect(pickSafeTool([{ name: 'connect_with_expert', annotations: readOnly }, { name: 'book_table', annotations: readOnly }, { name: 'requestQuote', annotations: readOnly }])).toBeNull()
    expect(pickSafeTool([{ name: 'connect_with_expert', annotations: readOnly }, { name: 'list_sources', annotations: readOnly }])?.name).toBe('list_sources')
  })
})

describe('classifyRemote', () => {
  it('N4: conectou sem login (mesmo com o login tambem pronto)', () => {
    const verdict = classifyRemote({ auth: 'oauth', ready: true, dry: okDry })
    expect(verdict).toMatchObject({ level: 4, outcome: 'open-connected', connected: true, loginReady: true, needsOwnClient: false })
    expect(verdict.authHost).toBe('auth.exemplo.com')
  })

  it('N3: login pronto', () => {
    const verdict = classifyRemote({
      auth: 'oauth',
      ready: false,
      clientError: 'HTTP 401 em initialize: x [desafio: Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"]',
      dry: okDry
    })
    expect(verdict).toMatchObject({ level: 3, outcome: 'login-ready', loginReady: true })
  })

  it('N2: servidor sem registro dinamico precisa de client id proprio', () => {
    const verdict = classifyRemote({ auth: 'oauth-static', ready: false, clientError: 'HTTP 401 em initialize: x [desafio: Bearer]', dry: noDcrDry })
    expect(verdict).toMatchObject({ level: 2, outcome: 'needs-own-client', needsOwnClient: true })
  })

  it('aberto que tambem exige client id proprio para logar mantem as duas informacoes', () => {
    expect(classifyRemote({ auth: 'oauth-static', ready: true, dry: noDcrDry })).toMatchObject({ level: 4, outcome: 'open-connected', needsOwnClient: true })
  })

  it('registro dinamico recusado pelo servidor e falha (a investigar), nao client id proprio', () => {
    const dry: DryRunFacts = {
      ...noDcrDry,
      error: 'este conector não aceita registro dinâmico; use uma chave de API (se houver) ou peça um client id (registro OAuth 400)'
    }
    const verdict = classifyRemote({ auth: 'oauth', ready: false, clientError: 'HTTP 401 em initialize: x [desafio: Bearer]', dry })
    expect(verdict.outcome).toBe('failed')
    expect(verdict.cause).toContain('400')
    expect(verdict.needsOwnClient).toBe(false)
  })

  it('registro recusado com um motivo do servico e bloqueio do servico; sem motivo continua a investigar', () => {
    const refused = (detail: string): DryRunFacts => ({
      ...noDcrDry,
      error: `este conector não aceita registro dinâmico; use uma chave de API (se houver) ou peça um client id (${detail})`
    })
    const verdict = classifyRemote({
      auth: 'oauth',
      ready: false,
      clientError: 'HTTP 401 em initialize: x [desafio: Bearer]',
      dry: refused('registro OAuth 400 (invalid_redirect_uri): redirect_uri not allowed; com localhost: registro OAuth 400 (invalid_redirect_uri): redirect_uri not allowed')
    })
    expect(verdict).toMatchObject({ outcome: 'blocked', level: 2 })
    expect(verdict.cause).toContain('URLs de retorno aprovadas')
    const disabled = classifyRemote({ auth: 'oauth', ready: false, clientError: 'HTTP 401', dry: refused('registro OAuth 400: dynamic client registration is disabled') })
    expect(disabled).toMatchObject({ outcome: 'blocked', cause: 'registro dinâmico recusado (400): registro dinâmico desativado pelo serviço' })
    expect(classifyRemote({ auth: 'oauth', ready: false, clientError: 'HTTP 401', dry: refused('registro OAuth 403: página HTML (provável bloqueio de WAF/CDN)') }).cause).toContain('WAF/CDN')
    // Without a reason the service gave, it stays "a investigar".
    expect(classifyRemote({ auth: 'oauth', ready: false, clientError: 'HTTP 401', dry: refused('registro OAuth 400: Unable to register client') }).outcome).toBe('failed')
    expect(classifyRemote({ auth: 'oauth', ready: false, clientError: 'HTTP 401', dry: refused('registro OAuth 400') }).outcome).toBe('failed')
  })

  it('api-key: 401 vira "precisa de chave de API" e 403 de WAF vira bloqueio', () => {
    expect(classifyRemote({ auth: 'api-key', ready: false, clientError: 'HTTP 401 em initialize: no key' })).toMatchObject({ level: 1, outcome: 'needs-api-key' })
    expect(classifyRemote({ auth: 'unknown', ready: false, clientError: 'HTTP 403 em initialize: <html>Just a moment...</html>' })).toMatchObject({ level: 1, outcome: 'blocked' })
  })

  it('N0: sem resposta HTTP e 5xx sao inalcancaveis', () => {
    expect(classifyRemote({ auth: 'none', ready: false, clientError: 'falha de rede em initialize: fetch failed (ENOTFOUND)' })).toMatchObject({ level: 0, outcome: 'unreachable', cause: 'DNS não resolve' })
    expect(classifyRemote({ auth: 'none', ready: false, clientError: 'HTTP 503 em initialize: down' })).toMatchObject({ level: 1, outcome: 'unreachable' })
  })

  it('erro nao classificado fica como falha a investigar', () => {
    expect(classifyRemote({ auth: 'none', ready: false, clientError: 'resposta MCP inválida para initialize' })).toMatchObject({ outcome: 'failed' })
  })
})

describe('blockedReason', () => {
  it('so testa https com dominio publico', () => {
    expect(blockedReason('https://mcp.exemplo.com/mcp')).toBeNull()
    expect(blockedReason('http://mcp.exemplo.com/mcp')).toBe('só https')
    expect(blockedReason('https://127.0.0.1/mcp')).toBe('IP literal')
    expect(blockedReason('https://10.0.0.1/mcp')).toBe('IP literal')
    expect(blockedReason('https://servidor.local/mcp')).toBe('host local')
    expect(blockedReason('https://u:p@mcp.exemplo.com/')).toBe('URL com credenciais')
    expect(blockedReason('https://intranet/mcp')).toBe('host sem domínio')
    expect(blockedReason(undefined)).toBe('sem URL')
  })
})

describe('createThrottledFetch', () => {
  function harness(statuses: Array<{ status: number; retryAfter?: string }> = []) {
    let clock = 1_000_000
    const slept: number[] = []
    const calls: Array<{ url: string; at: number; agent: string | null }> = []
    const queue = [...statuses]
    const base = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), at: clock, agent: new Headers(init?.headers).get('user-agent') })
      const next = queue.shift() ?? { status: 200 }
      return new Response('ok', { status: next.status, headers: next.retryAfter ? { 'retry-after': next.retryAfter } : {} })
    }) as typeof fetch
    const made = createThrottledFetch(base, {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      }
    })
    return { ...made, calls, slept }
  }

  it('manda o User-Agent do teste e respeita no maximo 1 requisicao por segundo por host', async () => {
    const t = harness()
    await t.fetch('https://a.example.com/x')
    await t.fetch('https://a.example.com/y')
    await t.fetch('https://b.example.com/x')
    expect(t.calls.map((call) => call.agent)).toEqual([TEST_USER_AGENT, TEST_USER_AGENT, TEST_USER_AGENT])
    expect(t.calls[1].at - t.calls[0].at).toBeGreaterThanOrEqual(1000)
    expect(t.calls[2].at - t.calls[1].at).toBe(0) // outro host nao espera
    expect(t.stats.byHost['a.example.com']).toBe(2)
  })

  it('nao troca o User-Agent que o chamador mandou', async () => {
    const t = harness()
    await t.fetch('https://a.example.com/x', { headers: { 'user-agent': 'outro/1' } })
    expect(t.calls[0].agent).toBe('outro/1')
  })

  it('espera o Retry-After e reenvia UMA vez em 429', async () => {
    const t = harness([{ status: 429, retryAfter: '3' }, { status: 200 }])
    const response = await t.fetch('https://a.example.com/x')
    expect(response.status).toBe(200)
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1].at - t.calls[0].at).toBeGreaterThanOrEqual(3000)
    expect(t.stats.retries429).toBe(1)
  })

  it('um segundo 429 seguido e devolvido sem nova tentativa', async () => {
    const t = harness([{ status: 429 }, { status: 429 }, { status: 200 }])
    expect((await t.fetch('https://a.example.com/x')).status).toBe(429)
    expect(t.calls).toHaveLength(2)
  })

  it('retryAfterMs le segundos e datas, com teto', () => {
    expect(retryAfterMs('2', 20_000)).toBe(2000)
    expect(retryAfterMs('999', 20_000)).toBe(20_000)
    expect(retryAfterMs(new Date(5_000).toUTCString(), 20_000, 1_000)).toBe(4000)
    expect(retryAfterMs('amanhã', 20_000)).toBeUndefined()
    expect(retryAfterMs(null, 20_000)).toBeUndefined()
  })
})

function record(over: Partial<ConnectorTestRecord>): ConnectorTestRecord {
  return {
    id: 'a',
    name: 'A',
    group: 'remote',
    source: 'claude-directory',
    category: 'outros',
    transport: 'http',
    auth: 'oauth',
    url: 'https://a.example.com/mcp',
    level: 3,
    outcome: 'login-ready',
    connected: false,
    loginReady: true,
    steps: [],
    ms: 1500,
    testedAt: '2026-10-27T00:00:00.000Z',
    ...over
  }
}

describe('mergeRecords e summarize', () => {
  it('guarda o estado anterior quando um conector e testado de novo e preserva a primeira rodada', () => {
    const first = [record({ id: 'a', level: 1, outcome: 'failed', cause: 'erro nosso', error: 'x' })]
    const second = mergeRecords(first, [record({ id: 'a', level: 3, outcome: 'login-ready' })], 'corrigido')
    expect(second[0].previous).toMatchObject({ level: 1, outcome: 'failed', cause: 'erro nosso' })
    expect(second[0].fixNote).toBe('corrigido')
    const third = mergeRecords(second, [record({ id: 'a', level: 4, outcome: 'open-connected', connected: true })])
    expect(third[0].previous?.outcome).toBe('failed') // a primeira rodada, nao a segunda
    expect(third[0].fixNote).toBe('corrigido')
  })

  it('conta por nivel e por resultado', () => {
    const summary = summarize([
      record({ id: 'a' }),
      record({ id: 'b', level: 4, outcome: 'open-connected', connected: true, loginReady: false }),
      record({ id: 'c', level: 2, outcome: 'needs-own-client', needsOwnClient: true, loginReady: false, cause: 'sem registro' }),
      record({ id: 'd', group: 'local', level: null, outcome: 'local-connected', connected: true, loginReady: false }),
      record({ id: 'e', group: 'no-endpoint', level: null, outcome: 'needs-endpoint', loginReady: false })
    ])
    expect(summary).toMatchObject({ total: 5, remote: 3, local: 1, noEndpoint: 1, loginReady: 1, needsOwnClient: 1, connected: 2 })
    expect(summary.byLevel).toEqual({ N3: 1, N4: 1, N2: 1 })
    expect(summary.byOutcome['login-ready']).toBe(1)
  })
})

describe('buildReport', () => {
  const entry = (id: string): DirectoryConnector =>
    ({ id, name: id, description: '', category: 'outros', kind: 'remote', transport: 'http', auth: 'oauth', tools: [], source: 'claude-directory' }) as DirectoryConnector

  it('monta as tabelas com os numeros dos registros e escapa barras verticais', () => {
    const records = [
      record({ id: 'a', name: 'Alfa | Beta' }),
      record({ id: 'b', name: 'B', level: 4, outcome: 'open-connected', connected: true, loginReady: false, toolCount: 3, protocolVersion: '2025-06-18', transportUsed: 'http' }),
      record({ id: 'c', name: 'C', level: 2, outcome: 'needs-own-client', needsOwnClient: true, loginReady: false, authHost: 'accounts.exemplo.com' }),
      record({ id: 'd', name: 'D', level: 1, outcome: 'blocked', loginReady: false, cause: 'provável bloqueio de WAF/CDN (HTTP 403)', error: 'HTTP 403' })
    ]
    const text = buildReport(records, ['a', 'b', 'c', 'd', 'e'].map(entry), { userAgent: TEST_USER_AGENT })
    expect(text).toContain('Conectores no diretório: **5**; com registro nesta execução: **4** (faltam 1)')
    expect(text).toContain('Alfa \\| Beta')
    expect(text).toContain('## Abertos que conectaram sem login (1)')
    expect(text).toContain('## Prontos para o login de 1 clique (1)')
    expect(text).toContain('## Precisam de client id próprio (1)')
    expect(text).toContain('provável bloqueio de WAF/CDN (HTTP 403)')
    expect(text).toContain('N5 — conectado com a conta do usuário: **não medido**')
  })
})
