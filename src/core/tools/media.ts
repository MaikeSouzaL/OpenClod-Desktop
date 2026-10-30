import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ImagePart, ToolResult } from '../../shared/types.js'
import type { MediaManifest } from '../media/ingest.js'
import { findMediaDir, ingestToMemory, loadSheetImages, mmss, readOcr, type MediaPageDraft } from '../media/memory.js'
import { transcribeMedia } from '../media/transcribe.js'
import { truncateMiddle } from '../util/ids.js'
import type { ToolContext, ToolDef } from './types.js'

function timestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

export const mediaTranscribeTool: ToolDef = {
  name: 'media_transcribe',
  description:
    'Transcreve áudio ou vídeo local com o faster-whisper embutido e retorna idioma, duração e segmentos com timestamps. Não envia a mídia para serviços externos. Use antes de resumir reuniões, vídeos, aulas ou gravações.',
  risk: 'read',
  parallelSafe: false,
  schema: z.object({
    path: z.string().min(1).max(1_000).describe('Arquivo de áudio/vídeo relativo ao workspace'),
    model: z.enum(['tiny', 'base', 'small']).optional().describe('Modelo embutido; base é o padrão'),
    language: z.string().regex(/^([a-z]{2,3}|auto)$/).optional().describe('ISO 639-1/3 ou auto')
  }),
  describe(raw) {
    const args = raw as { path?: string; model?: string; language?: string }
    return { title: 'Transcrever mídia', detail: args.path ?? '', preview: [args.model, args.language].filter(Boolean).join(' · ') }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string; model?: 'tiny' | 'base' | 'small'; language?: string }
    const source = ctx.workspace.resolve(args.path, ctx.cwd)
    const result = await transcribeMedia(source, { model: args.model, language: args.language, signal: ctx.signal })
    const lines = result.segments.length
      ? result.segments.map((segment) => `[${timestamp(segment.start)}–${timestamp(segment.end)}] ${segment.text}`)
      : [result.text || '(nenhuma fala reconhecida)']
    return {
      ok: Boolean(result.text.trim()),
      text: truncateMiddle([
        `Arquivo: ${path.basename(result.source)}`,
        `Idioma: ${result.language} (${Math.round(result.languageProbability * 100)}%)`,
        `Duração: ${timestamp(result.duration)} · ${result.device}/${result.computeType || 'auto'}`,
        '',
        ...lines
      ].join('\n'), 60_000),
      summary: `${result.segments.length} segmento(s) · ${timestamp(result.duration)} · ${result.language}`,
      files: [result.source],
      data: {
        language: result.language,
        languageProbability: result.languageProbability,
        duration: result.duration,
        device: result.device,
        computeType: result.computeType,
        segments: result.segments
      }
    }
  }
}

/** Mirrors a media page into the long-term index the way `memory_page write` does; best effort. */
export function mediaMirror(ctx: Pick<ToolContext, 'services' | 'projectId'>): ((draft: MediaPageDraft) => Promise<void>) | undefined {
  const aiMemory = ctx.services.aiMemory
  const projectId = ctx.projectId
  if (!aiMemory || !projectId) return undefined
  return async (draft) => {
    await aiMemory.writePage(projectId, { path: `pages/${draft.slug}.md`, title: draft.title, body: draft.body, tags: draft.tags, tier: 'semantic' })
  }
}

