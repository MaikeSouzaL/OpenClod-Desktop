/**
 * Logica PURA do teste de conectores (sem rede e sem disco): fetch educado, leitura dos erros do cliente MCP, escolha
 * da ferramenta inofensiva, classificacao do resultado e montagem do relatorio. Quem faz as chamadas e
 * scripts/mcp-connectors-test.ts; aqui fica o que pode ser testado com fixtures (tests/mcp-connectors-test.test.ts).
 *
 * Niveis (por conector remoto com URL):
 *  N0 inalcancavel · N1 alcancavel · N2 chega ao login · N3 login pronto (o dryRun montou a URL de autorizacao com PKCE)
 *  · N4 conectou sem login com o NOSSO McpClient e listou as ferramentas · N5 conectado com a conta do usuario
 *  (impossivel sem o usuario: nunca medido aqui).
 */

export const TEST_USER_AGENT = 'Openclod-Desktop-ConnectorTest/1.0'

export type Level = 0 | 1 | 2 | 3 | 4

export type Outcome =
  | 'open-connected'
  | 'login-ready'
  | 'needs-own-client'
  | 'needs-api-key'
  | 'needs-endpoint'
  | 'local-connected'
  | 'local-needs-credentials'
  | 'local-needs-runtime'
  | 'local-app-offline'
  | 'local-failed'
  | 'blocked'
  | 'unreachable'
  | 'failed'

export const OUTCOME_LABEL: Record<Outcome, string> = {
  'open-connected': 'Conectou sem login (aberto)',
  'login-ready': 'Pronto para o login de 1 clique',
  'needs-own-client': 'Precisa de client id próprio',
  'needs-api-key': 'Precisa de chave de API',
  'needs-endpoint': 'Precisa da URL do usuário (sem endpoint público)',
  'local-connected': 'Local: subiu e listou ferramentas',
  'local-needs-credentials': 'Local: exige credenciais (recusa sem elas)',
  'local-needs-runtime': 'Local: falta o programa no PC',
  'local-app-offline': 'Local: depende de um aplicativo aberto',
  'local-failed': 'Local: falhou',
  blocked: 'Bloqueado pelo serviço',
  unreachable: 'Inalcançável',
  failed: 'Falhou (a investigar)'
}

export interface TestStep {
  step: string
  ok: boolean
  ms: number
  detail: string
}

export interface ToolCallEvidence {
  tool: string
  ok: boolean
  ms: number
  chars: number
  isError: boolean
  note: string
}

export interface ConnectorTestRecord {
  id: string
  name: string
  group: 'remote' | 'local' | 'no-endpoint'
  source: string
  category: string
  transport: string
  auth: string
  url?: string
  command?: string
  /** Nivel mais alto alcancado (so conectores remotos com URL; null nos locais e sem endpoint). */
  level: Level | null
  outcome: Outcome
  /** Causa agrupavel (curta) do resultado quando nao e sucesso. */
  cause?: string
  /** O NOSSO cliente conectou sem login e listou as ferramentas (N4). */
  connected: boolean
  /** O ensaio OAuth montou a URL de autorizacao (N3). */
  loginReady: boolean
  /** O servidor de autorizacao descoberto nao oferece registro dinamico: o login exige um client id cadastrado pelo usuario. */
  needsOwnClient?: boolean
  steps: TestStep[]
  ms: number
  httpStatus?: number
  error?: string
  hint?: string
  challenge?: string
  protocolVersion?: string
  serverInfo?: string
  transportUsed?: string
  toolCount?: number
  tools?: string[]
  toolCall?: ToolCallEvidence
  redirectUri?: string
  authHost?: string
  /** Escopos anunciados pelo servidor (ensaio OAuth). */
  scope?: string
  note?: string
  testedAt: string
  /** Estado de uma rodada anterior, preservado quando uma correcao nossa fez o conector ser testado de novo. */
  previous?: { level: Level | null; outcome: Outcome; error?: string; cause?: string; testedAt: string }
  fixNote?: string
}

/* -------------------------------------------------------------------------- */
/* URLs que o teste nao toca                                                  */
/* -------------------------------------------------------------------------- */

/** Motivo para NAO testar uma URL remota (so https, sem credenciais embutidas, sem IP literal nem host local); null = pode. */
export function blockedReason(rawUrl: string | undefined): string | null {
  if (!rawUrl) return 'sem URL'
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'URL inválida'
  }
  if (url.protocol !== 'https:') return 'só https'
  if (url.username || url.password) return 'URL com credenciais'
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || /\.(local|localhost|internal|lan|home\.arpa|corp)$/.test(host)) return 'host local'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return 'IP literal'
  if (!host.includes('.')) return 'host sem domínio'
  return null
}

