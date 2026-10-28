// Lógica pura do coletor de logos dos conectores (sem rede, sem disco, sem sharp): usada por
// scripts/connector-icons.mjs e testada em tests/connector-icons.test.ts.
//
// Tudo o que vem de fora (HTML de sites, SVG, ICO, JSON de manifesto) é DADO NÃO CONFIÁVEL: aqui só se lê e se
// valida; nada é executado nem inserido na tela. O que o app embarca é gerado pelo coletor (WebP novo, ou um SVG
// que o próprio coletor escreve a partir de um caminho e de uma cor validados), nunca o arquivo do terceiro.

import { registrableDomain } from './mcp-directory-core.mjs'

/* ----------------------------------------------------------------------------------------------- constantes */

/** Lado, em pixels, das imagens WebP embarcadas (cartão = 40 px, detalhe = 46 px: 128 cobre telas de 2,5x). */
export const TILE_SIZE = 128
/** Margem em volta de um logo com fundo transparente, como fração do lado do ladrilho. */
export const LOGO_PADDING = 0.16
/** Fundo dos logos transparentes escuros/médios (quase branco, mais suave que #fff no tema escuro). */
export const BACKDROP_LIGHT = '#f6f7f9'
/** Fundo dos logos transparentes muito claros (que sumiriam no claro). */
export const BACKDROP_DARK = '#16181d'
/** Menor lado aceito para um logo bitmap; abaixo disso o ícone vira borrão. */
export const MIN_SIDE = 32
/** Pontuação mínima para o coletor parar de procurar outra fonte. */
export const GOOD_ENOUGH = 82

/* -------------------------------------------------------------------------------------------------- domínios */

/** Domínio em minúsculas, sem `www.` e sem porta/caminho; '' quando não parece um domínio. */
export function normalizeDomain(input) {
  let text = String(input ?? '').trim().toLowerCase()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      text = new URL(text).hostname
    } catch {
      return ''
    }
  } else {
    text = (text.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '')
  }
  text = text.replace(/^www\./, '').replace(/\.$/, '')
  if (/^\d+(\.\d+){3}$/.test(text)) return ''
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(text) && text.includes('.') ? text : ''
}

/** Primeiro rótulo do domínio registrável: `mycase.com` → `mycase`, `foo.co.uk` → `foo`. */
export function brandLabelOf(domain) {
  const reg = registrableDomain(normalizeDomain(domain))
  return reg.split('.')[0] ?? ''
}

/** Endereços que um coletor nunca deve visitar: laço local, rede privada, link-local, CGNAT, multicast. */
export function isPrivateAddress(address) {
  const text = String(address ?? '').trim().toLowerCase()
  if (!text) return true
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  const v4 = mapped ? mapped[1] : text
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  if (text.includes(':')) {
    if (text === '::' || text === '::1') return true
    if (/^f[cd]/.test(text) || /^fe[89ab]/.test(text) || /^ff/.test(text)) return true
    return false
  }
  return true
}

/** Antes de qualquer pedido: só http(s), sem usuário/senha na URL e sem host que é claramente interno. */
export function isFetchableUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPrivateAddress(host)
  return host.includes('.')
}

/* ------------------------------------------------------------------------------------------ HTML e manifesto */

