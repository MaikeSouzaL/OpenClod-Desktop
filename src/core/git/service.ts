import { execFile, type ExecFileException } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mergeNumstat, parseNumstat, parseStatusV2, parseWorktreeList } from './parse.js'
import type {
  CreateWorktreeOptions,
  GitFileDiff,
  GitFileDiffOptions,
  GitStatus,
  RemoveWorktreeOptions,
  WorktreeInfo
} from './types.js'

export type {
  CreateWorktreeOptions,
  GitFileDiff,
  GitFileDiffOptions,
  GitFileEntry,
  GitFileState,
  GitStatus,
  RemoveWorktreeOptions,
  WorktreeInfo
} from './types.js'

/**
 * Git service for the desktop UI: structured status, per-file diffs and
 * worktree management (one isolated checkout per session). Everything goes
 * through `execFile('git', ...)` — never a shell — so file names and branch
 * names are never interpreted by cmd/PowerShell/sh.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const WORKTREE_ADD_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024
const STATUS_MAX_BUFFER = 16 * 1024 * 1024
/** Largest diff handed back to the UI before it is cut at a line boundary. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024

const GIT_MISSING = 'O Git não foi encontrado. Instale o Git e reinicie o aplicativo.'
const NOT_A_REPO = 'Esta pasta não é um repositório Git.'
const OUTSIDE_REPO = 'O caminho está fora do repositório.'

/* ---------------------------------- process ---------------------------------- */

interface GitRun {
  /** Exit code; -1 when git could not run or was killed by the timeout. */
  code: number
  stdout: string
  stderr: string
  /** stdout reached maxBuffer: git was stopped and stdout is partial. */
  truncated: boolean
  /** The git executable (or the working directory) could not be started. */
  missing: boolean
  timedOut: boolean
}

interface RunOptions {
  timeout?: number
  maxBuffer?: number
  /** Treat pathspecs literally (default). A few commands, e.g. check-ignore, reject that mode. */
  literalPathspecs?: boolean
}

function runGit(cwd: string, args: string[], options: RunOptions = {}): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // core.quotepath=false keeps non-ASCII paths readable in diff headers.
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          // Never prompt, never take optional index locks (status is polled),
          // treat pathspecs literally ("a[1].txt" is a name, not a glob) and
          // keep messages in English so the few we match on are stable.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_LITERAL_PATHSPECS: options.literalPathspecs === false ? '0' : '1',
          LC_ALL: 'C'
        }
      },
      (err, stdout, stderr) => {
        const base = { stdout: stdout ?? '', stderr: stderr ?? '' }
        if (!err) return resolve({ ...base, code: 0, truncated: false, missing: false, timedOut: false })
        const e: ExecFileException = err
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve({ ...base, code: 0, truncated: true, missing: false, timedOut: false })
        }
        if (e.code === 'ENOENT') {
          return resolve({ ...base, code: -1, truncated: false, missing: true, timedOut: false })
        }
        const stderrText = base.stderr || String(e.message)
        if (typeof e.code === 'number') {
          return resolve({ ...base, stderr: stderrText, code: e.code, truncated: false, missing: false, timedOut: false })
        }
        return resolve({
          ...base,
          stderr: stderrText,
          code: -1,
          truncated: false,
          missing: false,
          timedOut: e.killed === true
        })
      }
    )
  })
}

function gitFailure(run: GitRun, action: string): Error {
  if (run.missing) return new Error(GIT_MISSING)
  if (run.timedOut) return new Error(`${action}: o Git demorou demais para responder.`)
  const detail = run.stderr
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-3)
    .join(' ')
  return new Error(detail ? `${action}: ${detail}` : `${action}.`)
}

/* ------------------------------- repo discovery ------------------------------- */

type RepoLookup =
  | { ok: true; root: string }
  | { ok: false; reason: 'no-dir' | 'no-git' | 'unsafe' | 'not-a-repo'; message: string }

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

