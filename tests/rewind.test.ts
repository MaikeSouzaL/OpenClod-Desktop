import { describe, expect, it } from 'vitest'
import { rewindMessages } from '../src/core/session/rewind'
import type { Message } from '../src/shared/types'

const message = (id: string, hidden = false): Message => ({
  id,
  role: id.startsWith('u') ? 'user' : 'assistant',
  ts: Number(id.match(/\d+/)?.[0] ?? 0),
  parts: [{ type: 'text', text: id }],
  hidden
})

describe('conversation rewind', () => {
  it('keeps the selected message and discards later history', () => {
    expect(rewindMessages([message('u1'), message('a2'), message('u3')], 'a2').map((item) => item.id)).toEqual(['u1', 'a2'])
  })

  it('rejects unknown and hidden messages', () => {
    expect(() => rewindMessages([message('u1')], 'missing')).toThrow(/não encontrada/)
    expect(() => rewindMessages([message('u1'), message('a2', true)], 'a2')).toThrow(/não encontrada/)
  })
})
