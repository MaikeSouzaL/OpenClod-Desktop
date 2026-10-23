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
