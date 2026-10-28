#!/usr/bin/env node
// Sonda os endpoints MCP remotos de resources/mcp-directory.json SEM credenciais e grava o resultado
// (`probe` + `auth`) de volta nas entradas, mais as evidencias em docs/mcp/sondagem-evidencias.json.
//
// O que faz por URL (nunca faz login, registro dinamico de cliente nem chama ferramentas alem de tools/list):
//   1. POST JSON-RPC `initialize` (protocolVersion 2025-06-18). 200 com resultado = acesso aberto -> notifications/initialized + tools/list.
//   2. 401/403: le WWW-Authenticate (resource_metadata), busca o protected-resource metadata (RFC 9728) e o metadata do
//      authorization server (RFC 8414 e OIDC, issuer com caminho nas duas formas) para ver registration_endpoint e PKCE S256.
//   3. 404/405/400 no POST: tenta o transporte SSE legado (GET text/event-stream -> `event: endpoint`).
// Cortesia: concorrencia 8, timeout 12 s, no maximo 3 requisicoes/s por host, respeita 429/Retry-After,
// User-Agent "Openclod-MCP-Probe/1.0".
//
// Uso: node scripts/mcp-probe.mjs [--only id1,id2] [--limit N] [--concurrency 8] [--timeout 12000]
//                                 [--skip-probed-hours H] [--no-write] [--allow-private]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROBE_PROTOCOL_VERSION,
  PROBE_USER_AGENT,
  applyProbe,
  authServerMetadataCandidates,
  classifyNetworkError,
  classifyProbe,
  detectWaf,
  isInitializeResult,
  jsonRpcMessages,
  parseSseEvents,
  probeLevel,
  protectedResourceMetadataCandidates,
  resourceMetadataFromHeader
} from './lib/mcp-probe-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRECTORY = path.join(ROOT, 'resources', 'mcp-directory.json')
const EVIDENCE = path.join(ROOT, 'docs', 'mcp', 'sondagem-evidencias.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------
// HTTP educado: guarda de URL, limite por host, timeout, redirecionamento manual, 429

function blockedReason(rawUrl, allowPrivate) {
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    return 'URL inválida'
  }
  if (allowPrivate) return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'protocolo não suportado'
  if (u.protocol !== 'https:') return 'só https'
  if (u.username || u.password) return 'URL com credenciais'
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || /\.(local|localhost|internal|lan|home\.arpa|corp)$/.test(host)) return 'host local'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return 'IP literal'
  if (!host.includes('.')) return 'host sem domínio'
  return null
}

