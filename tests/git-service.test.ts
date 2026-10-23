import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_DIFF_BYTES,
  createWorktree,
  gitFileDiff,
  gitStatus,
  listWorktrees,
  removeWorktree
} from '../src/core/git/service'
import { mergeNumstat, parseNumstat, parseStatusV2, parseWorktreeList } from '../src/core/git/parse'
import { makeTempDir, removeTempDir } from './helpers'

const execFileP = promisify(execFile)

/** Runs git in a test repo. Identity is set per repo, never globally. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout
}

const temps: string[] = []

/** Non-ASCII prefix on purpose: every path below also exercises unicode handling. */
async function tempDir(prefix = 'forja-git-ação-'): Promise<string> {
  const dir = await makeTempDir(prefix)
  temps.push(dir)
  return dir
}

async function initRepo(): Promise<string> {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.name', 'Forja Test')
  await git(dir, 'config', 'user.email', 'forja@example.test')
  await git(dir, 'config', 'commit.gpgsign', 'false')
  await git(dir, 'config', 'core.autocrlf', 'false')
  return dir
}

async function write(dir: string, rel: string, content: string | Buffer): Promise<void> {
  const file = path.join(dir, ...rel.split('/'))
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, content)
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', message)
}

/** Repo with one commit: a.txt (3 lines), b.txt, sub/c.txt. */
async function seededRepo(): Promise<string> {
  const dir = await initRepo()
  await write(dir, 'a.txt', 'one\ntwo\nthree\n')
  await write(dir, 'b.txt', 'bee\n')
  await write(dir, 'sub/c.txt', 'see\n')
  await commitAll(dir, 'seed')
  return dir
}

const real = (p: string): string => fs.realpathSync.native(p)

afterEach(async () => {
  while (temps.length) await removeTempDir(temps.pop()!)
})

/* -------------------------------------------------------------------------- */

