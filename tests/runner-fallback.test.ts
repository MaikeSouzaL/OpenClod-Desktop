import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider, type MockTurn } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { toOpenAIMessages } from '../src/core/providers/openai'
import { ProviderHealth } from '../src/core/providers/health'
import type { FallbackCandidate } from '../src/core/providers/chain'
import { DEFAULT_LIMITS, type HarnessEvent, type ImagePart, type Message, type ProviderConfig } from '../src/shared/types'
import type { ToolDef } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

/**
 * "Never stop for lack of credit": when the provider of the session runs out of balance, hits its limit, refuses the
 * key or goes down, the conversation moves to the next provider that works, the user is told in the conversation, and
 * the next turns stay on the one that works. Plus the vision relay: a model that cannot read images gets a description
 * written by one that can.
 */
let cwd: string
beforeEach(async () => {
  cwd = await makeTempDir('openclod-fallback-')
})
afterEach(async () => removeTempDir(cwd))

function cfg(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id, kind: 'openai', label: id.toUpperCase(), baseUrl: 'http://localhost:0/v1', model: `${id}-m`, contextWindow: 128_000, supportsVision: false, supportsTools: true, ...over }
}

function candidate(provider: ScriptedProvider, id: string, over: Partial<ProviderConfig> = {}, extra: Partial<FallbackCandidate> = {}): FallbackCandidate {
  return { provider, config: cfg(id, over), ...extra }
}

class TextOnly extends ScriptedProvider {
  readonly supportsVision = false
}

const shotTool = (image: ImagePart): ToolDef => ({
  name: 'read_file',
  description: 'fake tool that returns a screenshot',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: () => ({ title: 'Ler', detail: '' }),
  async execute() {
    return { ok: true, text: 'captura feita', summary: 'captura', images: [image] }
  }
})

function build(
  primary: ScriptedProvider,
  fallback: FallbackCandidate[],
  over: Partial<RunnerDeps> = {},
  tools: ToolDef[] = []
): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_chain',
    cwd,
    mode: 'code',
    provider: primary,
    providerConfig: cfg('a'),
    registry: buildRegistry(...tools),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 6 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] },
      projectMemory: {
        listPages: async () => [],
        listHandoffs: async () => [],
        map: async () => ({ text: '', pages: 0, durable: 0, openHandoffs: 0 }),
        openWork: async () => []
      }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    retryBaseMs: 0,
    fallback,
    ...over
  }
  return { runner: new SessionRunner(deps), events }
}

const quota: MockTurn = { error: 'HTTP 402: Insufficient Balance', errorKind: 'quota' }
const text = (message: Message): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')

