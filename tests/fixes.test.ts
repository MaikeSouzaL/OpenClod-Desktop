import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { applyEdit, editFileTool } from '../src/core/tools/fs'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { evaluateRules, globToRegExp, parseRule, ruleForApproval, ruleMatches, DEFAULT_RULES, mergeRules } from '../src/core/security/rules'
import { evaluateTool } from '../src/core/security/permissions'
import { parseToolArgs } from '../src/core/agent/runner'
import { SettingsStore, decodeSecretsFile, SETTINGS_VERSION, type SecretCrypto } from '../src/main/settings'
import { loadProjectSettings, ApprovalStore } from '../src/core/config/project'
import type { ToolContext, ToolDef } from '../src/core/tools/types'
import type { RiskLevel } from '../src/shared/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('openclod-fixes-')
})

afterEach(async () => {
  await removeTempDir(dir)
})

describe('applyEdit (edit_file core)', () => {
  it('writes $ replacement patterns literally', () => {
    const before = 'echo OLD\n'
    const out = applyEdit(before, 'OLD', 'cost $$ and $& and $1 and $` and $\'')
    expect(out).toMatchObject({ ok: true, occurrences: 1 })
    if (out.ok) expect(out.after).toBe("echo cost $$ and $& and $1 and $` and $'\n")
  })

  it('matches LF old_string against a CRLF file and keeps CRLF', () => {
    const before = 'a\r\nb\r\nc\r\n'
    const out = applyEdit(before, 'a\nb', 'x\ny')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.after).toBe('x\r\ny\r\nc\r\n')
  })

  it('tolerates typographic quotes in the file', () => {
    const before = 'const msg = “olá” — ‘ok’\n'
    const out = applyEdit(before, 'const msg = "olá" - \'ok\'', 'const msg = "tchau"')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.after).toBe('const msg = "tchau"\n')
  })

  it('reports ambiguity, missing text and identical strings', () => {
    expect(applyEdit('a a', 'a', 'b')).toMatchObject({ ok: false, error: 'ambiguous', occurrences: 2 })
    expect(applyEdit('a a', 'a', 'b', true)).toMatchObject({ ok: true, after: 'b b', occurrences: 2 })
    expect(applyEdit('abc', 'zzz', 'y')).toMatchObject({ ok: false, error: 'not_found' })
    expect(applyEdit('abc', 'b', 'b')).toMatchObject({ ok: false, error: 'identical' })
  })

  it('edit_file writes the literal text to disk', async () => {
    const file = path.join(dir, 'run.sh')
    fs.writeFileSync(file, 'echo $HOME\nPID=PLACEHOLDER\n')
    const tracker = new FileTracker(dir)
    tracker.markRead(file)
    const ctx = { cwd: dir, workspace: new WorkspaceGuard([dir]), tracker } as unknown as ToolContext
    const result = await editFileTool.execute({ path: 'run.sh', old_string: 'PLACEHOLDER', new_string: '$$' }, ctx)
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('echo $HOME\nPID=$$\n')
  })
})