describe('git parsers', () => {
  it('parseStatusV2 reads headers and every entry kind, keeping spaces in paths', () => {
    const out = [
      '# branch.oid 0123456789abcdef',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb dir with space/file name.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '1 .T N... 100644 120000 120000 a b link',
      '1 AM N... 000000 100644 100644 a b added then edited.txt',
      '1 D. N... 100644 000000 000000 a b gone.txt',
      '2 C. N... 100644 100644 100644 a b C100 copy.txt',
      'orig.txt',
      '? untracked file.txt',
      '! ignored.log',
      ''
    ].join('\0')
    const parsed = parseStatusV2(out)

    expect(parsed).toMatchObject({
      oid: '0123456789abcdef',
      branch: 'feat/x',
      detached: false,
      upstream: 'origin/feat/x',
      ahead: 2,
      behind: 1
    })
    const byPath = Object.fromEntries(parsed.files.map((f) => [f.path, f]))
    expect(byPath['dir with space/file name.ts']).toEqual({
      path: 'dir with space/file name.ts',
      status: 'modified',
      staged: false,
      unstaged: true
    })
    expect(byPath['new name.ts']).toMatchObject({ status: 'renamed', oldPath: 'old name.ts', staged: true, unstaged: false })
    expect(byPath['conflict.txt']).toMatchObject({ status: 'conflicted', staged: false, unstaged: true })
    expect(byPath['link']).toMatchObject({ status: 'typechange', staged: false, unstaged: true })
    expect(byPath['added then edited.txt']).toMatchObject({ status: 'added', staged: true, unstaged: true })
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', staged: true, unstaged: false })
    expect(byPath['copy.txt']).toMatchObject({ status: 'added', oldPath: 'orig.txt' })
    expect(byPath['untracked file.txt']).toMatchObject({ status: 'untracked', staged: false, unstaged: true })
    expect(byPath['ignored.log']).toBeUndefined()
  })

  it('parseStatusV2 flags a detached HEAD and an unborn branch', () => {
    const detached = parseStatusV2(['# branch.oid abc', '# branch.head (detached)', ''].join('\0'))
    expect(detached.detached).toBe(true)
    expect(detached.branch).toBeUndefined()

    const unborn = parseStatusV2(['# branch.oid (initial)', '# branch.head main', ''].join('\0'))
    expect(unborn.oid).toBeUndefined()
    expect(unborn.branch).toBe('main')
  })

  it('parseStatusV2 merges a staged deletion and a re-created untracked file at one path', () => {
    const out = ['1 D. N... 100644 000000 000000 a b f.txt', '? f.txt', ''].join('\0')
    const files = parseStatusV2(out).files
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'f.txt', status: 'deleted', staged: true, unstaged: true })
  })

  it('parseNumstat handles counts, binary markers, renames and tabs in names', () => {
    const out = ['3\t1\ta.txt', '-\t-\timg.png', '2\t0\t', 'old.txt', 'new.txt', '1\t1\ttab\tname.txt', ''].join('\0')
    const stats = parseNumstat(out)
    expect(stats.get('a.txt')).toEqual({ additions: 3, deletions: 1, binary: false })
    expect(stats.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true })
    expect(stats.get('new.txt')).toEqual({ additions: 2, deletions: 0, binary: false })
    expect(stats.has('old.txt')).toBe(false)
    expect(stats.get('tab\tname.txt')).toEqual({ additions: 1, deletions: 1, binary: false })
  })

  it('mergeNumstat adds staged and unstaged counts', () => {
    const a = parseNumstat('1\t2\tf.txt\0')
    const b = parseNumstat('4\t5\tf.txt\0-\t-\tg.bin\0')
    const merged = mergeNumstat(a, b)
    expect(merged.get('f.txt')).toEqual({ additions: 5, deletions: 7, binary: false })
    expect(merged.get('g.bin')?.binary).toBe(true)
  })

  it('parseWorktreeList reads main, detached, locked and prunable entries', () => {
    const out = [
      'worktree C:/repo',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/.forja/worktrees/x',
      'HEAD bbbb',
      'detached',
      'locked on a usb stick',
      '',
      'worktree C:/repo/.forja/worktrees/gone',
      'HEAD cccc',
      'branch refs/heads/feat/gone',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree "/tmp/we\\"ird"',
      'bare',
      ''
    ].join('\n')
    const list = parseWorktreeList(out)
    expect(list).toHaveLength(4)
    expect(list[0]).toMatchObject({ path: path.resolve('C:/repo'), branch: 'main', head: 'aaaa', isMain: true, locked: false })
    expect(list[1]).toMatchObject({ detached: true, locked: true, lockReason: 'on a usb stick', isMain: false })
    expect(list[1].branch).toBeUndefined()
    expect(list[2]).toMatchObject({ branch: 'feat/gone', prunable: true, prunableReason: 'gitdir file points to non-existent location' })
    expect(list[3].bare).toBe(true)
    expect(list[3].path).toBe(path.resolve('/tmp/we"ird'))
  })
})

/* -------------------------------------------------------------------------- */

