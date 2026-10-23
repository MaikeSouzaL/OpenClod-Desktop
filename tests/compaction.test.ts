import { describe, expect, it, vi } from 'vitest'
import { compactIfNeeded, estimateContextTokens } from '../src/core/agent/compaction'
import type { Message, MessageRole, ModelRequest, Provider, ProviderEvent } from '../src/shared/types'

function textMessage(id: string, role: MessageRole, text: string): Message {
  return { id, role, ts: 1, parts: [{ type: 'text', text }] }
}

function toolCallMessage(id: string, callId: string, name = 'read_file'): Message {
  return {
    id,
    role: 'assistant',
    ts: 1,
    parts: [
      { type: 'text', text: 'vou ler' },
      { type: 'tool_call', id: callId, name, args: { path: 'a.txt' } }
    ]
  }
}

function toolResultMessage(id: string, callId: string, name = 'read_file'): Message {
  return {
    id,
    role: 'tool',
    ts: 1,
    parts: [{ type: 'tool_result', toolCallId: callId, name, ok: true, text: 'conteúdo do arquivo' }]
  }
}

/** Every tool_result kept in the output must still have its tool_call. */
function expectNoOrphanToolResults(messages: Message[]): void {
  const seenCalls = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        expect(seenCalls.has(part.toolCallId), `tool_result órfão: ${part.toolCallId}`).toBe(true)
      }
      if (part.type === 'tool_call') seenCalls.add(part.id)
    }
  }
}

function fakeProvider(summaryText?: string): Provider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  const provider: Provider & { requests: ModelRequest[] } = {
    id: 'fake-summarizer',
    label: 'Fake summarizer',
    supportsVision: false,
    contextWindow: 1000,
    requests,
    countTokens: (text: string) => Math.ceil(text.length / 3.4),
    async *stream(req: ModelRequest): AsyncGenerator<ProviderEvent> {
      requests.push(req)
      if (summaryText === undefined) {
        yield { type: 'end', stopReason: 'error', toolCalls: [], error: 'summarizer down' }
        return
      }
      yield { type: 'text_delta', text: summaryText }
      yield { type: 'end', stopReason: 'stop', toolCalls: [] }
    }
  }
  return provider
}

describe('estimateContextTokens', () => {
  it('is monotonic as messages are appended and counts the system prompt', () => {
    const system = 'Você é um agente.'
    const messages: Message[] = []
    let previous = estimateContextTokens(system, messages)
    expect(previous).toBeGreaterThan(0)
    for (let i = 0; i < 10; i++) {
      messages.push(textMessage(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(100 + i)))
      const next = estimateContextTokens(system, messages)
      expect(next).toBeGreaterThanOrEqual(previous)
      previous = next
    }
    expect(estimateContextTokens('', [])).toBe(0)
    expect(estimateContextTokens(system, [])).toBeGreaterThan(0)
  })

  it('accounts for tool calls and results in the estimate', () => {
    const call = estimateContextTokens('', [toolCallMessage('a', 'c1')])
    const result = estimateContextTokens('', [toolCallMessage('a', 'c1'), toolResultMessage('t', 'c1')])
    expect(result).toBeGreaterThan(call)
  })
})

