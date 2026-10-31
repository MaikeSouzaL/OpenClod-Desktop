import fs from 'node:fs'
import path from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'

/**
 * Contact sheets of screens, the way a design review looks at them: a grid of screens, each with its code on top
 * (MOT-MEN-01, MOT-MEN-01b…), several sheets when there are many. The screens come from image files or from the frames
 * of a FigCraft document (src/core/tools/design.ts exports them first).
 */

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export interface SheetItem {
  file: string
  label: string
}

export interface SheetOptions {
  columns?: number
  perSheet?: number
  cellWidth?: number
  title?: string
  theme?: 'claro' | 'escuro'
}

export interface RenderedSheet {
  file: string
  width: number
  height: number
  labels: string[]
}

const PADDING = 24
const GAP = 18
const LABEL_HEIGHT = 22
const TITLE_HEIGHT = 40
/** A very tall screen (a long scroll) is cut at this many cell widths, so one screen never makes a sheet of 10 000 px. */
const MAX_ASPECT = 2.6

const THEMES = {
  claro: { background: '#f4f4f5', label: '#3f3f46', title: '#18181b', border: '#d4d4d8' },
  escuro: { background: '#18181b', label: '#d4d4d8', title: '#fafafa', border: '#3f3f46' }
}

/** "tela-10" after "tela-9": numbers inside names count as numbers. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })
}

/** Image files of the given files and folders (a folder's own images, or its subfolders too), in name order. */
export function collectImages(paths: string[], recursive = false, limit = 400): string[] {
  const out: string[] = []
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files = entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort(naturalCompare)
    for (const name of files) if (out.length < limit) out.push(path.join(dir, name))
    if (!recursive || depth >= 6) return
    for (const sub of entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort(naturalCompare)) {
      if (out.length >= limit) return
      visit(path.join(dir, sub), depth + 1)
    }
  }
  for (const given of paths) {
    if (out.length >= limit) break
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(given)
    } catch {
      stat = null
    }
    if (stat?.isDirectory()) visit(given, 0)
    else if (stat?.isFile() && IMAGE_EXTENSIONS.has(path.extname(given).toLowerCase())) out.push(given)
  }
  return out
}

/** The label of a screen image: its file name without the extension (and without an export's "01-" order prefix). */
export function labelOf(file: string): string {
  return path.basename(file, path.extname(file)).replace(/^\d{2,3}__/, '')
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] as string)
}

