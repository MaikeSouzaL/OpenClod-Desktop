import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../src/core/security/policy'
import {
  GitignoreFilter,
  globTool,
  grepTool,
  parseGitignore,
  ripgrepPath,
  runLines
} from '../src/core/tools/search'
import type { ToolContext } from '../src/core/tools/types'
import { bundledBinary, resetResourcesCache } from '../src/core/util/resources'
import { makeTempDir, removeTempDir } from './helpers'

delete process.env.FORJA_RG
resetResourcesCache()
const BUNDLED_RG = bundledBinary('rg')

let root: string
const savedEnv = { rg: process.env.FORJA_RG, res: process.env.FORJA_RESOURCES, path: process.env.PATH }

function write(rel: string, content: string | Buffer): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** Builds the same tree for every test: ignored, hidden, binary, oversized and CRLF files. */
function buildTree(): void {
  write('.gitignore', 'ignored/\n*.log\n!keep.log\n/rootonly.txt\n# comment\n')
  write('src/a.ts', 'const x = 1 // TODO fix\nfunction foo() {}\n')
  write('src/sub/b.ts', 'line one\r\nTODO second\r\nend\r\n')
  write('src/sub/c.tsx', 'TODO tsx\n')
  write('README.md', '# TODO readme\n')
  write('.github/ci.yml', 'TODO hidden\n')
  write('ignored/z.txt', 'TODO ignored\n')
  write('debug.log', 'TODO log\n')
  write('keep.log', 'TODO keep\n')
  write('rootonly.txt', 'TODO rootonly\n')
  write('nested/rootonly.txt', 'TODO nested rootonly\n')
  write('nested/.gitignore', 'local.txt\n')
  write('nested/local.txt', 'TODO local\n')
  write('nested/other.txt', 'TODO other\n')
  write('node_modules/pkg/i.js', 'TODO node_modules\n')
  write('build/out.js', 'TODO build\n')
  write('bin.dat', Buffer.concat([Buffer.from('bin'), Buffer.from([0]), Buffer.from('TODO binary')]))
  write('big.txt', 'TODO big\n'.repeat(300_000)) // > 2 MB: skipped by both engines
  write('upper/Case.TS', 'TODO upper\n')
  // Distinct mtimes make the glob ordering (newest first) deterministic: everything old, a few newer.
  const old = new Date(Date.UTC(2025, 0, 1))
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else fs.utimesSync(full, old, old)
    }
  }
  walk(root)
  const files = ['src/a.ts', 'src/sub/b.ts', 'src/sub/c.tsx', 'README.md', '.github/ci.yml', 'keep.log', 'nested/other.txt', 'upper/Case.TS']
  files.forEach((rel, index) => {
    const time = new Date(Date.UTC(2026, 0, 1 + index))
    fs.utimesSync(path.join(root, rel), time, time)
  })
}

beforeAll(async () => {
  root = await makeTempDir('forja-rg-')
  buildTree()
})

afterAll(async () => {
  await removeTempDir(root)
})

afterEach(() => {
  restoreEnv()
})

