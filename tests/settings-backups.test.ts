import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearSettingsBackups, hasPlainMcpSecrets, listSettingsBackups } from '../src/main/settings-backups'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-bak-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const withSecret = JSON.stringify({ mcpServers: [{ name: 'a', command: 'x', args: [], enabled: true, env: { API_KEY: 'segredo-de-teste-123' } }] })
const withRef = JSON.stringify({ mcpServers: [{ name: 'a', command: 'x', args: [], enabled: true, env: { API_KEY: '${secret:a.API_KEY}', MODE: 'prod' } }] })

describe('hasPlainMcpSecrets', () => {
  it('flags a literal credential and accepts vault references and harmless values', () => {
    expect(hasPlainMcpSecrets(withSecret)).toBe(true)
    expect(hasPlainMcpSecrets(withRef)).toBe(false)
    expect(hasPlainMcpSecrets(JSON.stringify({ mcpServers: [{ name: 'h', headers: { Authorization: 'Bearer abc' } }] }))).toBe(true)
    expect(hasPlainMcpSecrets(JSON.stringify({ mcpServers: [] }))).toBe(false)
    expect(hasPlainMcpSecrets(JSON.stringify({ theme: 'dark' }))).toBe(false)
    // A file that cannot be read is treated as risky.
    expect(hasPlainMcpSecrets('{ não é json')).toBe(true)
  })
})

describe('settings.json.bak-* copies', () => {
  it('lists only the backup files, tells which ones hold secrets and never returns their content', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'settings.json'), withRef)
    fs.writeFileSync(path.join(dir, 'settings.json.bak-2026-10-27'), withSecret)
    fs.writeFileSync(path.join(dir, 'settings.json.bak-2026-10-27-040000'), withRef)
    fs.writeFileSync(path.join(dir, 'settings.json.tmp'), withSecret)
    fs.writeFileSync(path.join(dir, 'outro.bak-1'), withSecret)
    fs.mkdirSync(path.join(dir, 'settings.json.bak-pasta'))
    const list = await listSettingsBackups(dir)
    expect(list.map((item) => item.name).sort()).toEqual(['settings.json.bak-2026-10-27', 'settings.json.bak-2026-10-27-040000'])
    expect(list.find((item) => item.name === 'settings.json.bak-2026-10-27')?.mayHaveSecrets).toBe(true)
    expect(list.find((item) => item.name === 'settings.json.bak-2026-10-27-040000')?.mayHaveSecrets).toBe(false)
    expect(JSON.stringify(list)).not.toContain('segredo-de-teste-123')
  })

  it('removes exactly those files and leaves everything else alone', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'settings.json'), withRef)
    fs.writeFileSync(path.join(dir, 'secrets.bin'), 'cofre')
    fs.writeFileSync(path.join(dir, 'settings.json.bak-2026-10-27'), withSecret)
    fs.writeFileSync(path.join(dir, 'settings.json.bak-2026-10-28'), withSecret)
    fs.writeFileSync(path.join(dir, 'settings.json.tmp'), 'x')
    fs.mkdirSync(path.join(dir, 'settings.json.bak-pasta'))
    fs.writeFileSync(path.join(dir, 'settings.json.bak-pasta', 'dentro.txt'), 'x')
    expect(await clearSettingsBackups(dir)).toBe(2)
    expect(fs.readdirSync(dir).sort()).toEqual(['secrets.bin', 'settings.json', 'settings.json.bak-pasta', 'settings.json.tmp'])
    expect(fs.existsSync(path.join(dir, 'settings.json.bak-pasta', 'dentro.txt'))).toBe(true)
    expect(await listSettingsBackups(dir)).toEqual([])
    expect(await clearSettingsBackups(dir)).toBe(0)
  })

  it('treats a missing folder as having no copies', async () => {
    const dir = path.join(tempDir(), 'nao-existe')
    expect(await listSettingsBackups(dir)).toEqual([])
    expect(await clearSettingsBackups(dir)).toBe(0)
  })
})
