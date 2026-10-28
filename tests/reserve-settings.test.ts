import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore, SETTINGS_VERSION, type SecretCrypto } from '../src/main/settings'
import { ProviderReserve, visionModelOf } from '../src/main/reserve'
import { classifyProviderError } from '../src/core/providers/http'
import type { AppSettings, ProviderConfig } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * The reserve as the app sees it: on by default, ordered by the user, started on a provider that works, and a model
 * that reads images found for the ones that cannot. Over a real SettingsStore with the OS vault replaced by a fake.
 */
const fakeCrypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (data) => Buffer.from(data.toString('utf8').slice(4), 'base64').toString('utf8')
}

let dir: string
beforeEach(async () => {
  dir = await makeTempDir('openclod-reserve-')
})
afterEach(async () => removeTempDir(dir))

function provider(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: 'openai',
    label: id,
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-m`,
    apiKeyRef: `secret:${id}`,
    contextWindow: 100_000,
    supportsVision: false,
    supportsTools: true,
    ...over
  }
}

async function storeWith(settings: Partial<AppSettings>, secrets: string[]): Promise<SettingsStore> {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings))
  const store = new SettingsStore(dir, fakeCrypto)
  await store.init()
  for (const id of secrets) await store.setSecret(id, `chave-de-teste-${id}`)
  return store
}

describe('the reserve is on unless the user turned it off', () => {
  it('is on in new profiles', async () => {
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    expect(store.get().useAllModels).toBe(true)
  })

  it('turns on a file written by an earlier build with the old explicit false (once), and keeps a later choice', async () => {
    const store = await storeWith({ settingsVersion: 7, useAllModels: false }, [])
    expect(store.get().useAllModels).toBe(true)
    expect(store.get().settingsVersion).toBe(SETTINGS_VERSION)
    expect(store.migrations.join(' ')).toContain('reserva automática entre provedores ligada')

    // The user turns it off in Settings: the next start respects it.
    await store.update({ useAllModels: false })
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.get().useAllModels).toBe(false)
    expect(again.migrations.join(' ')).not.toContain('reserva')
  })

  it('leaves a file that already had it on alone, without a migration note', async () => {
    const store = await storeWith({ settingsVersion: 7, useAllModels: true }, [])
    expect(store.get().useAllModels).toBe(true)
    expect(store.migrations.join(' ')).not.toContain('reserva')
  })
})

describe('ProviderReserve', () => {
  const providers = [provider('deepseek'), provider('openrouter'), provider('anthropic'), provider('semchave', { apiKeyRef: 'env:SEM_CHAVE_NENHUMA' })]

  async function reserve(extra: Partial<AppSettings> = {}, secrets = ['deepseek', 'openrouter', 'anthropic']): Promise<{ reserve: ProviderReserve; store: SettingsStore }> {
    const store = await storeWith({ settingsVersion: SETTINGS_VERSION, providers, defaultProviderId: 'deepseek', useAllModels: true, ...extra }, secrets)
    return { reserve: new ProviderReserve({ settings: () => store.get(), resolver: () => store.resolver() }), store }
  }

  it('lists the providers that have a key, in the order the user chose, never the one in use', async () => {
    const { reserve: r } = await reserve({ fallbackOrder: ['anthropic', 'openrouter'] })
    expect(r.chainFor(providers[0]).map((candidate) => candidate.config.id)).toEqual(['anthropic', 'openrouter'])
    expect(r.chainFor(providers[1]).map((candidate) => candidate.config.id)).toEqual(['anthropic', 'deepseek'])
  })

  it('leaves out a provider that has no key (it would only fail)', async () => {
    const { reserve: r } = await reserve()
    expect(r.chainFor(providers[0]).map((candidate) => candidate.config.id)).not.toContain('semchave')
  })

  it('tries the models ticked for a provider in Settings (fallbackModels), saved with the settings, not only its own model', async () => {
    const withModels = [provider('deepseek'), provider('openrouter', { model: 'or-1', models: ['or-1', 'or-2', 'or-3'] }), provider('anthropic')]
    const { reserve: r, store } = await reserve({ providers: withModels, fallbackOrder: ['openrouter'], fallbackModels: { openrouter: ['or-3', 'or-1'] } })
    expect(r.chainFor(withModels[0]).map((candidate) => `${candidate.config.id}/${candidate.config.model}`)).toEqual([
      'openrouter/or-1',
      'openrouter/or-3',
      'anthropic/anthropic-m'
    ])
    // It survives a restart (the file keeps it) and a provider with every box cleared stays out.
    await store.update({ fallbackModels: { openrouter: [], anthropic: ['anthropic-m'] } })
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.get().fallbackModels).toEqual({ openrouter: [], anthropic: ['anthropic-m'] })
    const reread = new ProviderReserve({ settings: () => again.get(), resolver: () => again.resolver() })
    expect(reread.chainFor(withModels[0]).map((candidate) => candidate.config.id)).toEqual(['anthropic'])
  })

  it('is empty when the user turned the reserve off', async () => {
    const { reserve: r } = await reserve({ useAllModels: false })
    expect(r.enabled()).toBe(false)
    expect(r.chainFor(providers[0])).toEqual([])
  })

  it('starts a session on the provider that works when its own is known to be down, and not otherwise', async () => {
    const { reserve: r } = await reserve({ fallbackOrder: ['openrouter'] })
    expect(r.startingPoint(providers[0]).config.id).toBe('deepseek')

    r.health.mark(providers[0], 'quota')
    const moved = r.startingPoint(providers[0])
    expect(moved.config.id).toBe('openrouter')
    expect(moved.movedFrom).toMatchObject({ kind: 'quota', config: { id: 'deepseek' } })
    // The status the Settings tile shows.
    expect(r.statusOf('deepseek')?.kind).toBe('quota')

    // A key saved again (or a successful test) clears it: the session is back on its own provider.
    r.health.clear('deepseek')
    expect(r.startingPoint(providers[0]).config.id).toBe('deepseek')
  })

  it('keeps the session where it is when nothing else can take over', async () => {
    const { reserve: r } = await reserve({}, ['deepseek'])
    r.health.mark(providers[0], 'quota')
    expect(r.startingPoint(providers[0]).config.id).toBe('deepseek')
    expect(r.startingPoint(providers[0]).movedFrom).toBeUndefined()
  })

  it('finds models that read images: the one the user picked, then the reserve providers that have one', async () => {
    const withVision = [
      provider('deepseek'),
      provider('openrouter', { supportsVision: true, model: 'texto/apenas', visionModels: ['google/gemini-flash', 'anthropic/claude-sonnet'] }),
      provider('anthropic', { supportsVision: true, model: 'claude-haiku' })
    ]
    const { reserve: r } = await reserve({ providers: withVision })
    expect(r.visionCandidates().map((candidate) => `${candidate.config.id}/${candidate.config.model}`)).toEqual([
      'openrouter/google/gemini-flash', // the cheap-looking one of the list, not the text-only default
      'anthropic/claude-haiku'
    ])

    const { reserve: picked } = await reserve({ providers: withVision, visionModel: { providerId: 'anthropic', model: 'claude-sonnet-x' } })
    expect(picked.visionCandidates()[0].config).toMatchObject({ id: 'anthropic', model: 'claude-sonnet-x', supportsVision: true })

    // A provider that failed goes to the end.
    picked.health.mark({ id: 'anthropic', model: 'claude-sonnet-x' }, 'quota')
    expect(picked.visionCandidates().at(-1)?.config.id).toBe('anthropic')
  })

  it('visionModelOf trusts the list from the server, then the provider flag', () => {
    expect(visionModelOf(provider('a', { model: 'm', visionModels: ['m', 'n'] }))).toBe('m')
    expect(visionModelOf(provider('a', { model: 'texto', visionModels: ['grande-pro', 'pequeno-flash'] }))).toBe('pequeno-flash')
    // The free tier of OpenRouter has a small daily cap: a paid model is picked first, even when the free one looks cheaper.
    expect(visionModelOf(provider('a', { model: 'texto', visionModels: ['vendor/free-model:free', 'vendor/grande-pro'] }))).toBe('vendor/grande-pro')
    expect(visionModelOf(provider('a', { model: 'texto', visionModels: ['vendor/a:free', 'vendor/b:free'] }))).toBe('vendor/a:free')
    expect(visionModelOf(provider('a', { model: 'm', supportsVision: true }))).toBe('m')
    expect(visionModelOf(provider('a', { model: 'm', supportsVision: false }))).toBeUndefined()
  })
})

describe('provider failures are told apart', () => {
  it('reads the usage-limit and no-balance messages of real providers as "no credit", not as a rate limit', () => {
    // DeepSeek: 402 with an insufficient_balance_error body.
    expect(classifyProviderError(402, '{"error":{"message":"Insufficient Balance","type":"insufficient_balance_error"}}')).toBe('quota')
    // Ollama Cloud: HTTP 429 whose message says the monthly usage limit was reached.
    expect(classifyProviderError(429, 'you (x) have reached your monthly usage limit, upgrade for higher limits or add usage credits')).toBe('quota')
    // The same text under another status code still means there is no credit.
    expect(classifyProviderError(403, 'Insufficient Balance')).toBe('quota')
    expect(classifyProviderError(400, 'insufficient_balance_error: recharge your account')).toBe('quota')
    // OpenRouter's free tier: a DAILY cap (what the user hit through Ollama's router today), not "wait a minute".
    expect(classifyProviderError(429, 'openrouter: Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day')).toBe('quota')
    // A plain rate limit keeps meaning "wait a little".
    expect(classifyProviderError(429, 'Rate limit reached for requests per minute')).toBe('rate_limit')
    expect(classifyProviderError(429, 'Too many requests')).toBe('rate_limit')
    expect(classifyProviderError(401, 'Incorrect API key provided')).toBe('auth')
  })
})
