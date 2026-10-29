import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitCheckoutTool, gitCommitTool, gitStatusTool } from '../src/core/tools/git'
import { WorkspaceGuard } from '../src/core/security/policy'
import { FileTracker } from '../src/core/session/tracker'
import type { ToolContext } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let dir: string
let ctx: ToolContext
const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

beforeEach(async () => {
  dir = await makeTempDir('openclod-git-tools-')
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'inicial')
  ctx = {
    sessionId: 'ses_git',
    cwd: dir,
    mode: 'code',
    policy: policy({ mode: 'auto' }),
    workspace: new WorkspaceGuard([dir]),
    signal: new AbortController().signal,
    tracker: new FileTracker(dir),
    emit: () => undefined,
    approve: async () => true,
    log: () => undefined
  } as unknown as ToolContext
})
afterEach(async () => {
  await removeTempDir(dir)
})

describe('git_checkout', () => {
  it('never lets a branch name act as an option or a file path, so local work survives', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'trabalho não commitado\n')
    for (const branch of ['-f', '--force', 'a.txt', '../x', 'feat..x', 'a b', '-b']) {
      const result = await gitCheckoutTool.execute({ branch }, ctx)
      expect(result.ok, branch).toBe(false)
    }
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('trabalho não commitado\n')
  })

  it('creates and switches normal branches, and refuses a switch that would overwrite local changes', async () => {
    expect((await gitCheckoutTool.execute({ branch: 'feature/x-1', create: true }, ctx)).ok).toBe(true)
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x-1')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'na feature\n')
    git('commit', '-q', '-am', 'feature')
    expect((await gitCheckoutTool.execute({ branch: 'main' }, ctx)).ok).toBe(true)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'sujo em main\n')
    const blocked = await gitCheckoutTool.execute({ branch: 'feature/x-1' }, ctx)
    expect(blocked.ok).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('sujo em main\n')
  })
})

describe('git_commit add_all', () => {
  it('commits source but leaves credentials out, and says which ones', async () => {
    fs.writeFileSync(path.join(dir, 'novo.ts'), 'export const x = 1\n')
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=segredo\n')
    fs.mkdirSync(path.join(dir, 'config'))
    fs.writeFileSync(path.join(dir, 'config', 'chave.pem'), '-----BEGIN PRIVATE KEY-----\n')
    const result = await gitCommitTool.execute({ message: 'feat: novo', add_all: true }, ctx)
    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/Não incluí/)
    expect(result.text).toContain('.env')
    expect(result.text).toContain('config/chave.pem')
    const tracked = git('ls-files').split(/\r?\n/)
    expect(tracked).toContain('novo.ts')
    expect(tracked).not.toContain('.env')
    expect(tracked).not.toContain('config/chave.pem')
  })

  it('does not touch a credentials file that is already tracked', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
    git('add', '-f', '.env')
    git('commit', '-q', '-m', 'versionado de propósito')
    fs.writeFileSync(path.join(dir, '.env'), 'A=2\n')
    const result = await gitCommitTool.execute({ message: 'chore: muda env', add_all: true }, ctx)
    // Already tracked: it is a normal modification, but `add -A` with the exclusion leaves it unstaged.
    expect(result.ok).toBe(false)
    expect(git('status', '--porcelain')).toContain('.env')
  })
})

describe('git_status', () => {
  it('lists new files one per line instead of collapsing a new folder', async () => {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'novo.ts'), 'x')
    const result = await gitStatusTool.execute({}, ctx)
    expect(result.text).toContain('src/novo.ts')
  })
})
