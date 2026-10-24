import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from '../src/core/providers/mock'
import { buildRegistry } from '../src/core/tools/registry'
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
      kind: 'mock',
      label: 'Scripted',
      baseUrl: '',
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

describe('MCP tools and effort reach the model', () => {
  const mcpTool: ToolDef = {
    name: 'mcp__srv__lookup',
    description: '[MCP srv] lookup',
    schema: z.record(z.unknown()),
    jsonSchema: { type: 'object' },
    risk: 'exec',
    parallelSafe: false,
    describe: () => ({ title: 'MCP srv/lookup', detail: '{}' }),
    async execute() {
      return { ok: true, text: 'achou' }
    }
  }

  function withMcp(provider: ScriptedProvider, mode: RunnerDeps['mode'], extra: Partial<RunnerDeps> = {}): SessionRunner {
    const { runner } = makeRunner(provider, { mode, registry: buildRegistry(readTool, writeTool, mcpTool), ...extra })
    return runner
  }

  it('offers registered MCP tools in working modes only', async () => {
    const names = async (mode: RunnerDeps['mode']): Promise<string[]> => {
      const provider = new ScriptedProvider([{ text: 'ok' }])
      await withMcp(provider, mode).send('oi')
      return provider.requests[0].tools.map((tool: ToolSpec) => tool.name)
    }
    expect(await names('code')).toContain('mcp__srv__lookup')
    expect(await names('autonomous')).toContain('mcp__srv__lookup')
    expect(await names('ask')).not.toContain('mcp__srv__lookup')
    expect(await names('review')).not.toContain('mcp__srv__lookup')
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

describe('model fallback', () => {
  const backupConfig = {
    id: 'mock-backup',
    kind: 'mock' as const,
    label: 'Backup',
    baseUrl: '',
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

  it('does not hide a partial answer by switching models mid-stream', async () => {
    const primary = new ScriptedProvider([
      { text: 'resposta parcial', error: '402 payment required', errorKind: 'quota' }
    ])
    const backup = new ScriptedProvider([{ text: 'não deveria ser chamado' }])
    const { runner, events } = withFallback(primary, backup)

    await runner.send('oi')

    expect(runner.state).toBe('error')
    expect(backup.requests).toHaveLength(0)
    const failed = runner.messages.find((m) => m.role === 'assistant' && m.error)
    expect(failed?.parts[0]).toMatchObject({ type: 'text', text: 'resposta parcial' })
    expect(events.some((e) => e.type === 'notice' && e.level === 'error')).toBe(true)
  })

  it('reports a real error when every model in the fallback chain fails', async () => {
    const primary = new ScriptedProvider([{ error: '402 payment required', errorKind: 'quota' }])
    const backup = new ScriptedProvider([{ error: '401 invalid api key', errorKind: 'auth' }])
    const { runner } = withFallback(primary, backup, { retryBaseMs: 0 })

    await runner.send('oi')

    expect(runner.state).toBe('error')
    expect(runner.messages.at(-1)?.error).toContain('401')
  })
})
