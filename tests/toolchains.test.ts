import { describe, expect, it } from 'vitest'
import { describeToolchains, detectToolchains, parseVersion, type ExecFn } from '../src/core/util/toolchains'

const outputs: Record<string, string> = {
  node: 'v22.22.1\n',
  git: 'git version 2.55.0.windows.3\n',
  go: 'go version go1.26.7 windows/amd64\n',
  rustc: 'rustc 1.99.1 (58cf8f9c3 2026-10-13)\n',
  cargo: 'cargo 1.99.1 (5f94df478 2026-08-27)\n',
  py: 'Python 3.14.5\n',
  java: 'openjdk version "21.0.4" 2024-07-16\n'
}

const fake: ExecFn = async (file) => {
  if (outputs[file]) return outputs[file]
  throw new Error(`spawn ${file} ENOENT`)
}

describe('toolchains', () => {
  it('parses the first version number of the output', () => {
    expect(parseVersion('go version go1.26.7 windows/amd64')).toBe('1.26.7')
    expect(parseVersion('Python 3.10.0')).toBe('3.10.0')
    expect(parseVersion('no digits here')).toBeNull()
    expect(parseVersion('v22.22.1')).toBe('22.22.1')
  })

  it('detects what is installed, falls back from python to py, and ignores what is missing', async () => {
    const found = await detectToolchains(fake)
    expect(found.map((item) => `${item.id} ${item.version}`)).toEqual([
      'node 22.22.1',
      'git 2.55.0',
      'python 3.14.5',
      'go 1.26.7',
      'rust 1.99.1',
      'cargo 1.99.1',
      'java 21.0.4'
    ])
    expect(found.find((item) => item.id === 'python')?.command).toBe('py')
  })

  it('describes present and missing toolchains for the system prompt', async () => {
    const text = describeToolchains(await detectToolchains(fake))
    expect(text).toContain('Go 1.26.7')
    expect(text).toContain('Rust (rustc) 1.99.1')
    expect(text).toMatch(/Não encontrados: .*npm.*\.NET/)
    expect(describeToolchains([])).toContain('nenhuma detectada')
  })

  it('treats a failing probe as not installed instead of throwing', async () => {
    const found = await detectToolchains(async () => {
      throw new Error('boom')
    })
    expect(found).toEqual([])
  })
})
