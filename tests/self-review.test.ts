import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { z } from 'zod'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS } from '../src/shared/types'
import type { ToolDef } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('openclod-self-review-')
})
afterEach(async () => {
  await removeTempDir(cwd)
})

/** A write tool that records what it changed, like the real file tools do. */
const editTool: ToolDef = {
  name: 'edit_file',
  description: 'fake edit',
  schema: z.object({ path: z.string(), before: z.string(), after: z.string() }),
  risk: 'write',
  parallelSafe: false,
  describe: (raw) => ({ title: 'Editar', detail: String((raw as { path: string }).path) }),
  async execute(raw, ctx) {
    const args = raw as { path: string; before: string; after: string }
    ctx.tracker.recordChange(path.join(cwd, args.path), args.before, args.after)
    return { ok: true, text: `editado ${args.path}`, summary: 'editado' }
  }
}

function runner(provider: ScriptedProvider, overrides: Partial<RunnerDeps> = {}): SessionRunner {
  return new SessionRunner({
    sessionId: 'ses_review',
    cwd,
    mode: 'code',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry: buildRegistry(editTool),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 8 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async () => true,
    ...overrides
  })
}

const edit = (id: string, file: string, before: string, after: string) => ({ toolCalls: [{ id, name: 'edit_file', args: { path: file, before, after } }] })
const reviewOf = (provider: ScriptedProvider): string[] =>
  provider.requests.flatMap((request) =>
    request.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === 'text' && part.text.includes('<self-review>') ? [part.text] : [])))
  )

describe('self-review before a turn that changed files ends', () => {
  it('shows the model the diff of the whole turn once, and the model can fix what it finds', async () => {
    const provider = new ScriptedProvider([
      edit('c1', 'app.ts', 'const a = 1\n', 'const a = 2\n'),
      edit('c2', 'app.ts', 'const a = 2\n', 'const a = 2\nconsole.log(a)\n'),
      { text: 'Pronto: troquei a constante.' },
      // The review shows the leftover console.log: the model takes it out...
      edit('c3', 'app.ts', 'const a = 2\nconsole.log(a)\n', 'const a = 2\n'),
      // ...and ends; no second review in the same turn.
      { text: 'Revisei: tirei o console.log que tinha sobrado.' }
    ])
    const session = runner(provider)
    await session.send('troque a constante para 2')

    const reviews = reviewOf(provider)
    // Sent once, then carried in the history of the requests after it.
    expect(new Set(reviews).size).toBe(1)
    const [review] = reviews
    expect(review).toContain('1 arquivo(s)')
    // The diff is of the whole turn (first edit and second together), not only the last edit.
    expect(review).toContain('-const a = 1')
    expect(review).toContain('+console.log(a)')
    expect(provider.requests).toHaveLength(5)
    const last = session.messages.filter((message) => message.role === 'assistant').at(-1)
    expect(last?.parts.some((part) => part.type === 'text' && part.text.includes('Revisei'))).toBe(true)
  })

  it('does not review a turn that changed nothing, a read-only session, a chat, a subagent, or when turned off', async () => {
    const plain = new ScriptedProvider([{ text: 'só uma resposta' }])
    await runner(plain).send('oi')
    expect(plain.requests).toHaveLength(1)

    for (const overrides of [{ selfReview: false }, { surface: 'chat' as const }, { depth: 1 }, { mode: 'ask' as const }]) {
      const provider = new ScriptedProvider([edit('c1', 'a.ts', 'x\n', 'y\n'), { text: 'feito' }])
      await runner(provider, overrides).send('mude')
      expect(reviewOf(provider), JSON.stringify(overrides)).toEqual([])
      expect(provider.requests).toHaveLength(2)
    }
  })

  it('cuts a huge diff and points at git_diff for the rest', async () => {
    const big = Array.from({ length: 2_000 }, (_, i) => `linha ${i}`).join('\n')
    const provider = new ScriptedProvider([edit('c1', 'small.ts', 'a\n', 'b\n'), edit('c2', 'z-big.ts', '', big), { text: 'feito' }, { text: 'confere' }])
    await runner(provider).send('mude')
    const [review] = reviewOf(provider)
    expect(review).toContain('-a')
    expect(review).toContain('z-big.ts (modified, +2000 -0)')
    expect(review).toContain('o diff de z-big.ts e dos seguintes ficou de fora')
    expect(review.length).toBeLessThan(16_000)
  })
})

describe('FileTracker.turnChanges', () => {
  it('adds up every change of the turn, per file, and starts over at the next turn', () => {
    const tracker = new FileTracker(cwd)
    tracker.beginTurn()
    tracker.recordChange(path.join(cwd, 'a.ts'), 'um\n', 'dois\n')
    tracker.recordChange(path.join(cwd, 'a.ts'), 'dois\n', 'tres\n')
    tracker.recordChange(path.join(cwd, 'b.ts'), 'x\n', 'y\n')
    tracker.recordChange(path.join(cwd, 'b.ts'), 'y\n', 'x\n')
    const changes = tracker.turnChanges()
    // b.ts went back to what it was: nothing to review there.
    expect(changes.map((change) => change.path)).toEqual(['a.ts'])
    expect(changes[0].diff).toContain('-um')
    expect(changes[0].diff).toContain('+tres')
    tracker.beginTurn()
    expect(tracker.turnChanges()).toEqual([])
  })
})
