import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersions, extensionVersion, readExtensionFiles, syncExtensionFiles, zipExtension } from '../src/main/chrome/package'

const EXTENSION = path.join(__dirname, '..', 'resources', 'chrome-extension')
/** The id the native-messaging manifest allows (src/main/chrome/install.ts). */
const EXTENSION_ID = 'iflajofnlenfolhiemmfbonmiinnookf'

const temps: string[] = []
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-ext-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bundled Chrome extension', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8')) as {
    key: string
    version: string
    icons: Record<string, string>
    action: { default_popup: string; default_icon: Record<string, string> }
    background: { service_worker: string }
    commands: Record<string, { suggested_key: { default: string } }>
  }

  it('keeps the id that the native-messaging manifest allows, derived from the manifest key', () => {
    const der = Buffer.from(manifest.key, 'base64')
    const hash = crypto.createHash('sha256').update(der).digest().subarray(0, 16)
    const id = [...hash].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('')
    expect(id).toBe(EXTENSION_ID)
  })

  it('ships every file the manifest points to, with real PNG icons in the sizes Chrome uses', () => {
    const exists = (relative: string): boolean => fs.existsSync(path.join(EXTENSION, relative))
    expect(exists(manifest.background.service_worker)).toBe(true)
    expect(exists(manifest.action.default_popup)).toBe(true)
    for (const [size, file] of Object.entries({ ...manifest.icons, ...manifest.action.default_icon })) {
      expect(exists(file), file).toBe(true)
      const png = fs.readFileSync(path.join(EXTENSION, file))
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect(png.readUInt32BE(16), `${file} width`).toBe(Number(size))
      expect(png.readUInt32BE(20), `${file} height`).toBe(Number(size))
    }
    // The worker imports these with importScripts: a missing one would stop the whole extension.
    const worker = fs.readFileSync(path.join(EXTENSION, manifest.background.service_worker), 'utf8')
    const imports = /importScripts\(([^)]*)\)/.exec(worker)?.[1].match(/'([^']+)'/g) ?? []
    expect(imports.length).toBeGreaterThanOrEqual(3)
    for (const quoted of imports) expect(exists(quoted.replace(/'/g, '')), quoted).toBe(true)
    const popup = fs.readFileSync(path.join(EXTENSION, 'popup.html'), 'utf8')
    for (const asset of popup.match(/(?:src|href)="([^"]+)"/g) ?? []) {
      const target = /"([^"]+)"/.exec(asset)?.[1] ?? ''
      expect(exists(target), target).toBe(true)
    }
  })

  it('declares the stop shortcut and a version newer than the first release', () => {
    expect(manifest.commands['stop-agent'].suggested_key.default).toBe('Alt+Shift+S')
    expect(compareVersions(manifest.version, '0.1.3')).toBe(1)
    expect(extensionVersion(EXTENSION)).toBe(manifest.version)
  })
})

describe('extension packaging', () => {
  it('compares versions numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.2')).toBe(0)
    expect(compareVersions('0.1.3', '0.2.0')).toBe(-1)
  })

  it('copies the extension to a stable folder, skips unchanged files and removes stale ones', () => {
    const source = temp()
    const target = temp()
    fs.mkdirSync(path.join(source, 'icons'))
    fs.writeFileSync(path.join(source, 'manifest.json'), '{"version":"1.0.0"}')
    fs.writeFileSync(path.join(source, 'icons', '16.png'), Buffer.from([1, 2, 3]))

    const first = syncExtensionFiles(source, target)
    expect(first.copied.sort()).toEqual(['icons/16.png', 'manifest.json'])
    expect(fs.readFileSync(path.join(target, 'icons', '16.png'))).toEqual(Buffer.from([1, 2, 3]))

    expect(syncExtensionFiles(source, target)).toEqual({ copied: [], removed: [] })

    fs.writeFileSync(path.join(source, 'manifest.json'), '{"version":"1.1.0"}')
    fs.rmSync(path.join(source, 'icons', '16.png'))
    fs.writeFileSync(path.join(target, 'left-over.js'), 'old')
    const update = syncExtensionFiles(source, target)
    expect(update.copied).toEqual(['manifest.json'])
    expect(update.removed.sort()).toEqual(['icons/16.png', 'left-over.js'])
    expect(extensionVersion(target)).toBe('1.1.0')
  })

  it('zips the real extension with manifest.json at the archive root and identical contents', () => {
    const out = path.join(temp(), 'ext.zip')
    const result = zipExtension(EXTENSION, out)
    expect(result.files).toBeGreaterThanOrEqual(10)
    const archive = unzipSync(new Uint8Array(fs.readFileSync(out)))
    expect(Object.keys(archive)).toContain('manifest.json')
    expect(Object.keys(archive)).toContain('icons/128.png')
    expect(Object.keys(archive).every((name) => !name.startsWith('chrome-extension/') && !name.includes('\\'))).toBe(true)
    for (const file of readExtensionFiles(EXTENSION)) {
      if (/\.(md|map)$/i.test(file.name)) continue
      expect(Buffer.from(archive[file.name]).equals(file.data), file.name).toBe(true)
    }
  })
})