/** Cuts a label to what fits in the cell (about 7 px per character at 13 px). */
export function fitLabel(label: string, cellWidth: number): string {
  const max = Math.max(6, Math.floor(cellWidth / 7.2))
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/** Splits the screens into sheets of `perSheet`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

/** Writes one sheet per `perSheet` screens into `outDir` (folha-01.png, folha-02.png…). */
export async function renderSheets(items: SheetItem[], outDir: string, options: SheetOptions = {}): Promise<RenderedSheet[]> {
  const columns = Math.min(10, Math.max(1, options.columns ?? 5))
  const perSheet = Math.min(40, Math.max(1, options.perSheet ?? columns * 2))
  const cellWidth = Math.min(800, Math.max(120, options.cellWidth ?? 300))
  const theme = THEMES[options.theme ?? 'claro']
  fs.mkdirSync(outDir, { recursive: true })
  const groups = chunk(items, perSheet)
  const sheets: RenderedSheet[] = []
  for (const [sheetIndex, group] of groups.entries()) {
    // Each screen at the cell width, cut when it is far taller than a phone screen.
    const cells = await Promise.all(
      group.map(async (item) => {
        const resized = await sharp(item.file, { failOn: 'none' })
          .rotate()
          .resize({ width: cellWidth, withoutEnlargement: false })
          .flatten({ background: '#ffffff' })
          .png()
          .toBuffer({ resolveWithObject: true })
        const maxHeight = Math.round(cellWidth * MAX_ASPECT)
        const data =
          resized.info.height > maxHeight
            ? await sharp(resized.data).extract({ left: 0, top: 0, width: resized.info.width, height: maxHeight }).png().toBuffer()
            : resized.data
        return { item, data, height: Math.min(resized.info.height, maxHeight) }
      })
    )
    const rows = chunk(cells, columns)
    const rowHeights = rows.map((row) => LABEL_HEIGHT + Math.max(...row.map((cell) => cell.height)))
    const usedColumns = Math.min(columns, group.length)
    const titleText = options.title?.trim()
      ? `${options.title.trim()}${groups.length > 1 ? ` · folha ${sheetIndex + 1} de ${groups.length}` : ''}`
      : ''
    const top = PADDING + (titleText ? TITLE_HEIGHT : 0)
    const width = PADDING * 2 + usedColumns * cellWidth + (usedColumns - 1) * GAP
    const height = top + rowHeights.reduce((sum, value) => sum + value, 0) + (rows.length - 1) * GAP + PADDING
    const layers: OverlayOptions[] = []
    const texts: string[] = []
    if (titleText) {
      texts.push(`<text x="${PADDING}" y="${PADDING + 22}" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="700" fill="${theme.title}">${escapeXml(titleText)}</text>`)
    }
    let y = top
    for (const [rowIndex, row] of rows.entries()) {
      for (const [columnIndex, cell] of row.entries()) {
        const x = PADDING + columnIndex * (cellWidth + GAP)
        texts.push(
          `<text x="${x}" y="${y + 15}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="600" fill="${theme.label}">${escapeXml(fitLabel(cell.item.label, cellWidth))}</text>`,
          `<rect x="${x - 0.5}" y="${y + LABEL_HEIGHT - 0.5}" width="${cellWidth + 1}" height="${cell.height + 1}" fill="none" stroke="${theme.border}" stroke-width="1"/>`
        )
        layers.push({ input: cell.data, left: x, top: y + LABEL_HEIGHT })
      }
      y += rowHeights[rowIndex] + GAP
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${texts.join('')}</svg>`)
    const file = path.join(outDir, `folha-${String(sheetIndex + 1).padStart(2, '0')}.png`)
    await sharp({ create: { width, height, channels: 3, background: theme.background } })
      .composite([...layers, { input: svg, left: 0, top: 0 }])
      .png()
      .toFile(file)
    sheets.push({ file, width, height, labels: group.map((item) => item.label) })
  }
  return sheets
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* FigCraft: the frames of the current page, in reading order                                                          */

export interface DesignFrame {
  id: number | string
  name: string
  x: number
  y: number
  width: number
  height: number
}

const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'])

/**
 * The JSON object a tool answered, also when the server adds text after it (FigCraft ends some answers with
 * `tip: … guide {} …`, whose braces would end a naive slice in the wrong place): the object ends where its braces close.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    if (start < 0) return null
    let depth = 0
    let inString = false
    for (let index = start; index < trimmed.length; index++) {
      const char = trimmed[index]
      if (inString) {
        if (char === '\\') index++
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
    return null
  }
}

interface InspectedNode {
  id?: number | string
  name?: string
  type?: string
  x?: number
  y?: number
  width?: number
  height?: number
  absoluteBounds?: { x?: number; y?: number; width?: number; height?: number }
  children?: InspectedNode[]
}

/**
 * The screens of FigCraft's `inspect_document` answer: the top-level frames (and components) of the current page,
 * looking inside sections, in reading order (rows top to bottom, left to right in a row).
 */
export function framesOfDocument(doc: unknown): DesignFrame[] {
  const root = doc as { currentPage?: number | string; pages?: Array<InspectedNode & { id?: number | string }> } | null
  const pages = root?.pages ?? []
  const page = pages.find((item) => item.id === root?.currentPage && item.children) ?? pages.find((item) => item.children)
  const frames: DesignFrame[] = []
  const visit = (nodes: InspectedNode[] | undefined, depth: number): void => {
    for (const node of nodes ?? []) {
      const type = String(node.type ?? '').toUpperCase()
      if (type === 'SECTION' && depth < 3) visit(node.children, depth + 1)
      else if (FRAME_TYPES.has(type) && node.id !== undefined) {
        const box = node.absoluteBounds ?? {}
        frames.push({
          id: node.id,
          name: String(node.name ?? node.id),
          x: Number(box.x ?? node.x ?? 0),
          y: Number(box.y ?? node.y ?? 0),
          width: Number(box.width ?? node.width ?? 0),
          height: Number(box.height ?? node.height ?? 0)
        })
      }
    }
  }
  visit(page?.children, 0)
  return readingOrder(frames)
}

/** Rows by their top (frames whose tops are within half a frame of each other share a row), then left to right. */
export function readingOrder(frames: DesignFrame[]): DesignFrame[] {
  const sorted = [...frames].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: DesignFrame[][] = []
  for (const frame of sorted) {
    const row = rows[rows.length - 1]
    const tolerance = Math.max(40, Math.min(frame.height, row?.[0]?.height ?? frame.height) / 2)
    if (row && Math.abs(frame.y - row[0].y) <= tolerance) row.push(frame)
    else rows.push([frame])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
}
