import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { McpClient, type McpServerConfig } from '../src/core/mcp/client'
import { buildMcpToolDefs, type McpToolBuild } from '../src/core/mcp/tools'
import { createMcpTools } from '../src/core/tools/mcp'
import { lazyTools } from '../src/core/tools/lazy'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import type { McpToolService, ToolContext, ToolDef } from '../src/core/tools/types'
import { DEFAULT_LIMITS, type AgentMode, type ApprovalRequest, type McpServerSettings, type PolicyConfig } from '../src/shared/types'
import { ScriptedProvider, type MockTurn } from './support/scripted-provider'
import { fakeStdio } from './support/fake-mcp'
import { isTurnContext } from '../src/core/agent/turn-context'
import { makeTempDir, policy, removeTempDir } from './helpers'

/** The text of the hidden per-turn context(s) of one provider request. */
function turnContextText(request: { messages: Array<import('../src/shared/types').Message> }): string {
  return request.messages
    .filter(isTurnContext)
    .map((message) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .join('\n')
}

/**
 * Every tool of every connected MCP server becomes a tool of its own (mcp__server__tool): names, schemas, risk,
 * approval, lazy loading through tool_search/tool_load and the call itself, driven through the real runner.
 */
let cwd = ''
let clients: McpClient[] = []
let settings: Record<string, McpServerSettings> = {}

beforeEach(async () => {
  cwd = await makeTempDir('openclod-mcp-fc-')
  clients = []
  settings = {}
})

afterEach(async () => {
  await Promise.all(clients.map((client) => client.stop(300).catch(() => undefined)))
  await removeTempDir(cwd)
})

async function connect(name: string, options: Record<string, unknown>, extra: Partial<McpServerConfig> = {}): Promise<McpClient> {
  const config = fakeStdio(name, options, extra)
  const client = new McpClient(config)
  clients.push(client)
  await client.start(10_000)
  settings[name] = { ...(extra as Partial<McpServerSettings>), name, command: config.command, args: config.args, enabled: true }
  return client
}

function build(inlineLimit?: number): McpToolBuild {
  return buildMcpToolDefs({
    hosts: clients,
    settings: (name) => settings[name],
    getHost: (name) => clients.find((client) => client.name === name),
    inlineLimit
  })
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'ses_test',
    cwd,
    mode: 'code',
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides
  } as unknown as ToolContext
}

function byName(tools: ToolDef[], name: string): ToolDef {
  const found = tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`ferramenta ausente: ${name} (há: ${tools.map((tool) => tool.name).join(', ')})`)
  return found
}

