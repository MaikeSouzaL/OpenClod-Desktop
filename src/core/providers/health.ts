import type { ProviderErrorKind } from '../../shared/types.js'
import { accountKeyOf } from './order.js'

/** What identifies a model for the health registry (the address is only needed to tell Ollama's cloud models apart). */
export interface HealthSubject {
  id: string
  model: string
  baseUrl?: string
}

/** A provider (or one of its models) the harness found unable to answer, and until when it is skipped. */
export interface ProviderHealthEntry {
  providerId: string
  /** Set when only this model is affected (a rate limit, a model the provider does not serve). */
  model?: string
  kind: ProviderErrorKind
  since: number
  until: number
  /** The failure belongs to the cloud models of a local Ollama server, not to the server's local models. */
  cloud?: boolean
}

/** Failures that belong to the account or to the connection: every model of the provider fails the same way. */
export function isAccountLevelKind(kind: ProviderErrorKind): boolean {
  return kind === 'quota' || kind === 'auth' || kind === 'network'
}

/** How long a failed provider is left alone before it is tried again (a recharge or a new key clears it sooner). */
export function cooldownMs(kind: ProviderErrorKind, retryAfterMs?: number): number {
  switch (kind) {
    case 'quota':
    case 'auth':
      return 10 * 60_000
    case 'bad_request':
      return 10 * 60_000
    case 'rate_limit':
      return Math.min(10 * 60_000, Math.max(30_000, retryAfterMs ?? 60_000))
    case 'overloaded':
      return 2 * 60_000
    case 'network':
    case 'server':
    case 'timeout':
      return 90_000
    default:
      return 60_000
  }
}

/**
 * What the harness learned about which providers work right now, shared by every session: the first request that
 * hits "insufficient balance" teaches the next session not to try that provider again (until the cooldown ends, or
 * the user saves a key / settings / tests the provider, which calls `clear`). It only ever reorders and skips:
 * when everything is marked, the chain still tries them in order, so a wrong mark can never stop the work.
 */
export class ProviderHealth {
  private readonly entries = new Map<string, ProviderHealthEntry>()

  constructor(private readonly clock: () => number = Date.now) {}

  private key(providerId: string, model?: string): string {
    return model ? `${providerId}::${model}` : providerId
  }

  /** Records a failure. Account-level kinds mark the whole account, the others only the model that failed. */
  mark(config: HealthSubject, kind: ProviderErrorKind, retryAfterMs?: number): ProviderHealthEntry {
    const now = this.clock()
    const account = isAccountLevelKind(kind)
    const entry: ProviderHealthEntry = {
      providerId: config.id,
      ...(account ? {} : { model: config.model }),
      ...(account && accountKeyOf(config).endsWith(':cloud') ? { cloud: true } : {}),
      kind,
      since: now,
      until: now + cooldownMs(kind, retryAfterMs)
    }
    this.entries.set(account ? this.key(accountKeyOf(config)) : this.key(entry.providerId, entry.model), entry)
    return entry
  }

  /** The active failure that covers this provider/model, if any. */
  unavailable(config: HealthSubject): ProviderHealthEntry | undefined {
    const now = this.clock()
    for (const key of [this.key(accountKeyOf(config)), this.key(config.id, config.model)]) {
      const entry = this.entries.get(key)
      if (!entry) continue
      if (entry.until <= now) {
        this.entries.delete(key)
        continue
      }
      return entry
    }
    return undefined
  }

  /** The most telling active failure of a provider (account level first), for the status shown in Settings. */
  statusOf(providerId: string): ProviderHealthEntry | undefined {
    const active = this.list().filter((entry) => entry.providerId === providerId)
    return active.find((entry) => !entry.model) ?? active[0]
  }

  list(): ProviderHealthEntry[] {
    const now = this.clock()
    for (const [key, entry] of [...this.entries]) if (entry.until <= now) this.entries.delete(key)
    return [...this.entries.values()]
  }

  /** The user fixed something (new key, recharge, saved settings, successful test): forget what was learned. */
  clear(providerId?: string): void {
    if (!providerId) {
      this.entries.clear()
      return
    }
    for (const [key, entry] of [...this.entries]) if (entry.providerId === providerId) this.entries.delete(key)
  }
}

/** Plain words for the user, used in the notices and in the Settings tiles. */
export function describeFailure(kind: ProviderErrorKind): string {
  switch (kind) {
    case 'quota':
      return 'sem saldo ou cota'
    case 'auth':
      return 'chave recusada'
    case 'rate_limit':
      return 'limite de uso atingido'
    case 'overloaded':
      return 'sobrecarregado'
    case 'bad_request':
      return 'modelo indisponível'
    case 'network':
      return 'sem conexão'
    case 'timeout':
      return 'sem resposta a tempo'
    case 'server':
      return 'erro do servidor'
    case 'context_overflow':
      return 'janela de contexto excedida'
    default:
      return 'falhou'
  }
}