export const mediaIngestTool: ToolDef = {
  name: 'media_ingest',
  // Transcribing a long recording has long silent stretches.
  idleLimitMs: 20 * 60_000,
  description:
    'Processa um áudio ou vídeo local de ponta a ponta e guarda tudo na memória do projeto, para você e qualquer outro modelo usarem como contexto sem reler a mídia: ' +
    'transcreve a fala (Whisper embutido, offline); em vídeo, extrai os frames que importam (cortes de cena, sem repetições), monta folhas de contato e lê o texto da tela (OCR). ' +
    'Cria uma página-índice e partes de poucos minutos com a fala e os frames em uma linha do tempo; depois consulte com memory_recall e memory_page read. ' +
    'Anexos de áudio/vídeo na mensagem do usuário já são processados sozinhos: use esta ferramenta para um arquivo que só foi citado, para reprocessar ou para ajustar idioma, modelo e limites. ' +
    'Não é preciso repetir o processamento de uma mídia já feita: a mesma chamada devolve o resultado guardado. ' +
    'Uma ferramenta tem 10 minutos; para uma mídia muito longa (mais de ~40 min) peça ao usuário para anexá-la na mensagem (o processamento automático não tem esse limite) ou use max_seconds.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    path: z.string().min(1).max(1_000).describe('Arquivo de áudio ou vídeo (caminho absoluto ou relativo ao workspace)'),
    language: z.string().regex(/^([a-z]{2,3}|auto)$/).optional().describe('Idioma da fala (ISO 639-1) ou auto (padrão: detecta)'),
    model: z.enum(['auto', 'tiny', 'base', 'small']).optional().describe('Modelo Whisper; auto usa small com GPU e base sem'),
    max_frames: z.number().int().min(10).max(400).optional().describe('Teto de frames mantidos num vídeo (padrão 150)'),
    max_seconds: z.number().int().min(10).optional().describe('Processa só os primeiros N segundos (padrão: tudo)'),
    ocr: z.boolean().optional().describe('Ler o texto que aparece nos frames (padrão: sim, só no Windows)'),
    overwrite: z.boolean().optional().describe('Refazer mesmo que já exista um resultado igual'),
    view_sheets: z.number().int().min(0).max(4).optional().describe('Quantas folhas de contato devolver como imagem a um modelo que enxerga (padrão 2)')
  }),
  describe(raw) {
    const args = raw as { path?: string; language?: string }
    return { title: 'Processar mídia', detail: args.path ?? '', preview: args.language }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      path: string
      language?: string
      model?: 'auto' | 'tiny' | 'base' | 'small'
      max_frames?: number
      max_seconds?: number
      ocr?: boolean
      overwrite?: boolean
      view_sheets?: number
    }
    const source = ctx.workspace.resolve(args.path, ctx.cwd)
    const result = await ingestToMemory({
      file: source,
      memory: ctx.services.projectMemory,
      mirror: mediaMirror(ctx),
      language: args.language,
      model: args.model,
      maxFrames: args.max_frames,
      maxSeconds: args.max_seconds,
      ocr: args.ocr,
      overwrite: args.overwrite,
      signal: ctx.signal,
      onProgress: (text) => ctx.progress?.(text)
    })
    const images: ImagePart[] = ctx.vision ? loadSheetImages(result.dir, result.manifest, args.view_sheets ?? 2) : []
    const manifest = result.manifest
    return {
      ok: true,
      text: result.digest + (ctx.vision ? '' : '\n(O modelo atual não recebe imagens: use o texto das partes, que inclui o que o OCR leu em cada frame.)'),
      summary: `${manifest.kind === 'video' ? 'vídeo' : 'áudio'} · ${mmss(manifest.info.duration)} · ${manifest.frames.length} frames · ${manifest.transcript.segments.length} trechos${result.cached ? ' (já processado)' : ''}`,
      files: [path.join(result.dir, 'manifest.json')],
      ...(images.length ? { images } : {}),
      data: {
        mediaSlug: result.plan.mediaSlug,
        index: result.plan.index.slug,
        parts: result.plan.parts.map((part) => part.slug),
        dir: result.dir,
        frames: manifest.frames.length,
        sheets: manifest.sheets.length,
        segments: manifest.transcript.segments.length,
        language: manifest.transcript.language,
        cached: result.cached
      }
    }
  }
}

function readManifest(dir: string): MediaManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as MediaManifest
  } catch {
    return null
  }
}

