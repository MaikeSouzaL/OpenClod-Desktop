import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpClient, McpConnectionLostError, type McpProgress } from '../src/core/mcp/client'
import { FAKE_STDIO_PATH, fakeStdio, isAlive, readPid, waitFor } from './support/fake-mcp'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * The MCP client against the fake stdio server (tests/support): what the spec asks of a client and what made the
 * real servers fail (hung start, dead process, big results, list_changed, elicitation, process trees).
 */
let dir = ''
let clients: McpClient[] = []

function make(options: Record<string, unknown> = {}, extra: Parameters<typeof fakeStdio>[2] = {}): McpClient {
  const client = new McpClient(fakeStdio('fake', options, extra))
  clients.push(client)
  return client
}

beforeEach(async () => {
  dir = await makeTempDir('openclod-mcp-stdio-')
  clients = []
})

afterEach(async () => {
  await Promise.all(clients.map((client) => client.stop(300).catch(() => undefined)))
  await removeTempDir(dir)
})

describe('listings and negotiation', () => {
  it('follows nextCursor on tools, resources, templates and prompts', async () => {
    const client = make({ only: ['echo', 'add', 'plain'], toolCount: 4, pageSize: 2 })
    await client.start(10_000)
    expect(client.toolsList().map((tool) => tool.name)).toEqual(['echo', 'add', 'plain', 'bulk_1', 'bulk_2', 'bulk_3', 'bulk_4'])
    expect(client.resourcesList().map((resource) => resource.name)).toEqual(['README', 'Tarefas', 'Clientes'])
    expect(client.resourceTemplatesList()).toMatchObject([{ uriTemplate: 'issue://{key}', name: 'Ticket' }])
    expect(client.promptsList().map((prompt) => prompt.name)).toEqual(['revisar', 'resumo'])
    // A fresh, paginated listing works on demand too.
    expect((await client.listResources()).length).toBe(3)
    expect((await client.listPrompts()).length).toBe(2)
    expect((await client.listResourceTemplates()).length).toBe(1)
  })

  it('negotiates the protocol version (offers the newest, accepts what the server answers) and keeps annotations', async () => {
    const client = make({ only: ['echo', 'delete_issue', 'plain'], versions: ['2025-03-26'], instructions: 'Use para testes.' })
    await client.start(10_000)
    expect(client.describe()).toMatchObject({ protocolVersion: '2025-03-26', serverName: 'fake', instructions: 'Use para testes.', transport: 'stdio' })
    const tools = Object.fromEntries(client.toolsList().map((tool) => [tool.name, tool]))
    expect(tools.echo).toMatchObject({ title: 'Echo', annotations: { readOnlyHint: true } })
    expect(tools.delete_issue.annotations).toEqual({ destructiveHint: true })
    expect(tools.plain.annotations).toBeUndefined()
  })

  it('refuses a server that answers a protocol version the client does not speak', async () => {
    const client = make({ forceVersion: '2099-01-01' })
    await expect(client.start(10_000)).rejects.toThrow(/versão de protocolo MCP não suportada/)
    expect(client.state).toBe('error')
    expect(client.describe().hint).toContain('2025-06-18')
  })

  it('does not ask for tools a server never offered, and treats "method not found" as zero tools', async () => {
    const client = make({ capabilities: { prompts: {} } })
    await client.start(10_000)
    expect(client.toolsList()).toEqual([])
    expect(client.promptsList().length).toBe(2)
  })
})

