import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractDocument } from '../src/core/documents/extractor'
import { ingestMedia } from '../src/core/media/ingest'
import { OCR_MAX_DIMENSION, ocrImage, ocrImages } from '../src/core/media/ocr'
import { resourcePath } from '../src/core/util/resources'
import { makeTempDir, removeTempDir } from './helpers'

/** Batch OCR: one PowerShell for all the frames of a video (Windows.Media.Ocr, offline). Windows only. */
const python = resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const script = resourcePath('media', 'openclod_media.py')
const run = process.platform === 'win32' && python && script ? describe : describe.skip

let root = ''
beforeAll(async () => {
  root = await makeTempDir('openclod-ocr-')
})
afterAll(async () => removeTempDir(root))

/** A PNG with real text in a real font (Windows' own GDI+), and one without any. */
function drawImages(): { withText: string; blank: string } {
  const withText = path.join(root, 'texto.png')
  const blank = path.join(root, 'branco.png')
  const draw = [
    'Add-Type -AssemblyName System.Drawing',
    '$bitmap = New-Object System.Drawing.Bitmap 1000, 220',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.Clear([System.Drawing.Color]::White)',
    'if ($env:OCR_TEXT) { $graphics.DrawString($env:OCR_TEXT, (New-Object System.Drawing.Font("Arial", 44)), [System.Drawing.Brushes]::Black, 20, 60) }',
    '$bitmap.Save($env:OCR_OUT, [System.Drawing.Imaging.ImageFormat]::Png)'
  ].join('; ')
  for (const [file, text] of [[withText, 'Relatorio de vendas 2026'], [blank, '']] as const) {
    const made = spawnSync('powershell.exe', ['-NoProfile', '-Command', draw], { encoding: 'utf8', env: { ...process.env, OCR_OUT: file, OCR_TEXT: text } })
    if (made.status !== 0) throw new Error(`não consegui desenhar a imagem de teste: ${made.stderr}`)
  }
  return { withText, blank }
}

async function batch(files: string[], onProgress?: (done: number) => void): Promise<Awaited<ReturnType<typeof ocrImages>> | null> {
  try {
    return await ocrImages(files, { onProgress })
  } catch (error) {
    if (/engine unavailable|OCR falhou/.test((error as Error).message)) return null // no Windows OCR language pack on this machine
    throw error
  }
}

run('reading the text on images', () => {
  it('reads real text, with accents and numbers intact, and returns nothing for an image without text', async () => {
    const { withText, blank } = drawImages()
    const result = await batch([withText, blank])
    if (!result) return
    expect(result.failed).toBe(0)
    expect(result.text.get(withText)?.join(' ').toLowerCase()).toMatch(/relat.rio de vendas 2026/)
    expect(result.text.get(blank)).toEqual([])
  }, 120_000)

  it('does every frame of a video in one go, reporting progress', async () => {
    const video = path.join(root, 'cenas.mp4')
    expect(spawnSync(python!, ['-I', '-X', 'utf8', script!, 'make-test-video', '--out', video], { encoding: 'utf8' }).status).toBe(0)
    const out = path.join(root, 'out')
    const manifest = (await ingestMedia(video, { outDir: out, noTranscribe: true })).manifest
    const files = manifest.frames.map((frame) => path.join(out, frame.file))
    const progress: number[] = []
    const result = await batch(files, (done) => progress.push(done))
    if (!result) return
    expect(result.failed).toBe(0)
    expect(result.text.size).toBe(files.length)
    expect(progress.at(-1)).toBe(files.length)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  }, 240_000)

  it('counts an image the engine cannot read as failed without losing the others', async () => {
    const { withText } = drawImages()
    const missing = path.join(root, 'nao-existe.png')
    const result = await batch([withText, missing])
    if (!result) return
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain('nao-existe.png')
    expect(result.text.has(withText)).toBe(true)
    expect(result.text.has(missing)).toBe(false)
    expect(fs.existsSync(withText)).toBe(true)
  }, 120_000)

  it('does nothing for an empty list', async () => {
    expect((await ocrImages([])).text.size).toBe(0)
  })
})

/**
 * What a WhatsApp document made of screenshots needs (2026-10-29 report): the engine reads NOTHING, without an error, from
 * an image taller than OcrEngine.MaxImageDimension, and a scanned PDF has no text layer at all.
 */
const runPages = process.platform === 'win32' && python ? describe : describe.skip

