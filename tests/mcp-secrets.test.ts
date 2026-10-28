import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore, SETTINGS_VERSION, type SecretCrypto } from '../src/main/settings'
import {
  MASK,
  deriveCredentials,
  hasSecretRef,
  isMaskedSecret,
  isSecretName,
  maskSecret,
  secretRef,
  vaultKeyFor
} from '../src/main/mcp-secrets'
import type { McpServerSettings } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

const fakeCrypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (data) => {
    const raw = data.toString('utf8')
    if (!raw.startsWith('enc:')) throw new Error('not encrypted')
    return Buffer.from(raw.slice(4), 'base64').toString('utf8')
  }
}

const noCrypto: SecretCrypto = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('indisponível')
  },
  decryptString: () => {
    throw new Error('indisponível')
  }
}

const APPWRITE_KEY = 'standard_abcdef0123456789'
const GITHUB_TOKEN = 'ghp_SECRETTOKEN123456'
const JIRA_TOKEN = 'ATATT-token-value-9999'
const STRIPE_KEY = 'sk_live_1234567890abcdef'
const SHORT_SECRET = 'abc123'
const DB_URL = 'postgres://user:pa55word@db.local:5432/app'
const ALL_SECRETS = [APPWRITE_KEY, GITHUB_TOKEN, JIRA_TOKEN, STRIPE_KEY, SHORT_SECRET, 'pa55word']

function legacyServers(): McpServerSettings[] {
  return [
    {
      name: 'appwrite',
      command: 'uvx',
      args: ['mcp-server-appwrite'],
      env: { APPWRITE_API_KEY: APPWRITE_KEY, APPWRITE_PROJECT_ID: 'proj-1', APPWRITE_ENDPOINT: 'https://cloud.appwrite.io/v1' },
      enabled: true
    },
    {
      name: 'github',
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      command: '',
      args: [],
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-Region': 'sa' },
      enabled: true
    },
    {
      name: 'jira',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: { JIRA_URL: 'https://empresa.atlassian.net', JIRA_USERNAME: 'ana@empresa.com', JIRA_API_TOKEN: JIRA_TOKEN, MAX_TOKENS: '4096' },
      enabled: true
    },
    {
      name: 'stripe',
      command: 'npx',
      args: ['-y', '@stripe/mcp', `--api-key=${STRIPE_KEY}`],
      env: { STRIPE_SECRET_KEY: STRIPE_KEY },
      enabled: true
    },
    { name: 'small', command: 'x', args: [], env: { API_KEY: SHORT_SECRET }, enabled: true },
    { name: 'db', command: 'x', args: [], env: { DATABASE_URL: DB_URL }, enabled: true }
  ]
}

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('openclod-mcp-secrets-')
})

afterEach(async () => {
  await removeTempDir(dir)
})

function writeSettings(servers: McpServerSettings[]): string {
  const text = JSON.stringify({ settingsVersion: SETTINGS_VERSION, mcpServers: servers }, null, 2)
  fs.writeFileSync(path.join(dir, 'settings.json'), text)
  return text
}

function backups(): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.bak-')).sort()
}

