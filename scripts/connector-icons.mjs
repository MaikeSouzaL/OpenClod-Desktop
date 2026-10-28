#!/usr/bin/env node
// Coleta, em TEMPO DE DESENVOLVIMENTO, o logo de cada conector do diretório e o empacota no app.
// O app nunca busca logo na internet: tudo o que a tela mostra está em src/renderer/public/connector-icons/.
//
//   node scripts/connector-icons.mjs                 coleta tudo (usa o cache em disco; só pede o que falta)
//   node scripts/connector-icons.mjs --refresh       ignora o cache e pede tudo de novo
//   node scripts/connector-icons.mjs --offline       só usa o cache (nenhum pedido de rede)
//   node scripts/connector-icons.mjs --only a,b      refaz só esses ids (os outros ficam como estão)
//   node scripts/connector-icons.mjs --no-write      não grava nada: só mostra o resumo
//   node scripts/connector-icons.mjs --report-only   reescreve só o relatório, a partir do manifesto (sem rede)
//   opções: --cache <pasta>  --concurrency <n>
//
// Fontes, da melhor para a pior (a nota de cada candidata decide, ver scoreCandidate em lib/connector-icons-core.mjs):
//  1. diretório: o `iconUrl` que o próprio diretório do Claude usa para o conector (scripts/data/mcp-directory-harvest.jsonl);
//  2. simple-icons: o glifo oficial da marca (CC0) num ladrilho na cor da marca;
//  3. site: o ícone que o site do fornecedor declara (apple-touch-icon, <link rel="icon">, manifesto web);
//  4. serviço de favicons (Google, DuckDuckGo): só na COLETA, último recurso.
// O resultado vai para:
//  - src/renderer/public/connector-icons/*.webp|svg    as imagens (128x128, ladrilho já com o fundo certo)
//  - src/renderer/src/lib/connector-icon-index.ts       id/domínio/marca → arquivo (o app lê só isto)
//  - docs/mcp/icones-conectores.json                    a origem de CADA imagem (arquivo, fonte, endereço, domínio)
//  - docs/mcp/ICONES-CONECTORES.md                      relatório de cobertura
// Conteúdo de sites, SVG e respostas de rede é dado não confiável: tamanho limitado, magic bytes conferidos, SVG
// limpo antes de rasterizar e só WebP novo (ou um SVG escrito por este script) vai para o app.
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  GOOD_ENOUGH,
  LOGO_PADDING,
  MIN_SIDE,
  TILE_SIZE,
  analyzeRaster,
  baseFileName,
  brandLabelOf,
  buildBrandIndex,
  buildIndex,
  conventionalIconUrls,
  decodeIco,
  glyphTileSvg,
  isFetchableUrl,
  isPrivateAddress,
  isSafeSvgAsset,
  looksLikeImageUrl,
  matchSimpleIcon,
  normalizeDomain,
  parseHtmlIcons,
  parseManifestIcons,
  renderIndexModule,
  sanitizeSvg,
  scoreCandidate,
  upgradeFaviconServiceUrl
} from './lib/connector-icons-core.mjs'
import { registrableDomain } from './lib/mcp-directory-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRECTORY_FILE = path.join(ROOT, 'resources', 'mcp-directory.json')
const HARVEST_FILE = path.join(ROOT, 'scripts', 'data', 'mcp-directory-harvest.jsonl')
const OVERRIDES_FILE = path.join(ROOT, 'scripts', 'data', 'connector-icons-overrides.json')
const ICONS_DIR = path.join(ROOT, 'src', 'renderer', 'public', 'connector-icons')
const INDEX_FILE = path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'connector-icon-index.ts')
const MANIFEST_FILE = path.join(ROOT, 'docs', 'mcp', 'icones-conectores.json')
const REPORT_FILE = path.join(ROOT, 'docs', 'mcp', 'ICONES-CONECTORES.md')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback
}
const REFRESH = flag('refresh')
const OFFLINE = flag('offline')
const NO_WRITE = flag('no-write')
const ONLY = new Set((option('only', '') || '').split(',').map((item) => item.trim()).filter(Boolean))
const CACHE_DIR = path.resolve(option('cache', path.join(os.tmpdir(), 'openclod-connector-icons-cache')))
const CONCURRENCY = Math.max(1, Math.min(32, Number(option('concurrency', '10')) || 10))

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OpenclodIconCollector/1.0'
const MAX_IMAGE_BYTES = 3_000_000
const MAX_HTML_BYTES = 300_000
const MAX_JSON_BYTES = 300_000
const TIMEOUT_MS = 12_000
const WORK_SIDE = 512

const log = (message) => process.stderr.write(`${message}\n`)

/* ------------------------------------------------------------------------------------------------ dados */

const require = createRequire(import.meta.url)
const directory = JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8')).entries
const harvest = new Map()
for (const line of fs.readFileSync(HARVEST_FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const row = JSON.parse(line)
  harvest.set(row.u, row)
}
const overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'))

const simpleIconsDir = path.dirname(require.resolve('simple-icons'))
const simpleIconsMeta = JSON.parse(fs.readFileSync(path.join(simpleIconsDir, 'package.json'), 'utf8'))
const simpleIconsData = JSON.parse(fs.readFileSync(path.join(simpleIconsDir, 'data', 'simple-icons.json'), 'utf8'))
const brandIndex = buildBrandIndex(simpleIconsData)
const simpleBySlug = new Map(simpleIconsData.map((icon) => [icon.slug, icon]))

/** O caminho (`d`) do único <path> do SVG do pacote. */
function simpleIconPath(slug) {
  const svg = fs.readFileSync(path.join(simpleIconsDir, 'icons', `${slug}.svg`), 'utf8')
  const d = svg.match(/<path\s+d="([^"]+)"/)?.[1]
  if (!d) throw new Error(`simple-icons/${slug}: sem <path d>`)
  return d
}