function interpretToplevel(run: GitRun): RepoLookup {
  if (run.missing) return { ok: false, reason: 'no-git', message: GIT_MISSING }
  if (run.code === 0) {
    const top = run.stdout.replace(/\r?\n$/, '')
    if (top) return { ok: true, root: path.resolve(top) }
  }
  if (/dubious ownership/i.test(run.stderr)) {
    return {
      ok: false,
      reason: 'unsafe',
      message: 'O Git recusou este repositório (propriedade duvidosa). Adicione a pasta em safe.directory para usá-la.'
    }
  }
  return { ok: false, reason: 'not-a-repo', message: NOT_A_REPO }
}

async function lookupRepo(cwd: string): Promise<RepoLookup> {
  if (typeof cwd !== 'string' || !cwd || !(await isDirectory(cwd))) {
    return { ok: false, reason: 'no-dir', message: `A pasta não existe: ${String(cwd)}` }
  }
  return interpretToplevel(await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeout: 10_000 }))
}

async function requireRepo(cwd: string): Promise<{ root: string }> {
  const repo = await lookupRepo(cwd)
  if (!repo.ok) throw new Error(repo.message)
  return { root: repo.root }
}

/* ----------------------------------- status ----------------------------------- */

/** Drops the last (possibly cut) NUL-terminated record of truncated output. */
function dropPartialRecord(output: string): string {
  const at = output.lastIndexOf('\0')
  return at < 0 ? '' : output.slice(0, at + 1)
}

/**
 * Structured status of the repository containing `cwd`. A folder that is not
 * a repository (or does not exist) yields `{ isRepo: false, files: [] }`
 * instead of an error; `error` is only set when git itself is the problem
 * (missing binary, "dubious ownership").
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (typeof cwd !== 'string' || !cwd || !(await isDirectory(cwd))) return { isRepo: false, files: [] }

  const [top, status, unstagedStat, stagedStat] = await Promise.all([
    runGit(cwd, ['rev-parse', '--show-toplevel'], { timeout: 10_000 }),
    runGit(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      maxBuffer: STATUS_MAX_BUFFER
    }),
    runGit(cwd, ['diff', '--numstat', '-z', '--no-ext-diff']),
    runGit(cwd, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff'])
  ])

  const repo = interpretToplevel(top)
  if (!repo.ok) {
    return repo.reason === 'no-git' || repo.reason === 'unsafe'
      ? { isRepo: false, files: [], error: repo.message }
      : { isRepo: false, files: [] }
  }
  if (status.code !== 0 || status.missing || status.timedOut) throw gitFailure(status, 'Falha ao ler o status do Git')

  const parsed = parseStatusV2(status.truncated ? dropPartialRecord(status.stdout) : status.stdout)
  // Numstat is a nicety: when it fails the list is still correct without counts.
  const stats = mergeNumstat(
    unstagedStat.code === 0 ? parseNumstat(unstagedStat.stdout) : new Map(),
    stagedStat.code === 0 ? parseNumstat(stagedStat.stdout) : new Map()
  )
  for (const file of parsed.files) {
    const stat = stats.get(file.path)
    if (!stat) continue
    if (stat.binary) {
      file.binary = true
    } else {
      file.additions = stat.additions
      file.deletions = stat.deletions
    }
  }
  parsed.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const result: GitStatus = { isRepo: true, root: repo.root, files: parsed.files }
  if (parsed.branch !== undefined) result.branch = parsed.branch
  if (parsed.detached) result.detached = true
  if (parsed.upstream !== undefined) result.upstream = parsed.upstream
  if (parsed.ahead !== undefined) result.ahead = parsed.ahead
  if (parsed.behind !== undefined) result.behind = parsed.behind
  if (status.truncated) result.truncated = true
  return result
}

/* ------------------------------------ diff ------------------------------------ */

/**
 * Resolves the nearest existing ancestor of `target` to its real path and
 * re-appends the part that does not exist (yet, or any more).
 */
