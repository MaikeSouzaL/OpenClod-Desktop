import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecurityError, WorkspaceGuard, expandLeadingEnv } from '../src/core/security/policy'

// Cowork tells the model to keep helper scripts in %TEMP%. The shell expands that, the file tools did not: write_file("%TEMP%\gerar.py")
// created a folder literally named "%TEMP%" inside the user's own folder. A leading, known folder variable is now expanded.

const windows = process.platform === 'win32'
const run = windows ? describe : describe.skip

run('a leading %VARIABLE% in a path given to the file tools', () => {
  it('expands the folder variables a model is likely to write', () => {
    expect(expandLeadingEnv('%TEMP%\\openclod-doc\\gerar.py')).toBe(`${process.env.TEMP}\\openclod-doc\\gerar.py`)
    expect(expandLeadingEnv('%temp%/gerar.py')).toBe(`${process.env.TEMP}/gerar.py`)
    expect(expandLeadingEnv('%TMP%')).toBe(process.env.TMP ?? '%TMP%')
    expect(expandLeadingEnv('%USERPROFILE%\\Desktop\\a.txt')).toBe(`${process.env.USERPROFILE}\\Desktop\\a.txt`)
    expect(expandLeadingEnv('%LOCALAPPDATA%\\Temp')).toBe(`${process.env.LOCALAPPDATA}\\Temp`)
  })

  it('leaves everything else alone: other variables, not at the start, no separator, ordinary paths', () => {
    process.env.OPENCLOD_TEST_SECRET = 'segredo'
    expect(expandLeadingEnv('%OPENCLOD_TEST_SECRET%\\x')).toBe('%OPENCLOD_TEST_SECRET%\\x')
    delete process.env.OPENCLOD_TEST_SECRET
    expect(expandLeadingEnv('C:\\pasta\\%TEMP%\\x')).toBe('C:\\pasta\\%TEMP%\\x')
    expect(expandLeadingEnv('%TEMP%x')).toBe('%TEMP%x')
    expect(expandLeadingEnv('%NAOEXISTE%\\x')).toBe('%NAOEXISTE%\\x')
    expect(expandLeadingEnv('relatorio.docx')).toBe('relatorio.docx')
    expect(expandLeadingEnv('C:\\Users\\ana\\vendas.csv')).toBe('C:\\Users\\ana\\vendas.csv')
  })

  it('resolves to the real temporary folder instead of a "%TEMP%" folder under the project', () => {
    const project = path.join(os.tmpdir(), 'openclod-env-project')
    const open = new WorkspaceGuard([project], true)
    const resolved = open.resolve('%TEMP%\\openclod-doc\\gerar.py', project)
    expect(resolved).toBe(`${process.env.TEMP}\\openclod-doc\\gerar.py`)
    expect(resolved.startsWith(project)).toBe(false)
    expect(resolved).not.toContain('%')
  })

  it('still obeys the containment rules of a guard that is not in full-access mode', () => {
    const project = path.join(os.tmpdir(), 'openclod-env-project-closed')
    expect(() => new WorkspaceGuard([project]).resolve('%USERPROFILE%\\Desktop\\a.txt', project)).toThrow(SecurityError)
    const withTemp = new WorkspaceGuard([project, os.tmpdir()])
    expect(withTemp.resolve('%TEMP%\\gerar.py', project)).toBe(`${process.env.TEMP}\\gerar.py`)
  })
})