const IMAGE_BY_EXT = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const DATA_IMAGE = /^data:image\/(png|svg\+xml|x-icon|vnd\.microsoft\.icon|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i
const MAX_DATA_URL = 600_000

/** Tipo de imagem que o endereço sugere (pela extensão), ou ''. */
export function imageTypeOfUrl(raw) {
  const text = String(raw ?? '')
  if (/^data:/i.test(text)) return (text.match(/^data:([^;,]+)/i)?.[1] ?? '').toLowerCase()
  try {
    const ext = new URL(text).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()
    return (ext && IMAGE_BY_EXT[ext]) || ''
  } catch {
    return ''
  }
}

/** A URL parece apontar direto para uma imagem (extensão ou serviço de favicons conhecido)? */
export function looksLikeImageUrl(raw) {
  const text = String(raw ?? '')
  if (!text) return false
  if (imageTypeOfUrl(text)) return true
  try {
    const url = new URL(text)
    if (/faviconv2|\/favicons$|\/favicon$/i.test(url.pathname) && /(^|\.)(gstatic|google)\.com$/i.test(url.hostname)) return true
    return /^\/(favicon|apple-touch-icon[^/]*)$/i.test(url.pathname)
  } catch {
    return false
  }
}

/**
 * O diretório às vezes aponta para o serviço de favicons do Google com tamanho pequeno (`sz=64`, `size=64`): na
 * coleta pedimos o maior (`sz=256`, `size=128`). Qualquer outro endereço volta como veio.
 */
export function upgradeFaviconServiceUrl(raw) {
  try {
    const url = new URL(String(raw))
    if (/(^|\.)google\.com$/i.test(url.hostname) && /^\/s2\/favicons\/?$/i.test(url.pathname) && url.searchParams.has('domain')) {
      url.searchParams.set('sz', '256')
      return url.href
    }
    if (/(^|\.)gstatic\.com$/i.test(url.hostname) && /^\/faviconV2\/?$/i.test(url.pathname)) {
      url.searchParams.set('size', '128')
      return url.href
    }
  } catch {
    /* não é uma URL: volta como veio */
  }
  return String(raw)
}

/** Atributos de uma tag HTML, em minúsculas. Não é um parser completo: lê só o que o coletor precisa. */
export function parseAttributes(tag) {
  const out = {}
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  const body = String(tag).replace(/^<\w+/, '').replace(/\/?>$/, '')
  let match
  while ((match = re.exec(body))) {
    const name = match[1].toLowerCase()
    if (!(name in out)) out[name] = (match[2] ?? match[3] ?? match[4] ?? '').trim()
  }
  return out
}

/** Maior lado declarado em `sizes="16x16 32x32"`; 0 quando ausente ou `any`. */
export function declaredSize(sizes) {
  let best = 0
  for (const part of String(sizes ?? '').toLowerCase().split(/\s+/)) {
    const m = part.match(/^(\d{1,4})x(\d{1,4})$/)
    if (m) best = Math.max(best, Number(m[1]), Number(m[2]))
  }
  return best
}

function resolveHref(href, base) {
  const text = String(href ?? '').trim()
  if (!text) return null
  if (/^data:/i.test(text)) return text.length <= MAX_DATA_URL && DATA_IMAGE.test(text) ? text : null
  try {
    const url = new URL(text, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Ícones que uma página declara: `<link rel="icon|apple-touch-icon|shortcut icon">` e o `manifest`. Cada item:
 * `{ url, kind: 'apple' | 'icon' | 'manifest', size, type }`. Só lê os primeiros 400 KB; `<base href>` vale.
 */
export function parseHtmlIcons(html, pageUrl) {
  const text = String(html ?? '').slice(0, 400_000).replace(/<!--[\s\S]*?-->/g, '')
  let base = pageUrl
  const baseTag = text.match(/<base\b[^>]*>/i)
  if (baseTag) {
    const href = parseAttributes(baseTag[0]).href
    const resolved = href ? resolveHref(href, pageUrl) : null
    if (resolved) base = resolved
  }
  const found = []
  const seen = new Set()
  for (const tag of text.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = parseAttributes(tag)
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (!rel.length || !attrs.href) continue
    const isApple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')
    const isIcon = rel.includes('icon')
    const isManifest = rel.includes('manifest')
    if (!isApple && !isIcon && !isManifest) continue
    const url = resolveHref(attrs.href, base)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const type = (attrs.type ?? '').toLowerCase() || imageTypeOfUrl(url)
    found.push({ url, kind: isManifest ? 'manifest' : isApple ? 'apple' : 'icon', size: declaredSize(attrs.sizes), type })
  }
  return found
}

/** Ícones do manifesto web (`icons[]` com `src` e `sizes`); os "maskable" têm margem de segurança, então valem menos. */
export function parseManifestIcons(json, manifestUrl) {
  let data = json
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json)
    } catch {
      return []
    }
  }
  const icons = data && typeof data === 'object' && Array.isArray(data.icons) ? data.icons : []
  const out = []
  for (const item of icons.slice(0, 20)) {
    if (!item || typeof item !== 'object' || typeof item.src !== 'string') continue
    const purpose = String(item.purpose ?? 'any').toLowerCase()
    if (/^monochrome$/.test(purpose.trim())) continue
    const url = resolveHref(item.src, manifestUrl)
    if (!url) continue
    out.push({
      url,
      kind: 'icon',
      size: declaredSize(item.sizes),
      type: String(item.type ?? '').toLowerCase() || imageTypeOfUrl(url),
      maskable: /\bmaskable\b/.test(purpose) && !/\bany\b/.test(purpose)
    })
  }
  return out
}

/** Endereços de ícone "de costume" quando a página não declara nenhum. */
export function conventionalIconUrls(origin) {
  let base
  try {
    base = new URL(origin)
  } catch {
    return []
  }
  return ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon.svg', '/favicon.png', '/favicon.ico'].map((path) => ({
    url: new URL(path, base).href,
    kind: path.startsWith('/apple') ? 'apple' : 'icon',
    size: 0,
    type: imageTypeOfUrl(path)
  }))
}