async function realpathNearest(target: string): Promise<string> {
  const tail: string[] = []
  let probe = target
  for (;;) {
    try {
      return path.join(await fs.promises.realpath(probe), ...tail.reverse())
    } catch {
      const up = path.dirname(probe)
      if (up === probe) return target
      tail.push(path.basename(probe))
      probe = up
    }
  }
}

function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

/**
 * Resolves a user-supplied path (root-relative, as returned by gitStatus, or
 * absolute) to a root-relative forward-slash path, refusing anything that ends
 * up outside the repository — lexically (`..`, other drives) or through a
 * symlink/junction in one of its parent directories.
 *
 * Both sides are compared as real paths, so an absolute path spelled with 8.3
 * short names, another case or a symlinked prefix still resolves correctly.
 * The last component is not followed: a symlink *file* is diffed by git as the
 * link text, which is safe, while a linked *directory* would let "link/secret"
 * read outside the repository.
 */
async function toRepoRelative(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw new Error('Caminho de arquivo inválido.')
  }
  const absolute = path.resolve(root, input)
  const realRoot = await fs.promises.realpath(root).catch(() => root)
  const realParent = await realpathNearest(path.dirname(absolute))
  const relative = path.relative(realRoot, path.join(realParent, path.basename(absolute)))
  if (!relative) throw new Error('Caminho de arquivo inválido.')
  if (isOutside(relative)) throw new Error(OUTSIDE_REPO)
  return relative.split(path.sep).join('/')
}

/** Cuts a truncated diff at the last complete line. */
function cutAtLine(text: string): string {
  const at = text.lastIndexOf('\n')
  return at < 0 ? text : text.slice(0, at + 1)
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']

/**
 * Unified diff of one file.
 *
 * `filePath` is relative to the repository root (the form gitStatus returns)
 * or absolute; it is never resolved against `cwd`. Untracked files are shown
 * as new files. Output over {@link MAX_DIFF_BYTES} is cut at a line boundary
 * and flagged with `truncated`.
 */
export async function gitFileDiff(
  cwd: string,
  filePath: string,
  options: GitFileDiffOptions = {}
): Promise<GitFileDiff> {
  const staged = options.staged === true
  const { root } = await requireRepo(cwd)
  const rel = await toRepoRelative(root, filePath)
  const oldRel = options.oldPath ? await toRepoRelative(root, options.oldPath) : undefined

  const result = (diff: string, truncated: boolean, untracked: boolean): GitFileDiff => ({
    path: rel,
    staged,
    untracked,
    diff: truncated ? cutAtLine(diff) : diff,
    truncated,
    binary: /^Binary files .* differ$/m.test(diff) || diff.includes('GIT binary patch')
  })

  if (staged) {
    const run = await runGit(root, ['diff', '--cached', '-M', ...DIFF_FLAGS, '--', ...(oldRel ? [oldRel] : []), rel], {
      maxBuffer: MAX_DIFF_BYTES
    })
    if (run.code !== 0) throw gitFailure(run, 'Falha ao obter o diff')
    return result(run.stdout, run.truncated, false)
  }

  const others = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', rel])
  if (others.code !== 0) throw gitFailure(others, 'Falha ao obter o diff')
  if (others.stdout.split('\0').includes(rel)) {
    // `git diff --no-index` exits 1 when the files differ — that is the normal
    // outcome here, not an error. Git itself understands "/dev/null" on every
    // platform, including Git for Windows, so no NUL/devNull juggling.
    const run = await runGit(root, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', rel], {
      maxBuffer: MAX_DIFF_BYTES
    })
    if (run.code !== 0 && run.code !== 1) throw gitFailure(run, 'Falha ao obter o diff')
    return result(run.stdout, run.truncated, true)
  }

  const run = await runGit(root, ['diff', ...DIFF_FLAGS, '--', rel], { maxBuffer: MAX_DIFF_BYTES })
  if (run.code !== 0) throw gitFailure(run, 'Falha ao obter o diff')
  return result(run.stdout, run.truncated, false)
}