function restoreEnv(): void {
  for (const [key, value] of [
    ['FORJA_RG', savedEnv.rg],
    ['FORJA_RESOURCES', savedEnv.res],
    ['PATH', savedEnv.path]
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetResourcesCache()
}

type Engine = 'rg' | 'node'

function useEngine(engine: Engine): void {
  if (engine === 'rg') {
    expect(BUNDLED_RG).not.toBeNull()
    process.env.FORJA_RG = BUNDLED_RG!
  } else {
    process.env.FORJA_RG = 'off'
  }
}

function makeCtx(signal: AbortSignal = new AbortController().signal): { ctx: ToolContext; warnings: string[] } {
  const warnings: string[] = []
  const ctx = {
    cwd: root,
    workspace: new WorkspaceGuard([root]),
    signal,
    log: (level: string, message: string) => {
      if (level === 'warn') warnings.push(message)
    }
  } as unknown as ToolContext
  return { ctx, warnings }
}

interface GrepRun {
  ok: boolean
  lines: string[]
  engine: unknown
  text: string
  summary?: string
  data?: Record<string, unknown>
  warnings: string[]
}

async function grep(engine: Engine, args: Record<string, unknown>): Promise<GrepRun> {
  useEngine(engine)
  const { ctx, warnings } = makeCtx()
  const result = await grepTool.execute(args, ctx)
  const lines = result.ok && result.data?.matches ? result.text.split('\n') : []
  return { ok: result.ok, lines, engine: result.data?.engine, text: result.text, summary: result.summary, data: result.data, warnings }
}

async function glob(engine: Engine, args: Record<string, unknown>): Promise<{ lines: string[]; engine: unknown; text: string }> {
  useEngine(engine)
  const { ctx } = makeCtx()
  const result = await globTool.execute(args, ctx)
  return { lines: result.files ? result.text.split('\n') : [], engine: result.data?.engine, text: result.text }
}

const sorted = (lines: string[]): string[] => [...lines].sort()
const files = (lines: string[]): string[] => [...new Set(lines.map((line) => line.split(':')[0]))].sort()

describe('bundled ripgrep', () => {
  it('is bundled, runs, and matches MANIFEST.json', () => {
    expect(BUNDLED_RG, 'run `npm run embed:bin` to bundle resources/bin/rg.exe').not.toBeNull()
    const run = spawnSync(BUNDLED_RG!, ['--version'], { encoding: 'utf8', windowsHide: true })
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/^ripgrep 14\.\d+\.\d+/)

    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(BUNDLED_RG!)), 'MANIFEST.json'), 'utf8')) as {
      entries: Array<{ name: string; sha256: string; size: number; license: string }>
    }
    const entry = manifest.entries.find((e) => e.name === 'ripgrep')
    expect(entry).toBeDefined()
    expect(createHash('sha256').update(fs.readFileSync(BUNDLED_RG!)).digest('hex')).toBe(entry!.sha256)
    expect(fs.statSync(BUNDLED_RG!).size).toBe(entry!.size)
    expect(entry!.license).toContain('MIT')
  })

  it('never resolves ripgrep from PATH: with no bundled copy the tools use the Node fallback', async () => {
    const fakeBin = path.join(root, '..', `forja-fakepath-${process.pid}`)
    const emptyResources = path.join(root, '..', `forja-emptyres-${process.pid}`)
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(emptyResources, { recursive: true })
    fs.writeFileSync(path.join(emptyResources, 'MANIFEST.json'), '{"version":1,"entries":[]}')
    try {
      // A perfectly good rg sits on PATH; it must be ignored.
      fs.copyFileSync(BUNDLED_RG!, path.join(fakeBin, process.platform === 'win32' ? 'rg.exe' : 'rg'))
      process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`
      process.env.FORJA_RESOURCES = emptyResources
      delete process.env.FORJA_RG
      resetResourcesCache()
      expect(ripgrepPath()).toBeNull()
      const { ctx } = makeCtx()
      const result = await grepTool.execute({ pattern: 'TODO fix' }, ctx)
      expect(result.data?.engine).toBe('node')
      expect(result.text).toContain('src/a.ts:1')
    } finally {
      restoreEnv()
      fs.rmSync(fakeBin, { recursive: true, force: true })
      fs.rmSync(emptyResources, { recursive: true, force: true })
    }
  })

  it('FORJA_RG overrides the bundled path; a missing path or "off" disables ripgrep', () => {
    process.env.FORJA_RG = BUNDLED_RG!
    expect(ripgrepPath()).toBe(BUNDLED_RG)
    process.env.FORJA_RG = path.join(root, 'does-not-exist', 'rg.exe')
    expect(ripgrepPath()).toBeNull()
    process.env.FORJA_RG = 'off'
    expect(ripgrepPath()).toBeNull()
    delete process.env.FORJA_RG
    expect(ripgrepPath()).toBe(BUNDLED_RG)
  })
})

describe('grep: ripgrep and the Node fallback agree', () => {
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'plain pattern (honours .gitignore, hidden files, binary and size limits)', args: { pattern: 'TODO' } },
    { name: 'ignore_case', args: { pattern: 'todo', ignore_case: true } },
    { name: 'case-sensitive miss', args: { pattern: 'todo' } },
    { name: 'include **/*.ts', args: { pattern: 'TODO', include: '**/*.ts' } },
    { name: 'include *.ts matches the basename at any depth', args: { pattern: 'TODO', include: '*.ts' } },
    { name: 'include with braces', args: { pattern: 'TODO', include: 'src/**/*.{ts,tsx}' } },
    { name: 'include is case-insensitive', args: { pattern: 'TODO', include: '**/*.ts', path: 'upper' } },
    { name: 'end-of-line anchor on a CRLF file', args: { pattern: 'second$' } },
    { name: 'sub-directory root', args: { pattern: 'TODO', path: 'src' } },
    { name: 'single file as root', args: { pattern: 'TODO', path: 'src/a.ts' } },
    { name: 'regex alternation', args: { pattern: 'fix|tsx' } },
    { name: 'look-ahead (PCRE2 in ripgrep, native in JS)', args: { pattern: 'TODO(?= tsx)' } }
  ]

  it.each(cases)('$name', async ({ args }) => {
    const rg = await grep('rg', args)
    const node = await grep('node', args)
    expect(rg.ok).toBe(true)
    expect(node.ok).toBe(true)
    expect(rg.engine).toBe('rg')
    expect(node.engine).toBe('node')
    expect(rg.warnings).toEqual([])
    expect(sorted(rg.lines)).toEqual(sorted(node.lines))
    if (rg.lines.length) expect(rg.summary).toBe(node.summary)
    else expect(rg.summary).toBe('0 resultados')
  })

  it('applies .gitignore (root, nested, negation, anchored) and skips binary and oversized files', async () => {
    for (const engine of ['rg', 'node'] as const) {
      const run = await grep(engine, { pattern: 'TODO' })
      expect(files(run.lines), engine).toEqual([
        '.github/ci.yml', // hidden files are searched
        'README.md',
        'keep.log', // re-included by "!keep.log"
        'nested/other.txt',
        'nested/rootonly.txt', // "/rootonly.txt" is anchored to the root
        'src/a.ts',
        'src/sub/b.ts',
        'src/sub/c.tsx',
        'upper/Case.TS'
      ])
      // never: ignored/, *.log, rootonly.txt, nested/local.txt (nested .gitignore), node_modules, build, bin.dat, big.txt
    }
  })

  it('keeps the public line format: path:line: trimmed text', async () => {
    const run = await grep('rg', { pattern: 'TODO fix' })
    expect(run.lines).toEqual(['src/a.ts:1: const x = 1 // TODO fix'])
    expect(run.summary).toMatch(/^1 ocorrência\(s\) em \d+ arquivos$/)
    expect(run.data).toMatchObject({ matches: 1, engine: 'rg' })
  })

  it('reports zero matches the same way', async () => {
    const rg = await grep('rg', { pattern: 'definitely-not-present-xyz' })
    const node = await grep('node', { pattern: 'definitely-not-present-xyz' })
    expect(rg.text).toMatch(/^nenhuma ocorrência de \/definitely-not-present-xyz\/ em \d+ arquivos$/)
    expect(rg.summary).toBe('0 resultados')
    expect(node.summary).toBe('0 resultados')
  })

  it('caps results at max_results and stops ripgrep early', async () => {
    for (const engine of ['rg', 'node'] as const) {
      const run = await grep(engine, { pattern: 'TODO', max_results: 3 })
      expect(run.lines, engine).toHaveLength(3)
      expect(run.summary).toMatch(/^3 ocorrência\(s\)/)
      expect(run.data?.engine).toBe(engine)
    }
    // The default cap is 200 and the hard schema cap is 400.
    await expect(grepTool.execute({ pattern: 'x', max_results: 401 }, makeCtx().ctx)).rejects.toThrow()
  })

  it('rejects a pattern JavaScript cannot parse, for both engines', async () => {
    for (const engine of ['rg', 'node'] as const) {
      const run = await grep(engine, { pattern: '(' })
      expect(run.ok, engine).toBe(false)
      expect(run.text).toContain('expressão regular inválida')
    }
  })

  it('falls back to Node when ripgrep rejects a pattern that JavaScript accepts', async () => {
    // "[^]" is valid JavaScript ("any character") but a syntax error for Rust regex and PCRE2.
    const run = await grep('rg', { pattern: 'TODO[^]fix' })
    expect(run.ok).toBe(true)
    expect(run.engine).toBe('node')
    expect(run.lines).toEqual(['src/a.ts:1: const x = 1 // TODO fix'])
    expect(run.warnings.join('\n')).toMatch(/ripgrep falhou/)
  })

  it('falls back to Node when the ripgrep binary cannot be started', async () => {
    const broken = path.join(root, process.platform === 'win32' ? 'broken-rg.exe' : 'broken-rg')
    fs.writeFileSync(broken, 'this is not an executable')
    fs.chmodSync(broken, 0o755)
    process.env.FORJA_RG = broken
    const { ctx, warnings } = makeCtx()
    const result = await grepTool.execute({ pattern: 'TODO fix' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.data?.engine).toBe('node')
    expect(result.text).toContain('src/a.ts:1')
    expect(warnings.length).toBeGreaterThan(0)
    fs.rmSync(broken)
  })

  it('does not follow directory links out of the workspace (junction/symlink)', async () => {
    const outside = await makeTempDir('forja-outside-')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TODO outside-secret\n')
    const link = path.join(root, 'linked-outside')
    try {
      fs.symlinkSync(outside, link, 'junction')
      for (const engine of ['rg', 'node'] as const) {
        const run = await grep(engine, { pattern: 'outside-secret' })
        expect(run.lines, engine).toEqual([])
        const globbed = await glob(engine, { pattern: '**/secret.txt' })
        expect(globbed.lines, engine).toEqual([])
      }
    } finally {
      fs.rmSync(link, { force: true, recursive: false })
      await removeTempDir(outside)
    }
  })

  it('an already aborted signal returns promptly without results or errors', async () => {
    const controller = new AbortController()
    controller.abort()
    useEngine('rg')
    const result = await grepTool.execute({ pattern: 'TODO' }, makeCtx(controller.signal).ctx)
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('0 resultados')
  })
})

describe('glob: ripgrep and the Node fallback agree', () => {
  const patterns = ['**/*.ts', '*.ts', 'src/**/*.{ts,tsx}', '*.md', '**/*.TS', '*.log', 'src/*.ts', '**/rootonly.txt', '.github/**', '**/*.js', 'nested/*.txt']

  it.each(patterns)('%s', async (pattern) => {
    const rg = await glob('rg', { pattern })
    const node = await glob('node', { pattern })
    expect(rg.engine).toBe('rg')
    expect(node.engine).toBe('node')
    // Same files, same order (newest first, ties broken by path).
    expect(rg.lines).toEqual(node.lines)
  })

  it('returns files newest first and honours .gitignore, hidden files and the heavy-directory list', async () => {
    const run = await glob('rg', { pattern: '**/*' })
    expect(run.lines[0]).toBe('upper/Case.TS') // latest mtime in buildTree()
    expect(run.lines).toContain('.github/ci.yml')
    expect(run.lines).toContain('keep.log')
    expect(run.lines).not.toContain('debug.log')
    expect(run.lines.some((l) => l.startsWith('ignored/') || l.startsWith('node_modules/') || l.startsWith('build/'))).toBe(false)
    expect(run.lines).not.toContain('nested/local.txt')
    expect(run.lines).not.toContain('rootonly.txt')
  })

  it('applies limit and reports an empty result like before', async () => {
    const limited = await glob('rg', { pattern: '**/*', limit: 2 })
    expect(limited.lines).toHaveLength(2)
    const none = await glob('rg', { pattern: '**/*.nope' })
    expect(none.text).toBe('nenhum arquivo corresponde a **/*.nope')
  })

  it('falls back to Node when ripgrep is unavailable', async () => {
    process.env.FORJA_RG = path.join(root, 'nope', 'rg.exe')
    const { ctx } = makeCtx()
    const result = await globTool.execute({ pattern: '*.md' }, ctx)
    expect(result.data?.engine).toBe('node')
    expect(result.text).toBe('README.md')
  })
})

describe('runLines: abort, timeout and result caps kill the whole process tree', () => {
  /** True while a process with this pid exists. */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const waitDead = async (pid: number, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (!alive(pid)) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return !alive(pid)
  }
  const PARENT = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    console.log('GRANDCHILD ' + child.pid)
    setInterval(() => {}, 1000)
  `

  it('AbortSignal while running: stops, reports "abort" and leaves no child behind', async () => {
    const controller = new AbortController()
    let parentPid = 0
    let grandchild = 0
    const started = Date.now()
    const run = await runLines(process.execPath, ['-e', PARENT], {
      cwd: root,
      signal: controller.signal,
      onSpawn: (pid) => (parentPid = pid),
      onLine: (line) => {
        grandchild = Number(line.replace('GRANDCHILD ', ''))
        controller.abort()
      }
    })
    expect(run.stopped).toBe('abort')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(parentPid).toBeGreaterThan(0)
    expect(grandchild).toBeGreaterThan(0)
    expect(await waitDead(parentPid)).toBe(true)
    expect(await waitDead(grandchild)).toBe(true)
  })

  it('timeout: stops a process that never ends', async () => {
    let pid = 0
    const run = await runLines(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root,
      timeoutMs: 300,
      onSpawn: (p) => (pid = p),
      onLine: () => undefined
    })
    expect(run.stopped).toBe('timeout')
    expect(await waitDead(pid)).toBe(true)
  })

  it('onLine returning true stops the process (result cap)', async () => {
    let pid = 0
    const seen: string[] = []
    const run = await runLines(
      process.execPath,
      ['-e', "for (let i = 0; i < 1e6; i++) console.log('row ' + i); setInterval(() => {}, 1000)"],
      {
        cwd: root,
        onSpawn: (p) => (pid = p),
        onLine: (line) => {
          seen.push(line)
          return seen.length >= 5
        }
      }
    )
    expect(run.stopped).toBe('limit')
    expect(seen).toHaveLength(5)
    expect(await waitDead(pid)).toBe(true)
  })

  it('reports a program that cannot start without throwing', async () => {
    const run = await runLines(path.join(root, 'no-such-program.exe'), [], { cwd: root, onLine: () => undefined })
    expect(run.spawnError).toBeTruthy()
    expect(run.stopped).toBeNull()
  })

  it('splits chunks into lines, strips CR, and flushes a final line without newline', async () => {
    const lines: string[] = []
    const run = await runLines(
      process.execPath,
      ['-e', "process.stdout.write('a\\r\\nb\\n\\nlast-without-newline')"],
      { cwd: root, onLine: (line) => void lines.push(line) }
    )
    expect(run.code).toBe(0)
    expect(lines).toEqual(['a', 'b', 'last-without-newline'])
  })
})

