import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { previewImage } from '../src/core/images/preview'
import { WorkspaceGuard } from '../src/core/security/policy'
import { documentExtractTool } from '../src/core/tools/documents'
import { imageOcrTool } from '../src/core/tools/images'
import type { ToolContext } from '../src/core/tools/types'
import { resourcePath } from '../src/core/util/resources'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * "Every image it reads shows in the chat": a tool that gives the model text (OCR, a PDF) also returns what it read as
 * small pictures in ToolResult.preview, which the runner never sends to a model (tests/runner-fallback.test.ts).
 */
let root = ''
beforeAll(async () => {
  root = await makeTempDir('openclod-previews-')
})
afterAll(async () => removeTempDir(root))

const context = (): ToolContext => ({ cwd: root, workspace: new WorkspaceGuard([root]), signal: new AbortController().signal }) as unknown as ToolContext

const sizeOf = async (data: string): Promise<{ width?: number; height?: number; format?: string }> => sharp(Buffer.from(data, 'base64')).metadata()

describe('previewImage', () => {
  it('a big image becomes a small JPEG that keeps its proportions and its label', async () => {
    const file = path.join(root, 'grande.png')
    await sharp({ create: { width: 3_000, height: 1_500, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toFile(file)
    const preview = await previewImage(file, 'grande.png')
    expect(preview).toMatchObject({ type: 'image', mediaType: 'image/jpeg', label: 'grande.png' })
    expect(await sizeOf(preview!.data)).toMatchObject({ width: 1_200, height: 600, format: 'jpeg' })
  })

  it('a tall scrolling print fits the height; a small image is not enlarged', async () => {
    const tall = path.join(root, 'rolagem.png')
    await sharp({ create: { width: 1_000, height: 12_000, channels: 3, background: '#ffffff' } }).png().toFile(tall)
    expect(await sizeOf((await previewImage(tall, 'r'))!.data)).toMatchObject({ height: 1_600 })
    const small = path.join(root, 'pequena.png')
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffffff' } }).png().toFile(small)
    expect(await sizeOf((await previewImage(small, 'p'))!.data)).toMatchObject({ width: 300, height: 200 })
  })

  it('never throws: a file that is not an image gives no preview', async () => {
    const file = path.join(root, 'nao-imagem.png')
    fs.writeFileSync(file, 'texto')
    expect(await previewImage(file, 'x')).toBeNull()
    expect(await previewImage(path.join(root, 'nao-existe.png'), 'x')).toBeNull()
  })
})

const python = resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const runWindows = process.platform === 'win32' && python ? describe : describe.skip

/** Reading, or null when this machine has no Windows OCR language (nothing to prove then). */
async function orSkip<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch (error) {
    if (/engine unavailable|OCR falhou/.test((error as Error).message)) return null
    throw error
  }
}

function makePdf(file: string, titles: string[], textLayer: boolean): void {
  // Pillow writes images only; reportlab is not embedded, so a text layer is written by hand around a Pillow page.
  const make = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 34)',
    'pages = []',
    'for title in sys.argv[2:]:',
    '    page = Image.new("RGB", (1240, 1754), "white")',
    '    ImageDraw.Draw(page).text((90, 90), title, font=font, fill="black")',
    '    pages.append(page)',
    'pages[0].save(sys.argv[1], save_all=True, append_images=pages[1:], resolution=150)'
  ].join('\n')
  if (!textLayer) {
    expect(spawnSync(python!, ['-I', '-c', make, file, ...titles], { encoding: 'utf8' }).status).toBe(0)
    return
  }
  const content = `BT /F1 24 Tf 72 720 Td (${titles[0]}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  fs.writeFileSync(file, Buffer.from(body, 'latin1'))
}

runWindows('the tools return what they read as previews', () => {
  it('document_extract on a scanned PDF: the OCR text for the model, the rendered pages for the chat', async () => {
    const pdf = path.join(root, 'digitalizado.pdf')
    makePdf(pdf, ['Contrato de uso', 'Anexo de valores'], false)
    const result = await orSkip(() => documentExtractTool.execute({ path: 'digitalizado.pdf' }, context()))
    if (!result) return
    expect(result.text).toContain('Contrato de uso')
    expect(result.preview?.map((image) => image.label)).toEqual(['página 1', 'página 2'])
    for (const image of result.preview ?? []) {
      expect(image.mediaType).toBe('image/jpeg')
      expect((await sizeOf(image.data)).width).toBeLessThanOrEqual(1_200)
      expect(result.text).not.toContain(image.data.slice(0, 40))
    }
    expect(result.images).toBeUndefined() // nothing for the model to look at: it reads the text
  }, 240_000)

  it('document_extract on a PDF with a text layer renders its first page for the chat', async () => {
    const pdf = path.join(root, 'com-texto.pdf')
    makePdf(pdf, ['Proposta comercial'], true)
    const result = await documentExtractTool.execute({ path: 'com-texto.pdf' }, context())
    expect(result.text).toContain('Proposta comercial')
    expect(result.preview?.map((image) => image.label)).toEqual(['página 1'])
  }, 120_000)

  it('image_ocr shows the image it read, named after the file', async () => {
    const file = path.join(root, 'recibo.png')
    await sharp({
      create: { width: 900, height: 220, channels: 3, background: '#ffffff' }
    })
      .composite([{ input: Buffer.from('<svg width="900" height="220"><text x="40" y="120" font-family="Arial" font-size="64">Recibo 4821</text></svg>'), top: 0, left: 0 }])
      .png()
      .toFile(file)
    const result = await orSkip(() => imageOcrTool.execute({ path: 'recibo.png' }, context()))
    if (!result) return
    expect(result.preview?.map((image) => image.label)).toEqual(['recibo.png'])
    expect(result.images).toBeUndefined()
  }, 120_000)
})
