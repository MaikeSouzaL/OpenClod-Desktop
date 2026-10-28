import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { UpdateAssetInfo, UpdateCheckInfo } from '../shared/api.js'

interface UpdateManifest {
  version: string
  notes?: string
  publishedAt?: string
  platforms?: Record<string, { url?: string; sha256?: string; size?: number }>
}

export async function checkForUpdate(
  currentVersion: string,
  feedUrl: string | undefined,
  options: { platform?: NodeJS.Platform; fetchImpl?: typeof fetch } = {}
): Promise<UpdateCheckInfo> {
  if (!feedUrl?.trim()) return { configured: false, currentVersion, available: false, detail: 'URL de atualização não configurada.' }
  const feed = safeUrl(feedUrl)
  const response = await (options.fetchImpl ?? fetch)(feed, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`servidor de atualização respondeu ${response.status}`)
  const text = await response.text()
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('manifesto de atualização maior que 1 MB')
  let manifest: UpdateManifest
  try { manifest = JSON.parse(text) } catch { throw new Error('manifesto de atualização inválido') }
  if (!isSemver(manifest.version)) throw new Error('versão do manifesto inválida')
  const platform = options.platform ?? process.platform
  const rawAsset = manifest.platforms?.[platform]
  const asset: UpdateAssetInfo | undefined = rawAsset ? {
    url: rawAsset.url ? safeUrl(rawAsset.url) : '',
    sha256: typeof rawAsset.sha256 === 'string' ? rawAsset.sha256.toLowerCase() : '',
    size: Number(rawAsset.size) || 0,
    platform
  } : undefined
  if (rawAsset && (!asset?.url || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.size <= 0)) throw new Error('asset de atualização inválido ou sem SHA-256')
  const available = compareSemver(manifest.version, currentVersion) > 0
  if (available && !asset) throw new Error(`não há pacote para a plataforma ${platform}`)
  return {
    configured: true,
    currentVersion,
    latestVersion: manifest.version,
    available,
    notes: typeof manifest.notes === 'string' ? manifest.notes.slice(0, 20_000) : undefined,
    publishedAt: typeof manifest.publishedAt === 'string' ? manifest.publishedAt : undefined,
    asset,
    detail: available ? `Versão ${manifest.version} disponível.` : `Você já está na versão ${currentVersion}.`
  }
}

export async function downloadUpdate(
  asset: UpdateAssetInfo,
  destination: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<{ path: string; bytes: number; sha256: string }> {
  const url = safeUrl(asset.url)
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || asset.size <= 0 || asset.size > 2 * 1024 * 1024 * 1024) throw new Error('metadata do pacote inválida')
  const response = await (options.fetchImpl ?? fetch)(url, { signal: options.signal ?? AbortSignal.timeout(15 * 60_000) })
  if (!response.ok) throw new Error(`download respondeu ${response.status}`)
  const length = Number(response.headers.get('content-length') || 0)
  if (length && length > asset.size) throw new Error('tamanho remoto maior que o declarado')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== asset.size) throw new Error(`tamanho do download não confere: ${bytes.length}/${asset.size}`)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== asset.sha256) throw new Error('SHA-256 do pacote não confere')
  const target = path.resolve(destination)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.download`
  await fs.promises.writeFile(temp, bytes)
  await fs.promises.rename(temp, target).catch(async (error) => {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw error
  })
  return { path: target, bytes: bytes.length, sha256 }
}

function safeUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('URL inválida') }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('atualizações exigem HTTPS (HTTP apenas em localhost)')
  url.username = ''
  url.password = ''
  return url.toString()
}

function isSemver(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) }
export function compareSemver(a: string, b: string): number {
  if (!isSemver(a) || !isSemver(b)) throw new Error('versão inválida')
  const [ac, bc] = [a.split('-')[0].split('.').map(Number), b.split('-')[0].split('.').map(Number)]
  for (let index = 0; index < 3; index++) if (ac[index] !== bc[index]) return ac[index] - bc[index]
  if (!a.includes('-') && b.includes('-')) return 1
  if (a.includes('-') && !b.includes('-')) return -1
  return a.localeCompare(b)
}
