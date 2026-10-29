import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { HookRunner } from '../src/core/hooks/runner'
import { classifyProviderError, postStream, readSse, retryAfterMs } from '../src/core/providers/http'
import { OpenAICompatibleProvider, toOpenAIMessages } from '../src/core/providers/openai'
import { AnthropicProvider } from '../src/core/providers/anthropic'
import { resolveCompat } from '../src/core/providers/compat'
import { ComputerLayer, resolveOcu, screenshotToScreen } from '../src/core/computer/layer'
import { McpClient } from '../src/core/mcp/client'
import { bundledBinary, resetResourcesCache } from '../src/core/util/resources'
import { computerClickTool, computerActivateTool } from '../src/core/tools/computer'
import { runCommandTool, readProcessOutputTool, killSessionProcesses } from '../src/core/tools/shell'
import { DEFAULT_LIMITS, type HarnessEvent, type HooksConfig, type Message, type ProviderConfig } from '../src/shared/types'
import type { ToolContext, ToolDef } from '../src/core/tools/types'
import { isTurnContext } from '../src/core/agent/turn-context'
import { makeTempDir, policy, removeTempDir } from './helpers'

let cwd: string
const servers: http.Server[] = []

beforeEach(async () => {
  cwd = await makeTempDir('openclod-harness-')
})

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.()
          server.close(() => resolve())
        })
    )
  )
  killSessionProcesses('ses_bg')
  await removeTempDir(cwd)
})

const readTool: ToolDef = {
  name: 'read_file',
  description: 'fake read',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: (raw) => ({ title: 'Ler', detail: String((raw as { path: string }).path), preview: String((raw as { path: string }).path) }),
  async execute(raw) {
    return { ok: true, text: `conteúdo de ${(raw as { path: string }).path}`, summary: 'lido' }
  }
}

const writeTool: ToolDef = {
  name: 'write_file',
  description: 'fake write',
  schema: z.object({ path: z.string() }),
  risk: 'write',
  parallelSafe: false,
  describe: (raw) => ({ title: 'Escrever', detail: String((raw as { path: string }).path), preview: String((raw as { path: string }).path) }),
  async execute(raw) {
    return { ok: true, text: `escrito ${(raw as { path: string }).path}` }
  }
}

function makeRunner(provider: ScriptedProvider, overrides: Partial<RunnerDeps> = {}): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_h',
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
    registry: buildRegistry(readTool, writeTool),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 6 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [] }
    } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    retryBaseMs: 1,
    ...overrides
  }
  return { runner: new SessionRunner(deps), events }
}

function textOf(message: Message): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.text : '')).join('\n')
}

/** Writes a hook script and returns the command that runs it. */
function hookScript(name: string, body: string): string {
  const file = path.join(cwd, `${name}.cjs`)
  fs.writeFileSync(file, body)
  return `node "${file}"`
}

