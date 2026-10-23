import path from 'node:path'
import type { GitFileEntry, GitFileState, WorktreeInfo } from './types.js'

/**
 * Pure parsers for the machine-readable formats of git. They take the raw
 * stdout and never touch the file system or spawn processes, so they can be
 * tested with hand-written fixtures (conflicts, copies, type changes...).
 */

/* --------------------------- git status --porcelain=v2 -------------------------- */

export interface ParsedStatus {
  oid?: string
  branch?: string
  detached: boolean
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileEntry[]
}

/** Splits off the first `count` space-separated fields; the rest is the path. */
function splitLeading(line: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = []
  let from = 0
  for (let i = 0; i < count; i++) {
    const at = line.indexOf(' ', from)
    if (at < 0) return null
    fields.push(line.slice(from, at))
    from = at + 1
  }
  return { fields, rest: line.slice(from) }
}

/**
 * Maps the two-letter XY code (X = index vs HEAD, Y = worktree vs index) to a
 * single status. A new file stays "added" even when edited afterwards, and a
 * file missing from the working tree is "deleted" whatever the index says.
 */
function classify(x: string, y: string): GitFileState {
  if (x === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C' || y === 'C' || y === 'A') return 'added'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/**
 * Parses `git status --porcelain=v2 -z --branch`. Entries are NUL-terminated;
 * rename/copy entries are followed by one extra NUL-terminated token holding
 * the original path. Paths are already relative to the repository root.
 */
export function parseStatusV2(output: string): ParsedStatus {
  const result: ParsedStatus = { detached: false, files: [] }
  const byPath = new Map<string, GitFileEntry>()
  const tokens = output.split('\0')

  const push = (entry: GitFileEntry): void => {
    byPath.set(entry.path, entry)
    result.files.push(entry)
  }

  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]
    if (!line) continue

    if (line.startsWith('# ')) {
      const space = line.indexOf(' ', 2)
      const key = space < 0 ? line.slice(2) : line.slice(2, space)
      const value = space < 0 ? '' : line.slice(space + 1)
      if (key === 'branch.oid') {
        result.oid = value === '(initial)' ? undefined : value
      } else if (key === 'branch.head') {
        if (value === '(detached)') result.detached = true
        else result.branch = value
      } else if (key === 'branch.upstream') {
        result.upstream = value
      } else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          result.ahead = Number(m[1])
          result.behind = Number(m[2])
        }
      }
      continue
    }

    const kind = line[0]
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = splitLeading(line, 8)
      if (!parts || !parts.rest) continue
      const xy = parts.fields[1]
      push({
        path: parts.rest,
        status: classify(xy[0], xy[1]),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.'
      })
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
      const parts = splitLeading(line, 9)
      const oldPath = tokens[++i]
      if (!parts || !parts.rest) continue
      const xy = parts.fields[1]
      push({
        path: parts.rest,
        oldPath: oldPath || undefined,
        status: classify(xy[0], xy[1]),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.'
      })
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = splitLeading(line, 10)
      if (!parts || !parts.rest) continue
      push({ path: parts.rest, status: 'conflicted', staged: false, unstaged: true })
    } else if (kind === '?') {
      const file = line.slice(2)
      if (!file) continue
      const existing = byPath.get(file)
      if (existing) {
        // Staged deletion plus a fresh untracked file at the same path.
        existing.unstaged = true
      } else {
        push({ path: file, status: 'untracked', staged: false, unstaged: true })
      }
    }
    // '!' (ignored) and unknown record types are skipped.
  }
  return result
}

/* ------------------------------ git diff --numstat ------------------------------ */

export interface NumstatEntry {
  additions: number
  deletions: number
  binary: boolean
}

/**
 * Parses `git diff --numstat -z`: `<add>\t<del>\t<path>\0`, or for renames
 * `<add>\t<del>\t\0<old>\0<new>\0`. Binary files report `-` for both counts.
 * Keyed by the (new) path.
 */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const stats = new Map<string, NumstatEntry>()
  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token)
    if (!m) continue
    let file = m[3]
    if (file === '') {
      // Rename: the next two tokens are the old and the new path.
      i += 2
      file = tokens[i] ?? ''
    }
    if (!file) continue
    const binary = m[1] === '-' || m[2] === '-'
    const previous = stats.get(file)
    stats.set(file, {
      additions: (previous?.additions ?? 0) + (binary ? 0 : Number(m[1])),
      deletions: (previous?.deletions ?? 0) + (binary ? 0 : Number(m[2])),
      binary: binary || (previous?.binary ?? false)
    })
  }
  return stats
}

/** Sums two numstat maps (staged + unstaged) into a new one. */
export function mergeNumstat(a: Map<string, NumstatEntry>, b: Map<string, NumstatEntry>): Map<string, NumstatEntry> {
  const merged = new Map(a)
  for (const [file, entry] of b) {
    const existing = merged.get(file)
    merged.set(
      file,
      existing
        ? {
            additions: existing.additions + entry.additions,
            deletions: existing.deletions + entry.deletions,
            binary: existing.binary || entry.binary
          }
        : entry
    )
  }
  return merged
}

/* ---------------------------- git worktree list --porcelain ---------------------------- */

/** Decodes a C-style quoted path ("..." with backslash escapes) if it is one. */
function unquoteC(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const inner = value.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch))
      continue
    }
    const next = inner[++i]
    if (next >= '0' && next <= '7') {
      let octal = next
      while (octal.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') octal += inner[++i]
      bytes.push(parseInt(octal, 8) & 0xff)
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' }
      bytes.push(...encoder.encode(map[next] ?? next))
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/**
 * Parses `git worktree list --porcelain`: blocks of `key value` lines, one
 * block per worktree, the main worktree first.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = []
  let current: WorktreeInfo | null = null
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) {
      current = null
      continue
    }
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      current = {
        path: path.resolve(unquoteC(value)),
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        isMain: list.length === 0
      }
      list.push(current)
      continue
    }
    if (!current) continue
    switch (key) {
      case 'HEAD':
        current.head = value
        break
      case 'branch':
        current.branch = value.replace(/^refs\/heads\//, '')
        break
      case 'bare':
        current.bare = true
        break
      case 'detached':
        current.detached = true
        break
      case 'locked':
        current.locked = true
        if (value) current.lockReason = value
        break
      case 'prunable':
        current.prunable = true
        if (value) current.prunableReason = value
        break
    }
  }
  return list
}