export function createHttp(options = {}) {
  const opts = {
    timeoutMs: options.timeoutMs ?? 12_000,
    minGapMs: options.minGapMs ?? 340, // < 3 requisicoes por segundo por host
    allowPrivate: options.allowPrivate ?? false,
    maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
    userAgent: options.userAgent ?? PROBE_USER_AGENT
  }
  const nextAt = new Map()
  const stats = { requests: 0, byHost: new Map() }

  async function throttle(host) {
    const now = Date.now()
    const at = Math.max(now, nextAt.get(host) ?? 0)
    nextAt.set(host, at + opts.minGapMs)
    if (at > now) await sleep(at - now)
  }

  /** fetch com redirecionamento manual (ate 3 saltos, cada um conferido e limitado por host). Nao le o corpo. */
  async function fetchFollow(rawUrl, init, signal) {
    let url = rawUrl
    let method = init.method ?? 'GET'
    const hops = []
    for (let hop = 0; hop <= 3; hop++) {
      const reason = blockedReason(url, opts.allowPrivate)
      if (reason) return { error: { kind: 'blocked', message: reason }, hops }
      const host = new URL(url).host
      await throttle(host)
      stats.requests++
      stats.byHost.set(host, (stats.byHost.get(host) ?? 0) + 1)
      let res
      try {
        res = await fetch(url, {
          method,
          headers: { 'user-agent': opts.userAgent, ...(init.headers ?? {}) },
          body: method === 'GET' || method === 'DELETE' ? undefined : init.body,
          redirect: 'manual',
          signal
        })
      } catch (err) {
        return { error: classifyNetworkError(err), hops }
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && init.followRedirects !== false) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!location) return { res, url, hops }
        let target
        try {
          target = new URL(location, url).href
        } catch {
          return { error: { kind: 'other', message: 'Location inválido' }, hops }
        }
        // Destino proibido (http, IP, host local): nao e seguido, mas a resposta 3xx conta como "alcancavel".
        if (blockedReason(target, opts.allowPrivate)) return { res, url, hops, redirectBlocked: target.replace(/[?#].*$/, '') }
        url = target
        hops.push(url)
        if (res.status === 303) method = 'GET'
        continue
      }
      return { res, url, hops }
    }
    return { error: { kind: 'other', message: 'redirecionamentos demais' }, hops }
  }

  async function readBody(res, until, maxBytes, signal) {
    if (!res.body) return { text: '', truncated: false }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        text += decoder.decode(value, { stream: true })
        if (until?.(text, res)) break
        if (bytes >= maxBytes) {
          truncated = true
          break
        }
        if (signal.aborted) break
      }
    } catch {
      /* timeout/abort durante a leitura: segue com o que chegou */
    } finally {
      reader.cancel().catch(() => {})
    }
    return { text, truncated }
  }

  /** Requisicao completa: corpo limitado, `until(text,res)` para parar de ler um stream SSE ao achar a resposta. */
  async function request(rawUrl, init = {}) {
    const signal = AbortSignal.timeout(init.timeoutMs ?? opts.timeoutMs)
    const followed = await fetchFollow(rawUrl, init, signal)
    if (followed.error) return { error: followed.error, hops: followed.hops }
    const { res } = followed
    if (followed.redirectBlocked) return { status: res.status, headers: res.headers, text: '', url: followed.url, hops: followed.hops, redirectBlocked: followed.redirectBlocked }
    const body = await readBody(res, init.until, init.maxBytes ?? 262_144, signal)
    return { status: res.status, headers: res.headers, text: body.text, url: followed.url, hops: followed.hops, truncated: body.truncated }
  }

  /** `request` + 429: espera o Retry-After (maximo 30 s) e tenta de novo ate 2 vezes. */
  async function requestWithRetry(rawUrl, init = {}) {
    let attempt = 0
    for (;;) {
      const out = await request(rawUrl, init)
      if (out.status !== 429) return out
      const header = out.headers.get('retry-after')
      let waitMs = 2000
      if (header) {
        const seconds = Number(header)
        if (Number.isFinite(seconds)) waitMs = seconds * 1000
        else {
          const date = Date.parse(header)
          if (!Number.isNaN(date)) waitMs = Math.max(0, date - Date.now())
        }
      }
      if (attempt >= 2 || waitMs > opts.maxRetryAfterMs) return { ...out, rateLimited: true }
      attempt++
      await sleep(Math.min(waitMs, opts.maxRetryAfterMs))
    }
  }

  async function getJson(rawUrl) {
    const out = await requestWithRetry(rawUrl, { headers: { accept: 'application/json' }, maxBytes: 262_144 })
    if (out.error || out.status !== 200) return { status: out.status, error: out.error }
    try {
      const json = JSON.parse(out.text)
      return { status: 200, json: json && typeof json === 'object' ? json : undefined }
    } catch {
      return { status: 200 }
    }
  }

  /** GET que fica aberto (SSE legado). Devolve a Response + controle de cancelamento. */
  async function openStream(rawUrl, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const followed = await fetchFollow(rawUrl, { headers: { accept: 'text/event-stream' } }, controller.signal)
    if (followed.error) {
      clearTimeout(timer)
      return { error: followed.error }
    }
    return {
      res: followed.res,
      url: followed.url,
      close: () => {
        clearTimeout(timer)
        controller.abort()
      }
    }
  }

  return { request, requestWithRetry, getJson, openStream, stats, opts, blockedReason: (u) => blockedReason(u, opts.allowPrivate) }
}

// ---------------------------------------------------------------------------------------------
// Passos da sondagem

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROBE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'openclod-probe', version: '1.0' } }
})

const rpcDone = (id) => (text, res) => {
  const type = res.headers.get('content-type') ?? ''
  return jsonRpcMessages(text, type).some((m) => m.id === id && ('result' in m || 'error' in m))
}

function rpcMessage(out, id) {
  const type = out.headers?.get('content-type') ?? ''
  return jsonRpcMessages(out.text ?? '', type).find((m) => m.id === id && ('result' in m || 'error' in m))
}