function simpleIconTile(slug) {
  const icon = simpleBySlug.get(slug)
  if (!icon) throw new Error(`simple-icons não tem o ícone "${slug}"`)
  return { icon, svg: glyphTileSvg({ path: simpleIconPath(slug), hex: icon.hex }) }
}

/* -------------------------------------------------------------------------------------------- domínios */

/** Domínios que não dizem nada sobre a marca do conector (hospedagem de código, CDNs, o próprio Claude). */
const NOT_A_BRAND = new Set([
  'github.com', 'gitlab.com', 'npmjs.com', 'pypi.org', 'claude.com', 'claude.ai', 'anthropic.com', 'modelcontextprotocol.io',
  'googleapis.com', 'google.com', 'gstatic.com', 'am-static.com', 'sanity.io', 'githubusercontent.com', 'website-files.com'
])

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Serviços de favicons do Google: o domínio verdadeiro vem no parâmetro `domain=` / `url=`. */
function domainFromFaviconService(raw) {
  try {
    const url = new URL(raw)
    if (!/(^|\.)(google|gstatic)\.com$/i.test(url.hostname)) return ''
    const value = url.searchParams.get('domain') || url.searchParams.get('url') || ''
    return normalizeDomain(value.includes('://') ? value : `https://${value}`)
  } catch {
    return ''
  }
}

/**
 * O domínio a usar para procurar o site/ícone de uma entrada, ou '' quando não há um confiável. O `iconDomain` do
 * diretório às vezes vem do host de uma CDN (sanity.io, github.com): só vale se bater com o host do endpoint MCP, com
 * o site que o diretório indica ou com o nome da marca.
 */
function trustedDomain(entry, iconUrl) {
  const forced = normalizeDomain(overrides.entries?.[entry.id]?.domain ?? '')
  if (forced) return forced
  const fromService = iconUrl ? domainFromFaviconService(iconUrl) : ''
  const endpointHost = entry.url ? hostOf(entry.url) : ''
  const fromEndpoint = endpointHost && !/^[\d.]+$/.test(endpointHost) ? registrableDomain(endpointHost) : ''
  const iconHost = iconUrl && !looksLikeImageUrl(iconUrl) ? hostOf(iconUrl) : ''
  const fromSite = iconHost ? registrableDomain(iconHost) : ''
  const declared = normalizeDomain(entry.iconDomain ?? '')
  const brandWords = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  // A marca pode ser o subdomínio (firebase.google.com): o nome começa pelo primeiro rótulo do host.
  const hostLabel = declared ? brandWords(declared.split('.')[0]) : ''
  const nameMatches = declared
    ? brandWords(entry.name).includes(brandLabelOf(declared)) || brandWords(entry.id).startsWith(brandLabelOf(declared)) || (hostLabel.length > 3 && brandWords(entry.name).startsWith(hostLabel))
    : false
  // Um domínio "de plataforma" (github.com, claude.com, sanity.io...) só vale para a marca que leva esse nome.
  const generic = (domain) => NOT_A_BRAND.has(domain) && !(brandWords(entry.id).startsWith(brandLabelOf(domain)) || brandWords(entry.name).startsWith(brandLabelOf(domain)))
  const candidates = [fromService, declared && (declared === fromEndpoint || declared === fromSite || nameMatches) ? declared : '', fromEndpoint, fromSite]
  for (const domain of candidates) if (domain && domain.includes('.') && !generic(domain)) return domain
  return ''
}

/* -------------------------------------------------------------------------------------------------- rede */

class Gate {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.waiting = []
  }
  async run(task) {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
const globalGate = new Gate(CONCURRENCY)
const hostGates = new Map()
const hostGate = (host) => {
  if (!hostGates.has(host)) hostGates.set(host, new Gate(2))
  return hostGates.get(host)
}
const dnsVerdicts = new Map()
/** Host que já falhou na rede (tempo esgotado, DNS, TLS, conexão recusada) nesta execução: não vale insistir. */
const deadHosts = new Map()

async function assertPublicHost(host) {
  const bare = host.replace(/^\[|\]$/g, '')
  if (!dnsVerdicts.has(bare)) {
    dnsVerdicts.set(
      bare,
      (async () => {
        if (/^[\d.]+$/.test(bare) || bare.includes(':')) return !isPrivateAddress(bare)
        const found = await dns.lookup(bare, { all: true })
        return found.length > 0 && found.every((item) => !isPrivateAddress(item.address))
      })().catch(() => false)
    )
  }
  if (!(await dnsVerdicts.get(bare))) throw new Error('host-recusado')
}

/** Lê o corpo até `maxBytes`. Passou do limite: `null` (imagem grande demais) ou, com `truncate`, só o começo (o <head> de uma página). */
async function readLimited(response, maxBytes, truncate = false) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    chunks.push(value)
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return truncate ? Buffer.concat(chunks).subarray(0, maxBytes) : null
    }
  }
  return Buffer.concat(chunks)
}

/** Um GET com redirecionamentos conferidos um a um (só http/https, nunca endereço interno) e corpo limitado. */
async function httpGet(rawUrl, { accept, maxBytes, truncate = false }) {
  let url = rawUrl
  for (let hop = 0; hop <= 5; hop++) {
    if (!isFetchableUrl(url)) return { ok: false, error: 'url-recusada' }
    const host = new URL(url).hostname
    const siteKey = `${new URL(url).protocol}//${host}`
    if (deadHosts.has(siteKey)) return { ok: false, error: `host-indisponivel (${deadHosts.get(siteKey)})`, network: true }
    try {
      await assertPublicHost(host)
    } catch {
      deadHosts.set(siteKey, 'dns-ou-endereco-interno')
      return { ok: false, error: 'host-recusado', network: true }
    }
    let response
    let body = null
    try {
      const outcome = await hostGate(host).run(async () => {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-US,en;q=0.8' } })
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          await res.body?.cancel().catch(() => undefined)
          return { res, body: null }
        }
        return { res, body: await readLimited(res, maxBytes, truncate) }
      })
      response = outcome.res
      body = outcome.body
    } catch (error) {
      const code = error?.cause?.code || error?.name || 'erro-de-rede'
      deadHosts.set(siteKey, String(code))
      return { ok: false, error: String(code), network: true }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) return { ok: false, error: 'redirecionamento-sem-destino', status: response.status }
      try {
        url = new URL(location, url).href
      } catch {
        return { ok: false, error: 'redirecionamento-invalido', status: response.status }
      }
      continue
    }
    if (body === null) return { ok: false, error: 'grande-demais', status: response.status }
    return { ok: response.status >= 200 && response.status < 300, status: response.status, url, contentType: response.headers.get('content-type') ?? '', body }
  }
  return { ok: false, error: 'redirecionamentos-demais' }
}

