import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkForUpdate, compareSemver, downloadUpdate } from '../src/main/updater'
import { makeTempDir, removeTempDir } from './helpers'

describe('application updater', () => {
  let root: string
  beforeEach(async () => { root = await makeTempDir('openclod-updater-') })
  afterEach(async () => removeTempDir(root))

  it('discovers a newer manifest and validates its platform asset', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      version: '1.2.0', notes: 'Correções', publishedAt: '2026-10-25T12:00:00Z',
      platforms: { win32: { url: 'https://example.com/Openclod.exe', sha256: 'a'.repeat(64), size: 123 } }
    }), { status: 200 })) as typeof fetch
    const result = await checkForUpdate('1.1.0', 'https://example.com/latest.json', { platform: 'win32', fetchImpl })
    expect(result).toMatchObject({ configured: true, available: true, latestVersion: '1.2.0', currentVersion: '1.1.0' })
    expect(result.asset?.platform).toBe('win32')
    expect(compareSemver('1.2.0', '1.1.9')).toBeGreaterThan(0)
  })

  it('downloads only an exact size and SHA-256 match', async () => {
    const bytes = Buffer.from('installer bytes')
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const target = path.join(root, 'update.exe')
    const okFetch = (async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })) as typeof fetch
    const result = await downloadUpdate({ url: 'https://example.com/a.exe', sha256, size: bytes.length, platform: 'win32' }, target, { fetchImpl: okFetch })
    expect(result).toMatchObject({ sha256, bytes: bytes.length })
    expect(fs.readFileSync(target)).toEqual(bytes)
    await expect(downloadUpdate({ url: 'https://example.com/a.exe', sha256: 'b'.repeat(64), size: bytes.length, platform: 'win32' }, path.join(root, 'bad.exe'), { fetchImpl: okFetch })).rejects.toThrow(/SHA-256/)
  })

  it('reports missing configuration and rejects insecure remote feeds', async () => {
    expect(await checkForUpdate('1.0.0', '')).toMatchObject({ configured: false, available: false })
    await expect(checkForUpdate('1.0.0', 'http://example.com/feed.json')).rejects.toThrow(/HTTPS/)
  })
})