/** Cabecalhos de um POST MCP. `Mcp-Method` e exigido pelo transporte da spec 2026-07-28 e inofensivo nas anteriores. */
const mcpPostHeaders = (method, extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': method, ...extra })

/** `meta` (so no protocolo sem estado 2026-07-28) vai em params._meta; no protocolo com sessao fica indefinido. */
async function listTools(http, url, headers, meta) {
  const names = []
  let cursor
  for (let page = 0; page < 5; page++) {
    const id = 10 + page
    const params = { ...(cursor ? { cursor } : {}), ...(meta ? { _meta: meta } : {}) }
    const out = await http.requestWithRetry(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params }),
      until: rpcDone(id)
    })
    if (out.error) return { ok: false, error: out.error.kind }
    if (out.status === 401 || out.status === 403) {
      return { ok: false, status: out.status, wwwAuthenticate: out.headers.get('www-authenticate') ?? undefined, authBody: out.text.slice(0, 300), waf: detectWaf(out.status, out.headers, out.text) }
    }
    const msg = rpcMessage(out, id)
    if (!msg || msg.error || !Array.isArray(msg.result?.tools)) {
      return { ok: false, status: out.status, error: msg?.error?.message ? String(msg.error.message).slice(0, 80) : `HTTP ${out.status} sem lista` }
    }
    for (const tool of msg.result.tools) if (tool?.name) names.push(String(tool.name))
    cursor = msg.result.nextCursor
    if (!cursor) break
  }
  return { ok: true, count: names.length, names: names.slice(0, 8) }
}

/**
 * MCP 2026-07-28 (sem estado): nao ha `initialize`; `server/discover` anuncia versoes/capacidades e cada requisicao leva
 * a versao em `_meta`. Usado quando o `initialize` 2025-06-18 e recusado com a lista de versoes suportadas.
 */