describe('the session moves to a provider that works', () => {
  it('leaves the provider that ran out of credit for ANOTHER provider, tells the user in the conversation, and stays there', async () => {
    const a = new ScriptedProvider([quota])
    const b = new ScriptedProvider([{ text: 'resposta do B' }, { text: 'segunda resposta do B' }])
    const { runner, events } = build(a, [candidate(b, 'b')])

    await runner.send('faça isso')

    expect(runner.state).toBe('done')
    expect(text(runner.messages.at(-1)!)).toBe('resposta do B')
    // The event the main process turns into the session's provider/model (and the composer into its picker).
    const change = events.find((event): event is Extract<HarnessEvent, { type: 'model_switch' }> => event.type === 'model_switch')
    expect(change).toMatchObject({ from: { providerId: 'a', model: 'a-m' }, to: { providerId: 'b', label: 'B', model: 'b-m' }, reason: 'quota' })
    // A line IN the conversation (not only a toast), saved with the history.
    const note = runner.messages.find((message) => message.role === 'system')
    expect(note?.notice).toEqual({ kind: 'model_switch', level: 'warn' })
    expect(text(note!)).toContain('A/a-m')
    expect(text(note!)).toContain('B/b-m')
    expect(text(note!)).toContain('sem saldo')
    // The note is for the user: no provider ever turns it into something a model reads.
    expect(JSON.stringify(toOpenAIMessages('', b.requests[0].messages))).not.toContain('continuando com')

    // The next turn goes straight to B: the exhausted provider is not asked again.
    await runner.send('mais uma')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(2)
    expect(text(runner.messages.at(-1)!)).toBe('segunda resposta do B')
  })

  it('keeps the whole conversation: the new model receives the user message and the earlier history', async () => {
    const a = new ScriptedProvider([{ text: 'primeira' }, quota])
    const b = new ScriptedProvider([{ text: 'continuei' }])
    const { runner } = build(a, [candidate(b, 'b')])
    await runner.send('pedido 1')
    await runner.send('pedido 2')
    const seen = b.requests[0].messages.filter((message) => message.role === 'user' && !message.hidden).map(text)
    expect(seen).toEqual(['pedido 1', 'pedido 2'])
    expect(b.requests[0].messages.some((message) => message.role === 'assistant' && text(message) === 'primeira')).toBe(true)
  })

  it('skips the other models of the same provider after "no balance" (the account is the problem), not after a rate limit', async () => {
    const sameProvider = new ScriptedProvider([{ text: 'não deveria responder' }])
    const other = new ScriptedProvider([{ text: 'respondeu o outro provedor' }])
    const afterQuota = build(new ScriptedProvider([quota]), [candidate(sameProvider, 'a', { model: 'a-pro' }), candidate(other, 'b')])
    await afterQuota.runner.send('oi')
    expect(sameProvider.requests).toHaveLength(0)
    expect(text(afterQuota.runner.messages.at(-1)!)).toBe('respondeu o outro provedor')

    const sibling = new ScriptedProvider([{ text: 'o irmão respondeu' }])
    const afterLimit = build(new ScriptedProvider([{ error: '429 slow down', errorKind: 'rate_limit' }]), [candidate(sibling, 'a', { model: 'a-pro' }), candidate(new ScriptedProvider([]), 'b')])
    await afterLimit.runner.send('oi')
    expect(text(afterLimit.runner.messages.at(-1)!)).toBe('o irmão respondeu')
  })

  it('after the monthly limit of an Ollama CLOUD model, the local model of the same server takes over (it is not the same account)', async () => {
    const cloud = new ScriptedProvider([{ error: 'you have reached your monthly usage limit', errorKind: 'quota' }])
    const local = new ScriptedProvider([{ text: 'respondeu o modelo local' }])
    const ollama = { baseUrl: 'http://127.0.0.1:11434/v1' }
    const { runner } = build(cloud, [candidate(local, 'ollama', { ...ollama, model: 'qwen3.5:4b' })], {
      providerConfig: cfg('ollama', { ...ollama, model: 'gemma4:31b-cloud' })
    })
    await runner.send('oi')
    expect(text(runner.messages.at(-1)!)).toBe('respondeu o modelo local')

    // The same server's other CLOUD model would hit the same limit: skipped.
    const sibling = new ScriptedProvider([{ text: 'não deveria responder' }])
    const second = build(new ScriptedProvider([quota]), [candidate(sibling, 'ollama', { ...ollama, model: 'kimi-k3:cloud' }), candidate(new ScriptedProvider([{ text: 'respondeu o outro' }]), 'b')], {
      providerConfig: cfg('ollama', { ...ollama, model: 'gemma4:31b-cloud' }),
      sessionId: 'ses_cloud'
    })
    await second.runner.send('oi')
    expect(sibling.requests).toHaveLength(0)
    expect(text(second.runner.messages.at(-1)!)).toBe('respondeu o outro')
  })

  it('does not wait out a rate limit when another provider is ready, and asks the first one to fail fast', async () => {
    const a = new ScriptedProvider([{ error: '429 too many requests', errorKind: 'rate_limit' }])
    const b = new ScriptedProvider([{ text: 'ok pelo B' }])
    const { runner } = build(a, [candidate(b, 'b')])
    await runner.send('oi')
    expect(a.requests).toHaveLength(1) // no retry of the limited provider
    expect(a.requests[0].fastFail).toBe(true)
    expect(text(runner.messages.at(-1)!)).toBe('ok pelo B')

    // Without a reserve the old patience stays: the same provider is retried before the turn gives up.
    const alone = new ScriptedProvider([{ error: '429', errorKind: 'rate_limit' }, { error: '429', errorKind: 'rate_limit' }, { text: 'passou' }])
    const lone = build(alone, [])
    await lone.runner.send('oi')
    expect(alone.requests).toHaveLength(3)
    expect(alone.requests[0].fastFail).toBe(false)
    expect(lone.runner.state).toBe('done')
  })

  it('teaches the shared health registry, and the next session skips what is known to be down', async () => {
    const health = new ProviderHealth()
    const a = new ScriptedProvider([{ error: '401 invalid api key', errorKind: 'auth' }])
    const b = new ScriptedProvider([{ text: 'B' }])
    await build(a, [candidate(b, 'b')], { health }).runner.send('oi')
    expect(health.unavailable({ id: 'a', model: 'a-m' })?.kind).toBe('auth')

    // Another session: its reserve lists the provider known to be down first; the healthy one answers.
    const down = new ScriptedProvider([{ text: 'não deveria responder' }])
    const up = new ScriptedProvider([{ text: 'respondeu quem funciona' }])
    health.mark({ id: 'down', model: 'down-m' }, 'quota')
    const second = build(new ScriptedProvider([quota]), [candidate(down, 'down'), candidate(up, 'up')], { health, sessionId: 'ses_2' })
    await second.runner.send('oi')
    expect(down.requests).toHaveLength(0)
    expect(text(second.runner.messages.at(-1)!)).toBe('respondeu quem funciona')
  })

  it('does not remember a hiccup that one retry cured (a new session is not sent away from a provider that works)', async () => {
    const health = new ProviderHealth()
    const a = new ScriptedProvider([{ error: '500 oops', errorKind: 'server' }, { text: 'voltou ao normal' }])
    const { runner } = build(a, [candidate(new ScriptedProvider([]), 'b')], { health })
    await runner.send('oi')
    expect(text(runner.messages.at(-1)!)).toBe('voltou ao normal')
    expect(a.requests).toHaveLength(2)
    expect(health.list()).toHaveLength(0)
  })

  it('still tries what is marked as down when nothing else is left (a stale mark never stops the work)', async () => {
    const health = new ProviderHealth()
    health.mark({ id: 'b', model: 'b-m' }, 'quota')
    const b = new ScriptedProvider([{ text: 'voltou a funcionar' }])
    // The provider in use keeps failing; the only reserve is marked: it is still the one that gets the conversation.
    const failing = new ScriptedProvider([{ error: '503', errorKind: 'overloaded' }, { error: '503', errorKind: 'overloaded' }, { error: '503', errorKind: 'overloaded' }])
    const { runner } = build(failing, [candidate(b, 'b')], { health })
    await runner.send('oi')
    expect(text(runner.messages.at(-1)!)).toBe('voltou a funcionar')
  })

  it('passes over a local server that is not running without spending a request on it', async () => {
    const health = new ProviderHealth()
    const local = new ScriptedProvider([{ text: 'não deveria responder' }])
    const remote = new ScriptedProvider([{ text: 'respondeu o remoto' }])
    const { runner, events } = build(new ScriptedProvider([quota]), [candidate(local, 'ollama', {}, { probe: async () => false }), candidate(remote, 'b')], { health })
    await runner.send('oi')
    expect(local.requests).toHaveLength(0)
    expect(health.unavailable({ id: 'ollama', model: 'ollama-m' })?.kind).toBe('network')
    expect(text(runner.messages.at(-1)!)).toBe('respondeu o remoto')
    expect(events.filter((event) => event.type === 'model_switch')).toHaveLength(1)
  })

  it('walks the whole chain: the second provider fails too, the third answers, and the user is told twice', async () => {
    const b = new ScriptedProvider([{ error: '401 bad key', errorKind: 'auth' }])
    const c = new ScriptedProvider([{ text: 'respondeu o terceiro' }])
    const { runner, events } = build(new ScriptedProvider([quota]), [candidate(b, 'b'), candidate(c, 'c')])
    await runner.send('oi')
    expect(runner.state).toBe('done')
    const switches = events.filter((event): event is Extract<HarnessEvent, { type: 'model_switch' }> => event.type === 'model_switch')
    expect(switches.map((change) => `${change.from.providerId}>${change.to.providerId}:${change.reason}`)).toEqual(['a>b:quota', 'b>c:auth'])
    expect(runner.messages.filter((message) => message.role === 'system')).toHaveLength(2)
  })

  it('ends with the real error only when nobody in the chain can answer', async () => {
    const { runner } = build(new ScriptedProvider([quota]), [candidate(new ScriptedProvider([{ error: '401 bad key', errorKind: 'auth' }]), 'b')])
    await runner.send('oi')
    expect(runner.state).toBe('error')
    expect(runner.messages.find((message) => message.role === 'assistant' && message.error)?.error).toContain('401')
  })
})

