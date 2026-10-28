import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '../src/core/providers/presets'
import { PROVIDER_MARKS } from '../src/renderer/src/lib/provider-logos'
import { providerInitials } from '../src/renderer/src/lib/provider-initials'
import { FROM_SIMPLE_ICONS, buildMarks, render } from '../scripts/provider-logos.mjs'

/**
 * As marcas da grade de Configurações → Provedores vêm embutidas no app (nunca são baixadas) e são GERADAS por
 * scripts/provider-logos.mjs. O que não tem marca (Anthropic: THIRD_PARTY_NOTICES.md §5; provedores criados pelo usuário) mostra
 * as iniciais.
 */
const ROOT = path.join(__dirname, '..')
const GENERATED = path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'provider-logos.ts')
const hasPackage = fs.existsSync(path.join(ROOT, 'node_modules', 'simple-icons', 'package.json'))

describe('provider marks', () => {
  it('every provider the app ships has a mark, except the ones kept off by policy', () => {
    const ids = [...Object.keys(PROVIDER_PRESETS), 'colab']
    const withoutMark = ids.filter((id) => !PROVIDER_MARKS[id])
    expect(withoutMark).toEqual(['anthropic'])
  })

  it('never carries an Anthropic or Claude mark', () => {
    for (const id of Object.keys(PROVIDER_MARKS)) expect(id).not.toMatch(/anthropic|claude/i)
    for (const entry of Object.values(FROM_SIMPLE_ICONS)) expect(entry.slug).not.toMatch(/anthropic|claude/i)
  })

  it('draws every mark as one non-empty path on a 24 grid, with an official colour only when it has one', () => {
    for (const [id, mark] of Object.entries(PROVIDER_MARKS)) {
      expect(mark.viewBox, id).toBe('0 0 24 24')
      expect(mark.path.length, id).toBeGreaterThan(20)
      expect(mark.path, id).toMatch(/^M/)
      if (mark.color) expect(mark.color, id).toMatch(/^#[0-9A-F]{6}$/)
    }
    expect(PROVIDER_MARKS.colab.color).toBe('#F9AB00')
    expect(PROVIDER_MARKS.openai.fillRule).toBe('evenodd')
  })

  it.skipIf(!hasPackage)('the generated file is exactly what the script writes from simple-icons (nobody edited it by hand)', () => {
    const expected = render(buildMarks())
    expect(fs.readFileSync(GENERATED, 'utf8').replace(/\r\n/g, '\n')).toBe(expected)
  })

  it('says where each mark came from', () => {
    const source = fs.readFileSync(GENERATED, 'utf8')
    expect(source).toContain('simple-icons')
    expect(source).toContain('mem0ai/mem0')
    expect(source).not.toMatch(/https?:\/\//)
  })
})

describe('initials for the providers without a mark', () => {
  it('takes the first letter of up to two words and ignores what is in parentheses', () => {
    expect(providerInitials('Anthropic')).toBe('A')
    expect(providerInitials('Meu servidor')).toBe('MS')
    expect(providerInitials('LM Studio (local)')).toBe('LS')
    expect(providerInitials('ollama-cloud')).toBe('OC')
    expect(providerInitials('  ')).toBe('?')
    expect(providerInitials('(só parênteses)')).toBe('?')
    expect(providerInitials('Çatalhöyük API')).toBe('ÇA')
  })
})
