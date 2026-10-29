import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import sharp from 'sharp'
import type { ImagePart } from '../../shared/types.js'
import { previewImage } from '../images/preview.js'

export interface OcrWord {
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface OcrLine {
  text: string
  words: OcrWord[]
}

export interface OcrResult {
  source: string
  text: string
  lines: OcrLine[]
}

const OCR_SCRIPT = [
  // Without it the JSON leaves in the console code page and every accent arrives as U+FFFD ("Relat�rio").
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]',
  'function Await($operation, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(); return $task.Result }',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:OPENCLOD_OCR_IMAGE)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if (-not $engine) { throw "Windows OCR engine unavailable" }',
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$lines = @($result.Lines | ForEach-Object { [pscustomobject]@{ text=$_.Text; words=@($_.Words | ForEach-Object { [pscustomobject]@{ text=$_.Text; x=[math]::Round($_.BoundingRect.X,2); y=[math]::Round($_.BoundingRect.Y,2); width=[math]::Round($_.BoundingRect.Width,2); height=[math]::Round($_.BoundingRect.Height,2) } }) } })',
  '[pscustomobject]@{ text=$result.Text; lines=$lines } | ConvertTo-Json -Depth 8 -Compress',
  '$bitmap.Dispose()',
  '$stream.Dispose()'
].join('\r\n')

/** Windows PowerShell 5.1's ConvertTo-Json writes a one-element array as the element itself. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value && typeof value === 'object' ? [value] : []
}

export function parseOcrOutput(raw: string, source = ''): OcrResult {
  try {
    const parsed = JSON.parse(raw.trim() || '{}') as { text?: unknown; lines?: unknown }
    const lines = asArray(parsed.lines).flatMap((item) => {
      const line = item as Record<string, unknown>
      const text = typeof line.text === 'string' ? line.text.trim() : ''
      const words = asArray(line.words).flatMap((entry) => {
        const word = entry as Record<string, unknown>
        const value = typeof word.text === 'string' ? word.text.trim() : ''
        return value ? [{ text: value, x: Number(word.x) || 0, y: Number(word.y) || 0, width: Number(word.width) || 0, height: Number(word.height) || 0 }] : []
      })
      return text || words.length ? [{ text: text || words.map((word) => word.text).join(' '), words }] : []
    })
    return { source, text: typeof parsed.text === 'string' ? parsed.text.trim() : lines.map((line) => line.text).join('\n'), lines }
  } catch {
    return { source, text: '', lines: [] }
  }
}

/**
 * One PowerShell process for many images: the OCR engine and the WinRT plumbing load once (about a second), after that
 * each image is a few hundred milliseconds. A video has dozens of frames; one process per frame would take minutes.
 * Output is one compact JSON object per line, UTF-8, so accents survive the console code page.
 */
export const OCR_BATCH_SCRIPT = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]',
  'function Await($operation, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(); return $task.Result }',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if (-not $engine) { throw "Windows OCR engine unavailable" }',
  // One path per line (UTF-8): ConvertFrom-Json hands a JSON array back as ONE object on Windows PowerShell 5.1.
  '$paths = @(Get-Content -Encoding UTF8 -LiteralPath $env:OPENCLOD_OCR_LIST | Where-Object { $_.Trim() })',
  'foreach ($item in $paths) {',
  // Get-Content strings carry PSPath/ReadCount: ConvertTo-Json would write them as an object, not as a string.
  '  $p = [string]$item',
  '  try {',
  '    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])',
  '    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '    $lines = @($result.Lines | ForEach-Object { $_.Text })',
  '    [pscustomobject]@{ path=$p; lines=$lines } | ConvertTo-Json -Compress',
  '    $bitmap.Dispose(); $stream.Dispose()',
  '  } catch { [pscustomobject]@{ path=$p; error=$_.Exception.Message } | ConvertTo-Json -Compress }',
  '}'
].join('\r\n')

export interface OcrBatchResult {
  /** Recognised text lines per image path (as given). */
  text: Map<string, string[]>
  /** Images the engine could not read. */
  failed: number
  /** The first few reasons, for the log. */
  errors: string[]
}

function powerShellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Runs a batch script over `files` (one path per line in a temporary list, OPENCLOD_OCR_LIST) and hands every JSON line
 * it prints to `onItem`. Fails only when the process dies before answering for a single file.
 */
