import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectImages, fitLabel, framesOfDocument, labelOf, parseJsonLoose, readingOrder, renderSheets } from '../src/core/design/sheets'
import { designSheetTool } from '../src/core/tools/design'
import { WorkspaceGuard } from '../src/core/security/policy'
import type { ToolContext } from '../src/core/tools/types'
import type { ToolResult } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('openclod-folhas-')
})

afterEach(async () => {
  await removeTempDir(dir)
})

const screen = async (file: string, color: string, height = 844): Promise<string> => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await sharp({ create: { width: 390, height, channels: 3, background: color } }).png().toFile(file)
  return file
}

/** What FigCraft's inspect_document answers (trimmed), with the "tip:" line its server adds. */
const inspectAnswer = (frames: Array<{ id: number; name: string; x: number; y: number; height?: number }>, section = false): string => {
  const nodes = frames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    type: 'FRAME',
    width: 390,
    height: frame.height ?? 844,
    absoluteBounds: { x: frame.x, y: frame.y, width: 390, height: frame.height ?? 844 }
  }))
  const children = section ? [{ id: 900, name: 'Fluxo', type: 'SECTION', children: nodes }, { id: 901, name: 'nota', type: 'TEXT' }] : nodes
  return `${JSON.stringify({ currentPage: 1, pages: [{ id: 1, name: 'Telas', type: 'PAGE', children }, { id: 7, name: 'Outra', type: 'PAGE' }] }, null, 2)}tip: call guide {} once`
}

function context(root: string, mcp?: ToolContext['services']['mcp'], vision = false): ToolContext {
  return {
    sessionId: 'ses_folhas',
    cwd: root,
    mode: 'code',
    vision,
    workspace: new WorkspaceGuard([root]),
    signal: new AbortController().signal,
    progress: () => undefined,
    emit: () => undefined,
    approve: async () => true,
    log: () => undefined,
    services: { mcp }
  } as unknown as ToolContext
}

/** A FigCraft that answers inspect_document and writes each exported frame as a real PNG. */
function fakeFigcraft(frames: Array<{ id: number; name: string; x: number; y: number }>, failId?: number) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const service = {
    call: async (server: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
      calls.push({ tool: `${server}/${tool}`, args })
      if (tool === 'inspect_document') return { ok: true, text: inspectAnswer(frames, true) }
      if (tool === 'export') {
        const id = (args.ids as number[])[0]
        if (id === failId) return { ok: false, text: 'node not found' }
        await screen(String(args.path), id % 2 ? '#e8f0ff' : '#fff4e0')
        return { ok: true, text: JSON.stringify({ path: args.path, format: 'png' }) }
      }
      return { ok: false, text: 'unknown tool' }
    }
  }
  return { service: service as unknown as ToolContext['services']['mcp'], calls }
}

describe('contact sheets of screens', () => {
  it('lays the screens out in a grid, the label of each on top, several sheets when there are many', async () => {
    const items = []
    for (let index = 0; index < 12; index++) items.push({ file: await screen(path.join(dir, `s${index}.png`), index % 2 ? '#ffffff' : '#e8f0ff'), label: `APP-HOM-${String(index + 1).padStart(2, '0')}` })
    const sheets = await renderSheets(items, path.join(dir, 'folhas'), { title: 'App · Início' })
    expect(sheets.map((sheet) => sheet.labels.length)).toEqual([10, 2])
    expect(sheets[0].labels[0]).toBe('APP-HOM-01')
    // 5 columns of 300 px with 18 px gaps and 24 px padding; two rows of 22 px label + the screen at 300 px wide, plus the title.
    const screenHeight = Math.round((844 * 300) / 390)
    expect(sheets[0].width).toBe(24 * 2 + 5 * 300 + 4 * 18)
    expect(sheets[0].height).toBe(24 + 40 + 2 * (22 + screenHeight) + 18 + 24)
    expect(path.basename(sheets[1].file)).toBe('folha-02.png')
    expect(sheets[1].width).toBe(24 * 2 + 2 * 300 + 18)
    const meta = await sharp(sheets[0].file).metadata()
    expect([meta.width, meta.height, meta.format]).toEqual([sheets[0].width, sheets[0].height, 'png'])
  })

  it('cuts a screen far taller than a phone, and a label that does not fit', async () => {
    const tall = await screen(path.join(dir, 'rolagem.png'), '#ffffff', 5_000)
    const [sheet] = await renderSheets([{ file: tall, label: 'x' }], path.join(dir, 'f'), { cellWidth: 200 })
    expect(sheet.height).toBe(24 + 22 + Math.round(200 * 2.6) + 24)
    expect(fitLabel('MOT-MEN-01-tela-com-um-nome-enorme-demais', 120)).toMatch(/…$/)
    expect(fitLabel('MOT-MEN-01', 300)).toBe('MOT-MEN-01')
  })

  it('collects images in name order (10 after 9), with subfolders only when asked', async () => {
    for (const name of ['tela-10.png', 'tela-9.png', 'tela-1.jpg', 'nota.txt']) fs.writeFileSync(path.join(dir, name), 'x')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'tela-20.webp'), 'x')
    expect(collectImages([dir]).map((file) => path.basename(file))).toEqual(['tela-1.jpg', 'tela-9.png', 'tela-10.png'])
    expect(collectImages([dir], true).map((file) => path.basename(file))).toEqual(['tela-1.jpg', 'tela-9.png', 'tela-10.png', 'tela-20.webp'])
    expect(labelOf('C:\\x\\003__MOT-MEN-01b.png')).toBe('MOT-MEN-01b')
  })

  it('reads the frames of the current page from FigCraft, inside sections, in reading order', () => {
    const doc = parseJsonLoose(
      inspectAnswer(
        [
          { id: 4, name: 'B', x: 440, y: 10 },
          { id: 2, name: 'A', x: 0, y: 0 },
          { id: 9, name: 'D', x: 440, y: 950 },
          { id: 5, name: 'C', x: 0, y: 900 }
        ],
        true
      )
    )
    expect(framesOfDocument(doc).map((frame) => frame.name)).toEqual(['A', 'B', 'C', 'D'])
    expect(parseJsonLoose('nada aqui')).toBeNull()
    expect(parseJsonLoose('{"a": "fecha } dentro do texto", "b": {"c": 1}}\ntip: call guide {} once')).toEqual({ a: 'fecha } dentro do texto', b: { c: 1 } })
    expect(readingOrder([])).toEqual([])
  })
})

