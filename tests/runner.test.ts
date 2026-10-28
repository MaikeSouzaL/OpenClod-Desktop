import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { SessionRunner, repairOrphanToolCalls, trimInlineImages, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { mcpCallTool, mcpCatalogTool } from '../src/core/tools/mcp'
import { lazyTools } from '../src/core/tools/lazy'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS, type HarnessEvent, type ToolSpec } from '../src/shared/types'
import type { ToolDef } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

const readTool: ToolDef = {
  name: 'read_file',
  description: 'fake read tool',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: (raw) => ({ title: 'Ler arquivo', detail: String((raw as { path: string }).path) }),
  async execute(raw) {
    const args = raw as { path: string }
    return { ok: true, text: `conteúdo de ${args.path}`, summary: 'lido' }
  }
}

const writeTool: ToolDef = {
  name: 'write_file',
  description: 'fake write tool',
  schema: z.object({ path: z.string(), content: z.string().optional() }),
  risk: 'write',
  parallelSafe: false,
  describe: (raw) => ({ title: 'Escrever arquivo', detail: String((raw as { path: string }).path) }),
  async execute(raw) {
    const args = raw as { path: string }
    return { ok: true, text: `escrito ${args.path}`, summary: 'escrito' }
  }
}

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('forja-runner-')
})

afterEach(async () => {
  await removeTempDir(cwd)
})

function makeRunner(
  provider: ScriptedProvider,
  overrides: Partial<RunnerDeps> = {}
): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const registry = buildRegistry(readTool, writeTool)
  const deps: RunnerDeps = {
    sessionId: 'ses_test',
    cwd,
    mode: 'code',
    provider,
    providerConfig: {
      id: 'mock',
      kind: 'openai',
      label: 'Scripted',
      baseUrl: 'http://localhost:0/v1',
      model: 'scripted',
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: true
    },
    registry,
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 4 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: {}
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    ...overrides
  }
  return { runner: new SessionRunner(deps), events }
}

