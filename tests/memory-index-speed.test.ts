import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectMemory } from '../src/core/memory/project'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-memory-index-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const page = (title: string, tags: string[], body: string): string =>
  ['---', `title: ${JSON.stringify(title)}`, `tags: [${tags.join(', ')}]`, 'pinned: false', 'created: 2026-10-29T10:00:00.000Z', 'updated: 2026-10-29T10:00:00.000Z', 'source: agent', 'memory_type: decision', '---', '', body, ''].join('\n')

describe('the memory index of a big wiki', () => {
  it('follows pages changed or removed outside Openclod, keeping per-file stamps in a compact index', async () => {
    const wiki = path.join(root, 'wiki')
    fs.mkdirSync(wiki, { recursive: true })
    fs.writeFileSync(path.join(wiki, 'a.md'), page('Página A', ['checkout'], 'primeira versão'))
    fs.writeFileSync(path.join(wiki, 'b.md'), page('Página B', ['checkout'], 'outra página'))
    const memory = new ProjectMemory(root)
    expect((await memory.listPages()).map((item) => item.slug)).toEqual(expect.arrayContaining(['a', 'b']))
    const stored = fs.readFileSync(path.join(root, 'index.json'), 'utf8')
    expect(stored).not.toContain('\n  ')
    expect(Object.keys(JSON.parse(stored).stamps)).toEqual(expect.arrayContaining(['a.md', 'b.md']))

    // Edited by hand (a different size) and one removed: the next read sees both.
    fs.writeFileSync(path.join(wiki, 'a.md'), page('Página A editada à mão', ['checkout'], 'segunda versão, bem mais longa'))
    fs.rmSync(path.join(wiki, 'b.md'))
    const after = await memory.listPages()
    expect(after.find((item) => item.slug === 'a')?.title).toBe('Página A editada à mão')
    expect(after.some((item) => item.slug === 'b')).toBe(false)
  })

  it('shares one rebuild between calls made at the same time, and builds the subject hubs', async () => {
    const memory = new ProjectMemory(root)
    for (const name of ['um', 'dois', 'tres']) {
      await memory.writePage({ title: `Decisão ${name}`, body: `sobre o checkout ${name}`, tags: ['checkout'], memoryType: 'decision' })
    }
    const fresh = new ProjectMemory(root)
    const [pages, stats] = await Promise.all([fresh.listPages(), fresh.stats()])
    expect(stats.pages).toBe(pages.length)
    expect(pages.some((item) => item.title === 'Índice: checkout')).toBe(true)
  })

  it('survives a file held for a moment by another program (EBUSY), and never fails a read over the index', async () => {
    const memory = new ProjectMemory(root)
    const realRename = fs.promises.rename
    let busy = 2
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return realRename(from, to)
    })
    await memory.writePage({ title: 'Guardada mesmo assim', body: 'o arquivo estava ocupado por um instante', tags: ['teste'] })
    expect(rename.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect((await memory.listPages()).some((item) => item.title === 'Guardada mesmo assim')).toBe(true)

    // The index can never be saved now: the pages are still listed, and no temporary file stays behind.
    rename.mockImplementation(async () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    fs.writeFileSync(path.join(root, 'wiki', 'nova.md'), page('Escrita por fora', ['teste'], 'texto'))
    const pages = await new ProjectMemory(root).listPages()
    expect(pages.some((item) => item.title === 'Escrita por fora')).toBe(true)
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  }, 30_000)

  it('migrates an imported session into turn notes writing the index once, not once per note', async () => {
    const wiki = path.join(root, 'wiki')
    fs.mkdirSync(wiki, { recursive: true })
    const sections = Array.from({ length: 60 }, (_, i) =>
      [`### 26/10/2026, 15:${String(i).padStart(2, '0')}`, '', `**Pedido:** pedido ${i}`, '', `**Resultado:** resultado ${i}`, ''].join('\n')
    )
    fs.writeFileSync(path.join(wiki, 'sessao-importada.md'), page('Sessão: Importada', ['sessao', 'automatico'], sections.join('\n')))

    const memory = new ProjectMemory(root)
    const indexFile = path.join(root, 'index.json')
    const realRename = fs.promises.rename
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation((from, to) => realRename(from, to))
    // A page the agent writes while the migration runs goes into the same index.
    await Promise.all([memory.init(), memory.writePage({ title: 'Escrita durante a manutenção', body: 'no meio do lote', tags: ['teste'] })])
    const indexWrites = rename.mock.calls.filter(([, to]) => path.resolve(String(to)) === indexFile).length
    expect(indexWrites).toBeLessThanOrEqual(2)

    const pages = await memory.listPages()
    expect(pages.filter((item) => item.kind === 'turn')).toHaveLength(60)
    expect(pages.some((item) => item.title === 'Escrita durante a manutenção')).toBe(true)

    // A turn note edited by hand after the batch is read again; a new instance sees the same index on disk.
    const turn = pages.find((item) => item.kind === 'turn')!
    const file = path.join(wiki, `${turn.slug}.md`)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^title: .*$/m, 'title: "Turno editado à mão"'))
    expect((await memory.listPages()).some((item) => item.title === 'Turno editado à mão')).toBe(true)
    const reopened = await new ProjectMemory(root).listPages()
    expect(reopened.filter((item) => item.kind === 'turn')).toHaveLength(60)
    expect(reopened.some((item) => item.title === 'Escrita durante a manutenção')).toBe(true)
  }, 30_000)
})
