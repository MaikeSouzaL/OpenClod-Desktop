import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretCrypto } from '../src/main/settings'
import type { McpServerSettings } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, safeStorage: {} }))

const { ConnectorService, catalogToDirectory, effectiveToolPolicy, looksUnauthorized, serverNameFor, MAX_MCP_SERVERS } = await import('../src/main/connector-service')
const { OAuthSetupError } = await import('../src/main/mcp-oauth')
const { SettingsStore } = await import('../src/main/settings')
const { resolveToolPolicy } = await import('../src/core/mcp/policy')

const fakeCrypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (data) => {
    const raw = data.toString('utf8')
    if (!raw.startsWith('enc:')) throw new Error('not encrypted')
    return Buffer.from(raw.slice(4), 'base64').toString('utf8')
  }
}

const GITHUB_TOKEN = 'ghp_SECRETTOKEN123456'

interface FakeClientSpec {
  state: 'ready' | 'error' | 'starting'
  lastError?: string | null
  reconnectAttempt?: number
  tools?: Array<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>
}

/** Same surface the connector service reads from McpClient; the policy comes from the real rule, read live from settings. */
function fakeClient(spec: FakeClientSpec, config: () => McpServerSettings | undefined = () => undefined): never {
  const policies = () =>
    (spec.tools ?? []).map((tool) => ({ description: '', inputSchema: {}, ...tool, policy: resolveToolPolicy(config() ?? {}, tool.name, tool.annotations) }))
  return {
    state: spec.state,
    lastError: spec.lastError ?? null,
    reconnectAttempt: spec.reconnectAttempt ?? 0,
    toolsList: () => policies().filter((tool) => tool.policy.exposed),
    toolPolicies: policies
  } as never
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('openclod-connectors-')
})

afterEach(async () => {
  await removeTempDir(dir)
})

const CLAUDE_ENTRY = {
  id: 'acme',
  name: 'Acme',
  description: 'Acme CRM',
  category: 'vendas-crm',
  kind: 'remote',
  transport: 'http',
  url: 'https://mcp.acme.example/mcp',
  auth: 'oauth-static',
  oauthClientId: 'openclod-public',
  oauthScopes: 'contacts.read deals.read',
  tools: ['search_contacts'],
  source: 'claude-directory'
}

async function harness(directory: unknown = null) {
  const store = new SettingsStore(dir, fakeCrypto)
  await store.init()
  const clients = new Map<string, never>()
  const behavior = new Map<string, FakeClientSpec>()
  const started = new Map<string, McpServerSettings>()
  const issues = new Map<string, string[]>()
  const counters = { restarts: 0, changes: 0, refreshes: 0, restarted: [] as Array<string | undefined> }
  const oauth = {
    preferredRedirectUri: 'http://127.0.0.1:38565/callback',
    begin: vi.fn(),
    prepareAuthorization: vi.fn(),
    token: vi.fn(async () => null as string | null),
    status: vi.fn((): { total: number; connected: number; expiresAt?: number; account?: string } => ({ total: 0, connected: 0 })),
    revoke: vi.fn(async () => ({ revoked: true, supported: true }))
  }
  const service = new ConnectorService({
    settings: store,
    oauth: oauth as never,
    clients: () => clients as never,
    restart: async (serverName?: string) => {
      counters.restarts++
      counters.restarted.push(serverName)
      clients.clear()
      for (const server of store.get().mcpServers) {
        if (!server.enabled) continue
        started.set(server.name, store.resolveMcpServer(server).server)
        const live = (): McpServerSettings | undefined => store.get().mcpServers.find((item) => item.name === server.name)
        clients.set(server.name, fakeClient(behavior.get(server.name) ?? { state: 'ready', tools: [{ name: 'tool_one' }] }, live))
      }
    },
    refreshTools: () => void counters.refreshes++,
    emitChanged: () => void counters.changes++,
    secretIssues: () => issues,
    challenge: () => undefined,
    loadDirectoryFile: () => directory
  })
  return { store, service, clients, behavior, started, issues, counters, oauth }
}

function settingsText(): string {
  return fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
}