describe('building the tools', () => {
  it('names, describes and classifies every tool of every ready server', async () => {
    await connect('docs', { only: ['echo', 'add', 'plain', 'delete_issue'] })
    await connect('bad', { only: ['union_tool', 'bad schema!', 'echo'] })
    const { tools, skipped, plan } = build()

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__bad__echo',
      'mcp__bad__union_tool',
      'mcp__docs__echo',
      'mcp__docs__add',
      'mcp__docs__delete_issue',
      'mcp__docs__plain'
    ])
    expect(plan.get('docs')).toBe('inline')

    const echo = byName(tools, 'mcp__docs__echo')
    expect(echo).toMatchObject({ risk: 'read', parallelSafe: true, approval: undefined, mcp: { server: 'docs', tool: 'echo', deferred: false, title: 'Echo' } })
    expect(echo.jsonSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
    expect(byName(tools, 'mcp__docs__plain')).toMatchObject({ risk: 'exec', parallelSafe: false })
    expect(byName(tools, 'mcp__docs__delete_issue')).toMatchObject({ risk: 'destructive' })

    // A root anyOf is flattened; a property no model API accepts skips only that tool.
    expect(byName(tools, 'mcp__bad__union_tool').jsonSchema).toMatchObject({ type: 'object', properties: { id: {}, name: {} } })
    expect(byName(tools, 'mcp__bad__union_tool').description).toContain('(id) ou (name)')
    expect(skipped).toEqual([{ server: 'bad', tool: 'bad schema!', reason: expect.stringContaining('nome inválido') }])
  })

  it('marks the tools of a big server as deferred and keeps small servers inline', async () => {
    await connect('docs', { only: ['echo', 'add'] })
    await connect('jira', { only: ['create_issue', 'delete_issue'], toolCount: 20 })
    const { tools, plan } = build()
    expect(plan.get('docs')).toBe('inline')
    expect(plan.get('jira')).toBe('deferred')
    expect(tools.filter((tool) => tool.mcp?.server === 'jira').every((tool) => tool.mcp?.deferred)).toBe(true)
    expect(tools.filter((tool) => tool.mcp?.server === 'docs').every((tool) => !tool.mcp?.deferred)).toBe(true)
    expect(tools.filter((tool) => tool.mcp?.server === 'jira')).toHaveLength(22)
    // alwaysLoad overrides the plan for a server.
    settings.jira = { ...settings.jira, alwaysLoad: true }
    expect(build().tools.filter((tool) => tool.mcp?.server === 'jira').every((tool) => !tool.mcp?.deferred)).toBe(true)
  })

  it('carries the user\'s explicit approval choice and hides denied tools', async () => {
    await connect('jira', { only: ['create_issue', 'delete_issue', 'plain'] }, { toolPolicy: { create_issue: 'allow', delete_issue: 'deny', plain: 'ask' }, approvalTools: [] })
    const { tools } = build()
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__jira__create_issue', 'mcp__jira__plain'])
    expect(byName(tools, 'mcp__jira__create_issue').approval).toBe('allow')
    expect(byName(tools, 'mcp__jira__plain').approval).toBe('ask')
  })

  it('builds nothing for a server that is not ready', async () => {
    const client = await connect('docs', { only: ['echo'] })
    await client.stop()
    expect(build().tools).toEqual([])
  })

  it('caps long descriptions and keeps remote servers behind the network switch', async () => {
    await connect('docs', { only: ['echo'], extraTools: [{ name: 'wordy', description: 'x'.repeat(10_000), inputSchema: { type: 'object', properties: {} } }] })
    expect(byName(build().tools, 'mcp__docs__wordy').description.length).toBeLessThanOrEqual(2_048)
    settings.docs = { ...settings.docs, url: 'https://example.test/mcp' }
    expect(byName(build().tools, 'mcp__docs__echo').requires).toBe('network')
  })
})