/** Everything the app keeps in the config folder except the backups, as text. */
function configFilesText(): string {
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith('settings.json.bak-'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n')
}

async function migrated(): Promise<SettingsStore> {
  writeSettings(legacyServers())
  const store = new SettingsStore(dir, fakeCrypto)
  await store.init()
  return store
}

function serverOf(store: SettingsStore, name: string): McpServerSettings {
  return store.get().mcpServers.find((server) => server.name === name)!
}

describe('MCP credential helpers', () => {
  it('recognizes credential names and ignores numeric/flag names that merely contain "token"', () => {
    for (const name of ['APPWRITE_API_KEY', 'Authorization', 'X-Api-Key', 'JIRA_API_TOKEN', 'CLIENT_SECRET', 'DB_PASSWORD', 'Bearer']) {
      expect(isSecretName(name), name).toBe(true)
    }
    for (const name of ['MAX_TOKENS', 'TOKEN_LIMIT', 'APPWRITE_PROJECT_ID', 'JIRA_URL', 'JIRA_USERNAME', 'Content-Type']) {
      expect(isSecretName(name), name).toBe(false)
    }
  })

  it('masks with six bullets and the last two characters, keeps the auth scheme and round-trips', () => {
    expect(maskSecret(APPWRITE_KEY)).toBe(`${MASK}89`)
    expect(maskSecret(`Bearer ${GITHUB_TOKEN}`)).toBe(`Bearer ${MASK}56`)
    expect(maskSecret(SHORT_SECRET)).toBe(MASK)
    for (const value of [APPWRITE_KEY, `Bearer ${GITHUB_TOKEN}`, SHORT_SECRET]) expect(isMaskedSecret(maskSecret(value))).toBe(true)
    expect(isMaskedSecret('uma-chave-nova-123')).toBe(false)
  })

  it('builds references that cannot be broken by dots or braces in names', () => {
    expect(secretRef('jira', 'JIRA_API_TOKEN')).toBe('${secret:jira.JIRA_API_TOKEN}')
    expect(hasSecretRef(secretRef('a.b}c', 'K'))).toBe(true)
    expect(vaultKeyFor('a', 'K.K')).not.toBe(vaultKeyFor('a.K', 'K'))
  })

  it('turns a Basic header (email:token) into email + token for another server, and copies same-name keys', () => {
    const basic = `Basic ${Buffer.from('ana@empresa.com:ATATT-secret:with:colons').toString('base64')}`
    const derived = deriveCredentials({ headers: { Authorization: basic } }, ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'CONFLUENCE_USERNAME', 'CONFLUENCE_API_TOKEN'])
    expect(derived.values).toEqual({
      JIRA_USERNAME: 'ana@empresa.com',
      JIRA_API_TOKEN: 'ATATT-secret:with:colons',
      CONFLUENCE_USERNAME: 'ana@empresa.com',
      CONFLUENCE_API_TOKEN: 'ATATT-secret:with:colons'
    })
    expect(
      deriveCredentials({ env: { ATLASSIAN_EMAIL: 'ana@empresa.com', ATLASSIAN_API_TOKEN: 'tok-123456' } }, ['JIRA_USERNAME', 'JIRA_API_TOKEN']).values
    ).toEqual({ JIRA_USERNAME: 'ana@empresa.com', JIRA_API_TOKEN: 'tok-123456' })
    expect(deriveCredentials({ headers: { Authorization: 'Bearer abc.def' } }, ['SERVICE_TOKEN', 'SERVICE_USER']).values).toEqual({ SERVICE_TOKEN: 'abc.def' })
    expect(deriveCredentials({ env: { JIRA_URL: 'https://x' } }, ['JIRA_URL']).values).toEqual({ JIRA_URL: 'https://x' })
  })
})