describe('design_sheet', () => {
  it('exports every frame of the FigCraft page itself and shows the sheets in the chat', async () => {
    const frames = [
      { id: 3, name: 'APP-HOM-02', x: 440, y: 0 },
      { id: 2, name: 'APP-HOM-01', x: 0, y: 0 },
      { id: 5, name: 'APP-MEN-01', x: 0, y: 900 }
    ]
    const figcraft = fakeFigcraft(frames)
    const result = await designSheetTool.execute({ figcraft: {}, title: 'App' }, context(dir, figcraft.service))
    expect(result.ok).toBe(true)
    expect(figcraft.calls.map((call) => call.tool)).toEqual(['figcraft/inspect_document', 'figcraft/export', 'figcraft/export', 'figcraft/export'])
    expect(figcraft.calls.slice(1).map((call) => (call.args.ids as number[])[0])).toEqual([2, 3, 5])
    expect(result.text).toContain('1 folha(s) com 3 tela(s)')
    expect(result.text).toContain('APP-HOM-01, APP-HOM-02, APP-MEN-01')
    expect(result.files?.[0]).toMatch(/[\\/]\.openclod[\\/]folhas[\\/].+[\\/]folha-01\.png$/)
    expect(fs.existsSync(result.files![0])).toBe(true)
    // A model that cannot see gets the text; the chat shows the sheet.
    expect(result.preview).toHaveLength(1)
    expect(result.images).toBeUndefined()
  })

  it('sends the sheets to a model that sees, keeps going when a frame does not export, and asks for a source', async () => {
    const figcraft = fakeFigcraft([{ id: 2, name: 'A', x: 0, y: 0 }, { id: 3, name: 'B', x: 440, y: 0 }], 3)
    const result = await designSheetTool.execute({ figcraft: { ids: [2, 3] }, out_dir: 'saida' }, context(dir, figcraft.service, true))
    expect(result.ok).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(result.text).toContain('B: não exportou')
    expect(fs.existsSync(path.join(dir, 'saida', 'folha-01.png'))).toBe(true)
    expect((await designSheetTool.execute({}, context(dir))).ok).toBe(false)
    expect((await designSheetTool.execute({ figcraft: {} }, context(dir))).text).toContain('MCP indisponível')
  })

  it('builds sheets from image files and folders, with the labels given', async () => {
    await screen(path.join(dir, 'telas', '01.png'), '#ffffff')
    await screen(path.join(dir, 'telas', '02.png'), '#e8f0ff')
    const result = await designSheetTool.execute({ paths: ['telas'], labels: ['LOG-01', 'LOG-02'], columns: 2 }, context(dir))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('LOG-01, LOG-02')
    expect(((result.data as { sheets: Array<{ width: number }> }).sheets[0]).width).toBe(24 * 2 + 2 * 300 + 18)
  })
})
