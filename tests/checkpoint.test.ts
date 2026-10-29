import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureGitFileCheckpoint, restoreGitFileCheckpoint } from '../src/core/session/checkpoint'
import { makeTempDir, removeTempDir } from './helpers'

describe('Git file checkpoints', () => {
  let dir: string
  let repo: string
  beforeEach(async () => {
    dir = await makeTempDir('openclod-checkpoint-')
    repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true })
    git('init', '-b', 'main')
    git('config', 'user.name', 'Checkpoint Test')
    git('config', 'user.email', 'checkpoint@example.invalid')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'head advance\n')
    git('add', 'tracked.txt')
    git('commit', '-m', 'base')
  })
  afterEach(async () => removeTempDir(dir))

  it('captures dirty tracked and untracked files and restores them safely', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before turn\n')
    fs.writeFileSync(path.join(repo, 'existing-untracked.txt'), 'existing\n')
    const checkpointDir = path.join(dir, 'checkpoint')
    const checkpoint = await captureGitFileCheckpoint(repo, checkpointDir)
    expect(checkpoint).toMatchObject({ kind: 'git', trackedPatch: true, untracked: ['existing-untracked.txt'] })

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'after turn\n')
    fs.writeFileSync(path.join(repo, 'existing-untracked.txt'), 'changed\n')
    fs.writeFileSync(path.join(repo, 'created-later.txt'), 'later\n')
    const restored = await restoreGitFileCheckpoint(repo, checkpointDir)
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('before turn\n')
    expect(fs.readFileSync(path.join(repo, 'existing-untracked.txt'), 'utf8')).toBe('existing\n')
    expect(fs.existsSync(path.join(repo, 'created-later.txt'))).toBe(false)
    expect(fs.existsSync(path.join(restored.recoveryDir, 'tracked.patch'))).toBe(true)
    expect(fs.readFileSync(path.join(restored.recoveryDir, 'untracked', 'created-later.txt'), 'utf8')).toBe('later\n')
  })

  it('returns null outside Git and rejects a changed HEAD', async () => {
    const plain = path.join(dir, 'plain')
    fs.mkdirSync(plain)
    expect(await captureGitFileCheckpoint(plain, path.join(dir, 'none'))).toBeNull()

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n')
    const checkpointDir = path.join(dir, 'head-checkpoint')
    await captureGitFileCheckpoint(repo, checkpointDir)
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
    execFileSync('git', ['commit', '-am', 'advance'], { cwd: repo, stdio: 'ignore', windowsHide: true })
    await expect(restoreGitFileCheckpoint(repo, checkpointDir)).rejects.toThrow(/HEAD.*mudou|HEAD.*changed/)
  })
})