export const mediaViewTool: ToolDef = {
  name: 'media_view',
  description:
    'Mostra uma folha de contato (3×3 frames consecutivos, cada um com número e tempo) ou um frame de um vídeo já processado com media_ingest ou anexado, com o texto que o OCR leu. ' +
    'Só devolve a imagem a um modelo que enxerga; os demais recebem o texto. Sem `sheet` nem `frame` lista o que existe.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    media: z.string().min(2).max(160).describe('Slug da mídia, da página-índice (video-...) ou de uma das partes'),
    sheet: z.number().int().min(1).optional().describe('Número da folha de contato'),
    frame: z.number().int().min(1).optional().describe('Número do frame (o # que aparece nas folhas e nas partes)')
  }),
  describe(raw) {
    const args = raw as { media?: string; sheet?: number; frame?: number }
    return { title: 'Ver mídia', detail: args.media ?? '', preview: args.sheet ? `folha ${args.sheet}` : args.frame ? `frame ${args.frame}` : undefined }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { media: string; sheet?: number; frame?: number }
    const found = findMediaDir(ctx.services.projectMemory.root, args.media)
    if (!found) return { ok: false, text: `mídia não encontrada: "${args.media}". Use o slug da página-índice ("video-...") que aparece na memória.` }
    const manifest = readManifest(found.dir)
    if (!manifest) return { ok: false, text: `o manifesto de "${found.mediaSlug}" está ilegível; processe de novo com media_ingest overwrite=true` }
    const ocr = readOcr(found.dir)
    const screen = (frameFile: string): string => {
      const lines = (ocr[frameFile] ?? []).filter((line) => line.trim().length >= 3)
      return lines.length ? ` · na tela: ${lines.slice(0, 6).join(' · ').slice(0, 400)}` : ''
    }
    const noVision = ctx.vision ? '' : '\n(O modelo atual não recebe imagens: o texto acima é tudo o que posso mostrar.)'

    if (args.sheet) {
      const sheet = manifest.sheets[args.sheet - 1]
      if (!sheet) return { ok: false, text: `a mídia tem ${manifest.sheets.length} folha(s); pediu a ${args.sheet}` }
      const rows = manifest.frames.filter((frame) => frame.sheet === sheet.file).map((frame) => `#${frame.number} ${frame.ts} (célula ${frame.cell})${screen(frame.file)}`)
      const image = ctx.vision ? loadSheetImages(found.dir, { sheets: [sheet] }, 1, 4_000_000) : []
      return {
        ok: true,
        text: `Folha ${args.sheet} de ${manifest.sheets.length} (${mmss(sheet.t0)}–${mmss(sheet.t1)}):\n${rows.join('\n')}${noVision}`,
        summary: `folha ${args.sheet}`,
        files: [path.join(found.dir, sheet.file)],
        ...(image.length ? { images: image } : {})
      }
    }
    if (args.frame) {
      const frame = manifest.frames.find((item) => item.number === args.frame) ?? manifest.frames[args.frame - 1]
      if (!frame) return { ok: false, text: `a mídia tem ${manifest.frames.length} frame(s); pediu o ${args.frame}` }
      let image: ImagePart[] = []
      if (ctx.vision) {
        try {
          image = [{ type: 'image', mediaType: 'image/jpeg', data: fs.readFileSync(path.join(found.dir, frame.file)).toString('base64'), label: `frame #${frame.number} ${frame.ts}` }]
        } catch {
          /* the file is gone: the text still answers */
        }
      }
      return {
        ok: true,
        text: `Frame #${frame.number} em ${frame.ts} (${frame.via}; folha ${frame.sheet ?? '?'}, célula ${frame.cell ?? '?'})${screen(frame.file)}${noVision}`,
        summary: `frame ${frame.number}`,
        files: [path.join(found.dir, frame.file)],
        ...(image.length ? { images: image } : {})
      }
    }
    return {
      ok: true,
      text: [
        `${manifest.source.name} — ${manifest.kind === 'video' ? 'vídeo' : 'áudio'}, ${mmss(manifest.info.duration)}, ${manifest.frames.length} frames em ${manifest.sheets.length} folha(s).`,
        ...manifest.sheets.map((sheet, index) => `- folha ${index + 1}: ${mmss(sheet.t0)}–${mmss(sheet.t1)} (frames #${sheet.first}–#${sheet.first + sheet.frames.length - 1})`),
        'Peça uma folha com sheet=N ou um frame com frame=N.'
      ].join('\n'),
      summary: `${manifest.sheets.length} folha(s)`
    }
  }
}

export const mediaTools: ToolDef[] = [mediaTranscribeTool, mediaIngestTool, mediaViewTool]