describe('gitStatus', () => {
  it('returns isRepo:false (no throw) for a folder that is not a repository', async () => {
    const dir = await tempDir()
    expect(await gitStatus(dir)).toEqual({ isRepo: false, files: [] })
  })

  it('returns isRepo:false for a folder that does not exist', async () => {
    const dir = await tempDir()
    expect(await gitStatus(path.join(dir, 'nope'))).toEqual({ isRepo: false, files: [] })
    expect(await gitStatus('')).toEqual({ isRepo: false, files: [] })
  })

  it('reports a clean repo with its branch and no upstream', async () => {
    const dir = await seededRepo()
    const status = await gitStatus(dir)
    expect(status.isRepo).toBe(true)
    expect(real(status.root!)).toBe(real(dir))
    expect(status.branch).toBe('main')
    expect(status.upstream).toBeUndefined()
    expect(status.ahead).toBeUndefined()
    expect(status.files).toEqual([])
  })

  it('reports an unstaged modification with numstat counts', async () => {
    const dir = await seededRepo()
    await write(dir, 'a.txt', 'one\nTWO\nthree\nfour\n')
    const { files } = await gitStatus(dir)
    expect(files).toEqual([
      { path: 'a.txt', status: 'modified', staged: false, unstaged: true, additions: 2, deletions: 1 }
    ])
  })

  it('reports staged, and staged-plus-unstaged, changes', async () => {
    const dir = await seededRepo()
    await write(dir, 'a.txt', 'one\ntwo\nthree\nfour\n')
    await git(dir, 'add', 'a.txt')
    await write(dir, 'b.txt', 'bee\nbuzz\n')
    await git(dir, 'add', 'b.txt')
    await write(dir, 'b.txt', 'bee\nbuzz\nbop\n')

    const byPath = Object.fromEntries((await gitStatus(dir)).files.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', staged: true, unstaged: false, additions: 1, deletions: 0 })
    // staged +1 (buzz) and unstaged +1 (bop) are summed.
    expect(byPath['b.txt']).toMatchObject({ status: 'modified', staged: true, unstaged: true, additions: 2, deletions: 0 })
  })

  it('reports added, deleted, staged-deleted and untracked files', async () => {
    const dir = await seededRepo()
    await write(dir, 'new.txt', 'n1\nn2\n')
    await git(dir, 'add', 'new.txt')
    await fs.promises.rm(path.join(dir, 'b.txt'))
    await git(dir, 'rm', '-q', 'sub/c.txt')
    await write(dir, 'loose.txt', 'x\n')

    const byPath = Object.fromEntries((await gitStatus(dir)).files.map((f) => [f.path, f]))
    expect(byPath['new.txt']).toMatchObject({ status: 'added', staged: true, unstaged: false, additions: 2, deletions: 0 })
    expect(byPath['b.txt']).toMatchObject({ status: 'deleted', staged: false, unstaged: true, additions: 0, deletions: 1 })
    expect(byPath['sub/c.txt']).toMatchObject({ status: 'deleted', staged: true, unstaged: false, deletions: 1 })
    expect(byPath['loose.txt']).toMatchObject({ status: 'untracked', staged: false, unstaged: true })
    expect(byPath['loose.txt'].additions).toBeUndefined()
  })

  it('reports a rename with oldPath and counts', async () => {
    const dir = await seededRepo()
    await git(dir, 'mv', 'a.txt', 'renamed.txt')
    await write(dir, 'renamed.txt', 'one\ntwo\nthree\nfour\n')
    await git(dir, 'add', 'renamed.txt')

    const { files } = await gitStatus(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: 'renamed.txt',
      oldPath: 'a.txt',
      status: 'renamed',
      staged: true,
      unstaged: false,
      additions: 1,
      deletions: 0
    })
  })

  it('marks binary files without counts', async () => {
    const dir = await seededRepo()
    await write(dir, 'img.bin', Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]))
    await git(dir, 'add', 'img.bin')
    const entry = (await gitStatus(dir)).files.find((f) => f.path === 'img.bin')!
    expect(entry).toMatchObject({ status: 'added', binary: true })
    expect(entry.additions).toBeUndefined()
  })

  it('reports a merge conflict', async () => {
    const dir = await seededRepo()
    await git(dir, 'checkout', '-q', '-b', 'other')
    await write(dir, 'a.txt', 'other\ntwo\nthree\n')
    await commitAll(dir, 'other')
    await git(dir, 'checkout', '-q', 'main')
    await write(dir, 'a.txt', 'main\ntwo\nthree\n')
    await commitAll(dir, 'main')
    await expect(git(dir, 'merge', 'other')).rejects.toBeTruthy()

    const entry = (await gitStatus(dir)).files.find((f) => f.path === 'a.txt')!
    expect(entry.status).toBe('conflicted')
  })

  it('uses forward slashes and root-relative paths, also from a subdirectory', async () => {
    const dir = await seededRepo()
    await write(dir, 'sub/deep/ação final.txt', 'oi\n')
    await write(dir, 'sub/c.txt', 'see\nmore\n')

    const status = await gitStatus(path.join(dir, 'sub'))
    expect(real(status.root!)).toBe(real(dir))
    expect(status.files.map((f) => f.path)).toEqual(['sub/c.txt', 'sub/deep/ação final.txt'])
    expect(status.files.some((f) => f.path.includes('\\'))).toBe(false)
  })

  it('lists every untracked file inside new folders', async () => {
    const dir = await seededRepo()
    await write(dir, 'newdir/one.txt', '1\n')
    await write(dir, 'newdir/inner/two.txt', '2\n')
    const paths = (await gitStatus(dir)).files.map((f) => f.path)
    expect(paths).toEqual(['newdir/inner/two.txt', 'newdir/one.txt'])
  })

  it('does not list ignored files', async () => {
    const dir = await seededRepo()
    await write(dir, '.gitignore', '*.log\n')
    await commitAll(dir, 'ignore')
    await write(dir, 'debug.log', 'noise\n')
    expect((await gitStatus(dir)).files).toEqual([])
  })

  it('works on a repository without commits', async () => {
    const dir = await initRepo()
    await write(dir, 'first.txt', 'a\nb\n')
    await git(dir, 'add', 'first.txt')
    const status = await gitStatus(dir)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.files).toEqual([
      { path: 'first.txt', status: 'added', staged: true, unstaged: false, additions: 2, deletions: 0 }
    ])
  })

  it('reports a detached HEAD without a branch name', async () => {
    const dir = await seededRepo()
    await git(dir, 'checkout', '-q', '--detach')
    const status = await gitStatus(dir)
    expect(status.detached).toBe(true)
    expect(status.branch).toBeUndefined()
  })

  it('reports upstream, ahead and behind', async () => {
    const dir = await seededRepo()
    const remote = await tempDir('forja-git-remote-')
    await git(remote, 'init', '-q', '--bare', '-b', 'main')
    await git(dir, 'remote', 'add', 'origin', remote)
    await git(dir, 'push', '-q', '-u', 'origin', 'main')

    const clone = await tempDir('forja-git-clone-')
    await git(clone, 'clone', '-q', remote, 'copy')
    const copy = path.join(clone, 'copy')
    await git(copy, 'config', 'user.name', 'Other')
    await git(copy, 'config', 'user.email', 'other@example.test')
    await git(copy, 'config', 'commit.gpgsign', 'false')
    await write(copy, 'remote-only.txt', 'r\n')
    await commitAll(copy, 'remote commit')
    await git(copy, 'push', '-q', 'origin', 'main')

    await write(dir, 'local-only.txt', 'l\n')
    await commitAll(dir, 'local commit')
    await git(dir, 'fetch', '-q', 'origin')

    const status = await gitStatus(dir)
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */

describe('gitFileDiff', () => {
  it('diffs a tracked file against the index', async () => {
    const dir = await seededRepo()
    await write(dir, 'a.txt', 'one\nTWO\nthree\n')
    const result = await gitFileDiff(dir, 'a.txt')
    expect(result).toMatchObject({ path: 'a.txt', staged: false, untracked: false, truncated: false, binary: false })
    expect(result.diff).toContain('--- a/a.txt')
    expect(result.diff).toContain('+++ b/a.txt')
    expect(result.diff).toContain('-two')
    expect(result.diff).toContain('+TWO')
  })

  it('keeps staged and unstaged diffs apart', async () => {
    const dir = await seededRepo()
    await write(dir, 'a.txt', 'one\nTWO\nthree\n')
    await git(dir, 'add', 'a.txt')
    await write(dir, 'a.txt', 'one\nTWO\nthree\nfour\n')

    const staged = await gitFileDiff(dir, 'a.txt', { staged: true })
    expect(staged.staged).toBe(true)
    expect(staged.diff).toContain('+TWO')
    expect(staged.diff).not.toContain('+four')

    const unstaged = await gitFileDiff(dir, 'a.txt')
    expect(unstaged.diff).toContain('+four')
    expect(unstaged.diff).not.toContain('+TWO')
  })

  it('returns an empty diff for an unchanged file', async () => {
    const dir = await seededRepo()
    expect(await gitFileDiff(dir, 'b.txt')).toMatchObject({ diff: '', truncated: false })
  })

  it('diffs an untracked file as a new file (exit code 1 is not an error)', async () => {
    const dir = await seededRepo()
    await write(dir, 'fresh.txt', 'hello\nworld\n')
    const result = await gitFileDiff(dir, 'fresh.txt')
    expect(result.untracked).toBe(true)
    expect(result.diff).toContain('new file mode')
    expect(result.diff).toContain('--- /dev/null')
    expect(result.diff).toContain('+++ b/fresh.txt')
    expect(result.diff).toContain('+hello')
    expect(result.diff).toContain('+world')
  })

  it('diffs untracked files with spaces and non-ASCII names in nested folders', async () => {
    const dir = await seededRepo()
    await write(dir, 'pasta nova/relatório final.txt', 'conteúdo\n')
    const result = await gitFileDiff(dir, 'pasta nova/relatório final.txt')
    expect(result.untracked).toBe(true)
    expect(result.diff).toContain('+conteúdo')
    expect(result.diff).toContain('relatório final.txt')
  })

  it('shows a deleted file and a staged deletion', async () => {
    const dir = await seededRepo()
    await fs.promises.rm(path.join(dir, 'b.txt'))
    await git(dir, 'rm', '-q', 'sub/c.txt')
    expect((await gitFileDiff(dir, 'b.txt')).diff).toContain('deleted file mode')
    expect((await gitFileDiff(dir, 'sub/c.txt', { staged: true })).diff).toContain('deleted file mode')
  })

  it('shows a staged rename when given the old path', async () => {
    const dir = await seededRepo()
    await git(dir, 'mv', 'a.txt', 'moved.txt')
    const result = await gitFileDiff(dir, 'moved.txt', { staged: true, oldPath: 'a.txt' })
    expect(result.diff).toContain('rename from a.txt')
    expect(result.diff).toContain('rename to moved.txt')
  })

  it('returns an empty staged diff for an untracked file', async () => {
    const dir = await seededRepo()
    await write(dir, 'fresh.txt', 'x\n')
    expect(await gitFileDiff(dir, 'fresh.txt', { staged: true })).toMatchObject({ diff: '', untracked: false })
  })

  it('flags binary files', async () => {
    const dir = await seededRepo()
    await write(dir, 'img.bin', Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]))
    const result = await gitFileDiff(dir, 'img.bin')
    expect(result.untracked).toBe(true)
    expect(result.binary).toBe(true)
  })

  it('treats pathspec characters literally (a glob must not match other files)', async () => {
    const dir = await seededRepo()
    await write(dir, 'a.txt', 'changed\n')
    await write(dir, 'b.txt', 'changed\n')
    expect((await gitFileDiff(dir, '*.txt')).diff).toBe('')
    await write(dir, 'weird[1].txt', 'x\n')
    expect((await gitFileDiff(dir, 'weird[1].txt')).diff).toContain('+x')
  })

  it('accepts an absolute path inside the repository', async () => {
    const dir = await seededRepo()
    await write(dir, 'a.txt', 'changed\n')
    const result = await gitFileDiff(dir, path.join(dir, 'a.txt'))
    expect(result.path).toBe('a.txt')
    expect(result.diff).toContain('+changed')
  })

  it('rejects paths that escape the repository', async () => {
    const dir = await seededRepo()
    const outside = await tempDir('forja-git-outside-')
    await write(outside, 'secret.txt', 'top secret\n')

    await expect(gitFileDiff(dir, '../secret.txt')).rejects.toThrow(/fora do repositório/)
    await expect(gitFileDiff(dir, 'sub/../../secret.txt')).rejects.toThrow(/fora do repositório/)
    await expect(gitFileDiff(dir, path.join(outside, 'secret.txt'))).rejects.toThrow(/fora do repositório/)
    await expect(gitFileDiff(dir, 'a.txt', { oldPath: '../secret.txt' })).rejects.toThrow(/fora do repositório/)
    await expect(gitFileDiff(dir, '')).rejects.toThrow(/inválido/)
    await expect(gitFileDiff(dir, '.')).rejects.toThrow(/inválido/)
  })

  it('rejects a path that goes out of the repository through a linked directory', async () => {
    const dir = await seededRepo()
    const outside = await tempDir('forja-git-outside-')
    await write(outside, 'secret.txt', 'top secret\n')
    const link = path.join(dir, 'linked')
    // A junction needs no privileges on Windows; on POSIX the type is ignored.
    fs.symlinkSync(outside, link, 'junction')
    try {
      await expect(gitFileDiff(dir, 'linked/secret.txt')).rejects.toThrow(/fora do repositório/)
    } finally {
      fs.rmSync(link, { force: true })
    }
  })

  it('rejects a folder that is not a repository', async () => {
    const dir = await tempDir()
    await expect(gitFileDiff(dir, 'a.txt')).rejects.toThrow(/não é um repositório/)
  })

  it('caps huge diffs at a line boundary and flags them as truncated', async () => {
    const dir = await seededRepo()
    const line = `${'x'.repeat(99)}\n`
    await write(dir, 'big.txt', line.repeat(Math.ceil((MAX_DIFF_BYTES * 1.5) / line.length)))
    const result = await gitFileDiff(dir, 'big.txt')
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES)
    expect(result.diff.endsWith('\n')).toBe(true)
    expect(result.diff).toContain('+++ b/big.txt')
  })
})