describe('connector directory', () => {
  it('turns the curated catalog into directory entries until the generated file exists', async () => {
    const { service } = await harness(null)
    const entries = service.directory().entries
    const byId = (id: string) => entries.find((entry) => entry.id === id)!
    expect(entries.length).toBeGreaterThan(20)
    expect(entries.every((entry) => entry.source === 'openclod-catalog' && entry.category && entry.name)).toBe(true)
    expect(byId('atlassian')).toMatchObject({ auth: 'oauth', kind: 'remote', transport: 'http', url: 'https://mcp.atlassian.com/v2/mcp' })
    expect(byId('github')).toMatchObject({ auth: 'api-key', credentials: [{ key: 'Authorization', where: 'header', required: true, secret: true }] })
    expect(byId('atlassian-token').auth).toBe('api-key')
    expect(byId('jira')).toMatchObject({ auth: 'local-env', kind: 'local', command: 'uvx' })
    expect(byId('jira').credentials?.some((credential) => credential.key === 'JIRA_API_TOKEN' && credential.secret)).toBe(true)
    expect(byId('playwright').auth).toBe('none')
    expect(catalogToDirectory).toBeTypeOf('function')
  })

  it('accepts every entry of the generated resources/mcp-directory.json (the contract between the two sides)', () => {
    const file = path.join(process.cwd(), 'resources', 'mcp-directory.json')
    if (!fs.existsSync(file)) return
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<{ id: string }> }
    const service = new ConnectorService({ loadDirectoryFile: undefined } as never)
    const entries = service.directory().entries
    const ids = new Set(entries.map((entry) => entry.id))
    // Nothing the file lists is dropped by the defensive reader, and ids stay unique.
    expect(raw.entries.filter((entry) => !ids.has(entry.id)).map((entry) => entry.id)).toEqual([])
    expect(ids.size).toBe(entries.length)
    expect(entries.every((entry) => (entry.transport === 'stdio' ? Boolean(entry.command) : true))).toBe(true)
  })

  it('reads the generated file defensively and keeps the catalog entries it does not list', async () => {
    const { service } = await harness({
      generatedAt: 5,
      entries: [CLAUDE_ENTRY, { id: 'broken' }, { id: 'odd', name: 'Odd', transport: 'http', url: 'https://odd.example/mcp', auth: 'telepathy', source: 'x' }, { ...CLAUDE_ENTRY, id: 'github', name: 'GitHub (Claude)' }]
    })
    const directory = service.directory()
    expect(directory.generatedAt).toBe(5)
    const ids = directory.entries.map((entry) => entry.id)
    expect(ids).not.toContain('broken')
    expect(directory.entries.find((entry) => entry.id === 'odd')).toMatchObject({ auth: 'unknown', kind: 'remote', tools: [], source: 'openclod-catalog' })
    // The file wins on a clashing id; catalog-only entries stay connectable.
    expect(directory.entries.find((entry) => entry.id === 'github')?.name).toBe('GitHub (Claude)')
    expect(ids).toContain('atlassian')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('connector states', () => {
  async function seeded() {
    const h = await harness({ entries: [CLAUDE_ENTRY] })
    await h.store.update({
      mcpServers: [
        { name: 'github', type: 'http', url: 'https://api.githubcopilot.com/mcp/', command: '', args: [], headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }, enabled: true },
        { name: 'atlassian', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', command: '', args: [], enabled: true },
        { name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp', command: '', args: [], enabled: true },
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: true },
        { name: 'jira', command: 'uvx', args: ['mcp-atlassian'], enabled: false },
        { name: 'filesystem', command: 'npx', args: [], enabled: true },
        { name: 'meu-servidor', type: 'http', url: 'https://x.example/mcp', command: '', args: [], enabled: true },
        { name: 'atlassian-velho', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp/', command: '', args: [], enabled: true }
      ]
    })
    h.clients.set('github', fakeClient({ state: 'error', lastError: 'HTTP 401 em initialize: {"error":"Bad credentials"}' }))
    h.clients.set('atlassian', fakeClient({ state: 'error', lastError: 'HTTP 401 em initialize: unauthorized' }))
    h.clients.set('context7', fakeClient({ state: 'ready', tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }))
    h.clients.set('playwright', fakeClient({ state: 'error', lastError: 'spawn npx ENOENT' }))
    h.clients.set('meu-servidor', fakeClient({ state: 'starting' }))
    h.oauth.status.mockImplementation((name?: string) =>
      name === 'context7' ? { total: 1, connected: 1, expiresAt: 1_900_000_000_000, account: 'ana@example.com' } : { total: 0, connected: 0 }
    )
    return h
  }

  it('reports every status the card needs, with a hint for each known failure', async () => {
    const { service } = await seeded()
    const states = service.states()
    const byId = (id: string) => states.find((state) => state.id === id)!

    expect(byId('context7')).toMatchObject({ status: 'connected', toolCount: 3, detail: '3 ferramentas', connectedAs: 'ana@example.com', tokenExpiresAt: 1_900_000_000_000, serverName: 'context7' })
    // A static Authorization header that the server refuses: no OAuth attempt, the hint says what to do.
    expect(byId('github')).toMatchObject({ status: 'needs-auth', detail: 'Credencial recusada pelo servidor' })
    expect(byId('github').hint).toMatch(/recusou a credencial do cabeçalho \(Authorization\)/)
    expect(byId('github').lastError).toContain('401')
    expect(byId('atlassian')).toMatchObject({ status: 'needs-auth', detail: 'Precisa entrar com sua conta' })
    expect(byId('playwright').status).toBe('error')
    expect(byId('playwright').hint).toMatch(/comando|encontrado/i)
    expect(byId('jira')).toMatchObject({ status: 'disabled', serverName: 'jira' })
    expect(byId('filesystem')).toMatchObject({ status: 'connecting' })
    expect(byId('meu-servidor')).toMatchObject({ status: 'connecting', serverName: 'meu-servidor' })
    // An OAuth entry that is not installed still tells which return URL to register and which client id it would use.
    expect(byId('acme')).toEqual({
      id: 'acme',
      status: 'not-installed',
      redirectUri: 'http://127.0.0.1:38565/callback',
      oauthClient: { clientId: 'openclod-public', hasSecret: false, source: 'directory' }
    })
    // The state of a server added by hand carries the server name as id.
    expect(states.filter((state) => state.status !== 'not-installed').map((state) => state.id)).toContain('atlassian-velho')
  })

  it('maps an imported server to the directory entry with the same URL when that URL is unambiguous', async () => {
    const { service, store, clients } = await harness({ entries: [CLAUDE_ENTRY] })
    await store.update({ mcpServers: [{ name: 'Acme CRM', type: 'http', url: 'https://mcp.acme.example/mcp/', command: '', args: [], enabled: true }] })
    clients.set('Acme CRM', fakeClient({ state: 'ready', tools: [{ name: 'a' }] }))
    expect(service.states().find((state) => state.id === 'acme')).toMatchObject({ status: 'connected', serverName: 'Acme CRM', toolCount: 1, detail: '1 ferramenta' })
    expect(service.states().some((state) => state.id === 'Acme CRM')).toBe(false)
  })

  it('explains the Atlassian Rovo case (Basic header refused) without trying OAuth by itself', async () => {
    const { service, store, clients, oauth } = await harness(null)
    const basic = `Basic ${Buffer.from('ana@empresa.com:ATATT-token-value-9999').toString('base64')}`
    await store.update({
      mcpServers: [{ name: 'atlassian', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', command: '', args: [], headers: { Authorization: basic }, enabled: true }]
    })
    clients.set('atlassian', fakeClient({ state: 'error', lastError: "HTTP 401 em initialize: You don't have permission to connect via API token" }))
    const state = service.stateById('atlassian')
    expect(state).toMatchObject({ status: 'needs-auth', detail: 'Credencial recusada pelo servidor' })
    expect(state.hint).toMatch(/Rovo MCP/)
    expect(state.hint).toMatch(/OAuth/)
    expect(oauth.begin).not.toHaveBeenCalled()
    expect(JSON.stringify(state)).not.toContain('ATATT-token-value-9999')
  })

  it('shows a lost connection that the client is retrying as connecting, but not an authentication failure', async () => {
    const { service, store, clients } = await harness(null)
    await store.update({ mcpServers: [{ name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp', command: '', args: [], enabled: true }] })
    clients.set('context7', fakeClient({ state: 'error', lastError: 'fetch failed: ECONNRESET', reconnectAttempt: 2 }))
    expect(service.stateById('context7')).toMatchObject({ status: 'connecting', detail: 'Reconectando… (tentativa 2)' })
    clients.set('context7', fakeClient({ state: 'error', lastError: 'HTTP 401 em tools/list', reconnectAttempt: 2 }))
    expect(service.stateById('context7').status).toBe('needs-auth')
  })

  it('shows a credential the vault lost as needing authentication', async () => {
    const { service, issues } = await seeded()
    issues.set('github', ['Authorization'])
    expect(service.stateById('github')).toMatchObject({ status: 'needs-auth', detail: 'Credencial ausente do cofre' })
    expect(service.stateById('github').lastError).toContain('Authorization')
  })

  it('never starts a login by itself: listing states only reads', async () => {
    const { service, oauth } = await seeded()
    service.states()
    expect(oauth.begin).not.toHaveBeenCalled()
  })

  it('recognizes authentication failures and nothing else', () => {
    for (const text of ['HTTP 401 em initialize', 'Unauthorized', 'invalid_token', 'API token not allowed for this org', 'authentication required']) {
      expect(looksUnauthorized(text), text).toBe(true)
    }
    for (const text of ['ECONNREFUSED 127.0.0.1:1', 'HTTP 500 em tools/list', 'timeout de MCP x.initialize', '', null]) {
      expect(looksUnauthorized(text), String(text)).toBe(false)
    }
  })
})

describe('connect', () => {
  it('saves an API-key connector with the token in the vault, not in settings.json, and starts it with the real value', async () => {
    const { service, store, started, counters } = await harness(null)
    const result = await service.connect('github', { credentials: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
    expect(result.authUrl).toBeUndefined()
    expect(result.state).toMatchObject({ id: 'github', serverName: 'github', status: 'connected' })
    // Only this connector's server is restarted; the others keep running.
    expect(counters.restarted).toEqual(['github'])
    expect(settingsText()).not.toContain(GITHUB_TOKEN)
    expect(settingsText()).toContain('${secret:github.Authorization}')
    expect(fs.readFileSync(path.join(dir, 'secrets.bin'), 'utf8')).not.toContain(GITHUB_TOKEN)
    expect(started.get('github')?.headers).toEqual({ Authorization: `Bearer ${GITHUB_TOKEN}` })
    expect(service.maskedSettings()[0].headers).toEqual({ Authorization: 'Bearer ••••••56' })
    expect(store.get().mcpServers[0].approvalTools).toBeUndefined()
  })

  it('asks for the required fields instead of saving half a connector', async () => {
    const { service, store, counters } = await harness(null)
    const result = await service.connect('github', {})
    expect(result.state).toMatchObject({ id: 'github', status: 'needs-auth', detail: 'Faltam credenciais: Authorization' })
    expect(store.get().mcpServers).toEqual([])
    expect(counters.restarts).toBe(0)
  })

  it('treats credentials the directory marks as secret as secrets even when the name does not say so', async () => {
    const { service, store, started } = await harness({
      entries: [
        {
          id: 'local-crm',
          name: 'CRM local',
          description: '',
          category: 'vendas-crm',
          kind: 'local',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'crm-mcp', '--workspace=${WORKSPACE}'],
          auth: 'local-env',
          credentials: [
            { key: 'WORKSPACE', label: 'Workspace', where: 'env', required: true, secret: true },
            { key: 'REGION', label: 'Região', where: 'env' }
          ],
          tools: [],
          source: 'claude-directory'
        },
        {
          id: 'remote-crm',
          name: 'CRM remoto',
          description: '',
          category: 'vendas-crm',
          kind: 'remote',
          transport: 'http',
          url: 'https://crm.example/mcp',
          auth: 'api-key',
          credentials: [{ key: 'X-Api-Key', label: 'Chave', where: 'header', required: true, prefix: 'Bearer ' }],
          tools: [],
          source: 'claude-directory'
        }
      ]
    })
    await service.connect('local-crm', { credentials: { WORKSPACE: 'ws-secret-value-1', REGION: 'br' } })
    expect(settingsText()).not.toContain('ws-secret-value-1')
    const saved = store.get().mcpServers.find((server) => server.name === 'local-crm')!
    expect(saved.env).toEqual({ WORKSPACE: '${secret:local-crm.WORKSPACE}', REGION: 'br' })
    expect(saved.args).toEqual(['-y', 'crm-mcp', '--workspace=${secret:local-crm.WORKSPACE}'])
    expect(started.get('local-crm')?.args).toEqual(['-y', 'crm-mcp', '--workspace=ws-secret-value-1'])

    await service.connect('remote-crm', { credentials: { 'X-Api-Key': 'key-value-123456' } })
    expect(started.get('remote-crm')?.headers).toEqual({ 'X-Api-Key': 'Bearer key-value-123456' })
    expect(settingsText()).not.toContain('key-value-123456')
  })

  it('keeps the tool permissions the user chose when a connector is reconnected', async () => {
    const { service, store } = await harness(null)
    await service.connect('github', { credentials: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
    await service.setToolPolicy('github', 'create_issue', 'deny')
    await service.connect('github', { credentials: { Authorization: 'Bearer ghp_OTHERTOKEN7654321' } })
    expect(store.get().mcpServers.find((server) => server.name === 'github')?.toolPolicy).toEqual({ create_issue: 'deny' })
    expect(store.mcpSecretValue('github', 'Authorization')).toBe('Bearer ghp_OTHERTOKEN7654321')
  })

  it('opens the OAuth login and returns its page at once; the server starts when the login finishes', async () => {
    const { service, store, oauth, counters, clients } = await harness(null)
    const login = deferred<string | null>()
    oauth.begin.mockResolvedValue({ authUrl: 'https://auth.atlassian.example/authorize?x=1', completion: login.promise, cancel: vi.fn() })
    const result = await service.connect('atlassian')
    expect(result.authUrl).toBe('https://auth.atlassian.example/authorize?x=1')
    expect(result.state).toMatchObject({ status: 'connecting', detail: 'Aguardando você concluir o login no navegador' })
    expect(store.get().mcpServers.map((server) => server.name)).toEqual(['atlassian'])
    expect(oauth.begin).toHaveBeenCalledWith('atlassian', 'https://mcp.atlassian.com/v2/mcp', undefined, { clientId: undefined, scopes: undefined })
    expect(counters.restarts).toBe(0)

    login.resolve('token-1')
    await vi.waitFor(() => expect(counters.restarted).toEqual(['atlassian']))
    expect(service.stateById('atlassian').status).toBe('connected')
    expect(clients.has('atlassian')).toBe(true)
  })

  it('passes the directory public client id and scopes to the login (oauth-static)', async () => {
    const { service, oauth } = await harness({ entries: [CLAUDE_ENTRY] })
    oauth.begin.mockResolvedValue({ authUrl: 'https://a.example/authorize', completion: new Promise(() => undefined), cancel: vi.fn() })
    await service.connect('acme')
    expect(oauth.begin).toHaveBeenCalledWith('acme', 'https://mcp.acme.example/mcp', undefined, { clientId: 'openclod-public', scopes: 'contacts.read deals.read' })
    expect(service.oauthOptions('acme')).toEqual({ clientId: 'openclod-public', scopes: 'contacts.read deals.read' })
  })

  describe('oauth-static without a directory client id: the user brings an OAuth app', () => {
    const STATIC = { ...CLAUDE_ENTRY, id: 'slackish', name: 'Slackish', url: 'https://mcp.slackish.example/mcp', oauthClientId: undefined, oauthScopes: undefined }
    const SECRET = 'app-secret-value-abcdef'
    const pending = () => ({
      authUrl: 'https://auth.slackish.example/authorize',
      redirectUri: 'http://127.0.0.1:38565/callback',
      redirectUriFallback: false,
      completion: new Promise<string | null>(() => undefined),
      cancel: vi.fn()
    })

    it('asks for the client id, with the exact return URL to register, and installs nothing', async () => {
      const { service, store, oauth, counters } = await harness({ entries: [STATIC] })
      const result = await service.connect('slackish')
      expect(result.state).toMatchObject({
        id: 'slackish',
        status: 'needs-auth',
        detail: 'Informe o client ID do aplicativo OAuth',
        redirectUri: 'http://127.0.0.1:38565/callback'
      })
      expect(result.state.hint).toContain('cadastre exatamente esta URL de retorno: http://127.0.0.1:38565/callback')
      expect(store.get().mcpServers).toEqual([])
      expect(oauth.begin).not.toHaveBeenCalled()
      expect(counters.restarts).toBe(0)
      // The state of the not-installed card tells the interface the same, so it can show the form up front.
      expect(service.stateById('slackish')).toEqual({ id: 'slackish', status: 'not-installed', redirectUri: 'http://127.0.0.1:38565/callback' })
    })

    it('uses the app the user typed, keeps the secret in the vault only, and reuses it on the next connect', async () => {
      const { service, store, oauth } = await harness({ entries: [STATIC] })
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
      try {
        oauth.begin.mockResolvedValue(pending())
        const first = await service.connect('slackish', { oauthClient: { clientId: '  my-app-id  ', clientSecret: SECRET } })
        expect(oauth.begin).toHaveBeenCalledWith('slackish', 'https://mcp.slackish.example/mcp', undefined, { clientId: 'my-app-id', clientSecret: SECRET, scopes: undefined })
        expect(first.authUrl).toBe('https://auth.slackish.example/authorize')
        expect(first.state).toMatchObject({
          status: 'connecting',
          redirectUri: 'http://127.0.0.1:38565/callback',
          oauthClient: { clientId: 'my-app-id', hasSecret: true, source: 'user' }
        })
        // Vault: `mcp:<server>.oauth_client_secret`; nothing in settings.json, the state or the console.
        expect(store.mcpSecretValue('slackish', 'oauth_client_secret')).toBe(SECRET)
        expect(settingsText()).not.toContain(SECRET)
        expect(fs.readFileSync(path.join(dir, 'secrets.bin'), 'utf8')).not.toContain(SECRET)
        expect(JSON.stringify(service.states())).not.toContain(SECRET)
        expect(spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')).not.toContain(SECRET)

        // Reconnecting does not ask again: the saved client is used.
        oauth.begin.mockClear()
        oauth.begin.mockResolvedValue(pending())
        await service.connect('slackish')
        expect(oauth.begin).toHaveBeenCalledWith('slackish', 'https://mcp.slackish.example/mcp', undefined, { clientId: 'my-app-id', clientSecret: SECRET, scopes: undefined })
        expect(service.oauthOptions('slackish')).toEqual({ clientId: 'my-app-id', clientSecret: SECRET, scopes: undefined })
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
    })

    it('a new client without a secret does not keep the secret of the previous one; disconnecting deletes it all', async () => {
      const { service, store, oauth } = await harness({ entries: [STATIC] })
      oauth.begin.mockResolvedValue(pending())
      await service.connect('slackish', { oauthClient: { clientId: 'first-app', clientSecret: SECRET } })
      await service.connect('slackish', { oauthClient: { clientId: 'second-app' } })
      expect(store.mcpSecretValue('slackish', 'oauth_client_id')).toBe('second-app')
      expect(store.mcpSecretValue('slackish', 'oauth_client_secret')).toBeUndefined()
      expect(service.stateById('slackish').oauthClient).toEqual({ clientId: 'second-app', hasSecret: false, source: 'user' })

      await service.disconnect('slackish')
      expect(store.hasMcpSecrets('slackish')).toBe(false)
      expect(service.stateById('slackish').oauthClient).toBeUndefined()
    })

    it('the saved client goes away with the server when it is removed from the list another way', async () => {
      const { service, store, oauth } = await harness({ entries: [STATIC] })
      oauth.begin.mockResolvedValue(pending())
      await service.connect('slackish', { oauthClient: { clientId: 'first-app', clientSecret: SECRET } })
      await store.update({ mcpServers: [] })
      expect(store.hasMcpSecrets('slackish')).toBe(false)
    })

    it('refuses an id that cannot be one', async () => {
      const { service } = await harness({ entries: [STATIC] })
      await expect(service.connect('slackish', { oauthClient: { clientId: '   ' } })).rejects.toThrow(/client ID/)
      await expect(service.connect('slackish', { oauthClient: { clientId: 'has space' } })).rejects.toThrow(/client ID inválido/)
    })

    it('can replace dynamic registration on an oauth entry with the user\'s own app', async () => {
      const { service, oauth } = await harness(null)
      oauth.begin.mockResolvedValue(pending())
      await service.connect('atlassian', { oauthClient: { clientId: 'atl-own' } })
      expect(oauth.begin).toHaveBeenCalledWith('atlassian', 'https://mcp.atlassian.com/v2/mcp', undefined, { clientId: 'atl-own', clientSecret: undefined, scopes: undefined })
    })

    it('warns about the other port when the fixed one was busy, and shows the URL of the login in progress', async () => {
      const { service, oauth } = await harness({ entries: [STATIC] })
      oauth.begin.mockResolvedValue({ ...pending(), redirectUri: 'http://127.0.0.1:51234/callback', redirectUriFallback: true })
      const result = await service.connect('slackish', { oauthClient: { clientId: 'my-app-id' } })
      expect(result.state.redirectUri).toBe('http://127.0.0.1:51234/callback')
      expect(result.state.hint).toContain('http://127.0.0.1:51234/callback')
      expect(result.state.hint).toContain('http://127.0.0.1:38565/callback')
      // A dynamically registered client has no URL to match: no warning.
      oauth.begin.mockResolvedValue({ ...pending(), redirectUri: 'http://127.0.0.1:51235/callback', redirectUriFallback: true })
      const dynamic = await service.connect('atlassian')
      expect(dynamic.state.hint).toBeUndefined()
    })

    it('shows the exact URL to register when the provider refuses the client, or when the login just times out', async () => {
      const { service, store, oauth } = await harness({ entries: [STATIC] })
      const { OAuthSetupError: Refused } = await import('../src/main/mcp-oauth')
      // The provider refuses at the very start: the card is not left half-installed.
      oauth.begin.mockRejectedValue(new Refused('client id inválido ou URL de retorno não cadastrada: cadastre exatamente http://127.0.0.1:38565/callback', 'cadastre a URL', 'http://127.0.0.1:38565/callback'))
      const rejected = await service.connect('slackish', { oauthClient: { clientId: 'wrong-id', clientSecret: SECRET } })
      expect(rejected.state).toMatchObject({ status: 'error', redirectUri: 'http://127.0.0.1:38565/callback', hint: 'cadastre a URL' })
      expect(rejected.state.lastError).toContain('cadastre exatamente http://127.0.0.1:38565/callback')
      expect(store.get().mcpServers).toEqual([])
      expect(store.hasMcpSecrets('slackish')).toBe(false)

      // The provider shows its own error page and nobody comes back: the failure points at the URL too.
      oauth.begin.mockResolvedValue({ ...pending(), completion: Promise.resolve(null) })
      await service.connect('slackish', { oauthClient: { clientId: 'my-app-id' } })
      await vi.waitFor(() => expect(service.stateById('slackish').status).toBe('needs-auth'))
      expect(service.stateById('slackish').hint).toContain('cadastre exatamente http://127.0.0.1:38565/callback')
    })
  })

  describe('dry run', () => {
    const report = (overrides: Record<string, unknown> = {}) => ({
      ok: true,
      server: 'acme',
      authUrl: 'https://auth.acme.example/authorize?client_id=x',
      steps: [
        { step: 'discovery', ok: true, ms: 12, detail: 'servidor de autorização em auth.acme.example' },
        { step: 'registration', ok: true, ms: 8, detail: 'cliente registrado dinamicamente' },
        { step: 'authorize-url', ok: true, ms: 0, detail: 'https://auth.acme.example/authorize com PKCE' }
      ],
      redirectUri: 'http://127.0.0.1:38565/callback',
      client: 'provided',
      scope: 'a b',
      ...overrides
    })

    it('rehearses an OAuth connector without installing, saving, opening or restarting anything', async () => {
      const { service, store, oauth, counters } = await harness({ entries: [CLAUDE_ENTRY] })
      oauth.prepareAuthorization.mockResolvedValue(report())
      const result = await service.connect('acme', { dryRun: { minIntervalMs: 1000 } })
      expect(oauth.prepareAuthorization).toHaveBeenCalledWith('acme', 'https://mcp.acme.example/mcp', {
        clientId: 'openclod-public',
        clientSecret: undefined,
        scopes: 'contacts.read deals.read',
        challenge: undefined,
        minIntervalMs: 1000
      })
      expect(result.dryRun).toMatchObject({ ok: true, client: 'directory', redirectUri: 'http://127.0.0.1:38565/callback', scope: 'a b' })
      expect(result.dryRun?.steps.map((step) => step.step)).toEqual(['discovery', 'registration', 'authorize-url'])
      expect(result.dryRun?.authUrl).toContain('client_id=x')
      expect(result.state).toMatchObject({ id: 'acme', status: 'not-installed' })
      expect(oauth.begin).not.toHaveBeenCalled()
      expect(store.get().mcpServers).toEqual([])
      expect(store.hasMcpSecrets('acme')).toBe(false)
      expect(counters).toMatchObject({ restarts: 0, changes: 0 })
    })

    it('says which client it used: the typed one, a dynamic registration, or none', async () => {
      const { service, oauth, store } = await harness({ entries: [{ ...CLAUDE_ENTRY, oauthClientId: undefined }] })
      oauth.prepareAuthorization.mockResolvedValue(report())
      const typed = await service.connect('acme', { dryRun: true, oauthClient: { clientId: 'typed-id', clientSecret: 'typed-secret-123' } })
      expect(typed.dryRun?.client).toBe('user')
      expect(oauth.prepareAuthorization.mock.calls[0][2]).toMatchObject({ clientId: 'typed-id', clientSecret: 'typed-secret-123' })
      // A rehearsal saves nothing, not even the typed client.
      expect(store.hasMcpSecrets('acme')).toBe(false)

      oauth.prepareAuthorization.mockResolvedValue(report({ client: 'dynamic' }))
      expect((await service.connect('acme', { dryRun: true })).dryRun?.client).toBe('dynamic')

      oauth.prepareAuthorization.mockResolvedValue(
        report({ ok: false, authUrl: undefined, client: undefined, error: 'este conector não aceita registro dinâmico', hint: 'cadastre a URL', steps: [{ step: 'discovery', ok: true, ms: 3, detail: 'x' }, { step: 'registration', ok: false, ms: 2, detail: 'y' }] })
      )
      const failed = await service.connect('acme', { dryRun: true })
      expect(failed.dryRun).toMatchObject({ ok: false, client: 'none', error: 'este conector não aceita registro dinâmico', hint: 'cadastre a URL' })
      expect(failed.dryRun?.authUrl).toBeUndefined()
    })

    it('does not rehearse what is not OAuth or has no URL, and says so', async () => {
      const { service, oauth } = await harness({
        entries: [{ id: 'sem-url', name: 'Sem URL', description: '', category: 'marketing', kind: 'remote', transport: 'http', auth: 'oauth', tools: [], notes: 'Sem endpoint público.', source: 'claude-directory' }]
      })
      const key = await service.connect('github', { dryRun: true })
      expect(key.dryRun).toMatchObject({ ok: false, steps: [], client: 'none' })
      expect(key.dryRun?.error).toContain('não usa OAuth')
      const noUrl = await service.connect('sem-url', { dryRun: true })
      expect(noUrl.dryRun).toMatchObject({ ok: false, error: 'este conector não tem URL pública para testar', hint: 'Sem endpoint público.' })
      // With the URL the user brings it is rehearsed like any other.
      oauth.prepareAuthorization.mockResolvedValue(report())
      const withUrl = await service.connect('sem-url', { dryRun: true, custom: { name: 'x', url: 'https://acme.example/mcp' } })
      expect(withUrl.dryRun?.ok).toBe(true)
      expect(oauth.prepareAuthorization.mock.calls[0][1]).toBe('https://acme.example/mcp')
      expect(oauth.begin).not.toHaveBeenCalled()
    })
  })

  it('shows a login that was cancelled or denied as needing authentication, with how to retry', async () => {
    const { service, oauth, counters } = await harness(null)
    oauth.begin.mockResolvedValue({ authUrl: 'https://a.example/authorize', completion: Promise.resolve(null), cancel: vi.fn() })
    await service.connect('atlassian')
    await vi.waitFor(() => expect(service.stateById('atlassian').status).toBe('needs-auth'))
    expect(service.stateById('atlassian').lastError).toContain('não foi concluído')
    expect(service.stateById('atlassian').hint).toMatch(/Conectar/)
    expect(counters.restarts).toBe(0)
  })

  it('reports an OAuth server without dynamic registration and without client id, and leaves nothing installed', async () => {
    const { service, store, oauth } = await harness(null)
    oauth.begin.mockRejectedValue(
      new OAuthSetupError('este conector não aceita registro dinâmico; use uma chave de API (se houver) ou peça um client id', 'peça um client id público')
    )
    const result = await service.connect('atlassian')
    expect(result.state).toMatchObject({ id: 'atlassian', status: 'error', hint: 'peça um client id público' })
    expect(result.state.lastError).toContain('registro dinâmico')
    expect(result.authUrl).toBeUndefined()
    expect(store.get().mcpServers).toEqual([])
    expect(store.hasMcpSecrets('atlassian')).toBe(false)
  })

  it('keeps an already installed connector when a new login attempt cannot start', async () => {
    const { service, store, oauth } = await harness(null)
    oauth.token.mockResolvedValueOnce(null)
    oauth.begin.mockResolvedValueOnce({ authUrl: 'https://a.example/authorize', completion: new Promise(() => undefined), cancel: vi.fn() })
    await service.connect('atlassian')
    oauth.begin.mockRejectedValueOnce(new OAuthSetupError('falhou', 'tente de novo'))
    const result = await service.connect('atlassian')
    expect(result.state.status).toBe('error')
    expect(store.get().mcpServers.map((server) => server.name)).toEqual(['atlassian'])
  })

  it('does not log in again when a valid token already exists', async () => {
    const { service, oauth, counters } = await harness(null)
    oauth.token.mockResolvedValue('still-valid')
    const result = await service.connect('atlassian')
    expect(oauth.begin).not.toHaveBeenCalled()
    expect(counters.restarts).toBe(1)
    expect(result.state.status).toBe('connected')
  })

  it('does not try OAuth for a connector that has a static Authorization header (it explains instead)', async () => {
    const { service, behavior, oauth } = await harness(null)
    behavior.set('painel', { state: 'error', lastError: 'HTTP 401 em initialize: invalid token' })
    const result = await service.connect('painel', {
      custom: { name: 'painel', url: 'https://painel.example/mcp', headers: { Authorization: 'Bearer tok-abcdefgh1234' } }
    })
    expect(oauth.begin).not.toHaveBeenCalled()
    expect(result.state).toMatchObject({ status: 'needs-auth', detail: 'Credencial recusada pelo servidor' })
    expect(result.state.hint).toBeTruthy()
    expect(settingsText()).not.toContain('tok-abcdefgh1234')
  })

  it('logs a custom connector in when it answers 401 and has no header of its own', async () => {
    const { service, behavior, oauth } = await harness(null)
    behavior.set('aberto', { state: 'error', lastError: 'HTTP 401 em initialize: unauthorized' })
    oauth.begin.mockResolvedValue({ authUrl: 'https://auth.example/authorize', completion: new Promise(() => undefined), cancel: vi.fn() })
    const result = await service.connect('aberto', { custom: { name: 'aberto', url: 'https://aberto.example/mcp' } })
    expect(oauth.begin).toHaveBeenCalledTimes(1)
    expect(result.authUrl).toBe('https://auth.example/authorize')
  })

  it('lists a remote entry that has no public URL and takes the URL the user brings when connecting', async () => {
    const { service, store, started, oauth } = await harness({
      entries: [
        { id: 'sem-url', name: 'Sem URL', description: 'x', category: 'marketing', kind: 'remote', transport: 'http', auth: 'unknown', tools: [], notes: 'Sem endpoint público no diretório; informe a URL do servidor ao conectar.', source: 'claude-directory' }
      ]
    })
    expect(service.directory().entries.some((entry) => entry.id === 'sem-url')).toBe(true)

    const asked = await service.connect('sem-url')
    expect(asked.state).toMatchObject({ id: 'sem-url', status: 'needs-auth', detail: 'Informe a URL do servidor MCP' })
    expect(asked.state.hint).toContain('informe a URL')
    expect(store.get().mcpServers).toEqual([])

    const result = await service.connect('sem-url', {
      custom: { name: 'ignorado', url: 'https://acme.example/mcp', headers: { 'X-Token': 'tok-abcdefgh1234' } }
    })
    expect(result.state).toMatchObject({ id: 'sem-url', serverName: 'sem-url', status: 'connected' })
    expect(started.get('sem-url')).toMatchObject({ url: 'https://acme.example/mcp', headers: { 'X-Token': 'tok-abcdefgh1234' } })
    expect(settingsText()).not.toContain('tok-abcdefgh1234')
    expect(oauth.begin).not.toHaveBeenCalled()
  })

  it('validates a custom connector and an unknown id', async () => {
    const { service } = await harness(null)
    await expect(service.connect('nao-existe')).rejects.toThrow(/não encontrado/)
    await expect(service.connect('x', { custom: { name: 'x', url: 'ftp://x' } })).rejects.toThrow(/http/)
    await expect(service.connect('x', { custom: { name: '', url: 'https://x.example/mcp' } })).rejects.toThrow(/nome/)
    expect(serverNameFor('Meu Conector!')).toBe('Meu-Conector-')
    expect(MAX_MCP_SERVERS).toBeGreaterThanOrEqual(100)
  })
})

describe('a program on this computer, and editing a connector added by hand', () => {
  const local = (extra: Record<string, unknown> = {}) => ({ name: 'meu-local', command: 'node', args: ['servidor.js', '--porta', '3000'], ...extra })
  const savedServers = (): McpServerSettings[] => (JSON.parse(settingsText()) as { mcpServers: McpServerSettings[] }).mcpServers

  it('adds a local program with its arguments, variables, folder and start time, and keeps the credential out of settings.json', async () => {
    const { service, started, oauth } = await harness(null)
    const result = await service.connect('meu-local', {
      custom: local({ env: { API_KEY: 'segredo-abcdefgh1234', REGIAO: 'sa-east-1' }, cwd: dir, startTimeoutMs: 60_000 })
    })
    expect(result.state).toMatchObject({ id: 'meu-local', serverName: 'meu-local', status: 'connected' })
    expect(oauth.begin).not.toHaveBeenCalled()
    // What the client runs has the real values...
    expect(started.get('meu-local')).toMatchObject({
      command: 'node',
      args: ['servidor.js', '--porta', '3000'],
      env: { API_KEY: 'segredo-abcdefgh1234', REGIAO: 'sa-east-1' },
      cwd: dir,
      startTimeoutMs: 60_000
    })
    // ...the file only has a reference for the credential, and the plain variable stays readable.
    const saved = savedServers()[0]
    expect(saved).toMatchObject({ name: 'meu-local', command: 'node', env: { API_KEY: '${secret:meu-local.API_KEY}', REGIAO: 'sa-east-1' } })
    expect(saved.url).toBeUndefined()
    expect(settingsText()).not.toContain('segredo-abcdefgh1234')
  })

  it('refuses what cannot run, with a message that says what to fix', async () => {
    const { service, store } = await harness(null)
    const add = (extra: Record<string, unknown>) => service.connect('x', { custom: local(extra) })
    await expect(add({ command: 'node\nrm -rf' })).rejects.toThrow(/comando é inválido/)
    await expect(add({ command: 'a'.repeat(1001) })).rejects.toThrow(/comando é inválido/)
    await expect(add({ args: Array.from({ length: 101 }, () => 'a') })).rejects.toThrow(/argumentos demais/)
    await expect(add({ env: { 'NOME COM ESPACO': 'x' } })).rejects.toThrow(/nome da variável/)
    await expect(add({ cwd: 'pasta-relativa' })).rejects.toThrow(/caminho completo/)
    await expect(add({ cwd: path.join(dir, 'nao-existe') })).rejects.toThrow(/pasta de trabalho não existe/)
    await expect(add({ cwd: path.join(dir, 'arquivo.txt') })).rejects.toThrow(/pasta de trabalho não existe/)
    await expect(add({ name: '' })).rejects.toThrow(/nome/)
    expect(store.get().mcpServers).toEqual([])
  })

  it('keeps the start time within 5 s and 10 min, and ignores nonsense', async () => {
    const { service } = await harness(null)
    const timeoutOf = async (name: string, startTimeoutMs: unknown): Promise<number | undefined> => {
      await service.connect(name, { custom: local({ name, startTimeoutMs }) })
      return savedServers().find((server) => server.name === name)?.startTimeoutMs
    }
    expect(await timeoutOf('curto', 1_000)).toBe(5_000)
    expect(await timeoutOf('longo', 9_999_999_999)).toBe(600_000)
    expect(await timeoutOf('normal', 45_000)).toBe(45_000)
    expect(await timeoutOf('zero', 0)).toBeUndefined()
    expect(await timeoutOf('texto', 'logo')).toBeUndefined()
  })

  it('edits in place: same position, new program, the credential kept behind its mask, the permissions the user chose kept', async () => {
    const { service, store, started } = await harness(null)
    await service.connect('primeiro', { custom: local({ name: 'primeiro', env: { API_KEY: 'segredo-abcdefgh1234', REGIAO: 'sa-east-1' }, cwd: dir, startTimeoutMs: 60_000 }) })
    await service.connect('segundo', { custom: local({ name: 'segundo' }) })
    await service.setToolPolicy('primeiro', 'tool_one', 'deny')
    const masked = store.maskedMcpServers().find((server) => server.name === 'primeiro')!
    expect(masked.env?.API_KEY).toMatch(/^•{6}/)

    const result = await service.connect('primeiro', {
      update: true,
      // What the edit form sends back: the mask untouched, one variable changed, the folder and the start time cleared.
      custom: { name: 'primeiro', command: 'python', args: ['-m', 'servidor'], env: { API_KEY: masked.env!.API_KEY, REGIAO: 'us-east-1' } }
    })
    expect(result.state).toMatchObject({ id: 'primeiro', status: 'connected' })
    expect(store.get().mcpServers.map((server) => server.name)).toEqual(['primeiro', 'segundo'])
    expect(started.get('primeiro')).toMatchObject({ command: 'python', args: ['-m', 'servidor'], env: { API_KEY: 'segredo-abcdefgh1234', REGIAO: 'us-east-1' } })
    const saved = savedServers()[0]
    expect(saved.cwd).toBeUndefined()
    expect(saved.startTimeoutMs).toBeUndefined()
    expect(saved.toolPolicy).toEqual({ tool_one: 'deny' })
    expect(settingsText()).not.toContain('segredo-abcdefgh1234')
    expect(settingsText()).not.toContain('••••')
  })

  it('replaces a credential only when the user typed a new one', async () => {
    const { service, store, started } = await harness(null)
    await service.connect('meu-local', { custom: local({ env: { API_KEY: 'segredo-abcdefgh1234' } }) })
    await service.connect('meu-local', { update: true, custom: local({ env: { API_KEY: 'outro-segredo-9876543210' } }) })
    expect(started.get('meu-local')?.env?.API_KEY).toBe('outro-segredo-9876543210')
    expect(store.mcpSecretValue('meu-local', 'API_KEY')).toBe('outro-segredo-9876543210')
    expect(settingsText()).not.toContain('segredo-')
  })

  it('edits a remote connector: the header behind its mask stays in the vault and the mask is never saved as the credential', async () => {
    const { service, store, started } = await harness(null)
    await service.connect('painel', { custom: { name: 'painel', url: 'https://painel.example/mcp', headers: { 'X-Api': 'tok-abcdefgh1234' } } })
    const masked = store.maskedMcpServers().find((server) => server.name === 'painel')!
    expect(masked.headers?.['X-Api']).toMatch(/^•{6}/)

    await service.connect('painel', { update: true, custom: { name: 'painel', url: 'https://painel2.example/mcp', headers: { 'X-Api': masked.headers!['X-Api'] } } })
    expect(started.get('painel')).toMatchObject({ url: 'https://painel2.example/mcp', headers: { 'X-Api': 'tok-abcdefgh1234' } })
    expect(store.mcpSecretValue('painel', 'X-Api')).toBe('tok-abcdefgh1234')
    expect(settingsText()).not.toContain('tok-abcdefgh1234')
    expect(settingsText()).not.toContain('••••')
  })

  it('refuses to edit what is not installed, what comes from the directory, and a request without a configuration', async () => {
    const { service } = await harness(null)
    await expect(service.connect('fantasma', { update: true, custom: local({ name: 'fantasma' }) })).rejects.toThrow(/não está instalado/)
    await service.connect('github', { credentials: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
    await expect(service.connect('github', { update: true, custom: local({ name: 'github' }) })).rejects.toThrow(/vem do diretório/)
    await expect(service.connect('github', { update: true })).rejects.toThrow(/informe a configuração/)
  })
})

describe('disconnect', () => {
  it('removes the server, revokes the token and deletes the credentials from the vault', async () => {
    const { service, store, oauth, counters } = await harness(null)
    await service.connect('github', { credentials: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
    expect(store.hasMcpSecrets('github')).toBe(true)
    const state = await service.disconnect('github')
    expect(state).toEqual({ id: 'github', status: 'not-installed' })
    expect(oauth.revoke).toHaveBeenCalledWith('github')
    expect(store.get().mcpServers).toEqual([])
    expect(store.hasMcpSecrets('github')).toBe(false)
    expect(settingsText()).not.toContain('secret:github')
    expect(counters.restarted).toEqual(['github', 'github'])
    expect(service.stateById('github').status).toBe('not-installed')
  })

  it('is a no-op for something that is not installed', async () => {
    const { service, counters, oauth } = await harness(null)
    expect(await service.disconnect('github')).toEqual({ id: 'github', status: 'not-installed' })
    expect(counters.restarts).toBe(0)
    expect(oauth.revoke).not.toHaveBeenCalled()
  })

  it('still removes a connector whose token cannot be revoked', async () => {
    const { service, store, oauth } = await harness(null)
    await service.connect('github', { credentials: { Authorization: `Bearer ${GITHUB_TOKEN}` } })
    oauth.revoke.mockRejectedValueOnce(new Error('rede fora'))
    await service.disconnect('github')
    expect(store.get().mcpServers).toEqual([])
  })
})

describe('tool permissions', () => {
  it('resolves exact name, then the longest glob, then the server default, then approvalTools and annotations', () => {
    const config: Pick<McpServerSettings, 'toolPolicy' | 'approvalTools'> = {
      toolPolicy: { '*': 'ask', 'jira_*': 'allow', 'jira_delete_*': 'deny', jira_delete_comment: 'allow' },
      approvalTools: ['confluence_*']
    }
    expect(effectiveToolPolicy(config, 'jira_delete_comment')).toBe('allow')
    expect(effectiveToolPolicy(config, 'jira_delete_issue')).toBe('deny')
    expect(effectiveToolPolicy(config, 'jira_get_issue')).toBe('allow')
    expect(effectiveToolPolicy(config, 'confluence_get_page')).toBe('ask')
    expect(effectiveToolPolicy({ approvalTools: ['confluence_*'] }, 'confluence_get_page')).toBe('ask')
    expect(effectiveToolPolicy({}, 'anything', { destructiveHint: true })).toBe('ask')
    expect(effectiveToolPolicy({}, 'anything', { readOnlyHint: true })).toBe('allow')
    // No annotation, no setting: it follows the app's permission mode, which the screen shows as "ask".
    expect(effectiveToolPolicy({}, 'anything')).toBe('ask')
    // The very same rule the runner enforces: a tool the include/exclude filter hides reads as denied.
    expect(effectiveToolPolicy({ excludeTools: ['secret_*'] }, 'secret_dump')).toBe('deny')
  })

  it('lists the live tools with their policy and saves a change for one tool or for all', async () => {
    const { service, store, behavior, counters } = await harness(null)
    behavior.set('context7', {
      state: 'ready',
      tools: [
        { name: 'search_docs', description: 'Search\n  the docs', annotations: { readOnlyHint: true } },
        { name: 'delete_doc', annotations: { destructiveHint: true } },
        { name: 'update_doc' }
      ]
    })
    await store.update({ mcpServers: [{ name: 'context7', type: 'http', url: 'https://mcp.context7.com/mcp', command: '', args: [], approvalTools: ['update_*'], enabled: true }] })
    await service.reload()
    expect(service.tools('context7')).toEqual([
      { name: 'search_docs', description: 'Search the docs', policy: 'allow', readOnly: true },
      { name: 'delete_doc', description: '', policy: 'ask', destructive: true },
      { name: 'update_doc', description: '', policy: 'ask' }
    ])

    const afterOne = await service.setToolPolicy('context7', 'delete_doc', 'deny')
    expect(afterOne.find((tool) => tool.name === 'delete_doc')?.policy).toBe('deny')
    expect(store.get().mcpServers[0].toolPolicy).toEqual({ delete_doc: 'deny' })
    expect(counters.refreshes).toBe(1)

    const afterAll = await service.setToolPolicy('context7', '*', 'ask')
    expect(afterAll.map((tool) => tool.policy)).toEqual(['ask', 'ask', 'ask'])
    expect(store.get().mcpServers[0].toolPolicy).toEqual({ '*': 'ask' })

    await expect(service.setToolPolicy('context7', 'x', 'maybe' as never)).rejects.toThrow(/inválida/)
    await expect(service.setToolPolicy('nope', 'x', 'allow')).rejects.toThrow(/não está configurado/)
    expect(service.tools('nope')).toEqual([])
  })
})

describe('reuse credentials (mcp_install reuse_credentials_from)', () => {
  it('copies email + token from a Basic header to the keys of another server, naming only keys', async () => {
    const { service, store } = await harness(null)
    const basic = `Basic ${Buffer.from('ana@empresa.com:ATATT-token-value-9999').toString('base64')}`
    await store.update({ mcpServers: [{ name: 'atlassian', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', command: '', args: [], headers: { Authorization: basic }, enabled: true }] })
    expect(settingsText()).not.toContain(basic)

    const lent = service.reuseCredentials('atlassian', { env: ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN'], headers: [] })
    expect(lent.env).toEqual({ JIRA_USERNAME: 'ana@empresa.com', JIRA_API_TOKEN: 'ATATT-token-value-9999' })
    expect(lent.keys).toEqual(['JIRA_USERNAME', 'JIRA_API_TOKEN'])
    expect(() => service.reuseCredentials('nao-existe', { env: [], headers: [] })).toThrow(/não está configurado; configurados: atlassian/)
  })
})