describe('running a tool', () => {
  it('calls the server with coerced arguments and returns structured data', async () => {
    await connect('docs', { only: ['add', 'echo'] })
    const { tools } = build()
    const add = byName(tools, 'mcp__docs__add')
    const result = await add.execute({ a: '2', b: '3' }, context())
    expect(result).toMatchObject({ ok: true, text: '{"sum":5}', data: { structuredContent: { sum: 5 } } })
    expect(add.describe({ a: 1 })).toMatchObject({ title: 'MCP docs/add', detail: '{"a":1}', preview: 'docs/add {"a":1}' })
  })

  it('refuses missing required arguments with the parameter list, without calling the server', async () => {
    await connect('docs', { only: ['add'] })
    const result = await byName(build().tools, 'mcp__docs__add').execute({ a: 1 }, context())
    expect(result.ok).toBe(false)
    expect(result.text).toContain('faltam b')
    expect(result.text).toContain('a*: number')
  })

  it('reports progress to the UI card and answers elicitation through ask_user', async () => {
    await connect('docs', { only: ['progress_tool', 'ask_user'] })
    const { tools } = build()
    const progress: string[] = []
    await byName(tools, 'mcp__docs__progress_tool').execute({ steps: 2 }, context({ progress: (text) => progress.push(text) }))
    expect(progress).toEqual(['passo 1 (1/2)', 'passo 2 (2/2)'])

    const asked: unknown[] = []
    const answered = await byName(tools, 'mcp__docs__ask_user').execute(
      {},
      context({
        ask: async (request) => {
          asked.push(request.questions.map((question) => question.header))
          return [{ header: 'Projeto', answers: ['Beta'] }, { header: 'Urgente?', answers: ['Não'] }]
        }
      })
    )
    expect(asked).toEqual([['Projeto', 'Urgente?']])
    expect(answered.text).toBe('elicit:{"action":"accept","content":{"project":"Beta","urgent":false}}')
    // No way to ask the user (a sub-agent without ask_user): the server gets a cancel.
    expect((await byName(tools, 'mcp__docs__ask_user').execute({}, context())).text).toBe('elicit:{"action":"cancel"}')
  })

  it('turns failures into a result with the known fix, and finds reloaded servers at call time', async () => {
    const client = await connect('docs', { only: ['echo', 'rpc_fail', 'fail'] })
    const { tools } = build()
    const fail = await byName(tools, 'mcp__docs__rpc_fail').execute({}, context())
    expect(fail).toMatchObject({ ok: false, summary: 'falhou' })
    expect(fail.text).toContain('MCP -32000: erro do servidor')
    expect(await byName(tools, 'mcp__docs__fail').execute({}, context())).toMatchObject({ ok: false, text: 'falhou de propósito' })

    await client.stop()
    const down = await byName(tools, 'mcp__docs__echo').execute({ text: 'x' }, context())
    expect(down.ok).toBe(false)
    expect(down.text).toContain('não está conectado')
    expect(down.text).toContain('mcp_reload')
    // The same ToolDef works again when the server comes back (nothing was captured at build time).
    await client.start(10_000)
    expect((await byName(tools, 'mcp__docs__echo').execute({ text: 'x' }, context())).text).toBe('echo:x')
  })

  it('says so when the tool vanished from the server\'s list', async () => {
    const client = await connect('docs', { only: ['echo', 'plain'] })
    const tools = build().tools
    client.setPolicy({ excludeTools: ['plain'] })
    const result = await byName(tools, 'mcp__docs__plain').execute({}, context())
    expect(result).toMatchObject({ ok: false, summary: 'ferramenta ausente' })
  })
})

/* ------------------------------------------------------------------ */
/* Through the runner                                                  */
/* ------------------------------------------------------------------ */

function service(): McpToolService {
  const find = (name: string): McpClient => {
    const client = clients.find((item) => item.name === name)
    if (!client) throw new Error(`servidor MCP "${name}" não está disponível`)
    return client
  }
  return {
    call: (server, tool, args, signal, options) => find(server).callTool(tool, args, undefined, signal, options),
    policy: (server, tool) => clients.find((item) => item.name === server)?.policyFor(tool),
    hint: () => undefined,
    list: () =>
      clients.map((client) => ({
        name: client.name,
        state: client.state,
        transport: client.transport,
        tools: client.toolsList().map((tool) => tool.name),
        resources: client.resourcesList(),
        prompts: client.promptsList(),
        resourceTemplates: client.resourceTemplatesList()
      })),
    catalog: () => [],
    schema: () => undefined,
    search: async () => ({ catalog: [], registry: [], installed: [] }),
    install: async () => ({ ok: false }),
    readResource: (server, uri) => find(server).readResource(uri),
    getPrompt: (server, name, args) => find(server).getPrompt(name, args)
  }
}

interface Harness {
  provider: ScriptedProvider
  runner: SessionRunner
  approvals: ApprovalRequest[]
  results(): Array<{ name: string; ok: boolean; text: string }>
  toolNames(request: number): string[]
}

function harness(turns: MockTurn[], options: { mode?: AgentMode; policy?: Partial<PolicyConfig>; approve?: boolean; inlineLimit?: number; withService?: boolean } = {}): Harness {
  const provider = new ScriptedProvider(turns)
  const built = build(options.inlineLimit)
  const mcpService = service()
  const registry = buildRegistry(...lazyTools, ...createMcpTools((server, tool) => mcpService.policy?.(server, tool)), ...built.tools)
  const approvals: ApprovalRequest[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_mcp',
    cwd,
    mode: options.mode ?? 'code',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry,
    policy: policy({ mode: 'ask', ...options.policy }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 12 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] },
      mcp: options.withService === false ? undefined : mcpService
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async (request) => {
      approvals.push(request)
      return options.approve ?? true
    }
  }
  const runner = new SessionRunner(deps)
  return {
    provider,
    runner,
    approvals,
    results: () =>
      runner.messages
        .flatMap((message) => message.parts)
        .filter((part): part is Extract<typeof part, { type: 'tool_result' }> => part.type === 'tool_result')
        .map((part) => ({ name: part.name, ok: part.ok, text: part.text })),
    toolNames: (request) => provider.requests[request].tools.map((tool) => tool.name)
  }
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): MockTurn => ({ toolCalls: [{ id, name, args }] })

