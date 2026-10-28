import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigTransferService } from '../src/core/config/transfer'
import { defaultSettings } from '../src/main/settings'
import { makeTempDir, removeTempDir } from './helpers'

describe('ConfigTransferService', () => {
  let root: string
  let service: ConfigTransferService

  beforeEach(async () => {
    root = await makeTempDir('openclod-config-transfer-')
    service = new ConfigTransferService()
  })
  afterEach(async () => removeTempDir(root))

  it('exports validated configuration without credentials, headers or secret env values', async () => {
    const settings = defaultSettings()
    settings.providers[0].apiKeyRef = 'plaintext-super-secret'
    settings.providers[0].baseUrl = 'https://example.com/v1?api_key=hidden'
    settings.mcpServers = [{
      name: 'jira',
      command: 'node',
      args: ['server.js', '--token=abc123'],
      env: { JIRA_TOKEN: 'secret-token', REGION: 'br' },
      headers: { Authorization: 'Bearer abc', 'X-Region': 'br' },
      enabled: true
    }]
    settings.hooks = {
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'http', url: 'https://hooks.example/x?token=hidden', headers: { Authorization: 'Bearer hidden' } }] }]
    }
    const target = path.join(root, 'settings.config.json')
    const result = await service.create(target, settings)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    const raw = fs.readFileSync(target, 'utf8')
    expect(raw).not.toContain('plaintext-super-secret')
    expect(raw).not.toContain('secret-token')
    expect(raw).not.toContain('Bearer abc')
    expect(raw).not.toContain('abc123')
    expect(raw).toContain('REGION')
    expect(raw).toContain('[REDACTED]')
    expect(result.warnings.length).toBeGreaterThan(3)
  })

  it('inspects a configuration and rejects wrong or incompatible files', async () => {
    const target = path.join(root, 'settings.config.json')
    await service.create(target, defaultSettings())
    const inspected = await service.inspect(target)
    expect(inspected.settings.providers?.length).toBeGreaterThan(0)
    expect(inspected.createdAt).toMatch(/^20/)

    fs.writeFileSync(target, JSON.stringify({ kind: 'other', version: 1, settings: {} }))
    await expect(service.inspect(target)).rejects.toThrow(/não é uma configuração/)
    fs.writeFileSync(target, JSON.stringify({ kind: 'openclod-config', version: 99, settings: {} }))
    await expect(service.inspect(target)).rejects.toThrow(/incompatível/)
    fs.writeFileSync(target, '{broken')
    await expect(service.inspect(target)).rejects.toThrow(/JSON/)
  })

  it('preserves current secret MCP env and headers when importing the same server', () => {
    const current = [{
      name: 'jira', command: 'node', args: [], enabled: true,
      env: { JIRA_TOKEN: 'current-secret', REGION: 'br' },
      headers: { Authorization: 'Bearer current', 'X-Region': 'br' }
    }]
    const imported = [{
      name: 'jira', command: 'node', args: [], enabled: true,
      env: { REGION: 'us' }
    }]
    const result = service.mergeSensitiveMcp(current, imported)
    expect(result.mergedFields).toBe(2)
    expect(result.servers[0].env).toEqual({ REGION: 'us', JIRA_TOKEN: 'current-secret' })
    expect(result.servers[0].headers).toEqual({ Authorization: 'Bearer current' })
  })
})