describe('agent loop robustness', () => {
  it('puts saved project facts in the per-turn context, not in the cached system prompt', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }, { text: 'ok de novo' }])
    const services = {
      browser: {},
      computer: {},
      skills: { list: () => [] },
      memory: { all: async () => [{ id: 'm', text: 'este projeto usa pnpm, nunca npm', ts: 1, tags: [] }] }
    } as unknown as RunnerDeps['services']
    const { runner } = makeRunner(provider, { services })
    await runner.send('instale as dependências')
    // The system prompt is the cached prefix: facts live in the hidden message that follows the user's request.
    expect(provider.requests[0].system).not.toContain('este projeto usa pnpm, nunca npm')
    const context = provider.requests[0].messages.filter(isTurnContext).map(textOf).join('\n')
    expect(context).toContain('## Fatos salvos com memory_write')
    expect(context).toContain('este projeto usa pnpm, nunca npm')
    // Unchanged facts are not repeated on the next turn.
    await runner.send('e agora?')
    expect(provider.requests[1].messages.filter(isTurnContext)).toHaveLength(1)
  })

  it('compacts and retries once when the provider reports a context overflow', async () => {
    const history: Message[] = Array.from({ length: 12 }, (_, i) => ({
      id: `h${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      ts: i,
      parts: [{ type: 'text', text: `mensagem antiga ${i}` }]
    }))
    const provider = new ScriptedProvider([
      { error: 'prompt is too long: 250000 tokens > 200000 maximum', errorKind: 'context_overflow' },
      { text: 'RESUMO DAS MENSAGENS ANTIGAS' },
      { text: 'feito depois da compactação' }
    ])
    const { runner, events } = makeRunner(provider, { initial: { messages: history } })
    await runner.send('continue')

    expect(provider.requests).toHaveLength(3)
    expect(runner.state).toBe('done')
    expect(textOf(runner.messages[0])).toContain('RESUMO DAS MENSAGENS ANTIGAS')
    expect(events.some((e) => e.type === 'notice' && e.text.includes('janela de contexto'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' })
  })

  it('asks the model to continue when output is cut by the length limit', async () => {
    const provider = new ScriptedProvider([{ text: 'parte 1', stopReason: 'length' }, { text: 'parte 2' }])
    const { runner, events } = makeRunner(provider)
    await runner.send('escreva um texto longo')

    expect(provider.requests).toHaveLength(2)
    const second = provider.requests[1].messages
    expect(second.some((m) => m.hidden && textOf(m).includes('Continue exatamente de onde parou'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'stop' })
  })

  it('ends the iteration budget with a tool-free summary instead of a bare error', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'Resumo: li a.txt; falta escrever b.txt.' }
    ])
    const { runner, events } = makeRunner(provider, { limits: { ...DEFAULT_LIMITS, maxIterations: 2 } })
    await runner.send('tarefa longa')

    expect(provider.requests[0].toolChoice).toBeUndefined()
    expect(provider.requests[1].toolChoice).toBe('none')
    expect(provider.requests[1].tools.length).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'length' })
    expect(runner.state).toBe('done')
  })

  it('repairs string-typed numeric arguments from local models', async () => {
    const numberTool: ToolDef = {
      name: 'read_file',
      description: 'read with limit',
      schema: z.object({ path: z.string(), limit: z.number().int() }),
      risk: 'read',
      parallelSafe: true,
      describe: () => ({ title: 'Ler', detail: '' }),
      async execute(raw) {
        const args = raw as { limit: number }
        return { ok: true, text: `limit=${args.limit} tipo=${typeof args.limit}` }
      }
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a', limit: '10' } }] },
      { text: 'ok' }
    ])
    const { runner } = makeRunner(provider, { registry: buildRegistry(numberTool) })
    await runner.send('leia')
    const toolMessage = runner.messages.find((m) => m.role === 'tool')!
    expect(textOf(toolMessage)).toContain('limit=10 tipo=number')
  })
})

describe('hooks (Claude Code format)', () => {
  it('PreToolUse exit code 2 blocks the tool and feeds stderr to the model', async () => {
    const command = hookScript('block', "process.stderr.write('proibido ler isso'); process.exit(2)")
    const hooks = new HookRunner({ PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command }] }] }, cwd, 'ses_h')
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'segredo.txt' } }] },
      { text: 'entendido' }
    ])
    const { runner, events } = makeRunner(provider, { hooks })
    await runner.send('leia')

    const end = events.find((e) => e.type === 'tool_end')
    expect(end).toMatchObject({ ok: false, summary: 'bloqueado por hook' })
    expect(textOf(runner.messages.find((m) => m.role === 'tool')!)).toContain('proibido ler isso')
  })

  it('PreToolUse JSON can rewrite the input and approve without asking', async () => {
    const command = hookScript(
      'rewrite',
      `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);
       process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow',updatedInput:{path:p.tool_input.file_path+'.bak'}}}))})`
    )
    const hooks = new HookRunner({ PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command }] }] }, cwd, 'ses_h')
    const approve = vi.fn(async () => false)
    const provider = new ScriptedProvider([{ toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt' } }] }, { text: 'ok' }])
    const { runner } = makeRunner(provider, { hooks, approve, policy: policy({ mode: 'ask' }) })
    await runner.send('escreva')

    expect(approve).not.toHaveBeenCalled()
    expect(textOf(runner.messages.find((m) => m.role === 'tool')!)).toContain('escrito a.txt.bak')
  })

  it('UserPromptSubmit stdout becomes context and a Stop hook can send the agent back to work', async () => {
    const context = hookScript('ctx', "process.stdout.write('lembrete: rode os testes')")
    const flag = path.join(cwd, 'stop.flag').replace(/\\/g, '/')
    const stop = hookScript(
      'stop',
      `const fs=require('fs');if(!fs.existsSync('${flag}')){fs.writeFileSync('${flag}','1');process.stderr.write('os testes não foram rodados');process.exit(2)}`
    )
    const config: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: context }] }],
      Stop: [{ hooks: [{ type: 'command', command: stop }] }]
    }
    const provider = new ScriptedProvider([{ text: 'pronto' }, { text: 'testes rodados' }])
    const { runner } = makeRunner(provider, { hooks: new HookRunner(config, cwd, 'ses_h') })
    await runner.send('faça a tarefa')

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[0].messages.some((m) => m.hidden && textOf(m).includes('lembrete: rode os testes'))).toBe(true)
    expect(provider.requests[1].messages.some((m) => m.hidden && textOf(m).includes('os testes não foram rodados'))).toBe(true)
  })

  it('a blocking UserPromptSubmit hook stops the turn before the model is called', async () => {
    const command = hookScript('deny', "process.stderr.write('fora do horário'); process.exit(2)")
    const provider = new ScriptedProvider([{ text: 'não deveria' }])
    const { runner, events } = makeRunner(provider, {
      hooks: new HookRunner({ UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] }, cwd, 'ses_h')
    })
    await runner.send('oi')
    expect(provider.requests).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'error' })
  })
})

