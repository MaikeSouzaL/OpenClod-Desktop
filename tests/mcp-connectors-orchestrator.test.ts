import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent } from '../src/shared/types'

// An OS vault that works under test (the real one is Electron's safeStorage / DPAPI).
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (data: Buffer) => Buffer.from(data.toString('utf8').slice(4), 'base64').toString('utf8')
  }
}))

const { Orchestrator } = await import('../src/main/orchestrator')

/**
 * The orchestrator end to end for MCP credentials: settings.json keeps only `${secret:...}` references, the
 * client is started with the real values, a missing value never starts a half-configured server, and
 * `mcp_install({ reuse_credentials_from })` copies credentials inside the app.
 */
const SECRET = 'sk-real-secret-0123456789'
const FAKE_SERVER = String.raw`
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
  if (msg.method === 'tools/list') return reply({ tools: [{ name: 'echo_env', description: 'Returns the credential it was started with', inputSchema: { type: 'object', properties: {} } }] })
  if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: (process.env.FAKE_API_KEY || '') + '|' + (process.env.FAKE_REGION || '') + '|' + process.argv[2] }] })
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
})
`

let dir = ''
let events: HarnessEvent[] = []
let logs: string[] = []
let script = ''

type Orch = InstanceType<typeof Orchestrator>

interface CallableService {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>
}

function service(orchestrator: Orch): CallableService {
  return (orchestrator as unknown as { mcpToolService(): CallableService }).mcpToolService()
}

async function boot(): Promise<Orch> {
  const orchestrator = new Orchestrator({ userData: dir, broadcast: (event) => events.push(event), log: (message) => logs.push(message) })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  return orchestrator
}