describe('per-tool policy at the client', () => {
  it('hides denied tools, lists them with their policy for settings screens and refuses to call them', async () => {
    const client = make(
      { only: ['echo', 'create_issue', 'delete_issue'] },
      { toolPolicy: { delete_issue: 'deny', create_issue: 'allow' }, approvalTools: ['echo'] }
    )
    await client.start(10_000)
    // The model sees two; the settings screen still lists all three so the user can turn delete_issue back on.
    expect(client.exposedToolsList().map((tool) => tool.name)).toEqual(['echo', 'create_issue'])
    expect(client.toolsList().map((tool) => tool.name)).toEqual(['echo', 'create_issue', 'delete_issue'])
    expect(client.hiddenToolCount).toBe(1)
    expect(client.toolPolicies().map((tool) => [tool.name, tool.policy.policy])).toEqual([
      ['echo', 'ask'],
      ['create_issue', 'allow'],
      ['delete_issue', 'deny']
    ])
    await expect(client.callTool('delete_issue', { key: 'X-1' }, 2000)).rejects.toThrow(/desativada pela configuração \(toolPolicy\)/)
    expect(client.requiresApproval('echo')).toBe(true)
    expect(client.requiresApproval('create_issue')).toBe(false)
    expect(client.toolRisk('echo')).toBe('destructive')

    // The policy can change without reconnecting.
    client.setPolicy({ toolPolicy: { '*': 'ask' } })
    expect(client.exposedToolsList().map((tool) => tool.name)).toEqual(['echo', 'create_issue', 'delete_issue'])
    expect(await client.callTool('delete_issue', { key: 'X-1' }, 2000)).toMatchObject({ ok: true, text: 'apagado:X-1' })
  })

  it('treats `_meta.anthropic/requiresUserInteraction` as an always-ask tool', async () => {
    const client = make({ only: ['needs_human', 'plain'] })
    await client.start(10_000)
    expect(client.policyFor('needs_human')).toMatchObject({ policy: 'ask', source: 'meta' })
    expect(client.requiresApproval('needs_human')).toBe(true)
    expect(client.requiresApproval('plain')).toBe(false)
  })
})

describe('tool results', () => {
  it('maps every content type and keeps structuredContent for the UI', async () => {
    const client = make({ only: ['add', 'structured', 'link', 'image', 'fail'] })
    await client.start(10_000)
    const sum = await client.callTool('add', { a: 2, b: 3 }, 5000)
    expect(sum).toMatchObject({ ok: true, text: '{"sum":5}', summary: 'fake/add', data: { server: 'fake', tool: 'add', structuredContent: { sum: 5 } } })
    expect((await client.callTool('structured', {}, 5000)).data).toMatchObject({ structuredContent: { temperature: 22.5, conditions: 'nublado' } })

    const link = await client.callTool('link', {}, 5000)
    expect(link.text).toContain('[link de recurso: README file:///projeto/README.md (text/markdown); leia com mcp_read_resource]')
    expect(link.text).toContain('[recurso db://tarefas]\n[1,2,3]')
    expect(link.text).toContain('[áudio audio/wav')

    const image = await client.callTool('image', {}, 5000)
    expect(image.images).toHaveLength(1)
    expect(image.text).toBe('(1 imagem(ns))')

    expect(await client.callTool('fail', {}, 5000)).toMatchObject({ ok: false, text: 'falhou de propósito' })
  })

  it('cuts a huge output (about 25 000 tokens by default) in the middle and says how to get less or more', async () => {
    const client = make({ only: ['big_output'] })
    await client.start(10_000)
    const result = await client.callTool('big_output', { size: 500_000 }, 20_000)
    expect(result.ok).toBe(true)
    expect(result.text.length).toBeLessThan(101_000)
    expect(result.text).toContain('caracteres omitidos')
    expect(result.text).toContain('maxOutputTokens')
    expect(result.data).toMatchObject({ truncated: true, originalChars: 500_000 })
    // Under the limit: untouched, with a warning above 10 000 tokens.
    const warn = await client.callTool('big_output', { size: 60_000 }, 20_000)
    expect(warn.text.length).toBe(60_000)
    expect(warn.data).toMatchObject({ warning: expect.stringContaining('saída grande') })
    expect(warn.data?.truncated).toBeUndefined()
  })

  it('honours maxOutputTokens from the server settings', async () => {
    const client = make({ only: ['big_output'] }, { maxOutputTokens: 1000 })
    await client.start(10_000)
    const result = await client.callTool('big_output', { size: 50_000 }, 20_000)
    expect(result.text.length).toBeLessThan(4_600)
    expect(result.data).toMatchObject({ truncated: true })
  })
})