async function statelessProbe(http, url, version) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'openclod-probe', version: '1.0' }
  }
  const headers = mcpPostHeaders('server/discover', { 'mcp-protocol-version': version })
  const out = await http.requestWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }),
    until: rpcDone(1)
  })
  if (out.error) return { ok: false }
  if (out.status === 401 || out.status === 403) {
    return { ok: false, status: out.status, wwwAuthenticate: out.headers.get('www-authenticate') ?? undefined, authBody: out.text.slice(0, 300), waf: detectWaf(out.status, out.headers, out.text) }
  }
  const msg = rpcMessage(out, 1)
  if (!msg?.result || typeof msg.result !== 'object') return { ok: false, status: out.status }
  const tools = await listTools(http, url, { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': version }, meta)
  return { ok: true, tools }
}

/** `options.prmOnly`: servidor aberto; so interessa saber se ele publica protected-resource metadata (e o AS dele). */
async function discoverOAuth(http, mcpUrl, wwwAuthenticate, ev, options = {}) {
  const advertised = resourceMetadataFromHeader(wwwAuthenticate)
  const candidates = advertised ? [advertised] : []
  for (const c of protectedResourceMetadataCandidates(mcpUrl)) if (!candidates.includes(c)) candidates.push(c)

  let prm
  for (const candidate of candidates) {
    const got = await http.getJson(candidate)
    const json = got.json
    if (json && (Array.isArray(json.authorization_servers) || typeof json.resource === 'string')) {
      prm = {
        found: true,
        advertised: !!advertised,
        via: candidate === advertised ? 'header' : 'well-known',
        url: candidate,
        authorizationServers: Array.isArray(json.authorization_servers) ? json.authorization_servers.filter((s) => typeof s === 'string').slice(0, 5) : [],
        scopesSupported: Array.isArray(json.scopes_supported) ? json.scopes_supported.filter((s) => typeof s === 'string') : undefined
      }
      break
    }
  }
  ev.prm = prm ?? { found: false, advertised: !!advertised, url: advertised }
  if (options.prmOnly && !prm) return

  // Sem protected-resource metadata, a descoberta legada procura o AS na origem do proprio servidor MCP.
  const issuers = prm?.authorizationServers?.length ? prm.authorizationServers.slice(0, 3) : [new URL(mcpUrl).origin]
  for (const issuer of issuers) {
    let candidatesAs
    try {
      candidatesAs = authServerMetadataCandidates(issuer)
    } catch {
      continue
    }
    for (const candidate of candidatesAs) {
      const got = await http.getJson(candidate)
      const json = got.json
      if (json && (typeof json.issuer === 'string' || typeof json.authorization_endpoint === 'string' || typeof json.token_endpoint === 'string')) {
        ev.as = {
          found: true,
          issuer: typeof json.issuer === 'string' ? json.issuer : issuer,
          via: candidate,
          registrationEndpoint: typeof json.registration_endpoint === 'string' ? json.registration_endpoint : undefined,
          codeChallengeMethods: Array.isArray(json.code_challenge_methods_supported) ? json.code_challenge_methods_supported.map(String) : [],
          scopesSupported: Array.isArray(json.scopes_supported) ? json.scopes_supported.filter((s) => typeof s === 'string') : undefined,
          grantTypes: Array.isArray(json.grant_types_supported) ? json.grant_types_supported.map(String) : undefined,
          // MCP 2026-07-28 troca o registro dinamico (deprecado) por Client ID Metadata Documents
          cimd: json.client_id_metadata_document_supported === true
        }
        return
      }
    }
  }
  ev.as = { found: false }
}

/** Transporte SSE legado: GET abre o stream, `event: endpoint` diz onde postar, a resposta volta pelo stream. */
async function probeLegacySse(http, url) {
  const stream = await http.openStream(url, 20_000)
  if (stream.error) return { error: stream.error }
  const { res } = stream
  try {
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '')
      return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') ?? undefined, authBody: text.slice(0, 300), waf: detectWaf(res.status, res.headers, text) }
    }
    if (res.status !== 200 || !/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) return { status: res.status, endpointEvent: false }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const queue = []
    const waitFor = async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        while (queue.length) {
          const ev = queue.shift()
          if (predicate(ev)) return ev
        }
        const left = deadline - Date.now()
        if (left <= 0) return undefined
        const chunk = await Promise.race([reader.read(), sleep(left).then(() => ({ timeout: true }))]).catch(() => ({ done: true }))
        if (chunk.timeout || chunk.done) return undefined
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n|\r/g, '\n')
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) queue.push(...parseSseEvents(`${part}\n\n`))
      }
    }

    const endpointEvent = await waitFor((ev) => ev.event === 'endpoint', 8000)
    if (!endpointEvent) return { status: 200, endpointEvent: false }
    let endpoint
    try {
      endpoint = new URL(endpointEvent.data.trim(), res.url || url)
    } catch {
      return { status: 200, endpointEvent: true }
    }
    if (endpoint.origin !== new URL(url).origin) return { status: 200, endpointEvent: true, foreignEndpoint: endpoint.origin }

    const postHeaders = { 'content-type': 'application/json' }
    const init = await http.requestWithRetry(endpoint.href, { method: 'POST', headers: postHeaders, body: INIT_BODY, maxBytes: 4096 })
    if (init.error) return { status: 200, endpointEvent: true }
    if (init.status === 401 || init.status === 403) {
      return { status: init.status, endpointEvent: true, wwwAuthenticate: init.headers.get('www-authenticate') ?? undefined, authBody: init.text.slice(0, 300), waf: detectWaf(init.status, init.headers, init.text) }
    }
    const initMsg = await waitFor((ev) => {
      try {
        return JSON.parse(ev.data)?.id === 1
      } catch {
        return false
      }
    }, 8000)
    let parsed
    try {
      parsed = initMsg ? JSON.parse(initMsg.data) : undefined
    } catch {
      parsed = undefined
    }
    if (!isInitializeResult(parsed)) return { status: 200, endpointEvent: true, initializeOk: false, rpcError: parsed?.error?.message ? String(parsed.error.message) : undefined }

    await http.requestWithRetry(endpoint.href, { method: 'POST', headers: postHeaders, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), maxBytes: 1024 })
    await http.requestWithRetry(endpoint.href, { method: 'POST', headers: postHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), maxBytes: 1024 })
    const toolsEvent = await waitFor((ev) => {
      try {
        return JSON.parse(ev.data)?.id === 2
      } catch {
        return false
      }
    }, 8000)
    let tools = { ok: false, error: 'sem resposta pelo stream' }
    if (toolsEvent) {
      try {
        const msg = JSON.parse(toolsEvent.data)
        if (Array.isArray(msg.result?.tools)) tools = { ok: true, count: msg.result.tools.length, names: msg.result.tools.slice(0, 8).map((t) => String(t?.name ?? '')).filter(Boolean) }
        else tools = { ok: false, error: msg.error?.message ? String(msg.error.message).slice(0, 80) : 'resposta sem tools' }
      } catch {
        tools = { ok: false, error: 'resposta ilegível' }
      }
    }
    return { status: 200, endpointEvent: true, initializeOk: true, tools }
  } finally {
    stream.close()
  }
}

