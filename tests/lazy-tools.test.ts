import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { CORE_TOOL_NAMES, DEFERRED_ESSENTIAL_TOOL_NAMES, TEAM_CORE_TOOL_NAMES, toolListTool, toolLoadTool, toolSearchTool } from '../src/core/tools/lazy'
import type { ToolDef } from '../src/core/tools/types'
import { DEFAULT_LIMITS } from '../src/shared/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('openclod-lazy-')
})

afterEach(async () => {
  await removeTempDir(cwd)
})

const browserNewTab: ToolDef = {
  name: 'browser_new_tab',
  description: 'Abre uma nova aba no navegador de automação.',
  schema: z.object({ url: z.string() }),
  risk: 'read',
  parallelSafe: false,
  describe(raw) {
    return { title: 'Nova aba', detail: String((raw as { url?: string }).url ?? '') }
  },
  async execute(raw) {
    return {
      ok: true,
      text: `aberta ${String((raw as { url?: string }).url ?? '')}`,
      summary: 'aba aberta'
    }
  }
}

const computerClick: ToolDef = {
  name: 'computer_click',
  description: 'Clica em um elemento da tela do Windows.',
  schema: z.object({ element_index: z.number().optional() }),
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  describe() {
    return { title: 'Clique', detail: 'elemento' }
  },
  async execute() {
    return { ok: true, text: 'clicou' }
  }
}

const stub = (name: string, description: string): ToolDef => ({
  name,
  description,
  schema: z.object({}),
  risk: 'read',
  parallelSafe: true,
  describe: () => ({ title: name, detail: '' }),
  async execute() {
    return { ok: true, text: name }
  }
})

function makeRunner(provider: ScriptedProvider, extraTools: ToolDef[] = []): SessionRunner {
  const deps: RunnerDeps = {
    sessionId: 'ses_lazy',
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
    registry: buildRegistry(toolSearchTool, toolListTool, toolLoadTool, browserNewTab, computerClick, ...extraTools),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 8 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async () => true
  }
  return new SessionRunner(deps)
}