describe('SessionRunner end-to-end turn', () => {
  it('does not stop with open plan items: sends the agent back until done or blocked', async () => {
    const updatePlan: ToolDef = {
      name: 'update_plan',
      description: 'fake plan tool',
      schema: z.object({
        items: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'active', 'done', 'blocked']) }))
      }),
      risk: 'read',
      parallelSafe: false,
      describe: () => ({ title: 'Atualizar plano', detail: 'fake' }),
      async execute(raw, ctx) {
        const args = raw as { items: Array<{ text: string; status: 'pending' | 'active' | 'done' | 'blocked' }> }
        ctx.setPlan(args.items.map((item, index) => ({ id: `plan_${index}`, ...item })))
        return { ok: true, text: 'plano atualizado', summary: 'plano' }
      }
    }
    const openItems = [
      { text: 'passo 1', status: 'done' as const },
      { text: 'passo 2', status: 'pending' as const }
    ]
    const doneItems = openItems.map((item) => ({ ...item, status: 'done' as const }))
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'plan_1', name: 'update_plan', args: { items: openItems } }] },
      { text: 'Vou parar aqui.' },
      { toolCalls: [{ id: 'plan_2', name: 'update_plan', args: { items: doneItems } }] },
      { text: 'Concluído.' }
    ])
    const { runner } = makeRunner(provider, {
      registry: buildRegistry(updatePlan),
      limits: { ...DEFAULT_LIMITS, maxIterations: 6 }
    })

    await runner.send('faça dois passos')

    expect(provider.requests).toHaveLength(4)
    expect(runner.plan.every((item) => item.status === 'done')).toBe(true)
    const guard = provider.requests[2].messages.find(
      (message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text.includes('<plan-guard>'))
    )
    expect(guard).toBeTruthy()
  })

  it('streams a tool call, executes it and finishes after the follow-up message', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'Concluído: o arquivo diz olá.' }
    ])
    const { runner, events } = makeRunner(provider)

    await runner.send('leia a.txt')

    const types = events.map((e) => e.type)
    expect(types).toContain('turn_start')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('message')
    expect(types).toContain('turn_end')

    const start = events.find((e): e is Extract<HarnessEvent, { type: 'tool_start' }> => e.type === 'tool_start')
    expect(start).toMatchObject({ toolCallId: 'call_1', name: 'read_file' })

    const end = events.find((e): e is Extract<HarnessEvent, { type: 'tool_end' }> => e.type === 'tool_end')
    expect(end).toMatchObject({ toolCallId: 'call_1', name: 'read_file', ok: true, summary: 'lido' })
    expect(end!.text).toContain('conteúdo de a.txt')

    const turnEnd = events.at(-1)
    expect(turnEnd).toMatchObject({ type: 'turn_end', stopReason: 'stop' })
    expect((turnEnd as { error?: string }).error).toBeUndefined()

    // Messages: user, assistant(tool_call), tool(result), assistant(text).
    expect(runner.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolMessage = runner.messages[2]
    expect(toolMessage.parts[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'call_1',
      name: 'read_file',
      ok: true
    })
    expect(runner.messages[3].parts[0]).toMatchObject({ type: 'text', text: 'Concluído: o arquivo diz olá.' })

    // The second provider request sees the tool result.
    expect(provider.requests).toHaveLength(2)
    const second = provider.requests[1]
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true)
    const specs = second.tools as ToolSpec[]
    expect(specs.some((s) => s.name === 'read_file')).toBe(true)

    expect(runner.busy).toBe(false)
    expect(runner.state).toBe('done')
    expect(runner.usage.input).toBeGreaterThan(0)
  })

  it('emits UI-only tool_progress without adding it to the transcript', async () => {
    const progressTool: ToolDef = {
      name: 'run_command',
      description: 'fake command with progress',
      schema: z.object({ command: z.string() }),
      risk: 'exec',
      parallelSafe: false,
      describe: () => ({ title: 'Executar comando', detail: 'fake' }),
      async execute(_raw, ctx) {
        ctx.progress?.('linha ao vivo', { outputAt: Date.now() })
        return { ok: true, text: 'fim', summary: 'ok' }
      }
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'cmd_1', name: 'run_command', args: { command: 'npm test' } }] },
      { text: 'terminou' }
    ])
    const { runner, events } = makeRunner(provider, { registry: buildRegistry(progressTool) })

    await runner.send('rode os testes')

    const progress = events.find((event): event is Extract<HarnessEvent, { type: 'tool_progress' }> => event.type === 'tool_progress')
    expect(progress).toMatchObject({ toolCallId: 'cmd_1', text: 'linha ao vivo' })
    expect(JSON.stringify(runner.messages.map((message) => message.parts))).not.toContain('linha ao vivo')
  })

  it('asks for approval, executes when approved and reports denial as a tool error', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'call_x', name: 'read_file', args: { path: 'x.txt' } }] },
      { text: 'ok' }
    ])
    const approve = vi.fn(async () => true)
    const { runner, events } = makeRunner(provider, {
      policy: policy({ mode: 'ask' }),
      approve
    })

    await runner.send('leia x.txt')
    expect(approve).not.toHaveBeenCalled() // read tools need no approval
    const toolEnd = events.find((e) => e.type === 'tool_end')
    expect(toolEnd).toMatchObject({ ok: true })

    const deniedProvider = new ScriptedProvider([
      { toolCalls: [{ id: 'call_y', name: 'write_file', args: { path: 'y.txt' } }] },
      { text: 'não consegui' }
    ])
    const denied = makeRunner(deniedProvider, {
      policy: policy({ mode: 'ask' }),
      approve: async () => false
    })
    await denied.runner.send('escreva')
    const deniedEnd = denied.events.find((e) => e.type === 'tool_end')
    expect(deniedEnd).toMatchObject({ ok: false, summary: 'negado pelo usuário' })
  })

  it('reports an unknown tool without calling the provider again unnecessarily', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c_missing', name: 'does_not_exist', args: {} }] },
      { text: 'tentei' }
    ])
    const { runner, events } = makeRunner(provider)
    await runner.send('use a ferramenta inexistente')
    const end = events.find((e) => e.type === 'tool_end')
    expect(end).toMatchObject({ ok: false, summary: 'ferramenta desconhecida' })
  })

  it('aborts an in-flight turn and emits turn_end with the cancellation error', async () => {
    const provider = new ScriptedProvider([{ text: 'a'.repeat(300), delayMs: 25 }])
    const { runner, events } = makeRunner(provider)

    const running = runner.send('demore')
    setTimeout(() => runner.abort(), 20)
    await running

    const turnEnd = events.at(-1)
    expect(turnEnd).toMatchObject({
      type: 'turn_end',
      stopReason: 'error',
      error: 'turno cancelado pelo usuário'
    })
    expect(events.some((e) => e.type === 'status' && e.state === 'cancelled')).toBe(true)
    expect(runner.busy).toBe(false)
    expect(runner.state).toBe('cancelled')
    // Stopping a turn is flagged so the activity feed, metrics and notifications do not call it a failure.
    expect(turnEnd).toMatchObject({ cancelled: true })
  })

  it('warns once that a paid provider has no tariff (cost shows as 0 and the cost limit cannot protect), but not for local or priced ones', async () => {
    const paid = { id: 'p', kind: 'openai' as const, label: 'Pago', baseUrl: 'https://api.example.com/v1', model: 'm', contextWindow: 128_000, supportsVision: false, supportsTools: true }
    const turns = [{ text: 'a', usage: { input: 100, output: 10 } }, { text: 'b', usage: { input: 100, output: 10 } }]
    const noticesOf = async (providerConfig: typeof paid & { inputCostPerMTok?: number }) => {
      const { runner, events } = makeRunner(new ScriptedProvider([turns[0]]), { providerConfig })
      await runner.send('um')
      await runner.send('dois')
      return events.filter((e) => e.type === 'notice' && /sem tarifa|não tem tarifa/.test(e.text))
    }
    expect(await noticesOf(paid)).toHaveLength(1)
    expect(await noticesOf({ ...paid, inputCostPerMTok: 3 })).toHaveLength(0)
    expect(await noticesOf({ ...paid, baseUrl: 'http://localhost:11434/v1' })).toHaveLength(0)
  })

  it('does not flag a genuine failure as cancelled', async () => {
    const failure = { error: 'modelo indisponível', retryable: true }
    const { runner, events } = makeRunner(new ScriptedProvider([failure, failure, failure]), { retryBaseMs: 1 })
    await runner.send('oi')
    expect(events.at(-1)).not.toHaveProperty('cancelled')
  })

  it('stops the rest of a tool batch once the user aborted: later calls never run', async () => {
    const ran: string[] = []
    const slow: ToolDef = {
      name: 'write_file', // a core tool, so the runner offers it in code mode
      description: 'slow write',
      schema: z.object({ id: z.string() }),
      risk: 'write',
      parallelSafe: false,
      describe: (raw) => ({ title: 'Escrever', detail: String((raw as { id: string }).id) }),
      async execute(raw) {
        const { id } = raw as { id: string }
        ran.push(id)
        await new Promise((resolve) => setTimeout(resolve, 60))
        return { ok: true, text: `feito ${id}` }
      }
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: 'b1', name: 'write_file', args: { id: 'um' } },
          { id: 'b2', name: 'write_file', args: { id: 'dois' } },
          { id: 'b3', name: 'write_file', args: { id: 'tres' } }
        ]
      },
      { text: 'fim' }
    ])
    const { runner, events } = makeRunner(provider, { registry: buildRegistry(slow) })
    const running = runner.send('faça três escritas')
    setTimeout(() => runner.abort(), 20)
    await running
    expect(ran).toEqual(['um'])
    const ends = events.filter((e) => e.type === 'tool_end') as Array<{ toolCallId: string; summary?: string }>
    expect(ends.filter((e) => e.summary === 'cancelada').map((e) => e.toolCallId)).toEqual(['b2', 'b3'])
  })

  it('reports a provider error as a turn error and a notice after the transient retries', async () => {
    const failure = { error: 'modelo indisponível', retryable: true }
    const provider = new ScriptedProvider([failure, failure, failure])
    const { runner, events } = makeRunner(provider, { retryBaseMs: 1 })
    await runner.send('oi')

    expect(provider.requests).toHaveLength(3)
    expect(events.filter((e) => e.type === 'notice' && e.level === 'warn')).toHaveLength(2)
    expect(runner.state).toBe('error')
    expect(events.some((e) => e.type === 'notice' && e.level === 'error')).toBe(true)
    const turnEnd = events.at(-1)
    expect(turnEnd).toMatchObject({
      type: 'turn_end',
      stopReason: 'error',
      error: 'modelo indisponível'
    })
  })

  it('refuses a concurrent send while a turn is running', async () => {
    const provider = new ScriptedProvider([{ text: 'a'.repeat(100), delayMs: 20 }])
    const { runner } = makeRunner(provider)
    const first = runner.send('primeiro')
    await expect(runner.send('segundo')).rejects.toThrow(/turno em execução/)
    await first
  })
})

