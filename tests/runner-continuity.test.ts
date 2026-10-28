import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS, type Message, type ModelRequest, type ProviderConfig } from '../src/shared/types'
import type { ToolDef } from '../src/core/tools/types'
import { isTurnContext } from '../src/core/agent/turn-context'
import { buildStatePage } from '../src/core/memory/state-page'
import { makeTempDir, policy, removeTempDir } from './helpers'

/**
 * Continuing somebody else's work: a NEW session finds the unfinished work of the previous one, a model that takes over
 * a long conversation starts from a summary instead of reading it all, and a request that names a skill, an agent or a
 * tool gets it suggested. None of it touches the system prompt.
 */
let cwd: string
beforeEach(async () => {
  cwd = await makeTempDir('openclod-continuity-')
})
afterEach(async () => removeTempDir(cwd))

const readTool: ToolDef = {
  name: 'read_file',
  description: 'fake read tool',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: () => ({ title: 'Ler', detail: '' }),
  async execute() {
    return { ok: true, text: 'conteúdo', summary: 'lido' }
  }
}

const capsule = buildStatePage({
  sessionTitle: 'Exportador CSV',
  sessionId: 'ses_antiga',
  sessionSlug: 'sessao-exportador-csv',
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  runState: 'done',
  firstRequest: 'Implemente o parser, o validador e o exportador CSV. Use ponto e vírgula como separador e CRLF.',
  lastRequest: 'Agora o validador.',
  result: 'Validador pronto, 4 testes passando.',
  plan: [
    { id: 'p1', text: 'parser', status: 'done' },
    { id: 'p3', text: 'exportador CSV com ponto e vírgula e CRLF', status: 'pending' }
  ],
  files: ['src/parser.js']
})

function config(model: string, contextWindow = 128_000): ProviderConfig {
  return { id: 'mock', kind: 'openai', label: 'Duplo', baseUrl: 'http://localhost:0/v1', model, contextWindow, supportsVision: false, supportsTools: true }
}

interface Memory {
  openWork?: () => Promise<unknown[]>
  handoffs?: () => Promise<unknown[]>
}

function makeRunner(provider: ScriptedProvider, overrides: Partial<RunnerDeps> = {}, memory: Memory = {}): SessionRunner {
  const deps: RunnerDeps = {
    sessionId: 'ses_nova',
    cwd,
    mode: 'code',
    provider,
    providerConfig: config('duplo'),
    registry: buildRegistry(readTool),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 8 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: {
        list: () => [
          { name: 'svg-master', description: 'Desenha SVG, ícones, logos e ilustrações vetoriais.' },
          { name: 'qa-total', description: 'QA total de qualquer projeto.' }
        ]
      },
      memory: { all: async () => [] },
      projectMemory: {
        listPages: async () => [],
        listHandoffs: memory.handoffs ?? (async () => []),
        map: async () => ({ text: '', pages: 0, durable: 0, openHandoffs: 0 }),
        openWork:
          memory.openWork ??
          (async () => [{ slug: 'estado-exportador-csv', title: capsule.title, updated: new Date().toISOString(), status: capsule.status, next: capsule.next, body: capsule.body }])
      }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async () => true,
    ...overrides
  }
  return new SessionRunner(deps)
}

const text = (message: Message): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
const contextOf = (request: ModelRequest): string => request.messages.filter(isTurnContext).map(text).join('\n')

