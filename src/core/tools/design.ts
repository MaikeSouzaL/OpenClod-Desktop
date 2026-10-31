import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ImagePart, ToolResult } from '../../shared/types.js'
import { previewImage } from '../images/preview.js'
import { collectImages, framesOfDocument, labelOf, parseJsonLoose, renderSheets, type SheetItem } from '../design/sheets.js'
import type { ToolDef } from './types.js'

/** Sheets returned as pictures at most (the rest stay on disk, with their paths in the text). */
const MAX_SHOWN = 6

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

/** A frame name as a file name, keeping the order prefix so the sheets follow the page. */
function fileNameFor(index: number, name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || `tela-${index + 1}`
  return `${String(index + 1).padStart(3, '0')}__${safe}.png`
}

export const designSheetTool: ToolDef = {
  name: 'design_sheet',
  description:
    'Monta FOLHAS DE CONTATO de telas para revisão de design: uma grade com várias telas lado a lado, cada uma com o seu nome/código em cima (ex.: MOT-MEN-01, MOT-MEN-01b), várias folhas quando há muitas. ' +
    'Fonte: `figcraft` exporta sozinho os frames da página atual do FigCraft (ou só os `ids` pedidos, na ordem de leitura) — use ao terminar ou revisar telas desenhadas no FigCraft; ou `paths` com imagens (png/jpg/webp) e pastas. ' +
    'Grava folha-01.png, folha-02.png… e mostra as folhas no chat. Mande ao usuário as folhas em vez de telas soltas.',
  risk: 'write',
  parallelSafe: false,
  // Exporting dozens of frames from FigCraft and composing the sheets can take a few minutes.
  idleLimitMs: 10 * 60_000,
  schema: z.object({
    figcraft: z
      .object({
        ids: z.array(z.union([z.number(), z.string()])).max(200).optional().describe('Frames a exportar (padrão: todos os frames da página atual)'),
        server: z.string().max(80).optional().describe('Nome do servidor MCP do FigCraft (padrão figcraft)'),
        scale: z.number().min(0.25).max(4).optional().describe('Escala da exportação (padrão 1)')
      })
      .optional(),
    paths: z.array(z.string().min(1).max(1_000)).max(100).optional().describe('Imagens e/ou pastas com imagens'),
    recursive: z.boolean().optional().describe('paths: entrar nas subpastas'),
    labels: z.array(z.string().max(80)).max(400).optional().describe('Rótulos na ordem das telas (padrão: nome do frame ou do arquivo)'),
    title: z.string().max(120).optional().describe('Título no topo de cada folha'),
    columns: z.number().int().min(1).max(10).optional().describe('Telas por linha (padrão 5)'),
    per_sheet: z.number().int().min(1).max(40).optional().describe('Telas por folha (padrão 2 linhas)'),
    cell_width: z.number().int().min(120).max(800).optional().describe('Largura de cada tela na folha, em px (padrão 300)'),
    theme: z.enum(['claro', 'escuro']).optional(),
    out_dir: z.string().max(1_000).optional().describe('Pasta das folhas (padrão .openclod/folhas/<data> no projeto)')
  }),
  describe(raw) {
    const args = raw as { figcraft?: { ids?: unknown[] }; paths?: string[]; title?: string }
    return {
      title: 'Folhas de contato',
      detail: args.figcraft ? `FigCraft${args.figcraft.ids?.length ? ` · ${args.figcraft.ids.length} frame(s)` : ' · página atual'}` : (args.paths ?? []).join(', '),
      preview: args.title ?? ''
    }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      figcraft?: { ids?: Array<number | string>; server?: string; scale?: number }
      paths?: string[]
      recursive?: boolean
      labels?: string[]
      title?: string
      columns?: number
      per_sheet?: number
      cell_width?: number
      theme?: 'claro' | 'escuro'
      out_dir?: string
    }
    if (!args.figcraft && !args.paths?.length) return { ok: false, text: 'informe `figcraft` (exportar do FigCraft) ou `paths` (imagens/pastas)' }
    const outDir = ctx.workspace.resolve(args.out_dir ?? path.join('.openclod', 'folhas', stamp()), ctx.cwd)
    const items: SheetItem[] = []
    const warnings: string[] = []

    if (args.figcraft) {
      const mcp = ctx.services.mcp
      const server = args.figcraft.server ?? 'figcraft'
      if (!mcp) return { ok: false, text: 'MCP indisponível nesta sessão: exporte as telas e use `paths`.' }
      let ids = args.figcraft.ids
      let names = new Map<string, string>()
      // The page tells the frames, their names and where they are (the reading order of the sheets).
      const inspected = await mcp.call(server, 'inspect_document', { depth: 2 }, ctx.signal)
      if (!inspected.ok) return { ok: false, text: `FigCraft não respondeu (${server}/inspect_document): ${inspected.text.slice(0, 400)}` }
      const frames = framesOfDocument(parseJsonLoose(inspected.text))
      names = new Map(frames.map((frame) => [String(frame.id), frame.name]))
      if (!ids?.length) ids = frames.map((frame) => frame.id)
      if (!ids.length) return { ok: false, text: 'a página atual do FigCraft não tem frames: desenhe as telas como frames de primeiro nível (ou passe `ids`).' }
      const exportDir = path.join(outDir, 'telas')
      fs.mkdirSync(exportDir, { recursive: true })
      for (const [index, id] of ids.entries()) {
        if (ctx.signal.aborted) throw new Error('folhas canceladas')
        const name = names.get(String(id)) ?? String(id)
        ctx.progress?.(`Exportando ${index + 1} de ${ids.length}: ${name}`)
        const file = path.join(exportDir, fileNameFor(index, name))
        const exported = await mcp.call(server, 'export', { ids: [id], path: file, format: 'png', scale: args.figcraft.scale ?? 1 }, ctx.signal)
        if (!exported.ok || !fs.existsSync(file)) {
          warnings.push(`${name}: não exportou (${exported.text.slice(0, 160)})`)
          continue
        }
        items.push({ file, label: name })
      }
    }

    if (args.paths?.length) {
      const files = collectImages(args.paths.map((given) => ctx.workspace.resolve(given, ctx.cwd)), args.recursive)
      for (const file of files) items.push({ file, label: labelOf(file) })
      if (!files.length) warnings.push('nenhuma imagem png/jpg/webp nos `paths`')
    }
    if (args.labels?.length) args.labels.forEach((label, index) => { if (items[index] && label.trim()) items[index].label = label.trim() })
    if (!items.length) return { ok: false, text: ['nenhuma tela para montar.', ...warnings].join('\n') }

    ctx.progress?.(`Montando as folhas de ${items.length} tela(s)…`)
    const sheets = await renderSheets(items, outDir, {
      columns: args.columns,
      perSheet: args.per_sheet,
      cellWidth: args.cell_width,
      title: args.title,
      theme: args.theme
    })
    const pictures: ImagePart[] = []
    for (const [index, sheet] of sheets.slice(0, MAX_SHOWN).entries()) {
      const picture = await previewImage(sheet.file, `Folha ${index + 1}${args.title ? ` · ${args.title}` : ''}`)
      if (picture) pictures.push(picture)
    }
    const text = [
      `${sheets.length} folha(s) com ${items.length} tela(s) em ${outDir}:`,
      ...sheets.map((sheet, index) => `- folha ${index + 1}: ${sheet.file} (${sheet.width}×${sheet.height}) — ${sheet.labels.join(', ')}`),
      sheets.length > MAX_SHOWN ? `As folhas a partir da ${MAX_SHOWN + 1} ficaram só no disco.` : '',
      warnings.length ? `Avisos:\n${warnings.map((warning) => `- ${warning}`).join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    return {
      ok: true,
      text,
      summary: `${sheets.length} folha(s) · ${items.length} tela(s)`,
      files: sheets.map((sheet) => sheet.file),
      // A model that sees images reviews the sheets itself; the chat shows them either way.
      ...(ctx.vision ? { images: pictures } : { preview: pictures }),
      data: { outDir, sheets, warnings }
    }
  }
}

export const designTools: ToolDef[] = [designSheetTool]
