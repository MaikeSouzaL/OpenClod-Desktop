import type { ProviderConfig } from '../../shared/types.js'

/**
 * Model discovery for the provider settings screen: asks a server which models
 * it serves (and, where the API says so, their context window and
 * capabilities). Never throws; failures come back as `error` text in pt-BR.
 */

export type DiscoverySource = 'ollama' | 'lmstudio' | 'openai' | 'anthropic'

export interface DiscoveredModel {
  id: string
  contextWindow?: number
  supportsVision?: boolean
  supportsTools?: boolean
}

export interface DiscoveryConfig {
  kind: DiscoverySource
  /** Same value the provider uses, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string
  apiKey?: string
}

export interface DiscoveryOptions {
  /** Per-request timeout in ms (default 4000). */
  timeoutMs?: number
  /** Injected fetch, for tests. */
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface DiscoveryResult {
  models: DiscoveredModel[]
  source: DiscoverySource
  error?: string
}

const DEFAULT_TIMEOUT_MS = 4000
/** Parallel POST /api/show calls against Ollama. */
const SHOW_CONCURRENCY = 4
const MAX_MODELS = 2000
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_MAX_PAGES = 5

/**
 * Which discovery protocol fits a provider config. Provider presets only say
 * `openai` or `anthropic`; the two local servers are told apart by their
 * default ports (Ollama 11434, LM Studio 1234).
 */
export function inferDiscoveryKind(config: { kind: ProviderConfig['kind'] | DiscoverySource; baseUrl: string }): DiscoverySource {
  if (config.kind === 'ollama' || config.kind === 'lmstudio' || config.kind === 'anthropic') return config.kind
  try {
    const port = new URL(config.baseUrl).port
    if (port === '11434') return 'ollama'
    if (port === '1234') return 'lmstudio'
  } catch {
    /* not a URL: handled by discoverModels */
  }
  return 'openai'
}

/**
 * Convenience for the settings screen: discovery for a saved provider, with
 * the key already resolved by the caller (see `resolveApiKey`).
 */
export function discoverForProvider(
  config: Pick<ProviderConfig, 'kind' | 'baseUrl'>,
  apiKey: string | undefined,
  opts?: DiscoveryOptions
): Promise<DiscoveryResult> {
  return discoverModels({ kind: inferDiscoveryKind(config), baseUrl: config.baseUrl, apiKey }, opts)
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

class DiscoveryError extends Error {
  constructor(
    message: string,
    /** HTTP status when the server answered, undefined for transport failures. */
    readonly status?: number,
    /** True when asking another endpoint of the same server could still work. */
    readonly retryElsewhere = false
  ) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

interface Context {
  fetch: typeof fetch
  timeoutMs: number
  signal?: AbortSignal
  apiKey?: string
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function networkMessage(err: unknown, url: string, timeoutMs: number, timedOut: boolean): string {
  const origin = originOf(url)
  if (timedOut) return `Tempo esgotado (${Math.round(timeoutMs / 100) / 10} s) ao consultar ${origin}.`
  const code = String((err as { cause?: { code?: unknown } })?.cause?.code ?? (err as { code?: unknown })?.code ?? '')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Endereço ${origin} não encontrado. Confira a URL base.`
  if (/^(CERT_|DEPTH_ZERO|UNABLE_TO_|ERR_TLS)/.test(code)) return `Falha de certificado TLS ao conectar a ${origin}.`
  return `Não foi possível conectar a ${origin}. O servidor está em execução?`
}

function httpMessage(status: number, url: string): string {
  if (status === 401 || status === 403) return `Acesso negado (HTTP ${status}): verifique a chave de API.`
  if (status === 404) return `Lista de modelos não encontrada (HTTP 404) em ${originOf(url)}. Confira a URL base.`
  if (status === 429) return 'Limite de requisições atingido (HTTP 429). Tente novamente em instantes.'
  return `O servidor respondeu HTTP ${status} ao listar modelos.`
}

/** Strips the API key from any text before it can reach the UI or logs. */
function scrub(text: string, apiKey: string | undefined): string {
  return apiKey ? text.split(apiKey).join('***') : text
}

async function requestJson(
  ctx: Context,
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown } = {}
): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ctx.timeoutMs)
  const onAbort = (): void => controller.abort()
  if (ctx.signal?.aborted) controller.abort()
  else ctx.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await ctx.fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    })
    if (!res.ok) {
      // 404/405/501 mean "this server does not have that endpoint"; auth and 5xx
      // would fail the same way on any other endpoint.
      throw new DiscoveryError(httpMessage(res.status, url), res.status, [400, 404, 405, 501].includes(res.status))
    }
    const text = await res.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new DiscoveryError(`Resposta de ${originOf(url)} não é JSON válido.`, res.status, true)
    }
  } catch (err) {
    if (err instanceof DiscoveryError) throw err
    if (ctx.signal?.aborted && !timedOut) throw new DiscoveryError('Consulta cancelada.')
    throw new DiscoveryError(networkMessage(err, url, ctx.timeoutMs, timedOut))
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onAbort)
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                      */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function firstPositive(source: Json | null, keys: string[]): number | undefined {
  if (!source) return undefined
  for (const key of keys) {
    const value = positiveInt(source[key])
    if (value !== undefined) return value
  }
  return undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function finish(models: Array<DiscoveredModel | null>): DiscoveredModel[] {
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []
  for (const model of models) {
    if (!model || !model.id || seen.has(model.id)) continue
    seen.add(model.id)
    // Only report what the server said: drop undefined keys.
    out.push(Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)) as unknown as DiscoveredModel)
    if (out.length >= MAX_MODELS) break
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/* ------------------------------------------------------------------ */
/* Ollama                                                               */
/* ------------------------------------------------------------------ */

function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/(?:\/(?:api|v1))+$/i, '')
}

/** `num_ctx 8192` from a Modelfile's parameters block: the context actually allocated. */
function numCtxFromParameters(parameters: unknown): number | undefined {
  if (typeof parameters !== 'string') return undefined
  const match = /^\s*num_ctx\s+(\d+)/m.exec(parameters)
  return match ? positiveInt(Number(match[1])) : undefined
}

async function discoverOllama(ctx: Context, baseUrl: string): Promise<DiscoveredModel[]> {
  const root = ollamaRoot(baseUrl)
  const headers = ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : undefined
  const tags = asRecord(await requestJson(ctx, `${root}/api/tags`, { headers }))
  if (!tags || !Array.isArray(tags.models)) {
    throw new DiscoveryError(`Resposta inesperada de ${originOf(root)}: /api/tags sem lista de modelos.`)
  }
  const ids = tags.models
    .map((entry) => asRecord(entry))
    .map((entry) => (typeof entry?.model === 'string' && entry.model ? entry.model : typeof entry?.name === 'string' ? entry.name : ''))
    .filter(Boolean)
    .slice(0, MAX_MODELS)

  // Details are best-effort: a model whose /api/show fails stays in the list.
  const detailed = await mapLimit(ids, SHOW_CONCURRENCY, async (id): Promise<DiscoveredModel | null> => {
    try {
      const show = asRecord(await requestJson(ctx, `${root}/api/show`, { method: 'POST', headers, body: { model: id } }))
      const capabilities = stringList(show?.capabilities)
      // Embedding-only models cannot chat. Old servers omit capabilities: keep those.
      if (show && Array.isArray(show.capabilities) && !capabilities.includes('completion')) return null
      const info = asRecord(show?.model_info)
      const architectureMax = Object.entries(info ?? {})
        .filter(([key]) => key.endsWith('.context_length'))
        .map(([, value]) => positiveInt(value))
        .find((value) => value !== undefined)
      return {
        id,
        contextWindow: numCtxFromParameters(show?.parameters) ?? architectureMax,
        supportsVision: show && Array.isArray(show.capabilities) ? capabilities.includes('vision') : undefined,
        supportsTools: show && Array.isArray(show.capabilities) ? capabilities.includes('tools') : undefined
      }
    } catch {
      return { id }
    }
  })
  return finish(detailed)
}

/* ------------------------------------------------------------------ */
/* LM Studio                                                            */
/* ------------------------------------------------------------------ */

function lmstudioRoot(baseUrl: string): string {
  return baseUrl.replace(/(?:\/api)?\/v1$/i, '').replace(/\/api$/i, '')
}

async function discoverLmStudio(ctx: Context, baseUrl: string): Promise<DiscoveredModel[]> {
  const root = lmstudioRoot(baseUrl)
  const headers = ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : undefined
  try {
    const body = asRecord(await requestJson(ctx, `${root}/api/v1/models`, { headers }))
    if (body && Array.isArray(body.models)) {
      return finish(
        body.models.map((entry): DiscoveredModel | null => {
          const model = asRecord(entry)
          if (!model || typeof model.key !== 'string') return null
          if (model.type !== undefined && model.type !== 'llm') return null
          const loaded = Array.isArray(model.loaded_instances) ? model.loaded_instances : []
          const loadedContexts = loaded
            .map((instance) => positiveInt(asRecord(asRecord(instance)?.config)?.context_length))
            .filter((value): value is number => value !== undefined)
          const capabilities = asRecord(model.capabilities)
          return {
            id: model.key,
            // A loaded instance has a concrete context; otherwise the model's maximum.
            contextWindow: loadedContexts.length ? Math.min(...loadedContexts) : positiveInt(model.max_context_length),
            supportsVision: typeof capabilities?.vision === 'boolean' ? capabilities.vision : undefined,
            supportsTools: typeof capabilities?.trained_for_tool_use === 'boolean' ? capabilities.trained_for_tool_use : undefined
          }
        })
      )
    }
  } catch (err) {
    // Older LM Studio has no /api/v1/models; anything else would fail again.
    if (!(err instanceof DiscoveryError) || !err.retryElsewhere) throw err
  }
  return discoverOpenAi(ctx, baseUrl)
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible                                                    */
/* ------------------------------------------------------------------ */

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function parseOpenAiModel(entry: unknown): DiscoveredModel | null {
  const model = asRecord(entry)
  if (!model) return null
  const id = [model.id, model.model, model.name].find((value): value is string => typeof value === 'string' && value.length > 0)
  if (!id) return null
  const architecture = asRecord(model.architecture)
  const capabilities = asRecord(model.capabilities)
  const inputs = stringList(architecture?.input_modalities)
  const params = stringList(model.supported_parameters)
  const flag = (...keys: string[]): boolean | undefined => {
    for (const key of keys) if (typeof capabilities?.[key] === 'boolean') return capabilities[key] as boolean
    return undefined
  }
  return {
    id,
    contextWindow:
      firstPositive(model, ['context_length', 'context_window', 'max_model_len', 'max_context_length', 'max_input_tokens']) ??
      firstPositive(asRecord(model.top_provider), ['context_length']),
    supportsVision: inputs.length ? inputs.includes('image') : flag('vision', 'image_input'),
    supportsTools: params.length ? params.includes('tools') : flag('tools', 'function_calling', 'trained_for_tool_use')
  }
}

/**
 * Where an OpenAI-compatible server lists its models. Almost always `<baseUrl>/models`, but OpenCode serves chat at
 * `/inference/.../v1` while its catalog lives at `/zen/v1/models` (the chat base returns 404 for `/models`). Pointing
 * detection there lets "Detectar modelos" pull OpenCode's live catalog instead of failing.
 */
export function openAiModelsUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    if (/(^|\.)opencode\.ai$/i.test(url.hostname)) return `${url.protocol}//${url.host}/zen/v1/models`
  } catch {
    /* not a parseable URL: fall through to the default */
  }
  return `${trimSlash(baseUrl)}/models`
}

async function discoverOpenAi(ctx: Context, baseUrl: string): Promise<DiscoveredModel[]> {
  const url = openAiModelsUrl(baseUrl)
  const body = await requestJson(ctx, url, { headers: ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : undefined })
  const record = asRecord(body)
  const list = Array.isArray(body) ? body : Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : null
  if (!list) throw new DiscoveryError(`Resposta inesperada de ${originOf(url)}: /models sem lista de modelos.`)
  return finish(list.slice(0, MAX_MODELS).map(parseOpenAiModel))
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                            */
/* ------------------------------------------------------------------ */

async function discoverAnthropic(ctx: Context, baseUrl: string): Promise<DiscoveredModel[]> {
  // Providers call `<baseUrl>/messages`, so baseUrl already ends in /v1.
  const base = trimSlash(baseUrl)
  const apiBase = /\/v\d+$/i.test(base) ? base : `${base}/v1`
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }
  if (ctx.apiKey) headers['x-api-key'] = ctx.apiKey

  const entries: unknown[] = []
  let afterId: string | undefined
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const query = `limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`
    const url = `${apiBase}/models?${query}`
    const body = asRecord(await requestJson(ctx, url, { headers }))
    if (!body || !Array.isArray(body.data)) {
      throw new DiscoveryError(`Resposta inesperada de ${originOf(url)}: /models sem lista de modelos.`)
    }
    entries.push(...body.data)
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id) break
    afterId = body.last_id
  }
  return finish(
    entries.map((entry): DiscoveredModel | null => {
      const model = asRecord(entry)
      if (!model || typeof model.id !== 'string') return null
      const image = asRecord(asRecord(model.capabilities)?.image_input)
      return {
        id: model.id,
        contextWindow: positiveInt(model.max_input_tokens),
        supportsVision: typeof image?.supported === 'boolean' ? image.supported : undefined
      }
    })
  )
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Lists the models a server offers.
 * - ollama: GET <root>/api/tags + POST <root>/api/show per model (4 at a time)
 * - lmstudio: GET <root>/api/v1/models, falling back to <baseUrl>/models
 * - openai: GET <baseUrl>/models with a Bearer key
 * - anthropic: GET <baseUrl>/models with x-api-key + anthropic-version
 * `<root>` is `baseUrl` without a trailing `/v1` (or `/api`).
 */
export async function discoverModels(config: DiscoveryConfig, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const source = config.kind
  const apiKey = config.apiKey?.trim() || undefined
  try {
    const baseUrl = trimSlash((config.baseUrl ?? '').trim())
    let parsed: URL | null = null
    try {
      parsed = new URL(baseUrl)
    } catch {
      /* reported below */
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return { models: [], source, error: 'URL base inválida: informe um endereço http:// ou https://.' }
    }
    const ctx: Context = {
      fetch: opts.fetch ?? globalThis.fetch,
      timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      apiKey
    }
    const run =
      source === 'ollama'
        ? discoverOllama
        : source === 'lmstudio'
          ? discoverLmStudio
          : source === 'anthropic'
            ? discoverAnthropic
            : discoverOpenAi
    return { models: await run(ctx, baseUrl), source }
  } catch (err) {
    const message = err instanceof DiscoveryError ? err.message : `Falha ao listar modelos: ${(err as Error)?.message ?? String(err)}`
    return { models: [], source, error: scrub(message, apiKey) }
  }
}
