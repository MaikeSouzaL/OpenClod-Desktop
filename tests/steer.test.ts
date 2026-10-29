import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { InboxStore } from '../src/main/inbox'
import { DEFAULT_LIMITS } from '../src/shared/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('openclod-steer-')
})
afterEach(async () => {
  await removeTempDir(cwd)
})

function runner(provider: ScriptedProvider): SessionRunner {
  return new SessionRunner({
    sessionId: 'ses_steer',
    cwd,
    mode: 'code',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry: buildRegistry(),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 8 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async () => true
  })
}

const texts = (request: ScriptedProvider['requests'][number]): string =>
  request.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))).join('\n')

describe('an instruction sent while the last answer is being written (steer)', () => {
  it('is answered in the same turn instead of staying unread at the end of the history', async () => {
    const provider = new ScriptedProvider(
      [
        // The final answer streams slowly; the user steers in the middle of it.
        { text: 'Aqui está o resumo do que fiz no projeto inteiro.', delayMs: 15 },
        { text: 'Certo: também atualizei o README.' }
      ],
      4
    )
    const session = runner(provider)
    const turn = session.send('resuma o que você fez')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(session.steer('e atualize o README também')).toBe(true)
    await turn

    expect(provider.requests).toHaveLength(2)
    expect(texts(provider.requests[0])).not.toContain('atualize o README')
    expect(texts(provider.requests[1])).toContain('[instrução do usuário durante o turno]\ne atualize o README também')
    expect(texts(provider.requests[1])).toContain('<instrucao-pendente>')
    const answers = session.messages.filter((message) => message.role === 'assistant')
    expect(answers.at(-1)?.parts.some((part) => part.type === 'text' && part.text.includes('README'))).toBe(true)
  })

  it('needs no extra round when the steer arrived before the last request', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }])
    const session = runner(provider)
    await session.send('oi')
    // Not running any more: refused, and nothing changes.
    expect(session.steer('tarde demais')).toBe(false)
    expect(provider.requests).toHaveLength(1)
  })
})

describe('inbox after a restart', () => {
  it('drops delivered steers and hands the queued prompts to the composer queue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-inbox-recover-'))
    try {
      const inbox = new InboxStore(dir)
      inbox.add('ses_1', { text: 'pare de mexer no CSS', mode: 'steer', origin: 'agent' })
      inbox.add('ses_1', { text: 'depois rode o build', mode: 'queue', origin: 'agent' })
      inbox.add('ses_1', { text: 'e os testes', mode: 'queue', origin: 'ui' })
      inbox.add('ses_2', { text: 'nada a fazer', mode: 'queue', origin: 'ui' })
      expect(inbox.sessions().sort()).toEqual(['ses_1', 'ses_2'])
      expect(inbox.recover('ses_1')).toEqual({ handedOver: 1, dropped: 1 })
      expect(inbox.list('ses_1').map((item) => [item.text, item.mode, item.origin])).toEqual([
        ['depois rode o build', 'queue', 'ui'],
        ['e os testes', 'queue', 'ui']
      ])
      expect(inbox.recover('ses_2')).toEqual({ handedOver: 0, dropped: 0 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
