import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { OpenAICompatibleProvider } from '../src/core/providers/openai'
import { buildFallbackChain, type FallbackCandidate } from '../src/core/providers/chain'
import { ProviderHealth } from '../src/core/providers/health'
import { ProviderReserve } from '../src/main/reserve'
import { DEFAULT_LIMITS, type AppSettings, type HarnessEvent, type Message, type ProviderConfig } from '../src/shared/types'
import { ScriptedProvider } from './support/scripted-provider'
import { startFakeColab, type FakeColab } from './support/fake-colab'
import { makeTempDir, policy, removeTempDir } from './helpers'

/**
 * "If Colab falls (the session ends, the tunnel drops, the quota runs out), the harness goes on by itself to the next provider."
 * The Colab side here is a REAL OpenAICompatibleProvider talking HTTP to a server that answers with the real Cloudflare pages
 * when the tunnel is gone; only the provider that takes over is the unit-test double.
 */
let cwd: string
let colab: FakeColab

beforeEach(async () => {
  cwd = await makeTempDir('openclod-colab-reserve-')
  colab = await startFakeColab()
})
afterEach(async () => {
  await colab.close()
  await removeTempDir(cwd)
})

function colabConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'colab',
    kind: 'openai',
    label: 'Google Colab (GPU)',
    baseUrl: colab.baseUrl,
    model: colab.model,
    apiKeyRef: colab.key,
    contextWindow: 65536,
    supportsVision: true,
    supportsTools: true,
    models: [colab.model],
    colab: { host: new URL(colab.origin).host, gpu: 'Tesla T4 (15 GB)', notebookVersion: '1.0.0', connectedAt: Date.now() },
    ...over
  }
}

function otherConfig(id: string): ProviderConfig {
  return { id, kind: 'openai', label: id.toUpperCase(), baseUrl: `https://${id}.example.com/v1`, model: `${id}-m`, apiKeyRef: `${id}-chave-de-teste`, contextWindow: 128_000, supportsVision: false, supportsTools: true }
}

function build(
  primary: { provider: OpenAICompatibleProvider | ScriptedProvider; config: ProviderConfig },
  fallback: FallbackCandidate[]
): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_colab',
    cwd,
    mode: 'code',
    provider: primary.provider,
    providerConfig: primary.config,
    registry: buildRegistry(),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 6 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] },
      projectMemory: { listPages: async () => [], listHandoffs: async () => [], map: async () => ({ text: '', pages: 0, durable: 0, openHandoffs: 0 }), openWork: async () => [] }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    retryBaseMs: 0,
    fallback
  }
  return { runner: new SessionRunner(deps), events }
}

const text = (message: Message): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
const chatPosts = (): number => colab.requests.filter((request) => request.method === 'POST' && request.path === '/v1/chat/completions').length

describe('Colab falls: the reserve takes over by itself', () => {
  it('the session\'s own Colab server answers while it is alive', async () => {
    const { runner } = build({ provider: new OpenAICompatibleProvider(colabConfig(), colab.key), config: colabConfig() }, [])
    await runner.send('oi')
    expect(text(runner.messages.at(-1)!)).toBe('pong')
    expect(chatPosts()).toBe(1)
  })

  it.each([
    ['the tunnel process is gone (real HTTP 530 "Error 1033" page)', 'tunnel-down' as const],
    ['the tunnel is up but the notebook stopped (real HTTP 502 "Bad gateway" page)', 'origin-down' as const]
  ])('%s: moves to the next provider at once, says why in the conversation, and stays there', async (_label, mode) => {
    colab.mode = mode
    const next = new ScriptedProvider([{ text: 'resposta do reserva' }, { text: 'segunda do reserva' }])
    const { runner, events } = build(
      { provider: new OpenAICompatibleProvider(colabConfig(), colab.key), config: colabConfig() },
      [{ provider: next, config: otherConfig('b') }]
    )
    const started = Date.now()
    await runner.send('faça isso')

    expect(runner.state).toBe('done')
    expect(text(runner.messages.at(-1)!)).toBe('resposta do reserva')
    // No five retries with growing waits against a server that is not there: the hand-over takes well under the old 15 s of backoff.
    expect(Date.now() - started).toBeLessThan(5000)
    expect(chatPosts()).toBeLessThanOrEqual(2)
    const change = events.find((event): event is Extract<HarnessEvent, { type: 'model_switch' }> => event.type === 'model_switch')
    expect(change).toMatchObject({ from: { providerId: 'colab' }, to: { providerId: 'b' }, reason: 'network' })
    const note = runner.messages.find((message) => message.role === 'system')
    expect(text(note!)).toContain('Google Colab (GPU)')
    expect(text(note!)).toContain('sem conexão')
    // The next turn does not ask the dead tunnel again.
    const before = colab.requests.length
    await runner.send('mais uma')
    expect(text(runner.messages.at(-1)!)).toBe('segunda do reserva')
    expect(colab.requests.length).toBe(before)
  })

  it('the tunnel drops in the MIDDLE of a conversation: the second turn is answered by the reserve with the whole history', async () => {
    const next = new ScriptedProvider([{ text: 'continuei no reserva' }])
    const { runner } = build(
      { provider: new OpenAICompatibleProvider(colabConfig(), colab.key), config: colabConfig() },
      [{ provider: next, config: otherConfig('b') }]
    )
    await runner.send('primeiro pedido')
    expect(text(runner.messages.at(-1)!)).toBe('pong')
    colab.mode = 'tunnel-down'
    await runner.send('segundo pedido')
    expect(text(runner.messages.at(-1)!)).toBe('continuei no reserva')
    const seen = next.requests[0].messages.filter((message) => message.role === 'user' && !message.hidden).map(text)
    expect(seen).toEqual(['primeiro pedido', 'segundo pedido'])
  })

  it('a server that stops answering altogether (session frozen) is not waited for 5 minutes when a reserve exists', async () => {
    // The probe the reserve attaches to a Colab candidate: a dead one is skipped without sending the conversation to it.
    colab.mode = 'hang'
    const next = new ScriptedProvider([{ text: 'resposta do segundo' }])
    const never = new ScriptedProvider([])
    const failing = new ScriptedProvider([{ error: 'HTTP 402: Insufficient Balance', errorKind: 'quota' }])
    const settings = { providers: [otherConfig('a'), colabConfig({ apiKeyRef: colab.key }), otherConfig('b')], useAllModels: true, fallbackOrder: ['colab', 'b'] } as unknown as AppSettings
    const reserve = new ProviderReserve({ settings: () => settings, resolver: () => ({ get: () => undefined }) })
    const chain = reserve.chainFor(otherConfig('a'))
    const colabCandidate = chain.find((candidate) => candidate.config.id === 'colab')!
    expect(colabCandidate.probe).toBeTypeOf('function')
    // 'hang' makes the probe wait its 2.5 s and give up: that is the cost of a dead tunnel, paid once and not per request.
    const started = Date.now()
    expect(await colabCandidate.probe!()).toBe(false)
    expect(Date.now() - started).toBeLessThan(4500)
    expect(reserve.health.unavailable(colabCandidate.config)).toMatchObject({ kind: 'network' })

    const { runner } = build(
      { provider: failing, config: otherConfig('a') },
      [{ provider: never, config: colabConfig(), probe: colabCandidate.probe }, { provider: next, config: otherConfig('b') }]
    )
    await runner.send('oi')
    expect(text(runner.messages.at(-1)!)).toBe('resposta do segundo')
    expect(never.requests).toHaveLength(0)
  }, 15_000)
})

