import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/orchestrator'
import type { Message, PlanItem } from '../src/shared/types'

/**
 * After every turn the app writes the continuity capsule of the session (src/core/memory/state-page.ts), in the wiki and
 * in the long-term index, so a NEW session, possibly on another model, finds where the work stands.
 */
let dir = ''
let projectDir = ''
let logs: string[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-cap-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-capproj-'))
  logs = []
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

interface FakeAi {
  available: true
  writes: Array<{ path: string; title: string; body: string; tier?: string }>
  deletes: string[]
  recent: () => Promise<unknown[]>
  relatedMarkdown: () => Promise<string>
  writePage: (projectId: string, input: { path: string; title: string; body: string; tier?: string }) => Promise<{ path: string; pageId: string }>
  /** What the index holds: the last write of each path, as the sidecar reads it back. */
  readPage: (projectId: string, path: string) => Promise<{ path: string; title: string; body: string } | null>
  deletePage: (projectId: string, path: string) => Promise<boolean>
}

async function boot() {
  const orchestrator = new Orchestrator({ userData: dir, broadcast: () => undefined, log: (message) => logs.push(message) })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  const project = await orchestrator.store.addProject(projectDir, 'Relatório')
  const first = await orchestrator.store.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: 'ollama', model: 'qualquer', title: 'Exportador CSV' })
  const ai: FakeAi = {
    available: true,
    writes: [],
    deletes: [],
    recent: async () => [{ path: 'pages/x.md', title: 'x', snippet: '' }],
    relatedMarkdown: async () => '',
    writePage: async (_projectId, input) => {
      ai.writes.push(input)
      return { path: input.path, pageId: input.path }
    },
    readPage: async (_projectId, pagePath) => {
      const written = [...ai.writes].reverse().find((item) => item.path === pagePath)
      return written && !ai.deletes.includes(pagePath) ? { path: pagePath, title: written.title, body: written.body } : null
    },
    deletePage: async (_projectId, pagePath) => {
      ai.deletes.push(pagePath)
      return true
    }
  }
  ;(orchestrator as unknown as { aiMemory: FakeAi }).aiMemory = ai
  const capture = (sessionId: string, runner: { messages: Message[]; plan: PlanItem[]; state: string }, userText: string): Promise<void> =>
    (orchestrator as unknown as { captureTurnMemory: (id: string, runner: unknown, text: string) => Promise<void> }).captureTurnMemory(sessionId, runner, userText)
  const memory = (orchestrator as unknown as { memoryForProject: (id: string) => import('../src/core/memory/project').ProjectMemory }).memoryForProject(project.id)
  return { orchestrator, project, first, ai, capture, memory }
}

const user = (text: string): Message => ({ id: `u_${text.length}`, role: 'user', ts: 1, parts: [{ type: 'text', text }] })
const assistant = (text: string): Message => ({ id: `a_${text.length}`, role: 'assistant', ts: 2, parts: [{ type: 'text', text }] })