describe('compactIfNeeded', () => {
  it('returns the exact same array when under budget and never calls the provider', async () => {
    const provider = fakeProvider('não deveria ser chamado')
    const messages = [
      textMessage('m1', 'user', 'oi'),
      textMessage('m2', 'assistant', 'olá')
    ]
    const snapshot = [...messages]
    const result = await compactIfNeeded({
      system: 'sistema curto',
      messages,
      provider,
      contextWindow: 100_000
    })
    expect(result.compacted).toBe(false)
    expect(result.messages).toBe(messages)
    expect(result.messages).toEqual(snapshot)
    expect(provider.requests).toHaveLength(0)
  })

  it('summarizes older messages and keeps the recent user tail', async () => {
    const provider = fakeProvider('RESUMO DO TESTE')
    const messages: Message[] = []
    for (let i = 0; i < 12; i++) {
      messages.push(
        textMessage(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `mensagem ${i} ` + 'y'.repeat(2000))
      )
    }
    const notes: string[] = []
    const result = await compactIfNeeded({
      system: 'sistema ' + 's'.repeat(1200),
      messages,
      provider,
      contextWindow: 4000,
      keepRecent: 4,
      onNote: (note) => notes.push(note)
    })

    expect(result.compacted).toBe(true)
    expect(result.note).toBe('resumo gerado')
    expect(notes).toEqual(['Contexto compactado com resumo.'])
    expect(result.messages).toHaveLength(5) // summary + 4 recent
    expect(result.messages[0].hidden).toBe(true)
    expect(result.messages[0].role).toBe('user')
    const header = result.messages[0].parts[0]
    expect(header.type).toBe('text')
    if (header.type === 'text') {
      expect(header.text).toContain('RESUMO DO TESTE')
      expect(header.text).toContain('Contexto compactado')
    }
    // The recent tail is preserved in order, starting at a user turn.
    expect(result.messages.slice(1)).toEqual(messages.slice(8))
    expect(result.messages[1].role).toBe('user')
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].maxTokens).toBe(200) // min(1500, floor(4000 * 0.05))
  })

  it('falls back deterministically when the summarizer fails, and still compacts', async () => {
    const provider = fakeProvider(undefined)
    const messages: Message[] = []
    for (let i = 0; i < 12; i++) {
      messages.push(textMessage(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(2000)))
    }
    const result = await compactIfNeeded({
      system: 's'.repeat(2000),
      messages,
      provider,
      contextWindow: 3000,
      keepRecent: 4
    })
    expect(result.compacted).toBe(true)
    expect(result.note).toBe('fallback determinístico')
    const header = result.messages[0].parts[0]
    if (header.type === 'text') expect(header.text).toContain('Contexto compactado')
  })

  it('does not compact a short conversation even when over budget', async () => {
    const provider = fakeProvider('nunca')
    const messages = [textMessage('m1', 'user', 'x'.repeat(20_000))]
    const result = await compactIfNeeded({
      system: '',
      messages,
      provider,
      contextWindow: 1000
    })
    expect(result.compacted).toBe(false)
    expect(result.messages).toBe(messages)
    expect(provider.requests).toHaveLength(0)
  })

  it('never separates a tool_call from its tool_result at the cut point', async () => {
    // Length 8, keepRecent 3 -> initial cut at index 5. Index 5 is a tool
    // result and there is no later user message, so the fallback must walk
    // back to include the assistant tool_call at index 4.
    const messages: Message[] = [
      textMessage('m0', 'user', 'início ' + 'a'.repeat(1000)),
      textMessage('m1', 'user', 'mais ' + 'b'.repeat(1000)),
      toolCallMessage('m2', 'call_1'),
      toolResultMessage('m3', 'call_1'),
      toolCallMessage('m4', 'call_2'),
      toolResultMessage('m5', 'call_2'),
      textMessage('m6', 'assistant', 'depois ' + 'c'.repeat(1000)),
      textMessage('m7', 'assistant', 'fim ' + 'd'.repeat(1000))
    ]
    const provider = fakeProvider('resumo')
    const result = await compactIfNeeded({
      system: 's'.repeat(500),
      messages,
      provider,
      contextWindow: 1600,
      keepRecent: 3
    })
    expect(result.compacted).toBe(true)
    expectNoOrphanToolResults(result.messages)
    const keptCall = result.messages.some((m) => m.parts.some((p) => p.type === 'tool_call'))
    expect(keptCall).toBe(true)
  })

  it('never splits an assistant tool_call from its result when cutting at a user turn', async () => {
    const messages: Message[] = [
      textMessage('u1', 'user', 'pedido ' + 'a'.repeat(1500)),
      toolCallMessage('a1', 'c1'),
      toolResultMessage('t1', 'c1'),
      textMessage('a2', 'assistant', 'pronto ' + 'b'.repeat(1500)),
      textMessage('u2', 'user', 'próximo ' + 'c'.repeat(1500)),
      textMessage('a3', 'assistant', 'ok ' + 'd'.repeat(1500)),
      textMessage('u3', 'user', 'fim ' + 'e'.repeat(1500)),
      textMessage('a4', 'assistant', 'feito ' + 'f'.repeat(1500)),
      textMessage('u4', 'user', 'mais ' + 'g'.repeat(1500)),
      textMessage('a5', 'assistant', 'sim ' + 'h'.repeat(1500)),
      textMessage('u5', 'user', 'último ' + 'i'.repeat(1500))
    ]
    const provider = fakeProvider('resumo')
    const result = await compactIfNeeded({
      system: 's'.repeat(500),
      messages,
      provider,
      contextWindow: 5000,
      keepRecent: 4
    })
    expect(result.compacted).toBe(true)
    expectNoOrphanToolResults(result.messages)
    expect(result.messages[1].role).toBe('user')
  })

  it('does not call onNote when there is nothing to compact', async () => {
    const provider = fakeProvider('x')
    const onNote = vi.fn()
    await compactIfNeeded({
      system: 'curto',
      messages: [textMessage('m1', 'user', 'oi')],
      provider,
      contextWindow: 100_000,
      onNote
    })
    expect(onNote).not.toHaveBeenCalled()
  })
})