describe('turn budget', () => {
  it('ends with a final summary and a budget event instead of a bare error', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
        usage: { input: 5_000_000, output: 1_000 }
      },
      { text: 'Resumo: li a.txt; falta o resto.', usage: { input: 10_000, output: 100 } }
    ])
    const { runner, events } = makeRunner(provider, {
      limits: { ...DEFAULT_LIMITS, maxTokens: 1_000 },
      initial: { plan: [{ id: 'p1', text: 'Ler a.txt', status: 'active' }] }
    })

    await runner.send('tarefa longa')

    const budget = events.find((event) => event.type === 'budget')
    expect(budget).toMatchObject({ type: 'budget', info: { kind: 'tokens', limit: 1_000 } })
    // The final call keeps the tools but forbids calls, so the turn can close.
    expect(provider.requests[1].toolChoice).toBe('none')
    expect(runner.messages.at(-1)?.parts[0]).toMatchObject({
      type: 'text',
      text: 'Resumo: li a.txt; falta o resto.'
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' })
    expect(runner.state).toBe('done')
    // The plan survives the budget stop for the "continue" action.
    expect(runner.plan[0].status).toBe('active')
    expect(events.some((event) => event.type === 'notice' && event.level === 'error')).toBe(false)
  })

  it('uses the automatic budget for a large context window', async () => {
    const provider = new ScriptedProvider([
      { text: 'ok', usage: { input: 5_000_000, output: 10 } }
    ])
    const { runner, events } = makeRunner(provider, {
      limits: { ...DEFAULT_LIMITS, maxTokens: 0 }
    })
    await runner.send('oi')
    const usage = events.find((event) => event.type === 'usage')
    expect(usage).toMatchObject({ type: 'usage', limit: 6_000_000 })
    expect(events.some((event) => event.type === 'budget')).toBe(false)
  })
})

