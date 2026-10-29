import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PatchError, applyChunks, parsePatch, patchDeletes, patchPaths, seekSequence } from '../src/core/patch/apply-patch'
import { applyPatchTool } from '../src/core/tools/apply-patch'
import { readFileTool } from '../src/core/tools/fs'
import { WorkspaceGuard } from '../src/core/security/policy'
import { FileTracker } from '../src/core/session/tracker'
import { evaluateTool } from '../src/core/security/permissions'
import type { ToolContext } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let dir: string
let ctx: ToolContext

function context(root: string): ToolContext {
  return {
    sessionId: 'ses_patch',
    cwd: root,
    mode: 'code',
    policy: policy({ mode: 'auto' }),
    workspace: new WorkspaceGuard([root]),
    signal: new AbortController().signal,
    tracker: new FileTracker(root),
    emit: () => undefined,
    approve: async () => true,
    log: () => undefined
  } as unknown as ToolContext
}

const file = (name: string): string => path.join(dir, name)
const write = (name: string, text: string): void => {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true })
  fs.writeFileSync(file(name), text)
}
const read = async (name: string): Promise<void> => {
  const result = await readFileTool.execute({ path: name }, ctx)
  expect(result.ok).toBe(true)
}
const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

beforeEach(async () => {
  dir = await makeTempDir('openclod-apply-patch-')
  ctx = context(dir)
})
afterEach(async () => {
  await removeTempDir(dir)
})

describe('parsePatch', () => {
  it('reads add, update with move and context, and delete', () => {
    const ops = parsePatch(
      patch(
        '*** Add File: novo.ts',
        '+export const a = 1',
        '+',
        '*** Update File: src/app.ts',
        '*** Move to: src/main.ts',
        '@@ function start() {',
        '   const x = 1',
        '-  const y = 2',
        '+  const y = 3',
        '*** End of File',
        '*** Delete File: velho.ts'
      )
    )
    expect(ops).toEqual([
      { kind: 'add', path: 'novo.ts', content: 'export const a = 1\n\n' },
      {
        kind: 'update',
        path: 'src/app.ts',
        moveTo: 'src/main.ts',
        chunks: [{ context: 'function start() {', oldLines: ['  const x = 1', '  const y = 2'], newLines: ['  const x = 1', '  const y = 3'], endOfFile: true }]
      },
      { kind: 'delete', path: 'velho.ts' }
    ])
  })

  it('accepts what models usually get slightly wrong: text around it, no End Patch, no @@ on the first chunk', () => {
    const ops = parsePatch("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.txt\n um\n-dois\n+2\n")
    expect(ops).toEqual([{ kind: 'update', path: 'a.txt', chunks: [{ oldLines: ['um', 'dois'], newLines: ['um', '2'], endOfFile: false }] }])
  })

  it('explains what is wrong, in Portuguese', () => {
    expect(() => parsePatch('*** Update File: a.txt')).toThrow(/Begin Patch/)
    expect(() => parsePatch(patch('*** Add File: a.txt', 'sem mais'))).toThrow(PatchError)
    expect(() => parsePatch(patch('*** Update File: a.txt', 'x linha'))).toThrow(/cada linha começa/)
    expect(() => parsePatch(patch('*** Update File: a.txt'))).toThrow(/nenhuma alteração/)
    expect(() => parsePatch(patch('qualquer coisa'))).toThrow(/linha inesperada/)
    expect(() => parsePatch(patch())).toThrow(/nenhuma operação/)
  })

  it('lists every path for the permission checks, and says when a file is removed', () => {
    const text = patch('*** Update File: a.ts', '*** Move to: b.ts', '-x', '+y', '*** Delete File: .env')
    expect(patchPaths(text)).toEqual(['a.ts', 'b.ts', '.env'])
    expect(patchDeletes(text)).toBe(true)
    expect(patchDeletes(patch('*** Add File: c.ts', '+1'))).toBe(false)
    expect(patchPaths('lixo')).toEqual([])
  })
})