async function capture(handler: (body: any, res: http.ServerResponse) => void): Promise<{ url: string; bodies: any[] }> {
  const bodies: any[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c)).on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      bodies.push(body)
      handler(body, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }
}

function sse(res: http.ServerResponse, frames: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
  res.end()
}

const user: Message = { id: 'u', role: 'user', ts: 1, parts: [{ type: 'text', text: 'oi' }] }

describe('provider wire formats and errors', () => {
  it('classifies provider failures', () => {
    expect(classifyProviderError(400, 'This model maximum context length is 128000 tokens')).toBe('context_overflow')
    expect(classifyProviderError(429, 'You exceeded your current quota')).toBe('quota')
    expect(classifyProviderError(429, 'Rate limit reached')).toBe('rate_limit')
    expect(classifyProviderError(529, 'Overloaded')).toBe('overloaded')
    expect(classifyProviderError(401, 'invalid x-api-key')).toBe('auth')
    expect(classifyProviderError(undefined, 'fetch failed')).toBe('network')
    expect(classifyProviderError(400, 'bad field')).toBe('bad_request')
  })

  it('honours Retry-After on 429', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0.05' })
        res.end('rate limit')
        return
      }
      res.writeHead(200)
      res.end('ok')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const delays: number[] = []
    const response = await postStream({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      headers: {},
      body: {},
      onRetry: (_a, _e, delay) => delays.push(delay)
    })
    expect(response.status).toBe(200)
    expect(delays).toEqual([50])
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500)
  })

  it('abandons a stream that goes silent', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"a":1}\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    const frames: string[] = []
    await expect(
      (async () => {
        for await (const frame of readSse(response.body!, 150)) frames.push(frame.data)
      })()
    ).rejects.toThrow(/ociosa/)
    expect(frames).toEqual(['{"a":1}'])
  })

  it('omits temperature and uses max_completion_tokens for OpenAI reasoning models', async () => {
    const server = await capture((_b, res) => sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
    const config: ProviderConfig = {
      id: 'o',
      kind: 'openai',
      label: 'o',
      baseUrl: server.url,
      model: 'openai/o4-mini',
      contextWindow: 200_000,
      supportsVision: false,
      supportsTools: true,
      temperature: 0.3,
      maxOutputTokens: 500
    }
    const provider = new OpenAICompatibleProvider(config, 'k')
    for await (const _ of provider.stream({ system: 's', messages: [user], tools: [] })) void _
    expect(server.bodies[0].temperature).toBeUndefined()
    expect(server.bodies[0].max_completion_tokens).toBe(500)
    expect(server.bodies[0].max_tokens).toBeUndefined()
    expect(resolveCompat({ model: 'gpt-4.1', baseUrl: 'http://x', compat: undefined }).omitTemperature).toBe(false)
  })

  it('echoes reasoning only inside the current tool loop for thinking models', () => {
    const messages: Message[] = [
      { id: '1', role: 'user', ts: 1, parts: [{ type: 'text', text: 'antes' }] },
      { id: '2', role: 'assistant', ts: 2, parts: [{ type: 'reasoning', text: 'raciocínio antigo' }, { type: 'text', text: 'oi' }] },
      { id: '3', role: 'user', ts: 3, parts: [{ type: 'text', text: 'agora' }] },
      { id: '4', role: 'assistant', ts: 4, parts: [{ type: 'reasoning', text: 'raciocínio atual' }, { type: 'tool_call', id: 't', name: 'read_file', args: {} }] },
      { id: '5', role: 'tool', ts: 5, parts: [{ type: 'tool_result', toolCallId: 't', name: 'read_file', ok: true, text: 'x' }] }
    ]
    const out = toOpenAIMessages('', messages, true)
    const assistants = out.filter((m) => m.role === 'assistant')
    expect(assistants[0].reasoning_content).toBeUndefined()
    expect(assistants[1].reasoning_content).toBe('raciocínio atual')
    expect(toOpenAIMessages('', messages, false).some((m) => m.reasoning_content)).toBe(false)
  })

  it('marks Anthropic cache breakpoints and honours tool_choice none', async () => {
    const server = await capture((_b, res) =>
      sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'oi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
      ])
    )
    const provider = new AnthropicProvider(
      { id: 'a', kind: 'anthropic', label: 'a', baseUrl: server.url, model: 'claude-x', contextWindow: 200_000, supportsVision: true, supportsTools: true },
      'k'
    )
    const events = []
    for await (const event of provider.stream({
      system: 'sistema',
      messages: [user],
      tools: [{ name: 't1', description: 'd', parameters: { type: 'object' } }, { name: 't2', description: 'd', parameters: { type: 'object' } }],
      toolChoice: 'none'
    }))
      events.push(event)
    const body = server.bodies[0]
    expect(body.system[0]).toMatchObject({ type: 'text', text: 'sistema', cache_control: { type: 'ephemeral' } })
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tool_choice).toEqual({ type: 'none' })
    expect(body.temperature).toBeUndefined()
    expect(events).toContainEqual({ type: 'usage', usage: { input: 100, output: 2, cachedInput: 90 } })
  })
})

