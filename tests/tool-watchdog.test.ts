import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionRunner, toolIdleLimit, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS, type HarnessEvent, type Message } from '../src/shared/types'
import type { ToolDef } from '../src/core/tools/types'
import { runCommandTool } from '../src/core/tools/shell'
import { askUserTool } from '../src/core/tools/ask'
import { makeTempDir, policy, removeTempDir } from './helpers'

let cwd: string
beforeEach(async () => {
  cwd = await makeTempDir('openclod-watchdog-')
})
afterEach(async () => {
  await removeTempDir(cwd)
})

const tool = (name: string, execute: ToolDef['execute'], extra: Partial<ToolDef> = {}): ToolDef => ({
  name,
  description: `fake ${name}`,
  schema: z.object({}).passthrough(),
  risk: 'read',
  parallelSafe: false,
  describe: () => ({ title: name, detail: '' }),
  execute,
  ...extra
})

function makeRunner(tools: ToolDef[], provider: ScriptedProvider, overrides: Partial<RunnerDeps> = {}): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_watchdog',
    cwd,
    mode: 'code',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry: buildRegistry(...tools),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 4 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true,
    watchdog: { idleMs: 400, tickMs: 50, graceMs: 100 },
    ...overrides
  }
  return { runner: new SessionRunner(deps), events }
}

const toolResultOf = (runner: SessionRunner, name: string) =>
  (runner as unknown as { messages: Message[] }).messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool_result' && part.name === name) as { ok: boolean; text?: string } | undefined

describe('the tool watchdog', () => {
  it('stops a call that hangs (even one that ignores its abort) and the turn goes on', async () => {
    let aborted = false
    const hang = tool('read_file', (_raw, ctx) => {
      ctx.signal.addEventListener('abort', () => (aborted = true))
      return new Promise(() => undefined) // never answers
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] }, { text: 'Segui por outro caminho.' }])
    const { runner, events } = makeRunner([hang], provider)
    const started = Date.now()
    await runner.send('faça')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(aborted).toBe(true)
    const result = toolResultOf(runner, 'read_file')
    expect(result?.ok).toBe(false)
    expect(result?.text).toMatch(/VIGIA do harness interrompeu read_file/)
    expect(events.some((event) => event.type === 'notice' && /Vigia: "read_file"/.test(event.text))).toBe(true)
    expect(events.some((event) => event.type === 'turn_end')).toBe(true)
  }, 15_000)

  it('leaves alone a long call that keeps reporting progress', async () => {
    const busy = tool('write_file', async (_raw, ctx) => {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        ctx.progress?.(`passo ${i}`)
      }
      return { ok: true, text: 'terminou' }
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: 'c1', name: 'write_file', args: {} }] }, { text: 'Pronto.' }])
    const { runner } = makeRunner([busy], provider)
    await runner.send('faça')
    expect(toolResultOf(runner, 'write_file')).toMatchObject({ ok: true, text: 'terminou' })
  }, 15_000)

  it('restarts the MCP server of a stuck MCP tool', async () => {
    const reloaded: string[] = []
    const stuck = tool('mcp__figcraft__batch', () => new Promise(() => undefined), { mcp: { server: 'figcraft', tool: 'batch', deferred: false } })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: 'c1', name: 'mcp__figcraft__batch', args: {} }] }, { text: 'Ok.' }])
    const { runner } = makeRunner([stuck], provider, {
      services: {
        browser: {},
        computer: {},
        skills: { list: () => [] },
        memory: {},
        mcp: { reload: async (server?: string) => void reloaded.push(server ?? '*') }
      } as unknown as RunnerDeps['services']
    })
    await runner.send('faça')
    expect(reloaded).toEqual(['figcraft'])
    expect(toolResultOf(runner, 'mcp__figcraft__batch')?.text).toMatch(/servidor MCP "figcraft" foi reiniciado/)
  }, 15_000)

  it('knows the tools that wait on purpose', () => {
    expect(toolIdleLimit(askUserTool, {})).toBeNull()
    expect(toolIdleLimit(runCommandTool, { command: 'npm test' })).toBeNull()
    expect(toolIdleLimit(tool('outra', async () => ({ ok: true, text: '' })), {})).toBe(240_000)
  })
})