fs.mkdirSync(CACHE_DIR, { recursive: true })
const stats = { network: 0, cached: 0 }

/** `httpGet` com cache em disco. Só guarda respostas HTTP (inclusive 404); falha de rede não vira cache. */
async function cachedGet(rawUrl, { accept, maxBytes, truncate = false }) {
  if (/^data:/i.test(rawUrl)) {
    const match = rawUrl.match(/^data:([^;,]+);base64,(.*)$/is)
    if (!match) return { ok: false, error: 'data-url-invalida' }
    return { ok: true, status: 200, url: rawUrl, contentType: match[1], body: Buffer.from(match[2].replace(/\s+/g, ''), 'base64') }
  }
  const key = crypto.createHash('sha1').update(rawUrl).digest('hex')
  const metaFile = path.join(CACHE_DIR, `${key}.json`)
  const binFile = path.join(CACHE_DIR, `${key}.bin`)
  if (!REFRESH && fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      stats.cached++
      return { ...meta, body: fs.existsSync(binFile) ? fs.readFileSync(binFile) : Buffer.alloc(0) }
    } catch {
      /* cache corrompido: pede de novo */
    }
  }
  if (OFFLINE) return { ok: false, error: 'offline' }
  stats.network++
  const result = await globalGate.run(() => httpGet(rawUrl, { accept, maxBytes, truncate }))
  if (!result.network && result.body) {
    const { body, ...meta } = result
    fs.writeFileSync(binFile, body)
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, cachedAt: Date.now() }))
  } else if (!result.network && result.status) {
    fs.writeFileSync(metaFile, JSON.stringify({ ok: false, status: result.status, error: result.error, url: result.url, cachedAt: Date.now() }))
  }
  return result
}

const IMAGE_ACCEPT = 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5'
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'

/* ------------------------------------------------------------------------------------------------ imagens */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function sniff(buffer) {
  const head = buffer.subarray(0, 16)
  if (head.subarray(0, 4).equals(PNG)) return 'png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (head[0] === 0 && head[1] === 0 && (head[2] === 1 || head[2] === 2) && head[3] === 0) return 'ico'
  if (head.subarray(4, 12).toString('latin1').startsWith('ftypavif')) return 'avif'
  const text = buffer.subarray(0, 2048).toString('utf8')
  if (/<svg[\s>]/i.test(text)) return 'svg'
  return ''
}

/** Decodifica qualquer imagem aceita em RGBA (no máximo 512 px de lado) + tamanho de origem. Lança se não servir. */
async function decodeImage(buffer) {
  const format = sniff(buffer)
  if (!format) throw new Error('não é uma imagem (HTML, texto ou formato desconhecido)')
  const limits = { failOn: 'none', limitInputPixels: 80_000_000 }
  let input = buffer
  let raw = null
  let vector = false
  if (format === 'ico') {
    const decoded = decodeIco(buffer)
    if (decoded.format === 'png') input = decoded.data
    else raw = decoded
  } else if (format === 'svg') {
    const clean = sanitizeSvg(buffer.toString('utf8'))
    if (!clean) throw new Error('SVG recusado pela limpeza')
    const probe = await sharp(Buffer.from(clean)).metadata()
    if (!probe.width || !probe.height) throw new Error('SVG sem tamanho')
    const density = Math.min(1200, Math.max(72, Math.round((72 * WORK_SIDE) / Math.max(probe.width, probe.height))))
    input = Buffer.from(clean)
    limits.density = density
    vector = true
  }
  let image = raw ? sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }) : sharp(input, limits)
  const meta = raw ? { width: raw.width, height: raw.height } : await image.metadata()
  if (!meta.width || !meta.height || meta.width > 12_000 || meta.height > 12_000) throw new Error('dimensões inválidas')
  image = image.ensureAlpha().resize({ width: WORK_SIDE, height: WORK_SIDE, fit: 'inside', withoutEnlargement: !vector, kernel: 'lanczos3' })
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  return { format, vector, srcWidth: meta.width, srcHeight: meta.height, work: { data, width: info.width, height: info.height } }
}

function webpOf(pipeline) {
  return pipeline.webp({ lossless: true, effort: 5 }).toBuffer()
}

/** A cor do canto superior esquerdo (quase sempre o fundo da imagem). */
function cornerColour(work) {
  const hex = (value) => value.toString(16).padStart(2, '0')
  return `#${hex(work.data[0])}${hex(work.data[1])}${hex(work.data[2])}`
}

