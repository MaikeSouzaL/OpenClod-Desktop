import crypto from 'node:crypto'
import fs from 'node:fs'

/** Downloads of the llama.cpp screen (models from Hugging Face, builds from GitHub): checked, resumable, cancellable. */

export const USER_AGENT = 'openclod-desktop'

export class Cancelled extends Error {
  constructor() {
    super('Cancelado.')
  }
}

export interface VerifiedDownload {
  url: string
  dest: string
  bytes: number
  /** Hex SHA-256 the publisher lists; the file is deleted when it does not match. */
  sha256: string
  /** Name for the error messages. */
  label: string
  signal: AbortSignal
  /** Bytes of this file so far. */
  onProgress?(bytes: number): void
  fetch?: typeof fetch
}

/**
 * Downloads `url` to `dest` through `dest.part`, resuming a part left behind (HTTP Range; a server that ignores it starts
 * over), and keeps the file only when size and SHA-256 match. A file already whole at `dest` is not downloaded again.
 */
export async function downloadVerified(job: VerifiedDownload): Promise<void> {
  if (fs.existsSync(job.dest) && fs.statSync(job.dest).size === job.bytes) return
  const part = `${job.dest}.part`
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (start > job.bytes) {
    fs.rmSync(part, { force: true })
    start = 0
  }
  job.onProgress?.(start)
  const headers: Record<string, string> = { 'user-agent': USER_AGENT }
  if (start) headers.range = `bytes=${start}-`
  let response: Response
  try {
    response = await (job.fetch ?? fetch)(job.url, { headers, signal: job.signal })
  } catch (err) {
    if (job.signal.aborted) throw new Cancelled()
    throw new Error(`O download parou (${(err as Error).message}). Clique de novo para continuar de onde parou.`)
  }
  if (!response.ok || !response.body) throw new Error(`O servidor respondeu HTTP ${response.status} para ${job.label}.`)
  // The server ignored the Range: start over.
  const append = start > 0 && response.status === 206
  // What is already in the .part goes into the hash first.
  const digest = append ? await hashFile(part) : crypto.createHash('sha256')
  let got = append ? start : 0
  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      digest.update(value)
      got += value.byteLength
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      job.onProgress?.(got)
    }
  } catch (err) {
    await closeStream(out)
    if (job.signal.aborted) throw new Cancelled()
    throw new Error(`O download parou (${(err as Error).message}). Clique de novo para continuar de onde parou.`)
  }
  await closeStream(out)
  if (fs.statSync(part).size !== job.bytes || digest.digest('hex') !== job.sha256.toLowerCase()) {
    fs.rmSync(part, { force: true })
    throw new Error(`O arquivo ${job.label} veio diferente do publicado (SHA-256 não confere) e foi apagado.`)
  }
  fs.renameSync(part, job.dest)
}

/** Free space where a download goes; null when the system does not say. */
export function freeBytes(folder: string): number | null {
  try {
    const stat = fs.statfsSync(folder)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return null
  }
}

/** Refuses a download that would leave less than 1 GB free. */
export function ensureSpace(folder: string, bytes: number): void {
  const free = freeBytes(folder)
  if (free !== null && bytes + (1 << 30) > free) {
    throw new Error(`Falta espaço no disco: precisa de ${(bytes / 1e9).toFixed(1)} GB e há ${(free / 1e9).toFixed(1)} GB livres.`)
  }
}

async function hashFile(file: string): Promise<crypto.Hash> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer)
  return hash
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()))
}

/** The environment of a helper llama-server run: no inherited `LLAMA_ARG_*` (each one is a hidden flag). */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.toUpperCase().startsWith('LLAMA_ARG_')) env[key] = value
  return env
}
