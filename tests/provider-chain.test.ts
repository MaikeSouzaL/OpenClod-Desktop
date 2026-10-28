import net from 'node:net'
import { describe, expect, it } from 'vitest'
import type { Provider, ProviderConfig } from '../src/shared/types'
import { buildFallbackChain, probeTcp } from '../src/core/providers/chain'
import { ProviderHealth, cooldownMs, isAccountLevelKind } from '../src/core/providers/health'
import { accountKeyOf, canJoinReserve, modelSeesImages, orderedProviders, reserveModels } from '../src/core/providers/order'

/**
 * The reserve of a session: which providers take over when the one in use runs out of credit, in which order, and
 * which ones are left out because they would only fail too.
 */
function cfg(id: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: 'openai',
    label: id.toUpperCase(),
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-model`,
    apiKeyRef: `secret:${id}`,
    contextWindow: 100_000,
    supportsVision: false,
    supportsTools: true,
    ...extra
  }
}

const create = (config: ProviderConfig): Provider => ({
  id: config.id,
  label: config.label,
  supportsVision: config.supportsVision,
  contextWindow: config.contextWindow,
  countTokens: (text) => text.length,
  async *stream() {
    /* never called here */
  }
})

const hasCredentials = (config: ProviderConfig): boolean => Boolean(config.apiKeyRef) || config.id === 'ollama'

const ids = (chain: ReturnType<typeof buildFallbackChain>): string[] => chain.map((item) => `${item.config.id}::${item.config.model}`)

describe('the reserve chain', () => {
  const providers = [
    cfg('deepseek'),
    cfg('anthropic'),
    cfg('kimi', { apiKeyRef: '' }), // no credential
    cfg('openrouter'),
    cfg('ollama', { apiKeyRef: '', baseUrl: 'http://127.0.0.1:11434/v1' }),
    cfg('toolless', { supportsTools: false })
  ]

  it('takes every OTHER provider that has a credential, in the order the user chose and then as listed', () => {
    const chain = buildFallbackChain(
      { providers, fallbackOrder: ['openrouter'] },
      { current: providers[0], hasCredentials, create }
    )
    // kimi has no credential and toolless cannot run an agent: both are left out; the provider in use is not its own reserve.
    expect(ids(chain)).toEqual(['openrouter::openrouter-model', 'anthropic::anthropic-model', 'ollama::ollama-model'])
  })

  it('leaves out what the user excluded and keeps a provider added later at the end of the line', () => {
    const chain = buildFallbackChain(
      { providers: [...providers, cfg('novo')], fallbackOrder: ['openrouter'], fallbackExclude: ['anthropic'] },
      { current: providers[0], hasCredentials, create }
    )
    expect(ids(chain)).toEqual(['openrouter::openrouter-model', 'ollama::ollama-model', 'novo::novo-model'])
  })

  it('tries the other models of a short list first, and ignores a catalog of hundreds', () => {
    const withModels = [
      cfg('deepseek', { models: ['deepseek-flash', 'deepseek-v4-pro'], model: 'deepseek-flash' }),
      cfg('openrouter', { models: Array.from({ length: 463 }, (_, index) => `vendor/model-${index}`), model: 'vendor/model-0' })
    ]
    const fromDeepseek = buildFallbackChain({ providers: withModels }, { current: withModels[0], hasCredentials, create })
    expect(ids(fromDeepseek)).toEqual(['deepseek::deepseek-v4-pro', 'openrouter::vendor/model-0'])
    const fromOpenrouter = buildFallbackChain({ providers: withModels }, { current: withModels[1], hasCredentials, create })
    // 463 alphabetical models are not alternatives: only the other provider is.
    expect(ids(fromOpenrouter)).toEqual(['deepseek::deepseek-flash'])
  })

  it('moves a provider that failed recently to the end instead of dropping it', () => {
    let now = 1_000
    const health = new ProviderHealth(() => now)
    health.mark(providers[3], 'quota')
    const chain = buildFallbackChain({ providers }, { current: providers[0], hasCredentials, create, health })
    expect(ids(chain)).toEqual(['anthropic::anthropic-model', 'ollama::ollama-model', 'openrouter::openrouter-model'])
    now += cooldownMs('quota') + 1
    expect(ids(buildFallbackChain({ providers }, { current: providers[0], hasCredentials, create, health }))).toEqual([
      'anthropic::anthropic-model',
      'openrouter::openrouter-model',
      'ollama::ollama-model'
    ])
  })

  it('gives local servers a probe (so one that is not running costs no request) and remote ones none', () => {
    const chain = buildFallbackChain({ providers }, { current: providers[0], hasCredentials, create })
    const byId = Object.fromEntries(chain.map((item) => [item.config.id, item]))
    expect(byId.ollama.probe).toBeTypeOf('function')
    expect(byId.openrouter.probe).toBeUndefined()
  })

  it('after an Ollama CLOUD model hits its monthly limit, the first reserve is the LOCAL models of the same server', () => {
    const ollama = cfg('ollama', {
      apiKeyRef: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'gemma4:31b-cloud',
      // A catalog (more than a handful): only the local models are alternates, the sibling cloud models are not.
      // `openrouter/...:free` is an Ollama entry that points at another service: not a machine-local model.
      models: ['gemma4:31b-cloud', 'kimi-k3:cloud', 'openrouter/google/gemma-4-31b-it:free', 'glm-5.3:cloud', 'qwen3.5:4b', 'llama3.2:3b', 'phi4:14b', 'mistral:7b']
    })
    const others = [cfg('openrouter'), ollama]
    const fromCloud = buildFallbackChain({ providers: others }, { current: ollama, hasCredentials, create })
    expect(ids(fromCloud)).toEqual(['ollama::qwen3.5:4b', 'ollama::llama3.2:3b', 'openrouter::openrouter-model'])

    // From another provider the server joins the reserve with its configured model, then its local models.
    const fromOpenrouter = buildFallbackChain({ providers: others }, { current: others[0], hasCredentials, create })
    expect(ids(fromOpenrouter)).toEqual(['ollama::gemma4:31b-cloud', 'ollama::qwen3.5:4b', 'ollama::llama3.2:3b'])

    // A local model that is not a cloud one has no such alternates.
    const local = { ...ollama, model: 'qwen3.5:4b' }
    expect(ids(buildFallbackChain({ providers: [cfg('openrouter'), local] }, { current: local, hasCredentials, create }))).toEqual(['openrouter::openrouter-model'])
  })

  it('tries the models the user ticked for a provider, in the provider\'s list order with its own model first, and none of the others', () => {
    const b = cfg('b', { model: 'b-m1', models: ['b-m1', 'b-m2', 'b-m3', 'b-m4'] })
    const providers = [cfg('a'), b, cfg('c')]
    const chain = buildFallbackChain(
      { providers, fallbackOrder: ['b', 'c'], fallbackModels: { b: ['b-m3', 'b-m1', 'b-m4'] } },
      { current: providers[0], hasCredentials, create }
    )
    // b-m2 was not ticked: never tried. c has no entry: only its own model.
    expect(ids(chain)).toEqual(['b::b-m1', 'b::b-m3', 'b::b-m4', 'c::c-model'])
  })

  it('a provider with every box cleared is out of the line, and one never touched keeps just its own model', () => {
    const b = cfg('b', { model: 'b-m1', models: ['b-m1', 'b-m2'] })
    const providers = [cfg('a'), b, cfg('c')]
    const none = buildFallbackChain({ providers, fallbackModels: { b: [] } }, { current: providers[0], hasCredentials, create })
    expect(ids(none)).toEqual(['c::c-model'])
    const untouched = buildFallbackChain({ providers }, { current: providers[0], hasCredentials, create })
    expect(ids(untouched)).toEqual(['b::b-m1', 'c::c-model'])
  })

  it('the models ticked for the provider in use are its first alternates (they help with per-model failures)', () => {
    const a = cfg('a', { model: 'a-m', models: Array.from({ length: 30 }, (_, index) => (index === 0 ? 'a-m' : `a-extra-${index}`)) })
    const providers = [a, cfg('b')]
    // 30 models is a catalog, so nothing is tried without ticks; with ticks, exactly the ticked ones.
    expect(ids(buildFallbackChain({ providers }, { current: a, hasCredentials, create }))).toEqual(['b::b-model'])
    const ticked = buildFallbackChain({ providers, fallbackModels: { a: ['a-m', 'a-extra-7', 'a-extra-2'] } }, { current: a, hasCredentials, create })
    expect(ids(ticked)).toEqual(['a::a-extra-2', 'a::a-extra-7', 'b::b-model'])
  })

  it('reserveModels: the one reading used by the screen and the chain', () => {
    const provider = { model: 'main', models: ['a', 'main', 'b', 'c'] }
    expect(reserveModels(provider)).toEqual(['main'])
    expect(reserveModels(provider, [])).toEqual([])
    // A ticked name the provider's list no longer has (a retired model) is left out: the screen has no box to untick it.
    expect(reserveModels(provider, ['c', 'a', 'main', 'retired-model', ' b '])).toEqual(['main', 'a', 'b', 'c'])
    expect(reserveModels({ model: '', models: [] })).toEqual([])
  })

  it('probeTcp answers whether anything is listening', async () => {
    const server = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    expect(await probeTcp(`http://127.0.0.1:${port}/v1`)).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await probeTcp(`http://127.0.0.1:${port}/v1`)).toBe(false)
  })
})