describe('the chain knows how to tell a live Colab from a dead one', () => {
  const settings = (): AppSettings =>
    ({ providers: [otherConfig('a'), colabConfig(), otherConfig('b')], useAllModels: true, fallbackOrder: ['colab', 'b'] }) as unknown as AppSettings

  it('gives only the Colab candidate a probe (the others have none because they are not local)', () => {
    const reserve = new ProviderReserve({ settings, resolver: () => ({ get: () => undefined }) })
    const chain = reserve.chainFor(otherConfig('a'))
    expect(chain.map((candidate) => [candidate.config.id, typeof candidate.probe])).toEqual([['colab', 'function'], ['b', 'undefined']])
  })

  it('the probe says yes while the server answers and marks the failure when it does not', async () => {
    const reserve = new ProviderReserve({ settings, resolver: () => ({ get: () => undefined }) })
    const probe = reserve.chainFor(otherConfig('a'))[0].probe!
    expect(await probe()).toBe(true)
    colab.mode = 'tunnel-down'
    expect(await probe()).toBe(false)
    expect(reserve.health.unavailable(colabConfig())).toMatchObject({ providerId: 'colab', kind: 'network' })
    colab.mode = 'engine-down'
    expect(await probe()).toBe(true) // up but unwell: let the real request report it
  })

  it('a refused key (the notebook restarted) is an auth failure of the whole provider', async () => {
    const wrong = { ...settings(), providers: [otherConfig('a'), colabConfig({ apiKeyRef: 'occ_chave-velha-do-reinicio' }), otherConfig('b')] } as AppSettings
    const reserve = new ProviderReserve({ settings: () => wrong, resolver: () => ({ get: () => undefined }) })
    const probe = reserve.chainFor(otherConfig('a'))[0].probe!
    expect(await probe()).toBe(false)
    expect(reserve.health.unavailable(colabConfig())).toMatchObject({ kind: 'auth' })
  })

  it('buildFallbackChain without a probeFor behaves as before: a remote candidate has no probe, a local one still gets the TCP check', () => {
    const options = { current: otherConfig('a'), hasCredentials: () => true, create: () => new ScriptedProvider([]), health: new ProviderHealth() }
    const remote = buildFallbackChain({ providers: [otherConfig('a'), colabConfig({ baseUrl: 'https://abc.trycloudflare.com/v1' })] }, options)
    expect(remote.map((candidate) => candidate.probe)).toEqual([undefined])
    const local = buildFallbackChain({ providers: [otherConfig('a'), colabConfig()] }, options)
    expect(local.map((candidate) => typeof candidate.probe)).toEqual(['function'])
  })

  it('a Colab provider on this computer (the test mode) is probed with the authenticated request, not just the open port', async () => {
    const reserve = new ProviderReserve({ settings, resolver: () => ({ get: () => undefined }) })
    colab.mode = 'tunnel-down' // the port is open, the notebook is not: only the real request can tell
    expect(await reserve.chainFor(otherConfig('a'))[0].probe!()).toBe(false)
  })
})