/* ------------------------------------------------------------------------------------------------------ SVG */

const ACTIVE_ELEMENTS = 'script|foreignObject|iframe|object|embed|audio|video|canvas|animate|animateMotion|animateTransform|set|handler|listener'

/**
 * Limpa um SVG de terceiro antes de rasterizar: sem scripts, `foreignObject`, atributos `on*`, referências
 * externas (`href`, `url(...)`, `@import`) nem declarações de entidade/DOCTYPE. Devolve `null` quando o arquivo é
 * grande demais, declara entidades (bomba de expansão) ou não é um SVG. O app NUNCA embarca esse texto: ele só
 * alimenta o rasterizador do coletor; a defesa serve para o rasterizador não buscar nada fora do arquivo.
 */
export function sanitizeSvg(input) {
  let svg = String(input ?? '')
  if (svg.length > 800_000) return null
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(svg)) return null
  svg = svg.replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  svg = svg.replace(new RegExp(`<(${ACTIVE_ELEMENTS})\\b[^>]*?>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
  svg = svg.replace(new RegExp(`<(${ACTIVE_ELEMENTS})\\b[^>]*?\\/?>`, 'gi'), '')
  svg = svg.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  svg = svg.replace(/\s+(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (match, dq, sq) => {
    const value = String(dq ?? sq ?? '').trim()
    return value.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value) ? match : ''
  })
  svg = svg.replace(/url\(\s*(['"]?)(?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)[^)]*?\1\s*\)/gi, 'none')
  svg = svg.replace(/@import[^;{]*;?/gi, '')
  return /<svg\b/i.test(svg) ? svg.trim() : null
}

/** O SVG parece um arquivo que o app pode embarcar como `<img>`? (vale para os SVG que o próprio coletor gera.) */
export function isSafeSvgAsset(svg) {
  const text = String(svg ?? '')
  return (
    /^\s*(?:<\?xml[^>]*\?>\s*)?<svg\b/i.test(text) &&
    !/<script|<foreignObject|<iframe|<object|<embed|<!ENTITY|<!DOCTYPE/i.test(text) &&
    !/\son[a-z]+\s*=/i.test(text) &&
    !/(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(text) &&
    !/url\(\s*['"]?(?!#)/i.test(text) &&
    !/@import/i.test(text)
  )
}

/* ------------------------------------------------------------------------------------------------------ ICO */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Entradas de um arquivo .ico (ou .cur): `{ width, height, bitCount, size, offset }`; lança em arquivo malformado. */
export function parseIcoEntries(buffer) {
  const buf = Buffer.from(buffer)
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || ![1, 2].includes(buf.readUInt16LE(2))) throw new Error('não é um arquivo .ico')
  const count = buf.readUInt16LE(4)
  if (count < 1 || count > 64 || 6 + count * 16 > buf.length) throw new Error('cabeçalho .ico inválido')
  const entries = []
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16
    const size = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    if (size < 8 || offset + size > buf.length) continue
    entries.push({ width: buf[at] || 256, height: buf[at + 1] || 256, bitCount: buf.readUInt16LE(at + 6), size, offset })
  }
  if (!entries.length) throw new Error('.ico sem imagens válidas')
  return entries
}

/**
 * A maior imagem de um .ico como `{ format: 'png', data }` (entrada PNG, que o sharp lê) ou
 * `{ format: 'rgba', width, height, data }` (entrada BMP, decodificada aqui: 1, 4, 8, 24 e 32 bits).
 */
export function decodeIco(buffer) {
  const buf = Buffer.from(buffer)
  const entries = parseIcoEntries(buf)
  const best = entries.reduce((a, b) => (b.width * b.height > a.width * a.height || (b.width * b.height === a.width * a.height && b.bitCount > a.bitCount) ? b : a))
  const data = buf.subarray(best.offset, best.offset + best.size)
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return { format: 'png', data }
  return { format: 'rgba', ...decodeDib(data) }
}

function decodeDib(data) {
  if (data.length < 40) throw new Error('imagem BMP do .ico truncada')
  const headerSize = data.readUInt32LE(0)
  if (headerSize < 40) throw new Error('cabeçalho BMP não suportado')
  const width = data.readInt32LE(4)
  const rawHeight = data.readInt32LE(8)
  const planes = data.readUInt16LE(12)
  const bpp = data.readUInt16LE(14)
  const compression = data.readUInt32LE(16)
  const colorsUsed = data.readUInt32LE(32)
  const height = Math.abs(rawHeight) >> 1
  if (width < 1 || width > 512 || height < 1 || height > 512 || planes !== 1) throw new Error('dimensões BMP inválidas')
  if (![1, 4, 8, 24, 32].includes(bpp) || (compression !== 0 && !(compression === 3 && bpp === 32))) throw new Error(`BMP ${bpp} bits/compressão ${compression} não suportado`)
  let cursor = headerSize + (compression === 3 && headerSize === 40 ? 12 : 0)
  const palette = []
  if (bpp <= 8) {
    const entries = colorsUsed || 1 << bpp
    if (cursor + entries * 4 > data.length) throw new Error('paleta BMP truncada')
    for (let index = 0; index < entries; index++) palette.push([data[cursor + index * 4 + 2], data[cursor + index * 4 + 1], data[cursor + index * 4]])
    cursor += entries * 4
  }
  const xorStride = (((width * bpp + 31) >> 5) << 2) >>> 0
  const andStride = (((width + 31) >> 5) << 2) >>> 0
  if (cursor + xorStride * height > data.length) throw new Error('pixels BMP truncados')
  const andStart = cursor + xorStride * height
  const hasMask = andStart + andStride * height <= data.length
  const rgba = Buffer.alloc(width * height * 4)
  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const rowStart = cursor + xorStride * (height - 1 - y)
    const maskStart = andStart + andStride * (height - 1 - y)
    for (let x = 0; x < width; x++) {
      let r
      let g
      let b
      let a = 255
      if (bpp === 32) {
        b = data[rowStart + x * 4]
        g = data[rowStart + x * 4 + 1]
        r = data[rowStart + x * 4 + 2]
        a = data[rowStart + x * 4 + 3]
        if (a) anyAlpha = true
      } else if (bpp === 24) {
        b = data[rowStart + x * 3]
        g = data[rowStart + x * 3 + 1]
        r = data[rowStart + x * 3 + 2]
      } else {
        const perByte = 8 / bpp
        const byte = data[rowStart + Math.floor(x / perByte)]
        const shift = 8 - bpp * ((x % perByte) + 1)
        const colour = palette[(byte >> shift) & ((1 << bpp) - 1)] ?? [0, 0, 0]
        ;[r, g, b] = colour
      }
      const out = (y * width + x) * 4
      rgba[out] = r
      rgba[out + 1] = g
      rgba[out + 2] = b
      rgba[out + 3] = a
    }
  }
  // 32 bits sem nenhum alfa = ícone antigo: a transparência vem da máscara AND. Nos demais a máscara sempre vale.
  if (hasMask && (bpp !== 32 || !anyAlpha)) {
    for (let y = 0; y < height; y++) {
      const maskStart = andStart + andStride * (height - 1 - y)
      for (let x = 0; x < width; x++) {
        const transparent = (data[maskStart + (x >> 3)] >> (7 - (x & 7))) & 1
        rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255
      }
    }
  } else if (bpp === 32 && !anyAlpha) {
    for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255
  }
  return { width, height, data: rgba }
}

/* ------------------------------------------------------------------------------------------------ cores */

function channelToLinear(value) {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const LINEAR = Array.from({ length: 256 }, (_, value) => channelToLinear(value))

/** Luminância relativa (WCAG) de uma cor `#rrggbb`. */
export function relativeLuminance(hex) {
  const m = String(hex).replace(/^#/, '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) throw new Error(`cor inválida: ${hex}`)
  return 0.2126 * LINEAR[parseInt(m[1], 16)] + 0.7152 * LINEAR[parseInt(m[2], 16)] + 0.0722 * LINEAR[parseInt(m[3], 16)]
}

/**
 * Cor do glifo sobre o fundo `#rrggbb`: branco, a não ser que o fundo seja muito claro (brilho > 0,69, a mesma régua que o
 * shields.io usa para os selos de marca), caso em que vai quase-preto. É o que dá o branco do WhatsApp sobre o verde, do
 * GitHub sobre o preto e do Google sobre o azul, e o escuro sobre os amarelos e verdes claros. É um logo, não texto: o que
 * vale é parecer com a marca, não a razão de contraste da WCAG.
 */
export function glyphColorOn(hex) {
  const m = String(hex).replace(/^#/, '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) throw new Error(`cor inválida: ${hex}`)
  const brightness = (parseInt(m[1], 16) * 299 + parseInt(m[2], 16) * 587 + parseInt(m[3], 16) * 114) / 255000
  return brightness > 0.69 ? '#111111' : '#ffffff'
}

/* ------------------------------------------------------------------------------------- ladrilho (simple-icons) */

const SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/

/**
 * Ladrilho quadrado de uma marca do simple-icons: fundo na cor da marca e o glifo (caminho de 24x24) em branco ou
 * quase-preto (ver glyphColorOn). O SVG é escrito aqui, só com o caminho e a cor, ambos validados: nada do
 * arquivo original do pacote entra no app. O canto arredondado fica por conta do CSS.
 */
export function glyphTileSvg({ path, hex }) {
  const colour = String(hex ?? '').replace(/^#/, '').toLowerCase()
  if (!/^[0-9a-f]{6}$/.test(colour)) throw new Error(`cor da marca inválida: ${hex}`)
  const d = String(path ?? '').trim()
  if (!d || d.length > 20_000 || !SVG_PATH.test(d)) throw new Error('caminho SVG inválido')
  const glyph = glyphColorOn(`#${colour}`)
  const scale = 3
  const offset = (TILE_SIZE - 24 * scale) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}" width="${TILE_SIZE}" height="${TILE_SIZE}"><rect width="${TILE_SIZE}" height="${TILE_SIZE}" fill="#${colour}"/><path fill="${glyph}" transform="translate(${offset} ${offset}) scale(${scale})" d="${d}"/></svg>\n`
}

/* ----------------------------------------------------------------------------------- casamento com simple-icons */

/** Só letras e números, sem acento, minúsculo: a chave de comparação entre nomes de marca. */
export function brandKey(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

const NOISE_WORDS = /\b(mcp|server|servidor|oficial|official|app|local|remote|remoto|connector|conector|api|token|cli|docs?)\b/gi

/** Nome do conector reduzido à marca: sem parênteses, ®/™ e palavras como "MCP" ou "oficial". */
export function brandNameOf(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[®™©]/g, ' ')
    .replace(NOISE_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Índices do simple-icons (`{ title, slug, hex, source, aliases }`): por chave do `slug`/`title` (`byKey`), por chave
 * dos apelidos (`byAlias`, que valem menos: "Terraform" é apelido do OpenTofu) e o domínio do `source` de cada ícone.
 */
export function buildBrandIndex(icons) {
  const byKey = new Map()
  const byAlias = new Map()
  const add = (map, key, icon) => {
    if (!key) return
    const list = map.get(key) ?? []
    if (!list.includes(icon)) list.push(icon)
    map.set(key, list)
  }
  const hostOf = new Map()
  for (const icon of icons) {
    add(byKey, brandKey(icon.slug), icon)
    add(byKey, brandKey(icon.title), icon)
    for (const group of Object.values(icon.aliases ?? {})) {
      for (const alias of Array.isArray(group) ? group : []) add(byAlias, brandKey(typeof alias === 'string' ? alias : alias?.title), icon)
    }
    try {
      hostOf.set(icon, registrableDomain(new URL(icon.source).hostname))
    } catch {
      /* sem fonte válida: só vale pelo nome */
    }
  }
  return { byKey, byAlias, hostOf }
}

/**
 * Procura o ícone de uma entrada do diretório. `high` = o nome (ou o id) bate EXATAMENTE com a marca e o domínio
 * confirma (o rótulo do domínio é o da marca, ou o domínio do `source` do ícone é o da entrada), ou o domínio bate
 * com a marca e com o `source`; `medium` = o resto, que o coletor NÃO aplica sem conferência humana. Apelido nunca
 * dá `high` sozinho. Devolve `{ icon, confidence }` ou `null`.
 */
export function matchSimpleIcon({ name, id, domain }, index) {
  const nameKey = brandKey(brandNameOf(name))
  const idKey = brandKey(id)
  const label = brandKey(brandLabelOf(domain ?? ''))
  const reg = registrableDomain(normalizeDomain(domain ?? ''))
  const found = new Map()
  const touch = (icon) => {
    let item = found.get(icon)
    if (!item) {
      item = { name: 0, id: 0, domain: 0, points: 0 }
      found.set(icon, item)
    }
    return item
  }
  // `field` guarda 2 = bate com o título/slug, 1 = só com um apelido.
  const consider = (key, field, exact, alias) => {
    if (!key) return
    const exactIcons = index.byKey.get(key) ?? []
    for (const icon of exactIcons) {
      const item = touch(icon)
      item[field] = 2
      item.points += exact
    }
    for (const icon of index.byAlias.get(key) ?? []) {
      if (exactIcons.includes(icon)) continue
      const item = touch(icon)
      item[field] = Math.max(item[field], 1)
      item.points += alias
    }
  }
  consider(nameKey, 'name', 3, 1)
  consider(label, 'domain', 1, 0.5)
  if (idKey !== nameKey) consider(idKey, 'id', 2, 0.5)
  let best = null
  for (const [icon, item] of found) {
    const sameHost = Boolean(reg) && index.hostOf.get(icon) === reg
    const points = item.points + (sameHost ? 2 : 0)
    const exactName = item.name === 2 || item.id === 2
    const confidence = (exactName && (item.domain > 0 || sameHost)) || (item.domain === 2 && sameHost) ? 'high' : 'medium'
    if (!best || points > best.points) best = { icon, confidence, points }
  }
  return best ? { icon: best.icon, confidence: best.confidence } : null
}

/* ------------------------------------------------------------------------------------------------ pontuação */

const SOURCE_BASE = { diretorio: 60, 'simple-icons': 70, site: 56, 'servico-de-favicons': 35, manual: 90 }

/**
 * Nota de uma candidata a logo (maior = melhor); `null` = recusada. `vector` = SVG; `kind` = `apple` (ícone de
 * tela inicial, quadrado e sem transparência) ou `icon`. Vetor e bitmap grande valem mais; bitmap pequeno ou muito
 * largo (um "wordmark") perde pontos.
 */
export function scoreCandidate({ source, width = 0, height = 0, vector = false, kind = 'icon', maskable = false }) {
  const base = SOURCE_BASE[source]
  if (base === undefined) return null
  let score = base
  if (kind === 'apple' && source === 'site') score += 4
  if (maskable) score -= 6
  if (source === 'simple-icons') return score
  const side = Math.max(width, height)
  const smaller = Math.min(width, height)
  if (vector) {
    score += 26
  } else {
    if (side < MIN_SIDE || smaller < 1) return null
    score += side >= 512 ? 25 : side >= 256 ? 22 : side >= 180 ? 20 : side >= 128 ? 16 : side >= 96 ? 12 : side >= 64 ? 6 : side >= 48 ? 0 : -10
  }
  const ratio = smaller >= 1 && side >= 1 ? side / smaller : 1
  if (ratio > 1.25) score -= Math.min(30, (ratio - 1.25) * 25)
  return Math.round(score * 10) / 10
}

/* ------------------------------------------------------------------------- análise de pixels (RGBA, sem sharp) */

const VISIBLE = 24
const GONE = 16

function lumaOf(r, g, b) {
  return 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b]
}

/**
 * Lê uma imagem RGBA e diz o que fazer com ela:
 *  - `bleed`: ocupa o quadrado inteiro (ícone de app, foto, ícone com cantos arredondados); só se redimensiona;
 *  - `logo`: figura solta (fundo transparente, ou fundo liso claro/escuro com margem grande): recorta na figura e
 *    coloca no centro de um ladrilho com margem. `crop` = retângulo da figura, `backdrop` = cor do ladrilho.
 */
export function analyzeRaster(rgba, width, height) {
  if (!rgba || rgba.length < width * height * 4 || width < 1 || height < 1) throw new Error('imagem RGBA inválida')
  const total = width * height
  let gone = 0
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] < GONE) gone++
  const goneFraction = gone / total
  const at = (x, y) => (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4
  const visibleAt = (x, y) => rgba[at(x, y) + 3] >= 200

  if (goneFraction >= 0.01) {
    // Ícone de app com cantos arredondados: o transparente fica só nos cantos e as bordas do meio são cheias.
    const zone = 0.28
    let cornerGone = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] >= GONE) continue
        const nearX = x < width * zone || x >= width * (1 - zone)
        const nearY = y < height * zone || y >= height * (1 - zone)
        if (nearX && nearY) cornerGone++
      }
    }
    const mids = visibleAt(width >> 1, 1) && visibleAt(width >> 1, height - 2) && visibleAt(1, height >> 1) && visibleAt(width - 2, height >> 1)
    if (mids && visibleAt(width >> 1, height >> 1) && gone > 0 && cornerGone / gone > 0.85 && goneFraction < 0.3) {
      return { mode: 'bleed', reason: 'cantos-arredondados', flatten: edgeColour(rgba, width, height) }
    }
    const box = boundsOf(rgba, width, height, (x, y) => rgba[(y * width + x) * 4 + 3] >= VISIBLE)
    if (!box) throw new Error('imagem totalmente transparente')
    return { mode: 'logo', reason: 'transparente', crop: box, backdrop: pickBackdrop(rgba, width, height, box) }
  }

  // Opaca. Fundo liso claro ou escuro + figura pequena no meio = logo solto num quadro grande (comum em JPEG/PNG).
  const bg = uniformCorners(rgba, width, height)
  if (bg) {
    const bgHex = hexOf(bg)
    const lum = relativeLuminance(bgHex)
    if (lum >= 0.8 || lum <= 0.02) {
      const box = boundsOf(rgba, width, height, (x, y) => {
        const i = (y * width + x) * 4
        return Math.abs(rgba[i] - bg[0]) + Math.abs(rgba[i + 1] - bg[1]) + Math.abs(rgba[i + 2] - bg[2]) > 48
      })
      if (box && (box.width < width * 0.78 || box.height < height * 0.78)) return { mode: 'logo', reason: 'fundo-liso', crop: box, backdrop: bgHex }
    }
  }
  return { mode: 'bleed', reason: 'opaca' }
}

