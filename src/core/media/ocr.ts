import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

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

export function parseOcrOutput(raw: string, source = ''): OcrResult {
  try {
    const parsed = JSON.parse(raw.trim() || '{}') as { text?: unknown; lines?: unknown }
    const lines = Array.isArray(parsed.lines) ? parsed.lines.flatMap((item) => {
      const line = item as Record<string, unknown>
      const text = typeof line.text === 'string' ? line.text.trim() : ''
      const words = Array.isArray(line.words) ? line.words.flatMap((entry) => {
        const word = entry as Record<string, unknown>
        const value = typeof word.text === 'string' ? word.text.trim() : ''
        return value ? [{ text: value, x: Number(word.x) || 0, y: Number(word.y) || 0, width: Number(word.width) || 0, height: Number(word.height) || 0 }] : []
      }) : []
      return text || words.length ? [{ text: text || words.map((word) => word.text).join(' '), words }] : []
    }) : []
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

export async function ocrImages(
  files: string[],
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<OcrBatchResult> {
  const empty: OcrBatchResult = { text: new Map(), failed: 0, errors: [] }
  if (!files.length) return empty
  if (process.platform !== 'win32') throw new Error('OCR nativo disponível apenas no Windows')
  const list = path.join(os.tmpdir(), `openclod-ocr-${process.pid}-${Date.now().toString(36)}.json`)
  await fs.promises.writeFile(list, files.map((file) => path.resolve(file)).join('\r\n'), 'utf8')
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const byResolved = new Map(files.map((file) => [path.resolve(file).toLowerCase(), file]))
  try {
    return await new Promise<OcrBatchResult>((resolve, reject) => {
      const child = spawn(powerShell, ['-NoProfile', '-NonInteractive', '-Command', OCR_BATCH_SCRIPT], {
        windowsHide: true,
        env: { ...process.env, OPENCLOD_OCR_LIST: list },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const text = new Map<string, string[]>()
      const errors: string[] = []
      let failed = 0
      let done = 0
      let stderrTail = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-1_000)
      })
      const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      reader.on('line', (line) => {
        const trimmed = line.trim().replace(/^\uFEFF/, '')
        if (!trimmed.startsWith('{')) return
        try {
          const item = JSON.parse(trimmed) as { path?: string; lines?: unknown; error?: string }
          const key = byResolved.get(String(item.path ?? '').toLowerCase()) ?? String(item.path ?? '')
          done++
          if (item.error) {
            failed++
            if (errors.length < 3) errors.push(`${path.basename(String(item.path ?? ''))}: ${String(item.error).slice(0, 200)}`)
          } else text.set(key, (Array.isArray(item.lines) ? item.lines : typeof item.lines === 'string' ? [item.lines] : []).map((value) => String(value).trim()).filter(Boolean))
          options.onProgress?.(done, files.length)
        } catch {
          /* a line that is not ours */
        }
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
        if (!done && code) reject(new Error(`OCR falhou (código ${code})${stderrTail ? ` · ${stderrTail.trim().slice(-500)}` : ''}`))
        else resolve({ text, failed, errors })
      })
    })
  } finally {
    await fs.promises.rm(list, { force: true }).catch(() => undefined)
  }
}

export async function ocrImage(file: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OcrResult> {
  if (process.platform !== 'win32') throw new Error('OCR nativo disponível apenas no Windows')
  const resolved = path.resolve(file)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('imagem não é um arquivo')
  if (stat.size > 50 * 1024 * 1024) throw new Error('imagem maior que 50 MB para OCR')
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(powerShell, ['-NoProfile', '-NonInteractive', '-Command', OCR_SCRIPT], {
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