/* -------------------------------------------------------------------------- */
/* fetch educado                                                              */
/* -------------------------------------------------------------------------- */

export interface ThrottleStats {
  requests: number
  retries429: number
  waitedMs: number
  byHost: Record<string, number>
}

export interface ThrottleOptions {
  userAgent?: string
  /** Intervalo minimo entre duas requisicoes ao MESMO host (padrao 1000 ms = no maximo 1 por segundo). */
  minGapMs?: number
  /** Teto da espera pedida por `Retry-After` (padrao 20 s). */
  maxRetryAfterMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** `Retry-After` (segundos ou data HTTP) em ms, limitado a `max`; undefined quando ausente ou ilegivel. */
export function retryAfterMs(value: string | null | undefined, max: number, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(max, Math.round(seconds * 1000)))
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, Math.min(max, at - now)) : undefined
}

/**
 * Embrulha um `fetch`: User-Agent claro, no maximo 1 requisicao por segundo por host (fila por host, entre todos os
 * chamadores) e UM novo envio depois de um 429, esperando `Retry-After`. Os corpos do McpClient e do OAuth sao texto, entao
 * reenviar e seguro.
 */
export function createThrottledFetch(base: typeof fetch, options: ThrottleOptions = {}): { fetch: typeof fetch; stats: ThrottleStats } {
  const userAgent = options.userAgent ?? TEST_USER_AGENT
  const gap = options.minGapMs ?? 1000
  const maxRetryAfter = options.maxRetryAfterMs ?? 20_000
  const clock = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const nextAt = new Map<string, number>()
  const stats: ThrottleStats = { requests: 0, retries429: 0, waitedMs: 0, byHost: {} }

  async function slot(host: string): Promise<void> {
    const now = clock()
    const at = Math.max(now, nextAt.get(host) ?? 0)
    nextAt.set(host, at + gap)
    if (at > now) {
      stats.waitedMs += at - now
      await sleep(at - now)
    }
  }

  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = new URL(target).host
    const headers = new Headers(init?.headers)
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent)
    for (let attempt = 0; ; attempt++) {
      await slot(host)
      stats.requests++
      stats.byHost[host] = (stats.byHost[host] ?? 0) + 1
      const response = await base(input, { ...init, headers })
      if (response.status !== 429 || attempt >= 1) return response
      const wait = retryAfterMs(response.headers.get('retry-after'), maxRetryAfter, clock()) ?? 5_000
      await response.body?.cancel().catch(() => undefined)
      stats.retries429++
      nextAt.set(host, Math.max(nextAt.get(host) ?? 0, clock() + wait))
    }
  }) as typeof fetch
  return { fetch: wrapped, stats }
}

/* -------------------------------------------------------------------------- */
/* leitura dos erros do cliente                                               */
/* -------------------------------------------------------------------------- */

export type NetworkKind = 'dns' | 'tls' | 'refused' | 'timeout' | 'reset' | 'other'

export interface ParsedClientError {
  httpStatus?: number
  /** Valor do WWW-Authenticate que o cliente anexou a mensagem (`[desafio: ...]`). */
  challenge?: string
  /** Falha de rede (sem resposta HTTP). */
  network?: NetworkKind
  waf: boolean
  unauthorized: boolean
  /** Os dois transportes foram tentados e nenhum falou MCP. */
  noTransport: boolean
  protocol: boolean
  toolsList: boolean
}

const WAF = /<!doctype|<html|<head|cloudflare|just a moment|attention required|cf-chl|captcha|access denied|akamai|incapsula|datadome|request blocked|you have been blocked|perimeterx/i