describe('applyChunks', () => {
  it('finds each chunk after the previous one and after its @@ line', () => {
    const before = 'function a() {\n  return 1\n}\nfunction b() {\n  return 1\n}\n'
    const after = applyChunks(before, parsePatch(patch('*** Update File: f.js', '@@ function b() {', '-  return 1', '+  return 2')).flatMap((op) => (op.kind === 'update' ? op.chunks : [])), 'f.js')
    expect(after).toBe('function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n')
  })

  it('keeps CRLF and the missing final newline of the file', () => {
    const chunks = [{ oldLines: ['b'], newLines: ['B'], endOfFile: false }]
    expect(applyChunks('a\r\nb\r\nc\r\n', chunks, 'f')).toBe('a\r\nB\r\nc\r\n')
    expect(applyChunks('a\nb\nc', chunks, 'f')).toBe('a\nB\nc')
  })

  it('matches lines that differ only in trailing spaces or look-alike punctuation', () => {
    expect(seekSequence(['a  ', 'b'], ['a', 'b'], 0)).toBe(0)
    expect(seekSequence(['  x = “1” — 2'], ['x = "1" - 2'], 0)).toBe(0)
    expect(seekSequence(['a', 'b', 'a', 'b'], ['a', 'b'], 0, true)).toBe(2)
    expect(seekSequence(['a'], ['z'], 0)).toBe(-1)
  })

  it('adds lines at the end when a chunk has no old lines, and refuses a chunk that is not in the file', () => {
    expect(applyChunks('a\n', [{ oldLines: [], newLines: ['b'], endOfFile: false }], 'f')).toBe('a\nb\n')
    expect(applyChunks('', [{ oldLines: [], newLines: ['primeira'], endOfFile: false }], 'f')).toBe('primeira\n')
    expect(() => applyChunks('a\n', [{ oldLines: ['z'], newLines: ['y'], endOfFile: false }], 'f.ts')).toThrow(/f\.ts: o trecho 1 não confere/)
  })
})

