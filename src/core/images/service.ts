import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const MAX_INPUT_BYTES = 100 * 1024 * 1024
const MAX_GENERATED_BYTES = 50 * 1024 * 1024

export interface ImageInfo {
  path: string
  width: number
  height: number
  format?: string
  channels?: number
  hasAlpha: boolean
  size: number
  space?: string
  orientation?: number
}

export interface ImageEditOptions {
  input: string
  output: string
  width?: number
  height?: number
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  background?: string
  crop?: { left: number; top: number; width: number; height: number }
  rotate?: number
  flip?: boolean
  flop?: boolean
  grayscale?: boolean
  format?: 'png' | 'jpeg' | 'webp'
  quality?: number
}

export interface ImageGenerationOptions {
  prompt: string
  output: string
  width?: number
  height?: number
  model?: string
  signal?: AbortSignal
}

export async function inspectImage(file: string): Promise<ImageInfo> {
  const resolved = path.resolve(file)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('imagem não é um arquivo')
  if (stat.size > MAX_INPUT_BYTES) throw new Error('imagem maior que 100 MB')
  const metadata = await sharp(resolved, { failOn: 'error' }).metadata()
  if (!metadata.width || !metadata.height) throw new Error('dimensões da imagem não puderam ser lidas')
  return {
    path: resolved,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    channels: metadata.channels,
    hasAlpha: Boolean(metadata.hasAlpha),
    size: stat.size,
    space: metadata.space,
    orientation: metadata.orientation
  }
}

export async function editImage(options: ImageEditOptions): Promise<ImageInfo> {
  const input = path.resolve(options.input)
  const output = path.resolve(options.output)
  if (input === output) throw new Error('a saída deve ser um arquivo diferente; o original é preservado')
  const source = await inspectImage(input)
  let image = sharp(input, { failOn: 'error' }).rotate()
  if (options.crop) {
    const crop = options.crop
    if ([crop.left, crop.top, crop.width, crop.height].some((value) => !Number.isFinite(value) || value < 0)) throw new Error('recorte inválido')
    if (crop.left + crop.width > source.width || crop.top + crop.height > source.height) throw new Error('recorte maior que a imagem')
    image = image.extract({ left: Math.round(crop.left), top: Math.round(crop.top), width: Math.round(crop.width), height: Math.round(crop.height) })
  }
  if (options.width || options.height) {
    image = image.resize({
      width: options.width ? Math.max(1, Math.min(16_384, Math.round(options.width))) : undefined,
      height: options.height ? Math.max(1, Math.min(16_384, Math.round(options.height))) : undefined,
      fit: options.fit ?? 'cover',
      background: options.background ?? '#00000000'
    })
  }
  if (options.rotate) image = image.rotate(options.rotate, { background: options.background ?? '#00000000' })
  if (options.flip) image = image.flip()
  if (options.flop) image = image.flop()
  if (options.grayscale) image = image.grayscale()
  const format = options.format ?? outputFormat(output)
  const quality = Math.max(1, Math.min(100, Math.round(options.quality ?? 90)))
  if (format === 'png') image = image.png({ compressionLevel: 9 })
  else if (format === 'jpeg') image = image.flatten({ background: options.background ?? '#ffffff' }).jpeg({ quality, mozjpeg: true })
  else image = image.webp({ quality, alphaQuality: quality })
  await fs.promises.mkdir(path.dirname(output), { recursive: true })
  const temp = `${output}.${process.pid}.${Date.now()}.tmp`
  try {
    await image.toFile(temp)
    await fs.promises.rename(temp, output)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  return inspectImage(output)
}

/** Optional OpenAI-compatible `/images/generations` endpoint. */
export async function generateImage(options: ImageGenerationOptions): Promise<ImageInfo> {
  const baseUrl = (process.env.OPENCLOD_IMAGE_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('OPENCLOD_IMAGE_BASE_URL não configurada; a geração externa está indisponível')
  if (!options.prompt.trim()) throw new Error('prompt vazio')
  const model = (options.model || process.env.OPENCLOD_IMAGE_MODEL || 'gpt-image-1').trim()
  const width = Math.max(64, Math.min(4096, Math.round(options.width ?? 1024)))
  const height = Math.max(64, Math.min(4096, Math.round(options.height ?? 1024)))
  const endpoint = /\/images\/generations$/.test(baseUrl) ? baseUrl : `${baseUrl}/images/generations`
  const apiKey = process.env.OPENCLOD_IMAGE_API_KEY || ''
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ model, prompt: options.prompt.slice(0, 20_000), size: `${width}x${height}`, n: 1, response_format: 'b64_json' }),
    signal: options.signal ?? AbortSignal.timeout(180_000)
  })
  if (!response.ok) throw new Error(`geração falhou (${response.status}): ${(await response.text().catch(() => '')).slice(0, 500)}`)
  const body = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> }
  const first = body.data?.[0]
  if (!first) throw new Error('provedor não retornou imagem')
  let bytes: Buffer
  if (first.b64_json) {
    bytes = Buffer.from(first.b64_json, 'base64')
  } else if (first.url && /^https?:\/\//i.test(first.url)) {
    const download = await fetch(first.url, { signal: AbortSignal.timeout(60_000) })
    if (!download.ok) throw new Error(`download da imagem falhou (${download.status})`)
    bytes = Buffer.from(await download.arrayBuffer())
  } else {
    throw new Error('resposta do provedor sem b64_json ou URL')
  }
  if (!bytes.length || bytes.length > MAX_GENERATED_BYTES) throw new Error('imagem gerada vazia ou maior que 50 MB')
  const output = path.resolve(options.output)
  await fs.promises.mkdir(path.dirname(output), { recursive: true })
  const temp = `${output}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(temp, bytes)
  try {
    const info = await inspectImage(temp)
    await fs.promises.rename(temp, output)
    return { ...info, path: output }
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function outputFormat(file: string): 'png' | 'jpeg' | 'webp' {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg'
  if (ext === '.webp') return 'webp'
  return 'png'
}