const SSE_FALLBACK_STATUSES = new Set([400, 404, 405, 406, 410, 415])
const TRANSIENT = new Set(['timeout', 'reset', 'other'])

/**
 * Sonda UMA URL e devolve as evidencias (entrada de `classifyProbe`). Nao grava nada e nao usa credenciais.
 * `options.http` permite injetar o cliente (testes); `options.allowPrivate` libera 127.0.0.1 para servidores de teste.
 */
export async function probeUrl(url, options = {}) {
  const http = options.http ?? createHttp(options)
  const started = Date.now()
  const ev = {}
  const startHost = (() => {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  })()

  let post = await http.requestWithRetry(url, { method: 'POST', headers: mcpPostHeaders('initialize'), body: INIT_BODY, until: rpcDone(1) })
  if (post.error && TRANSIENT.has(post.error.kind)) {
    await sleep(options.retryDelayMs ?? 1500)
    post = await http.requestWithRetry(url, { method: 'POST', headers: mcpPostHeaders('initialize'), body: INIT_BODY, until: rpcDone(1) })
  }
  if (post.error) {
    ev.error = post.error
    ev.durationMs = Date.now() - started
    return finalize(ev, http)
  }

  ev.status = post.status
  if (post.rateLimited) ev.rateLimited = true
  try {
    const finalHost = new URL(post.url).host
    if (post.hops?.length && finalHost !== startHost) ev.redirectedTo = finalHost
  } catch {
    /* ignora */
  }

  const initMsg = rpcMessage(post, 1)
  let sessionId
  let protocolVersion = PROBE_PROTOCOL_VERSION
  if (isInitializeResult(initMsg)) {
    ev.initialize = { ok: true }
    ev.transport = 'http'
    sessionId = post.headers.get('mcp-session-id') ?? undefined
    if (typeof initMsg.result.protocolVersion === 'string') protocolVersion = initMsg.result.protocolVersion
  } else if (initMsg?.error) {
    ev.initialize = { ok: false, rpcError: String(initMsg.error.message ?? initMsg.error.code ?? 'erro').slice(0, 200) }
  }
  if (post.status === 401 || post.status === 403) {
    ev.wwwAuthenticate = post.headers.get('www-authenticate') ?? undefined
    ev.authBody = post.text.slice(0, 300)
    ev.waf = detectWaf(post.status, post.headers, post.text)
  } else if (post.status >= 500 || post.status === 429 || post.status === 406) {
    ev.waf = detectWaf(post.status, post.headers, post.text)
    ev.authBody = post.text.slice(0, 200)
  } else if (!ev.initialize?.ok) {
    ev.authBody = post.text.slice(0, 300)
  }
  if (post.redirectBlocked) ev.redirectBlocked = post.redirectBlocked

  // O servidor so fala a spec 2026-07-28 (sem initialize): o erro traz as versoes suportadas -> tenta `server/discover`.
  const supported = initMsg?.error?.data?.supported
  if (!ev.initialize?.ok && Array.isArray(supported) && supported.length && (initMsg.error.code === -32022 || /unsupported protocol version/i.test(String(initMsg.error.message ?? '')))) {
    ev.versionMismatch = supported.map(String).sort()
    const version = ev.versionMismatch[ev.versionMismatch.length - 1]
    const stateless = await statelessProbe(http, url, version)
    if (stateless.ok) {
      ev.initialize = { ok: true }
      ev.transport = 'http'
      ev.stateless = version
      ev.tools = stateless.tools
      if (stateless.tools?.status === 401 || stateless.tools?.status === 403) {
        ev.wwwAuthenticate = stateless.tools.wwwAuthenticate
        ev.authBody = stateless.tools.authBody
        ev.waf = stateless.tools.waf
      }
    } else if (stateless.status === 401 || stateless.status === 403) {
      ev.status = stateless.status
      ev.wwwAuthenticate = stateless.wwwAuthenticate
      ev.authBody = stateless.authBody
      ev.waf = stateless.waf
    }
  }

  if (ev.initialize?.ok && !ev.stateless) {
    const followHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion }
    if (sessionId) followHeaders['mcp-session-id'] = sessionId
    await http.requestWithRetry(url, { method: 'POST', headers: { ...followHeaders, 'mcp-method': 'notifications/initialized' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), maxBytes: 1024 })
    const tools = await listTools(http, url, followHeaders)
    ev.tools = tools
    if (tools.status === 401 || tools.status === 403) {
      ev.wwwAuthenticate = tools.wwwAuthenticate
      ev.authBody = tools.authBody
      ev.waf = tools.waf
    }
    if (sessionId) await http.request(url, { method: 'DELETE', headers: followHeaders, maxBytes: 1024 }).catch(() => {})
  } else if (!ev.initialize?.rpcError && SSE_FALLBACK_STATUSES.has(post.status)) {
    const legacy = await probeLegacySse(http, url)
    if (legacy.error) {
      /* o POST ja respondeu; o GET SSE falhou: segue com a evidencia do POST */
    } else if (legacy.status === 401 || legacy.status === 403) {
      ev.status = legacy.status
      ev.wwwAuthenticate = legacy.wwwAuthenticate
      ev.authBody = legacy.authBody
      ev.waf = legacy.waf
      ev.sse = { endpointEvent: !!legacy.endpointEvent, status: legacy.status }
    } else if (legacy.endpointEvent) {
      ev.sse = { endpointEvent: true, status: legacy.status }
      if (legacy.foreignEndpoint) ev.authBody = `endpoint SSE em outra origem (${legacy.foreignEndpoint}); não seguido`
      if (legacy.initializeOk) {
        ev.initialize = { ok: true }
        ev.transport = 'sse'
        ev.status = 200
        ev.tools = legacy.tools
      }
    }
  }

  const toolsNeedAuth = ev.tools?.status === 401 || ev.tools?.status === 403
  if (ev.initialize?.ok && !toolsNeedAuth) {
    // Aberto para handshake/listagem: ainda assim ve se publica metadata OAuth (chamadas de ferramenta protegidas).
    try {
      await discoverOAuth(http, url, undefined, ev, { prmOnly: true })
    } catch (err) {
      ev.discoveryError = String(err?.message ?? err).slice(0, 120)
    }
  } else if ((ev.status === 401 || ev.status === 403 || toolsNeedAuth) && !ev.waf) {
    try {
      await discoverOAuth(http, url, ev.wwwAuthenticate, ev)
    } catch (err) {
      ev.discoveryError = String(err?.message ?? err).slice(0, 120)
    }
  }
  ev.durationMs = Date.now() - started
  return finalize(ev, http)
}