/* --------------------------------- worktrees --------------------------------- */

async function readWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const run = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  if (run.code !== 0) throw gitFailure(run, 'Falha ao listar os worktrees')
  return parseWorktreeList(run.stdout)
}

/** Key for comparing paths that may differ in case, separators or 8.3 names. */
async function canonicalKey(target: string): Promise<string> {
  let resolved = path.resolve(target)
  try {
    resolved = await fs.promises.realpath(resolved)
  } catch {
    /* the directory may be gone (prunable worktree): compare lexically */
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch {
    return false
  }
}

/** True when the path exists and is not an empty directory. */
async function isOccupied(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(target)
    if (!stat.isDirectory()) return true
    return (await fs.promises.readdir(target)).length > 0
  } catch {
    return false
  }
}

/**
 * Directory name for a branch: `feature/login` -> `feature-login`. (Windows
 * device names like "nul" need no special case: git cannot create such refs
 * on Windows in the first place.)
 */
function safeWorktreeName(branch: string): string {
  const cleaned = branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/g, '')
  return cleaned || 'worktree'
}

async function validateBranchName(root: string, raw: string): Promise<string> {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('Informe o nome da branch.')
  const invalid = new Error(`Nome de branch inválido: "${name}".`)
  // '@' alone is accepted by check-ref-format but is an alias of HEAD, and a
  // leading '-' would be read as an option by every later command.
  if (name.length > 200 || name === '@' || name.startsWith('-') || name.includes('\0')) throw invalid
  const run = await runGit(root, ['check-ref-format', '--branch', name], { timeout: 10_000 })
  if (run.missing) throw new Error(GIT_MISSING)
  // `--branch` expands "@{-1}" to the previous branch: only accept an exact echo.
  if (run.code !== 0 || run.stdout.replace(/\r?\n$/, '') !== name) throw invalid
  return name
}

/**
 * Keeps `<root>/.openclod/` out of the main repository's status without touching
 * tracked files: appends it to `.git/info/exclude` unless something already
 * ignores it. Best effort — failing here must not fail the worktree.
 */
async function ensureWorktreesIgnored(root: string, sample: string): Promise<void> {
  try {
    const ignored = await runGit(root, ['check-ignore', '-q', '--', sample], { timeout: 10_000, literalPathspecs: false })
    if (ignored.code === 0) return
    const where = await runGit(root, ['rev-parse', '--git-path', 'info/exclude'], { timeout: 10_000 })
    if (where.code !== 0) return
    const file = path.resolve(root, where.stdout.replace(/\r?\n$/, ''))
    const current = await fs.promises.readFile(file, 'utf8').catch(() => '')
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}/.openclod/\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

/** Lists every worktree of the repository containing `repoCwd`, main first. */
export async function listWorktrees(repoCwd: string): Promise<WorktreeInfo[]> {
  const { root } = await requireRepo(repoCwd)
  return readWorktrees(root)
}

/**
 * Creates a new branch checked out in its own worktree (session isolation).
 * The default location is `<main worktree>/.openclod/worktrees/<safe-branch>`;
 * a numeric suffix is added when that directory is already taken. The branch
 * must not exist yet.
 */
export async function createWorktree(repoCwd: string, options: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const { root } = await requireRepo(repoCwd)
  const branch = await validateBranchName(root, options.branch)

  const baseRef = options.baseRef?.trim() || 'HEAD'
  if (baseRef.startsWith('-') || baseRef.includes('\0')) throw new Error(`Referência base inválida: "${baseRef}".`)

  const existing = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { timeout: 10_000 })
  if (existing.code === 0) throw new Error(`A branch "${branch}" já existe.`)
  const base = await runGit(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { timeout: 10_000 })
  if (base.code !== 0) {
    throw new Error(
      baseRef === 'HEAD'
        ? 'O repositório ainda não tem commits: faça um commit antes de criar um worktree.'
        : `Não foi possível resolver a referência base "${baseRef}".`
    )
  }

  // Worktrees always hang off the main checkout, even when called from a linked one.
  const main = (await readWorktrees(root)).find((w) => w.isMain)
  if (!main || main.bare) throw new Error('Repositórios bare não são suportados para criar worktrees.')

  let dir: string
  if (options.dir && options.dir.trim()) {
    dir = path.resolve(main.path, options.dir.trim())
    if (await isOccupied(dir)) throw new Error(`O diretório já existe e não está vazio: ${dir}`)
  } else {
    const parent = path.join(main.path, '.openclod', 'worktrees')
    const name = safeWorktreeName(branch)
    dir = path.join(parent, name)
    for (let n = 2; (await pathExists(dir)) && n < 100; n++) dir = path.join(parent, `${name}-${n}`)
    await ensureWorktreesIgnored(main.path, `.openclod/worktrees/${name}`)
  }

  const add = await runGit(main.path, ['worktree', 'add', '-b', branch, '--', dir, baseRef], {
    timeout: WORKTREE_ADD_TIMEOUT_MS
  })
  if (add.code !== 0) throw gitFailure(add, 'Falha ao criar o worktree')

  const wanted = await canonicalKey(dir)
  for (const worktree of await readWorktrees(main.path)) {
    if ((await canonicalKey(worktree.path)) === wanted) return worktree
  }
  return {
    path: dir,
    head: base.stdout.trim() || undefined,
    branch,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    isMain: false
  }
}