describe('progress, cancellation and elicitation', () => {
  it('delivers progress notifications to the caller while the call runs', async () => {
    const client = make({ only: ['progress_tool'] })
    await client.start(10_000)
    const seen: McpProgress[] = []
    const result = await client.callTool('progress_tool', { steps: 3 }, 10_000, undefined, { onProgress: (progress) => seen.push(progress) })
    expect(result.text).toBe('progress-done')
    expect(seen).toEqual([
      { progress: 1, total: 3, message: 'passo 1' },
      { progress: 2, total: 3, message: 'passo 2' },
      { progress: 3, total: 3, message: 'passo 3' }
    ])
  })

  it('does not send a progress token when nobody listens', async () => {
    const client = make({ only: ['progress_tool'] })
    await client.start(10_000)
    expect((await client.callTool('progress_tool', { steps: 2 }, 10_000)).ok).toBe(true)
  })

  it('answers the server\'s elicitation request through the per-call handler (and cancels without one)', async () => {
    const client = make({ only: ['ask_user'] })
    await client.start(10_000)
    let asked: unknown
    const accepted = await client.callTool('ask_user', {}, 10_000, undefined, {
      onElicit: async (request) => {
        asked = request
        return { action: 'accept', content: { project: 'Beta', urgent: true } }
      }
    })
    expect(accepted.text).toBe('elicit:{"action":"accept","content":{"project":"Beta","urgent":true}}')
    expect(asked).toMatchObject({ message: 'Qual projeto?', requestedSchema: { properties: { project: { enum: ['Alfa', 'Beta'] } } } })
    expect((await client.callTool('ask_user', {}, 10_000)).text).toBe('elicit:{"action":"cancel"}')
    const failing = await client.callTool('ask_user', {}, 10_000, undefined, {
      onElicit: async () => {
        throw new Error('janela fechada')
      }
    })
    expect(failing.text).toBe('elicit:{"action":"cancel"}')
  })
})