describe('tool output spill', () => {
  it('spills a 20k non-read_file result and keeps a short preview', async () => {
    const outDir = await makeTempDir('forja-spill-')
    try {
      const bigTool: ToolDef = {
        name: 'run_command',
        description: 'fake big command',
        schema: z.object({ command: z.string() }),
        risk: 'exec',
        parallelSafe: true,
        describe: () => ({ title: 'Rodar', detail: 'big' }),
        async execute() {
          return { ok: true, text: `${'x'.repeat(20_000)}FIM`, summary: 'ok' }
        }
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: 'c_big', name: 'run_command', args: { command: 'big' } }] },
        { text: 'ok' }
      ])
      const { runner } = makeRunner(provider, {
        registry: buildRegistry(bigTool),
        toolOutputDir: outDir
      })

      await runner.send('rode o comando grande')

      const toolMessage = runner.messages.find((message) => message.role === 'tool')!
      const text = toolMessage.parts
        .filter((part) => part.type === 'tool_result')
        .map((part) => (part.type === 'tool_result' ? part.text : ''))
        .join('')
      expect(text.length).toBeLessThan(16_000)
      expect(text).toContain('salva em arquivo')
      expect(text).toContain('FIM')
      expect(fs.readdirSync(path.join(outDir, 'ses_test'))).toHaveLength(1)
    } finally {
      await removeTempDir(outDir)
    }
  })

  it('truncates a huge read_file instead of spilling it', async () => {
    const bigRead: ToolDef = {
      name: 'read_file',
      description: 'fake huge read',
      schema: z.object({ path: z.string() }),
      risk: 'read',
      parallelSafe: true,
      describe: () => ({ title: 'Ler', detail: 'big' }),
      async execute() {
        return { ok: true, text: `${'a'.repeat(70_000)}FIM`, summary: 'lido' }
      }
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c_read', name: 'read_file', args: { path: 'big.txt' } }] },
      { text: 'ok' }
    ])
    const { runner } = makeRunner(provider, { registry: buildRegistry(bigRead) })

    await runner.send('leia o arquivo grande')

    const toolMessage = runner.messages.find((message) => message.role === 'tool')!
    const text = toolMessage.parts
      .filter((part) => part.type === 'tool_result')
      .map((part) => (part.type === 'tool_result' ? part.text : ''))
      .join('')
    expect(text.length).toBeLessThanOrEqual(60_000)
    expect(text).not.toContain('salva em arquivo')
  })
})