async function runOcrBatch(
  script: string,
  files: string[],
  onItem: (item: Record<string, unknown>) => void,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('OCR nativo disponível apenas no Windows')
  const list = path.join(os.tmpdir(), `openclod-ocr-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`)
  await fs.promises.writeFile(list, files.map((file) => path.resolve(file)).join('\r\n'), 'utf8')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, OPENCLOD_OCR_LIST: list },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let answered = 0
      let stderrTail = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-1_000)
      })
      const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      reader.on('line', (line) => {
        const trimmed = line.trim().replace(/^\uFEFF/, '')
        if (!trimmed.startsWith('{')) return
        let item: Record<string, unknown>
        try {
          item = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          return // a line that is not ours
        }
        answered++
        onItem(item)
      })
      const timer = setTimeout(() => child.kill(), Math.min(10 * 60_000, 30_000 + files.length * 3_000))
      const onAbort = (): void => {
        child.kill()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`OCR falhou: ${error.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        if (!answered && code) reject(new Error(`OCR falhou (código ${code})${stderrTail ? ` · ${stderrTail.trim().slice(-500)}` : ''}`))
        else resolve()
      })
    })
  } finally {
    await fs.promises.rm(list, { force: true }).catch(() => undefined)
  }
}

export async function ocrImages(
  files: string[],
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<OcrBatchResult> {
  const text = new Map<string, string[]>()
  const errors: string[] = []
  let failed = 0
  if (!files.length) return { text, failed, errors }
  const byResolved = new Map(files.map((file) => [path.resolve(file).toLowerCase(), file]))
  let done = 0
  await runOcrBatch(OCR_BATCH_SCRIPT, files, (item) => {
    const key = byResolved.get(String(item.path ?? '').toLowerCase()) ?? String(item.path ?? '')
    done++
    if (item.error) {
      failed++
      if (errors.length < 3) errors.push(`${path.basename(String(item.path ?? ''))}: ${String(item.error).slice(0, 200)}`)
    } else text.set(key, (Array.isArray(item.lines) ? item.lines : typeof item.lines === 'string' ? [item.lines] : []).map((value) => String(value).trim()).filter(Boolean))
    options.onProgress?.(done, files.length)
  }, options)
  return { text, failed, errors }
}

/** One pass of the engine over the whole image (fast, keeps the engine's own line grouping). */
function ocrWhole(resolved: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<OcrResult> {
  return new Promise((resolve, reject) => {
    execFile(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', OCR_SCRIPT], {
      windowsHide: true,
      timeout: Math.max(10_000, Math.min(120_000, options.timeoutMs ?? 60_000)),
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      signal: options.signal,
      env: { ...process.env, OPENCLOD_OCR_IMAGE: resolved }
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`OCR falhou: ${error.message}${stderr ? ` · ${String(stderr).trim().slice(-800)}` : ''}`))
      else resolve(parseOcrOutput(String(stdout ?? ''), resolved))
    })
  })
}

export type OcrMode = 'inteira' | 'blocos'

/**
 * Text of an image. The whole image first; when the engine returns nothing (or the image is past OCR_MAX_DIMENSION,
 * where it returns nothing without an error), the image is read in enlarged blocks. `mode: 'blocos'` goes straight there.
 */
export async function ocrImage(
  file: string,
  options: { signal?: AbortSignal; timeoutMs?: number; mode?: 'auto' | OcrMode } = {}
): Promise<OcrResult & { mode: OcrMode }> {
  if (process.platform !== 'win32') throw new Error('OCR nativo disponível apenas no Windows')
  const resolved = path.resolve(file)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('imagem não é um arquivo')
  if (stat.size > 50 * 1024 * 1024) throw new Error('imagem maior que 50 MB para OCR')
  let whole: OcrResult | null = null
  if (options.mode !== 'blocos') {
    const size = await sharp(resolved).metadata().catch(() => null)
    if (!size || Math.max(size.width ?? 0, size.height ?? 0) <= OCR_MAX_DIMENSION) {
      whole = await ocrWhole(resolved, options)
      if (whole.text.trim() || options.mode === 'inteira') return { ...whole, mode: 'inteira' }
    }
  }
  try {
    const [blocks] = await ocrImagesInBlocks([resolved], { signal: options.signal })
    return { ...blocks, mode: 'blocos' }
  } catch (error) {
    // A format the engine decodes but the block cutter does not (BMP, ICO): the whole-image answer stands.
    if (whole && !options.signal?.aborted) return { ...whole, mode: 'inteira' }
    throw error
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Blocks                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Windows.Media.Ocr reads nothing — no error, an empty result — from an image wider or taller than this
 * (OcrEngine.MaxImageDimension). A WhatsApp PDF made of scrolling screenshots has pages far taller than that.
 */
export const OCR_MAX_DIMENSION = 10_000

/**
 * How an image is cut: cells of at most `stride` source pixels split it evenly; each block is its cell plus half the
 * `overlap` on every inner side (a word cut by one block is whole in the next), enlarged `scale` times, which also makes
 * small print legible. Every boundary can cut a word, so blocks are only as small as the limit needs.
 */
export interface TileGrid {
  stride: number
  overlap: number
  scale: number
}

/** 4 100 + 400 at 2× keeps blocks under 9 000 px: an A4 page is ONE block, a scrolling screenshot a few stacked ones. */
export const OCR_TILES: TileGrid = { stride: 4_100, overlap: 400, scale: 2 }
/** Last resort for an image the big blocks still read as empty. */
export const OCR_TILES_FINE: TileGrid = { stride: 800, overlap: 320, scale: 2 }

export interface OcrTile {
  col: number
  row: number
  /** The block, in source pixels. */
  x: number
  y: number
  width: number
  height: number
  /** Sides that are a cut through the image (not its border): a word touching one may be cut by it. */
  inner: { left: boolean; top: boolean; right: boolean; bottom: boolean }
}

/** Blocks covering a `width`×`height` image. Cells are even, so no sliver of a block is left at the right or bottom. */
export function tileGrid(width: number, height: number, grid: TileGrid = OCR_TILES): OcrTile[] {
  const cols = Math.max(1, Math.ceil(width / grid.stride))
  const rows = Math.max(1, Math.ceil(height / grid.stride))
  const cellWidth = width / cols
  const cellHeight = height / rows
  const half = grid.overlap / 2
  const tiles: OcrTile[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.max(0, Math.floor(col * cellWidth - half))
      const y = Math.max(0, Math.floor(row * cellHeight - half))
      const right = col === cols - 1 ? width : Math.min(width, Math.ceil((col + 1) * cellWidth + half))
      const bottom = row === rows - 1 ? height : Math.min(height, Math.ceil((row + 1) * cellHeight + half))
      tiles.push({
        col,
        row,
        x,
        y,
        width: right - x,
        height: bottom - y,
        inner: { left: x > 0, top: y > 0, right: right < width, bottom: bottom < height }
      })
    }
  }
  return tiles
}

/** What the engine found in one block: word boxes in the ENLARGED block's pixels. */
export interface TileWords {
  tile: OcrTile
  words: OcrWord[]
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * Words on one visual line share a vertical band: grouped top to bottom, then left to right. A gap wider than a few
 * letters (two columns side by side) is kept as wide space instead of gluing the columns into one sentence.
 */
export function groupLines(words: OcrWord[]): OcrLine[] {
  const rows: Array<{ cy: number; height: number; words: OcrWord[] }> = []
  for (const word of [...words].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2))) {
    const cy = word.y + word.height / 2
    let best: (typeof rows)[number] | undefined
    for (const row of rows) {
      const distance = Math.abs(row.cy - cy)
      if (distance <= Math.max(row.height, word.height) / 2 && (!best || distance < Math.abs(best.cy - cy))) best = row
    }
    if (best) {
      best.words.push(word)
      best.cy += (cy - best.cy) / best.words.length
      best.height = Math.max(best.height, word.height)
    } else rows.push({ cy, height: word.height, words: [word] })
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((row) => {
      const ordered = [...row.words].sort((a, b) => a.x - b.x)
      let text = ''
      ordered.forEach((word, index) => {
        if (index) {
          const before = ordered[index - 1]
          text += word.x - (before.x + before.width) > row.height * 2.5 ? '   ' : ' '
        }
        text += word.text
      })
      return { text, words: ordered }
    })
}

/** A word box this close (source pixels) to an inner side of its block may have been cut by it. */
const CUT_MARGIN = 4

/** Share of the smaller box covered by the other: ~1 for the same word read by two overlapping blocks. */
function overlapRatio(a: OcrWord, b: OcrWord): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return (width * height) / Math.max(1, Math.min(a.width * a.height, b.width * b.height))
}

/**
 * Joins the blocks of one image into its lines: every word back in page pixels; a word touching an inner side of its
 * block is dropped (it may be cut there, and the overlap gives the neighbour block the whole word); the same word read
 * by two blocks is kept once, the longer reading. Pure: the block geometry is tested without OCR.
 */
export function mergeTileWords(blocks: TileWords[], scale: number, source = ''): OcrResult {
  const candidates: OcrWord[] = []
  for (const { tile, words: found } of blocks) {
    for (const word of found) {
      const text = word.text.trim()
      if (!text) continue
      const x = tile.x + word.x / scale
      const y = tile.y + word.y / scale
      const width = word.width / scale
      const height = word.height / scale
      const cut =
        (tile.inner.left && x <= tile.x + CUT_MARGIN) ||
        (tile.inner.top && y <= tile.y + CUT_MARGIN) ||
        (tile.inner.right && x + width >= tile.x + tile.width - CUT_MARGIN) ||
        (tile.inner.bottom && y + height >= tile.y + tile.height - CUT_MARGIN)
      if (cut) continue
      candidates.push({ text, x: round2(x), y: round2(y), width: round2(width), height: round2(height) })
    }
  }
  const kept: OcrWord[] = []
  for (const word of candidates.sort((a, b) => b.text.length - a.text.length)) {
    if (!kept.some((other) => overlapRatio(word, other) > 0.5)) kept.push(word)
  }
  const lines = groupLines(kept)
  return { source, text: lines.map((line) => line.text).join('\n'), lines }
}

/** The batch again, with every word and its box: the boxes put each word of a block back on the page. */
const OCR_WORDS_BATCH_SCRIPT = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]',
  'function Await($operation, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(); return $task.Result }',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if (-not $engine) { throw "Windows OCR engine unavailable" }',
  '$paths = @(Get-Content -Encoding UTF8 -LiteralPath $env:OPENCLOD_OCR_LIST | Where-Object { $_.Trim() })',
  'foreach ($item in $paths) {',
  '  $p = [string]$item',
  '  try {',
  '    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])',
  '    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  // Bgra8 explicitly: the engine is documented for Bgra8/Gray8, whatever the PNG stores.
  '    $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '    $words = @($result.Lines | ForEach-Object { $_.Words } | ForEach-Object { [pscustomobject]@{ t=$_.Text; x=[math]::Round($_.BoundingRect.X,1); y=[math]::Round($_.BoundingRect.Y,1); w=[math]::Round($_.BoundingRect.Width,1); h=[math]::Round($_.BoundingRect.Height,1) } })',
  '    [pscustomobject]@{ path=$p; words=$words } | ConvertTo-Json -Compress -Depth 4',
  '    $bitmap.Dispose(); $stream.Dispose()',
  '  } catch { [pscustomobject]@{ path=$p; error=$_.Exception.Message } | ConvertTo-Json -Compress }',
  '}'
].join('\r\n')

/** Words (with boxes) of many images in one PowerShell process. An image the engine could not read has no entry. */
async function ocrWords(files: string[], options: { signal?: AbortSignal } = {}): Promise<Map<string, OcrWord[]>> {
  const byResolved = new Map(files.map((file) => [path.resolve(file).toLowerCase(), file]))
  const found = new Map<string, OcrWord[]>()
  const errors: string[] = []
  if (!files.length) return found
  await runOcrBatch(OCR_WORDS_BATCH_SCRIPT, files, (item) => {
    const key = byResolved.get(String(item.path ?? '').toLowerCase())
    if (!key) return
    if (item.error) {
      if (errors.length < 3) errors.push(String(item.error).slice(0, 200))
      return
    }
    found.set(key, asArray(item.words).flatMap((entry) => {
      const word = entry as Record<string, unknown>
      const text = typeof word.t === 'string' ? word.t.trim() : ''
      return text ? [{ text, x: Number(word.x) || 0, y: Number(word.y) || 0, width: Number(word.w) || 0, height: Number(word.h) || 0 }] : []
    }))
  }, options)
  if (!found.size && errors.length) throw new Error(`OCR falhou: ${errors[0]}`)
  return found
}

/**
 * OCR in blocks. Each image is normalised once (EXIF orientation, transparency over white, sRGB), cut into enlarged
 * blocks with sharp, and every block of every image goes through ONE OCR process (the engine loads once).
 */
export async function ocrImagesTiled(files: string[], options: { signal?: AbortSignal; grid?: TileGrid } = {}): Promise<OcrResult[]> {
  if (!files.length) return []
  const grid = options.grid ?? OCR_TILES
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openclod-ocr-blocos-'))
  try {
    const plans: Array<{ source: string; blocks: Array<{ tile: OcrTile; file: string }> }> = []
    for (const [index, file] of files.entries()) {
      const source = path.resolve(file)
      const { data, info } = await sharp(source, { failOn: 'error' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
      const blocks: Array<{ tile: OcrTile; file: string }> = []
      for (const [n, tile] of tileGrid(info.width, info.height, grid).entries()) {
        if (options.signal?.aborted) throw new Error('OCR cancelado')
        const out = path.join(dir, `${index}-${n}.png`)
        await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
          .extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height })
          .resize(Math.round(tile.width * grid.scale), Math.round(tile.height * grid.scale), { kernel: 'lanczos3' })
          .png()
          .toFile(out)
        blocks.push({ tile, file: out })
      }
      plans.push({ source, blocks })
    }
    const found = await ocrWords(plans.flatMap((plan) => plan.blocks.map((block) => block.file)), options)
    return plans.map((plan) => mergeTileWords(plan.blocks.map((block) => ({ tile: block.tile, words: found.get(block.file) ?? [] })), grid.scale, plan.source))
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Big blocks (a normal page is one, enlarged); the images still empty are read again in fine blocks. */
export async function ocrImagesInBlocks(files: string[], options: { signal?: AbortSignal } = {}): Promise<OcrResult[]> {
  const results = await ocrImagesTiled(files, { ...options, grid: OCR_TILES })
  const empty = results.flatMap((result, index) => (result.text.trim() ? [] : [index]))
  if (empty.length) {
    const fine = await ocrImagesTiled(empty.map((index) => files[index]), { ...options, grid: OCR_TILES_FINE })
    empty.forEach((index, position) => {
      if (fine[position]?.text.trim()) results[index] = fine[position]
    })
  }
  return results
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Scanned PDFs                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Pages of a PDF as PNGs with Windows.Data.Pdf, which ships with Windows: no renderer to install and nothing AGPL
 * (PyMuPDF) in the installer. RenderToStreamAsync is an IAsyncAction, so it needs the non-generic AsTask.
 */
const PDF_RENDER_SCRIPT = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType=WindowsRuntime]',
  '$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()',
  '$asTask = ($methods | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]',
  '$asTaskAction = ($methods | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and -not $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" })[0]',
  'function Await($operation, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(); return $task.Result }',
  'function AwaitAction($action) { $task = $asTaskAction.Invoke($null, @($action)); $task.Wait() }',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:OPENCLOD_PDF)) ([Windows.Storage.StorageFile])',
  '$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])',
  '$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($env:OPENCLOD_PDF_OUT)) ([Windows.Storage.StorageFolder])',
  '$total = [int]$doc.PageCount',
  '[pscustomobject]@{ pages = $total } | ConvertTo-Json -Compress',
  'for ($i = 0; $i -lt [Math]::Min($total, [int]$env:OPENCLOD_PDF_MAX); $i++) {',
  '  $page = $doc.GetPage([uint32]$i)',
  '  try {',
  '    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions',
  '    $options.DestinationWidth = [uint32]$env:OPENCLOD_PDF_WIDTH',
  '    $out = Await ($folder.CreateFileAsync(("page-{0:D4}.png" -f ($i + 1)), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])',
  '    $stream = Await ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '    try { AwaitAction ($page.RenderToStreamAsync($stream, $options)) } finally { $stream.Dispose() }',
  '    [pscustomobject]@{ page = $i + 1; path = $out.Path } | ConvertTo-Json -Compress',
  '  } catch {',
  '    [pscustomobject]@{ page = $i + 1; error = $_.Exception.Message } | ConvertTo-Json -Compress',
  '  } finally { $page.Dispose() }',
  '}'
].join('\r\n')

export interface RenderedPdf {
  /** Pages in the document (more than `images` when `maxPages` cut it). */
  pages: number
  images: Array<{ page: number; path: string }>
  errors: string[]
}

export async function renderPdfPages(
  file: string,
  options: { outDir: string; width?: number; maxPages?: number; signal?: AbortSignal }
): Promise<RenderedPdf> {
  if (process.platform !== 'win32') throw new Error('renderização de PDF disponível apenas no Windows')
  const maxPages = Math.max(1, Math.min(500, Math.round(options.maxPages ?? 40)))
  const width = Math.max(400, Math.min(4_000, Math.round(options.width ?? 1_700)))
  return new Promise((resolve, reject) => {
    const child = spawn(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', PDF_RENDER_SCRIPT], {
      windowsHide: true,
      env: {
        ...process.env,
        OPENCLOD_PDF: path.resolve(file),
        OPENCLOD_PDF_OUT: path.resolve(options.outDir),
        OPENCLOD_PDF_WIDTH: String(width),
        OPENCLOD_PDF_MAX: String(maxPages)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const result: RenderedPdf = { pages: 0, images: [], errors: [] }
    let stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-1_000)
    })
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', (line) => {
      const trimmed = line.trim().replace(/^﻿/, '')
      if (!trimmed.startsWith('{')) return
      try {
        const item = JSON.parse(trimmed) as { pages?: number; page?: number; path?: string; error?: string }
        if (typeof item.pages === 'number') result.pages = item.pages
        else if (item.error) result.errors.push(`página ${item.page}: ${String(item.error).slice(0, 200)}`)
        else if (item.path && item.page) result.images.push({ page: item.page, path: item.path })
      } catch {
        /* a line that is not ours */
      }
    })
    const timer = setTimeout(() => child.kill(), Math.min(15 * 60_000, 60_000 + maxPages * 5_000))
    const onAbort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`renderização do PDF falhou: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (options.signal?.aborted) reject(new Error('leitura cancelada'))
      else if (!result.images.length && code) reject(new Error(`o Windows não abriu este PDF (código ${code})${stderrTail ? ` · ${stderrTail.trim().slice(-400)}` : ''}`))
      else resolve(result)
    })
  })
}