describe('a new session finds the unfinished work of the previous one', () => {
  it('puts the capsule in front of the model on the first turn, whole enough to continue from', async () => {
    const provider = new ScriptedProvider([{ text: 'Continuando.' }, { text: 'Ok.' }])
    const runner = makeRunner(provider)
    await runner.send('Continue de onde paramos.')
    const context = contextOf(provider.requests[0])
    expect(context).toContain('## Trabalho em aberto de sessões anteriores')
    expect(context).toContain('Estado: Exportador CSV [estado-exportador-csv] — em aberto, atualizada há')
    expect(context).toContain('Objetivo: Implemente o parser')
    expect(context).toContain('ponto e vírgula como separador e CRLF')
    expect(context).toContain('Próximo passo: exportador CSV com ponto e vírgula e CRLF')
    expect(context).toContain('memory_page action=read slug=<slug>')
    // And it is not repeated while it does not change.
    await runner.send('e então?')
    expect(provider.requests[1].messages.filter(isTurnContext)).toHaveLength(1)
  })

  it('says it is the last FINISHED session when nothing is open', async () => {
    const done = buildStatePage({ sessionTitle: 'Antiga', sessionId: 's', sessionSlug: 'sessao-antiga', provider: 'p', model: 'm', runState: 'done', firstRequest: 'faça x', lastRequest: 'x', result: 'feito', plan: [], files: [] })
    const provider = new ScriptedProvider([{ text: 'Ok.' }])
    const runner = makeRunner(provider, {}, { openWork: async () => [{ slug: done.slug, title: done.title, updated: new Date().toISOString(), status: done.status, next: done.next, body: done.body }] })
    await runner.send('continue')
    expect(contextOf(provider.requests[0])).toContain('última sessão, concluída')
  })

  it('tells how to take over a handoff only when one is open, naming tool_load because memory_handoff is not sent', async () => {
    const open = new ScriptedProvider([{ text: 'Ok.' }])
    await makeRunner(open, {}, { handoffs: async () => [{ id: 'hand_1', summary: 'Parser pronto', next: 'Exportador CSV' }] }).send('continue')
    const context = contextOf(open.requests[0])
    expect(context).toContain('handoff hand_1: Parser pronto · próximo: Exportador CSV')
    expect(context).toContain('tool_load memory_handoff')
    expect(open.requests[0].tools.map((tool) => tool.name)).not.toContain('memory_handoff')

    const none = new ScriptedProvider([{ text: 'Ok.' }])
    await makeRunner(none).send('continue')
    expect(contextOf(none.requests[0])).not.toContain('memory_handoff')
  })

  it('is not handed to a subagent', async () => {
    const provider = new ScriptedProvider([{ text: 'Ok.' }])
    const runner = makeRunner(provider, { depth: 1, agentName: 'explorer' })
    await runner.send('procure os usos de parseCsv')
    expect(contextOf(provider.requests[0])).not.toContain('Trabalho em aberto')
  })
})