describe('MCP tools and effort reach the model', () => {
  const mcpTool: ToolDef = {
    name: 'mcp__srv__lookup',
    description: '[MCP srv] lookup',
    schema: z.record(z.string(), z.unknown()),
    jsonSchema: { type: 'object' },
    risk: 'exec',
    parallelSafe: false,
    describe: () => ({ title: 'MCP srv/lookup', detail: '{}' }),
    async execute() {
      return { ok: true, text: 'achou' }
    }
  }

  const mcpService = {
    search: async () => ({ catalog: [], registry: [], installed: [] }),
    install: async () => ({ ok: true }),
    list: () => [],
    catalog: () => [],
    schema: () => undefined,
    call: async () => ({ ok: true, text: '', summary: '' }),
    readResource: async () => [],
    getPrompt: async () => ({ messages: [] })
  }

  function withMcp(provider: ScriptedProvider, mode: RunnerDeps['mode'], extra: Partial<RunnerDeps> = {}): SessionRunner {
    const { runner } = makeRunner(provider, {
      mode,
      registry: buildRegistry(readTool, writeTool, mcpTool, mcpCatalogTool, mcpCallTool, ...lazyTools),
      services: {
        browser: {},
        computer: {},
        skills: { list: () => [] },
        memory: { all: async () => [] },
        mcp: mcpService
      } as unknown as RunnerDeps['services'],
      ...extra
    })
    return runner
  }

  it('leaves the MCP catalogue/call to tool_load in working modes only, never every server schema', async () => {
    const outcome = async (mode: RunnerDeps['mode']): Promise<{ sent: string[]; later: string[]; loaded: boolean }> => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: 'l1', name: 'tool_load', args: { tools: ['mcp_catalog', 'mcp_call'] } }] },
        { text: 'ok' }
      ])
      const runner = withMcp(provider, mode)
      await runner.send('oi')
      const load = runner.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool_result' && part.name === 'tool_load')
      return {
        sent: provider.requests[0].tools.map((tool: ToolSpec) => tool.name),
        later: provider.requests[1].tools.map((tool: ToolSpec) => tool.name),
        loaded: Boolean(load && load.type === 'tool_result' && load.ok)
      }
    }
    // The fallback path costs its schemas in every request, and first-class `mcp__server__tool` is the way in.
    const code = await outcome('code')
    expect(code.sent).not.toContain('mcp_catalog')
    expect(code.sent).not.toContain('mcp_call')
    expect(code.loaded).toBe(true)
    expect(code.later).toEqual(expect.arrayContaining(['mcp_catalog', 'mcp_call']))
    expect((await outcome('autonomous')).loaded).toBe(true)
    expect((await outcome('ask')).loaded).toBe(true)
    const review = await outcome('review')
    expect(review.loaded).toBe(false)
    expect(review.later).not.toContain('mcp_catalog')
    // Per-server schemas are never sent directly any more.
    expect(code.sent).not.toContain('mcp__srv__lookup')
  })

  it('passes the session effort to the provider on every request of a turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'pronto' }
    ])
    await withMcp(provider, 'code', { effort: 'xhigh' }).send('leia a.txt')
    expect(provider.requests.map((request) => request.effort)).toEqual(['xhigh', 'xhigh'])
  })

  it('stores provider blocks on the assistant message', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }])
    const inner = provider.stream.bind(provider)
    provider.stream = async function* (request) {
      yield { type: 'provider_blocks', kind: 'anthropic', model: 'm', blocks: [{ type: 'thinking', thinking: 't', signature: 's' }] }
      yield* inner(request)
    }
    const runner = withMcp(provider, 'code')
    await runner.send('oi')
    const assistant = runner.snapshot().messages.find((message) => message.role === 'assistant')
    expect(assistant?.providerBlocks).toEqual({ kind: 'anthropic', model: 'm', blocks: [{ type: 'thinking', thinking: 't', signature: 's' }] })
  })
})