describe('permission rules (Claude Code syntax)', () => {
  const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj'

  it('parses rules with and without patterns', () => {
    expect(parseRule('Bash')).toEqual({ tool: 'Bash', pattern: undefined })
    expect(parseRule('Bash(npm test:*)')).toEqual({ tool: 'Bash', pattern: 'npm test:*' })
    expect(parseRule('Bash(echo (a))')).toEqual({ tool: 'Bash', pattern: 'echo (a)' })
    expect(parseRule('  ')).toBeNull()
  })

  it('matches command prefixes, globs and exact commands', () => {
    expect(ruleMatches('Bash(npm test:*)', 'run_command', 'npm test', cwd)).toBe(true)
    expect(ruleMatches('Bash(npm test:*)', 'run_command', 'npm test -- --watch', cwd)).toBe(true)
    expect(ruleMatches('Bash(npm test:*)', 'run_command', 'npm testing', cwd)).toBe(false)
    expect(ruleMatches('Bash(git * --force)', 'run_command', 'git push origin --force', cwd)).toBe(true)
    expect(ruleMatches('run_command(ls)', 'run_command', 'ls', cwd)).toBe(true)
    expect(ruleMatches('Bash', 'start_process', 'npm run dev', cwd)).toBe(true)
  })

  it('matches paths by glob, basename and alias', () => {
    expect(ruleMatches('Edit(src/**)', 'edit_file', 'src/a/b.ts', cwd)).toBe(true)
    expect(ruleMatches('Edit(src/**)', 'edit_file', 'test/a.ts', cwd)).toBe(false)
    expect(ruleMatches('Read(.env)', 'read_file', 'config/.env', cwd)).toBe(true)
    expect(ruleMatches('Read(.env)', 'read_file', '.env.example', cwd)).toBe(false)
    expect(ruleMatches('Read(*.pem)', 'read_file', path.join(cwd, 'certs', 'server.pem'), cwd)).toBe(true)
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('a/c.ts')).toBe(false)
  })

  it('matches WebFetch domains and MCP servers', () => {
    expect(ruleMatches('WebFetch(domain:python.org)', 'fetch_url', 'https://docs.python.org/3/', cwd)).toBe(true)
    expect(ruleMatches('WebFetch(domain:python.org)', 'fetch_url', 'https://evil.org/python.org', cwd)).toBe(false)
    expect(ruleMatches('mcp__github', 'mcp__github__create_issue', '', cwd)).toBe(true)
  })

  it('applies deny > ask > allow', () => {
    const rules = { allow: ['Bash(git:*)'], ask: ['Bash(git push:*)'], deny: ['Bash(git push --force:*)'] }
    expect(evaluateRules(rules, 'run_command', 'git status', cwd)?.decision).toBe('allow')
    expect(evaluateRules(rules, 'run_command', 'git push origin', cwd)?.decision).toBe('ask')
    expect(evaluateRules(rules, 'run_command', 'git push --force origin', cwd)?.decision).toBe('deny')
    expect(evaluateRules(rules, 'run_command', 'npm test', cwd)).toBeNull()
  })

  it('builds the rule saved by "always allow"', () => {
    expect(ruleForApproval('run_command', 'npm run build')).toBe('Bash(npm run build)')
    expect(ruleMatches(ruleForApproval('run_command', 'npm run build'), 'run_command', 'npm run build', cwd)).toBe(true)
  })
})

describe('evaluateTool with rules', () => {
  const tool = (name: string, risk: RiskLevel): ToolDef =>
    ({ name, description: name, risk, parallelSafe: false, schema: z.object({}), describe: () => ({ title: name, detail: '' }), execute: async () => ({ ok: true, text: '' }) }) as ToolDef

  it('lets an allow rule skip the prompt in ask mode', () => {
    const p = policy({ mode: 'ask', rules: { allow: ['Bash(npm test:*)'], ask: [], deny: [] } })
    expect(evaluateTool(tool('run_command', 'exec'), 'npm test', p, dir).decision).toBe('allow')
    expect(evaluateTool(tool('run_command', 'exec'), 'npm publish', p, dir).decision).toBe('ask')
  })

  it('lets a deny rule block even in auto mode', () => {
    const p = policy({ mode: 'auto', rules: { allow: [], ask: [], deny: ['Bash(curl:*)'] } })
    expect(evaluateTool(tool('run_command', 'exec'), 'curl http://x', p, dir).decision).toBe('deny')
  })

  it('keeps read-only as a hard cap even with an allow rule', () => {
    const p = policy({ mode: 'readonly', rules: { allow: ['Write'], ask: [], deny: [] } })
    expect(evaluateTool(tool('write_file', 'write'), 'a.txt', p, dir).decision).toBe('deny')
  })

  it('asks before touching secret files by default, even in auto mode', () => {
    const p = policy({ mode: 'auto', rules: mergeRules(DEFAULT_RULES) })
    expect(evaluateTool(tool('read_file', 'read'), '.env', p, dir).decision).toBe('ask')
    expect(evaluateTool(tool('read_file', 'read'), '.env.example', p, dir).decision).toBe('allow')
    expect(evaluateTool(tool('write_file', 'write'), 'src/a.ts', p, dir).decision).toBe('allow')
  })
})

