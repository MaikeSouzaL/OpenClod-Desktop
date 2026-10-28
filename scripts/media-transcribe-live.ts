import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { transcribeMedia } from '../src/core/media/transcribe.js'

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..')
  const out = path.join(root, 'Prints', 'media-transcribe-2026-10-25')
  fs.mkdirSync(out, { recursive: true })
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openclod-transcribe-live-'))
  const wav = path.join(temp, 'openclod-recado.wav')
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const speechScript = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.SetOutputToWaveFile($env:OPENCLOD_WAV)',
    '$s.Speak("Openclod, a memoria do projeto usa um grafo inteligente e todos os testes passaram.")',
    '$s.Dispose()'
  ].join('\r\n')

  await new Promise<void>((resolve, reject) => {
    execFile(powerShell, ['-NoProfile', '-NonInteractive', '-Command', speechScript], {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, OPENCLOD_WAV: wav }
    }, (error) => error ? reject(error) : resolve())
  })
  const started = Date.now()
  const result = await transcribeMedia(wav, { model: 'base', language: 'pt', timeoutMs: 5 * 60_000 })
  const elapsedMs = Date.now() - started
  const savedWav = path.join(out, 'openclod-recado.wav')
  await fs.promises.copyFile(wav, savedWav)
  await fs.promises.rm(temp, { recursive: true, force: true })
  if (!result.text.trim() || !result.segments.length) throw new Error('Whisper returned an empty transcript')
  const evidence = {
    ok: true,
    source: savedWav,
    text: result.text,
    language: result.language,
    languageProbability: result.languageProbability,
    duration: result.duration,
    segments: result.segments,
    device: result.device,
    computeType: result.computeType,
    elapsedMs,
    note: 'WAV generated locally by Windows System.Speech and transcribed offline by the bundled faster-whisper runtime.'
  }
  await fs.promises.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
