import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectorAuth, ConnectorCategory, ConnectorDirectory, DirectoryConnector } from '../src/shared/mcp-connectors'
import {
  applyProbe,
  authServerMetadataCandidates,
  classifyNetworkError,
  classifyProbe,
  detectWaf,
  isInitializeResult,
  jsonRpcMessages,
  parseSseEvents,
  parseWwwAuthenticate,
  probeLevel,
  protectedResourceMetadataCandidates,
  resourceMetadataFromHeader,
  type ProbeEvidence
} from '../scripts/lib/mcp-probe-core.mjs'
import {
  iconDomainOf,
  mapCatalogEntry,
  mergeDirectory,
  normalizeUrl,
  registrableDomain,
  slugify,
  transportForUrl,
  validateDirectory,
  type HarvestRow
} from '../scripts/lib/mcp-directory-core.mjs'
import { createHttp, probeUrl } from '../scripts/mcp-probe.mjs'

// ---------------------------------------------------------------------------------------------
// Classificacao com fixtures (funcao pura)

const NOW = 1_700_000_000_000
const asOk = {
  found: true,
  issuer: 'https://auth.exemplo.com',
  codeChallengeMethods: ['S256', 'plain'],
  scopesSupported: ['read', 'write']
}

describe('classifyProbe', () => {
  it('acesso aberto: initialize sem credenciais + tools/list -> none, N4', () => {
    const r = classifyProbe({ status: 200, initialize: { ok: true }, transport: 'http', tools: { ok: true, count: 12 } }, NOW)
    expect(r.auth).toBe('none')
    expect(r.level).toBe(4)
    expect(r.probe).toMatchObject({ checkedAt: NOW, reachable: true, httpStatus: 200, openAccess: true, transportOk: 'http' })
    expect(r.probe.note).toContain('12 ferramentas')
  })

  it('handshake/listagem abertos MAS com protected-resource metadata (ex.: Gmail do Google) -> auth OAuth, openAccess preservado, N4', () => {
    const noDcr = classifyProbe(
      { status: 200, initialize: { ok: true }, transport: 'http', tools: { ok: true, count: 9 }, prm: { found: true, advertised: false, via: 'well-known', authorizationServers: ['https://accounts.exemplo.com/'] }, as: asOk },
      NOW
    )
    expect(noDcr.auth).toBe('oauth-static')
    expect(noDcr.level).toBe(4)
    expect(noDcr.probe).toMatchObject({ openAccess: true, transportOk: 'http', resourceMetadata: true, dynamicRegistration: false, pkceS256: true })
    expect(noDcr.probe.note).toContain('provavelmente exigem login')
    const dcr = classifyProbe(
      { status: 200, initialize: { ok: true }, tools: { ok: true, count: 2 }, prm: { found: true }, as: { ...asOk, registrationEndpoint: 'https://accounts.exemplo.com/register' } },
      NOW
    )
    expect(dcr.auth).toBe('oauth')
    // sem metadata, o mesmo servidor aberto continua "none"
    expect(classifyProbe({ status: 200, initialize: { ok: true }, tools: { ok: true, count: 2 }, prm: { found: false } }, NOW).auth).toBe('none')
  })

  it('acesso aberto por SSE legado registra transportOk "sse"', () => {
    const r = classifyProbe({ status: 200, initialize: { ok: true }, transport: 'sse', tools: { ok: true, count: 3 }, sse: { endpointEvent: true, status: 200 } }, NOW)
    expect(r.auth).toBe('none')
    expect(r.probe.transportOk).toBe('sse')
  })

  it('initialize aberto mas tools/list exige login -> segue o desafio, nao e acesso aberto', () => {
    const r = classifyProbe(
      {
        status: 200,
        initialize: { ok: true },
        tools: { ok: false, status: 401 },
        wwwAuthenticate: 'Bearer resource_metadata="https://x.exemplo.com/.well-known/oauth-protected-resource"',
        prm: { found: true, advertised: true },
        as: { ...asOk, registrationEndpoint: 'https://auth.exemplo.com/register' }
      },
      NOW
    )
    expect(r.auth).toBe('oauth')
    expect(r.probe.openAccess).toBeUndefined()
    expect(r.probe.note).toContain('tools/list exige')
  })

  it('oauth com registro dinamico + PKCE S256 -> oauth, N3', () => {
    const r = classifyProbe(
      {
        status: 401,
        wwwAuthenticate: 'Bearer error="invalid_token", resource_metadata="https://mcp.exemplo.com/.well-known/oauth-protected-resource"',
        prm: { found: true, advertised: true, via: 'header', authorizationServers: ['https://auth.exemplo.com'] },
        as: { ...asOk, registrationEndpoint: 'https://auth.exemplo.com/register' }
      },
      NOW
    )
    expect(r.auth).toBe('oauth')
    expect(r.level).toBe(3)
    expect(r.probe).toMatchObject({ reachable: true, httpStatus: 401, resourceMetadata: true, dynamicRegistration: true, pkceS256: true })
    expect(r.scopes).toEqual(['read', 'write'])
  })

  it('oauth sem registro dinamico -> oauth-static (precisa de client id), N2', () => {
    const r = classifyProbe(
      { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://mcp.exemplo.com/.well-known/oauth-protected-resource"', prm: { found: true, advertised: true }, as: asOk },
      NOW
    )
    expect(r.auth).toBe('oauth-static')
    expect(r.level).toBe(2)
    expect(r.probe).toMatchObject({ resourceMetadata: true, dynamicRegistration: false, pkceS256: true })
    expect(r.probe.note).toContain('client id pré-registrado')
  })

  it('anuncia o metadata mas o AS nao responde -> oauth-static com a ressalva na nota', () => {
    const r = classifyProbe({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://mcp.exemplo.com/prm"', prm: { found: false, advertised: true }, as: { found: false } }, NOW)
    expect(r.auth).toBe('oauth-static')
    expect(r.probe.resourceMetadata).toBe(true)
    expect(r.probe.dynamicRegistration).toBe(false)
    expect(r.probe.note).toContain('não confirmado')
  })

  it('descoberta legada (AS na origem, sem protected-resource metadata) com DCR -> oauth', () => {
    const r = classifyProbe(
      { status: 401, wwwAuthenticate: 'Bearer realm="OAuth"', prm: { found: false, advertised: false }, as: { ...asOk, registrationEndpoint: 'https://mcp.exemplo.com/register' } },
      NOW
    )
    expect(r.auth).toBe('oauth')
    expect(r.probe.resourceMetadata).toBe(false)
    expect(r.probe.note).toContain('legada')
  })

  it('DCR anunciado mas sem PKCE S256 -> oauth, porem nao conta como N3', () => {
    const r = classifyProbe(
      { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m.exemplo.com/prm"', prm: { found: true, advertised: true }, as: { found: true, registrationEndpoint: 'https://a.exemplo.com/reg', codeChallengeMethods: [] } },
      NOW
    )
    expect(r.auth).toBe('oauth')
    expect(r.probe.pkceS256).toBe(false)
    expect(r.level).toBe(2)
  })

  it('401 com WWW-Authenticate Basic/Bearer sem metadata -> api-key', () => {
    expect(classifyProbe({ status: 401, wwwAuthenticate: 'Basic realm="api"' }, NOW).auth).toBe('api-key')
    const bearer = classifyProbe({ status: 401, wwwAuthenticate: 'Bearer realm="mcp"' }, NOW)
    expect(bearer.auth).toBe('api-key')
    expect(bearer.level).toBe(1)
    expect(classifyProbe({ status: 401, wwwAuthenticate: 'ApiKey realm="x"' }, NOW).auth).toBe('api-key')
  })

  it('401 sem cabecalho mas pedindo a chave na mensagem -> api-key', () => {
    expect(classifyProbe({ status: 401, authBody: '{"error":"Missing API key. Provide the X-API-Key header"}' }, NOW).auth).toBe('api-key')
    expect(classifyProbe({ status: 403, authBody: 'invalid api_key' }, NOW).auth).toBe('api-key')
  })

  it('401 sem nenhuma pista continua unknown (alcancavel)', () => {
    const r = classifyProbe({ status: 401, authBody: 'Unauthorized' }, NOW)
    expect(r.auth).toBe('unknown')
    expect(r.probe.reachable).toBe(true)
    expect(r.level).toBe(1)
  })

  it('403 de WAF/captcha nao e classificado como api-key', () => {
    const r = classifyProbe({ status: 403, waf: true, authBody: 'Just a moment...' }, NOW)
    expect(r.auth).toBe('unknown')
    expect(r.probe.note).toContain('anti-bot')
  })

  it('inalcancavel: DNS, timeout, TLS e 5xx -> unknown, reachable false, N0', () => {
    for (const error of [{ kind: 'dns' as const }, { kind: 'timeout' as const }, { kind: 'tls' as const, message: 'CERT_HAS_EXPIRED' }, { kind: 'refused' as const }]) {
      const r = classifyProbe({ error }, NOW)
      expect(r.auth).toBe('unknown')
      expect(r.probe.reachable).toBe(false)
      expect(r.level).toBe(0)
      expect(r.probe.note).toMatch(/^Inalcançável/)
    }
    const r503 = classifyProbe({ status: 503 }, NOW)
    expect(r503.probe).toMatchObject({ reachable: false, httpStatus: 503 })
    expect(r503.auth).toBe('unknown')
  })

  it('429 persistente -> alcancavel, unknown', () => {
    const r = classifyProbe({ status: 429, rateLimited: true }, NOW)
    expect(r.probe.reachable).toBe(true)
    expect(r.auth).toBe('unknown')
    expect(r.probe.note).toContain('429')
  })

  it('SSE legado que respondeu endpoint mas nao concluiu o initialize -> transportOk sse, unknown', () => {
    const r = classifyProbe({ status: 405, sse: { endpointEvent: true, status: 200 } }, NOW)
    expect(r.probe.transportOk).toBe('sse')
    expect(r.auth).toBe('unknown')
  })

  it('404/405 sem SSE -> alcancavel mas nao e endpoint MCP', () => {
    const r = classifyProbe({ status: 404 }, NOW)
    expect(r.probe.reachable).toBe(true)
    expect(r.level).toBe(1)
    expect(r.probe.note).toContain('não é um endpoint MCP')
  })

  it('erro JSON-RPC no initialize pedindo token -> api-key', () => {
    const r = classifyProbe({ status: 200, initialize: { ok: false, rpcError: 'API key required' } }, NOW)
    expect(r.auth).toBe('api-key')
  })

  it('403/406 de WAF (pagina HTML sem WWW-Authenticate) fica unknown, sem virar api-key', () => {
    expect(detectWaf(403, {}, '<html><head><title>403 Forbidden</title></head></html>')).toBe(true)
    expect(detectWaf(406, {}, 'Request blocked')).toBe(true)
    expect(detectWaf(403, { 'www-authenticate': 'Bearer realm="x"' }, '<html></html>')).toBe(false)
    const r = classifyProbe({ status: 403, waf: true }, NOW)
    expect(r.auth).toBe('unknown')
    expect(r.probe.reachable).toBe(true)
    expect(r.probe.note).toContain('WAF')
    const r406 = classifyProbe({ status: 406, waf: true }, NOW)
    expect(r406.auth).toBe('unknown')
    expect(r406.probe.note).toContain('WAF')
  })

  it('403 sem pistas e sem corpo HTML nao afirma credencial: fala em "bloqueio de borda"', () => {
    const r = classifyProbe({ status: 403, authBody: '' }, NOW)
    expect(r.auth).toBe('unknown')
    expect(r.probe.note).toContain('bloqueio de borda')
  })

  it('redirecionamento para destino proibido (http) conta como alcancavel, sem seguir', () => {
    const r = classifyProbe({ status: 302, redirectBlocked: 'http://www.exemplo.com/notfound.htm' }, NOW)
    expect(r.auth).toBe('unknown')
    expect(r.probe).toMatchObject({ reachable: true, httpStatus: 302 })
    expect(r.probe.note).toContain('não seguido')
  })

  it('spec 2026-07-28 (sem initialize): server/discover aberto vira N4, e sem discover fica unknown com a causa', () => {
    const open = classifyProbe({ status: 200, versionMismatch: ['2026-07-28'], stateless: '2026-07-28', initialize: { ok: true }, transport: 'http', tools: { ok: true, count: 4 } }, NOW)
    expect(open.auth).toBe('none')
    expect(open.level).toBe(4)
    expect(open.probe.note).toContain('sem estado')
    const closed = classifyProbe({ status: 200, versionMismatch: ['2026-07-28'], initialize: { ok: false, rpcError: 'Unsupported protocol version' } }, NOW)
    expect(closed.auth).toBe('unknown')
    expect(closed.probe.note).toContain('2026-07-28')
  })

  it('AS que anuncia Client ID Metadata Document (sem DCR) fica oauth-static, com a ressalva na nota', () => {
    const r = classifyProbe({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m/prm"', prm: { found: true, advertised: true }, as: { ...asOk, cimd: true } }, NOW)
    expect(r.auth).toBe('oauth-static')
    expect(r.probe.note).toContain('Client ID Metadata Document')
  })

  it('probeLevel deriva N0..N4 do probe gravado', () => {
    expect(probeLevel(undefined)).toBeNull()
    expect(probeLevel({ checkedAt: 1, reachable: false })).toBe(0)
    expect(probeLevel({ checkedAt: 1, reachable: true })).toBe(1)
    expect(probeLevel({ checkedAt: 1, reachable: true, resourceMetadata: true })).toBe(2)
    expect(probeLevel({ checkedAt: 1, reachable: true, resourceMetadata: true, dynamicRegistration: true, pkceS256: true })).toBe(3)
    expect(probeLevel({ checkedAt: 1, reachable: true, openAccess: true })).toBe(4)
  })
})

describe('descoberta OAuth (caminhos RFC 9728 / 8414 / OIDC)', () => {
  it('protected-resource metadata: insercao com o caminho do recurso e depois a raiz', () => {
    expect(protectedResourceMetadataCandidates('https://mcp.exemplo.com/v2/mcp')).toEqual([
      'https://mcp.exemplo.com/.well-known/oauth-protected-resource/v2/mcp',
      'https://mcp.exemplo.com/.well-known/oauth-protected-resource'
    ])
    expect(protectedResourceMetadataCandidates('https://mcp.exemplo.com/')).toEqual(['https://mcp.exemplo.com/.well-known/oauth-protected-resource'])
  })

  it('AS COM caminho: tenta as DUAS formas (insercao RFC 8414 e anexo) e depois OIDC', () => {
    expect(authServerMetadataCandidates('https://auth.exemplo.com/tenant1')).toEqual([
      'https://auth.exemplo.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.exemplo.com/tenant1/.well-known/oauth-authorization-server',
      'https://auth.exemplo.com/.well-known/openid-configuration/tenant1',
      'https://auth.exemplo.com/tenant1/.well-known/openid-configuration'
    ])
  })

  it('AS sem caminho: raiz OAuth e OIDC (barra final ignorada)', () => {
    expect(authServerMetadataCandidates('https://auth.exemplo.com/')).toEqual([
      'https://auth.exemplo.com/.well-known/oauth-authorization-server',
      'https://auth.exemplo.com/.well-known/openid-configuration'
    ])
  })

  it('WWW-Authenticate: varios desafios, valores com aspas e sem aspas', () => {
    const header = 'Bearer realm="mcp", error="invalid_token", resource_metadata="https://m.exemplo.com/.well-known/oauth-protected-resource", Basic realm=api'
    const parsed = parseWwwAuthenticate(header)
    expect(parsed.map((c) => c.scheme)).toEqual(['Bearer', 'Basic'])
    expect(parsed[0].params).toMatchObject({ realm: 'mcp', error: 'invalid_token' })
    expect(parsed[1].params.realm).toBe('api')
    expect(resourceMetadataFromHeader(header)).toBe('https://m.exemplo.com/.well-known/oauth-protected-resource')
    expect(resourceMetadataFromHeader('Bearer realm="x"')).toBeUndefined()
    expect(parseWwwAuthenticate(null)).toEqual([])
  })

  it('SSE e JSON-RPC: extrai mensagens de corpo JSON, de stream e ignora o evento endpoint', () => {
    const sse = 'event: endpoint\ndata: /messages?s=1\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}\n\n'
    expect(parseSseEvents(sse).map((e) => e.event)).toEqual(['endpoint', 'message'])
    const msgs = jsonRpcMessages(sse, 'text/event-stream')
    expect(msgs).toHaveLength(1)
    expect(isInitializeResult(msgs[0])).toBe(true)
    expect(jsonRpcMessages('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"x"}}')[0].error.code).toBe(-32601)
    expect(jsonRpcMessages('<html>login</html>')).toEqual([])
  })

  it('detecta WAF e classifica erros de rede', () => {
    expect(detectWaf(403, { 'cf-mitigated': 'challenge' }, '')).toBe(true)
    expect(detectWaf(403, {}, '<title>Just a moment...</title>')).toBe(true)
    expect(detectWaf(401, {}, 'Unauthorized')).toBe(false)
    expect(classifyNetworkError({ cause: { code: 'ENOTFOUND' } }).kind).toBe('dns')
    expect(classifyNetworkError({ name: 'TimeoutError' }).kind).toBe('timeout')
    expect(classifyNetworkError({ cause: { code: 'CERT_HAS_EXPIRED' } }).kind).toBe('tls')
    expect(classifyNetworkError({ cause: { code: 'ECONNREFUSED' } }).kind).toBe('refused')
  })
})

describe('applyProbe', () => {
  const base: DirectoryConnector = {
    id: 'exemplo',
    name: 'Exemplo',
    description: 'd',
    category: 'outros',
    kind: 'remote',
    transport: 'http',
    url: 'https://mcp.exemplo.com/mcp',
    auth: 'unknown',
    tools: [],
    source: 'claude-directory'
  }

  it('entrada do diretorio recebe auth e probe sem mutar a original', () => {
    const result = classifyProbe({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m/prm"', prm: { found: true, advertised: true }, as: { ...asOk, registrationEndpoint: 'https://a/reg' } }, NOW)
    const next = applyProbe(base, result)
    expect(next.auth).toBe('oauth')
    expect(next.probe?.dynamicRegistration).toBe(true)
    expect(base.auth).toBe('unknown')
    expect(base.probe).toBeUndefined()
  })

  it('acesso aberto atualiza toolCount e preenche a previa de ferramentas vazia', () => {
    const ev: ProbeEvidence = { status: 200, initialize: { ok: true }, tools: { ok: true, count: 7, names: ['a', 'b'] } }
    const next = applyProbe(base, classifyProbe(ev, NOW), ev)
    expect(next.auth).toBe('none')
    expect(next.toolCount).toBe(7)
    expect(next.tools).toEqual(['a', 'b'])
  })

  it('inalcancavel mantem auth unknown e nao inventa toolCount', () => {
    const next = applyProbe({ ...base, toolCount: 5 }, classifyProbe({ error: { kind: 'dns' } }, NOW))
    expect(next.auth).toBe('unknown')
    expect(next.toolCount).toBe(5)
    expect(next.probe?.reachable).toBe(false)
  })

  it('catalogo proprio com credenciais conhecidas mantem api-key e anota a divergencia (idempotente)', () => {
    const gh: DirectoryConnector = {
      ...base,
      id: 'github',
      source: 'openclod-catalog',
      auth: 'api-key',
      credentials: [{ key: 'Authorization', label: 'Token', where: 'header', required: true, secret: true, prefix: 'Bearer ' }]
    }
    const ev: ProbeEvidence = { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m/prm"', prm: { found: true, advertised: true }, as: { ...asOk, registrationEndpoint: 'https://a/reg' } }
    const once = applyProbe(gh, classifyProbe(ev, NOW), ev)
    const twice = applyProbe(once, classifyProbe(ev, NOW), ev)
    expect(once.auth).toBe('api-key')
    expect(once.notes).toContain('Sondagem:')
    expect(twice.notes).toBe(once.notes)
  })

  it('catalogo proprio OAuth (sem credenciais) pode ser corrigido pela sondagem', () => {
    const slack: DirectoryConnector = { ...base, id: 'slack', source: 'openclod-catalog', auth: 'oauth' }
    const ev: ProbeEvidence = { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m/prm"', prm: { found: true, advertised: true }, as: asOk }
    expect(applyProbe(slack, classifyProbe(ev, NOW), ev).auth).toBe('oauth-static')
  })
})

// ---------------------------------------------------------------------------------------------
// Sondagem real contra servidores MCP de mentira em 127.0.0.1 (nada sai da maquina)

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string, base: string) => void
const servers: http.Server[] = []

async function serve(handler: Handler): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8'), `http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const rpc = (id: number, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result })
const probeOpts = { allowPrivate: true, minGapMs: 0, timeoutMs: 4000, retryDelayMs: 10 }

function initResult(id: number) {
  return rpc(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } })
}

describe('probeUrl contra servidores locais', () => {
  it('servidor aberto (JSON): initialize + tools/list sem credenciais -> N4', async () => {
    const base = await serve((req, res, body) => {
      const msg = body ? JSON.parse(body) : {}
      if (req.method === 'POST' && msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(initResult(msg.id))
      } else if (msg.method === 'notifications/initialized') res.writeHead(202).end()
      else if (msg.method === 'tools/list') res.writeHead(200, { 'content-type': 'application/json' }).end(rpc(msg.id, { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }))
      else res.writeHead(200).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(result.auth).toBe('none')
    expect(result.level).toBe(4)
    expect(evidence.tools).toMatchObject({ ok: true, count: 3 })
    expect(result.probe.transportOk).toBe('http')
  })

  it('servidor aberto que tambem publica /.well-known/oauth-protected-resource -> N4 mas auth oauth (chamadas exigem login)', async () => {
    const base = await serve((req, res, body, origin) => {
      const msg = body ? JSON.parse(body) : {}
      const json = (payload: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(payload as string)
      if (req.url === '/.well-known/oauth-protected-resource/mcp') return void json(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }))
      if (req.url === '/.well-known/oauth-authorization-server') {
        return void json(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t`, registration_endpoint: `${origin}/reg`, code_challenge_methods_supported: ['S256'] }))
      }
      if (msg.method === 'initialize') return void json(initResult(msg.id))
      if (msg.method === 'tools/list') return void json(rpc(msg.id, { tools: [{ name: 'ler' }] }))
      res.writeHead(msg.method ? 202 : 404).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(evidence.prm?.found).toBe(true)
    expect(result.auth).toBe('oauth')
    expect(result.probe).toMatchObject({ openAccess: true, resourceMetadata: true, dynamicRegistration: true, pkceS256: true })
    expect(result.level).toBe(4)
  })

  it('servidor aberto que responde o POST como stream SSE tambem e reconhecido', async () => {
    const base = await serve((req, res, body) => {
      const msg = body ? JSON.parse(body) : {}
      const sse = (payload: string) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${payload}\n\n`)
      if (msg.method === 'initialize') sse(initResult(msg.id))
      else if (msg.method === 'tools/list') sse(rpc(msg.id, { tools: [{ name: 'x' }] }))
      else res.writeHead(202).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    expect(classifyProbe(evidence).level).toBe(4)
    expect(evidence.tools?.count).toBe(1)
  })

  it('401 + resource_metadata + AS com caminho SO na forma de insercao (RFC 8414) -> oauth', async () => {
    const base = await serve((req, res, _body, origin) => {
      const url = req.url ?? ''
      if (url === '/mcp') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end('{"error":"unauthorized"}')
      } else if (url === '/.well-known/oauth-protected-resource/mcp') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/tenant1`] }))
      } else if (url === '/.well-known/oauth-authorization-server/tenant1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ issuer: `${origin}/tenant1`, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t`, registration_endpoint: `${origin}/reg`, code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp:read'] })
        )
      } else res.writeHead(404).end('nope')
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(result.auth).toBe('oauth')
    expect(result.level).toBe(3)
    expect(result.probe).toMatchObject({ resourceMetadata: true, dynamicRegistration: true, pkceS256: true })
    expect(result.scopes).toEqual(['mcp:read'])
  })

  it('AS com caminho SO na forma de anexo (<issuer>/.well-known/...) tambem e achado', async () => {
    const base = await serve((req, res, _body, origin) => {
      const url = req.url ?? ''
      if (url === '/mcp') res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm"` }).end()
      else if (url === '/prm') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/tenant2`] }))
      else if (url === '/tenant2/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ issuer: `${origin}/tenant2`, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t`, code_challenge_methods_supported: ['S256'] })
        )
      } else res.writeHead(404).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(result.auth).toBe('oauth-static') // achou o AS (OIDC anexado) mas ele nao anuncia registration_endpoint
    expect(result.probe).toMatchObject({ resourceMetadata: true, dynamicRegistration: false, pkceS256: true })
  })

  it('401 sem metadata, com Basic -> api-key (e nao tenta registrar nada)', async () => {
    const hits: string[] = []
    const base = await serve((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      res.writeHead(401, { 'www-authenticate': 'Basic realm="api"' }).end('Unauthorized')
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    expect(classifyProbe(evidence).auth).toBe('api-key')
    expect(hits.some((h) => h.startsWith('POST') && /register/.test(h))).toBe(false)
  })

  it('SPA que devolve 200 HTML em qualquer caminho nao e confundida com metadata OAuth', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/mcp') res.writeHead(401, { 'www-authenticate': 'Bearer realm="x"' }).end()
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>app</body></html>')
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(result.auth).toBe('api-key')
    expect(evidence.as?.found).toBe(false)
  })

  it('SSE legado: POST 405, GET abre stream com "event: endpoint" e o handshake completo funciona', async () => {
    const streams = new Map<string, http.ServerResponse>()
    const base = await serve((req, res, body) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && url.pathname === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write('event: endpoint\ndata: /messages?session=abc\n\n')
        streams.set('abc', res)
      } else if (req.method === 'POST' && url.pathname === '/messages') {
        const msg = JSON.parse(body)
        res.writeHead(202).end('Accepted')
        const stream = streams.get('abc')
        if (msg.method === 'initialize') stream?.write(`event: message\ndata: ${initResult(msg.id)}\n\n`)
        if (msg.method === 'tools/list') stream?.write(`event: message\ndata: ${rpc(msg.id, { tools: [{ name: 'p' }, { name: 'q' }] })}\n\n`)
      } else res.writeHead(405).end()
    })
    const { evidence } = await probeUrl(`${base}/sse`, probeOpts)
    const result = classifyProbe(evidence)
    expect(evidence.status).toBe(200)
    expect(result.auth).toBe('none')
    expect(result.probe).toMatchObject({ openAccess: true, transportOk: 'sse' })
    expect(evidence.tools?.count).toBe(2)
  })

  it('segue redirecionamento 307 repetindo o POST', async () => {
    const base = await serve((req, res, body) => {
      if (req.url === '/mcp') res.writeHead(307, { location: '/mcp/' }).end()
      else {
        const msg = body ? JSON.parse(body) : {}
        if (msg.method === 'initialize') res.writeHead(200, { 'content-type': 'application/json' }).end(initResult(msg.id))
        else if (msg.method === 'tools/list') res.writeHead(200, { 'content-type': 'application/json' }).end(rpc(msg.id, { tools: [] }))
        else res.writeHead(202).end()
      }
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    expect(classifyProbe(evidence).auth).toBe('none')
  })

  it('manda Mcp-Method em todo POST (exigido pela spec 2026-07-28) e identifica o cliente', async () => {
    const seen: Array<{ method?: string; header?: string }> = []
    const base = await serve((req, res, body) => {
      const msg = body ? JSON.parse(body) : {}
      seen.push({ method: msg.method, header: req.headers['mcp-method'] as string | undefined })
      if (msg.method === 'initialize') res.writeHead(200, { 'content-type': 'application/json' }).end(initResult(msg.id))
      else if (msg.method === 'tools/list') res.writeHead(200, { 'content-type': 'application/json' }).end(rpc(msg.id, { tools: [] }))
      else res.writeHead(202).end()
    })
    await probeUrl(`${base}/mcp`, probeOpts)
    expect(seen.length).toBeGreaterThanOrEqual(3)
    for (const s of seen) expect(s.header).toBe(s.method)
  })

  it('servidor que so fala a spec 2026-07-28: initialize recusado com a lista de versoes -> server/discover + tools/list com _meta', async () => {
    let discoverSeen = false
    let toolsMeta: unknown
    const base = await serve((req, res, body) => {
      const msg = body ? JSON.parse(body) : {}
      const json = (payload: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      if (msg.method === 'initialize') {
        return void json({ jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { requested: '2025-06-18', supported: ['2026-07-28'] } } })
      }
      if (msg.method === 'server/discover') {
        discoverSeen = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' && req.headers['mcp-protocol-version'] === '2026-07-28'
        return void json({ jsonrpc: '2.0', id: msg.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'novo', version: '1' } } })
      }
      if (msg.method === 'tools/list') {
        toolsMeta = msg.params?._meta
        return void json({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', tools: [{ name: 'um' }, { name: 'dois' }] } })
      }
      res.writeHead(202).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(discoverSeen).toBe(true)
    expect(toolsMeta).toMatchObject({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28' })
    expect(result.auth).toBe('none')
    expect(result.level).toBe(4)
    expect(evidence.stateless).toBe('2026-07-28')
    expect(evidence.tools?.count).toBe(2)
  })

  it('redirecionamento para URL proibida nao e seguido (SSRF) mas o host conta como alcancavel', async () => {
    const base = await serve((_req, res) => res.writeHead(302, { location: 'file:///etc/passwd' }).end())
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(evidence.redirectBlocked).toBe('file:///etc/passwd')
    expect(result.probe).toMatchObject({ reachable: true, httpStatus: 302 })
    expect(result.auth).toBe('unknown')
  })

  it('AS que anuncia client_id_metadata_document_supported e sem registration_endpoint -> oauth-static + cimd na evidencia', async () => {
    const base = await serve((req, res, _body, origin) => {
      const url = req.url ?? ''
      if (url === '/mcp') res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm"` }).end()
      else if (url === '/prm') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }))
      else if (url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t`, code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true })
        )
      } else res.writeHead(404).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(evidence.as?.cimd).toBe(true)
    expect(result.auth).toBe('oauth-static')
    expect(result.probe.dynamicRegistration).toBe(false)
  })

  it('429 com Retry-After: espera e tenta de novo', async () => {
    let calls = 0
    const base = await serve((req, res, body) => {
      const msg = body ? JSON.parse(body) : {}
      if (msg.method === 'initialize') {
        calls++
        if (calls === 1) return void res.writeHead(429, { 'retry-after': '0' }).end('slow down')
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(initResult(msg.id))
      }
      if (msg.method === 'tools/list') return void res.writeHead(200, { 'content-type': 'application/json' }).end(rpc(msg.id, { tools: [{ name: 'a' }] }))
      res.writeHead(202).end()
    })
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    expect(calls).toBe(2)
    expect(classifyProbe(evidence).level).toBe(4)
  })

  it('servidor fora do ar (conexao recusada) -> N0', async () => {
    const base = await serve((_req, res) => res.writeHead(200).end())
    const dead = base.replace(/:\d+$/, ':1')
    const { evidence } = await probeUrl(`${dead}/mcp`, { ...probeOpts, timeoutMs: 2000 })
    const result = classifyProbe(evidence)
    expect(result.level).toBe(0)
    expect(result.probe.reachable).toBe(false)
  })

  it('5xx -> inalcancavel (N0), com o status registrado', async () => {
    const base = await serve((_req, res) => res.writeHead(503).end('down'))
    const { evidence } = await probeUrl(`${base}/mcp`, probeOpts)
    const result = classifyProbe(evidence)
    expect(result.probe).toMatchObject({ reachable: false, httpStatus: 503 })
    expect(result.level).toBe(0)
  })

  it('cortesia: User-Agent proprio e no maximo 3 requisicoes por segundo no mesmo host', async () => {
    const seen: Array<{ at: number; ua: string | undefined; method: string }> = []
    const base = await serve((req, res) => {
      seen.push({ at: Date.now(), ua: req.headers['user-agent'], method: req.method ?? '' })
      res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end()
    })
    const client = createHttp({ allowPrivate: true, timeoutMs: 4000 }) // minGapMs padrao (340)
    await probeUrl(`${base}/mcp`, { http: client, retryDelayMs: 10 })
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen.every((s) => s.ua === 'Openclod-MCP-Probe/1.0')).toBe(true)
    for (let i = 3; i < seen.length; i++) expect(seen[i].at - seen[i - 3].at).toBeGreaterThanOrEqual(900)
  })

  it('guarda de URL: sem allowPrivate nao toca em localhost, IP literal nem http', async () => {
    const client = createHttp()
    expect(client.blockedReason('http://example.com/mcp')).toBe('só https')
    expect(client.blockedReason('https://127.0.0.1/mcp')).toBe('IP literal')
    expect(client.blockedReason('https://localhost/mcp')).toBe('host local')
    expect(client.blockedReason('https://servidor.internal/mcp')).toBe('host local')
    expect(client.blockedReason('https://user:pw@example.com/mcp')).toBe('URL com credenciais')
    expect(client.blockedReason('https://mcp.exemplo.com/mcp')).toBeNull()
    const { evidence } = await probeUrl('https://127.0.0.1:9/mcp', { retryDelayMs: 1 })
    expect(evidence.error?.kind).toBe('blocked')
  })
})

// ---------------------------------------------------------------------------------------------
// Diretorio: helpers e o JSON gerado

describe('helpers do diretorio', () => {
  it('slugify gera ids ascii unicos-friendly', () => {
    expect(slugify('Atlassian MCP')).toBe('atlassian-mcp')
    expect(slugify('Mercado Pago (Brasil)')).toBe('mercado-pago-brasil')
    expect(slugify('Pontuação & Ação')).toBe('pontuacao-and-acao')
    expect(slugify('日本語')).toBe('')
    expect(slugify('  --A__B--  ')).toBe('a-b')
  })

  it('transporte sse so quando o caminho termina em /sse ou /mcpsse', () => {
    expect(transportForUrl('https://mcp.asana.com/sse')).toBe('sse')
    expect(transportForUrl('https://getunblocked.com/api/mcpsse')).toBe('sse')
    expect(transportForUrl('https://mcp.exemplo.com/mcp')).toBe('http')
    expect(transportForUrl('https://sse.exemplo.com/mcp')).toBe('http')
  })

  it('iconDomain vem do host do icone/URL, ignorando CDNs e IPs, sem baixar nada', () => {
    expect(iconDomainOf({ iconUrl: 'https://www.atlassian.com', url: 'https://mcp.atlassian.com/v2/mcp' })).toBe('atlassian.com')
    expect(iconDomainOf({ iconUrl: 'https://storage.googleapis.com/x/icons/quickbooks.svg', url: 'https://ai-inc.quickbooks.intuit.com/v1/mcp' })).toBe('intuit.com')
    expect(iconDomainOf({ url: 'https://mcp.exemplo.co.uk/mcp' })).toBe('exemplo.co.uk')
    expect(iconDomainOf({ iconUrl: 'https://raw.githubusercontent.com/o/r/icon.png' })).toBeUndefined()
    expect(iconDomainOf({ url: 'https://127.0.0.1/mcp' })).toBeUndefined()
    expect(registrableDomain('mcp.app.vercel.app')).toBe('app.vercel.app')
    expect(normalizeUrl('HTTPS://Mcp.Exemplo.com/mcp/')).toBe(normalizeUrl('https://mcp.exemplo.com/mcp'))
  })

  it('mergeDirectory: gemeo por URL vira UMA entrada do catalogo (com directoryUuid), local homonimo ganha "(local)"', () => {
    const harvest: HarvestRow[] = [
      { u: '11111111-1111-4111-8111-111111111111', n: 'Notion', d: 'Busca e edita paginas', c: 'produtividade', url: 'https://mcp.notion.com/mcp', i: 'https://www.notion.so', t: ['search'], tc: 13 },
      { u: '22222222-2222-4222-8222-222222222222', n: 'Stripe', d: 'Pagamentos', c: 'financas', url: 'https://mcp.stripe.com/', t: [], tc: 0 },
      { u: '33333333-3333-4333-8333-333333333333', n: 'Sem Endpoint', d: '', c: 'invalida', t: [], tc: 0 }
    ]
    const catalog = [
      { id: 'notion', name: 'Notion (oficial)', description: 'Notion', category: 'productivity', transport: 'http' as const, url: 'https://mcp.notion.com/mcp', oauth: true },
      { id: 'stripe', name: 'Stripe', description: 'Stripe local', category: 'cloud', transport: 'stdio' as const, command: 'npx', args: ['-y', '@stripe/mcp', '--api-key=${STRIPE_SECRET_KEY}'], env: [{ key: 'STRIPE_SECRET_KEY', label: 'Chave', required: true, secret: true }] }
    ]
    const entries = mergeDirectory({ harvest, catalog })
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const notion = entries.find((e) => e.id === 'notion')!
    expect(notion).toMatchObject({ source: 'openclod-catalog', directoryUuid: '11111111-1111-4111-8111-111111111111', auth: 'oauth', toolCount: 13, iconDomain: 'notion.so' })
    expect(entries.filter((e) => e.url && normalizeUrl(e.url) === normalizeUrl('https://mcp.notion.com/mcp'))).toHaveLength(1)
    const local = entries.find((e) => e.id === 'stripe')!
    expect(local).toMatchObject({ kind: 'local', transport: 'stdio', auth: 'local-env', name: 'Stripe (local)', category: 'financas' })
    expect(local.credentials?.[0]).toEqual({ key: 'STRIPE_SECRET_KEY', label: 'Chave', where: 'env', required: true, secret: true })
    const remote = entries.find((e) => e.id === 'stripe-remote')!
    expect(remote).toMatchObject({ kind: 'remote', source: 'claude-directory', auth: 'unknown', directoryUuid: '22222222-2222-4222-8222-222222222222' })
    const noUrl = entries.find((e) => e.directoryUuid === '33333333-3333-4333-8333-333333333333')!
    expect(noUrl).toMatchObject({ category: 'outros', auth: 'unknown', transport: 'http' })
    expect(noUrl.url).toBeUndefined()
    expect(noUrl.notes).toContain('Sem endpoint público')
  })

  it('mapCatalogEntry: cabecalho Authorization vira credencial com prefixo "Bearer " (sem o valor no exemplo)', () => {
    const entry = mapCatalogEntry({
      id: 'github',
      name: 'GitHub (oficial)',
      description: 'd',
      category: 'development',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: [{ key: 'Authorization', label: 'Authorization: Bearer <token>', required: true, secret: true, example: 'Bearer github_pat_...' }]
    })
    expect(entry.auth).toBe('api-key')
    expect(entry.credentials).toEqual([{ key: 'Authorization', label: 'Token de acesso (Bearer)', where: 'header', required: true, secret: true, prefix: 'Bearer ', example: 'github_pat_...' }])
  })

  it('previous: preserva probe e auth quando o id e a URL nao mudaram', () => {
    const harvest: HarvestRow[] = [{ u: '44444444-4444-4444-8444-444444444444', n: 'Exemplo', d: 'd', c: 'outros', url: 'https://mcp.exemplo.com/mcp', t: [], tc: 0 }]
    const first = mergeDirectory({ harvest, catalog: [] })
    const probed = applyProbe(first[0], classifyProbe({ status: 401, wwwAuthenticate: 'Basic realm="x"' }, NOW))
    const again = mergeDirectory({ harvest, catalog: [], previous: [probed] })
    expect(again[0].auth).toBe('api-key')
    expect(again[0].probe?.checkedAt).toBe(NOW)
  })

  it('previous: credenciais acrescentadas a mao a uma entrada do diretorio do Claude (ex.: Learning Commons) sobrevivem a uma nova coleta', () => {
    const harvest: HarvestRow[] = [{ u: '55555555-5555-4555-8555-555555555555', n: 'Learning Commons', d: 'd', c: 'outros', url: 'https://kg.mcp.exemplo.org/mcp', t: [], tc: 0 }]
    const first = mergeDirectory({ harvest, catalog: [] })
    const probed = applyProbe(first[0], classifyProbe({ status: 401, wwwAuthenticate: 'Key' }, NOW))
    const edited = { ...probed, credentials: [{ key: 'x-api-key', label: 'Chave de API', where: 'header' as const, required: true, secret: true }] }
    const again = mergeDirectory({ harvest, catalog: [], previous: [edited] })
    expect(again[0].credentials).toEqual(edited.credentials)
    // Sem a edicao a entrada continua sem credenciais (nada inventado).
    expect(mergeDirectory({ harvest, catalog: [], previous: [probed] })[0].credentials).toBeUndefined()
  })
})

describe('rebuild preserva o que a sondagem descobriu', () => {
  const catalog = [
    { id: 'slack', name: 'Slack', description: 'Slack', category: 'communication', transport: 'http' as const, url: 'https://mcp.slack.com/mcp', oauth: true },
    {
      id: 'github',
      name: 'GitHub',
      description: 'GitHub',
      category: 'development',
      transport: 'http' as const,
      url: 'https://api.githubcopilot.com/mcp/',
      headers: [{ key: 'Authorization', label: 'Authorization: Bearer <token>', required: true, secret: true }]
    }
  ]

  it('auth corrigido pela sondagem (OAuth -> oauth-static) e a nota "Sondagem:" sobrevivem a um novo build, e o build e idempotente', () => {
    const first = mergeDirectory({ harvest: [], catalog })
    const evStatic: ProbeEvidence = { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m/prm"', prm: { found: true, advertised: true }, as: asOk }
    const slack = applyProbe(first.find((e) => e.id === 'slack')!, classifyProbe(evStatic, NOW), evStatic)
    const evDcr: ProbeEvidence = { status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://m/prm"', prm: { found: true, advertised: true }, as: { ...asOk, registrationEndpoint: 'https://a/reg' } }
    const github = applyProbe(first.find((e) => e.id === 'github')!, classifyProbe(evDcr, NOW), evDcr)
    expect(slack.auth).toBe('oauth-static')
    expect(github.auth).toBe('api-key')
    expect(github.notes).toContain('Sondagem:')

    const again = mergeDirectory({ harvest: [], catalog, previous: [slack, github] })
    expect(again.find((e) => e.id === 'slack')).toEqual(slack)
    expect(again.find((e) => e.id === 'github')).toEqual(github)
    expect(mergeDirectory({ harvest: [], catalog, previous: again })).toEqual(again)
  })

  it('url do catalogo mudou: a sondagem antiga (de outra URL) e descartada', () => {
    const first = mergeDirectory({ harvest: [], catalog })
    const slack = applyProbe(first.find((e) => e.id === 'slack')!, classifyProbe({ status: 401, wwwAuthenticate: 'Basic realm="x"' }, NOW))
    const moved = [{ ...catalog[0], url: 'https://mcp.slack.com/v2/mcp' }, catalog[1]]
    const rebuilt = mergeDirectory({ harvest: [], catalog: moved, previous: [slack] })
    expect(rebuilt.find((e) => e.id === 'slack')?.probe).toBeUndefined()
  })
})

const CATEGORY_RECORD: Record<ConnectorCategory, true> = {
  produtividade: true,
  desenvolvimento: true,
  comunicacao: true,
  design: true,
  dados: true,
  financas: true,
  'vendas-crm': true,
  marketing: true,
  suporte: true,
  documentos: true,
  'nuvem-infra': true,
  'seguranca-compliance': true,
  pesquisa: true,
  viagens: true,
  'saude-ciencia': true,
  midia: true,
  rh: true,
  juridico: true,
  outros: true
}
const AUTH_RECORD: Record<ConnectorAuth, true> = { oauth: true, 'oauth-static': true, 'api-key': true, 'local-env': true, none: true, unknown: true }

describe('resources/mcp-directory.json', () => {
  const file = path.join(__dirname, '..', 'resources', 'mcp-directory.json')
  const directory = JSON.parse(fs.readFileSync(file, 'utf8')) as ConnectorDirectory
  const entries = directory.entries

  it('passa nas invariantes do build (ids unicos, categorias, https, sem segredo)', () => {
    expect(validateDirectory(directory)).toEqual([])
  })

  it('tem os campos obrigatorios do contrato com os tipos certos', () => {
    expect(typeof directory.generatedAt).toBe('number')
    expect(entries.length).toBeGreaterThan(500)
    for (const e of entries) {
      expect(typeof e.id).toBe('string')
      expect(typeof e.name).toBe('string')
      expect(e.name.length).toBeGreaterThan(0)
      expect(typeof e.description).toBe('string')
      expect(e.description.length).toBeGreaterThan(0)
      expect(CATEGORY_RECORD[e.category]).toBe(true)
      expect(['remote', 'local']).toContain(e.kind)
      expect(['http', 'sse', 'stdio']).toContain(e.transport)
      expect(AUTH_RECORD[e.auth]).toBe(true)
      expect(Array.isArray(e.tools)).toBe(true)
      expect(['claude-directory', 'openclod-catalog']).toContain(e.source)
      if (e.toolCount !== undefined) expect(Number.isInteger(e.toolCount) && e.toolCount >= 0).toBe(true)
      if (e.probe) {
        expect(typeof e.probe.checkedAt).toBe('number')
        expect(typeof e.probe.reachable).toBe('boolean')
      }
    }
  })

  it('ids unicos, so [a-z0-9-], e directoryUuid unico', () => {
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    const uuids = entries.map((e) => e.directoryUuid).filter(Boolean)
    expect(new Set(uuids).size).toBe(uuids.length)
    for (const u of uuids) expect(u).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  })

  it('conectores remotos usam https e transport http/sse; locais stdio trazem command', () => {
    for (const e of entries) {
      if (e.kind === 'remote') {
        expect(['http', 'sse']).toContain(e.transport)
        if (e.url) expect(new URL(e.url).protocol).toBe('https:')
        else expect(e.notes ?? '').toContain('Sem endpoint público')
      }
      if (e.kind === 'local' && e.transport === 'stdio') expect(e.command).toBeTruthy()
    }
  })

  it('o catalogo proprio esta la: atlassian, atlassian-token e jira mantem os ids e as credenciais', () => {
    const byId = new Map(entries.map((e) => [e.id, e]))
    expect(byId.get('atlassian')).toMatchObject({ source: 'openclod-catalog', kind: 'remote', url: 'https://mcp.atlassian.com/v2/mcp' })
    expect(byId.get('atlassian-token')).toMatchObject({ source: 'openclod-catalog', kind: 'remote', auth: 'api-key' })
    expect(byId.get('atlassian-token')!.credentials?.map((c) => c.key)).toEqual(['ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'])
    expect(byId.get('jira')).toMatchObject({ source: 'openclod-catalog', kind: 'local', transport: 'stdio', command: 'uvx', auth: 'local-env' })
    expect(byId.get('jira')!.credentials?.find((c) => c.key === 'JIRA_API_TOKEN')).toMatchObject({ where: 'env', required: true, secret: true })
    // o gemeo do diretorio do Claude nao duplica o servico
    const atlassianUrls = entries.filter((e) => e.url === 'https://mcp.atlassian.com/v2/mcp').map((e) => e.id)
    expect(atlassianUrls.sort()).toEqual(['atlassian', 'atlassian-token'])
  })

  it('credenciais so declaram o NOME da variavel/cabecalho (nunca um valor)', () => {
    const allowed = new Set(['key', 'label', 'where', 'required', 'secret', 'prefix', 'example', 'help'])
    for (const e of entries) {
      for (const c of e.credentials ?? []) {
        for (const k of Object.keys(c)) expect(allowed.has(k)).toBe(true)
        if (c.secret && c.example) expect(c.example).not.toMatch(/[A-Za-z0-9_-]{24,}/)
      }
    }
  })

  it('toda entrada sondada traz um probe coerente com o auth', () => {
    for (const e of entries) {
      if (!e.probe) continue
      const level = probeLevel(e.probe)
      // "none" so quando o servidor aberto NAO publica metadata OAuth (senao as chamadas de ferramenta pedem login)
      if (e.probe.openAccess && e.auth === 'none') expect(e.probe.resourceMetadata).not.toBe(true)
      if (e.auth === 'none') expect(e.probe.reachable).toBe(true)
      if (e.source === 'claude-directory' && e.auth === 'oauth') {
        expect(e.probe.dynamicRegistration).toBe(true)
        expect(level).toBeGreaterThanOrEqual(2)
      }
      if (e.source === 'claude-directory' && e.auth === 'oauth-static') expect(e.probe.dynamicRegistration).not.toBe(true)
      if (!e.probe.reachable) expect(level).toBe(0)
    }
  })
})
