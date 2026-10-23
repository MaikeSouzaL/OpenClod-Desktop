import fs from 'node:fs'
import path from 'node:path'

/**
 * Everything Forja needs at runtime ships inside the project (nothing is taken
 * from the user's global Python, PATH or caches):
 *
 *   resources/
 *     runtime/python/   embedded Python + site-packages (speech recognition)
 *     models/whisper/   speech models (CTranslate2 format), one folder per size
 *     bin/              native helpers (ripgrep, open-computer-use, ...)
 *     MANIFEST.json     what was bundled, versions, sizes, licenses
 *
 * Packaged app: `<install>/resources/resources` (electron-builder extraResources).
 * Development: `<project>/resources`.
 */

const MARKER = 'MANIFEST.json'

function candidates(): string[] {
  const list: string[] = []
  if (process.env.FORJA_RESOURCES) list.push(process.env.FORJA_RESOURCES)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) list.push(path.join(resourcesPath, 'resources'))
  list.push(path.resolve(process.cwd(), 'resources'))
  return list
}

let cached: string | null | undefined

/** Absolute path of the bundled resources folder, or null when it is missing. */
export function resourcesRoot(): string | null {
  if (cached !== undefined && cached !== null && fs.existsSync(cached)) return cached
  cached = candidates().find((dir) => fs.existsSync(path.join(dir, MARKER))) ?? null
  return cached
}

/** Test hook: forget the cached location (the environment may have changed). */
export function resetResourcesCache(): void {
  cached = undefined
}

/** `resources/<parts>`; null when the resources folder or the entry does not exist. */
export function resourcePath(...parts: string[]): string | null {
  const root = resourcesRoot()
  if (!root) return null
  const target = path.join(root, ...parts)
  return fs.existsSync(target) ? target : null
}

/** `resources/bin/<name>` (`.exe` added on Windows when missing); null when absent. */
export function bundledBinary(name: string): string | null {
  const file = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name
  return resourcePath('bin', file)
}