describe('skills, agents and tools that fit the request are named, once', () => {
  it('suggests the skill the request is about, and nothing for a greeting or a repeated request', async () => {
    const provider = new ScriptedProvider([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    const runner = makeRunner(provider, {}, { openWork: async () => [] })
    await runner.send('ola')
    expect(provider.requests[0].messages.filter(isTurnContext)).toHaveLength(0)
    await runner.send('crie um ícone SVG para o logo do app')
    const second = contextOf(provider.requests[1])
    expect(second).toContain('## Sugestões para este pedido')
    expect(second).toContain('- skill svg-master')
    expect(second).toContain('carregue com use_skill')
    expect(second).not.toContain('qa-total')
    await runner.send('desenhe outro ícone SVG, agora para o logo da loja')
    // svg-master was already suggested in this conversation.
    expect(provider.requests[2].messages.filter(isTurnContext)).toHaveLength(1)
  })

})

describe('another model takes over a long conversation', () => {
  const longHistory = (model: string): Message[] => {
    const out: Message[] = []
    for (let index = 0; index < 10; index++) {
      out.push({ id: `u${index}`, role: 'user', ts: index, parts: [{ type: 'text', text: `pedido ${index}: ${'detalhe do trabalho feito '.repeat(300)}` }] })
      out.push({ id: `a${index}`, role: 'assistant', ts: index, model, parts: [{ type: 'text', text: `resposta ${index}: ${'resultado do trabalho '.repeat(300)}` }] })
    }
    return out
  }

  class Summarising extends ScriptedProvider {
    summaries = 0
    async *stream(req: Parameters<ScriptedProvider['stream']>[0]): ReturnType<ScriptedProvider['stream']> {
      if (req.system.includes('Você compacta o contexto')) {
        this.summaries++
        this.requests.push(structuredClone(req))
        yield { type: 'text_delta', text: '## Objective\n- continuar o exportador' }
        yield { type: 'end', stopReason: 'stop', toolCalls: [] }
        return
      }
      yield* super.stream(req)
    }
  }

  it('summarises the history before the first request, instead of reading ~40 000 tokens it never saw', async () => {
    const provider = new Summarising([{ text: 'Segui o resumo.' }])
    const runner = makeRunner(provider, { initial: { messages: longHistory('deepseek-flash') } }, { openWork: async () => [] })
    await runner.send('Continue de onde paramos.')
    expect(provider.summaries).toBe(1)
    const real = provider.requests.filter((request) => !request.system.includes('Você compacta o contexto'))
    expect(real).toHaveLength(1)
    expect(real[0].messages.some((message) => text(message).startsWith('[Contexto compactado'))).toBe(true)
    expect(real[0].messages.length).toBeLessThan(12)
  })

  it('does not summarise when the same model continues, or when the conversation is short', async () => {
    const same = new Summarising([{ text: 'ok' }])
    await makeRunner(same, { initial: { messages: longHistory('duplo') } }, { openWork: async () => [] }).send('continue')
    expect(same.summaries).toBe(0)

    const short = new Summarising([{ text: 'ok' }])
    const history: Message[] = [
      { id: 'u', role: 'user', ts: 1, parts: [{ type: 'text', text: 'oi' }] },
      { id: 'a', role: 'assistant', ts: 2, model: 'deepseek-flash', parts: [{ type: 'text', text: 'olá' }] }
    ]
    await makeRunner(short, { initial: { messages: history } }, { openWork: async () => [] }).send('continue')
    expect(short.summaries).toBe(0)
  })

  it('does the same when a model runs out of quota in the middle of a turn and the next one is switched in', async () => {
    const exhausted = new ScriptedProvider([{ error: 'insufficient_quota: sem saldo', errorKind: 'quota' }])
    const next = new Summarising([{ text: 'Continuei com o outro modelo.' }])
    const runner = makeRunner(
      exhausted,
      // Another provider: after a quota failure the same account's other models would fail the same way.
      { initial: { messages: longHistory('duplo') }, fallback: [{ provider: next, config: { ...config('reserva'), id: 'reserva' } }] },
      { openWork: async () => [] }
    )
    await runner.send('Continue de onde paramos.')
    expect(next.summaries).toBe(1)
    const real = next.requests.filter((request) => !request.system.includes('Você compacta o contexto'))
    expect(real[0].messages.some((message) => text(message).startsWith('[Contexto compactado'))).toBe(true)
    expect(text(runner.messages.at(-1)!)).toContain('Continuei com o outro modelo.')
  })
})

describe('the context meter measures instead of guessing', () => {
  it('reports the real size of the system prompt, the project instructions, the skills, the tools and the memory in the history', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const instructions = '# Regras do projeto\n\n' + '- Sempre rode os testes antes de concluir.\n'.repeat(40)
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), instructions)
    const provider = new ScriptedProvider([{ text: 'Ok.' }])
    const runner = makeRunner(provider)
    const before = runner.contextBreakdown()
    expect(before.items.find((item) => item.id === 'memory')).toBeUndefined()

    await runner.send('Continue de onde paramos.')
    const meter = runner.contextBreakdown()
    const by = Object.fromEntries(meter.items.map((item) => [item.id, item.tokens]))
    expect(by.system).toBeGreaterThan(1_500) // the real static prompt, not the old fixed 1 100
    // the file, plus the comment line that labels where it came from
    expect(by.instructions).toBeGreaterThanOrEqual(Math.ceil(instructions.length / 3.4))
    expect(by.instructions).toBeLessThan(Math.ceil(instructions.length / 3.4) + 30)
    expect(by.skills).toBeGreaterThan(0)
    expect(by.tools).toBeGreaterThan(0)
    expect(by.memory).toBeGreaterThan(50) // the capsule that reached the model
    expect(by.messages).toBeGreaterThan(0)
    expect(meter.total).toBe(meter.items.reduce((sum, item) => sum + item.tokens, 0))
    expect(meter.window).toBe(128_000)
  })
})
