import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_IGNORES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  'release'
])

export interface WalkOptions {
  maxFiles?: number
  maxDepth?: number
  signal?: AbortSignal
  include?: (relPath: string) => boolean
  ignore?: Set<string>
}

export async function* walkFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const maxFiles = opts.maxFiles ?? 20_000
  const maxDepth = opts.maxDepth ?? 20
  const ignore = opts.ignore ?? DEFAULT_IGNORES
  let count = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length) {
    if (opts.signal?.aborted) return
    const { dir, depth } = stack.pop()!
    if (depth > maxDepth) continue
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile()) {
        if (opts.include && !opts.include(path.relative(root, full).replace(/\\/g, '/'))) continue
        yield full
        if (++count >= maxFiles) return
      }
    }
  }
}

/** Minimal glob → RegExp: supports **, *, ?, {a,b} and character classes. */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  const normalized = pattern.replace(/\\/g, '/')
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        out += '.*'
        i++
        if (normalized[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '{') {
      const end = normalized.indexOf('}', i)
      if (end > 0) {
        const options = normalized.slice(i + 1, end).split(',')
        out += `(?:${options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = end
      } else {
        out += '\\{'
      }
    } else if ('.[](){}^$+'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 4096)
  return probe.includes(0)
}