function settingsText(): string {
  return fs.readFileSync(path.join(dir, 'config', 'settings.json'), 'utf8')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-mcpc-'))
  script = path.join(dir, 'fake-mcp.cjs')
  fs.writeFileSync(script, FAKE_SERVER)
  events = []
  logs = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

describe('MCP credentials through the orchestrator', () => {
  it('starts a server with the real credential while settings.json holds only a reference', async () => {
    const orchestrator = await boot()
    try {
      await orchestrator.settings.update({
        mcpServers: [
          { name: 'fake', command: process.execPath, args: [script, '--key=' + SECRET], env: { FAKE_API_KEY: SECRET, FAKE_REGION: 'br' }, enabled: true }
        ]
      })
      const stored = JSON.parse(settingsText()) as { mcpServers: Array<{ args: string[]; env: Record<string, string> }> }
      expect(settingsText()).not.toContain(SECRET)
      expect(stored.mcpServers[0].env).toEqual({ FAKE_API_KEY: '${secret:fake.FAKE_API_KEY}', FAKE_REGION: 'br' })

      await orchestrator.restartMcp()
      const result = await service(orchestrator).call('fake', 'echo_env', {})
      expect(result.ok).toBe(true)
      // The process received the real value in its environment and in its args.
      expect(result.text).toBe(`${SECRET}|br|--key=${SECRET}`)
      expect(orchestrator.connectorStates().find((state) => state.id === 'fake')).toMatchObject({ status: 'connected', toolCount: 1 })
      expect(logs.join('\n')).not.toContain(SECRET)
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('does not start a server whose credential disappeared from the vault, and says so', async () => {
    const orchestrator = await boot()
    try {
      await orchestrator.settings.update({
        mcpServers: [{ name: 'fake', command: process.execPath, args: [script], env: { FAKE_API_KEY: SECRET }, enabled: true }]
      })
      await orchestrator.settings.clearMcpSecrets('fake')
      await orchestrator.restartMcp()
      const state = orchestrator.connectorStates().find((item) => item.id === 'fake')!
      expect(state).toMatchObject({ status: 'needs-auth', detail: 'Credencial ausente do cofre' })
      expect(state.lastError).toContain('FAKE_API_KEY')
      expect(state.hint).toBeTruthy()
      await expect(service(orchestrator).call('fake', 'echo_env', {})).rejects.toThrow()
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('lists live tools with their policy and tells the interface when a policy changes', async () => {
    const orchestrator = await boot()
    try {
      await orchestrator.settings.update({ mcpServers: [{ name: 'fake', command: process.execPath, args: [script], enabled: true }] })
      await orchestrator.restartMcp()
      // No annotation and no setting: it follows the app's permission mode, shown as "ask".
      expect(orchestrator.connectorTools('fake').map((tool) => [tool.name, tool.policy])).toEqual([['echo_env', 'ask']])
      events.length = 0
      const updated = await orchestrator.setToolPolicy('fake', 'echo_env', 'allow')
      expect(updated[0].policy).toBe('allow')
      expect(orchestrator.settings.get().mcpServers[0].toolPolicy).toEqual({ echo_env: 'allow' })
      // The very client that runs the tool enforces it (no reconnection needed).
      const live = (orchestrator as unknown as { mcpClients: Map<string, { policyFor(name: string): { policy: string; explicit: boolean } }> }).mcpClients.get('fake')!
      expect(live.policyFor('echo_env')).toMatchObject({ policy: 'allow', explicit: true })
      const denied = await orchestrator.setToolPolicy('fake', 'echo_env', 'deny')
      expect(denied.map((tool) => [tool.name, tool.policy])).toEqual([['echo_env', 'deny']])
      await expect(service(orchestrator).call('fake', 'echo_env', {})).rejects.toThrow()
      expect(events.some((event) => event.type === 'settings_changed' && event.scope === 'mcp')).toBe(true)

      events.length = 0
      const states = await orchestrator.reloadMcp()
      expect(states.find((state) => state.id === 'fake')?.status).toBe('connected')
      expect(events.some((event) => event.type === 'settings_changed' && event.scope === 'mcp')).toBe(true)
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('serves the masked settings for the editor and takes them back without losing the secret', async () => {
    const orchestrator = await boot()
    try {
      await orchestrator.settings.update({
        mcpServers: [{ name: 'fake', command: process.execPath, args: [script], env: { FAKE_API_KEY: SECRET }, enabled: true }]
      })
      const masked = orchestrator.maskedMcpSettings()
      expect(masked[0].env).toEqual({ FAKE_API_KEY: '••••••89' })
      await orchestrator.settings.update({ mcpServers: masked })
      await orchestrator.restartMcp()
      expect((await service(orchestrator).call('fake', 'echo_env', {})).text).toBe(`${SECRET}||undefined`)
    } finally {
      await orchestrator.shutdown()
    }
  })

  it('mcp_install reuse_credentials_from copies email + token from another server without exposing them', async () => {
    const orchestrator = await boot()
    orchestrator.restartMcp = async () => undefined // nothing to start: the point is what gets saved
    const token = 'ATATT-token-value-9999'
    const basic = `Basic ${Buffer.from(`ana@empresa.com:${token}`).toString('base64')}`
    await orchestrator.settings.update({
      mcpServers: [{ name: 'atlassian', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', command: '', args: [], headers: { Authorization: basic }, enabled: true }]
    })
    const install = orchestrator.installMcp.bind(orchestrator) as (input: Record<string, unknown>) => Promise<{ ok: boolean; name?: string; missing?: string[]; reused?: string[]; error?: string }>

    // Nothing but the non-secret URL is missing: reported, and nothing is saved yet.
    const incomplete = await install({ id: 'jira', reuseCredentialsFrom: 'atlassian' })
    expect(incomplete.missing).toEqual(['JIRA_URL'])
    expect(incomplete.reused).toEqual(['JIRA_USERNAME', 'JIRA_API_TOKEN'])
    expect(orchestrator.settings.get().mcpServers.map((server) => server.name)).toEqual(['atlassian'])

    const result = await install({ id: 'jira', env: { JIRA_URL: 'https://empresa.atlassian.net' }, reuseCredentialsFrom: 'atlassian' })
    expect(result.name).toBe('jira')
    expect(result.reused).toEqual(['JIRA_USERNAME', 'JIRA_API_TOKEN'])
    expect(JSON.stringify(result)).not.toContain(token)

    const jira = orchestrator.settings.get().mcpServers.find((server) => server.name === 'jira')!
    expect(jira.env).toEqual({
      JIRA_URL: 'https://empresa.atlassian.net',
      JIRA_USERNAME: 'ana@empresa.com',
      JIRA_API_TOKEN: '${secret:jira.JIRA_API_TOKEN}'
    })
    expect(orchestrator.settings.resolveMcpServer(jira).server.env?.JIRA_API_TOKEN).toBe(token)
    expect(settingsText()).not.toContain(token)
    expect(settingsText()).not.toContain(basic)

    // An unknown source is an error that names the configured servers.
    const unknown = await install({ id: 'jira', reuseCredentialsFrom: 'nao-existe' })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/não está configurado; configurados: atlassian, jira/)
  })
})
