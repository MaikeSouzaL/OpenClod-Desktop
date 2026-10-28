import { describe, expect, it } from 'vitest'
import { toAnthropicMessages } from '../src/core/providers/anthropic'
import { toOpenAIMessages } from '../src/core/providers/openai'
import type { Message } from '../src/shared/types'

const shot = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' }

function transcript(): Message[] {
  return [
    { id: 'u1', role: 'user', ts: 1, parts: [{ type: 'text', text: 'olhe a tela' }] },
    {
      id: 'a1',
      role: 'assistant',
      ts: 2,
      parts: [
        { type: 'tool_call', id: 'c1', name: 'computer_screenshot', args: {} },
        { type: 'tool_call', id: 'c2', name: 'list_dir', args: {} }
      ]
    },
    {
      id: 't1',
      role: 'tool',
      ts: 3,
      parts: [
        { type: 'tool_result', toolCallId: 'c1', name: 'computer_screenshot', ok: true, text: 'captura 800x600', images: [shot] },
        { type: 'tool_result', toolCallId: 'c2', name: 'list_dir', ok: true, text: 'a.txt' }
      ]
    }
  ]
}

describe('screenshots returned by tools reach vision models', () => {
  it('OpenAI-compatible: tool messages stay contiguous, then one user message carries the images', () => {
    const out = toOpenAIMessages('', transcript(), false, false, true)
    const roles = out.map((message) => message.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    const parts = last.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts[0].text).toContain('computer_screenshot')
    expect(parts[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
  })

  it('OpenAI-compatible: a model without vision never receives the pixels', () => {
    const out = toOpenAIMessages('', transcript(), false, false, false)
    expect(out.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(JSON.stringify(out)).not.toContain('AAAA')
  })

  it('Anthropic: the image is a block inside the tool_result, next to the text', () => {
    const out = toAnthropicMessages(transcript(), { vision: true })
    const results = out.flatMap((message) => message.content).filter((block) => block.type === 'tool_result')
    const first = results[0] as { content: unknown }
    expect(Array.isArray(first.content)).toBe(true)
    expect(first.content).toEqual([
      { type: 'text', text: 'captura 800x600' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
    expect((results[1] as { content: unknown }).content).toBe('a.txt')
  })

  it('Anthropic: without vision, or on a failed tool, only text is sent', () => {
    expect(JSON.stringify(toAnthropicMessages(transcript(), { vision: false }))).not.toContain('AAAA')
    const failed = transcript()
    const result = failed[2].parts[0]
    if (result.type === 'tool_result') result.ok = false
    expect(JSON.stringify(toAnthropicMessages(failed, { vision: true }))).not.toContain('AAAA')
  })
})
