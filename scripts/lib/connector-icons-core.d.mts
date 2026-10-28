// Tipos de scripts/lib/connector-icons-core.mjs (para os testes em TypeScript).

export const TILE_SIZE: number
export const LOGO_PADDING: number
export const BACKDROP_LIGHT: string
export const BACKDROP_DARK: string
export const MIN_SIDE: number
export const GOOD_ENOUGH: number

export function normalizeDomain(input: unknown): string
export function brandLabelOf(domain: string): string
export function isPrivateAddress(address: unknown): boolean
export function isFetchableUrl(raw: unknown): boolean

export function imageTypeOfUrl(raw: unknown): string
export function looksLikeImageUrl(raw: unknown): boolean
export function upgradeFaviconServiceUrl(raw: unknown): string
export function parseAttributes(tag: string): Record<string, string>
export function declaredSize(sizes: unknown): number

export interface IconLink {
  url: string
  kind: 'apple' | 'icon' | 'manifest'
  size: number
  type: string
  maskable?: boolean
}
export function parseHtmlIcons(html: string, pageUrl: string): IconLink[]
export function parseManifestIcons(json: unknown, manifestUrl: string): IconLink[]
export function conventionalIconUrls(origin: string): IconLink[]

export function sanitizeSvg(input: unknown): string | null
export function isSafeSvgAsset(svg: unknown): boolean

export interface IcoEntry {
  width: number
  height: number
  bitCount: number
  size: number
  offset: number
}
export function parseIcoEntries(buffer: Uint8Array): IcoEntry[]
export type DecodedIco = { format: 'png'; data: Buffer } | { format: 'rgba'; width: number; height: number; data: Buffer }
export function decodeIco(buffer: Uint8Array): DecodedIco

export function relativeLuminance(hex: string): number
export function glyphColorOn(hex: string): string
export function glyphTileSvg(input: { path: string; hex: string }): string

export interface SimpleIconLike {
  title: string
  slug: string
  hex: string
  source?: string
  aliases?: Record<string, unknown>
  [key: string]: unknown
}
export interface BrandIndex {
  byKey: Map<string, SimpleIconLike[]>
  byAlias: Map<string, SimpleIconLike[]>
  hostOf: Map<SimpleIconLike, string>
}
export function brandKey(text: unknown): string
export function brandNameOf(name: string): string
export function buildBrandIndex(icons: readonly SimpleIconLike[]): BrandIndex
export function matchSimpleIcon(
  input: { name: string; id?: string; domain?: string },
  index: BrandIndex
): { icon: SimpleIconLike; confidence: 'high' | 'medium' } | null

export function scoreCandidate(input: { source: string; width?: number; height?: number; vector?: boolean; kind?: string; maskable?: boolean }): number | null

export type RasterPlan =
  | { mode: 'bleed'; reason: string; flatten?: string }
  | { mode: 'logo'; reason: string; crop: { left: number; top: number; width: number; height: number }; backdrop: string }
export function analyzeRaster(rgba: Uint8Array | Buffer, width: number, height: number): RasterPlan

export function baseFileName(id: string): string
export interface IconIndex {
  byId: Record<string, string>
  byDomain: Record<string, string>
  byBrand: Record<string, string>
}
export function buildIndex(input: { entries: Array<{ id: string; domain?: string; file?: string }>; brandFiles?: Record<string, string> }): IconIndex
export function renderIndexModule(index: IconIndex, meta?: { generatedBy?: string }): string