describe('plain-text MCP credentials move to the vault', () => {
  it('migrates on load: no secret stays in settings.json, a backup keeps the old file, values resolve for the client', async () => {
    const original = writeSettings(legacyServers())
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()

    const onDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
    for (const secret of ALL_SECRETS) expect(onDisk, secret).not.toContain(secret)
    expect(onDisk).toContain('${secret:appwrite.APPWRITE_API_KEY}')
    expect(onDisk).toContain('${secret:github.Authorization}')
    // Not credentials: untouched.
    expect(serverOf(store, 'appwrite').env).toMatchObject({ APPWRITE_PROJECT_ID: 'proj-1', APPWRITE_ENDPOINT: 'https://cloud.appwrite.io/v1' })
    expect(serverOf(store, 'jira').env).toMatchObject({ JIRA_URL: 'https://empresa.atlassian.net', JIRA_USERNAME: 'ana@empresa.com', MAX_TOKENS: '4096' })
    expect(serverOf(store, 'github').headers).toMatchObject({ 'X-Region': 'sa' })
    // A secret that was also written into args is replaced there too.
    expect(serverOf(store, 'stripe').args).toEqual(['-y', '@stripe/mcp', '--api-key=${secret:stripe.STRIPE_SECRET_KEY}'])

    // The backup is the file as it was (it is the only plain copy; nothing is lost).
    expect(backups()).toHaveLength(1)
    const backup = fs.readFileSync(path.join(dir, backups()[0]), 'utf8')
    expect((JSON.parse(backup) as { mcpServers: McpServerSettings[] }).mcpServers).toEqual(JSON.parse(original).mcpServers)

    // The vault holds the values, encrypted; the client gets them filled in.
    expect(fs.readFileSync(path.join(dir, 'secrets.bin'), 'utf8')).not.toContain(APPWRITE_KEY)
    expect(store.mcpSecretValue('appwrite', 'APPWRITE_API_KEY')).toBe(APPWRITE_KEY)
    const github = store.resolveMcpServer(serverOf(store, 'github'))
    expect(github.missing).toEqual([])
    expect(github.server.headers).toEqual({ Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-Region': 'sa' })
    expect(store.resolveMcpServer(serverOf(store, 'stripe')).server.args).toEqual(['-y', '@stripe/mcp', `--api-key=${STRIPE_KEY}`])
    expect(store.resolveMcpServer(serverOf(store, 'db')).server.env).toEqual({ DATABASE_URL: DB_URL })

    // The startup log line names servers, never values.
    const note = store.migrations.join('\n')
    expect(note).toMatch(/segredo\(s\) de MCP movido\(s\)/)
    for (const secret of ALL_SECRETS) expect(note).not.toContain(secret)
  })

  it('is idempotent: a second start changes nothing and creates no new backup', async () => {
    await migrated()
    const before = configFilesText()
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.migrations.join(' ')).not.toMatch(/MCP/)
    expect(backups()).toHaveLength(1)
    expect(configFilesText()).toBe(before)
    expect(again.mcpSecretValue('github', 'Authorization')).toBe(`Bearer ${GITHUB_TOKEN}`)
  })

  it('never overwrites an older backup when plain credentials show up again the same day', async () => {
    await migrated()
    const first = backups()[0]
    const firstText = fs.readFileSync(path.join(dir, first), 'utf8')
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { mcpServers: McpServerSettings[] }
    settings.mcpServers.push({ name: 'late', command: 'x', args: [], env: { LATE_API_KEY: 'late-secret-value-1' }, enabled: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings))
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    expect(backups()).toHaveLength(2)
    expect(fs.readFileSync(path.join(dir, first), 'utf8')).toBe(firstText)
    expect(store.mcpSecretValue('late', 'LATE_API_KEY')).toBe('late-secret-value-1')
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).not.toContain('late-secret-value-1')
  })

  it('leaves the file alone (and does not throw) when the OS vault is unavailable', async () => {
    const original = writeSettings(legacyServers())
    const store = new SettingsStore(dir, noCrypto)
    await store.init()
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe(original)
    expect(backups()).toHaveLength(0)
    await store.update({ mcpServers: legacyServers() })
    expect(serverOf(store, 'appwrite').env?.APPWRITE_API_KEY).toBe(APPWRITE_KEY)
  })

  it('prints no secret to the console while migrating, masking, merging and saving', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
    try {
      const store = await migrated()
      await store.update({ mcpServers: store.maskedMcpServers() })
      const printed = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')
      for (const secret of ALL_SECRETS) expect(printed).not.toContain(secret)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})

describe('masked JSON for the editor', () => {
  it('masks every credential (env, headers, connection strings) and nothing else', async () => {
    const store = await migrated()
    const masked = store.maskedMcpServers()
    const byName = (name: string): McpServerSettings => masked.find((server) => server.name === name)!
    expect(byName('appwrite').env).toMatchObject({ APPWRITE_API_KEY: `${MASK}89`, APPWRITE_PROJECT_ID: 'proj-1' })
    expect(byName('github').headers).toEqual({ Authorization: `Bearer ${MASK}56`, 'X-Region': 'sa' })
    expect(byName('jira').env).toMatchObject({ JIRA_API_TOKEN: `${MASK}99`, JIRA_USERNAME: 'ana@empresa.com', MAX_TOKENS: '4096' })
    expect(byName('small').env).toEqual({ API_KEY: MASK })
    const text = JSON.stringify(masked)
    for (const secret of ALL_SECRETS) expect(text, secret).not.toContain(secret)
    // References are an implementation detail of the vault: the editor sees masked values in env and headers.
    const values = masked.flatMap((server) => [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})])
    expect(values.some((value) => hasSecretRef(value))).toBe(false)
  })

  it('saving the masked JSON keeps the stored secrets (merge) and applies the other edits', async () => {
    const store = await migrated()
    const masked = store.maskedMcpServers()
    masked.find((server) => server.name === 'appwrite')!.env!.APPWRITE_PROJECT_ID = 'proj-2'
    await store.update({ mcpServers: masked })

    const appwrite = store.resolveMcpServer(serverOf(store, 'appwrite')).server
    expect(appwrite.env).toMatchObject({ APPWRITE_API_KEY: APPWRITE_KEY, APPWRITE_PROJECT_ID: 'proj-2' })
    expect(store.resolveMcpServer(serverOf(store, 'github')).server.headers?.Authorization).toBe(`Bearer ${GITHUB_TOKEN}`)
    expect(store.resolveMcpServer(serverOf(store, 'small')).server.env?.API_KEY).toBe(SHORT_SECRET)
    const text = configFilesText()
    for (const secret of ALL_SECRETS) expect(text, secret).not.toContain(secret)
    expect(text).not.toContain('••••')

    // And it survives a restart.
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.resolveMcpServer(serverOf(again, 'appwrite')).server.env?.APPWRITE_API_KEY).toBe(APPWRITE_KEY)
  })

  it('a value typed over the mask becomes a new secret in the vault, never text in the file', async () => {
    const store = await migrated()
    const masked = store.maskedMcpServers()
    masked.find((server) => server.name === 'appwrite')!.env!.APPWRITE_API_KEY = 'brand-new-secret-value'
    masked.push({ name: 'fresh', command: 'x', args: [], env: { OPENAI_API_KEY: 'sk-fresh-abcdef123456', REGION: 'br' }, enabled: true })
    await store.update({ mcpServers: masked })

    expect(store.mcpSecretValue('appwrite', 'APPWRITE_API_KEY')).toBe('brand-new-secret-value')
    expect(store.mcpSecretValue('fresh', 'OPENAI_API_KEY')).toBe('sk-fresh-abcdef123456')
    expect(serverOf(store, 'fresh').env).toEqual({ OPENAI_API_KEY: '${secret:fresh.OPENAI_API_KEY}', REGION: 'br' })
    const text = configFilesText()
    expect(text).not.toContain('brand-new-secret-value')
    expect(text).not.toContain('sk-fresh-abcdef123456')
  })

  it('a masked value follows a renamed server and the old name loses its vault entries', async () => {
    const store = await migrated()
    const masked = store.maskedMcpServers()
    masked.find((server) => server.name === 'appwrite')!.name = 'appwrite-prod'
    await store.update({ mcpServers: masked })
    expect(store.resolveMcpServer(serverOf(store, 'appwrite-prod')).server.env?.APPWRITE_API_KEY).toBe(APPWRITE_KEY)
    expect(store.mcpSecretValue('appwrite', 'APPWRITE_API_KEY')).toBeUndefined()
  })

  it('drops a masked placeholder that has nothing behind it instead of saving it as a secret', async () => {
    const store = await migrated()
    const masked = store.maskedMcpServers()
    masked.push({ name: 'ghost', command: 'x', args: [], env: { API_KEY: `${MASK}ab`, REGION: 'br' }, enabled: true })
    await store.update({ mcpServers: masked })
    expect(serverOf(store, 'ghost').env).toEqual({ REGION: 'br' })
    expect(configFilesText()).not.toContain('••••')
  })

  it('forgets the secrets of a server removed from the list', async () => {
    const store = await migrated()
    expect(store.hasMcpSecrets('github')).toBe(true)
    await store.update({ mcpServers: store.maskedMcpServers().filter((server) => server.name !== 'github') })
    expect(store.hasMcpSecrets('github')).toBe(false)
    expect(store.hasMcpSecrets('appwrite')).toBe(true)
  })
})