describe('on-demand tools', () => {
  it('only sends core tools until tool_load enables a hidden one', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 's1', name: 'tool_search', args: { query: 'browser_new_tab' } }] },
      { toolCalls: [{ id: 's2', name: 'tool_load', args: { tools: ['browser_new_tab'] } }] },
      {
        toolCalls: [
          { id: 's3', name: 'browser_new_tab', args: { url: 'https://github.com' } }
        ]
      },
      { text: 'aba aberta' }
    ])
    const runner = makeRunner(provider)

    await runner.send('abra o github')

    const first = provider.requests[0].tools.map((tool) => tool.name)
    expect(first).toContain('tool_search')
    expect(first).toContain('tool_load')
    expect(first).not.toContain('browser_new_tab')

    // After tool_load, the next request carries the browser schema.
    const afterLoad = provider.requests[2].tools.map((tool) => tool.name)
    expect(afterLoad).toContain('browser_new_tab')

    const calls = runner.messages
      .flatMap((message) => message.parts)
      .filter((part): part is Extract<typeof part, { type: 'tool_call' }> => part.type === 'tool_call')
      .map((part) => part.name)
    expect(calls).toEqual(['tool_search', 'tool_load', 'browser_new_tab'])
    expect(runner.state).toBe('done')
  })

  it('finds computer tools by alias and lists the complete catalog', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 's1', name: 'tool_search', args: { query: 'mouse' } }] },
      { toolCalls: [{ id: 's2', name: 'tool_list', args: {} }] },
      { text: 'ok' }
    ])
    const runner = makeRunner(provider)
    await runner.send('quais ferramentas de mouse existem?')

    const results = runner.messages
      .flatMap((message) => message.parts)
      .filter((part): part is Extract<typeof part, { type: 'tool_result' }> => part.type === 'tool_result')
    const search = results.find((part) => part.name === 'tool_search')
    expect(search?.text).toContain('computer_click')
    const catalog = results.find((part) => part.name === 'tool_list')
    expect(catalog?.text).toContain('computer_click')
    expect(catalog?.text).toContain('browser_new_tab')
  })

  it('finds the former essentials by the words a model uses for them, not only by their names', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'a', name: 'tool_search', args: { query: 'catálogo de skills' } }] },
      { toolCalls: [{ id: 'b', name: 'tool_search', args: { query: 'passagem de bastão' } }] },
      { toolCalls: [{ id: 'c', name: 'tool_search', args: { query: 'estado dos servidores' } }] },
      { text: 'ok' }
    ])
    const runner = makeRunner(provider, [stub('list_skills', 'Instaladas.'), stub('memory_handoff', 'Dono único.'), stub('mcp_servers', 'Diagnóstico.')])
    await runner.send('procure')
    const found = runner.messages
      .flatMap((message) => message.parts)
      .filter((part): part is Extract<typeof part, { type: 'tool_result' }> => part.type === 'tool_result' && part.name === 'tool_search')
      .map((part) => part.text)
    expect(found[0]).toContain('list_skills')
    expect(found[1]).toContain('memory_handoff')
    expect(found[2]).toContain('mcp_servers')
  })

  it('puts a former essential in the tool list from the first call when the user names it, and keeps it for the session', async () => {
    const provider = new ScriptedProvider([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    const runner = makeRunner(provider, [stub('list_skills', 'Instaladas.'), stub('memory_handoff', 'Dono único.'), stub('task', 'Subtarefa.')])
    await runner.send('ola')
    const names = (request: number): string[] => provider.requests[request].tools.map((tool) => tool.name)
    expect(names(0)).not.toContain('memory_handoff')
    await runner.send('Registre um handoff de memória para a próxima sessão: resumo "piso de tokens medido", próximo passo "rodar a suíte". Depois me diga o id.')
    // Not found by the model, not loaded by it: the harness put it there because the request says "handoff".
    expect(names(1)).toContain('memory_handoff')
    expect(names(1)).not.toContain('list_skills')
    // And it stays: the head of the provider's cached prompt does not change back.
    await runner.send('Qual é a próxima task do backlog?')
    expect(names(2)).toContain('memory_handoff')
    // The word `task` is an ordinary word in a request about code, not a request for the generic worker.
    expect(names(2)).not.toContain('task')
  })

  it('loads nothing for a request that does not name it, or for a hidden message', async () => {
    const provider = new ScriptedProvider([{ text: 'a' }, { text: 'b' }])
    const runner = makeRunner(provider, [stub('list_skills', 'Instaladas.'), stub('memory_handoff', 'Dono único.')])
    await runner.send('Corrija o bug do login e rode os testes.')
    await runner.send('Registre um handoff para a próxima sessão.', { hidden: true })
    const names = (request: number): string[] => provider.requests[request].tools.map((tool) => tool.name)
    expect(names(0)).not.toContain('memory_handoff')
    expect(names(1)).not.toContain('memory_handoff')
  })

  it('refuses to load a tool that the mode does not expose', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 's1', name: 'tool_load', args: { tools: ['mcp_catalog'] } }] },
      { text: 'ok' }
    ])
    const runner = makeRunner(provider)
    await runner.send('carregue o catálogo MCP')

    const result = runner.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool_result' && part.name === 'tool_load')
    expect(result).toBeDefined()
    if (result?.type === 'tool_result') {
      expect(result.ok).toBe(false)
      expect(result.text).toContain('não disponível')
    }
  })
})

describe('the always-sent set', () => {
  it('keeps what nearly every session uses and leaves the rest to tool_load', () => {
    const everyday = [
      'read_file', 'write_file', 'edit_file', 'patch_file', 'list_dir', 'grep', 'glob', 'run_command', 'fetch_url', 'web_search',
      'update_plan', 'ask_user', 'report_limitation', 'use_skill', 'memory_page', 'memory_recall', 'memory_write', 'agent',
      'tool_search', 'tool_list', 'tool_load'
    ]
    for (const name of everyday) expect(CORE_TOOL_NAMES.has(name), name).toBe(true)
    // The former essentials: found with tool_search, enabled with tool_load, still in the pool a child agent is built from.
    for (const name of DEFERRED_ESSENTIAL_TOOL_NAMES) expect(CORE_TOOL_NAMES.has(name), name).toBe(false)
    // apply_patch is not a former essential: it is here because Codex/GPT models call it by name without loading it.
    expect([...DEFERRED_ESSENTIAL_TOOL_NAMES].sort()).toEqual(
      ['apply_patch', 'list_agents', 'list_skills', 'mcp_call', 'mcp_catalog', 'mcp_servers', 'memory_brief', 'memory_handoff', 'memory_search', 'task']
    )
    // The delegation helpers are sent only to whoever delegates (team mode, or an agent that may call others).
    for (const name of TEAM_CORE_TOOL_NAMES) {
      expect(CORE_TOOL_NAMES.has(name), name).toBe(false)
      expect(DEFERRED_ESSENTIAL_TOOL_NAMES.has(name), name).toBe(true)
    }
    // Each schema here is paid in every request of every session: growing the set is a decision, not a side effect.
    expect(CORE_TOOL_NAMES.size).toBeLessThanOrEqual(22)
  })
})