describe('loop guard', () => {
  it('stops a repeated reasoning stream and stores a limitation card', async () => {
    const block = 'Preciso verificar a hipótese com cuidado antes de responder ao usuário. '
    const provider = new ScriptedProvider([{ reasoning: block.repeat(8) }])
    const { runner, events } = makeRunner(provider, { effort: 'low' })

    await runner.send('continue')

    expect(events.some((event) => event.type === 'notice' && /Loop detectado/.test(event.text))).toBe(true)
    const end = events.find((event) => event.type === 'turn_end')
    expect(end).toMatchObject({ stopReason: 'error' })
    expect(end?.type === 'turn_end' ? end.error : '').toMatch(/Loop detectado/)
    const limitation = runner.messages
      .flatMap((message) => message.parts)
      .find((part): part is Extract<typeof part, { type: 'limitation' }> => part.type === 'limitation')
    expect(limitation?.report.title).toBe('Loop detectado e interrompido')
    expect(runner.state).toBe('error')
  })

  it('stops after four identical tool calls instead of nudging forever', async () => {
    const call = { id: 'same', name: 'read_file', args: { path: 'a.txt' } }
    const provider = new ScriptedProvider([
      { toolCalls: [call] },
      { toolCalls: [call] },
      { toolCalls: [call] },
      { toolCalls: [call] },
      { text: 'não deveria chegar aqui' }
    ])
    const { runner, events } = makeRunner(provider)

    await runner.send('leia de novo')

    const end = events.find((event) => event.type === 'turn_end')
    expect(end).toMatchObject({ stopReason: 'error' })
    expect(events.some((event) => event.type === 'notice' && /Loop detectado na ferramenta/.test(event.text))).toBe(true)
    expect(provider.remaining).toBe(1)
    expect(runner.state).toBe('error')
  })
})

describe('tool images', () => {
  it('keeps screenshots in the transcript even when the model has no vision', async () => {
    const imageRead: ToolDef = {
      ...readTool,
      async execute() {
        return {
          ok: true,
          text: 'captura de tela',
          summary: 'tela 800x600',
          images: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', label: 'print.png' }]
        }
      }
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'shot_1', name: 'read_file', args: { path: 'print.png' } }] },
      { text: 'vi a captura' }
    ])
    // The mock reports vision=true by default; force the vision-less path.
    Object.defineProperty(provider, 'supportsVision', { value: false })
    const { runner } = makeRunner(provider, { registry: buildRegistry(imageRead) })

    await runner.send('tire um print')

    const part = runner.messages
      .flatMap((message) => message.parts)
      .find((candidate): candidate is Extract<typeof candidate, { type: 'tool_result' }> => candidate.type === 'tool_result')
    expect(part?.images).toHaveLength(1)
    expect(part?.text).toContain('não suporta visão')
    // The note tells the model it did NOT get the picture and where to read the screen as text instead.
    expect(part?.text).toContain('NÃO recebeu a imagem')
    expect(part?.text).toContain('computer_snapshot')
  })
})