/** O que a mensagem de erro do McpClient diz: status HTTP, desafio de autenticacao, tipo de falha de rede. */
export function parseClientError(error: string | undefined | null): ParsedClientError {
  const text = String(error ?? '')
  const status = /\bHTTP (\d{3})\b/.exec(text)?.[1]
  const challenge = /\[desafio: ([^\]]*)\]/.exec(text)?.[1]?.trim()
  const out: ParsedClientError = {
    ...(status ? { httpStatus: Number(status) } : {}),
    ...(challenge ? { challenge } : {}),
    waf: false,
    unauthorized: /\bHTTP (401|403)\b|unauthori[sz]ed|forbidden/i.test(text),
    noTransport: /nenhum transporte mcp funcionou/i.test(text),
    protocol: /vers[aã]o de protocolo mcp n[aã]o suportada/i.test(text),
    toolsList: /tools\/list/i.test(text)
  }
  if (out.httpStatus) {
    out.waf = [403, 406, 429, 503].includes(out.httpStatus) && WAF.test(text) && !/bearer/i.test(out.challenge ?? '')
    // A 200 that is an HTML page (a CDN redirected the POST to an error page): the client says so in the message.
    if (/devolveu uma p[aá]gina html/i.test(text)) out.waf = true
  } else if (/falha de rede|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|EPIPE|UND_ERR|timeout de mcp|tempo de partida|esgotado|certificate|CERT_|SSL|TLS/i.test(text)) {
    if (/ENOTFOUND|EAI_AGAIN|EAI_NODATA|getaddrinfo/i.test(text)) out.network = 'dns'
    else if (/CERT|TLS|SSL|self[- ]signed|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|WRONG_VERSION/i.test(text)) out.network = 'tls'
    else if (/ECONNREFUSED/i.test(text)) out.network = 'refused'
    else if (/timeout|esgotado|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(text)) out.network = 'timeout'
    else if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|terminated/i.test(text)) out.network = 'reset'
    else out.network = 'other'
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* ferramenta inofensiva                                                      */
/* -------------------------------------------------------------------------- */

export interface SafeToolCandidate {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** Nomes que apontam para dados da pessoa, da conta ou da organizacao: nunca chamados pelo teste. */
const PERSONAL =
  /(^|[_\-.\s])(me|my|mine|self|whoami|user|users|profile|profiles|account|accounts|customer|customers|contact|contacts|email|emails|inbox|message|messages|chat|chats|order|orders|cart|wallet|balance|payment|payments|card|cards|booking|bookings|reservation|reservations|history|session|sessions|token|tokens|secret|secrets|key|keys|credential|credentials|team|teams|member|members|org|orgs|organization|organizations|workspace|workspaces|subscription|subscriptions|invoice|invoices|private|personal|billing|favorite|favorites|saved|notification|notifications|address|addresses|ticket|tickets|trip|trips|portfolio|portfolios|watchlist|watchlists|project|projects|repo|repos|file|files|document|documents)($|[_\-.\s])/i

/**
 * Nomes que soam a acao (iniciar contato, reservar, enviar, assinar...), mesmo anotados `readOnlyHint: true` por um servidor
 * descuidado: uma chamada de prova nunca deve poder gerar um lead, uma reserva ou uma mensagem (TaxAct `connect_with_expert`).
 */
const ACTION_LIKE =
  /(^|[_\-.\s])(connect|book|reserve|schedule|request|submit|send|notify|invite|subscribe|signup|sign|register|apply|expert|advisor|lead|leads|call|callback|quote|checkout|buy|purchase|pay|transfer|create|update|delete|remove|write|post|publish|upload|run|execute|start|stop|launch|trigger|install|login|logout|auth|authenticate)($|[_\-.\s])/i

const PERSONAL_DESCRIPTION =/\b(your|current user|authenticated user|logged[- ]in|personal|private|my own)\b/i

const PREFERRED = /(^|[_\-.\s])(ping|health|healthcheck|status|about|version|help|info|capabilities|schema|catalog|categories|category|types|sources|datasets|models|supported|metadata|list|time|now|date|current_time)($|[_\-.\s])/i

function words(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
}

/**
 * A unica ferramenta que o teste chama num conector aberto: anotada `readOnlyHint: true`, sem argumentos obrigatorios e
 * sem cara de dado pessoal; prefere as de informacao geral (status, versao, listas, categorias). null = nenhuma serve.
 */
export function pickSafeTool(tools: readonly SafeToolCandidate[]): SafeToolCandidate | null {
  let best: { tool: SafeToolCandidate; score: number } | null = null
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true) continue
    const required = (tool.inputSchema as { required?: unknown } | undefined)?.required
    if (Array.isArray(required) && required.length > 0) continue
    const spelled = words(tool.name)
    if (PERSONAL.test(spelled) || ACTION_LIKE.test(spelled) || PERSONAL_DESCRIPTION.test(tool.description ?? '')) continue
    const score = (PREFERRED.test(spelled) ? 10 : 0) - Math.min(5, Math.floor((tool.description ?? '').length / 400))
    if (!best || score > best.score) best = { tool, score }
  }
  return best?.tool ?? null
}

/* -------------------------------------------------------------------------- */
/* classificacao                                                              */
/* -------------------------------------------------------------------------- */

export interface DryRunFacts {
  ok: boolean
  error?: string
  hint?: string
  steps: Array<{ step: string; ok: boolean; ms: number; detail: string }>
  redirectUri?: string
  client?: string
  scope?: string
}

