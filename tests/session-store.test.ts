import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/core/session/store'
import type { Message, SessionState } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

function message(id: string, role: Message['role'], text: string): Message {
  return { id, role, ts: 1, parts: [{ type: 'text', text }] }
}

describe('SessionStore', () => {
  let dir: string
  let store: SessionStore

  beforeEach(async () => {
    dir = await makeTempDir('forja-sessions-')
    store = new SessionStore(dir)
    await store.init()
  })

  afterEach(async () => {
    await removeTempDir(dir)
  })

  it('creates a session, saves messages and reloads it from disk', async () => {
    const meta = await store.createSession({
      projectId: 'prj_1',
      cwd: dir,
      mode: 'code',
      providerId: 'mock',
      model: 'scripted'
    })
    expect(meta.id).toMatch(/^ses_/)
    expect(meta.title).toBe('Nova sessão')
    expect(meta.totalUsage).toEqual({ input: 0, output: 0 })

    const state = await store.loadSession(meta.id)
    expect(state).not.toBeNull()
    expect(state!.messages).toEqual([])
    expect(state!.state).toBe('idle')

    const messages = [
      message('m1', 'user', 'faça algo'),
      message('m2', 'assistant', 'feito')
    ]
    const saved: SessionState = {
      ...state!,
      messages,
      usage: { input: 12, output: 7, costUsd: 0.01 },
      state: 'done'
    }
    await store.saveSession(saved)

    // The in-memory value reflects the save immediately.
    expect(store.getSession(meta.id)!.messages).toHaveLength(2)
    expect(store.getSession(meta.id)!.meta.totalUsage).toEqual({ input: 12, output: 7, costUsd: 0.01 })

    // A fresh store (simulating an app restart) reads the JSON back.
    const reopened = new SessionStore(dir)
    await reopened.init()
    const reloaded = await reopened.loadSession(meta.id)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.meta.id).toBe(meta.id)
    expect(reloaded!.meta.mode).toBe('code')
    expect(reloaded!.messages).toEqual(messages)
    expect(reloaded!.usage).toEqual({ input: 12, output: 7, costUsd: 0.01 })
  })

  it('marks a stale active plan as interrupted on startup', async () => {
    const meta = await store.createSession({
      projectId: 'prj_stale',
      cwd: dir,
      mode: 'code',
      providerId: 'mock',
      model: 'm'
    })
    const state = await store.loadSession(meta.id)
    await store.saveSession({
      ...state!,
      state: 'streaming',
      plan: [
        { id: 'done', text: 'feito', status: 'done' },
        { id: 'open', text: 'aguardando decisão', status: 'active' }
      ]
    })

    const reopened = new SessionStore(dir)
    await reopened.init()
    const reloaded = await reopened.loadSession(meta.id)
    expect(reloaded!.state).toBe('idle')
    expect(reloaded!.plan.map((item) => item.status)).toEqual(['done', 'active'])
    expect(reloaded!.plan[1].interrupted).toBe(true)
    expect(typeof reloaded!.plan[1].endedAt).toBe('number')
  })

  it('lists sessions newest-first with preview and message count', async () => {
    const first = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'ask',
      providerId: 'mock',
      model: 'm',
      title: 'Primeira'
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'ask',
      providerId: 'mock',
      model: 'm',
      title: 'Segunda'
    })
    const state = await store.loadSession(first.id)
    await store.saveSession({
      ...state!,
      messages: [message('u1', 'user', '  olá   mundo \n com   espaços  ')]
    })

    const list = await store.listSessions()
    expect(list.map((s) => s.meta.id)).toContain(second.id)
    const firstSummary = list.find((s) => s.meta.id === first.id)!
    expect(firstSummary.messageCount).toBe(1)
    expect(firstSummary.preview.trim()).toBe('olá mundo com espaços')
  })

  it('renames and archives through patchMeta, persisting the archived flag', async () => {
    const meta = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'review',
      providerId: 'mock',
      model: 'm'
    })
    await store.patchMeta(meta.id, { title: 'Renomeada', archived: true })

    expect(store.getSession(meta.id)!.meta.title).toBe('Renomeada')
    expect(store.getSession(meta.id)!.meta.archived).toBe(true)

    const reopened = new SessionStore(dir)
    await reopened.init()
    const reloaded = await reopened.loadSession(meta.id)
    expect(reloaded!.meta.title).toBe('Renomeada')
    expect(reloaded!.meta.archived).toBe(true)

    const list = await reopened.listSessions()
    expect(list.find((s) => s.meta.id === meta.id)!.meta.archived).toBe(true)
  })

  it('persists the desktop surface and defaults legacy sessions to code', async () => {
    const chat = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'ask',
      surface: 'chat',
      providerId: 'mock',
      model: 'm',
      title: 'Conversa'
    })
    expect(chat.surface).toBe('chat')

    const legacy = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'code',
      providerId: 'mock',
      model: 'm',
      title: 'Antiga'
    })
    expect(legacy.surface).toBe('code')

    // Simulate a session file written before surfaces existed.
    const legacyPath = path.join(dir, 'sessions', `${legacy.id}.json`)
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as SessionState
    delete (raw.meta as { surface?: string }).surface
    fs.writeFileSync(legacyPath, JSON.stringify(raw))

    const reopened = new SessionStore(dir)
    await reopened.init()
    const chatReloaded = await reopened.loadSession(chat.id)
    expect(chatReloaded!.meta.surface).toBe('chat')
    const legacyReloaded = await reopened.loadSession(legacy.id)
    expect(legacyReloaded!.meta.surface).toBeUndefined()

    const summaries = await reopened.listSessions()
    expect(summaries.find((item) => item.meta.id === chat.id)!.meta.surface).toBe('chat')
  })

  it('exports and imports a session as a new id, preserving content', async () => {
    const meta = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'debug',
      providerId: 'mock',
      model: 'm',
      title: 'Original'
    })
    const state = await store.loadSession(meta.id)
    await store.saveSession({
      ...state!,
      messages: [message('m1', 'user', 'conteúdo original')],
      plan: [{ id: 'pl1', text: 'passo', status: 'active' }]
    })

    const exported = await store.exportSession(meta.id)
    expect(exported).not.toBeNull()
    const parsed = JSON.parse(exported!)
    expect(parsed.format).toBe('forja.session.v1')
    expect(parsed.state.meta.id).toBe(meta.id)

    const imported = await store.importSession(exported!)
    expect(imported.id).not.toBe(meta.id)
    expect(imported.title).toBe('Original (importada)')
    expect(imported.mode).toBe('debug')

    const importedState = await store.loadSession(imported.id)
    expect(importedState!.messages[0].parts[0]).toEqual({ type: 'text', text: 'conteúdo original' })
    expect(importedState!.plan).toEqual([{ id: 'pl1', text: 'passo', status: 'active' }])

    // Imported session survives a restart too.
    const reopened = new SessionStore(dir)
    await reopened.init()
    expect(await reopened.loadSession(imported.id)).not.toBeNull()
  })

  it('rejects malformed import payloads', async () => {
    await expect(store.importSession('{}')).rejects.toThrow(/inválido/)
    await expect(
      store.importSession(JSON.stringify({ format: 'forja.session.v1', state: {} }))
    ).rejects.toThrow(/inválido/)
    await expect(store.importSession('não é json')).rejects.toThrow()
    await expect(store.exportSession('ses_missing')).resolves.toBeNull()
  })

  it('appends and reads JSONL events, and deletes them with the session', async () => {
    const meta = await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'code',
      providerId: 'mock',
      model: 'm'
    })
    await store.appendEvent(meta.id, { type: 'turn_start', sessionId: meta.id, messageId: 'm1' })
    await store.appendEvent(meta.id, {
      type: 'turn_end',
      sessionId: meta.id,
      messageId: 'm1',
      stopReason: 'stop'
    })

    const events = await store.readEvents(meta.id)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'turn_start', messageId: 'm1' })
    expect(events[1]).toMatchObject({ type: 'turn_end', stopReason: 'stop' })
    expect(typeof (events[0] as { ts: number }).ts).toBe('number')

    // Limit returns the most recent events.
    const limited = await store.readEvents(meta.id, 1)
    expect(limited).toHaveLength(1)
    expect(limited[0]).toMatchObject({ type: 'turn_end' })

    expect(await store.readEvents('ses_missing')).toEqual([])

    await store.deleteSession(meta.id)
    expect(await store.loadSession(meta.id)).toBeNull()
    expect(await store.readEvents(meta.id)).toEqual([])
    expect(fs.existsSync(path.join(dir, 'sessions', `${meta.id}.json`))).toBe(false)
  })

  it('tracks projects (add, dedupe, remove)', async () => {
    const project = await store.addProject(dir, 'Meu projeto')
    expect(project.name).toBe('Meu projeto')

    const again = await store.addProject(dir)
    expect(again.id).toBe(project.id)
    expect(store.listProjects()).toHaveLength(1)

    const otherPath = path.join(dir, 'other')
    const other = await store.addProject(otherPath)
    expect(other.name).toBe('other')
    expect(store.listProjects()).toHaveLength(2)

    await store.removeProject(project.id)
    expect(store.listProjects().map((p) => p.id)).toEqual([other.id])

    const reopened = new SessionStore(dir)
    await reopened.init()
    expect(reopened.listProjects().map((p) => p.id)).toEqual([other.id])
  })

  it('keeps one default model per project and backfills legacy projects', async () => {
    const alpha = await store.addProject(path.join(dir, 'alpha'), 'Alpha')
    const beta = await store.addProject(path.join(dir, 'beta'), 'Beta')
    const alphaSession = await store.createSession({
      projectId: alpha.id,
      cwd: alpha.path,
      mode: 'code',
      providerId: 'deepseek',
      model: 'deepseek-flash'
    })
    await store.createSession({
      projectId: beta.id,
      cwd: beta.path,
      mode: 'code',
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5'
    })

    // Existing projects without a stored model inherit their latest session.
    const migrated = new SessionStore(dir)
    await migrated.init()
    const projects = migrated.listProjects()
    expect(projects.find((item) => item.id === alpha.id)?.model).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-flash'
    })
    expect(projects.find((item) => item.id === beta.id)?.model).toEqual({
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5'
    })

    // Changing Beta does not touch Alpha.
    await migrated.setProjectModel(beta.id, 'openai', 'gpt-4o')
    const reopened = new SessionStore(dir)
    await reopened.init()
    expect(reopened.listProjects().find((item) => item.id === alpha.id)?.model).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-flash'
    })
    expect(reopened.listProjects().find((item) => item.id === beta.id)?.model).toEqual({
      providerId: 'openai',
      model: 'gpt-4o'
    })
    // The session keeps its own model even if the project default changes.
    expect(reopened.getSession(alphaSession.id)?.meta.model).toBe('deepseek-flash')
  })

  it('survives 30 simultaneous saves of one session and keeps the last one called', async () => {
    const meta = await store.createSession({ projectId: 'p', cwd: dir, mode: 'code', providerId: 'mock', model: 'm' })
    const base = (await store.loadSession(meta.id))!
    const saves = Array.from({ length: 30 }, (_, index) =>
      store.saveSession({ ...base, messages: [message(`m${index}`, 'user', `versão ${index}`)] })
    )
    const results = await Promise.allSettled(saves)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${meta.id}.json`), 'utf8')) as SessionState
    expect(onDisk.messages[0].id).toBe('m29')
    expect((await fs.promises.readdir(path.join(dir, 'sessions'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps streaming deltas out of the durable journal and caps its size', async () => {
    const meta = await store.createSession({ projectId: 'p', cwd: dir, mode: 'code', providerId: 'mock', model: 'm' })
    await store.appendEvent(meta.id, { type: 'text_delta', sessionId: meta.id, messageId: 'x', text: 'olá' })
    await store.appendEvent(meta.id, { type: 'reasoning_delta', sessionId: meta.id, messageId: 'x', text: 'hmm' })
    await store.appendEvent(meta.id, { type: 'turn_start', sessionId: meta.id, messageId: 'x' })
    const events = (await store.readEvents(meta.id)) as Array<{ type: string }>
    expect(events.map((event) => event.type)).toEqual(['turn_start'])

    const journal = path.join(dir, 'sessions', `${meta.id}.events.jsonl`)
    fs.writeFileSync(journal, 'x'.repeat(11 * 1024 * 1024))
    const fresh = new SessionStore(dir)
    await fresh.appendEvent(meta.id, { type: 'turn_start', sessionId: meta.id, messageId: 'y' })
    expect(fs.existsSync(`${journal}.1`)).toBe(true)
    expect(fs.statSync(journal).size).toBeLessThan(1024)
    await store.deleteSession(meta.id)
    expect(fs.existsSync(`${journal}.1`)).toBe(false)
  })

  it('clearAll removes every persisted session file', async () => {
    await store.createSession({
      projectId: 'p',
      cwd: dir,
      mode: 'ask',
      providerId: 'mock',
      model: 'm'
    })
    await expect(store.listSessions()).resolves.toHaveLength(1)
    await store.clearAll()
    expect(await store.listSessions()).toHaveLength(0)
    expect(await fs.promises.readdir(path.join(dir, 'sessions'))).toEqual([])
  })
})