describe('vault access for connectors', () => {
  it('stores and clears the credentials of one server without touching another whose name shares a prefix', async () => {
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    const refs = await store.setMcpSecrets('a', { TOKEN: 'token-of-a-111111', EMPTY: '  ' })
    await store.setMcpSecrets('a.b', { TOKEN: 'token-of-a-b-22222' })
    expect(refs).toEqual({ TOKEN: '${secret:a.TOKEN}' })
    expect(await store.clearMcpSecrets('a')).toBe(1)
    expect(store.mcpSecretValue('a', 'TOKEN')).toBeUndefined()
    expect(store.mcpSecretValue('a.b', 'TOKEN')).toBe('token-of-a-b-22222')
    expect(await store.clearMcpSecrets('a')).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'secrets.bin'), 'utf8')).not.toContain('token-of-a-b-22222')
  })

  it('refuses to keep credentials when the OS vault is unavailable', async () => {
    const store = new SettingsStore(dir, noCrypto)
    await store.init()
    await expect(store.setMcpSecrets('a', { TOKEN: 'token-of-a-111111' })).rejects.toThrow(/criptografia do sistema indisponível/)
  })

  it('reports a credential the vault no longer has instead of starting the server with half of them', async () => {
    writeSettings([
      { name: 'ghost', command: 'x', args: [], env: { API_KEY: '${secret:ghost.API_KEY}', REGION: 'br' }, headers: undefined, enabled: true }
    ])
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    const resolved = store.resolveMcpServer(serverOf(store, 'ghost'))
    expect(resolved.missing).toEqual(['ghost.API_KEY'])
    expect(resolved.server.env).toEqual({ REGION: 'br' })
  })

  it('lends the credentials of a configured server (Basic -> email + token) without exposing a value', async () => {
    const basic = `Basic ${Buffer.from(`ana@empresa.com:${JIRA_TOKEN}`).toString('base64')}`
    writeSettings([{ name: 'atlassian', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', command: '', args: [], headers: { Authorization: basic }, enabled: true }])
    const store = new SettingsStore(dir, fakeCrypto)
    await store.init()
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).not.toContain(basic)
    const source = store.mcpCredentialSource('atlassian')!
    expect(source.headers?.Authorization).toBe(basic)
    expect(deriveCredentials(source, ['JIRA_USERNAME', 'JIRA_API_TOKEN']).values).toEqual({ JIRA_USERNAME: 'ana@empresa.com', JIRA_API_TOKEN: JIRA_TOKEN })
    expect(store.mcpCredentialSource('nope')).toBeUndefined()
  })
})
