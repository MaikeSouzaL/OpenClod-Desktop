import { describe, expect, it } from 'vitest'
import { normalizeTtsOptions, parseEdgeTtsVoices, parseTtsVoices } from '../src/main/tts'

describe('TTS Windows', () => {
  it('normalizes text, rate and volume within safe ranges', () => {
    expect(normalizeTtsOptions({ text: '  Olá\u0000 mundo  ', rate: 99, volume: -4, voice: 'Microsoft Maria (pt-BR)' })).toEqual({
      text: 'Olá mundo',
      provider: 'edge',
      rate: 10,
      volume: 0,
      voice: 'Microsoft Maria (pt-BR)'
    })
    expect(normalizeTtsOptions({ text: 'silêncio', volume: 0 }).volume).toBe(0)
    expect(normalizeTtsOptions({ text: 'olá', provider: 'edge' })).toMatchObject({ provider: 'edge', voice: 'pt-BR-FranciscaNeural' })
  })

  it('accepts one or many voices and ignores malformed output', () => {
    expect(parseTtsVoices('{"name":"Maria","culture":"pt-BR","gender":"Female","age":"Adult"}')).toEqual([
      { provider: 'windows', id: 'Maria', displayName: 'Maria', name: 'Maria', culture: 'pt-BR', gender: 'Female', age: 'Adult' }
    ])
    expect(parseTtsVoices('[{"name":"A"},{"bad":true}]')).toEqual([
      { provider: 'windows', id: 'A', displayName: 'A', name: 'A', culture: '', gender: '', age: '' }
    ])
    expect(parseTtsVoices('not json')).toEqual([])
  })

  it('parses Edge neural voices and ignores non-neural entries', () => {
    expect(parseEdgeTtsVoices(JSON.stringify([
      { id: 'pt-BR-FranciscaNeural', name: 'Microsoft Francisca Online (Natural)', culture: 'pt-BR', gender: 'Female', categories: ['General'], personalities: ['Friendly'] },
      { id: 'invalid' }
    ]))).toEqual([
      {
        provider: 'edge',
        id: 'pt-BR-FranciscaNeural',
        displayName: 'Microsoft Francisca Online (Natural)',
        name: 'pt-BR-FranciscaNeural',
        culture: 'pt-BR',
        gender: 'Female',
        age: 'Adult',
        categories: ['General'],
        personalities: ['Friendly']
      }
    ])
  })
})