describe('start and stop are bounded', () => {
  it('gives up on a server that never answers within startTimeoutMs, kills it and says why', async () => {
    const pidFile = path.join(dir, 'hang.pid')
    const client = make({ hangOnStart: true, pidFile }, { startTimeoutMs: 600 })
    const started = Date.now()
    await expect(client.start()).rejects.toThrow(/timeout de MCP fake\.initialize \(600ms\)/)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(client.state).toBe('error')
    expect(client.lastError).toContain('timeout de MCP')
    expect(client.describe().hint).toContain('startTimeoutMs')
    const pid = readPid(pidFile)
    expect(await waitFor(() => !isAlive(pid), 5_000)).toBe(true)
  })

  it('does not let the listings stretch a start without limit', async () => {
    // initialize takes 400 ms of a 600 ms budget and every page is slow: the start still ends, ready or not.
    const client = make({ initializeDelayMs: 400, toolsListDelayMs: 200, pageSize: 1, only: ['echo', 'add'] }, { startTimeoutMs: 600 })
    const started = Date.now()
    await client.start().catch(() => undefined)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('still lists the tools of a server whose handshake used up almost the whole start budget', async () => {
    // initialize answers near the end of the 2 s budget (1.5 s plus the process starting) and tools/list needs another
    // 0.8 s. That is `rea` on a loaded machine (initialize took 19.7 s of 20 s, then tools/list got 274 ms and the server
    // was reported dead): a server that answered initialize is alive and gets a fair time to list.
    const client = make({ initializeDelayMs: 1_500, toolsListDelayMs: 800, only: ['echo', 'add'] }, { startTimeoutMs: 2_000 })
    await client.start()
    expect(client.state).toBe('ready')
    expect(client.toolsList().map((tool) => tool.name)).toEqual(['echo', 'add'])
  })

  it('reports the command that is not installed as a clear error and a hint, without crashing', async () => {
    const client = new McpClient({ name: 'nope', command: 'openclod-comando-que-nao-existe', args: [] })
    clients.push(client)
    const started = Date.now()
    await expect(client.start(10_000)).rejects.toThrow(/ENOENT/)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(client.state).toBe('error')
    expect(client.describe().hint).toContain('não foi encontrado')
  })

  it('puts the server\'s own stderr in the error when it exits during startup', async () => {
    const client = new McpClient({
      name: 'crash',
      command: process.execPath,
      args: ['-e', "console.error('chave de API ausente'); process.exit(2)"]
    })
    clients.push(client)
    await expect(client.start(10_000)).rejects.toThrow(/encerrou \(código 2\).*chave de API ausente/)
    expect(client.lastError).toContain('chave de API ausente')
  })

  it('kills a server that ignores the closing of stdin', async () => {
    const pidFile = path.join(dir, 'stubborn.pid')
    const client = make({ ignoreStdinClose: true, pidFile })
    await client.start(10_000)
    const pid = readPid(pidFile)
    expect(isAlive(pid)).toBe(true)
    const started = Date.now()
    await client.stop(300)
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(await waitFor(() => !isAlive(pid), 5_000)).toBe(true)
    expect(client.state).toBe('stopped')
  })

  // `npx`/`uvx` run through cmd.exe on Windows, so the real server is a grandchild: only taskkill /T reaches it.
  it.skipIf(process.platform !== 'win32')('kills the whole process tree of a server started through a .cmd launcher', async () => {
    const pidFile = path.join(dir, 'tree.pid')
    const launcher = path.join(dir, 'launch.cmd')
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${FAKE_STDIO_PATH}"\r\n`)
    const client = new McpClient({
      name: 'tree',
      command: launcher,
      args: [],
      env: { FAKE_MCP: JSON.stringify({ ignoreStdinClose: true, pidFile }) }
    })
    clients.push(client)
    await client.start(15_000)
    const pid = readPid(pidFile)
    expect(isAlive(pid)).toBe(true)
    await client.stop(300)
    expect(await waitFor(() => !isAlive(pid), 6_000)).toBe(true)
  })

  it('stops promptly a server that exits when stdin closes', async () => {
    const client = make({ only: ['echo'] })
    await client.start(10_000)
    const started = Date.now()
    await client.stop()
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('can be started again after a stop', async () => {
    const client = make({ only: ['echo'] })
    await client.start(10_000)
    await client.stop()
    await client.start(10_000)
    expect((await client.callTool('echo', { text: 'de novo' }, 5000)).text).toBe('echo:de novo')
  })
})

describe('reconnection', () => {
  it('restarts a stdio server that died, with backoff, and shows the state meanwhile', async () => {
    const changes: Array<{ state: string; attempt: number }> = []
    const client = make(
      { only: ['echo', 'die'] },
      { reconnect: { baseDelayMs: 60, maxDelayMs: 200, maxAttempts: 4 }, onStateChange: (c) => changes.push({ state: c.state, attempt: c.reconnectAttempt }) }
    )
    await client.start(10_000)
    const failure = await client.callTool('die', {}, 5_000).catch((err: Error) => err)
    expect(failure).toBeInstanceOf(McpConnectionLostError)
    expect(client.state === 'error' || client.state === 'starting').toBe(true)
    expect(await waitFor(() => client.state === 'ready', 8_000)).toBe(true)
    expect(client.reconnectAttempt).toBe(0)
    expect(changes.some((entry) => entry.state === 'error' && entry.attempt >= 1)).toBe(true)
    expect((await client.callTool('echo', { text: 'voltei' }, 5_000)).text).toBe('echo:voltei')
  })

  it('gives up after maxAttempts and says so', async () => {
    const flag = path.join(dir, 'cannot-start')
    const client = make({ only: ['die'], failIfFile: flag }, { reconnect: { baseDelayMs: 30, maxDelayMs: 60, maxAttempts: 2 } })
    await client.start(10_000)
    fs.writeFileSync(flag, 'x')
    await client.callTool('die', {}, 5_000).catch(() => undefined)
    expect(await waitFor(() => /reconexão esgotada após 2 tentativas/.test(client.lastError ?? ''), 8_000)).toBe(true)
    expect(client.state).toBe('error')
    expect(client.reconnectAttempt).toBe(0)
    // A manual reconnect works once the cause is gone.
    fs.rmSync(flag)
    await client.reconnectNow()
    expect(client.state).toBe('ready')
  })

  it('does not reconnect by itself when the option is off', async () => {
    const client = make({ only: ['die'] })
    await client.start(10_000)
    await client.callTool('die', {}, 5_000).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(client.state).toBe('error')
    expect(client.lastError).toContain('conexão perdida')
  })
})

describe('list_changed', () => {
  it('reloads only that server\'s tools, once for a burst of notifications', async () => {
    const calls: string[] = []
    const client = make(
      { only: ['grow', 'echo'] },
      { listChangedDebounceMs: 100, onToolsChanged: (kind) => calls.push(kind ?? '') }
    )
    await client.start(10_000)
    expect(client.toolsList().map((tool) => tool.name)).toEqual(['echo', 'grow'])
    await Promise.all([client.callTool('grow', {}, 5_000), client.callTool('grow', {}, 5_000), client.callTool('grow', {}, 5_000)])
    expect(await waitFor(() => client.toolsList().some((tool) => tool.name === 'late_tool'), 5_000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(calls).toEqual(['tools'])
    expect(client.state).toBe('ready')
    expect((await client.callTool('late_tool', {}, 5_000)).text).toBe('late-ok')
  })
})
