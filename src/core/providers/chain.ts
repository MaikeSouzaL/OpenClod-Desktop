import net from 'node:net'
import type { Provider, ProviderConfig } from '../../shared/types.js'
import type { ProviderHealth } from './health.js'
import { CLOUD_MODEL, canJoinReserve, isLocalBaseUrl, orderedProviders, reserveModels } from './order.js'

/** One model the session can move to when the active one cannot answer. */
export interface FallbackCandidate {
  provider: Provider
  config: ProviderConfig
  /** Cheap "is anything listening" check for local servers (Ollama, LM Studio), run right before switching to it. */
  probe?: () => Promise<boolean>
}

/** A local server that is not running would only cost a failed request: connect to its port instead. */
export function probeTcp(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      resolve(true)
      return
    }
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Curated model lists (a handful of entries) are alternatives worth trying; a catalog of hundreds is not. */
const MAX_CURATED_MODELS = 6

export interface ChainSettings {
  providers: readonly ProviderConfig[]
  /** The user's order of preference for the reserve (provider ids). */
  fallbackOrder?: readonly string[]
  /** Providers the user does not want as a reserve. */
  fallbackExclude?: readonly string[]
  /** The models ticked for each provider (Settings → Ordem da reserva); a provider with no entry takes part with its own model. */
  fallbackModels?: Readonly<Record<string, readonly string[]>>
}

export interface ChainOptions {
  /** What the session runs on now: it is never part of its own reserve. */
  current: ProviderConfig
  hasCredentials: (config: ProviderConfig) => boolean
  create: (config: ProviderConfig) => Provider
  health?: ProviderHealth
  /**
   * A cheap "is it there" check for a candidate that is not a local server (a Google Colab tunnel: the TCP port of the
   * Cloudflare edge always answers, only an authenticated request tells whether the notebook is still alive).
   */
  probeFor?: (config: ProviderConfig) => (() => Promise<boolean>) | undefined
  /** Also queue the other models of the current provider's own short list (they only help with per-model failures). */
  sameProviderModels?: boolean
  /** Most candidates kept. */
  limit?: number
}

/**
 * The reserve of a session, in the order it is tried:
 *  1. the other models of the provider in use (only when it lists a handful of them; the runner skips them when the
 *     failure is the account's: no balance, a refused key, no connection);
 *  2. every other provider that has a credential, in the user's order, each with the model configured for it.
 * Providers that failed recently go to the end instead of being dropped, so the chain never ends up empty because of
 * a mark that may be stale. Local servers carry a `probe`, so one that is not running is skipped without a request.
 */
export function buildFallbackChain(settings: ChainSettings, options: ChainOptions): FallbackCandidate[] {
  const { current, health } = options
  // Room for the models the user ticked (a few per provider), not for a whole catalog.
  const limit = options.limit ?? 40
  const excluded = new Set(settings.fallbackExclude ?? [])
  const seen = new Set<string>([`${current.id}::${current.model}`])
  const healthy: FallbackCandidate[] = []
  const degraded: FallbackCandidate[] = []

  const add = (config: ProviderConfig): void => {
    const key = `${config.id}::${config.model}`
    if (seen.has(key)) return
    seen.add(key)
    let provider: Provider
    try {
      provider = options.create(config)
    } catch {
      return // one invalid provider must not stop the chain
    }
    // A specific probe (an authenticated request to a Colab server) beats the generic "is the port open" one, even on this
    // computer (the test mode of the Colab feature points at 127.0.0.1).
    const probe = options.probeFor?.(config) ?? (isLocalBaseUrl(config.baseUrl) ? () => probeTcp(config.baseUrl) : undefined)
    const candidate: FallbackCandidate = { provider, config, ...(probe ? { probe } : {}) }
    ;(health?.unavailable(config) ? degraded : healthy).push(candidate)
  }

  /**
   * A local Ollama server also serves cloud models (`name:cloud`) that have their own monthly limit; its local models cost
   * nothing and never run out. When the model is a cloud one, the first local models of the server are its natural reserve.
   */
  const localAlternates = (config: ProviderConfig): ProviderConfig[] => {
    if (!isLocalBaseUrl(config.baseUrl) || !CLOUD_MODEL.test(config.model)) return []
    // Names with a "/" (`openrouter/vendor/model:free`, `opencode-go/x`) are Ollama entries that point at somebody else's
    // service: they spend that account, not the machine.
    return (config.models ?? [])
      .filter((model) => model && !CLOUD_MODEL.test(model) && !model.includes('/'))
      .slice(0, 2)
      .map((model) => ({ ...config, model }))
  }

  const own = settings.providers.find((provider) => provider.id === current.id)
  if (own && options.sameProviderModels !== false && options.hasCredentials(own)) {
    // The local models of the server first (they do not share the cloud limit), then the models the user ticked for this
    // provider or, when nothing was ticked, a short list of other models.
    for (const alternate of localAlternates({ ...own, model: current.model })) add(alternate)
    const ticked = settings.fallbackModels?.[own.id]
    if (ticked !== undefined) {
      for (const model of reserveModels(own, ticked)) add({ ...own, model })
    } else {
      const models = (own.models ?? []).filter(Boolean)
      if (models.length > 1 && models.length <= MAX_CURATED_MODELS) {
        for (const model of models) add({ ...own, model })
      }
    }
  }

  for (const provider of orderedProviders(settings.providers, settings.fallbackOrder)) {
    if (excluded.has(provider.id)) continue
    if (!canJoinReserve(provider) || !options.hasCredentials(provider)) continue
    if (provider.id === current.id) continue
    const ticked = settings.fallbackModels?.[provider.id]
    if (ticked !== undefined) {
      // The user chose which models of this provider take part: each one, in order (none ticked = the provider is out).
      for (const model of reserveModels(provider, ticked)) add({ ...provider, model })
      continue
    }
    add({ ...provider })
    for (const alternate of localAlternates(provider)) add(alternate)
  }

  return [...healthy, ...degraded].slice(0, limit)
}