describe('failures in the middle of an answer and context windows', () => {
  it('a rate limit that cuts an answer in half keeps the half on screen, and the next model is told to continue it', async () => {
    const a = new ScriptedProvider([{ text: 'A conclusão é que', error: 'stream error: rate limit', errorKind: 'rate_limit' }])
    const b = new ScriptedProvider([{ text: ' o teste passa.' }])
    const { runner } = build(a, [candidate(b, 'b')])
    await runner.send('conclua')
    expect(runner.state).toBe('done')
    const kept = runner.messages.find((message) => message.role === 'assistant' && text(message) === 'A conclusão é que')
    expect(kept).toBeTruthy()
    const seen = b.requests[0].messages
    expect(seen.findIndex((message) => text(message) === 'A conclusão é que')).toBeGreaterThan(-1)
    expect(seen.at(-1)?.hidden).toBe(true)
    expect(text(seen.at(-1)!)).toContain('Continue exatamente de onde ela parou')
    // The half answer is not marked as a failure: it is part of the conversation.
    expect(kept?.error).toBeUndefined()
  })

  it('a context overflow that compaction cannot fix goes to a model with a BIGGER window, never a smaller one', async () => {
    const a = new ScriptedProvider([{ error: 'context_length_exceeded', errorKind: 'context_overflow' }])
    const small = new ScriptedProvider([{ text: 'não deveria responder' }])
    const big = new ScriptedProvider([{ text: 'coube na janela maior' }])
    const { runner, events } = build(a, [candidate(small, 'small', { contextWindow: 16_000 }), candidate(big, 'big', { contextWindow: 1_000_000 })], {
      providerConfig: cfg('a', { contextWindow: 32_000 })
    })
    await runner.send('um pedido enorme')
    expect(small.requests).toHaveLength(0)
    expect(text(runner.messages.at(-1)!)).toBe('coube na janela maior')
    expect(events.find((event) => event.type === 'model_switch')).toMatchObject({ reason: 'context_overflow', to: { providerId: 'big' } })
  })

  it('a context overflow with no bigger model left still ends with the error, not a loop', async () => {
    const a = new ScriptedProvider([{ error: 'context_length_exceeded', errorKind: 'context_overflow' }])
    const { runner } = build(a, [candidate(new ScriptedProvider([]), 'same-size', { contextWindow: 128_000 })])
    await runner.send('um pedido enorme')
    expect(runner.state).toBe('error')
  })
})