function boundsOf(rgba, width, height, test) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!test(x, y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function hexOf([r, g, b]) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/** Cor dos quatro cantos quando eles são (quase) iguais; senão `null`. */
function uniformCorners(rgba, width, height) {
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1]
  ].map(([x, y]) => {
    const i = (y * width + x) * 4
    return [rgba[i], rgba[i + 1], rgba[i + 2]]
  })
  const first = points[0]
  const same = points.every((p) => Math.abs(p[0] - first[0]) + Math.abs(p[1] - first[1]) + Math.abs(p[2] - first[2]) <= 24)
  return same ? first : null
}

/** Média das cores visíveis nas bordas (usada para preencher os cantos transparentes de um ícone arredondado). */
function edgeColour(rgba, width, height) {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  const take = (x, y) => {
    const i = (y * width + x) * 4
    if (rgba[i + 3] < 200) return
    r += rgba[i]
    g += rgba[i + 1]
    b += rgba[i + 2]
    n++
  }
  for (let x = 0; x < width; x++) {
    take(x, 0)
    take(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    take(0, y)
    take(width - 1, y)
  }
  return n ? hexOf([Math.round(r / n), Math.round(g / n), Math.round(b / n)]) : '#ffffff'
}

/**
 * Fundo do ladrilho de um logo transparente: claro, a menos que muitos pixels do logo sumissem nele (um logo
 * branco), caso em que o fundo é escuro.
 */
function pickBackdrop(rgba, width, height, box) {
  let weight = 0
  let lostOnLight = 0
  let lostOnDark = 0
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      const i = (y * width + x) * 4
      const a = rgba[i + 3]
      if (a < VISIBLE) continue
      const luminance = lumaOf(rgba[i], rgba[i + 1], rgba[i + 2])
      weight += a
      if (luminance > 0.62) lostOnLight += a
      if (luminance < 0.035) lostOnDark += a
    }
  }
  if (!weight) return BACKDROP_LIGHT
  return lostOnLight / weight > lostOnDark / weight + 0.15 ? BACKDROP_DARK : BACKDROP_LIGHT
}

