import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicProvider, toAnthropicMessages } from '../src/core/providers/anthropic'
import { OpenAICompatibleProvider } from '../src/core/providers/openai'
import { resolveCompat } from '../src/core/providers/compat'
import {
  anthropicFamily,
  anthropicReasoning,
  clampEffort,
  normalizeClaudeId,
  openaiReasoningEffort
} from '../src/core/providers/reasoning'
import { compactIfNeeded } from '../src/core/agent/compaction'
import { ScriptedProvider } from './support/scripted-provider'
import type { Message, ProviderConfig, ProviderEvent } from '../src/shared/types'

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function capture(handler: (body: any, res: http.ServerResponse, index: number) => void): Promise<{ url: string; bodies: any[] }> {
  const bodies: any[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk)).on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      bodies.push(body)
      handler(body, res, bodies.length - 1)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }
}

function sse(res: http.ServerResponse, frames: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
  res.end()
}

function config(url: string, model: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'a', kind: 'anthropic', label: 'a', baseUrl: url, model, contextWindow: 200_000, supportsVision: true, supportsTools: true, ...extra }
}

const user: Message = { id: 'u', role: 'user', ts: 1, parts: [{ type: 'text', text: 'oi' }] }
const OK_STREAM = [
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
]

describe('Claude model families', () => {
  it('normalizes ids from proxies, Bedrock and Vertex', () => {
    expect(normalizeClaudeId('anthropic/claude-opus-4.5')).toBe('claude-opus-4-5')
    expect(normalizeClaudeId('anthropic.claude-sonnet-4-5-v1:0')).toBe('claude-sonnet-4-5')
    expect(normalizeClaudeId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5')
    expect(normalizeClaudeId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4')
  })

  it('classifies thinking style and effort support per model', () => {
    expect(anthropicFamily('claude-opus-5-5')).toMatchObject({ thinking: 'adaptive', thinkingByDefault: true, sampling: false })
    expect(anthropicFamily('claude-fable-5-1').efforts).toContain('xhigh')
    expect(anthropicFamily('claude-sonnet-5-5').thinking).toBe('adaptive')
    expect(anthropicFamily('claude-opus-4-8')).toMatchObject({ thinking: 'adaptive', thinkingByDefault: false, sampling: false })
    expect(anthropicFamily('claude-opus-4-6')).toMatchObject({ thinking: 'adaptive', sampling: true })
    expect(anthropicFamily('claude-opus-4-6').efforts).not.toContain('xhigh')
    expect(anthropicFamily('claude-opus-4-5')).toMatchObject({ thinking: 'budget', efforts: ['low', 'medium', 'high'] })
    expect(anthropicFamily('claude-haiku-4-5')).toMatchObject({ thinking: 'budget', efforts: [] })
    expect(anthropicFamily('claude-haiku-5-5').thinking).toBe('adaptive')
    expect(anthropicFamily('claude-sonnet-4-20250514').thinking).toBe('budget')
    expect(anthropicFamily('claude-3-7-sonnet-20250219').thinking).toBe('budget')
    expect(anthropicFamily('gpt-5').thinking).toBe('none')
    expect(anthropicFamily('claude-x').thinking).toBe('none')
  })

  it('clamps an unsupported effort to the closest lower level', () => {
    expect(clampEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high')
    expect(clampEffort('max', ['low', 'medium', 'high'])).toBe('high')
    expect(clampEffort('low', ['medium', 'high'])).toBe('medium')
    expect(clampEffort('high', [])).toBeUndefined()
    expect(openaiReasoningEffort('xhigh')).toBe('high')
    expect(openaiReasoningEffort('low')).toBe('low')
  })
})

describe('Anthropic reasoning request shaping', () => {
  it('uses adaptive thinking + output_config.effort and never a budget on current models', () => {
    const shape = anthropicReasoning('claude-opus-5-5', 'xhigh', undefined)
    expect(shape.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(shape.outputConfig).toEqual({ effort: 'xhigh' })
    expect(shape.maxTokens).toBe(32_000)
    expect(shape.allowSampling).toBe(false)
    expect(JSON.stringify(shape)).not.toContain('budget_tokens')
  })

  it('leaves thinking optional on Opus 4.8 until an effort is chosen', () => {
    const off = anthropicReasoning('claude-opus-4-8', undefined, undefined)
    expect(off.thinking).toBeUndefined()
    expect(off.maxTokens).toBe(8192)
    expect(anthropicReasoning('claude-opus-4-8', 'medium', undefined).thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  it('keeps thinking always on (adaptive) for Fable without an effort and sends no effort field', () => {
    const shape = anthropicReasoning('claude-fable-5-1', undefined, undefined)
    expect(shape.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(shape.outputConfig).toBeUndefined()
  })

  it('maps effort to budget_tokens below max_tokens on budget models', () => {
    const shape = anthropicReasoning('claude-haiku-4-5', 'high', undefined)
    expect(shape.thinking).toEqual({ type: 'enabled', budget_tokens: 12288 })
    expect(shape.maxTokens).toBeGreaterThan(12288)
    expect(shape.outputConfig).toBeUndefined()
    const opus45 = anthropicReasoning('claude-opus-4-5', 'max', undefined)
    expect(opus45.outputConfig).toEqual({ effort: 'high' })
    expect((opus45.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(opus45.maxTokens)
  })

  it('shrinks the budget to a small explicit max_tokens and skips thinking when it cannot fit', () => {
    const small = anthropicReasoning('claude-haiku-4-5', 'max', 4000)
    expect(small.maxTokens).toBe(4000)
    expect((small.thinking as { budget_tokens: number }).budget_tokens).toBe(2976)
    expect(anthropicReasoning('claude-haiku-4-5', 'max', 1500).thinking).toBeUndefined()
  })

  it('does not enable thinking for unknown models', () => {
    const shape = anthropicReasoning('some-proxy-model', 'high', undefined)
    expect(shape.thinking).toBeUndefined()
    expect(shape.outputConfig).toBeUndefined()
    expect(shape.allowSampling).toBe(true)
  })
})

describe('AnthropicProvider with reasoning', () => {
  it('drops temperature on models that reject it and whenever thinking is on', async () => {
    const server = await capture((_b, res) => sse(res, OK_STREAM))
    const run = async (model: string, effort?: 'low'): Promise<any> => {
      const provider = new AnthropicProvider(config(server.url, model, { temperature: 0.2 }), 'k')
      for await (const _ of provider.stream({ system: 's', messages: [user], tools: [], effort })) void _
      return server.bodies.at(-1)
    }
    expect((await run('claude-opus-4-7')).temperature).toBeUndefined()
    expect((await run('claude-haiku-4-5')).temperature).toBe(0.2)
    const thinking = await run('claude-haiku-4-5', 'low')
    expect(thinking.temperature).toBeUndefined()
    expect(thinking.thinking).toMatchObject({ type: 'enabled' })
  })

  it('captures thinking blocks with signatures and replays them in the original order', async () => {
    const server = await capture((_b, res, index) =>
      sse(
        res,
        index === 0
          ? [
              { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'vou ler ' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'o arquivo' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-1' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENC' } },
              { type: 'content_block_stop', index: 1 },
              { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
              { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
              { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
              { type: 'content_block_stop', index: 2 },
              { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }
            ]
          : OK_STREAM
      )
    )
    const provider = new AnthropicProvider(config(server.url, 'claude-opus-5-5'), 'k')
    const events: ProviderEvent[] = []
    for await (const event of provider.stream({ system: 's', messages: [user], tools: [], effort: 'high' })) events.push(event)

    const blocksEvent = events.find((event) => event.type === 'provider_blocks')
    expect(blocksEvent).toMatchObject({ kind: 'anthropic', model: 'claude-opus-5-5' })
    const blocks = (blocksEvent as { blocks: any[] }).blocks
    expect(blocks.map((block) => block.type)).toEqual(['thinking', 'redacted_thinking', 'tool_use'])
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'vou ler o arquivo', signature: 'SIG-1' })
    expect(blocks[2]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } })
    expect(events.filter((event) => event.type === 'reasoning_delta')).toHaveLength(2)

    const assistant: Message = {
      id: 'a1',
      role: 'assistant',
      ts: 2,
      parts: [{ type: 'tool_call', id: 'toolu_1', name: 'read_file', args: { path: 'a.ts' } }],
      providerBlocks: { kind: 'anthropic', model: 'claude-opus-5-5', blocks }
    }
    const toolResult: Message = { id: 't1', role: 'tool', ts: 3, parts: [{ type: 'tool_result', toolCallId: 'toolu_1', name: 'read_file', ok: true, text: 'conteúdo' }] }
    for await (const _ of provider.stream({ system: 's', messages: [user, assistant, toolResult], tools: [], effort: 'high' })) void _

    const sent = server.bodies[1].messages
    expect(sent[1].role).toBe('assistant')
    expect(sent[1].content.map((block: any) => block.type)).toEqual(['thinking', 'redacted_thinking', 'tool_use'])
    expect(sent[1].content[0].signature).toBe('SIG-1')
    expect(sent[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    // Replaying must not mutate the stored blocks (cache_control is added to a copy).
    expect(JSON.stringify(blocks)).not.toContain('cache_control')
  })

  it('does not store provider blocks when the response has no thinking', async () => {
    const server = await capture((_b, res) => sse(res, OK_STREAM))
    const provider = new AnthropicProvider(config(server.url, 'claude-haiku-4-5'), 'k')
    const events: ProviderEvent[] = []
    for await (const event of provider.stream({ system: 's', messages: [user], tools: [] })) events.push(event)
    expect(events.some((event) => event.type === 'provider_blocks')).toBe(false)
  })

  it('never puts cache_control on a thinking block', () => {
    const body = toAnthropicMessages([
      user,
      { id: 'a', role: 'assistant', ts: 2, parts: [{ type: 'text', text: 'x' }], providerBlocks: { kind: 'anthropic', model: 'm', blocks: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'x' }] } }
    ])
    expect(body[1].content).toHaveLength(2)
    expect(toAnthropicMessages([{ ...user }], { replayThinking: false })).toHaveLength(1)
  })

  it('resends once without thinking history when the API rejects a signature', async () => {
    const server = await capture((_b, res, index) => {
      if (index === 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block.' } }))
        return
      }
      sse(res, OK_STREAM)
    })
    const provider = new AnthropicProvider(config(server.url, 'claude-opus-5-5'), 'k')
    const assistant: Message = {
      id: 'a1',
      role: 'assistant',
      ts: 2,
      parts: [{ type: 'text', text: 'resposta antiga' }],
      providerBlocks: { kind: 'anthropic', model: 'claude-opus-5-5', blocks: [{ type: 'thinking', thinking: 't', signature: 'STALE' }, { type: 'text', text: 'resposta antiga' }] }
    }
    const next: Message = { id: 'u2', role: 'user', ts: 3, parts: [{ type: 'text', text: 'e agora?' }] }
    const events: ProviderEvent[] = []
    for await (const event of provider.stream({ system: 's', messages: [user, assistant, next], tools: [] })) events.push(event)

    expect(server.bodies).toHaveLength(2)
    expect(JSON.stringify(server.bodies[0])).toContain('STALE')
    expect(JSON.stringify(server.bodies[1])).not.toContain('STALE')
    expect(server.bodies[1].messages[1].content).toEqual([{ type: 'text', text: 'resposta antiga' }])
    expect(events.at(-1)).toMatchObject({ type: 'end', stopReason: 'stop' })
  })
})

describe('compaction and reasoning', () => {
  it('drops provider blocks from the turns it keeps (their signatures were made with the old prefix)', async () => {
    const blocks = [{ type: 'thinking', thinking: 't', signature: 's' }]
    const messages: Message[] = Array.from({ length: 14 }, (_, index) =>
      index % 2 === 0
        ? { id: `u${index}`, role: 'user' as const, ts: index, parts: [{ type: 'text' as const, text: `pergunta ${index}` }] }
        : { id: `a${index}`, role: 'assistant' as const, ts: index, parts: [{ type: 'text' as const, text: `resposta ${index}` }], providerBlocks: { kind: 'anthropic' as const, model: 'm', blocks } }
    )
    const provider = new ScriptedProvider([{ text: 'resumo' }, { text: 'resumo' }])
    const result = await compactIfNeeded({ system: 's', messages, provider, contextWindow: 1000, keepRecent: 4, force: true })
    expect(result.compacted).toBe(true)
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(result.messages.some((message) => message.providerBlocks)).toBe(false)
  })
})

describe('OpenAI-compatible reasoning_effort', () => {
  it('sends reasoning_effort only for reasoning models unless forced', async () => {
    const server = await capture((_b, res) => sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
    const run = async (
      model: string,
      compat?: ProviderConfig['compat'],
      effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'xhigh'
    ): Promise<any> => {
      const provider = new OpenAICompatibleProvider(
        { id: 'o', kind: 'openai', label: 'o', baseUrl: server.url, model, contextWindow: 200_000, supportsVision: false, supportsTools: true, compat },
        'k'
      )
      for await (const _ of provider.stream({ system: 's', messages: [user], tools: [], effort })) void _
      return server.bodies.at(-1)
    }
    expect((await run('gpt-5')).reasoning_effort).toBe('high')
    expect((await run('openai/o4-mini')).reasoning_effort).toBe('high')
    expect((await run('gpt-4.1')).reasoning_effort).toBeUndefined()
    expect((await run('deepseek-chat', { reasoningEffort: true })).reasoning_effort).toBe('high')
    expect((await run('deepseek-flash', undefined, 'low')).reasoning_effort).toBe('low')
    expect((await run('deepseek-flash', undefined, 'medium')).reasoning_effort).toBe('high')
    expect((await run('deepseek-flash', undefined, 'high')).reasoning_effort).toBe('high')
    expect((await run('deepseek-flash')).reasoning_effort).toBe('high')
    expect((await run('deepseek-flash', undefined, 'max')).reasoning_effort).toBe('max')
    expect((await run('deepseek-v4-pro', undefined, 'max')).reasoning_effort).toBe('max')
    expect(resolveCompat({ model: 'gpt-4.1', baseUrl: 'http://x', compat: undefined }).reasoningEffort).toBe(false)
    expect(resolveCompat({ model: 'deepseek-flash', baseUrl: 'http://x', compat: undefined }).reasoningEffort).toBe(true)
  })

  it('replays reasoning_content on every assistant turn for DeepSeek V4', async () => {
    const server = await capture((_b, res) => sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
    const provider = new OpenAICompatibleProvider(
      { id: 'o', kind: 'openai', label: 'o', baseUrl: server.url, model: 'deepseek-flash', contextWindow: 200_000, supportsVision: false, supportsTools: true },
      'k'
    )
    const messages: Message[] = [
      user,
      {
        id: 'a1',
        role: 'assistant',
        ts: 2,
        parts: [
          { type: 'reasoning', text: 'raciocínio antigo' },
          { type: 'text', text: 'resposta 1' }
        ]
      },
      { id: 'u2', role: 'user', ts: 3, parts: [{ type: 'text', text: 'segundo' }] },
      { id: 'a2', role: 'assistant', ts: 4, parts: [{ type: 'text', text: 'resposta 2' }] }
    ]
    for await (const _ of provider.stream({ system: 's', messages, tools: [], effort: 'high' })) void _
    const body = server.bodies.at(-1)
    const assistants = body.messages.filter((message: any) => message.role === 'assistant')
    expect(assistants.map((message: any) => message.reasoning_content)).toEqual(['raciocínio antigo', ''])
    expect(body.reasoning_effort).toBe('high')
  })
})