const FAKE_OCU = `
// Minimal stand-in for open-computer-use's MCP mode: snapshots live only in
// this process, like the real backend.
const snapshots = new Set()
let buffer = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const text = (t, isError) => ({ content: [{ type: 'text', text: t }], isError: Boolean(isError) })
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    const args = (msg.params && msg.params.arguments) || {}
    let result
    if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-ocu' } }
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'click' }, { name: 'get_app_state' }] }
    else if (msg.params.name === 'get_app_state') { snapshots.add(args.app); result = text('0 button "OK"') }
    else if (msg.params.name === 'click') {
      if (args.app === 'ghost') result = text('app not found: ghost', true)
      else if (!snapshots.has(args.app)) result = text('No app state is available for ' + args.app + '. Run get_app_state before action tools.', true)
      else result = text('clicked ' + args.app + '#' + args.element_index)
    }
    else if (msg.params.name === 'activate_window') result = typeof args.window === 'object' ? text('activated ' + args.window.id) : text('window must be an object with an integer id', true)
    else if (msg.params.name === 'launch_app') result = process.env.OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH === '1' ? text('launched') : text('launch_app is disabled by default', true)
    else result = text('unknown', true)
    send({ jsonrpc: '2.0', id: msg.id, result })
  }
})
`

describe('computer use backend', () => {
  it('converts screenshot coordinates back to the virtual desktop', () => {
    const capture = { originX: -1920, originY: 0, scale: 1600 / 3840, width: 1600, height: 451 }
    expect(screenshotToScreen({ x: 800, y: 200 }, capture)).toEqual({ x: 0, y: 480 })
    expect(screenshotToScreen({ x: 10, y: 10 }, null)).toEqual({ x: 10, y: 10 })
  })

  it.runIf(process.platform === 'win32')('keeps one backend process so element actions see the snapshot, and reports failures', async () => {
    fs.writeFileSync(path.join(cwd, 'fake-ocu.js'), FAKE_OCU)
    const cmd = path.join(cwd, 'fake-ocu.cmd')
    fs.writeFileSync(cmd, `@node "%~dp0fake-ocu.js" %*\r\n`)
    const layer = new ComputerLayer(cmd)
    layer.configure({ allowControl: true })
    try {
      // No snapshot yet: the layer takes one and retries instead of failing.
      const click = await layer.clickElement({ app: 'notepad' }, 3)
      expect(click).toMatchObject({ ok: true, text: 'clicked notepad#3' })
      expect(await layer.activateWindow(42)).toMatchObject({ ok: true, text: 'activated 42' })
      expect(await layer.launchApp('notepad')).toMatchObject({ ok: true })

      const ctx = {
        policy: policy({ allowComputerControl: true }),
        services: { computer: layer },
        signal: new AbortController().signal
      } as unknown as ToolContext
      const failed = await computerClickTool.execute({ app: 'ghost', element_index: 0 }, ctx)
      expect(failed.ok).toBe(false)
      expect(failed.text).toContain('app not found')
      expect((await computerActivateTool.execute({ window: 7 }, ctx)).ok).toBe(true)

      const blocked = await computerClickTool.execute({ app: 'notepad', element_index: 0 }, { ...ctx, policy: policy() } as ToolContext)
      expect(blocked.ok).toBe(false)
      expect(blocked.text).toContain('allowComputerControl')
    } finally {
      await layer.close()
    }
  })
})