/**
 * Removes a registered, non-main worktree. Without `force` it refuses when the
 * worktree has uncommitted changes (tracked edits or untracked files); a
 * locked worktree is always refused. The branch is left in place so commits
 * made in the worktree are never lost.
 */
export async function removeWorktree(
  repoCwd: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {}
): Promise<WorktreeInfo> {
  const { root } = await requireRepo(repoCwd)
  if (typeof worktreePath !== 'string' || !worktreePath.trim() || worktreePath.includes('\0')) {
    throw new Error('Caminho do worktree inválido.')
  }

  const worktrees = await readWorktrees(root)
  const main = worktrees.find((w) => w.isMain) ?? worktrees[0]
  const wanted = await canonicalKey(path.resolve(main?.path ?? root, worktreePath))
  let target: WorktreeInfo | undefined
  for (const worktree of worktrees) {
    if ((await canonicalKey(worktree.path)) === wanted) {
      target = worktree
      break
    }
  }
  // Only worktrees git itself knows about are ever removed — never an arbitrary directory.
  if (!target) throw new Error(`Worktree não encontrado: ${worktreePath}`)
  if (target.isMain) throw new Error('Não é possível remover o worktree principal.')
  if (target.locked) {
    throw new Error(
      `O worktree está bloqueado${target.lockReason ? ` (${target.lockReason})` : ''}. Desbloqueie-o com "git worktree unlock" antes de remover.`
    )
  }

  const present = await isDirectory(target.path)
  if (present && !options.force) {
    const status = await runGit(target.path, ['status', '--porcelain', '--untracked-files=normal'])
    if (status.code !== 0) throw gitFailure(status, 'Falha ao verificar o worktree')
    const changes = status.stdout.split('\n').filter((line) => line.trim()).length
    if (changes > 0) {
      throw new Error(
        `O worktree tem ${changes} alteração(ões) não commitada(s). Faça commit ou use a remoção forçada para descartá-las.`
      )
    }
  }

  // Run from the main checkout so no child process holds the doomed directory.
  // A worktree whose directory is already gone only needs its record dropped.
  const args = ['worktree', 'remove', ...(options.force || !present ? ['--force'] : []), '--', target.path]
  const run = await runGit(main?.path ?? root, args, { timeout: WORKTREE_ADD_TIMEOUT_MS })
  if (run.code !== 0) throw gitFailure(run, 'Falha ao remover o worktree')
  return target
}