export interface RemoteFacts {
  auth: string
  /** O cliente MCP terminou o start (initialize + tools/list). */
  ready: boolean
  clientError?: string
  dry?: DryRunFacts | null
}

export interface RemoteVerdict {
  level: Level
  outcome: Outcome
  cause?: string
  connected: boolean
  loginReady: boolean
  needsOwnClient: boolean
  parsed: ParsedClientError
  authHost?: string
}

const NO_DCR = /n[aã]o aceita registro din[aâ]mico/i

/**
 * Why a server that ADVERTISES dynamic registration still refused ours, from the detail the app now keeps
 * (`registro OAuth <status> (<code>): <o que o servidor disse>`). null = the answer says nothing we can act on, which stays
 * "a investigar" instead of being filed as the service's fault. Order matters: the most specific reason first.
 */
export function classifyRegistrationRefusal(error: string | undefined): string | null {
  const text = String(error ?? '')
  if (!/registro oauth/i.test(text)) return null
  if (/p[aá]gina html|just a moment|cloudflare/i.test(text)) return 'o WAF/CDN bloqueou o registro (página HTML)'
  if (/clientip|IP band|ip not allowed|ERR-PLAYAUTH|허용되지/i.test(text)) return 'o registro é restrito por IP/região'
  if (/invalid session|E0000005|initial access token|requires authentication|authentication required/i.test(text)) return 'o registro exige sessão ou token inicial (não é aberto)'
  if (/trusted hosts|host not trusted|approved|allowlist|allow-list|not on our list|unknown application|vendor with name|not found in approved/i.test(text)) {
    return 'só aceita clientes aprovados (lista de permitidos)'
  }
  if (/disabled|not enabled|desativad/i.test(text)) return 'registro dinâmico desativado pelo serviço'
  if (/limit of entities|too many clients|quota|limit reached/i.test(text)) return 'limite de clientes registrados no serviço'
  if (/redirect|allowed (?:host|domain)|https\/ssl|must be https/i.test(text)) return 'só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost)'
  if (/registro oauth (?:404|5\d\d)\b/i.test(text)) return 'o endpoint de registro anunciado responde 404/5xx'
  if (/registro oauth 403\b/i.test(text)) return 'o servidor recusa o registro (403) sem dar o motivo'
  return null
}

/** Host do servidor de autorizacao lido do detalhe do passo `discovery` do ensaio. */
export function authHostOf(dry: DryRunFacts | null | undefined): string | undefined {
  const detail = dry?.steps.find((step) => step.step === 'discovery' && step.ok)?.detail ?? ''
  return /servidor de autoriza[cç][aã]o em ([^;\s]+)/.exec(detail)?.[1]
}

export function dryDiscoveryOk(dry: DryRunFacts | null | undefined): boolean {
  return Boolean(dry?.steps.some((step) => step.step === 'discovery' && step.ok))
}