describe('provider health', () => {
  it('an account-level failure marks the whole provider, a per-model one only that model', () => {
    const health = new ProviderHealth(() => 5_000)
    health.mark({ id: 'deepseek', model: 'flash' }, 'quota')
    health.mark({ id: 'openrouter', model: 'a' }, 'rate_limit')
    expect(health.unavailable({ id: 'deepseek', model: 'anything' })?.kind).toBe('quota')
    expect(health.unavailable({ id: 'openrouter', model: 'a' })?.kind).toBe('rate_limit')
    expect(health.unavailable({ id: 'openrouter', model: 'b' })).toBeUndefined()
    expect(isAccountLevelKind('auth')).toBe(true)
    expect(isAccountLevelKind('overloaded')).toBe(false)
    expect(health.statusOf('deepseek')?.kind).toBe('quota')
  })

  it('the limit of Ollama\'s cloud models does not mark the models that run on the machine', () => {
    const health = new ProviderHealth(() => 1_000)
    const cloud = { id: 'ollama', model: 'gemma4:31b-cloud', baseUrl: 'http://127.0.0.1:11434/v1' }
    health.mark(cloud, 'quota')
    expect(health.unavailable({ id: 'ollama', model: 'kimi-k3:cloud', baseUrl: cloud.baseUrl })?.kind).toBe('quota')
    expect(health.unavailable({ id: 'ollama', model: 'qwen3.5:4b', baseUrl: cloud.baseUrl })).toBeUndefined()
    expect(health.statusOf('ollama')).toMatchObject({ kind: 'quota', cloud: true })
    expect(accountKeyOf(cloud)).toBe('ollama:cloud')
    expect(accountKeyOf({ id: 'ollama', model: 'qwen3.5:4b', baseUrl: cloud.baseUrl })).toBe('ollama')
    // A remote provider whose model happens to end in ":cloud" is still one account.
    expect(accountKeyOf({ id: 'x', model: 'm:cloud', baseUrl: 'https://x.example/v1' })).toBe('x')
  })

  it('forgets a failure when the cooldown ends, or when the user fixes something', () => {
    let now = 0
    const health = new ProviderHealth(() => now)
    health.mark({ id: 'a', model: 'm' }, 'rate_limit')
    expect(health.unavailable({ id: 'a', model: 'm' })).toBeDefined()
    now = cooldownMs('rate_limit') + 1
    expect(health.unavailable({ id: 'a', model: 'm' })).toBeUndefined()
    expect(health.list()).toHaveLength(0)

    health.mark({ id: 'a', model: 'm' }, 'quota')
    health.mark({ id: 'b', model: 'm' }, 'auth')
    health.clear('a')
    expect(health.unavailable({ id: 'a', model: 'm' })).toBeUndefined()
    expect(health.unavailable({ id: 'b', model: 'm' })).toBeDefined()
    health.clear()
    expect(health.list()).toHaveLength(0)
  })
})

describe('reserve helpers', () => {
  it('orders the providers the user listed first and keeps the rest as listed', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderedProviders(list, ['c', 'zzz', 'c']).map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(orderedProviders(list).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('a provider needs tools and a model to take over a task', () => {
    expect(canJoinReserve({ model: 'x', supportsTools: true })).toBe(true)
    expect(canJoinReserve({ model: 'x', supportsTools: false })).toBe(false)
    expect(canJoinReserve({ model: ' ', supportsTools: true })).toBe(false)
  })

  it('the per-model list of vision models wins over the provider flag', () => {
    expect(modelSeesImages({ model: 'text-only', supportsVision: true, visionModels: ['gemini'] })).toBe(false)
    expect(modelSeesImages({ model: 'gemini', supportsVision: false, visionModels: ['gemini'] })).toBe(true)
    expect(modelSeesImages({ model: 'whatever', supportsVision: true })).toBe(true)
    expect(modelSeesImages({ model: 'whatever', supportsVision: false })).toBe(false)
  })
})