function finalize(ev, http) {
  return { evidence: ev, requests: http.stats?.requests }
}

// ---------------------------------------------------------------------------------------------
// CLI

/** Escopos anunciados podem ser centenas (Google, Microsoft): guarda os 25 primeiros e o total. */
export function trimScopes(list, max = 25) {
  if (!Array.isArray(list) || !list.length) return {}
  return list.length > max ? { scopesSupported: list.slice(0, max), scopesTotal: list.length } : { scopesSupported: list, scopesTotal: list.length }
}

function compactEvidence(entry, ev, result) {
  const out = {
    url: entry.url,
    level: result.level,
    auth: result.auth,
    status: ev.status,
    durationMs: ev.durationMs,
    ...(ev.error ? { error: ev.error } : {}),
    ...(ev.redirectedTo ? { redirectedTo: ev.redirectedTo } : {}),
    ...(ev.redirectBlocked ? { redirectBlocked: ev.redirectBlocked } : {}),
    ...(ev.stateless ? { stateless: ev.stateless } : {}),
    ...(ev.versionMismatch ? { versionMismatch: ev.versionMismatch } : {}),
    ...(ev.rateLimited ? { rateLimited: true } : {}),
    ...(ev.waf ? { waf: true } : {}),
    ...(ev.wwwAuthenticate ? { wwwAuthenticate: ev.wwwAuthenticate.slice(0, 300) } : {}),
    ...(ev.authBody && !ev.initialize?.ok ? { body: ev.authBody.replace(/\s+/g, ' ').slice(0, 160) } : {}),
    ...(ev.initialize ? { initialize: ev.initialize } : {}),
    ...(ev.transport ? { transport: ev.transport } : {}),
    ...(ev.tools ? { tools: { ok: ev.tools.ok, count: ev.tools.count, status: ev.tools.status, error: ev.tools.error } } : {}),
    ...(ev.prm ? { prm: { found: ev.prm.found, advertised: ev.prm.advertised, via: ev.prm.via, url: ev.prm.url, authorizationServers: ev.prm.authorizationServers, ...trimScopes(ev.prm.scopesSupported) } } : {}),
    ...(ev.as ? { as: { ...ev.as, ...trimScopes(ev.as.scopesSupported) } } : {}),
    ...(ev.sse ? { sse: ev.sse } : {}),
    ...(ev.discoveryError ? { discoveryError: ev.discoveryError } : {})
  }
  return out
}