/** O ladrilho 128x128 (WebP, sempre opaco) de uma imagem decodificada, e o plano usado. */
async function composeTile(decoded) {
  const { work } = decoded
  const plan = analyzeRaster(work.data, work.width, work.height)
  const raw = { raw: { width: work.width, height: work.height, channels: 4 } }
  let tile
  if (plan.mode === 'bleed') {
    const around = plan.flatten ?? cornerColour(work)
    const ratio = Math.max(work.width, work.height) / Math.min(work.width, work.height)
    const flat = sharp(work.data, raw).flatten({ background: around })
    tile = await webpOf(
      ratio <= 1.2
        ? flat.resize(TILE_SIZE, TILE_SIZE, { fit: 'cover', kernel: 'lanczos3' })
        : flat.resize(TILE_SIZE, TILE_SIZE, { fit: 'contain', kernel: 'lanczos3', background: around })
    )
  } else {
    const inner = Math.round(TILE_SIZE * (1 - 2 * LOGO_PADDING))
    const figure = await sharp(work.data, raw)
      .extract(plan.crop)
      .resize(inner, inner, { fit: 'inside', kernel: 'lanczos3' })
      .png()
      .toBuffer()
    const meta = await sharp(figure).metadata()
    tile = await webpOf(
      sharp({ create: { width: TILE_SIZE, height: TILE_SIZE, channels: 4, background: plan.backdrop } }).composite([
        { input: figure, left: Math.round((TILE_SIZE - meta.width) / 2), top: Math.round((TILE_SIZE - meta.height) / 2) }
      ])
    )
  }
  // Figuras com gradientes/fotos ficam menores em WebP com perda; logos chapados, em WebP sem perda.
  if (tile.length > 16_000) {
    const lossy = await sharp(tile).webp({ quality: 88, effort: 5 }).toBuffer()
    if (lossy.length < tile.length) tile = lossy
  }
  const effective = plan.mode === 'logo' ? Math.max(plan.crop.width, plan.crop.height) * (decoded.srcWidth / work.width) : Math.max(decoded.srcWidth, decoded.srcHeight)
  return { plan, tile, ext: 'webp', effective: Math.round(effective) }
}

/* ------------------------------------------------------------------------------------------- candidatas */

/**
 * Uma candidata a partir de um endereço de imagem. `via` descreve de onde veio (para o relatório); `kind` é
 * `apple`/`icon`; `maskable` = ícone de manifesto com margem de segurança.
 */
async function imageCandidate({ url, source, via, kind = 'icon', maskable = false }) {
  const fetchUrl = upgradeFaviconServiceUrl(url)
  const response = await cachedGet(fetchUrl, { accept: IMAGE_ACCEPT, maxBytes: MAX_IMAGE_BYTES })
  if (!response.ok || !response.body?.length) return { fail: `${via}: ${response.error ?? `HTTP ${response.status ?? '?'}`}` }
  let decoded
  try {
    decoded = await decodeImage(response.body)
  } catch (error) {
    return { fail: `${via}: ${error.message}` }
  }
  if (!decoded.vector && Math.max(decoded.srcWidth, decoded.srcHeight) < MIN_SIDE) return { fail: `${via}: imagem pequena demais (${decoded.srcWidth}x${decoded.srcHeight})` }
  let composed
  try {
    composed = await composeTile(decoded)
  } catch (error) {
    return { fail: `${via}: ${error.message}` }
  }
  // Proporção da figura que ficou no ladrilho (o recorte, quando houve) e lado útil: um wordmark largo vira miniatura.
  const figure = composed.plan.mode === 'logo' ? composed.plan.crop : { width: decoded.srcWidth, height: decoded.srcHeight }
  const ratio = Math.max(figure.width, figure.height) / Math.max(1, Math.min(figure.width, figure.height))
  const side = decoded.vector ? 100 * ratio : Math.max(composed.effective, MIN_SIDE)
  const score = scoreCandidate({ source, width: side, height: side / ratio, vector: decoded.vector, kind, maskable })
  if (score === null) return { fail: `${via}: imagem pequena demais (${decoded.srcWidth}x${decoded.srcHeight})` }
  return {
    candidate: {
      source,
      via,
      score,
      sourceUrl: /^data:/i.test(url) ? 'data-uri' : fetchUrl,
      srcSize: decoded.vector ? 'svg' : `${decoded.srcWidth}x${decoded.srcHeight}`,
      mode: composed.plan.mode,
      reason: composed.plan.reason,
      ext: composed.ext,
      bytes: composed.tile
    }
  }
}

function simpleIconCandidate(slug, { confidence, via }) {
  const { icon, svg } = simpleIconTile(slug)
  if (!isSafeSvgAsset(svg)) throw new Error(`ladrilho inseguro: ${slug}`)
  const score = scoreCandidate({ source: 'simple-icons' }) + (confidence === 'high' ? 6 : -12)
  return {
    source: 'simple-icons',
    via,
    score,
    sourceUrl: `https://simpleicons.org/?q=${slug}`,
    srcSize: 'svg',
    mode: 'glyph',
    reason: 'glifo-na-cor-da-marca',
    ext: 'svg',
    bytes: Buffer.from(svg),
    license: icon.license?.type ?? 'CC0-1.0 (coleção)',
    brandTitle: icon.title
  }
}

function rankLinks(links) {
  const weight = (link) => (link.type === 'image/svg+xml' ? 1000 : 0) + (link.kind === 'apple' ? 120 : 0) + link.size - (link.maskable ? 200 : 0) - (link.type === 'image/x-icon' || /\.ico(\?|$)/i.test(link.url) ? 150 : 0)
  return [...links].sort((a, b) => weight(b) - weight(a))
}

/** Candidatas do site de um domínio: o que a página declara (e o manifesto), ou os endereços de costume. */
async function siteCandidates(origin, attempts) {
  const page = await cachedGet(origin, { accept: HTML_ACCEPT, maxBytes: MAX_HTML_BYTES, truncate: true })
  let response = page
  if (!page.ok && page.network && origin.startsWith('https://')) response = await cachedGet(origin.replace(/^https:/, 'http:'), { accept: HTML_ACCEPT, maxBytes: MAX_HTML_BYTES, truncate: true })
  if (!response.ok || !response.body) {
    attempts.push(`site ${origin}: ${response.error ?? `HTTP ${response.status ?? '?'}`}`)
    return conventionalIconUrls(origin)
  }
  const links = parseHtmlIcons(response.body.toString('utf8'), response.url || origin)
  const manifest = links.find((link) => link.kind === 'manifest')
  const fromManifest = []
  if (manifest) {
    const file = await cachedGet(manifest.url, { accept: 'application/manifest+json,application/json,*/*;q=0.5', maxBytes: MAX_JSON_BYTES })
    if (file.ok && file.body) fromManifest.push(...parseManifestIcons(file.body.toString('utf8'), manifest.url))
  }
  const icons = [...links.filter((link) => link.kind !== 'manifest'), ...fromManifest]
  return icons.length ? icons : conventionalIconUrls(response.url || origin)
}

