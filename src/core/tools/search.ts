// Approach notes (no code copied): running ripgrep with --no-config, reading its JSON stream and
// treating exit code 2 + a "regex parse error" on stderr as a bad pattern follows the design of
// opencode's ripgrep adapter.
// Adapted from opencode (MIT), packages/core/src/ripgrep.ts @ 0749dec67568a5a4dcc8ce42b2db5da8fe4ce6fa
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import { DEFAULT_IGNORES, globToRegExp, isProbablyBinary } from '../util/fs-walk.js'
import { truncateMiddle } from '../util/ids.js'
import { bundledBinary } from '../util/resources.js'
import { killTree } from './shell.js'

const MAX_MATCH_LINES = 400
const MAX_FILE_BYTES = 2 * 1024 * 1024
const RG_TIMEOUT_MS = 30_000
/** Candidates collected by glob before the mtime sort; ripgrep is cheap, so this is generous. */
const RG_GLOB_CAP = 20_000
const MAX_STDERR = 8 * 1024

/* ------------------------------------------------------------------ */
/* Bundled ripgrep                                                      */
/* ------------------------------------------------------------------ */

/**
 * The bundled `resources/bin/rg(.exe)`. Never looks at PATH: the app must behave the
 * same on every machine. `OPENCLOD_RG` overrides it for tests: a path to use instead,
 * `off` to force the pure-Node fallback, and a path that does not exist counts as "missing".
 */
export function ripgrepPath(): string | null {
  const override = process.env.OPENCLOD_RG?.trim()
  if (override) {
    if (/^(off|none|false|0)$/i.test(override)) return null
    try {
      return fs.statSync(override).isFile() ? override : null
    } catch {
      return null
    }
  }
  return bundledBinary('rg')
}

export interface LineRun {
  /** Exit code; null when the process was killed or never started. */
  code: number | null
  stderr: string
  /** Why we stopped it early (null when it ended on its own). */
  stopped: 'limit' | 'timeout' | 'abort' | null
  spawnError?: string
}

export interface LineRunOptions {
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Return true to stop the process (result cap reached). */
  onLine: (line: string) => boolean | void
  onSpawn?: (pid: number) => void
}

/** Kills the process and everything it started (taskkill /T on Windows). */
function terminate(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') killTree(child.pid)
  child.kill('SIGKILL')
}

/**
 * Runs a program without a shell and feeds its stdout to `onLine`, one line at a time.
 * Honours an AbortSignal and a timeout by killing the whole process tree, and never
 * rejects: failures come back in the result so the caller can fall back.
 */
export function runLines(bin: string, args: string[], opts: LineRunOptions): Promise<LineRun> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ code: null, stderr: '', stopped: 'abort' })
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A user's ripgrep config file must not change what the agent sees.
        env: { ...process.env, RIPGREP_CONFIG_PATH: '' }
      })
    } catch (err) {
      return resolve({ code: null, stderr: '', stopped: null, spawnError: (err as Error).message })
    }
    if (child.pid) opts.onSpawn?.(child.pid)

    let stopped: LineRun['stopped'] = null
    let settled = false
    let stderr = ''
    let pending = ''
    let safety: NodeJS.Timeout | undefined

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(safety)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderr, stopped, ...(spawnError ? { spawnError } : {}) })
    }
    const stop = (why: NonNullable<LineRun['stopped']>): void => {
      if (stopped) return
      stopped = why
      terminate(child)
      // 'close' normally follows the kill; this only guards against a stuck pipe.
      safety = setTimeout(() => finish(null), 3000)
    }
    const onAbort = (): void => stop('abort')
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs ?? RG_TIMEOUT_MS)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const feed = (line: string): void => {
      if (!line || stopped) return
      if (opts.onLine(line.endsWith('\r') ? line.slice(0, -1) : line) === true) stop('limit')
    }

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      if (stopped) return
      pending += chunk
      let index: number
      while ((index = pending.indexOf('\n')) >= 0 && !stopped) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        feed(line)
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk
    })
    child.on('error', (err) => finish(null, child.pid ? undefined : err.message))
    child.on('close', (code) => {
      if (!stopped) feed(pending)
      finish(code)
    })
  })
}

/** Globs excluded in every search: the same directories the pure-Node walker skips. */
function ignoredDirGlobs(): string[] {
  return [...DEFAULT_IGNORES].flatMap((name) => ['--glob', `!${name}`])
}