describe('apply_patch tool', () => {
  it('creates, changes, moves and removes files in one call, and records each change', async () => {
    write('src/app.ts', 'const a = 1\nconst b = 2\n')
    write('old.txt', 'tchau\n')
    write('mover.txt', 'um\ndois\n')
    await read('src/app.ts')
    await read('old.txt')
    await read('mover.txt')
    const result = await applyPatchTool.execute(
      {
        patch: patch(
          '*** Add File: src/novo.ts',
          '+export const novo = true',
          '*** Update File: src/app.ts',
          ' const a = 1',
          '-const b = 2',
          '+const b = 3',
          '*** Update File: mover.txt',
          '*** Move to: pasta/movido.txt',
          ' um',
          '-dois',
          '+2',
          '*** Delete File: old.txt'
        )
      },
      ctx
    )
    expect(result.ok, result.text).toBe(true)
    expect(result.text).toContain('patch aplicado em 4 arquivo(s)')
    expect(fs.readFileSync(file('src/novo.ts'), 'utf8')).toBe('export const novo = true\n')
    expect(fs.readFileSync(file('src/app.ts'), 'utf8')).toBe('const a = 1\nconst b = 3\n')
    expect(fs.readFileSync(file('pasta/movido.txt'), 'utf8')).toBe('um\n2\n')
    expect(fs.existsSync(file('mover.txt'))).toBe(false)
    expect(fs.existsSync(file('old.txt'))).toBe(false)
    const changes = ctx.tracker.changes().map((change) => change.path.replace(/\\/g, '/')).sort()
    expect(changes).toEqual(['mover.txt', 'old.txt', 'pasta/movido.txt', 'src/app.ts', 'src/novo.ts'])
    // What was just written counts as read: a second patch needs no new read.
    const again = await applyPatchTool.execute({ patch: patch('*** Update File: src/app.ts', '-const b = 3', '+const b = 4') }, ctx)
    expect(again.ok, again.text).toBe(true)
  })

  it('is all or nothing: one chunk that does not match changes no file', async () => {
    write('a.txt', 'um\n')
    write('b.txt', 'dois\n')
    await read('a.txt')
    await read('b.txt')
    const result = await applyPatchTool.execute(
      { patch: patch('*** Update File: a.txt', '-um', '+1', '*** Add File: c.txt', '+3', '*** Update File: b.txt', '-NÃO EXISTE', '+2') },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/nada foi alterado.*b\.txt: o trecho 1 não confere/s)
    expect(fs.readFileSync(file('a.txt'), 'utf8')).toBe('um\n')
    expect(fs.existsSync(file('c.txt'))).toBe(false)
    expect(ctx.tracker.changes()).toEqual([])
  })

  it('follows the read-first and changed-on-disk rules of edit_file', async () => {
    write('a.txt', 'um\n')
    const unread = await applyPatchTool.execute({ patch: patch('*** Update File: a.txt', '-um', '+1') }, ctx)
    expect(unread.text).toMatch(/leia a\.txt antes/)
    const unreadDelete = await applyPatchTool.execute({ patch: patch('*** Delete File: a.txt') }, ctx)
    expect(unreadDelete.text).toMatch(/leia a\.txt antes/)
    await read('a.txt')
    // Another program saves the file after the read.
    await new Promise((resolve) => setTimeout(resolve, 20))
    fs.writeFileSync(file('a.txt'), 'um\noutra linha\n')
    const stale = await applyPatchTool.execute({ patch: patch('*** Update File: a.txt', '-um', '+1') }, ctx)
    expect(stale.text).toMatch(/mudou no disco/)
    expect(fs.readFileSync(file('a.txt'), 'utf8')).toBe('um\noutra linha\n')
  })

  it('never overwrites by Add File or Move to, and refuses a file twice or outside the project', async () => {
    write('a.txt', 'um\n')
    write('b.txt', 'dois\n')
    await read('a.txt')
    expect((await applyPatchTool.execute({ patch: patch('*** Add File: a.txt', '+x') }, ctx)).text).toMatch(/já existe/)
    expect((await applyPatchTool.execute({ patch: patch('*** Update File: a.txt', '*** Move to: b.txt', '-um', '+1') }, ctx)).text).toMatch(/b\.txt já existe/)
    expect((await applyPatchTool.execute({ patch: patch('*** Update File: a.txt', '-um', '+1', '*** Delete File: a.txt') }, ctx)).text).toMatch(/duas vezes/)
    const outside = await applyPatchTool.execute({ patch: patch('*** Add File: ../fora.txt', '+x') }, ctx)
    expect(outside.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, '..', 'fora.txt'))).toBe(false)
  })

  it('dry_run shows what would change and writes nothing', async () => {
    write('a.txt', 'um\n')
    await read('a.txt')
    const result = await applyPatchTool.execute({ patch: patch('*** Update File: a.txt', '-um', '+1', '*** Add File: b.txt', '+2'), dry_run: true }, ctx)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('alterar a.txt (+1 -1)')
    expect(result.text).toContain('criar b.txt (+1 -0)')
    expect(fs.readFileSync(file('a.txt'), 'utf8')).toBe('um\n')
    expect(fs.existsSync(file('b.txt'))).toBe(false)
  })

  it('asks like delete_path when it removes a file, and checks every path against the rules and credential files', () => {
    const withDelete = { patch: patch('*** Update File: a.ts', '-x', '+y', '*** Delete File: b.ts') }
    const auto = policy({ mode: 'auto' })
    expect(evaluateTool(applyPatchTool, 'a.ts\nb.ts', auto, dir, withDelete).decision).toBe('ask')
    expect(evaluateTool(applyPatchTool, 'a.ts', auto, dir, { patch: patch('*** Update File: a.ts', '-x', '+y') }).decision).toBe('allow')
    // The default rules ask before touching .env, even when it is the second file of the patch.
    const env = { patch: patch('*** Update File: a.ts', '-x', '+y', '*** Update File: .env', '-A=1', '+A=2') }
    const rules = policy({ mode: 'auto', rules: { allow: ['Edit(a.ts)'], ask: ['Edit(.env)'], deny: [] } })
    expect(evaluateTool(applyPatchTool, 'a.ts\n.env', rules, dir, env).decision).toBe('ask')
    // A credential store is blocked outright, whatever the mode.
    const ssh = { patch: patch('*** Add File: ~/.ssh/id_rsa', '+x') }
    const denied = evaluateTool(applyPatchTool, '~/.ssh/id_rsa', policy({ mode: 'auto' }), dir, ssh)
    expect(denied.decision).toBe('deny')
  })
})
