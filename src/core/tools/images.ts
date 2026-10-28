import path from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import { editImage, generateImage, inspectImage } from '../images/service.js'
import { ocrImage } from '../media/ocr.js'
import type { ToolDef } from './types.js'

function imageText(info: Awaited<ReturnType<typeof inspectImage>>): string {
  return `${info.path}\n${info.width}x${info.height} · ${info.format ?? '?'} · ${info.channels ?? '?'} canal(is) · alpha=${info.hasAlpha ? 'sim' : 'não'} · ${info.size} bytes`
}

export const imageInspectTool: ToolDef = {
  name: 'image_inspect',
  description: 'Inspeciona dimensões, formato, canais, transparência, espaço de cor e tamanho de uma imagem local.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({ path: z.string().min(1).max(1_000) }),
  describe(raw) {
    return { title: 'Inspecionar imagem', detail: (raw as { path?: string }).path ?? '' }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string }
    const info = await inspectImage(ctx.workspace.resolve(args.path, ctx.cwd))
    return { ok: true, text: imageText(info), summary: `${info.width}x${info.height} ${info.format ?? ''}`, files: [info.path], data: { ...info } }
  }
}

export const imageEditTool: ToolDef = {
  name: 'image_edit',
  description:
    'Edita imagem local sem sobrescrever o original: recorte, redimensionamento com ajuste, rotação, espelhamento, escala de cinza e conversão PNG/JPEG/WebP com transparência e qualidade.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    input: z.string().min(1).max(1_000),
    output: z.string().min(1).max(1_000),
    width: z.number().int().min(1).max(16_384).optional(),
    height: z.number().int().min(1).max(16_384).optional(),
    fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).optional(),
    background: z.string().max(40).optional(),
    crop: z.object({ left: z.number().min(0), top: z.number().min(0), width: z.number().min(1), height: z.number().min(1) }).optional(),
    rotate: z.number().min(-360).max(360).optional(),
    flip: z.boolean().optional(),
    flop: z.boolean().optional(),
    grayscale: z.boolean().optional(),
    format: z.enum(['png', 'jpeg', 'webp']).optional(),
    quality: z.number().int().min(1).max(100).optional()
  }),
  describe(raw) {
    const args = raw as { input?: string; output?: string }
    return { title: 'Editar imagem', detail: args.output ?? '', preview: args.input ?? '' }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      input: string; output: string; width?: number; height?: number; fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
      background?: string; crop?: { left: number; top: number; width: number; height: number }; rotate?: number
      flip?: boolean; flop?: boolean; grayscale?: boolean; format?: 'png' | 'jpeg' | 'webp'; quality?: number
    }
    const info = await editImage({
      ...args,
      input: ctx.workspace.resolve(args.input, ctx.cwd),
      output: ctx.workspace.resolve(args.output, ctx.cwd)
    })
    return { ok: true, text: imageText(info), summary: `imagem ${info.width}x${info.height}`, files: [info.path], data: { ...info } }
  }
}

export const imageGenerateTool: ToolDef = {
  name: 'image_generate',
  description:
    'Gera uma imagem por endpoint HTTP compatível com OpenAI `/images/generations`. Exige OPENCLOD_IMAGE_BASE_URL e opcionalmente OPENCLOD_IMAGE_API_KEY e OPENCLOD_IMAGE_MODEL; falha claramente quando não configurado e valida o arquivo retornado.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({
    prompt: z.string().min(1).max(20_000),
    output: z.string().min(1).max(1_000),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
    model: z.string().min(1).max(200).optional()
  }),
  describe(raw) {
    const args = raw as { output?: string; prompt?: string }
    return { title: 'Gerar imagem', detail: args.output ?? '', preview: args.prompt?.slice(0, 300) }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { prompt: string; output: string; width?: number; height?: number; model?: string }
    const info = await generateImage({ ...args, output: ctx.workspace.resolve(args.output, ctx.cwd), signal: ctx.signal })
    return {
      ok: true,
      text: `${imageText(info)}\nprompt: ${args.prompt.slice(0, 500)}`,
      summary: `${path.basename(info.path)} · ${info.width}x${info.height}`,
      files: [info.path],
      data: { ...info }
    }
  }
}

export const imageOcrTool: ToolDef = {
  name: 'image_ocr',
  description:
    'Extrai texto offline de capturas, fotos e documentos digitalizados com Windows.Media.Ocr. Retorna linhas e coordenadas das palavras para rastrear a posição na imagem.',
  risk: 'read',
  parallelSafe: false,
  schema: z.object({
    path: z.string().min(1).max(1_000),
    include_boxes: z.boolean().optional().describe('Incluir coordenadas x/y/largura/altura das palavras')
  }),
  describe(raw) {
    return { title: 'OCR de imagem', detail: (raw as { path?: string }).path ?? '' }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string; include_boxes?: boolean }
    const result = await ocrImage(ctx.workspace.resolve(args.path, ctx.cwd), { signal: ctx.signal })
    const text = result.lines.length
      ? result.lines.map((line) => args.include_boxes
          ? `${line.text}\n  ${line.words.map((word) => `${word.text}@${word.x},${word.y},${word.width}x${word.height}`).join(' · ')}`
          : line.text).join('\n')
      : '(nenhum texto reconhecido)'
    return {
      ok: Boolean(result.text),
      text,
      summary: `${result.lines.length} linha(s) OCR`,
      files: [result.source],
      data: { text: result.text, lines: result.lines }
    }
  }
}

export const imageTools: ToolDef[] = [imageInspectTool, imageEditTool, imageGenerateTool, imageOcrTool]