describe('the vision relay: a model that cannot read images gets a description', () => {
  const PICTURE_DATA = 'UElDVFVSRS1CWVRFUw=='
  const picture: ImagePart = { type: 'image', mediaType: 'image/png', data: PICTURE_DATA, label: 'tela.png' }
  const eyes = (config: ProviderConfig = cfg('olhos', { supportsVision: true })): { provider: ScriptedProvider; config: ProviderConfig } => ({
    provider: new ScriptedProvider([{ text: 'Tela de login: título "Entrar", campo de e-mail e um botão azul "ENTRAR".' }]),
    config
  })

  it('describes the user\'s picture once with a model that can see; the text-only model never receives the picture', async () => {
    const active = new TextOnly([{ text: 'Entendi a tela.' }, { text: 'Segunda resposta.' }])
    const seeing = eyes()
    const { runner, events } = build(active, [], { vision: { candidates: () => [seeing] } })

    await runner.send('o que tem na imagem?', { images: [picture] })

    expect(seeing.provider.requests).toHaveLength(1)
    expect(seeing.provider.requests[0].messages[0].parts.some((part) => part.type === 'image')).toBe(true)
    const sent = JSON.stringify(active.requests[0].messages)
    expect(sent).not.toContain(picture.data) // no picture bytes
    expect(sent).toContain('botão azul')
    expect(sent).toContain('OLHOS/olhos-m') // who wrote the description
    expect(events.some((event) => event.type === 'notice' && event.text.includes('não lê imagens'))).toBe(true)

    // The description lives on the picture: the next request does not pay for it again.
    await runner.send('e agora?')
    expect(seeing.provider.requests).toHaveLength(1)
    expect(JSON.stringify(active.requests[1].messages)).toContain('botão azul')
  })

  it('describes a screenshot returned by a tool, and keeps the description after the picture is gone', async () => {
    const shot: ImagePart = { type: 'image', mediaType: 'image/png', data: 'U0NSRUVOU0hPVA==', label: 'captura' }
    const active = new TextOnly([
      { toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'x' } }] },
      { text: 'Vi o botão.' }
    ])
    const seeing = eyes()
    const { runner } = build(active, [], { vision: { candidates: () => [seeing] } }, [shotTool(shot)])
    await runner.send('tire uma captura')

    const second = JSON.stringify(active.requests[1].messages)
    expect(second).not.toContain(shot.data)
    expect(second).toContain('botão azul')
    // What is stored with the session keeps the description (the picture bytes are not stored).
    const result = runner.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool_result')
    expect(result && result.type === 'tool_result' ? result.imageDescriptions?.[0] : '').toContain('botão azul')

    // A new runner over the stored history (pictures stripped, as the app saves it) still tells the model what was there.
    const stored: Message[] = runner.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => (part.type === 'tool_result' ? { ...part, images: undefined } : part))
    }))
    const reloaded = new TextOnly([{ text: 'Lembro do botão.' }])
    const again = build(reloaded, [], { initial: { messages: stored }, sessionId: 'ses_reloaded' })
    await again.runner.send('o que você viu?')
    expect(JSON.stringify(reloaded.requests[0].messages)).toContain('botão azul')
  })

  it('a model that CAN read images still receives the picture itself, and the relay is not called', async () => {
    const active = new ScriptedProvider([{ text: 'Vi a imagem.' }])
    const seeing = eyes()
    const { runner } = build(active, [], { vision: { candidates: () => [seeing] } })
    await runner.send('olhe', { images: [picture] })
    expect(seeing.provider.requests).toHaveLength(0)
    expect(JSON.stringify(active.requests[0].messages)).toContain(picture.data)
  })

  it('tries the next model with vision when the first fails, and rests after every one failed', async () => {
    const active = new TextOnly([{ text: 'a' }, { text: 'b' }])
    const broken = { provider: new ScriptedProvider([{ error: '402 no balance', errorKind: 'quota' }]), config: cfg('quebrado', { supportsVision: true }) }
    const backup = eyes(cfg('reserva-visao', { supportsVision: true }))
    const first = build(active, [], { vision: { candidates: () => [broken, backup] } })
    await first.runner.send('veja', { images: [picture] })
    expect(broken.provider.requests).toHaveLength(1)
    expect(JSON.stringify(active.requests[0].messages)).toContain('botão azul')

    const text2 = new TextOnly([{ text: 'x' }, { text: 'y' }])
    const dead = { provider: new ScriptedProvider([{ error: '401', errorKind: 'auth' }, { error: '401', errorKind: 'auth' }]), config: cfg('morto', { supportsVision: true }) }
    const second = build(text2, [], { vision: { candidates: () => [dead] }, sessionId: 'ses_dead' })
    await second.runner.send('veja', { images: [picture] })
    await second.runner.send('veja de novo')
    expect(dead.provider.requests).toHaveLength(1) // the relay rested instead of failing again at every request
    expect(JSON.stringify(text2.requests[0].messages)).not.toContain(picture.data)
    expect(JSON.stringify(text2.requests[0].messages)).toContain('nenhum modelo com visão')
    expect(second.events.some((event) => event.type === 'notice' && event.level === 'warn' && event.text.includes('Nenhum modelo com visão'))).toBe(true)
  })
})

