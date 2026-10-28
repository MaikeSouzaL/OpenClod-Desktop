import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS, type Message } from '../src/shared/types'
import type { ToolDef } from '../src/core/tools/types'
import type { MemoryPageSummary } from '../src/core/memory/project'
import { TURN_CONTEXT_OPEN, isTurnContext } from '../src/core/agent/turn-context'
import { makeTempDir, policy, removeTempDir } from './helpers'

/**
 * Providers cache the PREFIX of the prompt. Measured on real sessions: the first call of a turn got 2% of its input from
 * the cache and the call after `update_plan` 9%, against 92% for the rest, because the plan, the wiki briefing and the
 * memory recall lived in the system prompt and changed every turn. These tests pin the property that fixes it: the
 * system prompt never changes, and each request starts with exactly the messages of the one before.
 */
let cwd: string
beforeEach(async () => {
  cwd = await makeTempDir('openclod-prefix-')
})
afterEach(async () => removeTempDir(cwd))

const readTool: ToolDef = {
  name: 'read_file',
  description: 'fake read tool',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: (raw) => ({ title: 'Ler arquivo', detail: String((raw as { path: string }).path) }),
  async execute(raw) {
    return { ok: true, text: `conteúdo de ${(raw as { path: string }).path}`, summary: 'lido' }
  }
}
const planTool: ToolDef = {
  name: 'update_plan',
  description: 'fake plan tool',
  schema: z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'active', 'done', 'blocked']) })) }),
  risk: 'read',
  parallelSafe: false,
  describe: () => ({ title: 'Atualizar plano', detail: 'fake' }),
  async execute(raw, ctx) {
    const args = raw as { items: Array<{ text: string; status: 'pending' | 'active' | 'done' | 'blocked' }> }
    ctx.setPlan(args.items.map((item, index) => ({ id: `plan_${index}`, ...item })))
    return { ok: true, text: 'plano atualizado', summary: 'plano' }
  }
}

function durable(over: Partial<MemoryPageSummary> & { slug: string; title: string }): MemoryPageSummary {
  return { tags: [], pinned: false, updated: '2026-10-27T08:00:00Z', summary: '', terms: [], kind: 'topic', links: [], backlinks: [], status: 'active', memoryType: 'solution', ...over }
}
const jiraPage = durable({
  slug: 'mcp-do-jira-conectado',
  title: 'MCP do Jira conectado pelo conector local jira (read-only)',
  tags: ['jira', 'mcp', 'atlassian'],
  summary: 'O servidor oficial recusa token de API; o conector local jira usa uvx mcp-atlassian.',
  terms: ['jira', 'conectado', 'conector', 'local', 'mcp', 'atlassian', 'token', 'uvx']
})
const backlogPage = durable({
  slug: 'backlog-cnc',
  title: 'Backlog CNC — o que falta fazer',
  memoryType: 'fact',
  tags: ['cnc', 'backlog'],
  summary: '34 itens abertos, 113 h estimadas.',
  terms: ['backlog', 'cnc', 'falta', 'fazer', 'itens', 'abertos']
})

function makeRunner(provider: ScriptedProvider, overrides: Partial<RunnerDeps> = {}, memory: { pages?: MemoryPageSummary[]; listPages?: () => Promise<MemoryPageSummary[]> } = {}) {
  const deps: RunnerDeps = {
    sessionId: 'ses_prefix',
    cwd,
    mode: 'code',
    provider,
    providerConfig: {
      id: 'mock',
      kind: 'openai',
      label: 'Duplo',
      baseUrl: 'http://localhost:0/v1',
      model: 'duplo',
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: true
    },
    registry: buildRegistry(readTool, planTool),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 8 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [{ name: 'svg-master', description: 'Desenha SVG.' }] },
      memory: { all: async () => [] },
      projectMemory: {
        listPages: memory.listPages ?? (async () => memory.pages ?? [jiraPage, backlogPage]),
        listHandoffs: async () => [],
        map: async () => ({ text: 'Esta memória tem 2 página(s) de assunto.', pages: 2, durable: 2, openHandoffs: 0 })
      }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async () => true,
    ...overrides
  }
  return new SessionRunner(deps)
}