describe('open-computer-use binary resolution', () => {
  const ENV_KEYS = ['OPENCLOD_OCU', 'OPENCLOD_OCU_BIN', 'OCU_BIN', 'OPENCLOD_RESOURCES', 'APPDATA', 'USERPROFILE', 'PATH'] as const
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const EXE = process.platform === 'win32' ? 'open-computer-use.exe' : 'open-computer-use'
  const NPM_RELATIVE = 'npm/node_modules/@opensymph/open-computer-use/dist/windows/amd64/open-computer-use.exe'
  let sandbox: string

  function touch(...parts: string[]): string {
    const file = path.join(sandbox, ...parts)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fake')
    return file
  }

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(cwd, 'ocu-'))
    for (const key of ['OPENCLOD_OCU', 'OPENCLOD_OCU_BIN', 'OCU_BIN']) delete process.env[key]
    process.env.OPENCLOD_RESOURCES = path.join(sandbox, 'resources')
    process.env.APPDATA = path.join(sandbox, 'appdata')
    process.env.USERPROFILE = path.join(sandbox, 'home')
    process.env.PATH = path.join(sandbox, 'pathdir')
    fs.mkdirSync(process.env.OPENCLOD_RESOURCES, { recursive: true })
    fs.writeFileSync(path.join(process.env.OPENCLOD_RESOURCES, 'MANIFEST.json'), '{"version":1,"entries":[]}')
    resetResourcesCache()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    resetResourcesCache()
  })

  it('goes explicit path > OPENCLOD_OCU > bundled > npm global > PATH, and null disables the backend', () => {
    const explicit = touch('explicit', 'ocu.exe')
    const fromEnv = touch('env', 'ocu.exe')
    const bundled = touch('resources', 'bin', EXE)
    const npm = touch('appdata', NPM_RELATIVE)
    const onPath = touch('pathdir', EXE)
    process.env.OPENCLOD_OCU = fromEnv

    expect(resolveOcu(explicit)).toEqual({ path: explicit, source: 'explicit' })
    expect(resolveOcu()).toEqual({ path: fromEnv, source: 'env' })

    delete process.env.OPENCLOD_OCU
    expect(resolveOcu()).toEqual({ path: bundled, source: 'bundled' })

    fs.rmSync(bundled)
    expect(resolveOcu()).toEqual({ path: npm, source: 'npm' })

    fs.rmSync(npm)
    expect(resolveOcu()).toEqual({ path: onPath, source: 'path' })

    fs.rmSync(onPath)
    expect(resolveOcu()).toBeNull()

    // null means "no backend", whatever else exists.
    touch('resources', 'bin', EXE)
    expect(resolveOcu(null)).toBeNull()
  })

  it('skips missing candidates: a stale explicit path or env var falls through to the next step', () => {
    const bundled = touch('resources', 'bin', EXE)
    process.env.OPENCLOD_OCU = path.join(sandbox, 'gone', 'ocu.exe')
    expect(resolveOcu(path.join(sandbox, 'also-gone.exe'))).toEqual({ path: bundled, source: 'bundled' })
    const legacy = touch('legacy', 'ocu.exe')
    process.env.OCU_BIN = legacy
    expect(resolveOcu()).toEqual({ path: legacy, source: 'env' })
  })

  it('prefers the bundled copy over a user-installed one on PATH', () => {
    const bundled = touch('resources', 'bin', EXE)
    touch('pathdir', EXE)
    expect(resolveOcu()?.path).toBe(bundled)
  })

  it.runIf(process.platform === 'win32')('ComputerLayer reports availability and where the helper came from', () => {
    expect(new ComputerLayer(null).available).toBe(false)
    expect(new ComputerLayer().available).toBe(false)
    const bundled = touch('resources', 'bin', EXE)
    const layer = new ComputerLayer()
    expect(layer.available).toBe(true)
    expect(layer.status().detail).toContain(bundled)
    expect(layer.status().detail).toContain('(bundled)')
    const explicit = touch('explicit', 'ocu.exe')
    expect(new ComputerLayer(explicit).status().detail).toContain('(explicit)')
  })
})

