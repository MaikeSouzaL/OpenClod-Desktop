// Logica PURA da sondagem de endpoints MCP remotos (sem rede, sem disco). Quem faz as requisicoes e
// scripts/mcp-probe.mjs; aqui ficam o parser de WWW-Authenticate, os caminhos de descoberta OAuth (RFC 9728/8414/OIDC),
// o parser de SSE e a classificacao das evidencias (`classifyProbe`), testados com fixtures em tests/mcp-probe.test.ts.

export const PROBE_USER_AGENT = 'Openclod-MCP-Probe/1.0'
export const PROBE_PROTOCOL_VERSION = '2025-06-18'

/**
 * Cabecalho WWW-Authenticate -> [{ scheme, params }]. Aceita varios desafios no mesmo valor
 * (`Bearer realm="x", resource_metadata="https://..", Basic realm="y"`). Chaves dos params em minusculas.
 */
export function parseWwwAuthenticate(header) {
  const challenges = []
  if (typeof header !== 'string' || !header.trim()) return challenges
  const re = /\s*,?\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]*))?/y
  let current = null
  let match
  while (re.lastIndex < header.length && (match = re.exec(header))) {
    const [, token, raw] = match
    if (raw === undefined) {
      current = { scheme: token, params: {} }
      challenges.push(current)
    } else if (current) {
      const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
      current.params[token.toLowerCase()] = value
    }
  }
  return challenges
}

/** URL do `resource_metadata` anunciado em qualquer desafio (RFC 9728 §5.1), ou undefined. */
export function resourceMetadataFromHeader(header) {
  for (const challenge of parseWwwAuthenticate(header)) {
    const url = challenge.params.resource_metadata
    if (url) return url
  }
  return undefined
}

/** RFC 9728 §3: o documento fica em /.well-known/oauth-protected-resource inserido entre host e caminho do recurso. */
export function protectedResourceMetadataCandidates(resourceUrl) {
  const u = new URL(resourceUrl)
  const path = u.pathname.replace(/\/+$/, '')
  const root = `${u.origin}/.well-known/oauth-protected-resource`
  return path ? [`${root}${path}`, root] : [root]
}

/**
 * Onde procurar o metadata do authorization server (RFC 8414 + OIDC Discovery). Para um issuer COM caminho
 * (`https://auth.exemplo.com/tenant1`) tenta as DUAS formas: insercao (`<origin>/.well-known/<x><path>`, RFC 8414) e
 * anexo (`<issuer>/.well-known/<x>`); sem caminho, so a raiz. Ordem: OAuth primeiro, depois OIDC.
 */
export function authServerMetadataCandidates(issuer) {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, '')
  const base = `${u.origin}${path}`
  const out = []
  if (path) {
    out.push(`${u.origin}/.well-known/oauth-authorization-server${path}`)
    out.push(`${base}/.well-known/oauth-authorization-server`)
    out.push(`${u.origin}/.well-known/openid-configuration${path}`)
    out.push(`${base}/.well-known/openid-configuration`)
  } else {
    out.push(`${u.origin}/.well-known/oauth-authorization-server`)
    out.push(`${u.origin}/.well-known/openid-configuration`)
  }
  return out
}