describe('model fallback', () => {
  const backupConfig = {
    id: 'mock-backup',
    kind: 'openai' as const,
    label: 'Backup',
    baseUrl: 'http://localhost:0/v1',
    model: 'backup-model',
    contextWindow: 32_000,
    supportsVision: false,
    supportsTools: true
  }

  function withFallback(
    primary: ScriptedProvider,
    backup: ScriptedProvider,
    overrides: Partial<RunnerDeps> = {}
  ): { runner: SessionRunner; events: HarnessEvent[] } {
    return makeRunner(primary, {
      fallback: [{ provider: backup, config: backupConfig }],
      ...overrides
    })
  }

  it('switches to the next model after quota exhaustion and keeps the conversation', async () => {
    const primary = new ScriptedProvider([{ error: '402 payment required', errorKind: 'quota' }])
    const backup = new ScriptedProvider([{ text: 'fallback ok' }])
    const { runner, events } = withFallback(primary, backup)

    await runner.send('continue o trabalho')

    expect(runner.state).toBe('done')
    // Same user message, then the backup model's answer: nothing was lost.
    expect(runner.messages[0]).toMatchObject({ role: 'user' })
    expect(runner.messages.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'fallback ok' })
    expect(backup.requests).toHaveLength(1)
    expect(backup.requests[0].messages.some((m) => m.role === 'user')).toBe(true)

    const notice = events.find(
      (e): e is Extract<HarnessEvent, { type: 'notice' }> =>
        e.type === 'notice' && e.text.includes('continuando com')
    )
    expect(notice?.text).toContain('quota')
    expect(notice?.text).toContain('Backup/backup-model')
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' })
  })

  it('also falls back on a bad_request (model unavailable on the provider)', async () => {
    const primary = new ScriptedProvider([{ error: '400 model not found', errorKind: 'bad_request' }])
    const backup = new ScriptedProvider([{ text: 'modelo alternativo respondeu' }])
    const { runner } = withFallback(primary, backup)

    await runner.send('oi')

    expect(runner.state).toBe('done')
    expect(backup.requests).toHaveLength(1)
  })

  it('keeps a partial answer on screen and lets the next model continue it, instead of ending the turn', async () => {
    const primary = new ScriptedProvider([
      { text: 'resposta parcial', error: '402 payment required', errorKind: 'quota' }
    ])
    const backup = new ScriptedProvider([{ text: ' e o resto da resposta' }])
    const { runner } = withFallback(primary, backup)

    await runner.send('oi')

    expect(runner.state).toBe('done')
    // What reached the screen stays in the history, without an error mark; the next model is asked to pick it up.
    const partial = runner.messages.find((m) => m.role === 'assistant' && m.parts[0]?.type === 'text' && m.parts[0].text === 'resposta parcial')
    expect(partial).toBeTruthy()
    expect(partial?.error).toBeUndefined()
    expect(backup.requests).toHaveLength(1)
    const seen = backup.requests[0].messages
    expect(seen.some((m) => m.role === 'assistant' && JSON.stringify(m.parts).includes('resposta parcial'))).toBe(true)
    expect(seen.some((m) => m.hidden && JSON.stringify(m.parts).includes('resposta-interrompida'))).toBe(true)
    expect(runner.messages.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: ' e o resto da resposta' })
  })

  it('reports a real error when every model in the fallback chain fails', async () => {
    const primary = new ScriptedProvider([{ error: '402 payment required', errorKind: 'quota' }])
    const backup = new ScriptedProvider([{ error: '401 invalid api key', errorKind: 'auth' }])
    const { runner } = withFallback(primary, backup, { retryBaseMs: 0 })

    await runner.send('oi')

    expect(runner.state).toBe('error')
    const failed = runner.messages.find((message) => message.role === 'assistant' && message.error)
    expect(failed?.error).toContain('401')
    const limitation = runner.messages.flatMap((message) => message.parts).find((part) => part.type === 'limitation')
    expect(limitation).toBeTruthy()
  })
})