describe('bundled open-computer-use.exe', () => {
  it.runIf(process.platform === 'win32')('matches MANIFEST.json, reports its version, and speaks MCP over stdio', async () => {
    delete process.env.OPENCLOD_RESOURCES
    resetResourcesCache()
    const bundled = bundledBinary('open-computer-use')
    expect(bundled, 'run `npm run embed:bin` to bundle resources/bin/open-computer-use.exe').not.toBeNull()
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(bundled!)), 'MANIFEST.json'), 'utf8')) as {
      entries: Array<{ name: string; version: string; sha256: string; size: number }>
    }
    const entry = manifest.entries.find((e) => e.name === 'open-computer-use')
    expect(entry).toBeDefined()
    expect(createHash('sha256').update(fs.readFileSync(bundled!)).digest('hex')).toBe(entry!.sha256)
    expect(fs.statSync(bundled!).size).toBe(entry!.size)

    const version = spawnSync(bundled!, ['--version'], { encoding: 'utf8', windowsHide: true })
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(entry!.version)

    // The harness resolves it without any env or PATH help.
    for (const key of ['OPENCLOD_OCU', 'OPENCLOD_OCU_BIN', 'OCU_BIN']) delete process.env[key]
    expect(resolveOcu()?.path.toLowerCase()).toBe(bundled!.toLowerCase())

    const client = new McpClient({ name: 'open-computer-use', command: bundled!, args: ['mcp'] })
    try {
      await client.start(30_000)
      const names = client.toolsList().map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['get_app_state', 'click', 'type_text', 'list_apps']))
    } finally {
      await client.stop()
    }
  })
})

describe('background processes', () => {
  it('runs a command in the background and reads its output incrementally', async () => {
    fs.writeFileSync(path.join(cwd, 'bg.js'), "console.log('linha 1'); setTimeout(() => { console.log('linha 2') }, 400)")
    const ctx = {
      sessionId: 'ses_bg',
      cwd,
      workspace: new WorkspaceGuard([cwd]),
      policy: policy(),
      signal: new AbortController().signal,
      emit: () => undefined,
      log: () => undefined
    } as unknown as ToolContext
    const started = await runCommandTool.execute({ command: 'node bg.js', run_in_background: true }, ctx)
    expect(started.ok).toBe(true)
    const pid = (started.data as { pid: number }).pid

    const first = await readProcessOutputTool.execute({ pid, wait_ms: 5000 }, ctx)
    expect(first.text).toContain('linha 1')
    let all = first.text
    for (let i = 0; i < 20 && !all.includes('linha 2'); i++) {
      const next = await readProcessOutputTool.execute({ pid, wait_ms: 1000 }, ctx)
      expect(next.text).not.toContain('linha 1')
      all += next.text
    }
    expect(all).toContain('linha 2')
    const unknown = await readProcessOutputTool.execute({ pid: 999999 }, ctx)
    expect(unknown.ok).toBe(false)
  })
})