describe('through the runner', () => {
  it('sends small servers directly and describes every server in the system prompt', async () => {
    await connect('docs', { only: ['echo', 'add'] })
    await connect('jira', { only: ['create_issue'], toolCount: 20 })
    const h = harness([call('c1', 'mcp__docs__echo', { text: 'oi' }), { text: 'pronto' }], { policy: { mode: 'auto' } })
    await h.runner.send('use o docs')

    const names = h.toolNames(0)
    expect(names).toEqual(expect.arrayContaining(['mcp__docs__echo', 'mcp__docs__add', 'tool_search', 'tool_load']))
    // The indirect path is a fallback: tool_search finds it, tool_load enables it, and it does not ride along every request.
    expect(names).not.toContain('mcp_call')
    expect(names).not.toContain('mcp_catalog')
    expect(names.some((name) => name.startsWith('mcp__jira__'))).toBe(false)
    // The connected servers change as they start and stop, so they travel in the per-turn context and not in the
    // system prompt, whose prefix the provider caches.
    const system = h.provider.requests[0].system
    expect(system).toContain('mcp__<servidor>__<ferramenta>')
    expect(system).not.toContain('- docs: 2 direta(s)')
    const context = turnContextText(h.provider.requests[0])
    expect(context).toContain('## Servidores MCP conectados agora')
    expect(context).toContain('- docs: 2 direta(s): mcp__docs__echo, mcp__docs__add')
    expect(context).toContain('- jira: 21 sob demanda (tool_search("jira") e tool_load)')
    expect(h.results()).toEqual([{ name: 'mcp__docs__echo', ok: true, text: 'echo:oi' }])
  })

  it('finds a deferred server with tool_search, loads all of it with a glob and calls it', async () => {
    await connect('docs', { only: ['echo'] })
    await connect('jira', { only: ['create_issue', 'delete_issue'], toolCount: 20 })
    const h = harness(
      [
        call('s1', 'tool_search', { query: 'jira create' }),
        call('s2', 'tool_load', { tools: ['mcp__jira__*'] }),
        call('s3', 'mcp__jira__create_issue', { title: 'Login quebrado' }),
        { text: 'criado' }
      ],
      { policy: { mode: 'auto' } }
    )
    await h.runner.send('crie um ticket no jira')

    const [search, load, created] = h.results()
    expect(search.text).toContain('mcp__jira__create_issue')
    expect(search.text).not.toContain('mcp__jira__delete_issue') // "jira create": every word must match
    expect(search.text).not.toContain('mcp__docs__echo') // direct tools are not listed again
    expect(load.text).toContain('habilitadas: ')
    expect(load.text).toContain('mcp__jira__delete_issue')
    expect(load.text).toContain('mcp__jira__bulk_20')
    expect(created).toEqual({ name: 'mcp__jira__create_issue', ok: true, text: 'criado:Login quebrado' })
    expect(h.toolNames(0).some((name) => name.startsWith('mcp__jira__'))).toBe(false)
    expect(h.toolNames(2)).toEqual(expect.arrayContaining(['mcp__jira__create_issue', 'mcp__jira__delete_issue']))
  })

  it('keeps a loaded MCP server for the rest of the session instead of asking again each turn', async () => {
    await connect('jira', { only: ['create_issue'], toolCount: 20 })
    const h = harness(
      [call('l1', 'tool_load', { tools: ['mcp__jira__*'] }), { text: 'carregado' }, call('c1', 'mcp__jira__create_issue', { title: 'outro' }), { text: 'criado' }],
      { policy: { mode: 'auto' } }
    )
    await h.runner.send('carregue o jira')
    await h.runner.send('crie outro ticket')
    expect(h.results().at(-1)).toEqual({ name: 'mcp__jira__create_issue', ok: true, text: 'criado:outro' })
    expect(h.toolNames(2)).toContain('mcp__jira__create_issue')
  })

  it('refuses a deferred tool that was never loaded and points to tool_search', async () => {
    await connect('jira', { only: ['create_issue'], toolCount: 20 })
    const h = harness([call('c1', 'mcp__jira__create_issue', { title: 'x' }), { text: 'ok' }], { policy: { mode: 'auto' } })
    await h.runner.send('x')
    expect(h.results()[0].ok).toBe(false)
    expect(h.results()[0].text).toContain('não está carregada')
    expect(h.results()[0].text).toContain('tool_search')
  })

  it('rejects a glob that matches nothing', async () => {
    await connect('docs', { only: ['echo'] })
    const h = harness([call('l1', 'tool_load', { tools: ['mcp__nada__*'] }), { text: 'ok' }])
    await h.runner.send('x')
    expect(h.results()[0]).toMatchObject({ ok: false })
    expect(h.results()[0].text).toContain('nenhuma ferramenta MCP corresponde')
  })

  it('asks for approval by risk: read-only runs, the rest asks in ask mode', async () => {
    await connect('docs', { only: ['echo', 'plain', 'delete_issue'] })
    const h = harness([call('a', 'mcp__docs__echo', { text: 'x' }), call('b', 'mcp__docs__plain'), call('c', 'mcp__docs__delete_issue', { key: 'K-1' }), { text: 'fim' }], { policy: { mode: 'ask' } })
    await h.runner.send('x')
    expect(h.approvals.map((request) => request.tool)).toEqual(['mcp__docs__plain', 'mcp__docs__delete_issue'])
    expect(h.approvals[1]).toMatchObject({ risk: 'destructive', title: 'MCP docs/delete_issue', preview: 'docs/delete_issue {"key":"K-1"}' })
    expect(h.results().map((result) => result.ok)).toEqual([true, true, true])
  })

  it('in auto mode only destructive tools ask, and a denial reaches the model', async () => {
    await connect('docs', { only: ['plain', 'delete_issue'] })
    const h = harness([call('b', 'mcp__docs__plain'), call('c', 'mcp__docs__delete_issue', { key: 'K-1' }), { text: 'fim' }], { policy: { mode: 'auto' }, approve: false })
    await h.runner.send('x')
    expect(h.approvals.map((request) => request.tool)).toEqual(['mcp__docs__delete_issue'])
    expect(h.results()[0]).toMatchObject({ ok: true, text: 'plain-ok' })
    expect(h.results()[1].ok).toBe(false)
    expect(h.results()[1].text).toContain('o usuário negou')
  })

  it('applies toolPolicy: ask beats unrestricted mode, allow skips the prompt, deny removes the tool', async () => {
    await connect('docs', { only: ['plain', 'create_issue', 'delete_issue'] }, { toolPolicy: { plain: 'ask', create_issue: 'allow', delete_issue: 'deny' } })
    const h = harness(
      [call('a', 'mcp__docs__plain'), call('b', 'mcp__docs__create_issue', { title: 't' }), call('c', 'mcp__docs__delete_issue', { key: 'K' }), { text: 'fim' }],
      { policy: { mode: 'unrestricted' } }
    )
    await h.runner.send('x')
    expect(h.approvals.map((request) => request.tool)).toEqual(['mcp__docs__plain'])
    expect(h.results().map((result) => [result.name, result.ok])).toEqual([
      ['mcp__docs__plain', true],
      ['mcp__docs__create_issue', true],
      ['mcp__docs__delete_issue', false]
    ])
    expect(h.results()[2].text).toContain('ferramenta desconhecida')
    expect(h.toolNames(0)).not.toContain('mcp__docs__delete_issue')

    const askMode = harness([call('b', 'mcp__docs__create_issue', { title: 't' }), { text: 'fim' }], { policy: { mode: 'ask' } })
    await askMode.runner.send('x')
    expect(askMode.approvals).toEqual([])
  })

  it('plan and review modes only get tools that declare themselves read-only', async () => {
    await connect('docs', { only: ['echo', 'plain'] })
    const h = harness([{ text: 'planejado' }], { mode: 'plan' })
    await h.runner.send('x')
    expect(h.toolNames(0)).toContain('mcp__docs__echo')
    expect(h.toolNames(0)).not.toContain('mcp__docs__plain')
    expect(turnContextText(h.provider.requests[0])).toContain('- docs: 1 direta(s): mcp__docs__echo')
  })

  it('mcp_call asks exactly like the direct tool and refuses what the policy hides', async () => {
    await connect('docs', { only: ['echo', 'plain', 'delete_issue'] }, { toolPolicy: { delete_issue: 'deny' } })
    const h = harness(
      [
        call('l', 'tool_load', { tools: ['mcp_call'] }),
        call('a', 'mcp_call', { server: 'docs', tool: 'echo', arguments: { text: 'x' } }),
        call('b', 'mcp_call', { server: 'docs', tool: 'plain' }),
        call('c', 'mcp_call', { server: 'docs', tool: 'delete_issue', arguments: { key: 'K' } }),
        { text: 'fim' }
      ],
      { policy: { mode: 'ask' } }
    )
    await h.runner.send('x')
    expect(h.approvals.map((request) => [request.tool, request.risk])).toEqual([['mcp_call', 'exec']])
    const results = h.results().slice(1)
    expect(results[0]).toMatchObject({ ok: true, text: 'echo:x' })
    expect(results[1]).toMatchObject({ ok: true, text: 'plain-ok' })
    expect(results[2].ok).toBe(false)
    expect(results[2].text).toContain('desativada pela configuração')
  })

  it('finds mcp_catalog and mcp_call with tool_search, loads them with tool_load, then calls through', async () => {
    await connect('docs', { only: ['echo'] })
    const h = harness(
      [
        call('s1', 'tool_search', { query: 'mcp_catalog' }),
        call('l1', 'tool_load', { tools: ['mcp_catalog', 'mcp_call'] }),
        call('c2', 'mcp_call', { server: 'docs', tool: 'echo', arguments: { text: 'y' } }),
        { text: 'ok' }
      ],
      { policy: { mode: 'auto' } }
    )
    await h.runner.send('x')
    const [search, load, called] = h.results()
    expect(search.text).toContain('mcp_catalog')
    expect(load.text).toContain('habilitadas: mcp_catalog, mcp_call')
    expect(called).toMatchObject({ name: 'mcp_call', ok: true, text: 'echo:y' })
    expect(h.toolNames(0)).not.toContain('mcp_call')
    expect(h.toolNames(2)).toEqual(expect.arrayContaining(['mcp_catalog', 'mcp_call']))
  })

  it('a direct mcp_call loads the indirect path and runs, instead of spending a refused call', async () => {
    await connect('docs', { only: ['echo'] })
    const h = harness([call('c1', 'mcp_call', { server: 'docs', tool: 'echo', arguments: { text: 'x' } }), { text: 'ok' }], { policy: { mode: 'auto' } })
    await h.runner.send('x')
    expect(h.results()).toEqual([{ name: 'mcp_call', ok: true, text: 'echo:x' }])
    expect(h.toolNames(0)).not.toContain('mcp_call')
    expect(h.toolNames(1)).toContain('mcp_call')
  })

  it('gives the caller\'s MCP tools to a specialist that names them, even deferred ones', async () => {
    await connect('jira', { only: ['create_issue'], toolCount: 20 })
    const h = harness([{ text: 'ok' }], { policy: { mode: 'auto' } })
    await h.runner.send('x')
    // The tools a child could be given include the deferred ones (it must still tool_load them).
    const ctx = (h.runner as unknown as { callerInfo(signal: AbortSignal): { availableTools: string[] } }).callerInfo(new AbortController().signal)
    expect(ctx.availableTools).toContain('mcp__jira__create_issue')
    expect(ctx.availableTools).toContain('mcp__jira__bulk_20')
  })
})
