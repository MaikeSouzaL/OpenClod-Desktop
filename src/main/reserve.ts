import type { AppSettings, ProviderConfig, ProviderErrorKind } from '../shared/types.js'
import { createProvider, hasCredentials, resolveApiKey } from '../core/providers/index.js'
import { checkColabLink } from '../core/colab/link.js'
import { buildFallbackChain, type FallbackCandidate } from '../core/providers/chain.js'
import { ProviderHealth, isAccountLevelKind } from '../core/providers/health.js'
import { accountKeyOf, orderedProviders } from '../core/providers/order.js'
import type { DescribeCandidate } from '../core/vision/relay.js'

/** What the reserve needs from the app's settings: read-only, so a test can hand it plain objects. */
export interface ReserveSource {
  settings(): AppSettings
  resolver(): { get(key: string): string | undefined }
}

/** Words in a model id that usually mean "small and cheap": the first choice to describe pictures. */
const CHEAP_HINT = /flash|mini|haiku|lite|small|nano|4b|7b|8b/i

/** OpenRouter's free models share a small daily cap (50 requests without credits): the last choice, never the first. */
const FREE_TIER = /:free$/i

/** A model of this provider that can read images: the one it is set to when it reads them, else one the server listed. */
export function visionModelOf(config: ProviderConfig): string | undefined {
  const known = (config.visionModels ?? []).filter(Boolean)
  if (known.length) {
    if (known.includes(config.model)) return config.model
    const paid = known.filter((model) => !FREE_TIER.test(model))
    const pool = paid.length ? paid : known
    return pool.find((model) => CHEAP_HINT.test(model)) ?? pool[0]
  }
  return config.supportsVision && config.model.trim() ? config.model : undefined
}

/**
 * The app's answer to "which LLM takes over when this one cannot": the ordered reserve of every session, what the
 * harness learned about which providers work right now (shared by all sessions), where a session should START when its
 * own provider is known to be down, and which models read pictures for the ones that cannot.
 */
export class ProviderReserve {
  constructor(
    private readonly source: ReserveSource,
    readonly health: ProviderHealth = new ProviderHealth()
  ) {}

  /** On by default; the switch in Settings turns it off. */
  enabled(): boolean {
    return this.source.settings().useAllModels !== false
  }

  /** The reserve of a session that runs on `current`: other providers with a credential, in the user's order. */
  chainFor(current: ProviderConfig): FallbackCandidate[] {
    if (!this.enabled()) return []
    const resolver = this.source.resolver()
    return buildFallbackChain(this.source.settings(), {
      current,
      hasCredentials: (config) => hasCredentials(config, resolver),
      create: (config) => createProvider(config, resolver),
      health: this.health,
      // A Colab server behind a tunnel is "up" as far as TCP can tell even after the notebook ended: ask it, in 2.5 s.
      probeFor: (config) =>
        config.colab
          ? async () => {
              const check = await checkColabLink({ baseUrl: config.baseUrl, apiKey: resolveApiKey(config, resolver), model: config.model, timeoutMs: 2500 })
              if (check.state === 'caiu') this.health.mark(config, 'network')
              else if (check.state === 'chave') this.health.mark(config, 'auth')
              return check.state === 'conectado' || check.state === 'erro'
            }
          : undefined
    })
  }

  /**
   * Where a session starts. Its own provider, unless the harness already knows that one cannot answer (no balance, key
   * refused...) and another works: then it starts on that one, so a recharge-less account is not asked again at every turn.
   */
  startingPoint(wanted: ProviderConfig): {
    config: ProviderConfig
    movedFrom?: { config: ProviderConfig; kind: ProviderErrorKind; missingKey?: boolean }
  } {
    // A provider with no key cannot answer either: a session saved on one (the key was removed, or never saved) starts on
    // the reserve instead of refusing the message.
    const missingKey = !hasCredentials(wanted, this.source.resolver())
    const down = missingKey ? undefined : this.health.unavailable(wanted)
    if ((!missingKey && !down) || !this.enabled()) return { config: wanted }
    const kind: ProviderErrorKind = missingKey ? 'auth' : (down as { kind: ProviderErrorKind }).kind
    const sameAccountFails = missingKey || isAccountLevelKind(kind)
    const mine = accountKeyOf(wanted)
    const next = this.chainFor(wanted).find(
      (candidate) => !this.health.unavailable(candidate.config) && !(sameAccountFails && accountKeyOf(candidate.config) === mine)
    )
    return next ? { config: next.config, movedFrom: { config: wanted, kind, ...(missingKey ? { missingKey: true } : {}) } } : { config: wanted }
  }

  /** Models that read images, in the order to try: the one the user picked, then the reserve providers that have one. */
  visionCandidates(): DescribeCandidate[] {
    const settings = this.source.settings()
    const resolver = this.source.resolver()
    const healthy: DescribeCandidate[] = []
    const degraded: DescribeCandidate[] = []
    const seen = new Set<string>()
    const add = (base: ProviderConfig, model: string): void => {
      const key = `${base.id}::${model}`
      if (seen.has(key) || !hasCredentials(base, resolver)) return
      seen.add(key)
      const config: ProviderConfig = { ...base, model, supportsVision: true, visionModels: undefined }
      try {
        const candidate = { provider: createProvider(config, resolver), config }
        ;(this.health.unavailable(config) ? degraded : healthy).push(candidate)
      } catch {
        /* one invalid provider must not stop the others */
      }
    }
    const chosen = settings.visionModel
    const chosenBase = chosen ? settings.providers.find((provider) => provider.id === chosen.providerId) : undefined
    if (chosen && chosenBase) add(chosenBase, chosen.model)
    for (const provider of orderedProviders(settings.providers, settings.fallbackOrder)) {
      if (settings.fallbackExclude?.includes(provider.id)) continue
      const model = visionModelOf(provider)
      if (model) add(provider, model)
    }
    return [...healthy, ...degraded]
  }

  /** What Settings shows next to each provider: the failure the harness is working around, if any. */
  statusOf(providerId: string): { kind: ProviderErrorKind; since: number; until: number; cloud?: boolean } | undefined {
    const entry = this.health.statusOf(providerId)
    return entry ? { kind: entry.kind, since: entry.since, until: entry.until, ...(entry.cloud ? { cloud: true } : {}) } : undefined
  }
}