const SERVICE_URLS = (domain) => [
  { url: `https://www.google.com/s2/favicons?domain=${domain}&sz=256`, via: 'google-s2' },
  { url: `https://icons.duckduckgo.com/ip3/${domain}.ico`, via: 'duckduckgo' }
]

/**
 * Reúne candidatas de todas as fontes (parando cedo quando uma já é boa o bastante) e devolve todas elas com nota;
 * a escolha final acontece depois, quando já se sabe quais imagens se repetem entre domínios.
 */
async function collectEntry(entry) {
  const attempts = []
  const candidates = []
  const manual = overrides.entries?.[entry.id] ?? {}
  if (manual.skip) return { candidates, attempts: [`manual: ${manual.skip}`], skipped: String(manual.skip) }
  const row = harvest.get(entry.directoryUuid)
  const iconUrl = manual.iconUrl ?? row?.i
  const domain = trustedDomain(entry, iconUrl)
  const best = () => candidates.reduce((top, item) => Math.max(top, item.score), 0)

  if (manual.simpleIcon) candidates.push({ ...simpleIconCandidate(manual.simpleIcon, { confidence: 'high', via: `simple-icons:${manual.simpleIcon}` }), score: 95, source: 'manual' })

  if (manual.iconUrl || (iconUrl && looksLikeImageUrl(iconUrl))) {
    const result = await imageCandidate({ url: iconUrl, source: manual.iconUrl ? 'manual' : 'diretorio', via: 'iconUrl-do-diretorio' })
    if (result.candidate) candidates.push(result.candidate)
    else attempts.push(result.fail)
  }

  const match = matchSimpleIcon({ name: entry.name, id: entry.id, domain }, brandIndex)
  if (match && !manual.simpleIcon) {
    if (match.confidence === 'high') candidates.push(simpleIconCandidate(match.icon.slug, { confidence: 'high', via: `simple-icons:${match.icon.slug}` }))
    else attempts.push(`simple-icons sugere "${match.icon.slug}" (confiança média: não aplicado sem conferência)`)
  }

  if (best() < GOOD_ENOUGH) {
    const origins = []
    if (iconUrl && !looksLikeImageUrl(iconUrl) && isFetchableUrl(iconUrl) && !isGenericHost(hostOf(iconUrl))) origins.push(`${new URL(iconUrl).origin}/`)
    if (domain) origins.push(`https://${domain}/`, ...(registrableDomain(domain) === domain ? [`https://www.${domain}/`] : []))
    const seen = new Set()
    let visited = 0
    for (const origin of origins) {
      if (seen.has(origin) || visited >= 3 || best() >= GOOD_ENOUGH) continue
      seen.add(origin)
      visited++
      const links = rankLinks(await siteCandidates(origin, attempts)).slice(0, 4)
      let kept = 0
      for (const link of links) {
        if (kept >= 2 || best() >= GOOD_ENOUGH) break
        const result = await imageCandidate({ url: link.url, source: 'site', via: `${link.kind === 'apple' ? 'apple-touch-icon' : link.type === 'image/svg+xml' ? 'link-icon-svg' : 'link-icon'}@${hostOf(origin)}`, kind: link.kind, maskable: link.maskable })
        if (result.candidate) {
          candidates.push(result.candidate)
          kept++
        } else attempts.push(result.fail)
      }
    }
  }

  if (best() < 60 && domain) {
    for (const service of SERVICE_URLS(domain)) {
      if (best() >= 60) break
      const result = await imageCandidate({ url: service.url, source: 'servico-de-favicons', via: `${service.via}@${domain}` })
      if (result.candidate) candidates.push(result.candidate)
      else attempts.push(result.fail)
    }
  }
  if (!candidates.length && !attempts.length) attempts.push(domain ? 'nenhuma fonte devolveu imagem' : 'sem domínio confiável e sem ícone no diretório')
  return { candidates, attempts, domain }
}

function isGenericHost(host) {
  return NOT_A_BRAND.has(registrableDomain(host))
}

const ENTRY_TIMEOUT_MS = 120_000

/** Corre `worker` sobre os itens com limite de concorrência; uma entrada que passa de 2 minutos é abandonada (sem logo). */
async function pool(items, worker) {
  const results = new Array(items.length)
  const running = new Map()
  let next = 0
  let done = 0
  const runners = Array.from({ length: Math.min(CONCURRENCY * 2, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      running.set(index, items[index].id)
      let timer
      try {
        results[index] = await Promise.race([
          worker(items[index], index),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`tempo esgotado (${ENTRY_TIMEOUT_MS / 1000}s)`)), ENTRY_TIMEOUT_MS)
          })
        ])
      } catch (error) {
        results[index] = { candidates: [], attempts: [`erro: ${error.message}`], domain: '' }
      } finally {
        clearTimeout(timer)
        running.delete(index)
      }
      done++
      if (done % 50 === 0 || done === items.length) log(`  ${done}/${items.length} entradas`)
    }
  })
  const watchdog = () => {
    if (running.size) log(`  o programa ia terminar com ${running.size} entrada(s) sem resposta: ${[...running.values()].join(', ')}`)
  }
  process.once('beforeExit', watchdog)
  await Promise.all(runners)
  process.off('beforeExit', watchdog)
  return results
}

/* -------------------------------------------------------------------------------------------- principal */

const sha1 = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex')