describe('self-analysis on failure', () => {
  it('adds a limitation card with the exact error and a suggested fix', async () => {
    const provider = new ScriptedProvider([
      { error: '400 {"error":{"message":"Invalid message content type: <nil>"}}', errorKind: 'bad_request' }
    ])
    const { runner, events } = makeRunner(provider)

    await runner.send('conserte o bug do login')

    expect(runner.state).toBe('error')
    const limitation = runner.messages
      .flatMap((message) => message.parts)
      .find((part): part is Extract<typeof part, { type: 'limitation' }> => part.type === 'limitation')
    expect(limitation?.report).toMatchObject({ goal: 'conserte o bug do login', automatic: true })
    expect(limitation?.report.error).toContain('Invalid message content type')
    expect(limitation?.report.suggestion).toMatch(/formato da requisição/i)
    expect(events.some((event) => event.type === 'limitation')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'error' })
  })

  it('does not add a second card when the agent reported the limitation itself', async () => {
    const reportTool: ToolDef = {
      name: 'report_limitation',
      description: 'fake limitation report',
      schema: z.object({ title: z.string() }),
      risk: 'read',
      parallelSafe: false,
      describe: () => ({ title: 'Limitação', detail: 'fake' }),
      async execute() {
        return { ok: true, text: 'registrado', summary: 'registrado' }
      }
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'lim_1', name: 'report_limitation', args: { title: 'sem acesso' } }] },
      { error: '429 rate limit', errorKind: 'rate_limit' }
    ])
    const { runner } = makeRunner(provider, { registry: buildRegistry(reportTool) })

    await runner.send('tente acessar')

    const cards = runner.messages.flatMap((message) => message.parts).filter((part) => part.type === 'limitation')
    expect(cards).toHaveLength(0)
  })
})

describe('crash recovery', () => {
  it('repairs tool calls left without a result after a forced quit', () => {
    const assistant = {
      id: 'msg_a',
      role: 'assistant' as const,
      ts: 1,
      parts: [
        { type: 'tool_call' as const, id: 'call_1', name: 'read_file', args: { path: 'a' } },
        { type: 'tool_call' as const, id: 'call_2', name: 'run_command', args: { command: 'npm test' } }
      ]
    }
    const tool = {
      id: 'msg_t',
      role: 'tool' as const,
      ts: 2,
      parts: [
        { type: 'tool_result' as const, toolCallId: 'call_1', name: 'read_file', ok: true, text: 'conteúdo' }
      ]
    }
    const { messages, repaired } = repairOrphanToolCalls([assistant, tool])
    expect(repaired).toBe(1)
    const results = messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool_result')
    expect(results.map((part) => part.toolCallId).sort()).toEqual(['call_1', 'call_2'])
    const interrupted = results.find((part) => part.toolCallId === 'call_2')
    expect(interrupted).toMatchObject({ ok: false })
    expect(interrupted?.text).toMatch(/interrompida/i)
  })

  it('leaves a complete conversation untouched', () => {
    const assistant = {
      id: 'msg_a',
      role: 'assistant' as const,
      ts: 1,
      parts: [{ type: 'tool_call' as const, id: 'call_1', name: 'read_file', args: {} }]
    }
    const tool = {
      id: 'msg_t',
      role: 'tool' as const,
      ts: 2,
      parts: [{ type: 'tool_result' as const, toolCallId: 'call_1', name: 'read_file', ok: true, text: 'ok' }]
    }
    const { messages, repaired } = repairOrphanToolCalls([assistant, tool])
    expect(repaired).toBe(0)
    expect(messages).toHaveLength(2)
  })
})

describe('inline image budget', () => {
  it('keeps the newest images and explains the removed ones', () => {
    const data = 'A'.repeat(100)
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data }
    const toolResult = (id: string) => ({
      id: `msg_${id}`,
      role: 'tool' as const,
      ts: 1,
      parts: [
        {
          type: 'tool_result' as const,
          toolCallId: id,
          name: 'computer_screenshot',
          ok: true,
          text: 'captura',
          images: [image]
        }
      ]
    })
    const trimmed = trimInlineImages([toolResult('old'), toolResult('middle'), toolResult('new')], 160, 80)
    expect(trimmed).toHaveLength(3)
    const images = trimmed.flatMap((message) => message.parts).filter((part) => part.type === 'tool_result')
    expect(images[0].images).toBeUndefined()
    expect(images[1].images).toBeUndefined()
    expect(images[2].images).toHaveLength(1)
    expect(images[0].text).toMatch(/removida/i)
  })

  it('does not touch a conversation under the trigger', () => {
    const messages = [
      {
        id: 'm',
        role: 'user' as const,
        ts: 1,
        parts: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'A'.repeat(40) }]
      }
    ]
    expect(trimInlineImages(messages, 1000, 500)).toBe(messages)
  })
})
