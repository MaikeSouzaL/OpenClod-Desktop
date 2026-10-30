import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/orchestrator'

/**
 * "O harness trava depois que eu envio a mensagem": before the first turn of a session the app copied EVERY page of
 * the project wiki into the AI-Memory sidecar (two HTTP calls per page) and only then started the turn. On a project
 * with ~70 pages the user's message sat in the composer for minutes. Starting a turn must never wait for that.
 */
let dir = ''
let projectDir = ''
let logs: string[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-orch-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-proj-'))
  logs = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

async function boot(): Promise<{ orchestrator: Orchestrator; sessionId: string; projectId: string }> {
  const orchestrator = new Orchestrator({ userData: dir, broadcast: () => undefined, log: (message) => logs.push(message) })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  const project = await orchestrator.store.addProject(projectDir, 'Projeto de teste')
  // Ollama needs no key, so the runner can be built without any credential.
  const meta = await orchestrator.store.createSession({
    projectId: project.id,
    cwd: projectDir,
    mode: 'code',
    providerId: 'ollama',
    model: 'qualquer'
  })
  return { orchestrator, sessionId: meta.id, projectId: project.id }
}

describe('starting a turn', () => {
  it('does not wait for the memory sync, even when it never finishes', async () => {
    const { orchestrator, sessionId } = await boot()
    let syncStarted = false
    ;(orchestrator as unknown as { syncNativeToAi: () => Promise<void> }).syncNativeToAi = () => {
      syncStarted = true
      return new Promise<void>(() => undefined) // the sidecar never answers
    }
    const started = Date.now()
    const runner = await Promise.race([
      orchestrator.ensureRunner(sessionId),
      new Promise<'TRAVOU'>((resolve) => setTimeout(() => resolve('TRAVOU'), 20_000))
    ])
    expect(runner).not.toBe('TRAVOU')
    expect(syncStarted).toBe(true) // it still runs, in the background
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 40_000)

  it('does not let a failing sync break the turn either', async () => {
    const { orchestrator, sessionId } = await boot()
    ;(orchestrator as unknown as { syncNativeToAi: () => Promise<void> }).syncNativeToAi = () => Promise.reject(new Error('sidecar caiu'))
    await expect(orchestrator.ensureRunner(sessionId)).resolves.toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(logs.join('\n')).toContain('sidecar caiu')
  }, 40_000)
})

describe('memory sync into AI-Memory', () => {
  interface FakeAi {
    available: true
    writes: string[]
    /** What the index holds, by path (the sidecar keeps what was written to it). */
    pages: Map<string, string>
    recent: () => Promise<unknown[]>
    relatedMarkdown: () => Promise<string>
    writePage: (projectId: string, input: { path: string; body: string }) => Promise<{ path: string; pageId: string }>
    readPage: (projectId: string, path: string) => Promise<{ path: string; title: string; body: string } | null>
    deletePage: () => Promise<boolean>
  }

  function fakeAi(): FakeAi {
    const ai: FakeAi = {
      available: true,
      writes: [],
      pages: new Map(),
      recent: async () => [{ path: 'pages/x.md', title: 'x', snippet: '' }], // non-empty: the index is alive
      relatedMarkdown: async () => '',
      writePage: async (_projectId, input) => {
        ai.writes.push(input.path)
        ai.pages.set(input.path, input.body)
        return { path: input.path, pageId: input.path }
      },
      readPage: async (_projectId, path) => (ai.pages.has(path) ? { path, title: path, body: ai.pages.get(path)! } : null),
      deletePage: async () => true
    }
    return ai
  }

  it('copies each page once and only re-copies the ones that changed', async () => {
    const { orchestrator, projectId } = await boot()
    const ai = fakeAi()
    ;(orchestrator as unknown as { aiMemory: FakeAi }).aiMemory = ai
    const memory = (orchestrator as unknown as { memoryForProject: (id: string) => { writePage: (input: { title: string; body: string; tags?: string[] }) => Promise<{ slug: string }> } }).memoryForProject(projectId)
    for (const n of [1, 2, 3]) await memory.writePage({ title: `Página ${n}`, body: `conteúdo ${n}`, tags: ['teste'] })

    const sync = (): Promise<void> =>
      (orchestrator as unknown as { doSyncNativeToAi: (id: string) => Promise<void> }).doSyncNativeToAi(projectId)

    await sync()
    // the three pages plus the topic-index page the wiki builds for their shared tag
    expect(ai.writes.length).toBeGreaterThanOrEqual(3)
    expect(ai.writes.some((item) => /pagina-3/.test(item))).toBe(true)

    ai.writes.length = 0
    await sync() // nothing changed: nothing is copied (this is what makes every start after the first one instant)
    expect(ai.writes).toHaveLength(0)

    await memory.writePage({ title: 'Página 2', body: 'conteúdo 2 alterado', tags: ['teste'] })
    await sync()
    expect(ai.writes.some((item) => /pagina-2/.test(item))).toBe(true)
    expect(ai.writes.some((item) => /pagina-1/.test(item))).toBe(false) // the untouched pages stay put
    expect(ai.writes.some((item) => /pagina-3/.test(item))).toBe(false)
  }, 40_000)

  it('starts over when AI-Memory lost its index', async () => {
    const { orchestrator, projectId } = await boot()
    const ai = fakeAi()
    ;(orchestrator as unknown as { aiMemory: FakeAi }).aiMemory = ai
    const memory = (orchestrator as unknown as { memoryForProject: (id: string) => { writePage: (input: { title: string; body: string }) => Promise<unknown> } }).memoryForProject(projectId)
    await memory.writePage({ title: 'Única', body: 'conteúdo' })
    const sync = (): Promise<void> =>
      (orchestrator as unknown as { doSyncNativeToAi: (id: string) => Promise<void> }).doSyncNativeToAi(projectId)
    await sync()
    expect(ai.writes).toHaveLength(1)
    ai.recent = async () => [] // fresh sidecar data folder
    ai.pages.clear()
    ai.writes.length = 0
    await sync()
    expect(ai.writes).toHaveLength(1)
  }, 40_000)

  it('records a page the index already has with the same text instead of writing it again (an import put it there)', async () => {
    const { orchestrator, projectId } = await boot()
    const ai = fakeAi()
    ;(orchestrator as unknown as { aiMemory: FakeAi }).aiMemory = ai
    const memory = (orchestrator as unknown as { memoryForProject: (id: string) => { writePage: (input: { title: string; body: string }) => Promise<{ slug: string }> } }).memoryForProject(projectId)
    const imported = await memory.writePage({ title: 'Importada', body: 'texto que a importação já mandou ao índice' })
    const changed = await memory.writePage({ title: 'Diferente', body: 'texto novo' })
    ai.pages.set(`pages/${imported.slug}.md`, 'texto que a importação já mandou ao índice')
    ai.pages.set(`pages/${changed.slug}.md`, 'texto antigo')
    const sync = (): Promise<void> =>
      (orchestrator as unknown as { doSyncNativeToAi: (id: string) => Promise<void> }).doSyncNativeToAi(projectId)
    await sync()
    expect(ai.writes).not.toContain(`pages/${imported.slug}.md`)
    expect(ai.writes).toContain(`pages/${changed.slug}.md`)
    ai.writes.length = 0
    await sync()
    expect(ai.writes).toHaveLength(0)
  }, 40_000)
})
