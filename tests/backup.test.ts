import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupService } from '../src/core/backup/service'
import { makeTempDir, removeTempDir } from './helpers'

describe('BackupService', () => {
  let root: string
  let backupFile: string
  beforeEach(async () => {
    root = await makeTempDir('openclod-backup-test-')
    fs.mkdirSync(path.join(root, 'data', 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(root, 'data', 'memory', 'projects', 'p1'), { recursive: true })
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true })
    fs.mkdirSync(path.join(root, 'skills', 's1'), { recursive: true })
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.mkdirSync(path.join(root, 'data', 'oauth'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data', 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', path: 'C:/p1', name: 'P1' }] }))
    fs.writeFileSync(path.join(root, 'data', 'sessions', 's1.json'), JSON.stringify({ meta: { id: 's1' }, messages: [] }))
    fs.writeFileSync(path.join(root, 'data', 'memory', 'projects', 'p1', 'page.md'), '# memory\n')
    fs.writeFileSync(path.join(root, 'agents', 'a.md'), '# agent\n')
    fs.writeFileSync(path.join(root, 'skills', 's1', 'SKILL.md'), '# skill\n')
    fs.writeFileSync(path.join(root, 'config', 'settings.json'), '{"theme":"dark"}')
    fs.writeFileSync(path.join(root, 'data', 'oauth', 'auth.json'), 'secret')
    backupFile = path.join(root, 'backups', 'test.openclod-backup.json.gz')
  })
  afterEach(async () => removeTempDir(root))

  it('creates a compressed backup that excludes secrets and verifies its checksum', async () => {
    const service = new BackupService(root, '0.1.0')
    const created = await service.create(backupFile)
    expect(created.files).toBe(6)
    expect(created.bytes).toBeGreaterThan(0)
    expect(await service.inspect(backupFile)).toEqual(created)
    const raw = fs.readFileSync(backupFile).toString('latin1')
    expect(raw).not.toContain('secret')
  })

  it('restores files after making a pre-restore backup', async () => {
    const service = new BackupService(root, '0.1.0')
    await service.create(backupFile)
    fs.writeFileSync(path.join(root, 'data', 'sessions', 's1.json'), '{"meta":{"id":"s1"},"messages":[{"x":1}]}')
    fs.writeFileSync(path.join(root, 'data', 'sessions', 'new.json'), '{"meta":{"id":"new"}}')
    const restored = await service.restore(backupFile)
    expect(restored.files).toBe(6)
    expect(fs.readFileSync(path.join(root, 'data', 'sessions', 's1.json'), 'utf8')).not.toContain('"x"')
    expect(fs.existsSync(path.join(root, 'data', 'sessions', 'new.json'))).toBe(true)
    expect(fs.existsSync(restored.preRestore.createdAt ? path.join(root, 'backups') : '')).toBe(true)
  })

  it('rejects a corrupted backup', async () => {
    const service = new BackupService(root)
    await service.create(backupFile)
    fs.writeFileSync(backupFile, 'broken')
    await expect(service.inspect(backupFile)).rejects.toThrow(/corrompido|inválido/)
  })
})

describe('BackupService on a real, messy profile', () => {
  let root: string
  beforeEach(async () => {
    root = await makeTempDir('openclod-backup-messy-')
    fs.mkdirSync(path.join(root, 'data', 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(root, 'skills', 's1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data', 'projects.json'), JSON.stringify({ projects: [] }))
    fs.writeFileSync(path.join(root, 'data', 'sessions', 's1.json'), '{"meta":{"id":"s1"},"messages":[]}')
    fs.writeFileSync(path.join(root, 'skills', 's1', 'SKILL.md'), '# skill\n')
  })
  afterEach(async () => removeTempDir(root))

  it('leaves out huge event journals and stray secret files instead of failing the whole backup', async () => {
    const journal = path.join(root, 'data', 'sessions', 's1.events.jsonl')
    fs.writeFileSync(journal, Buffer.alloc(40 * 1024 * 1024, 0x61))
    fs.writeFileSync(path.join(root, 'skills', 's1', '.env'), 'TOKEN=abc')
    const service = new BackupService(root, '0.1.0')
    const target = path.join(root, 'backups', 'messy.openclod-backup.json.gz')
    const created = await service.create(target)
    expect(created.files).toBe(3)
    expect(created.skipped?.sort()).toEqual(['data/sessions/s1.events.jsonl', 'skills/s1/.env'].sort())
    expect(fs.readFileSync(target).toString('latin1')).not.toContain('TOKEN=abc')
    expect(await service.inspect(target)).toEqual(created)
  })
})