describe('parseToolArgs (argument repair)', () => {
  const tool = {
    schema: z.object({ path: z.string(), limit: z.number().int().optional(), all: z.boolean().optional(), ids: z.array(z.number()).optional() })
  }

  it('coerces numeric, boolean and JSON strings once', () => {
    const parsed = parseToolArgs(tool, { path: 'a', limit: '20', all: 'true', ids: '[1,2]' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual({ path: 'a', limit: 20, all: true, ids: [1, 2] })
  })

  it('still reports real problems', () => {
    expect(parseToolArgs(tool, { limit: 'muitos' }).success).toBe(false)
  })
})

const fakeCrypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (data) => {
    const raw = data.toString('utf8')
    if (!raw.startsWith('enc:')) throw new Error('not encrypted')
    return Buffer.from(raw.slice(4), 'base64').toString('utf8')
  }
}

describe('SettingsStore secrets and migration', () => {
  it('stores a key encrypted and reads it back after a restart', async () => {
    const first = new SettingsStore(dir, fakeCrypto)
    await first.init()
    await first.setSecret('openai', ' sk-test-123 ')
    expect(first.secretValue('openai')).toBe('sk-test-123')
    expect(first.resolver().get('openai')).toBe('sk-test-123')
    expect(first.get().providers.find((p) => p.id === 'openai')?.apiKeyRef).toBe('secret:openai')
    expect(fs.readFileSync(path.join(dir, 'secrets.bin'), 'utf8')).not.toContain('sk-test-123')

    const second = new SettingsStore(dir, fakeCrypto)
    await second.init()
    expect(second.secretValue('openai')).toBe('sk-test-123')
  })

  it('keeps a vault key linked when a stale provider list is saved', async () => {
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    await store.setSecret('deepseek', 'sk-deepseek')
    const staleProviders = store.get().providers.map((provider) =>
      provider.id === 'deepseek' ? { ...provider, apiKeyRef: 'env:DEEPSEEK_API_KEY' } : provider
    )

    await store.update({ providers: staleProviders })

    expect(store.get().providers.find((provider) => provider.id === 'deepseek')?.apiKeyRef).toBe('secret:deepseek')
    expect(store.resolver().get('deepseek')).toBe('sk-deepseek')
  })

  it('heals a stored key that an older build unlinked from its provider', async () => {
    const first = new SettingsStore(dir, fakeCrypto)
    await first.init()
    await first.setSecret('deepseek', 'sk-deepseek')
    const stale = first.get()
    stale.providers = stale.providers.map((provider) =>
      provider.id === 'deepseek' ? { ...provider, apiKeyRef: 'env:DEEPSEEK_API_KEY' } : provider
    )
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(stale))

    const second = new SettingsStore(dir, fakeCrypto)
    await second.init()

    expect(second.get().providers.find((provider) => provider.id === 'deepseek')?.apiKeyRef).toBe('secret:deepseek')
    expect(second.resolver().get('deepseek')).toBe('sk-deepseek')
  })

  it('backfills the three DeepSeek V4 effort levels once', async () => {
    const first = new SettingsStore(dir, fakeCrypto)
    await first.init()
    const old = first.get()
    old.settingsVersion = 5
    old.providers = old.providers.map((provider) =>
      provider.id === 'deepseek' ? { ...provider, effortLevels: ['max'] } : provider
    )
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(old))

    const migrated = new SettingsStore(dir, fakeCrypto)
    await migrated.init()
    expect(migrated.get().providers.find((provider) => provider.id === 'deepseek')?.effortLevels).toEqual([
      'low',
      'high',
      'max'
    ])
    expect(migrated.migrations.join(' ')).toMatch(/DeepSeek V4.*low\/high\/max/)

    // A later explicit choice (only max) is preserved on the next start.
    const settings = migrated.get()
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'deepseek' ? { ...provider, effortLevels: ['max'] } : provider
    )
    await migrated.update({ providers: settings.providers })
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.get().providers.find((provider) => provider.id === 'deepseek')?.effortLevels).toEqual(['max'])
  })

  it('removes the retired Scripted provider from an old settings file and falls back to DeepSeek', async () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 6,
        defaultProviderId: 'mock',
        lastModel: { providerId: 'mock', model: 'scripted' },
        providers: [
          { id: 'mock', kind: 'mock', label: 'Scripted (autoteste)', baseUrl: '', model: 'scripted' },
          { id: 'deepseek', kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }
        ]
      })
    )
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    const settings = store.get()
    expect(settings.providers.map((provider) => provider.id)).not.toContain('mock')
    expect(settings.providers.some((provider) => provider.kind === ('mock' as never))).toBe(false)
    expect(settings.defaultProviderId).toBe('deepseek')
    expect(settings.lastModel).toBeUndefined()
    expect(store.migrations.join(' ')).toContain('Scripted')

    // Persisted: the next start does not see it again, and nothing re-adds it.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { providers: Array<{ id: string }>; defaultProviderId: string }
    expect(saved.providers.map((provider) => provider.id)).not.toContain('mock')
    expect(saved.defaultProviderId).toBe('deepseek')
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.get().providers.map((provider) => provider.id)).not.toContain('mock')
    expect(again.migrations.join(' ')).not.toContain('Scripted')
  })

  it('reads the secrets file written by 0.1.0', () => {
    const legacyInner = Buffer.from(JSON.stringify({ openai: Buffer.from('sk-legacy', 'utf8').toString('base64') }), 'utf8').toString('base64')
    const file = fakeCrypto.encryptString(legacyInner)
    expect(decodeSecretsFile(file, fakeCrypto)).toEqual({ openai: 'sk-legacy' })
  })

  it('migrates old defaults to unrestricted mode once and adds secret-file rules', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ policy: { mode: 'ask', rules: { allow: ['Bash(ls)'] } } }))
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    const settings = store.get()
    expect(settings.policy.mode).toBe('unrestricted')
    expect(settings.settingsVersion).toBe(SETTINGS_VERSION)
    expect(settings.policy.rules?.allow).toContain('Bash(ls)')
    expect(settings.policy.rules?.ask).toContain('Read(.env)')
    expect(store.migrations.length).toBe(1)
    expect(settings.policy.allowComputerControl).toBe(true)

    // a later "ask" choice by the user is respected
    await store.update({ policy: { ...settings.policy, mode: 'ask' } })
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.get().policy.mode).toBe('ask')
  })

  it('migrates the old 3M turn cap to automatic and fills DeepSeek costs', async () => {
    const legacy = {
      settingsVersion: 3,
      policy: { mode: 'unrestricted' },
      limits: { maxTokens: 3_000_000 },
      providers: [
        {
          id: 'deepseek',
          kind: 'openai',
          label: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
          contextWindow: 1_048_576,
          supportsVision: false,
          supportsTools: true
        }
      ]
    }
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacy))
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    const settings = store.get()
    expect(settings.limits.maxTokens).toBe(0)
    expect(settings.providers.find((provider) => provider.id === 'deepseek')).toMatchObject({
      inputCostPerMTok: 0.3,
      outputCostPerMTok: 1.2,
      cachedInputCostPerMTok: 0.006
    })
    expect(store.migrations.some((message) => message.includes('3M'))).toBe(true)
  })

  it('removes the legacy microphone shortcut during migration', async () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 4,
        voice: { model: 'base', language: 'pt', shortcut: 'Control+Alt+Space' }
      })
    )
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    expect(store.get().voice?.shortcut).toBe('')
  })

  it('keeps an explicit read-only choice during migration', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ policy: { mode: 'readonly' } }))
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    expect(store.get().policy.mode).toBe('readonly')
  })
})

describe('project settings and saved approvals', () => {
  it('loads .openclod permissions and hooks, and .claude only when enabled', () => {
    fs.mkdirSync(path.join(dir, '.openclod'))
    fs.mkdirSync(path.join(dir, '.claude'))
    fs.writeFileSync(
      path.join(dir, '.openclod', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] } })
    )
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(secret.txt)'] } }))

    const openclodOnly = loadProjectSettings(dir)
    expect(openclodOnly.rules.allow).toEqual(['Bash(npm test:*)'])
    expect(openclodOnly.rules.deny).toEqual([])
    expect(openclodOnly.hooks.Stop).toHaveLength(1)

    const withClaude = loadProjectSettings(dir, { importClaude: true })
    expect(withClaude.rules.deny).toEqual(['Read(secret.txt)'])
    expect(withClaude.sources).toHaveLength(2)
  })

  it('persists "always allow" rules per project', () => {
    const store = new ApprovalStore(path.join(dir, 'permissions'))
    store.add('proj_1', 'Bash(npm test)')
    store.add('proj_1', 'Bash(npm test)')
    expect(store.load('proj_1')).toEqual(['Bash(npm test)'])
    expect(store.load('other')).toEqual([])
  })
})
