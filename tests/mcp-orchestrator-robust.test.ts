import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSettings } from '../src/shared/types'
import type { ToolRegistry } from '../src/core/tools/registry'
import type { ToolContext } from '../src/core/tools/types'
import { FAKE_STDIO_PATH, isAlive, readPid, waitFor } from './support/fake-mcp'

// An OS vault that works under test (the real one is Electron's safeStorage / DPAPI).
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (data: Buffer) => Buffer.from(data.toString('utf8').slice(4), 'base64').toString('utf8')
  }
}))

const { Orchestrator } = await import('../src/main/orchestrator')

/**
 * The app's MCP orchestration end to end with real child processes: one server that hangs at startup must not hold
 * back the others, a reload touches only the server asked for, `list_changed` reloads one server's tools without
 * restarting anything, per-tool policy and reconnection reach the registry the model sees.
 */
type Orch = InstanceType<typeof Orchestrator>

let dir = ''
let logs: string[] = []

function server(name: string, options: Record<string, unknown>, extra: Partial<McpServerSettings> = {}): McpServerSettings {
  return { name, command: process.execPath, args: [FAKE_STDIO_PATH], env: { FAKE_MCP: JSON.stringify(options) }, enabled: true, ...extra }
}

// The automatic second attempt waits long enough here not to happen inside the tests that are not about it.
async function boot(servers: McpServerSettings[], mcpStartRetryDelayMs = 60_000): Promise<Orch> {
  const orchestrator = new Orchestrator({ userData: dir, broadcast: () => undefined, log: (message) => logs.push(message), mcpStartRetryDelayMs })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  await orchestrator.settings.update({ mcpServers: servers })
  return orchestrator
}

function registry(orchestrator: Orch): ToolRegistry {
  return (orchestrator as unknown as { baseRegistry: ToolRegistry }).baseRegistry
}

interface ServiceLike {
  list(): Array<{ name: string; state: string; error?: string; hint?: string; tools: string[]; deferred?: number; reconnect?: string }>
  reload(server?: string): Promise<{ servers: Array<{ name: string; state: string; tools: number; error?: string; hint?: string }> }>
  hint(server: string, message: string): string | undefined
}

function service(orchestrator: Orch): ServiceLike {
  return (orchestrator as unknown as { mcpToolService(): ServiceLike }).mcpToolService()
}

function ctx(orchestrator: Orch): ToolContext {
  return { signal: new AbortController().signal, log: () => undefined, services: { mcp: service(orchestrator) } } as unknown as ToolContext
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-mcp-orch-'))
  logs = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 })
})

