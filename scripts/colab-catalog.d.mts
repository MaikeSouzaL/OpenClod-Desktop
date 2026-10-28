// Tipos de scripts/colab-catalog.mjs (para os testes em TypeScript).
export interface CatalogFamily {
  name: string
  label: string
  flags?: string
}
export interface ListingCard {
  caps: string[]
  sizes: string[]
}
export interface TagRow {
  ref: string
  tag: string
  digest: string
  context: string
  inputs: string[]
}
/** What the memory math needs from a GGUF header (only the keys the script keeps). */
export type GgufMetadata = Record<string, number | string | boolean | number[] | boolean[] | { count: number }>
export interface KvCache {
  kibPerToken: number
  fixedMiB: number
  maxContext: number
  arch: string
  moe: boolean
}
export interface CatalogEntry {
  tag: string
  family: string
  label: string
  flags: string
  sizeLabel: string
  quant: string
  weightsGB: number
  projectorGB: number
  kvKiB: number
  kvFixedMiB: number
  maxContext: number
  arch: string
  moe?: boolean
  vision: boolean
  audio: boolean
  tools: boolean
  thinking: boolean
  license: string
  requires: string
}
export const FAMILIES: CatalogFamily[]
export function parseListing(html: string): Map<string, ListingCard>
export function parseTags(html: string, family: string): TagRow[]
export function parseGgufHeader(buffer: Buffer): GgufMetadata
export function kvCache(metadata: GgufMetadata): KvCache | null
export function versionAtLeast(version: string, minimum: string): boolean
export function sizeLabelOf(tag: string, modelType?: string): string
export function leadingSize(tag: string): string
export function pickTags(rows: TagRow[]): TagRow[]
export function pythonRow(entry: CatalogEntry): string
export function catalogBlock(entries: CatalogEntry[], stamp: string): string
