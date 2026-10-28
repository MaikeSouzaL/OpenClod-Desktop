// Tipos de scripts/lib/mcp-directory-core.mjs (para os testes em TypeScript).
import type { ConnectorAuth, ConnectorCategory, ConnectorDirectory, DirectoryConnector } from '../../src/shared/mcp-connectors'

export const CATEGORIES: ConnectorCategory[]
export const AUTH_KINDS: ConnectorAuth[]
export function slugify(name: string): string
export function transportForUrl(url: string): 'http' | 'sse'
export function normalizeUrl(raw: string): string
export function registrableDomain(host: string): string
export function iconDomainOf(input?: { iconUrl?: string; url?: string }): string | undefined
export function normalizeCategory(value: string): ConnectorCategory

/** Linha do harvest (colhida da ferramenta search_mcp_registry). */
export interface HarvestRow {
  u: string
  n: string
  d: string
  c: string
  url?: string
  i?: string
  t: string[]
  tc: number
}
/** Entrada de src/core/mcp/catalog.ts (McpCatalogEntry), so os campos usados aqui. */
export interface CatalogLike {
  id: string
  name: string
  description: string
  category: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Array<{ key: string; label: string; required?: boolean; secret?: boolean; example?: string }>
  headers?: Array<{ key: string; label: string; required?: boolean; secret?: boolean; example?: string }>
  basicAuth?: { user: string; password: string }
  oauth?: boolean
  docs?: string
  notes?: string
  approvalTools?: string[]
}
export function mapCatalogEntry(cat: CatalogLike): DirectoryConnector
export function mapHarvestRow(row: HarvestRow): DirectoryConnector
export function mergeDirectory(input: { harvest: HarvestRow[]; catalog: CatalogLike[]; previous?: DirectoryConnector[] }): DirectoryConnector[]
export function validateDirectory(directory: ConnectorDirectory | unknown): string[]