describe('starting the servers', () => {
  it('lets the servers that answer be used while one that hangs is still starting, then reports it as an error', async () => {
    const hungPid = path.join(dir, 'hung.pid')
    const orchestrator = await boot([
      server('hung', { hangOnStart: true, pidFile: hungPid }, { startTimeoutMs: 2_500 }),
      server('alfa', { only: ['echo', 'plain'] }),
      server('beta', { only: ['add'] })
    ])
    try {
      const started = Date.now()
      const restart = orchestrator.restartMcp()
      // The registry gets the fast servers' tools long before the hung one gives up.
      const early = await waitFor(() => Boolean(registry(orchestrator).get('mcp__alfa__echo') && registry(orchestrator).get('mcp__beta__add')), 2_000)
      expect(early).toBe(true)
      expect(Date.now() - started).toBeLessThan(2_300)
      expect(service(orchestrator).list().find((item) => item.name === 'hung')?.state).toBe('starting')

      await restart
      expect(Date.now() - started).toBeLessThan(12_000)
      const states = Object.fromEntries(service(orchestrator).list().map((item) => [item.name, item]))
      expect(states.alfa.state).toBe('ready')
      expect(states.beta.state).toBe('ready')
      expect(states.hung.state).toBe('error')
      expect(states.hung.error).toContain('timeout de MCP hung.initialize')
      expect(states.hung.hint).toContain('startTimeoutMs')
      expect(logs.join('\n')).toContain('MCP hung')
      expect(await waitFor(() => !isAlive(readPid(hungPid)), 5_000)).toBe(true)
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('reloads only the server asked for, and reports what each one ended up as', async () => {
    const pids = { alfa: path.join(dir, 'alfa.pid'), beta: path.join(dir, 'beta.pid') }
    const orchestrator = await boot([
      server('alfa', { only: ['echo'], pidFile: pids.alfa }),
      server('beta', { only: ['add'], pidFile: pids.beta }),
      server('broken', { hangOnStart: true }, { startTimeoutMs: 1_200 })
    ])
    try {
      await orchestrator.restartMcp()
      const before = { alfa: readPid(pids.alfa), beta: readPid(pids.beta) }

      const report = await orchestrator.reloadMcpServers('alfa')
      expect(report.servers).toEqual([{ name: 'alfa', state: 'ready', tools: 1, error: undefined, hint: undefined }])
      expect(readPid(pids.alfa)).not.toBe(before.alfa)
      expect(readPid(pids.beta)).toBe(before.beta)
      expect(isAlive(before.beta)).toBe(true)
      expect(registry(orchestrator).get('mcp__alfa__echo')).toBeTruthy()

      expect(await orchestrator.reloadMcpServers('nao-existe')).toEqual({ servers: [] })
      const all = await orchestrator.reloadMcpServers()
      expect(all.servers.map((item) => [item.name, item.state])).toEqual([['alfa', 'ready'], ['beta', 'ready'], ['broken', 'error']])
      expect(all.servers[2].error).toContain('timeout')
      expect(all.servers[2].hint).toContain('startTimeoutMs')
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('tries a server that ran out of start time once more in the background', async () => {
    // The first start finds the flag and never answers; by the second one the machine "calmed down" (flag gone).
    const gate = path.join(dir, 'lento.flag')
    fs.writeFileSync(gate, '')
    const orchestrator = await boot([server('lento', { only: ['echo'], hangIfFile: gate }, { startTimeoutMs: 1_000 })], 300)
    try {
      await orchestrator.restartMcp()
      const state = (): string | undefined => service(orchestrator).list().find((item) => item.name === 'lento')?.state
      expect(state()).toBe('error')
      fs.rmSync(gate)
      expect(await waitFor(() => state() === 'ready', 8_000)).toBe(true)
      expect(registry(orchestrator).get('mcp__lento__echo')).toBeTruthy()
      expect(logs.join('\n')).toContain('MCP lento: nova tentativa de partida')
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('tries only once more: a server that never answers ends as an error, with no third attempt', async () => {
    const orchestrator = await boot([server('mudo', { hangOnStart: true }, { startTimeoutMs: 800 })], 200)
    try {
      await orchestrator.restartMcp()
      // second attempt: 200 ms of waiting + 800 ms of timeout; a third would show up well inside the next 3 s
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const text = logs.join('\n')
      expect(text.match(/MCP mudo: nova tentativa de partida/g)?.length).toBe(1)
      expect(text.match(/MCP mudo: timeout de MCP mudo\.initialize/g)?.length).toBe(2)
      expect(service(orchestrator).list().find((item) => item.name === 'mudo')?.state).toBe('error')
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('does not retry a server that failed for another reason than time', async () => {
    const orchestrator = await boot([{ name: 'ausente', command: 'openclod-comando-que-nao-existe', args: [], enabled: true }], 200)
    try {
      await orchestrator.restartMcp()
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(logs.join('\n')).not.toContain('nova tentativa de partida')
      expect(service(orchestrator).list().find((item) => item.name === 'ausente')?.state).toBe('error')
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('runs the mcp_reload tool through the service', async () => {
    const orchestrator = await boot([server('alfa', { only: ['echo'] }), server('broken', { hangOnStart: true }, { startTimeoutMs: 1_200 })])
    try {
      await orchestrator.restartMcp()
      const reload = registry(orchestrator).get('mcp_reload')!
      const result = await reload.execute({}, ctx(orchestrator))
      expect(result.ok).toBe(true)
      expect(result.text).toContain('● alfa · ready · 1 ferramentas')
      expect(result.text).toContain('○ broken · error')
      expect(result.text).toContain('Dica:')
      const only = await reload.execute({ server: 'alfa' }, ctx(orchestrator))
      expect(only.summary).toBe('1/1 conectados')
      expect((await reload.execute({ server: 'x' }, ctx(orchestrator))).ok).toBe(false)
    } finally {
      await orchestrator.shutdown()
    }
  })
})

describe('tools in the registry', () => {
  it('exposes mcp__server__tool, defers a big server and reloads one server\'s tools on list_changed without restarting', async () => {
    const pid = path.join(dir, 'alfa.pid')
    const orchestrator = await boot([
      server('alfa', { only: ['grow', 'echo'], pidFile: pid }),
      server('grande', { only: ['plain'], toolCount: 20 })
    ])
    try {
      await orchestrator.restartMcp()
      const reg = registry(orchestrator)
      expect(reg.get('mcp__alfa__echo')?.mcp).toEqual({ server: 'alfa', tool: 'echo', deferred: false, title: 'Echo' })
      expect(reg.get('mcp__grande__bulk_7')?.mcp?.deferred).toBe(true)
      expect(service(orchestrator).list().find((item) => item.name === 'grande')?.deferred).toBe(21)
      const before = readPid(pid)

      await reg.get('mcp__alfa__grow')!.execute({}, ctx(orchestrator))
      expect(await waitFor(() => Boolean(reg.get('mcp__alfa__late_tool')), 5_000)).toBe(true)
      expect(readPid(pid)).toBe(before)
      expect(logs.join('\n')).toContain('MCP alfa: tools atualizadas')
      expect((await reg.get('mcp__alfa__late_tool')!.execute({}, ctx(orchestrator))).text).toBe('late-ok')
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('follows a policy change saved from the connectors screen, with no reconnection', async () => {
    const pid = path.join(dir, 'alfa.pid')
    const orchestrator = await boot([server('alfa', { only: ['echo', 'plain', 'delete_issue'], pidFile: pid })])
    try {
      await orchestrator.restartMcp()
      const reg = registry(orchestrator)
      const before = readPid(pid)
      expect(reg.get('mcp__alfa__plain')?.approval).toBeUndefined()

      await orchestrator.connectors.setToolPolicy('alfa', 'delete_issue', 'deny')
      await orchestrator.connectors.setToolPolicy('alfa', 'plain', 'allow')
      await orchestrator.connectors.setToolPolicy('alfa', 'echo', 'ask')
      expect(reg.get('mcp__alfa__delete_issue')).toBeUndefined()
      expect(reg.get('mcp__alfa__plain')?.approval).toBe('allow')
      expect(reg.get('mcp__alfa__echo')?.approval).toBe('ask')
      expect(readPid(pid)).toBe(before)

      // The indirect path obeys the same policy.
      const mcpCall = reg.get('mcp_call')!
      expect(mcpCall.resolveCall?.({ server: 'alfa', tool: 'delete_issue' })).toMatchObject({ deny: expect.stringContaining('desativada') })
      expect(mcpCall.resolveCall?.({ server: 'alfa', tool: 'echo' })).toMatchObject({ approval: 'ask', risk: 'read' })
    } finally {
      await orchestrator.shutdown()
    }
  })
})

describe('reconnection', () => {
  it('brings a server that died back, and the registry follows', async () => {
    const orchestrator = await boot([server('alfa', { only: ['die', 'echo'] })])
    try {
      await orchestrator.restartMcp()
      const reg = registry(orchestrator)
      expect(reg.get('mcp__alfa__echo')).toBeTruthy()
      await reg.get('mcp__alfa__die')!.execute({}, ctx(orchestrator))
      // The dead server's tools disappear, then come back after the backoff (1 s).
      expect(await waitFor(() => !reg.get('mcp__alfa__echo'), 3_000)).toBe(true)
      expect(await waitFor(() => Boolean(reg.get('mcp__alfa__echo')), 10_000)).toBe(true)
      expect(service(orchestrator).list()[0].state).toBe('ready')
    } finally {
      await orchestrator.shutdown()
    }
  }, 30_000)
})
