import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ocrImage } from '../src/core/media/ocr.js'

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..')
  const out = path.join(root, 'Prints', 'ocr-2026-10-25')
  fs.mkdirSync(out, { recursive: true })
  const image = path.join(out, 'openclod-ocr.png')
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 900,220',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$font = New-Object System.Drawing.Font("Segoe UI",28)',
    '$g.DrawString("Openclod memoria inteligente 2026",$font,[System.Drawing.Brushes]::Black,25,70)',
    '$bmp.Save($env:OPENCLOD_OCR_IMAGE,[System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose()',
    '$bmp.Dispose()'
  ].join('\r\n')
  execFileSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, OPENCLOD_OCR_IMAGE: image }
  })
  const result = await ocrImage(image)
  if (!/Openclod.*inteligente.*2026/i.test(result.text)) throw new Error(`unexpected OCR text: ${result.text}`)
  const evidence = { ok: true, image, text: result.text, lines: result.lines }
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
