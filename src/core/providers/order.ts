import type { ProviderConfig } from '../../shared/types.js'

/** Pure helpers for the reserve order; the Settings screen and the chain builder use the same rules. */

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(baseUrl ?? '')
}

/**
 * Providers in the order the reserve uses them: the ones the user ordered first, then every other provider in the
 * order they are listed (a provider added later joins the end of the line by itself, so "never stop for lack of
 * credit" does not depend on remembering to edit this list).
 */
export function orderedProviders<T extends { id: string }>(providers: readonly T[], order?: readonly string[]): T[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const out: T[] = []
  const seen = new Set<string>()
  for (const id of order ?? []) {
    const provider = byId.get(id)
    if (!provider || seen.has(id)) continue
    seen.add(id)
    out.push(provider)
  }
  for (const provider of providers) {
    if (seen.has(provider.id)) continue
    seen.add(provider.id)
    out.push(provider)
  }
  return out
}

/** Ollama serves some models from its cloud (`name:cloud`, `name-cloud`): another account and another limit than the local ones. */
export const CLOUD_MODEL = /[:-]cloud$/i

/**
 * Whose limit a model spends. Every model of a provider shares the provider's account, except the cloud models of a local
 * Ollama server: they have their own monthly limit, while the local models of the same server cost nothing and never run out.
 * A failure of "no balance / key refused / no connection" is the account's, so it rules out every model of the same account.
 */
export function accountKeyOf(config: { id: string; baseUrl?: string; model: string }): string {
  return isLocalBaseUrl(config.baseUrl) && CLOUD_MODEL.test(config.model) ? `${config.id}:cloud` : config.id
}

/**
 * The models of a provider that take part in the reserve, in the order they are tried: the ones the user ticked (`chosen`),
 * the provider's own model first and the rest as the provider's list has them. A ticked name the list no longer has (a model
 * the provider retired) is left out: the screen shows no box for it, so it could never be unticked.
 * `chosen` missing means "never touched": just the provider's own model. An empty list means "none of them".
 * The Settings screen and the chain builder both read the selection through this, so what is ticked is what is tried.
 */
export function reserveModels(provider: Pick<ProviderConfig, 'model' | 'models'>, chosen?: readonly string[]): string[] {
  const main = provider.model?.trim() ?? ''
  if (chosen === undefined) return main ? [main] : []
  const wanted = new Set(chosen.map((model) => model.trim()).filter(Boolean))
  const known = [...new Set([main, ...(provider.models ?? [])].filter(Boolean))]
  return known.filter((model) => wanted.has(model))
}

/** The agent needs tool calling and a model name: anything else cannot take over a task. */
export function canJoinReserve(config: Pick<ProviderConfig, 'model' | 'supportsTools'>): boolean {
  return config.supportsTools !== false && Boolean(config.model?.trim())
}

/** Whether a model is known to read images: the per-model list from "Detectar modelos" wins over the provider flag. */
export function modelSeesImages(config: Pick<ProviderConfig, 'model' | 'supportsVision'> & { visionModels?: string[] }): boolean {
  if (config.visionModels?.length) return config.visionModels.includes(config.model)
  return config.supportsVision
}
