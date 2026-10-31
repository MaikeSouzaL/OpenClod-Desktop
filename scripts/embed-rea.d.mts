// Tipos de scripts/embed-rea.mjs (para os testes em TypeScript).
export interface ReaRelease {
  version: string
  tag: string
  commit: string
  tarball: string
  file: string
  integrity: string
  windowsAddonSha256: string
}
export interface NodeRuntime {
  version: string
  file: string
  url: string
  sha256: string
  shasums: string
}
export interface ReaEngine {
  id: string
  name: string
  version: string
  url: string
  file: string
  sha256: string
  strip?: string
  archive?: 'file'
  env: Record<string, string>
  requiredPaths?: string[]
  extraFiles?: Record<string, string>
  vcRuntime?: string
  license: string
  sourceUrl?: string
  defaultOn?: boolean
}
export const REA_DIR: string
export const STATE_FILE: string
export const CATALOG_FILE: string
export const REA: ReaRelease
export const NODE: NodeRuntime
export const ENGINES: ReaEngine[]
export function treeDigest(dir: string): Promise<{ files: number; size: number; digest: string }>