/** Resultado de um conector remoto a partir do que o cliente MCP e o ensaio OAuth viram. Pura: so le os fatos. */
export function classifyRemote(facts: RemoteFacts): RemoteVerdict {
  const parsed = parseClientError(facts.clientError)
  const dry = facts.dry ?? null
  const discovery = dryDiscoveryOk(dry)
  const loginReady = Boolean(dry?.ok)
  const connected = facts.ready
  const needsOwnClient = Boolean(dry && discovery && !dry.ok && NO_DCR.test(dry.error ?? '') && !/\(registro oauth/i.test(dry.error ?? ''))
  const bearerChallenge = /bearer|resource_metadata/i.test(parsed.challenge ?? '')

  let level: Level = 0
  if (connected || parsed.httpStatus !== undefined || discovery) level = 1
  if (connected || bearerChallenge || discovery) level = 2
  if (loginReady) level = 3
  if (connected) level = 4
  if (connected) {
    return { level, outcome: 'open-connected', connected, loginReady, needsOwnClient, parsed, authHost: authHostOf(dry) }
  }
  const base = { level, connected, loginReady, needsOwnClient, parsed, authHost: authHostOf(dry) }

  if (facts.auth === 'api-key' && (parsed.unauthorized || parsed.httpStatus === 401 || parsed.httpStatus === 403)) {
    return { ...base, outcome: 'needs-api-key', cause: 'exige chave de API' }
  }
  if (loginReady) return { ...base, outcome: 'login-ready' }
  if (needsOwnClient) {
    return { ...base, outcome: 'needs-own-client', cause: 'servidor de autorização sem registro dinâmico' }
  }
  if (dry && discovery && !dry.ok) {
    const status = /registro oauth (\d{3})/i.exec(dry.error ?? '')?.[1]
    // A reason the server gave is the service's policy (nothing for us to fix); without one it stays "a investigar".
    const policy = classifyRegistrationRefusal(dry.error)
    if (policy) return { ...base, outcome: 'blocked', cause: `registro dinâmico recusado${status ? ` (${status})` : ''}: ${policy}` }
    return { ...base, outcome: 'failed', cause: status ? `registro dinâmico recusado (${status}) sem motivo claro` : 'ensaio OAuth falhou' }
  }
  if (parsed.network) {
    const causes: Record<NetworkKind, string> = {
      dns: 'DNS não resolve',
      tls: 'falha de TLS/certificado',
      refused: 'conexão recusada',
      timeout: 'tempo esgotado',
      reset: 'conexão reiniciada pelo servidor',
      other: 'erro de rede'
    }
    return { ...base, outcome: 'unreachable', cause: causes[parsed.network] }
  }
  if (parsed.httpStatus !== undefined && parsed.httpStatus >= 500) {
    return { ...base, outcome: 'unreachable', cause: `HTTP ${parsed.httpStatus} do servidor` }
  }
  if (parsed.waf) return { ...base, outcome: 'blocked', cause: `provável bloqueio de WAF/CDN (HTTP ${parsed.httpStatus})` }
  if (parsed.protocol) return { ...base, outcome: 'failed', cause: 'versão de protocolo MCP não suportada' }
  if (parsed.noTransport) return { ...base, outcome: 'blocked', cause: 'a URL não fala MCP (nenhum transporte funcionou)' }
  if (parsed.httpStatus === 401 || parsed.httpStatus === 403) {
    return {
      ...base,
      outcome: 'blocked',
      cause: dry && !discovery ? `HTTP ${parsed.httpStatus} sem metadados OAuth descobríveis` : `HTTP ${parsed.httpStatus}: exige credencial`
    }
  }
  if (parsed.httpStatus !== undefined) return { ...base, outcome: 'blocked', cause: `HTTP ${parsed.httpStatus}: a URL não responde como MCP` }
  return { ...base, outcome: 'failed', cause: parsed.toolsList ? 'tools/list falhou' : 'erro não classificado' }
}

/* -------------------------------------------------------------------------- */
/* resumo                                                                     */
/* -------------------------------------------------------------------------- */

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1
  return out
}

export interface TestSummary {
  total: number
  remote: number
  local: number
  noEndpoint: number
  byLevel: Record<string, number>
  byOutcome: Record<string, number>
  byAuth: Record<string, number>
  causes: Record<string, number>
  loginReady: number
  needsOwnClient: number
  connected: number
  toolCalls: { tried: number; ok: number }
}

export function summarize(records: readonly ConnectorTestRecord[]): TestSummary {
  const remote = records.filter((record) => record.group === 'remote')
  const failed = records.filter((record) => record.cause)
  return {
    total: records.length,
    remote: remote.length,
    local: records.filter((record) => record.group === 'local').length,
    noEndpoint: records.filter((record) => record.group === 'no-endpoint').length,
    byLevel: countBy(remote, (record) => `N${record.level ?? '?'}`),
    byOutcome: countBy(records, (record) => record.outcome),
    byAuth: countBy(records, (record) => record.auth),
    causes: countBy(failed, (record) => `${record.outcome}: ${record.cause}`),
    loginReady: records.filter((record) => record.loginReady).length,
    needsOwnClient: records.filter((record) => record.needsOwnClient).length,
    connected: records.filter((record) => record.connected).length,
    toolCalls: {
      tried: records.filter((record) => record.toolCall).length,
      ok: records.filter((record) => record.toolCall?.ok).length
    }
  }
}

/** Mescla uma nova rodada nos registros gravados: o que foi testado de novo troca o antigo e guarda o estado anterior. */
export function mergeRecords(existing: readonly ConnectorTestRecord[], fresh: readonly ConnectorTestRecord[], fixNote?: string): ConnectorTestRecord[] {
  const byId = new Map(existing.map((record) => [record.id, record]))
  for (const record of fresh) {
    const old = byId.get(record.id)
    const next: ConnectorTestRecord = { ...record }
    if (old) {
      next.previous = old.previous ?? { level: old.level, outcome: old.outcome, error: old.error, cause: old.cause, testedAt: old.testedAt }
      if (old.fixNote && !fixNote) next.fixNote = old.fixNote
    }
    if (fixNote) next.fixNote = fixNote
    byId.set(record.id, next)
  }
  return [...byId.values()]
}