describe('GitignoreFilter (Node fallback)', () => {
  it('parses negation, anchoring, directory-only rules, comments and **', () => {
    const rules = parseGitignore('# c\n\n*.log\n!keep.log\n/top.txt\nbuild/\ndocs/**/*.tmp\n')
    expect(rules.map((r) => [r.negate, r.dirOnly])).toEqual([
      [false, false],
      [true, false],
      [false, false],
      [false, true],
      [false, false]
    ])
    expect(rules[0].regex.test('a/b/x.log')).toBe(true) // no slash: any depth
    expect(rules[2].regex.test('top.txt')).toBe(true)
    expect(rules[2].regex.test('sub/top.txt')).toBe(false) // anchored
    expect(rules[4].regex.test('docs/a/b/c.tmp')).toBe(true)
    expect(rules[4].regex.test('docs/c.tmp')).toBe(true)
    expect(rules[4].regex.test('other/c.tmp')).toBe(false)
  })

  it('decides per file, including parent directories and nested files', () => {
    const filter = new GitignoreFilter(root)
    const abs = (rel: string): string => path.join(root, rel)
    expect(filter.isIgnored(abs('ignored/z.txt'))).toBe(true)
    expect(filter.isIgnored(abs('debug.log'))).toBe(true)
    expect(filter.isIgnored(abs('keep.log'))).toBe(false)
    expect(filter.isIgnored(abs('rootonly.txt'))).toBe(true)
    expect(filter.isIgnored(abs('nested/rootonly.txt'))).toBe(false)
    expect(filter.isIgnored(abs('nested/local.txt'))).toBe(true)
    expect(filter.isIgnored(abs('nested/other.txt'))).toBe(false)
    expect(filter.isIgnored(abs('src/a.ts'))).toBe(false)
  })

  it('does not filter an explicitly requested root that a parent rule would ignore', async () => {
    const run = await grep('node', { pattern: 'TODO ignored', path: 'ignored' })
    expect(run.lines).toEqual(['ignored/z.txt:1: TODO ignored'])
    const rg = await grep('rg', { pattern: 'TODO ignored', path: 'ignored' })
    expect(rg.lines).toEqual(run.lines)
  })
})