describe('the capsule after a turn', () => {
  it('is written to the wiki and mirrored to the index, and a new session sees it as open work', async () => {
    const { first, ai, capture, memory } = await boot()
    const plan: PlanItem[] = [
      { id: 'p1', text: 'parser', status: 'done' },
      { id: 'p2', text: 'exportador CSV com ponto e vírgula', status: 'pending' }
    ]
    const request = 'Implemente o parser e o exportador CSV. Separador ponto e vírgula, linhas em CRLF.'
    await capture(first.id, { messages: [user(request), assistant('Parser pronto, 3 testes passando.')], plan, state: 'done' }, request)

    const capsule = await memory.readPage('estado-exportador-csv')
    expect(capsule).toBeTruthy()
    expect(capsule!.tags).toEqual(['estado', 'em-aberto'])
    for (const expected of ['**Situação:** em aberto', 'ponto e vírgula, linhas em CRLF', 'Parser pronto, 3 testes passando.', '- [pending] exportador CSV com ponto e vírgula', '## Próximo passo\nexportador CSV com ponto e vírgula']) {
      expect(capsule!.body).toContain(expected)
    }
    const mirrored = ai.writes.find((write) => write.path === 'pages/estado-exportador-csv.md')
    expect(mirrored?.tier).toBe('semantic')
    expect(mirrored?.body).toContain('Próximo passo')

    // Another session of the same project sees it; the session itself does not need to.
    expect((await memory.openWork({ excludeContext: 'sessao:ses_outra' }))[0]).toMatchObject({ slug: 'estado-exportador-csv', status: 'em-aberto', next: 'exportador CSV com ponto e vírgula' })
    expect(await memory.openWork({ excludeContext: `sessao:${first.id}` })).toEqual([])
  })

  it('is rewritten on the next turn and becomes "concluído" when the plan is finished', async () => {
    const { first, capture, memory } = await boot()
    const open: PlanItem[] = [{ id: 'p1', text: 'exportador', status: 'pending' }]
    await capture(first.id, { messages: [user('faça o exportador'), assistant('começando')], plan: open, state: 'done' }, 'faça o exportador')
    await capture(first.id, { messages: [user('faça o exportador'), assistant('começando'), user('termine'), assistant('exportador pronto')], plan: [{ ...open[0], status: 'done' }], state: 'done' }, 'termine')
    const pages = (await memory.listPages()).filter((page) => page.slug.startsWith('estado-'))
    expect(pages).toHaveLength(1)
    expect(pages[0].tags).toEqual(['estado', 'concluido'])
    const next = await memory.openWork({ excludeContext: 'sessao:ses_outra' })
    expect(next[0].status).toBe('concluido')
  })

  it('marks a turn that failed as interrupted, and a failure of the capsule never breaks the turn memory', async () => {
    const { first, capture, memory, ai } = await boot()
    await capture(first.id, { messages: [user('rode a migração'), assistant('falhou')], plan: [], state: 'error' }, 'rode a migração')
    expect((await memory.openWork({ excludeContext: 'sessao:ses_outra' }))[0]).toMatchObject({ status: 'interrompido', next: 'retomar o último pedido: rode a migração' })

    ;(memory as unknown as { recordState: () => Promise<never> }).recordState = () => Promise.reject(new Error('disco cheio'))
    ai.writes.length = 0
    await capture(first.id, { messages: [user('de novo'), assistant('ok')], plan: [], state: 'done' }, 'de novo')
    expect(logs.join('\n')).toContain('cápsula de continuidade')
    expect(logs.join('\n')).toContain('disco cheio')
    // The turn notes were still mirrored.
    expect(ai.writes.some((write) => write.path.startsWith('pages/turno-'))).toBe(true)
  })
})

describe('the index follows the wiki when a page leaves it', () => {
  it('deletes the mirror of an archived hub on the next sync, and only that one', async () => {
    const { orchestrator, project, ai, memory } = await boot()
    // Two durable pages sharing a tag make a real hub; two turn logs sharing a junk word made the old kind of hub.
    await memory.writePage({ title: 'Jira conectado', body: 'ok', tags: ['jira'], memoryType: 'solution' })
    await memory.writePage({ title: 'Jira de novo', body: 'ok', tags: ['jira'] })
    await memory.writePage({ title: 'Turno 1 — abre', body: 'x', tags: ['turno', 'abre'], source: 'auto' })
    await memory.writePage({ title: 'Turno 2 — abre', body: 'x', tags: ['turno', 'abre'], source: 'auto' })
    await memory.writePage({ title: 'Índice: abre', body: '- [[turno-1-abre]]', tags: ['indice', 'abre'], source: 'auto', context: 'auto:hub' })

    // What the previous build had already copied to the index (it mirrored the junk hub too).
    const cacheFile = path.join(dir, 'data', 'memory', 'projects', project.id, 'ai-sync.json')
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ 'pages/indice-abre.md': 'antigo', 'pages/jira-conectado.md': 'antigo' }))

    await (orchestrator as unknown as { doSyncNativeToAi: (id: string) => Promise<void> }).doSyncNativeToAi(project.id)

    // The wiki archived the junk hub when it opened, so the sync removes its copy from the index...
    expect(fs.existsSync(path.join(dir, 'data', 'memory', 'projects', project.id, 'wiki', '.archive', 'indice-abre.md'))).toBe(true)
    expect(ai.deletes).toContain('pages/indice-abre.md')
    // ...and nothing that is still in the wiki.
    expect(ai.deletes).not.toContain('pages/jira-conectado.md')
    expect(ai.deletes).not.toContain('pages/indice-jira.md')
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, string>
    expect(Object.keys(cache)).not.toContain('pages/indice-abre.md')
    expect(Object.keys(cache)).toContain('pages/jira-conectado.md')
  })
})
