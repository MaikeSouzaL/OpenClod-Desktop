import fs from 'node:fs'
import path from 'node:path'
import { zipSync, type Zippable } from 'fflate'

/**
 * Pure file helpers for the Chrome extension, kept free of Electron so they can be tested: copy the bundled
 * extension to a stable per-user folder (Chrome keeps an unpacked extension by path, so that path must not
 * change when the app is updated or moved) and pack it into a .zip for sharing or the Chrome Web Store.
 */

export interface ExtensionFile {
  /** Path relative to the extension root, with forward slashes. */
  name: string
  data: Buffer
}

export function readExtensionFiles(dir: string): ExtensionFile[] {
  const files: ExtensionFile[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push({ name: path.relative(dir, full).split(path.sep).join('/'), data: fs.readFileSync(full) })
    }
  }
  walk(dir)
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

export function extensionVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Compares two dotted versions ("0.2.0" > "0.1.3"); unknown parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff) return diff < 0 ? -1 : 1
  }
  return 0
}

/**
 * Makes `target` an exact copy of `source`: copies new and changed files, removes files that no longer exist
 * in the source. Untouched files keep their timestamps. Returns what changed.
 */
export function syncExtensionFiles(source: string, target: string): { copied: string[]; removed: string[] } {
  const wanted = readExtensionFiles(source)
  const copied: string[] = []
  const removed: string[] = []
  fs.mkdirSync(target, { recursive: true })
  for (const file of wanted) {
    const destination = path.join(target, ...file.name.split('/'))
    const current = fs.existsSync(destination) ? fs.readFileSync(destination) : null
    if (current && current.equals(file.data)) continue
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, file.data)
    copied.push(file.name)
  }
  const names = new Set(wanted.map((file) => file.name))
  for (const file of fs.existsSync(target) ? readExtensionFiles(target) : []) {
    if (names.has(file.name)) continue
    fs.rmSync(path.join(target, ...file.name.split('/')), { force: true })
    removed.push(file.name)
  }
  return { copied, removed }
}

/** Zips the extension with `manifest.json` at the archive root (what Chrome and the Web Store expect). */
export function zipExtension(dir: string, destination: string): { path: string; bytes: number; files: number } {
  const entries: Zippable = {}
  const files = readExtensionFiles(dir).filter((file) => !/\.(md|map)$/i.test(file.name))
  for (const file of files) entries[file.name] = [new Uint8Array(file.data), { level: 9 }]
  const archive = zipSync(entries)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, archive)
  return { path: destination, bytes: archive.length, files: files.length }
}
