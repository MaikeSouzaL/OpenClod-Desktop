import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editFileTool, patchFileTool, readFileTool, writeFileTool } from '../src/core/tools/fs'
import { withFileLock } from '../src/core/util/file-lock'
import { WorkspaceGuard } from '../src/core/security/policy'
import { FileTracker } from '../src/core/session/tracker'
import type { ToolContext, ToolDef } from '../src/core/tools/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let dir: string
let ctx: ToolContext

function context(root: string): ToolContext {
  return {
    sessionId: 'ses_fs',
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

const run = (tool: ToolDef, args: Record<string, unknown>) => tool.execute(args, ctx)

beforeEach(async () => {
  dir = await makeTempDir('forja-fs-safety-')
  ctx = context(dir)
})
afterEach(async () => {
  await removeTempDir(dir)
})

describe('withFileLock', () => {
  it('runs work on the same file one at a time, in call order, and survives a failing job', async () => {
    const order: string[] = []
    const job = (name: string, ms: number, fail = false) =>
      withFileLock(path.join(dir, 'a.txt'), async () => {
        order.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(`${name}:end`)
        if (fail) throw new Error('boom')
      })
    const results = await Promise.allSettled([job('A', 30), job('B', 5, true), job('C', 1)])
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end'])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })

  it('does not serialize different files', async () => {
    let active = 0
    let peak = 0
    const job = (file: string) =>
      withFileLock(path.join(dir, file), async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active--
      })
    await Promise.all([job('x.txt'), job('y.txt'), job('z.txt')])
    expect(peak).toBe(3)
  })
})

describe('concurrent edits', () => {
  it('keeps every one of 40 simultaneous edits to the same file', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `item-${String(index).padStart(2, '0')}`)
    fs.writeFileSync(path.join(dir, 'f.txt'), lines.join('\n'))
    await run(readFileTool, { path: 'f.txt' })
    const results = await Promise.all(lines.map((line, index) => run(editFileTool, { path: 'f.txt', old_string: line, new_string: `ITEM-${String(index).padStart(2, '0')}` })))
    expect(results.every((result) => result.ok)).toBe(true)
    const final = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8').split('\n')
    expect(final).toEqual(lines.map((_, index) => `ITEM-${String(index).padStart(2, '0')}`))
  })
})

describe('changed since read', () => {
  it('refuses to overwrite or edit a file that changed after it was read', async () => {
    const file = path.join(dir, 'g.txt')
    fs.writeFileSync(file, 'original\n')
    await run(readFileTool, { path: 'g.txt' })
    fs.writeFileSync(file, 'edição do usuário, mais longa\n')
    const overwrite = await run(writeFileTool, { path: 'g.txt', content: 'do agente\n' })
    expect(overwrite.ok).toBe(false)
    expect(overwrite.text).toContain('mudou no disco')
    const edit = await run(editFileTool, { path: 'g.txt', old_string: 'edição', new_string: 'x' })
    expect(edit.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('edição do usuário, mais longa\n')
    await run(readFileTool, { path: 'g.txt' })
    expect((await run(editFileTool, { path: 'g.txt', old_string: 'edição', new_string: 'texto' })).ok).toBe(true)
  })

  it('a successful edit refreshes the stamp so the next edit works without a new read', async () => {
    fs.writeFileSync(path.join(dir, 'h.txt'), 'um dois três')
    await run(readFileTool, { path: 'h.txt' })
    expect((await run(editFileTool, { path: 'h.txt', old_string: 'um', new_string: '1' })).ok).toBe(true)
    expect((await run(editFileTool, { path: 'h.txt', old_string: 'dois', new_string: '2' })).ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'h.txt'), 'utf8')).toBe('1 2 três')
  })
})

describe('encoding and line endings', () => {
  it('refuses to edit a Windows-1252 file as UTF-8 text instead of corrupting the accents', async () => {
    const file = path.join(dir, 'legacy.txt')
    const original = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x62, 0x63]) // "café abc" in Windows-1252
    fs.writeFileSync(file, original)
    await run(readFileTool, { path: 'legacy.txt' })
    const result = await run(editFileTool, { path: 'legacy.txt', old_string: 'abc', new_string: 'xyz' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('UTF-8')
    expect(fs.readFileSync(file).equals(original)).toBe(true)
  })

  it('patch_file keeps the CRLF line endings of the file', async () => {
    const file = path.join(dir, 'win.txt')
    fs.writeFileSync(file, 'a\r\nb\r\nc\r\n')
    await run(readFileTool, { path: 'win.txt' })
    const patch = '--- a/win.txt\n+++ b/win.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
    const result = await run(patchFileTool, { path: 'win.txt', patch })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('a\r\nB\r\nc\r\n')
  })
})
