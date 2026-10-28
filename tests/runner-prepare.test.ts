import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS, type HarnessEvent, type ImagePart } from '../src/shared/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

/**
 * `SendOptions.prepare`: work that must finish before the first model call, with the user's message already on screen.
 * The app uses it to process an audio or video attached to the message (transcript, frames, memory) before the model starts.
 */
let cwd: string

beforeEach(async () => {
  cwd = await makeTempDir('openclod-prepare-')
})
afterEach(async () => removeTempDir(cwd))

function makeRunner(provider: ScriptedProvider): { runner: SessionRunner; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  const deps: RunnerDeps = {
    sessionId: 'ses_prepare',
    cwd,
    mode: 'code',
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Teste', baseUrl: 'http://localhost:0/v1', model: 'm', contextWindow: 128_000, supportsVision: provider.supportsVision, supportsTools: true },
    registry: buildRegistry(),
    policy: policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 3 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve: async () => true
  }
  return { runner: new SessionRunner(deps), events }
}

const sheet: ImagePart = { type: 'image', mediaType: 'image/jpeg', data: 'AAAA', label: 'folha 1' }
const hiddenTexts = (request: { messages: Array<{ hidden?: boolean; parts: Array<{ type: string; text?: string }> }> }): string[] =>
  request.messages.filter((message) => message.hidden).flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text ?? ''))

describe('prepare before the first model call', () => {
  it('runs with the user message already shown, reports progress as quiet notices, and hands the model its text', async () => {
    const provider = new ScriptedProvider([{ text: 'Resumo pronto.' }])
    const { runner, events } = makeRunner(provider)
    let calledWithMessages = -1
    await runner.send('resuma o vídeo', {
      prepareLabel: 'media_ingest',
      prepare: async ({ progress }) => {
        calledWithMessages = runner.messages.length
        expect(provider.requests).toHaveLength(0)
        progress('Processando aula.mp4: transcrição, frames e memória…')
        return { text: '<midia-processada>\nMídia processada: aula.mp4 [video-aula-abc123]\n</midia-processada>' }
      }
    })
    // the user's message was already in the history, and it is the one the model reads first
    expect(calledWithMessages).toBe(1)
    const messageIndex = events.findIndex((event) => event.type === 'message')
    const noticeIndex = events.findIndex((event) => event.type === 'notice' && /Processando aula\.mp4/.test((event as { text: string }).text))
    expect(messageIndex).toBeGreaterThanOrEqual(0)
    expect(noticeIndex).toBeGreaterThan(messageIndex)
    expect(events[noticeIndex]).toMatchObject({ type: 'notice', level: 'info', desktop: false })

    // While it works it shows as a running tool (name, elapsed time, last note): not a silent "thinking", and not in the history.
    const start = events.find((event) => event.type === 'tool_start') as { toolCallId: string; name: string } | undefined
    expect(start?.name).toBe('media_ingest')
    expect(events.find((event) => event.type === 'tool_progress')).toMatchObject({ toolCallId: start?.toolCallId, name: 'media_ingest', text: expect.stringContaining('Processando aula.mp4') })
    const end = events.find((event) => event.type === 'tool_end')
    expect(end).toMatchObject({ toolCallId: start?.toolCallId, name: 'media_ingest', ok: true, summary: 'concluído' })
    expect(events.findIndex((event) => event.type === 'tool_end')).toBeLessThan(events.findIndex((event) => event.type === 'turn_end'))
    expect(runner.messages.some((message) => message.parts.some((part) => part.type === 'tool_call'))).toBe(false)

    expect(provider.requests).toHaveLength(1)
    const sent = provider.requests[0].messages
    expect(sent[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'resuma o vídeo' }] })
    expect(sent[0].hidden).toBeFalsy()
    expect(hiddenTexts(provider.requests[0])).toEqual([expect.stringContaining('[video-aula-abc123]')])
    expect(sent.findIndex((message) => message.hidden)).toBeGreaterThan(0)
  })

  it('shows the contact sheets to a model that sees images and keeps them from one that does not', async () => {
    const seeing = new ScriptedProvider([{ text: 'ok' }])
    await makeRunner(seeing).runner.send('veja', { prepare: async () => ({ text: '<midia-processada>x</midia-processada>', images: [sheet] }) })
    const seen = seeing.requests[0].messages.find((message) => message.hidden)
    expect(seen?.parts.map((part) => part.type)).toEqual(['text', 'image'])

    const blind = new ScriptedProvider([{ text: 'ok' }])
    Object.defineProperty(blind, 'supportsVision', { value: false })
    await makeRunner(blind).runner.send('veja', { prepare: async () => ({ text: '<midia-processada>x</midia-processada>', images: [sheet] }) })
    const unseen = blind.requests[0].messages.find((message) => message.hidden)
    expect(unseen?.parts.map((part) => part.type)).toEqual(['text'])
  })

  it('reports a failure and still answers the user', async () => {
    const provider = new ScriptedProvider([{ text: 'Respondi sem a mídia.' }])
    const { runner, events } = makeRunner(provider)
    await runner.send('resuma', {
      prepare: async () => {
        throw new Error('motor de mídia indisponível')
      }
    })
    expect(events.some((event) => event.type === 'notice' && event.level === 'warn' && /preparação do pedido falhou: motor de mídia indisponível/.test(event.text))).toBe(true)
    expect(events.find((event) => event.type === 'tool_end')).toMatchObject({ name: 'preparar', ok: false, summary: expect.stringContaining('motor de mídia indisponível') })
    expect(provider.requests).toHaveLength(1)
    expect(hiddenTexts(provider.requests[0])).toEqual([])
    expect(runner.messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('does nothing when the preparation has nothing to add', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }])
    await makeRunner(provider).runner.send('oi', { prepare: async () => null })
    expect(hiddenTexts(provider.requests[0])).toEqual([])
  })

  it('stops the turn without calling the model when the user cancels while it prepares', async () => {
    const provider = new ScriptedProvider([{ text: 'não devia chegar aqui' }])
    const { runner, events } = makeRunner(provider)
    const sending = runner.send('resuma', {
      prepare: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelado')), { once: true })
          setTimeout(() => runner.abort(), 20)
        })
    })
    await sending
    expect(provider.requests).toHaveLength(0)
    expect(events.some((event) => event.type === 'turn_end' && (event as { cancelled?: boolean }).cancelled)).toBe(true)
    expect(events.some((event) => event.type === 'notice' && /preparação do pedido falhou/.test((event as { text: string }).text))).toBe(false)
  })
})