async function main() {
  if (flag('report-only')) {
    // Só reescreve o relatório a partir do manifesto que já existe (nenhum pedido de rede, nenhuma imagem tocada).
    fs.writeFileSync(REPORT_FILE, renderReport(JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))))
    log(`Relatório reescrito: ${path.relative(ROOT, REPORT_FILE)}`)
    return
  }
  const entries = directory.filter((entry) => !ONLY.size || ONLY.has(entry.id))
  log(`Conectores: ${directory.length} no diretório; processando ${entries.length}. Cache: ${CACHE_DIR}${OFFLINE ? ' (offline)' : ''}`)
  const collected = await pool(entries, (entry) => collectEntry(entry))
  log(`Pedidos: ${stats.network} à rede, ${stats.cached} do cache.`)

  // Imagem tirada de SITES que se repete em 3 ou mais domínios diferentes é ícone genérico (página parada, hospedagem),
  // não marca. O ícone que o próprio diretório escolheu para o conector vale sempre (o logo do MCP serve a 3 conectores).
  const fromWebsites = (candidate) => candidate.source === 'site' || candidate.source === 'servico-de-favicons'
  const domainsByHash = new Map()
  entries.forEach((entry, index) => {
    for (const candidate of collected[index].candidates) candidate.hash = sha1(candidate.bytes)
    if (!collected[index].domain) return
    for (const candidate of collected[index].candidates.filter(fromWebsites)) {
      const set = domainsByHash.get(candidate.hash) ?? new Set()
      set.add(collected[index].domain)
      domainsByHash.set(candidate.hash, set)
    }
  })
  const placeholders = new Set([...domainsByHash].filter(([, set]) => set.size >= 3).map(([hash]) => hash))
  const isPlaceholder = (candidate) => fromWebsites(candidate) && placeholders.has(candidate.hash)

  const previous = fs.existsSync(MANIFEST_FILE) && ONLY.size ? JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) : null
  const results = new Map()
  const missing = new Map()
  const fileOfHash = new Map()
  const files = new Map()
  const order = { manual: 0, diretorio: 1, 'simple-icons': 2, site: 3, 'servico-de-favicons': 4 }

  entries.forEach((entry, index) => {
    const { candidates, attempts, domain, skipped } = collected[index]
    const usable = candidates.filter((candidate) => !isPlaceholder(candidate)).sort((a, b) => b.score - a.score || order[a.source] - order[b.source])
    const dropped = candidates.length - usable.length
    if (!usable.length) {
      const reasons = [...attempts]
      if (dropped) reasons.push(`${dropped} imagem(ns) descartada(s): a mesma imagem aparece em 3 ou mais domínios (ícone genérico)`)
      missing.set(entry.id, { name: entry.name, domain: domain || entry.iconDomain || '', reason: skipped ? `sem marca: ${skipped}` : reasons.slice(0, 5).join(' | ') || 'sem candidatas' })
      return
    }
    const chosen = usable[0]
    let file = fileOfHash.get(chosen.hash)
    if (!file) {
      file = `${baseFileName(entry.id)}.${chosen.ext}`
      fileOfHash.set(chosen.hash, file)
      files.set(file, chosen.bytes)
    }
    results.set(entry.id, {
      file,
      source: chosen.source,
      via: chosen.via,
      domain: domain || '',
      iconDomain: entry.iconDomain ?? '',
      sourceUrl: chosen.sourceUrl,
      srcSize: chosen.srcSize,
      mode: chosen.mode,
      bytes: chosen.bytes.length,
      sha1: chosen.hash,
      score: chosen.score,
      ...(chosen.license ? { license: chosen.license, brand: chosen.brandTitle } : {})
    })
  })

  if (ONLY.size) {
    entries.forEach((entry, index) => {
      const found = results.get(entry.id)
      const { candidates, attempts, domain } = collected[index]
      log(`- ${entry.id} [${domain || 'sem domínio'}] ${found ? `→ ${found.source} ${found.via} nota ${found.score} ${found.srcSize} ${found.mode} ${found.bytes}B` : '→ SEM LOGO'}`)
      for (const candidate of candidates) log(`    candidata: ${candidate.source} ${candidate.via} nota ${candidate.score} ${candidate.srcSize} ${candidate.mode}${isPlaceholder(candidate) ? ' (GENÉRICA)' : ''}`)
      for (const attempt of attempts) log(`    falhou: ${attempt}`)
    })
  }

  // Extras: marcas para conectores personalizados ("whatsapp", "appwrite-api", "mercadopago"...).
  const brands = {}
  const brandFiles = {}
  for (const [word, slug] of Object.entries(overrides.brands ?? {})) {
    const tile = simpleIconCandidate(slug, { confidence: 'high', via: `simple-icons:${slug}` })
    const hash = sha1(tile.bytes)
    let file = fileOfHash.get(hash)
    if (!file) {
      file = `brand-${baseFileName(word)}.svg`
      fileOfHash.set(hash, file)
      files.set(file, tile.bytes)
    }
    brandFiles[word] = file
    brands[word] = { file, slug, brand: tile.brandTitle, license: tile.license, sourceUrl: tile.sourceUrl }
  }

  // Junta com o que já existia quando só alguns ids foram refeitos.
  let finalResults = results
  let finalMissing = missing
  let finalBrands = brands
  if (previous) {
    finalResults = new Map(Object.entries(previous.entries ?? {}))
    for (const id of ONLY) finalResults.delete(id)
    for (const [id, value] of results) finalResults.set(id, value)
    finalMissing = new Map(Object.entries(previous.missing ?? {}))
    for (const id of ONLY) finalMissing.delete(id)
    for (const [id, value] of missing) finalMissing.set(id, value)
    finalBrands = brands
  }

  const entriesForIndex = directory.map((entry) => {
    const found = finalResults.get(entry.id)
    // Domínio de plataforma (github.com, google.com, claude.com...) não identifica uma marca: nunca vira atalho por domínio.
    // Um conector personalizado em api.github.com ainda acha o logo do GitHub pela palavra "github" do endereço.
    return { id: entry.id, domain: found?.domain && !NOT_A_BRAND.has(found.domain) ? found.domain : undefined, file: found?.file }
  })
  const index = buildIndex({ entries: entriesForIndex, brandFiles })

  // Totais e cobertura.
  const withDomain = directory.filter((entry) => entry.iconDomain)
  const withLogo = withDomain.filter((entry) => finalResults.has(entry.id))
  const bySource = {}
  for (const value of finalResults.values()) bySource[value.source] = (bySource[value.source] ?? 0) + 1
  const total = { entries: directory.length, withIconDomain: withDomain.length, withIconDomainAndLogo: withLogo.length, withLogo: finalResults.size, withoutLogo: directory.length - finalResults.size }
  const allFiles = new Map(files)
  if (previous) {
    for (const value of finalResults.values()) if (!allFiles.has(value.file) && fs.existsSync(path.join(ICONS_DIR, value.file))) allFiles.set(value.file, fs.readFileSync(path.join(ICONS_DIR, value.file)))
  }
  const totalBytes = [...allFiles.values()].reduce((sum, buffer) => sum + buffer.length, 0)
  const coverage = withDomain.length ? withLogo.length / withDomain.length : 0

  log(`Com logo: ${finalResults.size}/${directory.length}. Das ${withDomain.length} com iconDomain: ${withLogo.length} (${(coverage * 100).toFixed(1)}%).`)
  log(`Por fonte: ${JSON.stringify(bySource)}. Arquivos: ${allFiles.size}, ${(totalBytes / 1e6).toFixed(2)} MB.`)

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/connector-icons.mjs',
    simpleIcons: { version: simpleIconsMeta.version, license: simpleIconsMeta.license },
    tileSize: TILE_SIZE,
    summary: { ...total, coverageOfIconDomain: Number(coverage.toFixed(4)), bySource, files: allFiles.size, bytes: totalBytes },
    entries: Object.fromEntries([...finalResults].sort(([a], [b]) => a.localeCompare(b, 'en'))),
    brands: finalBrands,
    missing: Object.fromEntries([...finalMissing].sort(([a], [b]) => a.localeCompare(b, 'en')))
  }

  if (NO_WRITE) {
    log('--no-write: nada foi gravado.')
    return
  }
  fs.mkdirSync(ICONS_DIR, { recursive: true })
  const keep = new Set(allFiles.keys())
  for (const name of fs.readdirSync(ICONS_DIR)) if (!keep.has(name)) fs.rmSync(path.join(ICONS_DIR, name))
  for (const [name, bytes] of files) fs.writeFileSync(path.join(ICONS_DIR, name), bytes)
  fs.writeFileSync(INDEX_FILE, renderIndexModule(index, { generatedBy: `simple-icons ${simpleIconsMeta.version} (${simpleIconsMeta.license}); ${total.withLogo} de ${total.entries} conectores com logo.` }))
  fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true })
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(REPORT_FILE, renderReport(manifest))
  log(`Gravado: ${path.relative(ROOT, ICONS_DIR)} (${allFiles.size} arquivos), ${path.relative(ROOT, INDEX_FILE)}, ${path.relative(ROOT, MANIFEST_FILE)}, ${path.relative(ROOT, REPORT_FILE)}.`)
  if (coverage < 0.95) {
    log(`ATENÇÃO: cobertura ${(coverage * 100).toFixed(1)}% abaixo da meta de 95%.`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------------------------------------ relatório */

const SOURCE_LABEL = {
  manual: 'Escolha manual (scripts/data/connector-icons-overrides.json)',
  diretorio: 'Ícone do próprio diretório do Claude (iconUrl)',
  'simple-icons': 'simple-icons (glifo oficial na cor da marca)',
  site: 'Site do fornecedor (apple-touch-icon, link rel=icon, manifesto)',
  'servico-de-favicons': 'Serviço de favicons (Google/DuckDuckGo), só na coleta'
}

function renderReport(manifest) {
  const s = manifest.summary
  const pct = (value, of) => (of ? `${((value / of) * 100).toFixed(1)}%` : '0%')
  const lines = []
  lines.push('# Logos dos conectores', '')
  lines.push('> Relatório GERADO por `node scripts/connector-icons.mjs` (não edite à mão: a próxima coleta o reescreve).', '')
  lines.push('A tela Personalização → Conectores mostra o logo original de cada serviço no lugar da letra. As imagens são **coletadas',
    'em desenvolvimento e empacotadas no app** (`src/renderer/public/connector-icons/`): o Openclod **não faz nenhum pedido de rede para',
    'carregar logos**, então a tela funciona offline e nenhum serviço de terceiros fica sabendo quais conectores você está olhando.', '')
  lines.push('## Cobertura', '')
  lines.push('| | Quantidade |', '|---|---:|')
  lines.push(`| Conectores no diretório | ${s.entries} |`)
  lines.push(`| Com \`iconDomain\` (domínio do fornecedor) | ${s.withIconDomain} |`)
  lines.push(`| **Dessas, com logo real** | **${s.withIconDomainAndLogo}** (${pct(s.withIconDomainAndLogo, s.withIconDomain)}) — meta: 95% |`)
  lines.push(`| Com logo (todas as entradas) | ${s.withLogo} (${pct(s.withLogo, s.entries)}) |`)
  lines.push(`| Sem logo (mostram as iniciais coloridas) | ${s.withoutLogo} |`)
  lines.push(`| Arquivos de imagem | ${s.files} (${(s.bytes / 1e6).toFixed(2)} MB no total, ${Math.round(s.bytes / Math.max(1, s.files) / 1024)} KB em média) |`, '')
  lines.push('## De onde veio cada logo', '', '| Fonte | Logos |', '|---|---:|')
  for (const [source, count] of Object.entries(s.bySource).sort((a, b) => b[1] - a[1])) lines.push(`| ${SOURCE_LABEL[source] ?? source} | ${count} |`)
  lines.push('', 'A origem de **cada** imagem (arquivo, fonte, endereço, domínio, tamanho original e nota) está em `docs/mcp/icones-conectores.json`.', '')
  const vector = 'Vetor (SVG) na origem: desenhado em alta resolução'
  const buckets = { [vector]: 0, '128 px ou mais': 0, '64 a 127 px': 0, '32 a 63 px (ampliado, fica mais suave)': 0 }
  for (const value of Object.values(manifest.entries)) {
    const side = value.srcSize === 'svg' ? Infinity : Math.max(...String(value.srcSize).split('x').map(Number))
    const key = side === Infinity ? vector : side >= 128 ? '128 px ou mais' : side >= 64 ? '64 a 127 px' : '32 a 63 px (ampliado, fica mais suave)'
    buckets[key]++
  }
  lines.push('## Qualidade das imagens', '', 'Tamanho do arquivo de origem (a imagem final tem sempre 128 × 128 px):', '', '| Origem | Logos |', '|---|---:|')
  for (const [label, count] of Object.entries(buckets)) lines.push(`| ${label} | ${count} |`)
  lines.push('')
  const missing = Object.entries(manifest.missing)
  lines.push(`## Conectores sem logo (${missing.length})`, '')
  if (missing.length) {
    lines.push('Esses mostram as iniciais num quadrado colorido (sempre a mesma cor para o mesmo nome). Motivo de cada um:', '', '| Id | Nome | Domínio | Por que ficou sem logo |', '|---|---|---|---|')
    for (const [id, item] of missing) lines.push(`| \`${id}\` | ${String(item.name).replace(/\|/g, '/')} | ${item.domain || '—'} | ${String(item.reason).replace(/\|/g, '/').slice(0, 260)} |`)
  } else lines.push('Nenhum.')
  lines.push('', '## Como funciona', '',
    '- **Coleta** (`scripts/connector-icons.mjs`): para cada conector junta candidatas de várias fontes e fica com a de maior nota. A nota favorece vetor (SVG) e imagem grande, e desconta imagem pequena (< 48 px) ou muito larga (um "wordmark"). Imagens menores que 32 px, páginas de erro e o ícone genérico de hospedagem (a mesma imagem em 3 ou mais domínios) são descartadas.',
    '- **Normalização**: todo logo vira um ladrilho quadrado de 128 × 128 px. Logo com fundo transparente é centralizado com margem sobre um fundo claro — ou escuro, quando o logo é branco e sumiria. Ícone de app (quadrado cheio) ocupa o ladrilho inteiro. Os cantos arredondados são feitos pelo CSS.',
    '- **simple-icons**: o glifo da marca fica num ladrilho na cor oficial da marca, em branco (ou quase-preto sobre cores muito claras, como o amarelo). O SVG é escrito pelo coletor só com o caminho e a cor, ambos validados.',
    '- **Segurança**: o que vem de sites é dado não confiável. O coletor só aceita http(s) público (recusa endereço interno, inclusive em redirecionamentos), limita o tamanho das respostas, confere o tipo pelos primeiros bytes, limpa o SVG (sem `<script>`, `on*=`, `<foreignObject>`, `href` externo, `@import`, entidades) antes de rasterizar e só empacota WebP novo ou SVG escrito por ele. No app, o logo é sempre uma `<img>`, nunca SVG inline.',
    '- **Domínio confiável**: o `iconDomain` do diretório às vezes é o de uma CDN ou de uma plataforma (`sanity.io`, `github.com`, `claude.com`). O coletor só procura o site de um domínio quando ele bate com o endereço do servidor MCP, com o site que o diretório indica ou com o nome da marca; nos demais casos usa só o ícone que o próprio diretório indica (ou deixa as iniciais) em vez de mostrar o logo da plataforma.',
    '- **Anthropic/Claude**: a política do projeto (`THIRD_PARTY_NOTICES.md`, seção 5) é não redistribuir logos da Anthropic/Claude; esses conectores ficam com as iniciais.',
    '- **Onde ficam e por quê**: em `src/renderer/public/` (o Vite copia a pasta como está para `out/renderer/connector-icons/`). Assim as ~900 imagens não entram no JavaScript (o índice que o app lê, `connector-icon-index.ts`, tem ~70 KB), o caminho relativo funciona no `npm run dev` (servidor), no `npm run build` e dentro do `app.asar` do instalador, e a CSP (`img-src \'self\'`) já permite.',
    '- **No app**: `ConnectorIcon` mostra a imagem pelo caminho relativo `connector-icons/<arquivo>`, em tamanho fixo (40 px no cartão, 46 px no detalhe), com `loading="lazy"` e `decoding="async"` para não pesar na grade de 900 cartões. Se não houver imagem ou ela falhar (`onError`), volta para as iniciais.',
    '- **Conectores personalizados** (os que você adiciona): recebem o logo quando o nome ou o endereço apontam para uma marca conhecida (ex.: `whatsapp`, `appwrite-docs`, `mcp.mercadopago.com`). Os demais ficam com as iniciais.', '')
  lines.push('## Como atualizar', '',
    '```powershell',
    'node scripts/connector-icons.mjs            # usa o cache; só pede o que falta',
    'node scripts/connector-icons.mjs --refresh  # pede tudo de novo',
    'node scripts/connector-icons.mjs --only github,notion',
    '```', '',
    'Para corrigir um logo errado ou ausente, edite `scripts/data/connector-icons-overrides.json` (`simpleIcon`, `iconUrl`, `domain` ou `skip` por id) e rode de novo.', '')
  lines.push('## Marcas e licenças', '',
    `Os logos são marcas registradas dos respectivos donos e aparecem **somente para identificar o serviço** a que o conector se refere; não indicam parceria nem endosso. O pacote [simple-icons](https://simpleicons.org) (${manifest.simpleIcons.version}, ${manifest.simpleIcons.license}) é usado só em desenvolvimento; veja \`THIRD_PARTY_NOTICES.md\`.`, '')
  return `${lines.join('\n')}\n`
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(2)
})