const contexts = (messages: Message[]): Message[] => messages.filter(isTurnContext)
const text = (message: Message): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
function startsWith(longer: Message[], shorter: Message[]): boolean {
  return shorter.every((message, index) => JSON.stringify(longer[index]) === JSON.stringify(message))
}

describe('the prompt prefix stays put', () => {
  it('keeps the same system prompt and the same history prefix across iterations, plan updates and turns', async () => {
    const provider = new ScriptedProvider([
      // turn 1: the model writes a plan, reads a file, closes the plan
      { toolCalls: [{ id: 'p1', name: 'update_plan', args: { items: [{ text: 'passo 1', status: 'active' }, { text: 'passo 2', status: 'pending' }] } }] },
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ id: 'p2', name: 'update_plan', args: { items: [{ text: 'passo 1', status: 'done' }, { text: 'passo 2', status: 'done' }] } }] },
      { text: 'Pronto: o conector é o local.' },
      // turn 2: a greeting
      { text: 'Olá!' },
      // turn 3: another subject
      { text: 'Faltam 34 itens.' }
    ])
    const runner = makeRunner(provider)
    await runner.send('como conectei o Jira no harness?')
    await runner.send('ola')
    await runner.send('o que falta fazer no backlog CNC?')

    expect(provider.requests).toHaveLength(6)
    // 1. The system prompt is one and the same string for the whole session.
    expect(new Set(provider.requests.map((request) => request.system)).size).toBe(1)
    const system = provider.requests[0].system
    for (const volatile of ['passo 1', 'mcp-do-jira-conectado', 'backlog-cnc', 'Esta memória tem']) expect(system).not.toContain(volatile)
    // 2. Every request starts with all the messages of the previous one: nothing earlier was rewritten.
    for (let index = 1; index < provider.requests.length; index++) {
      expect(startsWith(provider.requests[index].messages, provider.requests[index - 1].messages), `request ${index}`).toBe(true)
    }
  })

  it('puts what matches the request in ONE hidden message, and sends nothing for a greeting', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'p1', name: 'update_plan', args: { items: [{ text: 'passo 1', status: 'done' }] } }] },
      { text: 'Pronto.' },
      { text: 'Olá!' },
      { text: 'Faltam 34 itens.' }
    ])
    const runner = makeRunner(provider)
    await runner.send('como conectei o Jira no harness?')
    const first = contexts(provider.requests[0].messages)
    expect(first).toHaveLength(1)
    expect(text(first[0]).startsWith(TURN_CONTEXT_OPEN)).toBe(true)
    expect(text(first[0])).toContain('## Mapa da memória do projeto')
    expect(text(first[0])).toContain('[mcp-do-jira-conectado]')
    expect(text(first[0])).not.toContain('Plano atual')
    // The hidden message comes right after the user's.
    const at = provider.requests[0].messages.indexOf(first[0])
    expect(provider.requests[0].messages[at - 1].role).toBe('user')
    expect(text(provider.requests[0].messages[at - 1])).toContain('como conectei o Jira')

    await runner.send('ola')
    expect(contexts(provider.requests[2].messages)).toHaveLength(1)

    await runner.send('o que falta fazer no backlog CNC?')
    const all = contexts(provider.requests[3].messages)
    expect(all).toHaveLength(2)
    expect(text(all[1])).toContain('[backlog-cnc]')
    // The page that was already in the history is not sent again, and neither is the plan the model wrote itself.
    expect(text(all[1])).not.toContain('[mcp-do-jira-conectado]')
    expect(text(all[1])).not.toContain('Plano atual')
    expect(text(all[1])).not.toContain('Mapa da memória')
  })

  it('shows a plan that changed outside the model\'s own calls, such as one interrupted by closing the app', async () => {
    const provider = new ScriptedProvider([{ text: 'Retomando.' }])
    const runner = makeRunner(provider, {
      initial: { plan: [{ id: 'x', text: 'Migrar o banco', status: 'active', interrupted: true }] }
    })
    await runner.send('continue')
    const [context] = contexts(provider.requests[0].messages)
    expect(text(context)).toContain('## Plano atual (update_plan)')
    expect(text(context)).toContain('- [active] Migrar o banco (interrompido — retome daqui)')
    expect(provider.requests[0].system).not.toContain('Migrar o banco')
  })

  it('does not send the map or the pages again when the runner is rebuilt over the same history', async () => {
    const first = new ScriptedProvider([{ text: 'Use o conector local.' }])
    const runner = makeRunner(first)
    await runner.send('como conectei o Jira no harness?')
    expect(contexts(runner.messages)).toHaveLength(1)

    // The user changed the model: a new runner starts from the saved messages.
    const second = new ScriptedProvider([{ text: 'Ok.' }])
    const rebuilt = makeRunner(second, { initial: { messages: structuredClone(runner.messages) } })
    await rebuilt.send('e o conector do Jira, como reconectar?')
    const after = contexts(second.requests[0].messages)
    expect(after).toHaveLength(1)
  })

  it('does not make the model wait for a memory service that never answers', async () => {
    const provider = new ScriptedProvider([{ text: 'Respondi sem memória.' }])
    const runner = makeRunner(provider, {}, { listPages: () => new Promise(() => undefined) })
    const started = Date.now()
    await runner.send('como conectei o Jira no harness?')
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(provider.requests).toHaveLength(1)
    expect(text(runner.messages.at(-1)!)).toContain('Respondi sem memória.')
  })

  it('puts the context back after a compaction in the middle of a long turn swallowed the old one', async () => {
    // A long tool loop in a small window: the compaction summarises the start of the turn (the user's request and the
    // hidden context with it), so the context of this turn has to come back after the summary.
    const bigRead: ToolDef = {
      ...readTool,
      async execute(raw) {
        return { ok: true, text: `conteúdo de ${(raw as { path: string }).path}\n${'linha de código '.repeat(180)}`, summary: 'lido' }
      }
    }
    class Summarising extends ScriptedProvider {
      summaries = 0
      async *stream(req: Parameters<ScriptedProvider['stream']>[0]): ReturnType<ScriptedProvider['stream']> {
        if (req.system.includes('Você compacta o contexto')) {
          this.summaries++
          yield { type: 'text_delta', text: '## Objective\n- continuar o trabalho' }
          yield { type: 'end', stopReason: 'stop', toolCalls: [] }
          return
        }
        yield* super.stream(req)
      }
    }
    const reads = Array.from({ length: 10 }, (_, index) => ({ toolCalls: [{ id: `r${index}`, name: 'read_file', args: { path: `f${index}.txt` } }] }))
    const provider = new Summarising([...reads, { text: 'Feito.' }])
    const runner = makeRunner(provider, {
      registry: buildRegistry(bigRead, planTool),
      limits: { ...DEFAULT_LIMITS, maxIterations: 20 },
      providerConfig: { id: 'mock', kind: 'openai', label: 'Duplo', baseUrl: 'http://localhost:0/v1', model: 'duplo', contextWindow: 10_000, supportsVision: false, supportsTools: true }
    })
    await runner.send('como conectei o Jira no harness?')

    expect(provider.summaries).toBeGreaterThanOrEqual(1)
    expect(runner.messages.some((message) => text(message).startsWith('[Contexto compactado'))).toBe(true)
    // The request right after the summary carries a context again: map and pages, since the old one was swallowed.
    const real = provider.requests.filter((request) => !request.system.includes('Você compacta o contexto'))
    const afterSummary = real.find((request) => request.messages.some((message) => text(message).startsWith('[Contexto compactado')))!
    const back = contexts(afterSummary.messages)
    expect(back.length).toBeGreaterThanOrEqual(1)
    expect(text(back.at(-1)!)).toContain('## Mapa da memória do projeto')
    expect(text(back.at(-1)!)).toContain('[mcp-do-jira-conectado]')
  })
})