/** GDI+ draws `lines` of text down a white `width`×`height` page. */
function drawPage(file: string, width: number, height: number, lines: string[], gap: number): void {
  const draw = [
    'Add-Type -AssemblyName System.Drawing',
    '$bitmap = New-Object System.Drawing.Bitmap ([int]$env:OCR_W), ([int]$env:OCR_H)',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.Clear([System.Drawing.Color]::White)',
    '$font = New-Object System.Drawing.Font("Arial", 30)',
    '$y = 60; foreach ($line in ($env:OCR_LINES -split "\\|")) { $graphics.DrawString($line, $font, [System.Drawing.Brushes]::Black, 60, $y); $y += [int]$env:OCR_GAP }',
    '$bitmap.Save($env:OCR_OUT, [System.Drawing.Imaging.ImageFormat]::Png)'
  ].join('; ')
  const made = spawnSync('powershell.exe', ['-NoProfile', '-Command', draw], {
    encoding: 'utf8',
    env: { ...process.env, OCR_OUT: file, OCR_W: String(width), OCR_H: String(height), OCR_LINES: lines.join('|'), OCR_GAP: String(gap) }
  })
  if (made.status !== 0) throw new Error(`não consegui desenhar a página de teste: ${made.stderr}`)
}

/** Reading, or null when this machine has no Windows OCR language (nothing to prove then). */
async function orSkip<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch (error) {
    if (/engine unavailable|OCR falhou/.test((error as Error).message)) return null
    throw error
  }
}

runPages('reading whole pages and scanned PDFs', () => {
  it('keeps the accents of a single image (the JSON used to leave in the console code page: "Relat�rio")', async () => {
    const file = path.join(root, 'acentos.png')
    drawPage(file, 1100, 260, ['Relatório de visitação às 10h'], 80)
    const result = await orSkip(() => ocrImage(file))
    if (!result) return
    expect(result.mode).toBe('inteira')
    expect(result.text).toMatch(/Relatório de visitação/)
    expect(result.text).not.toContain('\uFFFD')
  }, 120_000)

  it('reads a scrolling screenshot taller than the engine limit, in blocks, with every line and none twice', async () => {
    const file = path.join(root, 'rolagem.png')
    const height = OCR_MAX_DIMENSION + 1_200
    const lines = Array.from({ length: 26 }, (_, index) => `Linha ${index + 1} do pedido`)
    drawPage(file, 1_400, height, lines, 440)
    const result = await orSkip(() => ocrImage(file))
    if (!result) return
    expect(result.mode).toBe('blocos')
    const numbers = [...result.text.matchAll(/Linha (\d+)/g)].map((match) => Number(match[1]))
    expect(numbers).toEqual(lines.map((_, index) => index + 1))
  }, 180_000)

  it('reads a scanned PDF (images only, no text layer) in ONE call, also when the attachment has no extension', async () => {
    const pdf = path.join(root, 'digitalizado.pdf')
    const make = [
      'import sys',
      'from PIL import Image, ImageDraw, ImageFont',
      'font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 30)',
      'pages = []',
      'for title in ("Relatório de uso", "Relatório de performance"):',
      '    page = Image.new("RGB", (1240, 1754), "white")',
      '    draw = ImageDraw.Draw(page)',
      '    draw.text((90, 90), title, font=font, fill="black")',
      '    draw.text((90, 160), "Pedidos aprovados: 1.284", font=font, fill="black")',
      '    pages.append(page)',
      'pages[0].save(sys.argv[1], save_all=True, append_images=pages[1:], resolution=150)'
    ].join('\n')
    expect(spawnSync(python!, ['-I', '-c', make, pdf], { encoding: 'utf8' }).status).toBe(0)
    expect(fs.readFileSync(pdf).includes(Buffer.from(' Tj'))).toBe(false) // no text operator: images only
    const attachment = path.join(root, 'anexo-whatsapp')
    fs.copyFileSync(pdf, attachment)
    for (const file of [pdf, attachment]) {
      const doc = await orSkip(() => extractDocument(file))
      if (!doc) return
      expect(doc.format).toBe('pdf')
      expect(doc.metadata.ocr).toBe(true)
      expect(doc.pages.map((page) => page.text.split('\n')[0])).toEqual(['Relatório de uso', 'Relatório de performance'])
      expect(doc.text).toContain('Pedidos aprovados: 1.284')
      expect(doc.warnings.join(' ')).toMatch(/OCR/)
    }
  }, 240_000)
})
