import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProjectInstructions } from '../src/core/agent/context'
import { makeTempDir, removeTempDir } from './helpers'

let root: string
const write = (relative: string, content: string): void => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

beforeEach(async () => {
  root = await makeTempDir('openclod-instr-')
})
afterEach(async () => removeTempDir(root))

describe('project instructions hierarchy', () => {
  it('reads the repository root before the package folder, then the personal local file', () => {
    fs.mkdirSync(path.join(root, '.git'))
    write('CLAUDE.md', 'REGRA DA RAIZ')
    write('packages/app/CLAUDE.md', 'REGRA DO PACOTE')
    write('packages/app/CLAUDE.local.md', 'PREFERÊNCIA PESSOAL')
    const text = loadProjectInstructions(path.join(root, 'packages', 'app')) ?? ''
    expect(text.indexOf('REGRA DA RAIZ')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('REGRA DA RAIZ')).toBeLessThan(text.indexOf('REGRA DO PACOTE'))
    expect(text.indexOf('REGRA DO PACOTE')).toBeLessThan(text.indexOf('PREFERÊNCIA PESSOAL'))
    expect(text).toContain('../../CLAUDE.md')
  })

  it('does not climb past the repository root', () => {
    write('CLAUDE.md', 'FORA DO REPOSITÓRIO')
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true })
    write('repo/CLAUDE.md', 'DENTRO')
    const text = loadProjectInstructions(path.join(root, 'repo')) ?? ''
    expect(text).toContain('DENTRO')
    expect(text).not.toContain('FORA DO REPOSITÓRIO')
  })

  it('expands @imports inside the project and ignores the ones that escape it or point nowhere', () => {
    fs.mkdirSync(path.join(root, '.git'))
    write('CLAUDE.md', 'Veja @docs/estilo.md e também @../segredo.md e @nao-existe.md ok.')
    write('docs/estilo.md', 'USE TABS')
    fs.writeFileSync(path.join(path.dirname(root), 'segredo.md'), 'NUNCA DEVE APARECER')
    const text = loadProjectInstructions(root) ?? ''
    expect(text).toContain('USE TABS')
    expect(text).toContain('importado de docs/estilo.md')
    expect(text).not.toContain('NUNCA DEVE APARECER')
    expect(text).toContain('@nao-existe.md')
    fs.rmSync(path.join(path.dirname(root), 'segredo.md'), { force: true })
  })

  it('survives import cycles and identical files, and bounds the total size', () => {
    fs.mkdirSync(path.join(root, '.git'))
    write('CLAUDE.md', 'A importa @b.md')
    write('b.md', 'B importa @CLAUDE.md')
    expect(loadProjectInstructions(root)).toContain('B importa')
    write('AGENTS.md', 'A importa @b.md') // same content as CLAUDE.md: included once
    expect((loadProjectInstructions(root) ?? '').match(/A importa/g)).toHaveLength(1)
    for (let i = 0; i < 6; i++) write(`pacote${i}/CLAUDE.md`, 'x'.repeat(11_000))
    const deep = path.join(root, 'pacote0')
    expect((loadProjectInstructions(deep) ?? '').length).toBeLessThan(45_000)
  })
})