/**
 * Flags shared by grep and glob. `--no-require-git` makes .gitignore count even outside
 * a git repository (agent workspaces often are not one); hidden files are searched like
 * in the Node walker, minus the heavy directories above; output order is deterministic.
 */
function baseRgArgs(): string[] {
  return ['--no-config', '--no-require-git', '--no-ignore-global', '--hidden', '--sort', 'path']
}

function rgPathText(entry: { text?: string; bytes?: string } | undefined): string | null {
  if (!entry) return null
  if (typeof entry.text === 'string') return entry.text
  if (typeof entry.bytes === 'string') return Buffer.from(entry.bytes, 'base64').toString('utf8')
  return null
}

function relFromCwd(cwd: string, file: string): string {
  return path.relative(cwd, file).replace(/\\/g, '/')
}

/** `include` globs without a slash match the basename at any depth (gitignore style), like ripgrep. */
function matchesInclude(includeRe: RegExp, hasSlash: boolean, rel: string): boolean {
  return includeRe.test(rel) || (!hasSlash && includeRe.test(rel.slice(rel.lastIndexOf('/') + 1)))
}

/* ------------------------------------------------------------------ */
/* .gitignore for the pure-Node fallback                               */
/* ------------------------------------------------------------------ */

interface IgnoreRule {
  negate: boolean
  dirOnly: boolean
  regex: RegExp
}