/* -------------------------------------------------------------------------- */

describe('worktrees', () => {
  it('creates a branch in .forja/worktrees/<safe-name> and lists it', async () => {
    const dir = await seededRepo()
    const info = await createWorktree(dir, { branch: 'feature/login' })
    expect(real(info.path)).toBe(path.join(real(dir), '.forja', 'worktrees', 'feature-login'))
    expect(info).toMatchObject({ branch: 'feature/login', isMain: false, bare: false, detached: false, locked: false })
    expect(fs.existsSync(path.join(info.path, 'a.txt'))).toBe(true)
    expect((await git(info.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('feature/login')

    const list = await listWorktrees(dir)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ isMain: true, branch: 'main' })
    expect(real(list[0].path)).toBe(real(dir))
    expect(list[1]).toMatchObject({ branch: 'feature/login', isMain: false })
    expect(list[1].head).toBe((await git(dir, 'rev-parse', 'HEAD')).trim())
  })

  it('keeps .forja/ out of the main repository status', async () => {
    const dir = await seededRepo()
    await createWorktree(dir, { branch: 'iso' })
    expect(await gitStatus(dir)).toMatchObject({ isRepo: true, files: [] })
    // And a second worktree does not append the rule again.
    await createWorktree(dir, { branch: 'iso2' })
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('/.forja/').length - 1).toBe(1)
  })

  it('does not touch info/exclude when .forja is already ignored', async () => {
    const dir = await seededRepo()
    await write(dir, '.gitignore', '.forja/\n')
    await commitAll(dir, 'ignore forja')
    const before = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
    await createWorktree(dir, { branch: 'iso' })
    expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toBe(before)
    expect((await gitStatus(dir)).files).toEqual([])
  })

  it('starts the branch from baseRef', async () => {
    const dir = await seededRepo()
    const first = (await git(dir, 'rev-parse', 'HEAD')).trim()
    await git(dir, 'tag', 'v1')
    await write(dir, 'a.txt', 'later\n')
    await commitAll(dir, 'second')

    const info = await createWorktree(dir, { branch: 'from-tag', baseRef: 'v1' })
    expect(info.head).toBe(first)
    expect((await git(info.path, 'rev-parse', 'HEAD')).trim()).toBe(first)
  })

  it('uses a custom directory (absolute or relative to the main worktree)', async () => {
    const dir = await seededRepo()
    const elsewhere = path.join(await tempDir('forja-git-wt-'), 'checkout')
    const a = await createWorktree(dir, { branch: 'abs', dir: elsewhere })
    expect(real(a.path)).toBe(real(elsewhere))

    const b = await createWorktree(dir, { branch: 'rel', dir: 'nested/place' })
    expect(real(b.path)).toBe(path.join(real(dir), 'nested', 'place'))
  })

  it('refuses a custom directory that is not empty', async () => {
    const dir = await seededRepo()
    const busy = await tempDir('forja-git-busy-')
    await write(busy, 'keep.txt', 'mine\n')
    await expect(createWorktree(dir, { branch: 'busy', dir: busy })).rejects.toThrow(/não está vazio/)
    expect(fs.existsSync(path.join(busy, 'keep.txt'))).toBe(true)
  })

  it('adds a numeric suffix when branch names map to the same directory', async () => {
    const dir = await seededRepo()
    const a = await createWorktree(dir, { branch: 'feat/a' })
    const b = await createWorktree(dir, { branch: 'feat-a' })
    expect(path.basename(a.path)).toBe('feat-a')
    expect(path.basename(b.path)).toBe('feat-a-2')
  })

  it('creates worktrees under the main checkout even when called from a linked one', async () => {
    const dir = await seededRepo()
    const first = await createWorktree(dir, { branch: 'first' })
    const second = await createWorktree(first.path, { branch: 'second' })
    expect(real(second.path)).toBe(path.join(real(dir), '.forja', 'worktrees', 'second'))
    expect(await listWorktrees(first.path)).toHaveLength(3)
  })

  it('validates the branch name and the base', async () => {
    const dir = await seededRepo()
    for (const bad of ['', '   ', 'has space', '-leading', 'a..b', 'x.lock', 'a~1', '@', '@{-1}', 'HEAD', 'trail/']) {
      await expect(createWorktree(dir, { branch: bad })).rejects.toThrow(/branch/i)
    }
    await expect(createWorktree(dir, { branch: 'main' })).rejects.toThrow(/já existe/)
    await expect(createWorktree(dir, { branch: 'ok', baseRef: 'nope-ref' })).rejects.toThrow(/referência base/)
    await expect(createWorktree(dir, { branch: 'ok', baseRef: '--output=x' })).rejects.toThrow(/Referência base inválida/)
    // Nothing was created by the refused calls.
    expect(await listWorktrees(dir)).toHaveLength(1)
    expect((await git(dir, 'branch', '--list', 'ok')).trim()).toBe('')
  })

  it('explains that a repository without commits cannot get a worktree', async () => {
    const dir = await initRepo()
    await expect(createWorktree(dir, { branch: 'x' })).rejects.toThrow(/ainda não tem commits/)
  })

  it('refuses folders that are not repositories', async () => {
    const dir = await tempDir()
    await expect(createWorktree(dir, { branch: 'x' })).rejects.toThrow(/não é um repositório/)
    await expect(listWorktrees(dir)).rejects.toThrow(/não é um repositório/)
    await expect(removeWorktree(dir, path.join(dir, 'x'))).rejects.toThrow(/não é um repositório/)
  })

  it('removes a clean worktree and keeps its branch', async () => {
    const dir = await seededRepo()
    const info = await createWorktree(dir, { branch: 'done' })
    const removed = await removeWorktree(dir, info.path)

    expect(removed.branch).toBe('done')
    expect(fs.existsSync(info.path)).toBe(false)
    expect(await listWorktrees(dir)).toHaveLength(1)
    expect((await git(dir, 'branch', '--list', 'done')).trim()).toContain('done')
  })

  it('accepts the worktree path in any spelling git or the caller may use', async () => {
    const dir = await seededRepo()
    const info = await createWorktree(dir, { branch: 'spelling' })
    // Forward slashes and, on Windows, a different case.
    const alt = info.path.split(path.sep).join('/')
    await removeWorktree(dir, process.platform === 'win32' ? alt.toUpperCase() : alt)
    expect(await listWorktrees(dir)).toHaveLength(1)
  })

  it('refuses to remove the main worktree', async () => {
    const dir = await seededRepo()
    await expect(removeWorktree(dir, dir)).rejects.toThrow(/principal/)
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true)
  })

  it('refuses a path that is not a registered worktree and deletes nothing', async () => {
    const dir = await seededRepo()
    const stranger = await tempDir('forja-git-stranger-')
    await write(stranger, 'keep.txt', 'mine\n')
    await expect(removeWorktree(dir, stranger)).rejects.toThrow(/não encontrado/)
    await expect(removeWorktree(dir, '')).rejects.toThrow(/inválido/)
    expect(fs.existsSync(path.join(stranger, 'keep.txt'))).toBe(true)
  })

  it('refuses a worktree with uncommitted changes unless forced', async () => {
    const dir = await seededRepo()
    const modified = await createWorktree(dir, { branch: 'dirty-mod' })
    await write(modified.path, 'a.txt', 'edited\n')
    await expect(removeWorktree(dir, modified.path)).rejects.toThrow(/não commitada/)
    expect(fs.existsSync(modified.path)).toBe(true)

    const untracked = await createWorktree(dir, { branch: 'dirty-new' })
    await write(untracked.path, 'scratch.txt', 'x\n')
    await expect(removeWorktree(dir, untracked.path)).rejects.toThrow(/1 alteração/)

    await removeWorktree(dir, modified.path, { force: true })
    await removeWorktree(dir, untracked.path, { force: true })
    expect(fs.existsSync(modified.path)).toBe(false)
    expect(fs.existsSync(untracked.path)).toBe(false)
    expect(await listWorktrees(dir)).toHaveLength(1)
  })

  it('ignores ignored files when checking for changes', async () => {
    const dir = await seededRepo()
    await write(dir, '.gitignore', '*.log\n')
    await commitAll(dir, 'ignore logs')
    const info = await createWorktree(dir, { branch: 'logs' })
    await write(info.path, 'run.log', 'noise\n')
    await removeWorktree(dir, info.path)
    expect(fs.existsSync(info.path)).toBe(false)
  })

  it('refuses a locked worktree, even when forced', async () => {
    const dir = await seededRepo()
    const info = await createWorktree(dir, { branch: 'locked-one' })
    await git(dir, 'worktree', 'lock', '--reason', 'on usb', info.path)
    expect((await listWorktrees(dir))[1]).toMatchObject({ locked: true, lockReason: 'on usb' })
    await expect(removeWorktree(dir, info.path, { force: true })).rejects.toThrow(/bloqueado.*on usb/)
    expect(fs.existsSync(info.path)).toBe(true)
  })

  it('drops the record of a worktree whose directory was deleted by hand', async () => {
    const dir = await seededRepo()
    const info = await createWorktree(dir, { branch: 'vanished' })
    await fs.promises.rm(info.path, { recursive: true, force: true })
    expect((await listWorktrees(dir))[1]).toMatchObject({ prunable: true })

    await removeWorktree(dir, info.path)
    expect(await listWorktrees(dir)).toHaveLength(1)
  })
})