/* ------------------------------------------------------------------------------------------------ nomes e índice */

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Nome de arquivo (sem extensão) do logo de uma entrada: o `id`, com cuidado com nomes reservados do Windows. */
export function baseFileName(id) {
  const slug = String(id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`id sem caracteres aproveitáveis: ${id}`)
  return RESERVED_NAMES.test(slug) ? `${slug}-logo` : slug
}

/**
 * Monta o índice que o app lê: `byId` (o id do conector → arquivo), `byDomain` (domínio → arquivo, só quando todos os
 * conectores do domínio usam o mesmo arquivo ou um deles tem o id igual ao nome do domínio) e `byBrand` (palavra de
 * marca → arquivo, para conectores personalizados).
 */
export function buildIndex({ entries, brandFiles = {} }) {
  const byId = {}
  for (const entry of entries) if (entry.file) byId[entry.id] = entry.file
  const domains = new Map()
  for (const entry of entries) {
    const domain = normalizeDomain(entry.domain ?? '')
    if (!domain || !entry.file) continue
    const list = domains.get(domain) ?? []
    list.push(entry)
    domains.set(domain, list)
  }
  const byDomain = {}
  for (const [domain, list] of domains) {
    const unique = new Set(list.map((entry) => entry.file))
    if (unique.size === 1) {
      byDomain[domain] = list[0].file
      continue
    }
    const label = brandLabelOf(domain)
    const owner = list.find((entry) => entry.id === label) ?? list.find((entry) => entry.id.startsWith(`${label}-`))
    if (owner) byDomain[domain] = owner.file
  }
  const byBrand = { ...brandFiles }
  const sort = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')))
  return { byId: sort(byId), byDomain: sort(byDomain), byBrand: sort(byBrand) }
}