/** Texto de um corpo SSE -> eventos [{ event, data, id }] (data com varias linhas e juntada por \n). */
export function parseSseEvents(text) {
  const events = []
  let event = 'message'
  let id
  let data = []
  const flush = () => {
    if (data.length) events.push({ event, data: data.join('\n'), id })
    event = 'message'
    id = undefined
    data = []
  }
  for (const rawLine of String(text).split(/\r\n|\r|\n/)) {
    if (rawLine === '') {
      flush()
      continue
    }
    if (rawLine.startsWith(':')) continue
    const colon = rawLine.indexOf(':')
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
    let value = colon === -1 ? '' : rawLine.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  flush()
  return events
}

/** Mensagens JSON-RPC (objetos) contidas num corpo JSON ou SSE. Ignora o que nao for JSON. */
export function jsonRpcMessages(text, contentType = '') {
  const out = []
  const push = (value) => {
    if (Array.isArray(value)) value.forEach(push)
    else if (value && typeof value === 'object' && (value.jsonrpc || 'result' in value || 'error' in value || value.method)) out.push(value)
  }
  const asSse = /event-stream/i.test(contentType) || /^\s*(event|data|id|:)/m.test(String(text).slice(0, 200)) && !/^\s*[[{]/.test(String(text))
  if (asSse) {
    for (const ev of parseSseEvents(text)) {
      try {
        push(JSON.parse(ev.data))
      } catch {
        /* evento nao-JSON (ex.: endpoint) */
      }
    }
  } else {
    try {
      push(JSON.parse(text))
    } catch {
      /* corpo nao-JSON */
    }
  }
  return out
}

/** `initialize` valido: resultado JSON-RPC com protocolVersion/serverInfo/capabilities. */
export function isInitializeResult(message) {
  const r = message?.result
  return !!r && typeof r === 'object' && (typeof r.protocolVersion === 'string' || !!r.serverInfo || !!r.capabilities)
}

/** O servidor ou o WAF barrou a requisicao com um desafio (nao e erro do MCP). */
export function detectWaf(status, headers, body) {
  const get = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? ''
  const text = String(body ?? '').slice(0, 4000).toLowerCase()
  if (String(get('cf-mitigated')).toLowerCase() === 'challenge') return true
  if (status === 403 || status === 503 || status === 429 || status === 406) {
    if (/just a moment|attention required|cf-chl|challenge-platform|_incapsula_|datadome|captcha|access denied.*(akamai|edgesuite)|px-captcha|request blocked|you have been blocked|errors\.edgesuite\.net/.test(text)) return true
  }
  // 403/406 que devolve uma pagina HTML sem WWW-Authenticate: quase sempre o WAF/CDN barrando o User-Agent, nao o MCP.
  if ((status === 403 || status === 406) && !get('www-authenticate') && /^\s*(<!doctype|<html|<head|<\?xml)/i.test(String(body ?? ''))) return true
  return false
}

const KEY_HINT =
  /api[\s_-]?key|x-api-key|apikey|access[\s_-]?key|secret[\s_-]?key|chave de api|(provide|missing|invalid|required|need|requires|expected).{0,40}(api[\s_-]?key|token)|(api[\s_-]?key|token).{0,30}(required|missing|invalid|obrigat)/i

export function mentionsApiKey(text) {
  return typeof text === 'string' && KEY_HINT.test(text)
}

/** Mensagem curta de erro de rede em pt-BR a partir de `error.kind`. */
export function describeNetworkError(error) {
  if (!error) return 'sem resposta'
  const detail = error.message ? ` (${String(error.message).slice(0, 80)})` : ''
  switch (error.kind) {
    case 'dns':
      return `DNS não resolve${detail}`
    case 'timeout':
      return 'tempo esgotado (12 s) sem resposta'
    case 'tls':
      return `falha de TLS/certificado${detail}`
    case 'refused':
      return 'conexão recusada'
    case 'reset':
      return `conexão reiniciada pelo servidor${detail}`
    case 'blocked':
      return `URL bloqueada pela sondagem${detail}`
    default:
      return `erro de rede${detail}`
  }
}

/** Erro do fetch (undici) -> { kind, message }. */
export function classifyNetworkError(err) {
  const code = String(err?.cause?.code ?? err?.code ?? '')
  const name = String(err?.name ?? '')
  const message = String(err?.cause?.message ?? err?.message ?? '')
  if (/ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME/.test(code)) return { kind: 'dns', message: code }
  if (/ECONNREFUSED/.test(code)) return { kind: 'refused', message: code }
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT|ETIMEDOUT/.test(code)) return { kind: 'timeout', message: code || name }
  if (/CERT|TLS|SSL|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|WRONG_VERSION/.test(code + message)) return { kind: 'tls', message: code || message.slice(0, 80) }
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|terminated/.test(code + message)) return { kind: 'reset', message: code || message.slice(0, 80) }
  return { kind: 'other', message: (code || message).slice(0, 80) }
}

/**
 * Nivel de teste N0..N4 a partir do `probe` gravado (N5 = "conectado com a conta do usuario" nao existe sem o usuario).
 *  N0 inalcancavel · N1 alcancavel · N2 chega ao login (401 + metadata OAuth) · N3 login possivel (DCR + PKCE S256) ·
 *  N4 conecta sem login (initialize ok). Devolve null quando a entrada nao foi sondada.
 */
export function probeLevel(probe) {
  if (!probe) return null
  if (!probe.reachable) return 0
  if (probe.openAccess) return 4
  if (probe.dynamicRegistration === true && probe.pkceS256 === true) return 3
  if (probe.resourceMetadata === true || probe.dynamicRegistration !== undefined) return 2
  return 1
}

/**
 * Evidencias -> classificacao. Funcao pura.
 *
 * Evidencias (todas opcionais menos o que se indica):
 *  {
 *    error?: { kind, message },            // falha de rede/timeout na requisicao decisiva
 *    status?: number,                      // HTTP da requisicao decisiva (POST initialize, ou o GET SSE)
 *    wwwAuthenticate?: string,             // cabecalho do 401/403 decisivo
 *    authBody?: string,                    // trecho do corpo do 401/403 / resposta nao-MCP
 *    waf?: boolean,                        // 403/503 de WAF/anti-bot
 *    rateLimited?: boolean,                // 429 persistente
 *    redirectedTo?: string,                // host final quando a URL redireciona para outro host
 *    initialize?: { ok: boolean, rpcError?: string },
 *    transport?: 'http' | 'sse',           // transporte em que o initialize respondeu
 *    tools?: { ok: boolean, count?: number, status?: number, error?: string },
 *    prm?: { found: boolean, advertised?: boolean, via?: 'header'|'well-known', authorizationServers?: string[], scopesSupported?: string[] },
 *    as?: { found: boolean, issuer?: string, registrationEndpoint?: string, codeChallengeMethods?: string[], scopesSupported?: string[], via?: string },
 *    sse?: { endpointEvent: boolean, status?: number }
 *  }
 * Devolve { auth, probe: ConnectorProbe, level, scopes? }.
 */
export function classifyProbe(ev = {}, now = Date.now()) {
  const probe = { checkedAt: now, reachable: true }
  const notes = []
  const finish = (auth, extra = {}) => {
    Object.assign(probe, extra)
    if (notes.length) probe.note = notes.join('; ')
    const result = { auth, probe, level: probeLevel(probe) }
    const scopes = ev.as?.scopesSupported?.length ? ev.as.scopesSupported : ev.prm?.scopesSupported
    if (scopes?.length) result.scopes = [...scopes]
    return result
  }

  if (ev.redirectedTo) notes.push(`redireciona para ${ev.redirectedTo}`)

  const status = ev.status
  if (ev.error || ev.reachable === false) {
    probe.reachable = false
    if (status !== undefined) probe.httpStatus = status
    notes.unshift(`Inalcançável: ${describeNetworkError(ev.error)}`)
    return finish('unknown')
  }
  if (typeof status === 'number') probe.httpStatus = status

  // 5xx: servidor fora do ar (ou WAF respondendo 503) -> inalcancavel para fins de conexao
  if (typeof status === 'number' && status >= 500 && !ev.initialize?.ok) {
    probe.reachable = false
    notes.unshift(ev.waf ? `Inalcançável: HTTP ${status} de proteção anti-bot` : `Inalcançável: HTTP ${status} do servidor`)
    return finish('unknown')
  }

  // Acesso aberto: initialize respondeu sem credenciais. (Se tools/list pede login, o servidor e protegido.)
  const toolsNeedAuth = ev.tools && (ev.tools.status === 401 || ev.tools.status === 403)
  if (ev.initialize?.ok && !toolsNeedAuth) {
    probe.openAccess = true
    probe.transportOk = ev.transport === 'sse' ? 'sse' : 'http'
    if (ev.stateless) notes.push(`protocolo MCP ${ev.stateless} sem estado: respondeu server/discover (sem initialize)`)
    if (ev.tools?.ok && typeof ev.tools.count === 'number') notes.push(`tools/list sem login: ${ev.tools.count} ferramentas`)
    else if (ev.tools && !ev.tools.ok) notes.push(`initialize aberto, mas tools/list falhou${ev.tools.error ? ` (${ev.tools.error})` : ev.tools.status ? ` (HTTP ${ev.tools.status})` : ''}`)
    // Handshake e listagem abertos, mas o servidor publica metadata OAuth (RFC 9728): quem protege so as chamadas de
    // ferramenta (ex.: Gmail/Drive do Google) responde assim. Marcar "none" faria o cliente nunca pedir login.
    if (ev.prm?.found) {
      const asFound = !!ev.as?.found
      const dcr = !!ev.as?.registrationEndpoint
      const pkce = (ev.as?.codeChallengeMethods ?? []).some((m) => String(m).toUpperCase() === 'S256')
      const extra = { resourceMetadata: true }
      if (asFound) {
        extra.dynamicRegistration = dcr
        extra.pkceS256 = pkce
      } else extra.dynamicRegistration = false
      notes.push(
        `publica protected-resource metadata OAuth: as chamadas de ferramenta provavelmente exigem login (${dcr ? 'registro dinâmico anunciado' : asFound ? 'sem registro dinâmico: client id pré-registrado' : 'metadata do AS ilegível'})`
      )
      return finish(dcr ? 'oauth' : 'oauth-static', extra)
    }
    return finish('none')
  }

  if (ev.rateLimited || status === 429) {
    notes.push('limitado por taxa (HTTP 429) mesmo após esperar; autenticação não determinada')
    return finish('unknown')
  }

  if (ev.redirectBlocked) {
    notes.push(`HTTP ${status} redireciona para ${ev.redirectBlocked} (fora de https ou host proibido); não seguido, então o endpoint não respondeu como MCP`)
    return finish('unknown')
  }

  if (ev.waf && (status === 403 || status === 406) && !ev.wwwAuthenticate && !toolsNeedAuth) {
    notes.push(`HTTP ${status} de provável bloqueio de WAF/CDN/anti-bot (página HTML ou desafio, sem WWW-Authenticate); autenticação não determinada`)
    return finish('unknown')
  }

  if (ev.versionMismatch && !ev.initialize?.ok) {
    notes.push(`o servidor só aceita MCP ${ev.versionMismatch.join(', ')} (protocolo sem estado, sem initialize); o discover não concluiu sem credenciais`)
    return finish('unknown')
  }

  const authStatus = toolsNeedAuth ? ev.tools.status : status
  if (authStatus === 401 || authStatus === 403) {
    if (toolsNeedAuth) notes.push('initialize responde sem login, mas tools/list exige credenciais')
    const prmAdvertised = !!(ev.prm?.found || ev.prm?.advertised || resourceMetadataFromHeader(ev.wwwAuthenticate))
    const asFound = !!ev.as?.found
    const dcr = !!ev.as?.registrationEndpoint
    const pkce = (ev.as?.codeChallengeMethods ?? []).some((m) => String(m).toUpperCase() === 'S256')

    if (prmAdvertised || asFound) {
      const extra = { resourceMetadata: prmAdvertised }
      if (asFound) {
        extra.dynamicRegistration = dcr
        extra.pkceS256 = pkce
        if (dcr) {
          notes.push(`${authStatus} com login OAuth; registro dinâmico (RFC 7591) ${pkce ? 'e PKCE S256 anunciados' : 'anunciado, mas PKCE S256 não anunciado'}`)
        } else {
          notes.push(`${authStatus} com login OAuth, mas o servidor de autorização NÃO anuncia registro dinâmico: precisa de client id pré-registrado${ev.as.cimd ? ' (ou Client ID Metadata Document, que o AS anuncia)' : ''}`)
        }
        if (!prmAdvertised) notes.push('descoberta legada (sem protected-resource metadata)')
      } else {
        extra.dynamicRegistration = false
        notes.push(`${authStatus} anuncia OAuth, mas o metadata do servidor de autorização não pôde ser lido; registro dinâmico não confirmado`)
      }
      return finish(dcr ? 'oauth' : 'oauth-static', extra)
    }

    const challenges = parseWwwAuthenticate(ev.wwwAuthenticate)
    const scheme = challenges[0]?.scheme
    const keyMessage = mentionsApiKey(ev.authBody) || mentionsApiKey(ev.initialize?.rpcError)
    if (scheme && /^(basic|apikey|api-key|key|bearer|token|x-api-key)$/i.test(scheme)) {
      notes.push(`${authStatus} com WWW-Authenticate ${scheme} sem metadata OAuth: espera chave/token fixo`)
      return finish('api-key')
    }
    if (keyMessage) {
      notes.push(`${authStatus} pedindo chave de API/token na mensagem de erro`)
      return finish('api-key')
    }
    notes.push(
      authStatus === 401
        ? '401 exige credencial, mas não indica o esquema (sem WWW-Authenticate nem metadata OAuth)'
        : `${authStatus} sem WWW-Authenticate nem metadata OAuth: pode ser credencial exigida ou bloqueio de borda; esquema não indicado`
    )
    return finish('unknown')
  }

  // initialize 200 com erro JSON-RPC
  if (ev.initialize && ev.initialize.ok === false && ev.initialize.rpcError) {
    if (mentionsApiKey(ev.initialize.rpcError)) {
      notes.push('initialize devolveu erro JSON-RPC pedindo chave de API/token')
      return finish('api-key')
    }
    notes.push(`initialize devolveu erro JSON-RPC: ${String(ev.initialize.rpcError).slice(0, 100)}`)
    return finish('unknown')
  }

  // SSE legado: o GET abriu o stream e anunciou o endpoint, mas initialize nao concluiu
  if (ev.sse?.endpointEvent) {
    probe.transportOk = 'sse'
    notes.push('SSE legado respondeu "event: endpoint", mas o initialize não foi concluído sem credenciais')
    return finish('unknown')
  }

  if (typeof status === 'number') {
    if (status === 404 || status === 405 || status === 410) notes.push(`HTTP ${status}: a URL responde, mas não é um endpoint MCP (POST/GET SSE)`)
    else if (status === 400 || status === 406 || status === 415) notes.push(`HTTP ${status} ao POST initialize (sessão/cabeçalho exigido?); autenticação não determinada`)
    else if (status >= 200 && status < 300) notes.push(`HTTP ${status} sem resposta JSON-RPC de initialize (não parece servidor MCP)`)
    else if (status >= 300 && status < 400) notes.push(`HTTP ${status} (redirecionamento não resolvido)`)
    else notes.push(`HTTP ${status}; autenticação não determinada`)
  } else {
    notes.push('resposta sem status utilizável')
  }
  return finish('unknown')
}

/**
 * Aplica o resultado de `classifyProbe` numa entrada do diretorio (sem mutar a original).
 *  - Servidores locais e entradas sem URL nao sao tocados.
 *  - Catalogo proprio com credenciais conhecidas (api-key) mantem o `auth` do catalogo e ganha uma nota se a sondagem diverge.
 *  - `toolCount` so e atualizado quando tools/list aberto contou ferramentas.
 */
export function applyProbe(entry, result, ev = {}) {
  const next = { ...entry, probe: result.probe }
  const catalogKnown = entry.source === 'openclod-catalog' && entry.auth === 'api-key' && (entry.credentials?.length ?? 0) > 0
  // Diretorio do Claude: `auth` reflete SEMPRE a ultima sondagem (um 403 de WAF hoje nao pode herdar o OAuth de ontem).
  // Catalogo proprio: so e corrigido quando a sondagem conclui algo; "unknown" nao apaga o que o catalogo sabe.
  let auth = entry.auth
  if (catalogKnown) auth = entry.auth
  else if (entry.source === 'claude-directory') auth = result.auth
  else if (result.auth !== 'unknown') auth = result.auth
  next.auth = auth

  const cleaned = String(entry.notes ?? '').replace(/\s*Sondagem:[^\n]*$/, '').trim()
  if (catalogKnown && result.auth !== 'unknown' && result.auth !== auth) {
    const label = result.auth === 'none' ? 'o endpoint também responde sem credencial' : `o endpoint também aceita login (${result.auth})`
    next.notes = `${cleaned ? cleaned + ' ' : ''}Sondagem: ${label}.`
  } else if (cleaned) next.notes = cleaned
  else delete next.notes

  if (ev.tools?.ok && typeof ev.tools.count === 'number' && result.probe.openAccess) {
    next.toolCount = ev.tools.count
    if (Array.isArray(ev.tools.names) && ev.tools.names.length && !(entry.tools?.length)) next.tools = ev.tools.names.slice(0, 8)
  }
  // `oauthScopes` NAO e preenchido a partir de scopes_supported: o contrato o reserva para servidores que nao publicam
  // os escopos; os anunciados ficam so na evidencia (docs/mcp/sondagem-evidencias.json).
  return next
}