function parseArgs(argv) {
  const args = { concurrency: 8, timeoutMs: 12_000, write: true, only: undefined, limit: undefined, skipProbedHours: 0, allowPrivate: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') args.only = new Set(String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean))
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--concurrency') args.concurrency = Number(argv[++i])
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i])
    else if (a === '--skip-probed-hours') args.skipProbedHours = Number(argv[++i])
    else if (a === '--no-write') args.write = false
    else if (a === '--allow-private') args.allowPrivate = true
    else throw new Error(`argumento desconhecido: ${a}`)
  }
  return args
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n')
  fs.renameSync(tmp, file)
}

/** Evidencias: um resultado por linha (compacto e facil de comparar no git). */
export function writeEvidenceFile(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const { results, ...head } = doc
  const ids = Object.keys(results).sort()
  const body = ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(results[id])}`).join(',\n')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(head).slice(0, -1)},"results":{\n${body}\n}}\n`)
  fs.renameSync(tmp, file)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const directory = JSON.parse(fs.readFileSync(DIRECTORY, 'utf8'))
  const byId = new Map(directory.entries.map((e, i) => [e.id, i]))
  let targets = directory.entries.filter((e) => e.kind === 'remote' && e.url)
  if (args.only) targets = targets.filter((e) => args.only.has(e.id))
  if (args.skipProbedHours > 0) {
    const cutoff = Date.now() - args.skipProbedHours * 3_600_000
    targets = targets.filter((e) => !(e.probe && e.probe.checkedAt > cutoff))
  }
  if (args.limit) targets = targets.slice(0, args.limit)
  console.log(`sondando ${targets.length} endpoints remotos (concorrência ${args.concurrency}, timeout ${args.timeoutMs} ms)`)

  const evidenceFile = fs.existsSync(EVIDENCE) ? JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) : { results: {} }
  const evidence = { generatedAt: Date.now(), userAgent: PROBE_USER_AGENT, protocolVersion: PROBE_PROTOCOL_VERSION, results: { ...(evidenceFile.results ?? {}) } }
  const http = createHttp({ timeoutMs: args.timeoutMs, allowPrivate: args.allowPrivate })

  let done = 0
  let next = 0
  const checkpoint = () => {
    if (!args.write) return
    writeJsonAtomic(DIRECTORY, directory)
    evidence.generatedAt = Date.now()
    writeEvidenceFile(EVIDENCE, evidence)
  }
  async function worker() {
    for (;;) {
      const index = next++
      if (index >= targets.length) return
      const entry = directory.entries[byId.get(targets[index].id)]
      let ev
      try {
        ;({ evidence: ev } = await probeUrl(entry.url, { http, timeoutMs: args.timeoutMs }))
      } catch (err) {
        ev = { error: { kind: 'other', message: String(err?.message ?? err) }, status: undefined }
      }
      const result = classifyProbe(ev)
      directory.entries[byId.get(entry.id)] = applyProbe(entry, result, ev)
      evidence.results[entry.id] = compactEvidence(entry, ev, result)
      done++
      console.log(`[${done}/${targets.length}] N${result.level} ${result.auth.padEnd(12)} ${entry.id}  ${result.probe.note ?? ''}`.slice(0, 220))
      if (done % 25 === 0) checkpoint()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))
  checkpoint()

  const levels = {}
  const auths = {}
  for (const e of directory.entries) {
    if (e.kind !== 'remote' || !e.url || !e.probe) continue
    const level = probeLevel(e.probe)
    levels[`N${level}`] = (levels[`N${level}`] ?? 0) + 1
    auths[e.auth] = (auths[e.auth] ?? 0) + 1
  }
  console.log('níveis', levels, 'auth', auths, `requisições: ${http.stats.requests}`)
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