/**
 * Every picture is shown in the chat with whether the model really saw it: the runner writes where each one went on
 * the stored picture (`delivery`), and pictures meant for the user only (`preview`) never reach a model.
 */
describe('the chat can tell whether the model saw a picture', () => {
  const picture: ImagePart = { type: 'image', mediaType: 'image/png', data: 'VVNFUi1QSUNUVVJF', label: 'tela.png' }
  const shot: ImagePart = { type: 'image', mediaType: 'image/png', data: 'VE9PTC1TSE9U', label: 'captura' }
  const page: ImagePart = { type: 'image', mediaType: 'image/jpeg', data: 'UERGLVBBR0U=', label: 'página 1' }
  const ocrTool: ToolDef = {
    name: 'document_extract',
    description: 'fake document reader that only shows the page to the user',
    schema: z.object({ path: z.string() }),
    risk: 'read',
    parallelSafe: true,
    describe: () => ({ title: 'Ler documentos', detail: '' }),
    async execute() {
      return { ok: true, text: 'Texto extraído da página 1', summary: '1 página', preview: [page] }
    }
  }
  const seeingModel = (): { provider: ScriptedProvider; config: ProviderConfig } => ({
    provider: new ScriptedProvider([{ text: 'Uma tela com um botão.' }, { text: 'Outra tela.' }]),
    config: cfg('olhos', { supportsVision: true })
  })
  const stored = (runner: SessionRunner): { user: ImagePart[]; tool: ImagePart[] } => {
    const parts = runner.messages.flatMap((message) => message.parts)
    return {
      user: parts.filter((part): part is ImagePart => part.type === 'image'),
      tool: parts.flatMap((part) => (part.type === 'tool_result' ? (part.images ?? []) : []))
    }
  }
  const turn = (): MockTurn[] => [{ toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'x' } }] }, { text: 'feito' }]

  it("a model with vision: the user's picture and the screenshot are marked as received", async () => {
    const { runner } = build(new ScriptedProvider(turn()), [], {}, [shotTool(shot)])
    await runner.send('olhe', { images: [picture] })
    const { user, tool } = stored(runner)
    expect(user.map((image) => image.delivery)).toEqual(['model'])
    expect(tool.map((image) => image.delivery)).toEqual(['model'])
    expect(picture.delivery).toBeUndefined() // the caller's object is untouched
  })

  it('a text-only model with a relay: marked as relayed, and the description is on the picture', async () => {
    const { runner, events } = build(new TextOnly(turn()), [], { vision: { candidates: () => [seeingModel()] } }, [shotTool(shot)])
    await runner.send('olhe', { images: [picture] })
    const { user, tool } = stored(runner)
    expect(user[0]).toMatchObject({ delivery: 'relay', describedBy: 'OLHOS/olhos-m' })
    expect(user[0].description).toBeTruthy()
    expect(tool[0].delivery).toBe('relay')
    // The chat keeps its own copy of each message: once described, the message is sent again so the seal can say so.
    const userMessage = runner.messages.find((message) => message.role === 'user' && !message.hidden)!
    const sent = events.filter((event) => event.type === 'message' && event.message.id === userMessage.id)
    expect(sent).toHaveLength(2)
  })

  it('a text-only model and nobody to describe: marked as NOT seen', async () => {
    const { runner } = build(new TextOnly(turn()), [], {}, [shotTool(shot)])
    await runner.send('olhe', { images: [picture] })
    const { user, tool } = stored(runner)
    expect(user[0].delivery).toBe('none')
    expect(tool[0].delivery).toBe('none')
  })

  it('the contact sheets of an attached video are kept (marked as received) only for a model with vision', async () => {
    const prepare = async (): Promise<{ text: string; images: ImagePart[] }> => ({
      text: '<midia>transcrição</midia>',
      images: [{ ...shot, label: 'folha 1' }]
    })
    const seeing = build(new ScriptedProvider([{ text: 'ok' }]), [])
    await seeing.runner.send('veja o vídeo', { prepare })
    const hidden = seeing.runner.messages.find((message) => message.hidden && message.parts.some((part) => part.type === 'image'))
    expect(hidden?.parts.find((part) => part.type === 'image')).toMatchObject({ delivery: 'model', label: 'folha 1' })

    const blind = build(new TextOnly([{ text: 'ok' }]), [], { sessionId: 'ses_blind' })
    await blind.runner.send('veja o vídeo', { prepare })
    expect(blind.runner.messages.some((message) => message.parts.some((part) => part.type === 'image'))).toBe(false)
  })

  it('a preview is stored for the chat and never sent, even to a model with vision', async () => {
    const active = new ScriptedProvider([{ toolCalls: [{ id: 'call_1', name: 'document_extract', args: { path: 'a.pdf' } }] }, { text: 'li' }])
    const { runner } = build(active, [], {}, [ocrTool])
    await runner.send('leia o pdf')
    const result = runner.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool_result')
    expect(result && result.type === 'tool_result' ? result.preview : undefined).toEqual([page])
    const sent = JSON.stringify(active.requests[1].messages)
    expect(sent).toContain('Texto extraído da página 1')
    expect(sent).not.toContain(page.data)
    expect(JSON.stringify(toOpenAIMessages('', runner.messages, false, false, true))).not.toContain(page.data)
  })
})
