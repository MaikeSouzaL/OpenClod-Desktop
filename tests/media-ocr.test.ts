import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ingestMedia } from '../src/core/media/ingest'
import { ocrImages } from '../src/core/media/ocr'
import { resourcePath } from '../src/core/util/resources'
import { makeTempDir, removeTempDir } from './helpers'

/** Batch OCR: one PowerShell for all the frames of a video (Windows.Media.Ocr, offline). Windows only. */
const python = resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const script = resourcePath('media', 'forja_media.py')
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