/** Small pictures of the first `count` rendered pages, for the chat (ToolResult.preview). */
async function pagePreviews(images: RenderedPdf['images'], count: number): Promise<ImagePart[]> {
  const out: ImagePart[] = []
  for (const image of images.slice(0, Math.max(0, count))) {
    const preview = await previewImage(image.path, `página ${image.page}`)
    if (preview) out.push(preview)
  }
  return out
}

/**
 * A scanned PDF read with OCR: its pages rendered, then every block of every page through one OCR process.
 * `previews`: how many of the rendered pages to keep as small pictures for the chat, before the folder is removed.
 */
export async function ocrPdf(
  file: string,
  options: { signal?: AbortSignal; maxPages?: number; width?: number; previews?: number } = {}
): Promise<{ pageCount: number; pages: Array<{ number: number; text: string }>; errors: string[]; previews: ImagePart[] }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openclod-pdf-ocr-'))
  try {
    const rendered = await renderPdfPages(file, { outDir: dir, width: options.width, maxPages: options.maxPages, signal: options.signal })
    const results = await ocrImagesInBlocks(rendered.images.map((image) => image.path), { signal: options.signal })
    return {
      pageCount: rendered.pages,
      pages: rendered.images.map((image, index) => ({ number: image.page, text: results[index]?.text ?? '' })),
      errors: rendered.errors,
      previews: await pagePreviews(rendered.images, options.previews ?? 0)
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * The first pages of a PDF that was read from its text layer (so never rendered), as small pictures for the chat.
 * Empty when the OS cannot render PDFs or rendering fails: a preview never fails the reading.
 */
export async function pdfPreviews(file: string, options: { pages?: number; signal?: AbortSignal } = {}): Promise<ImagePart[]> {
  if (process.platform !== 'win32') return []
  const pages = Math.max(1, options.pages ?? 1)
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openclod-pdf-preview-'))
  try {
    const rendered = await renderPdfPages(file, { outDir: dir, width: 1_200, maxPages: pages, signal: options.signal })
    return await pagePreviews(rendered.images, pages)
  } catch {
    return []
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