/** gitignore glob -> RegExp over a "/"-separated path relative to the .gitignore's directory. */
function gitignoreToRegExp(pattern: string, anchored: boolean): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/'
        const atEnd = i + 2 >= pattern.length
        if (atStart && pattern[i + 2] === '/') {
          out += '(?:.*/)?' // "**/" matches zero or more directories
          i += 2
        } else if (atStart && atEnd) {
          out += '.*'
          i += 1
        } else {
          out += '[^/]*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end > 0) {
        const body = pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')
        out += `[${body}]`
        i = end
      } else {
        out += '\\['
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      i++
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`)
}

export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (!line) continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    rules.push({ negate, dirOnly, regex: gitignoreToRegExp(line, anchored) })
  }
  return rules
}

/**
 * Minimal .gitignore support (nested files, negation, anchoring, directory-only rules) so
 * the fallback sees roughly what ripgrep sees. .gitignore files of the ancestors count up
 * to the nearest directory containing `.git`; without one only the search root and below.
 */
export class GitignoreFilter {
  private readonly top: string
  private readonly rulesCache = new Map<string, IgnoreRule[]>()
  private readonly dirCache = new Map<string, boolean>()

  constructor(private readonly root: string) {
    let top = root
    for (let dir = root; ; ) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        top = dir
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    this.top = top
  }

  private rulesFor(dir: string): IgnoreRule[] {
    let rules = this.rulesCache.get(dir)
    if (!rules) {
      try {
        rules = parseGitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'))
      } catch {
        rules = []
      }
      this.rulesCache.set(dir, rules)
    }
    return rules
  }

  /** Last matching rule wins; rules of deeper .gitignore files come later. */
  private verdict(target: string, isDir: boolean): boolean {
    let ignored = false
    const chain: string[] = []
    for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
      chain.unshift(dir)
      if (dir === this.top || path.dirname(dir) === dir) break
    }
    for (const dir of chain) {
      const rules = this.rulesFor(dir)
      if (!rules.length) continue
      const rel = path.relative(dir, target).split(path.sep).join('/')
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue
        if (rule.regex.test(rel)) ignored = !rule.negate
      }
    }
    return ignored
  }

  /** True when the directory, or one of its parents below the search root, is ignored. */
  dirIgnored(dir: string): boolean {
    // The search root itself (explicitly requested) and everything above it are never filtered.
    if (dir.length <= this.root.length) return false
    const cached = this.dirCache.get(dir)
    if (cached !== undefined) return cached
    const result = this.dirIgnored(path.dirname(dir)) || this.verdict(dir, true)
    this.dirCache.set(dir, result)
    return result
  }

  /** The file's own verdict (its directories are expected to have been checked while walking). */
  fileIgnored(file: string): boolean {
    return this.verdict(file, false)
  }

  /** True when the file (absolute path) or any parent directory is ignored. */
  isIgnored(file: string): boolean {
    return this.dirIgnored(path.dirname(file)) || this.verdict(file, false)
  }
}

/**
 * Like walkFiles, but ignored directories are pruned instead of walked and filtered file by
 * file (a gitignored `data/` or `repositorios/` can hold tens of thousands of files).
 */
async function* walkUnignored(
  root: string,
  filter: GitignoreFilter,
  opts: { signal: AbortSignal; maxFiles: number; accepts?: (rel: string) => boolean }
): AsyncGenerator<string> {
  let count = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length) {
    if (opts.signal.aborted) return
    const { dir, depth } = stack.pop()!
    if (depth > 20) continue
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (DEFAULT_IGNORES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!filter.dirIgnored(full)) stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile()) {
        if (filter.fileIgnored(full)) continue
        if (opts.accepts && !opts.accepts(relFromCwd(root, full))) continue
        yield full
        if (++count >= opts.maxFiles) return
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* grep                                                                 */
/* ------------------------------------------------------------------ */

interface GrepArgs {
  pattern: string
  root: string
  cwd: string
  include?: string
  ignoreCase: boolean
  limit: number
  signal: AbortSignal
}

interface GrepOutcome {
  lines: string[]
  /** Files that contain at least one result line. */
  files: number
  /** Files looked at; null when unknown (ripgrep reports it only for files with matches). */
  scanned: number | null
  engine: 'rg' | 'node'
  /** Set when ripgrep stopped early (timeout): the lines are partial. */
  partial?: 'timeout'
}

/** One result line, identical for both engines. */
function grepLine(rel: string, lineNo: number, text: string): string {
  return `${rel}:${lineNo}: ${text.trim().slice(0, 300)}`
}

/** `include` as a predicate over a path relative to the search root. */
function includeFilter(include: string | undefined): ((rel: string) => boolean) | undefined {
  if (!include) return undefined
  const regex = globToRegExp(include)
  const hasSlash = include.replace(/\\/g, '/').includes('/')
  return (rel) => matchesInclude(regex, hasSlash, rel)
}

/** Directory ripgrep runs in: the search root, or its parent when the root is a single file. */
function rgCwd(root: string): string {
  try {
    return fs.statSync(root).isFile() ? path.dirname(root) : root
  } catch {
    return root
  }
}

/**
 * Lists the files ripgrep would search (ignore rules applied, heavy directories skipped).
 * `include`/`glob` filters are applied by the caller, in JavaScript: ripgrep's own -g globs
 * *override* .gitignore (a `*.log` glob would resurrect ignored logs), so they cannot be used.
 */
async function rgListFiles(
  rg: string,
  root: string,
  signal: AbortSignal,
  onFile: (absolute: string) => boolean | void
): Promise<LineRun> {
  return runLines(rg, [...baseRgArgs(), '--files', '--max-filesize', '2M', ...ignoredDirGlobs(), '--', root], {
    cwd: rgCwd(root),
    signal,
    onLine: (line) => onFile(path.normalize(line))
  })
}

/** Returns null when ripgrep is missing or failed, so the caller can fall back. */
async function grepWithRg(args: GrepArgs, onWarn: (msg: string) => void): Promise<GrepOutcome | null> {
  const rg = ripgrepPath()
  if (!rg) return null
  const rgArgs = [
    ...baseRgArgs(),
    '--json',
    '--crlf', // "foo$" must match CRLF files like it does in the Node scanner
    '--engine',
    'auto', // PCRE2 takes over for look-around / backreferences
    '--max-filesize',
    '2M',
    ...(args.ignoreCase ? ['--ignore-case'] : []),
    ...ignoredDirGlobs(),
    '-e',
    args.pattern,
    '--',
    args.root
  ]
  const accepts = includeFilter(args.include)

  const lines: string[] = []
  const filesWithMatches = new Set<string>()
  let sawSummary = false
  let badJson = false

  const run = await runLines(rg, rgArgs, {
    cwd: rgCwd(args.root),
    signal: args.signal,
    onLine: (line) => {
      let message: { type?: string; data?: Record<string, unknown> }
      try {
        message = JSON.parse(line)
      } catch {
        badJson = true
        return true
      }
      if (message.type === 'match') {
        const data = message.data as {
          path?: { text?: string; bytes?: string }
          lines?: { text?: string; bytes?: string }
          line_number?: number
        }
        const file = rgPathText(data.path)
        const text = rgPathText(data.lines)
        if (file === null || text === null || typeof data.line_number !== 'number') return
        if (accepts && !accepts(relFromCwd(args.root, file))) return
        filesWithMatches.add(file)
        lines.push(grepLine(relFromCwd(args.cwd, file), data.line_number, text))
        return lines.length >= args.limit
      } else if (message.type === 'summary') {
        // Its "searches" counts only files that had matches, so it is not used as a scan count.
        sawSummary = true
      }
    }
  })

  if (run.spawnError) {
    onWarn(`ripgrep não iniciou (${run.spawnError}); usando busca em Node`)
    return null
  }
  const finished = run.stopped !== null || sawSummary
  if (badJson || (!finished && run.code !== 0 && run.code !== 1)) {
    const detail = run.stderr.split(/\r?\n/).find((l) => l.trim()) ?? `código ${run.code}`
    onWarn(`ripgrep falhou (${detail}); usando busca em Node`)
    return null
  }

  // With no results the model still wants to know that files were searched: count them (cheap).
  let scanned: number | null = null
  if (!lines.length && run.stopped === null) {
    let count = 0
    const listed = await rgListFiles(rg, args.root, args.signal, (file) => {
      if (!accepts || accepts(relFromCwd(args.root, file))) count++
    })
    if (listed.stopped === null && !listed.spawnError) scanned = count
  }
  return {
    lines,
    files: filesWithMatches.size,
    scanned,
    engine: 'rg',
    ...(run.stopped === 'timeout' ? { partial: 'timeout' as const } : {})
  }
}

/** Pure-Node scanner: used when ripgrep is missing or fails. */
async function grepWithNode(args: GrepArgs, regex: RegExp): Promise<GrepOutcome> {
  const accepts = includeFilter(args.include)
  const rootStat = await fs.promises.stat(args.root).catch(() => null)
  const filter = new GitignoreFilter(rootStat?.isFile() ? path.dirname(args.root) : args.root)
  const lines: string[] = []
  const filesWithMatches = new Set<string>()
  let scanned = 0

  async function* candidates(): AsyncGenerator<string> {
    if (rootStat?.isFile()) {
      yield args.root
      return
    }
    yield* walkUnignored(args.root, filter, { signal: args.signal, maxFiles: 20_000, accepts })
  }

  for await (const file of candidates()) {
    scanned++
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat || stat.size > MAX_FILE_BYTES) continue
    const buffer = await fs.promises.readFile(file).catch(() => null)
    if (!buffer || isProbablyBinary(buffer)) continue
    const fileLines = buffer.toString('utf8').split(/\r?\n/)
    for (let i = 0; i < fileLines.length; i++) {
      if (regex.test(fileLines[i])) {
        lines.push(grepLine(relFromCwd(args.cwd, file), i + 1, fileLines[i]))
        filesWithMatches.add(file)
        if (lines.length >= args.limit) break
      }
    }
    if (lines.length >= args.limit) break
  }
  return { lines, files: filesWithMatches.size, scanned, engine: 'node' }
}

export const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Pesquisa expressão regular no conteúdo dos arquivos do projeto. Retorna arquivo:linha:conteúdo. Use include para filtrar (ex.: "*.ts").',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    pattern: z.string().min(1).describe('Expressão regular (JavaScript)'),
    path: z.string().optional().describe('Diretório base'),
    include: z.string().optional().describe('Glob de arquivos, ex.: **/*.{ts,tsx}'),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(MAX_MATCH_LINES).optional()
  }),
  describe(a) {
    const args = a as { pattern: string }
    return { title: 'Pesquisar', detail: `/${args.pattern}/`, preview: args.pattern }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      pattern: string
      path?: string
      include?: string
      ignore_case?: boolean
      max_results?: number
    }
    // The JavaScript dialect is the contract: a pattern JS rejects is rejected for both engines.
    let regex: RegExp
    try {
      regex = new RegExp(args.pattern, args.ignore_case ? 'i' : '')
    } catch (err) {
      return { ok: false, text: `expressão regular inválida: ${(err as Error).message}` }
    }
    const search: GrepArgs = {
      pattern: args.pattern,
      root: ctx.workspace.resolve(args.path ?? '.', ctx.cwd),
      cwd: ctx.cwd,
      include: args.include,
      ignoreCase: Boolean(args.ignore_case),
      limit: args.max_results ?? 200,
      signal: ctx.signal
    }

    const outcome =
      (await grepWithRg(search, (msg) => ctx.log?.('warn', msg))) ?? (await grepWithNode(search, regex))
    const { lines: results, scanned, files } = outcome
    const timeout = outcome.partial ? `busca interrompida: tempo limite de ${RG_TIMEOUT_MS / 1000}s` : ''

    if (!results.length) {
      const where = scanned === null ? '' : ` em ${scanned} arquivos`
      return {
        ok: true,
        text: `nenhuma ocorrência de /${args.pattern}/${where}${timeout ? ` (${timeout})` : ''}`,
        summary: '0 resultados',
        data: { matches: 0, files: 0, ...(scanned === null ? {} : { scanned }), engine: outcome.engine }
      }
    }
    return {
      ok: true,
      text: truncateMiddle(results.join('\n'), 30_000) + (timeout ? `\n[${timeout}; resultados parciais]` : ''),
      // "em N arquivos" is the number of files that contain results, for both engines.
      summary: `${results.length} ocorrência(s) em ${files} arquivos`,
      data: { matches: results.length, files, ...(scanned === null ? {} : { scanned }), engine: outcome.engine }
    }
  }
}

/* ------------------------------------------------------------------ */
/* glob                                                                 */
/* ------------------------------------------------------------------ */

interface GlobArgs {
  pattern: string
  root: string
  limit: number
  signal: AbortSignal
}

interface GlobOutcome {
  /** Absolute paths, unsorted. */
  files: string[]
  engine: 'rg' | 'node'
}

async function globWithRg(args: GlobArgs, onWarn: (msg: string) => void): Promise<GlobOutcome | null> {
  const rg = ripgrepPath()
  if (!rg) return null
  const regex = globToRegExp(args.pattern)
  const files: string[] = []
  const run = await rgListFiles(rg, args.root, args.signal, (file) => {
    const rel = relFromCwd(args.root, file)
    if (!regex.test(rel) && !regex.test(rel.slice(rel.lastIndexOf('/') + 1))) return
    files.push(file)
    return files.length >= RG_GLOB_CAP
  })
  if (run.stopped) return { files, engine: 'rg' }
  // Exit 2 with some files listed means a few paths were unreadable; keep what was found.
  if (run.spawnError || (run.code !== 0 && run.code !== 1 && !files.length)) {
    const detail = run.spawnError ?? run.stderr.split(/\r?\n/).find((l) => l.trim()) ?? `código ${run.code}`
    onWarn(`ripgrep falhou (${detail}); usando busca em Node`)
    return null
  }
  return { files, engine: 'rg' }
}

async function globWithNode(args: GlobArgs): Promise<GlobOutcome> {
  const regex = globToRegExp(args.pattern)
  const filter = new GitignoreFilter(args.root)
  const files: string[] = []
  for await (const file of walkUnignored(args.root, filter, {
    signal: args.signal,
    maxFiles: 40_000,
    accepts: (rel) => regex.test(rel) || regex.test(rel.slice(rel.lastIndexOf('/') + 1))
  })) {
    files.push(file)
    if (files.length >= args.limit * 5) break
  }
  return { files, engine: 'node' }
}

/** Bounded-concurrency stat so a 20k-file candidate list does not open 20k handles at once. */
async function mtimes(files: string[]): Promise<Array<{ file: string; mtime: number }>> {
  const out: Array<{ file: string; mtime: number }> = new Array(files.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= files.length) return
      const stat = await fs.promises.stat(files[i]).catch(() => null)
      out[i] = { file: files[i], mtime: stat?.mtimeMs ?? 0 }
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, worker))
  return out
}

export const globTool: ToolDef = {
  name: 'glob',
  description:
    'Localiza arquivos por padrão de caminho (ex.: "src/**/*.ts", "**/*.test.tsx"). Ordena por data de modificação.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),
  describe(a) {
    const args = a as { pattern: string }
    return { title: 'Localizar arquivos', detail: args.pattern, preview: args.pattern }
  },
  async execute(raw, ctx: ToolContext): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { pattern: string; path?: string; limit?: number }
    const search: GlobArgs = {
      pattern: args.pattern,
      root: ctx.workspace.resolve(args.path ?? '.', ctx.cwd),
      limit: args.limit ?? 200,
      signal: ctx.signal
    }

    const outcome = (await globWithRg(search, (msg) => ctx.log?.('warn', msg))) ?? (await globWithNode(search))
    // Newest first; the path breaks ties so both engines return the same order.
    const matches = (await mtimes(outcome.files)).sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1))
    const limited = matches.slice(0, search.limit)
    if (!limited.length) {
      return { ok: true, text: `nenhum arquivo corresponde a ${args.pattern}`, summary: '0 arquivos', data: { engine: outcome.engine } }
    }
    return {
      ok: true,
      text: limited.map((m) => relFromCwd(ctx.cwd, m.file)).join('\n'),
      summary: `${limited.length} arquivo(s)`,
      files: limited.map((m) => m.file),
      data: { engine: outcome.engine }
    }
  }
}

export const searchTools: ToolDef[] = [grepTool, globTool]