/** O texto do módulo TypeScript do índice (ordem estável: o diff só muda quando um logo muda). */
export function renderIndexModule(index, meta = {}) {
  const lines = [
    '// GERADO por scripts/connector-icons.mjs a partir de resources/mcp-directory.json: não edite à mão.',
    '// Os arquivos ficam em src/renderer/public/connector-icons/ (copiados para out/renderer/connector-icons/ no build).',
    '// A origem de cada imagem está em docs/mcp/icones-conectores.json; o relatório, em docs/mcp/ICONES-CONECTORES.md.',
    ''
  ]
  if (meta.generatedBy) lines.push(`// ${meta.generatedBy}`, '')
  lines.push(
    'export interface ConnectorIconIndex {',
    '  /** Directory id (or custom server name) → file inside connector-icons/. */',
    '  byId: Readonly<Record<string, string>>',
    '  /** Registrable domain → file, for connectors added by hand that point at a known service. */',
    '  byDomain: Readonly<Record<string, string>>',
    '  /** Lower-case brand word → file, for connectors added by hand that are named after a well-known service. */',
    '  byBrand: Readonly<Record<string, string>>',
    '}',
    '',
    `export const CONNECTOR_ICON_INDEX: ConnectorIconIndex = ${JSON.stringify(index, null, 2)}`,
    ''
  )
  return lines.join('\n')
}
