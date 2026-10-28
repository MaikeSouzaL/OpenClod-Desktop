import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/orchestrator'
import type { HarnessEvent, ProviderConfig } from '../src/shared/types'

/**
 * The reserve in the app's main process: a model switch is saved on the session (so the composer, the next runner and a
 * restart all see the model that works), and a session starts on the provider that works when its own is down or has no key.
 * Keys come from environment variables (the OS vault is Electron's and is not available in a unit test).
 */
let dir = ''
let projectDir = ''
let events: HarnessEvent[] = []
let logs: string[] = []
const ENV = ['OPENCLOD_TEST_KEY_A', 'OPENCLOD_TEST_KEY_B']

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-reserve-orch-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-reserve-proj-'))
  events = []
  logs = []
  process.env.OPENCLOD_TEST_KEY_A = 'chave-de-teste-a'
  process.env.OPENCLOD_TEST_KEY_B = 'chave-de-teste-b'
})

afterEach(() => {
  for (const name of ENV) delete process.env[name]
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

function provider(id: string, env: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: 'openai',
    label: id.toUpperCase(),
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-m`,
    apiKeyRef: `env:${env}`,
    contextWindow: 100_000,
    supportsVision: false,
    supportsTools: true,
    ...over
  }
}

async function boot(sessionProvider = 'a'): Promise<{ orchestrator: Orchestrator; sessionId: string }> {
  const orchestrator = new Orchestrator({ userData: dir, broadcast: (event) => events.push(event), log: (message) => logs.push(message) })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  await orchestrator.settings.update({
    providers: [provider('a', 'OPENCLOD_TEST_KEY_A'), provider('b', 'OPENCLOD_TEST_KEY_B'), provider('semchave', 'OPENCLOD_TEST_SEM_CHAVE')],
    defaultProviderId: 'a',
    useAllModels: true,
    fallbackOrder: ['b']
  })
  const project = await orchestrator.store.addProject(projectDir, 'Projeto de teste')
  const meta = await orchestrator.store.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: sessionProvider, model: `${sessionProvider}-m` })
  return { orchestrator, sessionId: meta.id }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80))

describe('a model switch is saved on the session', () => {
  it('saves the new provider and model, so the composer, the next runner and a restart use it', async () => {
    const { orchestrator, sessionId } = await boot('a')
    ;(orchestrator as unknown as { onEvent(event: HarnessEvent): void }).onEvent({
      type: 'model_switch',
      sessionId,
      from: { providerId: 'a', label: 'A', model: 'a-m' },
      to: { providerId: 'b', label: 'B', model: 'b-m' },
      reason: 'quota'
    })
    await settle()
    expect(orchestrator.store.getSession(sessionId)?.meta).toMatchObject({ providerId: 'b', model: 'b-m' })
    expect(logs.join('\n')).toContain('A/a-m → B/b-m (quota)')
    // The event also reached the window (the composer listens to it).
    expect(events.some((event) => event.type === 'model_switch')).toBe(true)
  })
})

describe('where a session starts', () => {
  it('starts on the reserve when its own provider is known to be down, tells the window, and keeps it saved', async () => {
    const { orchestrator, sessionId } = await boot('a')
    orchestrator.reserve.health.mark({ id: 'a', model: 'a-m' }, 'quota')
    await orchestrator.ensureRunner(sessionId)
    await settle()
    const change = events.find((event): event is Extract<HarnessEvent, { type: 'model_switch' }> => event.type === 'model_switch')
    expect(change).toMatchObject({ from: { providerId: 'a' }, to: { providerId: 'b', model: 'b-m' }, reason: 'quota' })
    expect(orchestrator.store.getSession(sessionId)?.meta.providerId).toBe('b')
  })

  it('leaves a session where it is when its provider works', async () => {
    const { orchestrator, sessionId } = await boot('a')
    await orchestrator.ensureRunner(sessionId)
    await settle()
    expect(events.some((event) => event.type === 'model_switch')).toBe(false)
    expect(orchestrator.store.getSession(sessionId)?.meta.providerId).toBe('a')
  })

  it('does not refuse the message of a session saved on a provider with no key: it starts on the reserve', async () => {
    const { orchestrator, sessionId } = await boot('semchave')
    await expect(orchestrator.ensureRunner(sessionId)).resolves.toBeTruthy()
    await settle()
    expect(orchestrator.store.getSession(sessionId)?.meta).toMatchObject({ providerId: 'b', model: 'b-m' })
  })

  it('still says there is no key when nothing at all can answer', async () => {
    const { orchestrator, sessionId } = await boot('semchave')
    delete process.env.OPENCLOD_TEST_KEY_A
    delete process.env.OPENCLOD_TEST_KEY_B
    await expect(orchestrator.ensureRunner(sessionId)).rejects.toThrow(/não tem credencial/)
  })

  it('a new conversation asked on a provider that is down starts on the one that works', async () => {
    const { orchestrator } = await boot('a')
    orchestrator.reserve.health.mark({ id: 'a', model: 'a-m' }, 'auth')
    const project = orchestrator.store.listProjects()[0]
    const meta = await orchestrator.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: 'a', model: 'a-m' })
    expect(meta).toMatchObject({ providerId: 'b', model: 'b-m' })

    // Saving the provider list again (a new key, a recharge) forgets what was learned: it starts on its own again.
    orchestrator.reserve.health.clear()
    const again = await orchestrator.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: 'a', model: 'a-m' })
    expect(again).toMatchObject({ providerId: 'a' })
  })

  it('with the reserve turned off nothing moves, whatever the health says', async () => {
    const { orchestrator, sessionId } = await boot('a')
    await orchestrator.settings.update({ useAllModels: false })
    orchestrator.reserve.health.mark({ id: 'a', model: 'a-m' }, 'quota')
    await orchestrator.ensureRunner(sessionId)
    await settle()
    expect(events.some((event) => event.type === 'model_switch')).toBe(false)
    expect(orchestrator.store.getSession(sessionId)?.meta.providerId).toBe('a')
  })
})
