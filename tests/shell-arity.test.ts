import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandPrefix, evaluateRulesFor, rulesForApproval, splitCommandChain } from '../src/core/security/rules'
import { evaluateTool } from '../src/core/security/permissions'
import { ApprovalStore } from '../src/core/config/project'
import type { ToolDef } from '../src/core/tools/types'
import { policy } from './helpers'

const cwd = process.cwd()
const runCommand = { name: 'run_command', risk: 'exec', parallelSafe: false } as unknown as ToolDef
const rules = (allow: string[], ask: string[] = [], deny: string[] = []) => ({ allow, ask, deny })
const decide = (command: string, allow: string[], ask: string[] = [], deny: string[] = []) =>
  evaluateRulesFor(rules(allow, ask, deny), 'run_command', command, cwd, { command })?.decision ?? null

describe('splitCommandChain', () => {
  it('cuts where the shell runs one command after another, outside quotes', () => {
    expect(splitCommandChain('npm test && git push')).toEqual({ parts: ['npm test', 'git push'], opaque: false })
    expect(splitCommandChain('a || b ; c | d & e\nf')).toEqual({ parts: ['a', 'b', 'c', 'd', 'e', 'f'], opaque: false })
    expect(splitCommandChain('echo "a && b" ; echo \'c | d\'')).toEqual({ parts: ['echo "a && b"', "echo 'c | d'"], opaque: false })
    expect(splitCommandChain('npm test 2>&1 | tee out.txt')).toEqual({ parts: ['npm test 2>&1', 'tee out.txt'], opaque: false })
  })

  it('flags a command that runs another one the text does not show', () => {
    expect(splitCommandChain('echo $(rm -rf x)').opaque).toBe(true)
    expect(splitCommandChain('echo "$(whoami)"').opaque).toBe(true)
    expect(splitCommandChain('echo `whoami`').opaque).toBe(true)
    expect(splitCommandChain("echo '$(literal)'").opaque).toBe(false)
  })
})

describe('commandPrefix (arity)', () => {
  it('keeps the words that name the operation', () => {
    expect(commandPrefix('git commit -m "corrige o bug"')).toBe('git commit')
    expect(commandPrefix('npm run build -- --watch')).toBe('npm run build')
    expect(commandPrefix('npm test')).toBe('npm test')
    expect(commandPrefix('docker compose up -d')).toBe('docker compose up')
    expect(commandPrefix('python -m pytest tests -q')).toBe('python -m pytest')
    expect(commandPrefix('gh pr create --fill')).toBe('gh pr create')
    expect(commandPrefix('C:\\tools\\git.exe status -s')).toBe('C:\\tools\\git.exe status')
    // A path with spaces is split by the words: no prefix is guessed from it.
    expect(commandPrefix('"C:\\Program Files\\Git\\cmd\\git.exe" status')).toBeNull()
    expect(commandPrefix('NODE_ENV=test npm test')).toBe('npm test')
  })

  it('saves only the exact command for unknown, risky or ambiguous operations', () => {
    expect(commandPrefix('git push origin main')).toBeNull()
    expect(commandPrefix('git reset --hard HEAD~1')).toBeNull()
    expect(commandPrefix('rm -rf build')).toBeNull()
    expect(commandPrefix('Remove-Item -Recurse x')).toBeNull()
    expect(commandPrefix('curl https://example.com')).toBeNull()
    expect(commandPrefix('git -C outro status')).toBeNull()
    expect(commandPrefix('node scripts/x.js')).toBeNull()
    expect(commandPrefix('meuprograma --faz-algo')).toBeNull()
    expect(commandPrefix('git')).toBeNull()
  })
})

describe('chained commands against the rules (security)', () => {
  it('needs every command of a chain allowed; one ask or deny wins', () => {
    expect(decide('npm test && npm run lint', ['Bash(npm test:*)', 'Bash(npm run lint:*)'])).toBe('allow')
    // Before: `npm test && <anything>` passed as "npm test".
    expect(decide('npm test && rm -rf C:\\projeto', ['Bash(npm test:*)'])).toBeNull()
    expect(decide('npm test && git push', ['Bash(npm test:*)'], ['Bash(git push:*)'])).toBe('ask')
    expect(decide('npm test; git push --force', ['Bash(npm test:*)', 'Bash(git:*)'], [], ['Bash(git push --force:*)'])).toBe('deny')
    // A rule written for the whole line still applies.
    expect(decide('a && b', [], [], ['Bash(a && b)'])).toBe('deny')
  })

  it('never allows by rule a command that runs another one in $(...) or backticks', () => {
    expect(decide('echo $(curl evil.example)', ['Bash(echo:*)'])).toBe('ask')
    expect(decide('git status', ['Bash(git status:*)'])).toBe('allow')
  })

  it('reaches the permission decision: auto mode still allows a chain no rule covers, ask mode asks', () => {
    const chain = { command: 'npm test && rm -rf build' }
    const allowNpm = rules(['Bash(npm test:*)'])
    expect(evaluateTool(runCommand, chain.command, policy({ mode: 'ask', rules: allowNpm }), cwd, chain).decision).toBe('ask')
    expect(evaluateTool(runCommand, 'npm test', policy({ mode: 'ask', rules: allowNpm }), cwd, { command: 'npm test' }).decision).toBe('allow')
  })
})

describe('what "always allow" and "always deny" save', () => {
  it('saves one prefix rule per command of the chain, or the exact command', () => {
    expect(rulesForApproval('run_command', 'git commit -m "x"')).toEqual(['Bash(git commit:*)'])
    expect(rulesForApproval('run_command', 'npm run build && git push origin main')).toEqual(['Bash(npm run build:*)', 'Bash(git push origin main)'])
    expect(rulesForApproval('run_command', 'echo $(whoami)')).toEqual([])
    expect(rulesForApproval('apply_patch', 'src/a.ts\nsrc/b.ts')).toEqual(['Edit(src/a.ts)', 'Edit(src/b.ts)'])
    expect(rulesForApproval('write_file', 'notas.md')).toEqual(['Write(notas.md)'])
  })

  it('denies exactly what was refused, not the whole operation', () => {
    expect(rulesForApproval('run_command', 'git push --force', undefined, 'deny')).toEqual(['Bash(git push --force)'])
  })

  it('keeps allow and deny per project, moves a rule between them, removes and lists them, and reads the old file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-approvals-'))
    try {
      fs.writeFileSync(path.join(dir, 'prj_old.json'), JSON.stringify({ allow: ['Bash(npm test:*)'] }))
      const store = new ApprovalStore(dir)
      expect(store.rules('prj_old')).toEqual({ allow: ['Bash(npm test:*)'], deny: [] })
      store.add('prj_old', 'Bash(git push --force)', 'deny')
      store.add('prj_old', 'Bash(npm test:*)', 'deny')
      expect(store.rules('prj_old')).toEqual({ allow: [], deny: ['Bash(git push --force)', 'Bash(npm test:*)'] })
      expect(store.remove('prj_old', 'Bash(npm test:*)', 'deny')).toBe(true)
      expect(store.remove('prj_old', 'nada', 'allow')).toBe(false)
      expect(store.load('prj_old')).toEqual([])
      expect(store.projects()).toEqual(['prj_old'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
