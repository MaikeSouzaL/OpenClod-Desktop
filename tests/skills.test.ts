import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillLibrary, parseFrontmatter } from '../src/core/skills/library'
import { describeSkills } from '../src/core/agent/context'
import { makeTempDir, removeTempDir } from './helpers'

describe('parseFrontmatter', () => {
  it('reads plain, quoted, folded and literal values', () => {
    const { meta, body } = parseFrontmatter(
      [
        '---',
        'name: minha-skill',
        'description: >',
        '  Primeira linha da descrição',
        '  continua na segunda.',
        'when: "com \\"aspas\\" e dois-pontos: ok"',
        "other: 'it''s fine'",
        'notes: |',
        '  linha A',
        '  linha B',
        '---',
        '',
        '# Corpo'
      ].join('\n')
    )
    expect(meta.name).toBe('minha-skill')
    expect(meta.description).toBe('Primeira linha da descrição continua na segunda.')
    expect(meta.when).toBe('com "aspas" e dois-pontos: ok')
    expect(meta.other).toBe("it's fine")
    expect(meta.notes).toBe('linha A\nlinha B')
    expect(body.trim()).toBe('# Corpo')
  })

  it('survives a byte-order mark and CRLF, and joins a wrapped plain value', () => {
    const raw = '﻿---\r\nname: crlf\r\ndescription: texto que\r\n  continua aqui\r\n---\r\ncorpo\r\n'
    const { meta, body } = parseFrontmatter(raw)
    expect(meta).toEqual({ name: 'crlf', description: 'texto que continua aqui' })
    expect(body.trim()).toBe('corpo')
  })

  it('returns the whole text as body when there is no header', () => {
    expect(parseFrontmatter('# só corpo')).toEqual({ meta: {}, body: '# só corpo' })
  })
})

describe('SkillLibrary + prompt', () => {
  let dir: string
  beforeEach(async () => {
    dir = await makeTempDir('openclod-skills-')
  })
  afterEach(async () => removeTempDir(dir))

  it('loads a folded description from disk and shows names and descriptions in the system prompt', async () => {
    fs.mkdirSync(path.join(dir, 'longa'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'longa', 'SKILL.md'), '---\nname: longa\ndescription: >\n  Faz uma coisa específica\n  quando o usuário pedir X.\n---\nCorpo')
    const library = new SkillLibrary([{ dir, source: 'usuario' }])
    const [skill] = await library.reload()
    expect(skill.description).toBe('Faz uma coisa específica quando o usuário pedir X.')
    const prompt = describeSkills(library.list())
    expect(prompt).toContain('- longa: Faz uma coisa específica quando o usuário pedir X.')
    expect(prompt).toContain('use_skill ANTES de agir')
  })

  it('keeps the list bounded and points to list_skills when there are too many', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ name: `skill-${index}`, description: 'd'.repeat(300) }))
    const prompt = describeSkills(many)
    expect(prompt.length).toBeLessThan(8000)
    expect(prompt).toMatch(/mais \d+ skill\(s\); use list_skills/)
  })

  it('ships the bundled skills with a real description', async () => {
    const library = new SkillLibrary([{ dir: path.join(__dirname, '..', 'resources', 'skills'), source: 'usuario' }])
    const names = (await library.reload()).map((skill) => skill.name)
    expect(names).toEqual(expect.arrayContaining(['svg-master', 'qa-total', 'animation-master', 'docx', 'xlsx', 'pptx']))
    for (const skill of library.list()) expect(skill.description.length, skill.name).toBeGreaterThan(40)
  })
})

describe('animation-master check-animation.mjs', () => {
  let dir: string
  beforeEach(async () => {
    dir = await makeTempDir('openclod-anim-')
  })
  afterEach(async () => removeTempDir(dir))
  const script = path.join(__dirname, '..', 'resources', 'skills', 'animation-master', 'scripts', 'check-animation.mjs')
  const run = (name: string, content: string): { code: number; out: string } => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    try {
      const out = execFileSync('node', [script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  it('passes a clean spinner that respects reduced motion', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>x</title><style>.a{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.a{animation:none}}</style><path class="a" d="M0 0"/></svg>`
    const result = run('ok.svg', svg)
    expect(result.code).toBe(0)
    expect(result.out).not.toMatch(/ERRO|AVISO/)
  })

  it('flags broken SMIL, scripts and an unguarded infinite loop', () => {
    const svg = `<svg><script>alert(1)</script><rect><animate dur="0s"/><animateTransform dur="1s" attributeName="transform" repeatCount="indefinite"/></rect></svg>`
    const result = run('bad.svg', svg)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/script embutido/)
    expect(result.out).toMatch(/sem attributeName/)
    expect(result.out).toMatch(/nunca anima/)
    expect(result.out).toMatch(/animateTransform> sem type/)
    expect(result.out).toMatch(/prefers-reduced-motion/)
  })

  it('warns about layout-triggering keyframes', () => {
    const html = `<style>.b{animation:grow 2s infinite}@keyframes grow{from{width:10px}to{width:200px}}</style><div class="b"></div>`
    const result = run('layout.html', html)
    expect(result.out).toMatch(/anima width/)
  })
})
