import { describe, expect, it } from 'vitest'
import { effortLevelsFor } from '../src/shared/reasoning'
import { presetToConfig } from '../src/core/providers/presets'

describe('effort levels per provider/model', () => {
  it('uses explicit levels configured for an OpenAI-compatible provider', () => {
    expect(effortLevelsFor('openai', 'deepseek-flash', false, ['low', 'high'])).toEqual(['low', 'high'])
    expect(effortLevelsFor('openai', 'deepseek-flash')).toEqual(['low', 'high', 'max'])
    expect(effortLevelsFor('openai', 'deepseek/deepseek-v4-pro')).toEqual(['low', 'high', 'max'])
  })

  it('keeps automatic detection when the provider does not declare levels', () => {
    expect(effortLevelsFor('openai', 'gpt-5.2')).toEqual(['low', 'medium', 'high'])
    expect(effortLevelsFor('anthropic', 'claude-opus-4-5')).toContain('high')
  })

  it('ships the DeepSeek V4 levels in the provider preset', () => {
    expect(presetToConfig('deepseek').effortLevels).toEqual(['low', 'high', 'max'])
  })
})
