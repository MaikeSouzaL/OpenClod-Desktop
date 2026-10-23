import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  McpClient,
  filterMcpTools,
  isMcpToolExposed,
  matchesToolPattern,
  mcpQualifiedName,
  mcpToolRisk,
  normalizeMcpServerSettings
} from '../src/core/mcp/client'
import { REA_APPROVAL_TOOLS, detectRea, listMcpPresets, reaMcpPreset } from '../src/core/mcp/presets'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * McpClient does not export its line-framing helpers, so this test drives the
 * real stdio transport against a throwaway JSON-RPC 2.0 server. That covers the
 * framing/parsing path (newline-delimited JSON, malformed lines, notifications)
 * without any network access.
 */
const SERVER_SOURCE = String.raw`
const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // client notification, ignore

  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

  if (msg.jsonrpc !== '2.0') return fail(-32600, 'invalid request')

  switch (msg.method) {
    case 'initialize':
      // Exercise the parser: malformed line, server notification, then result.
      process.stdout.write('this is not json\n')
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' }
      })
      break
    case 'tools/list':
      reply({
        tools: [
          {
            name: 'echo',
            description: 'Echoes text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
          },
          { name: 'broken', description: 'Always fails' }
        ]
      })
      break
    case 'tools/call': {
      const name = msg.params && msg.params.name
      const args = (msg.params && msg.params.arguments) || {}
      if (name === 'broken') return fail(42, 'ferramenta quebrada')
      if (name !== 'echo') return fail(404, 'unknown tool')
      reply({ content: [{ type: 'text', text: 'echo:' + String(args.text) }] })
      break
    }
    default:
      fail(-32601, 'method not found')
  }
})

rl.on('close', () => process.exit(0))
`

describe('McpClient (JSON-RPC over stdio)', () => {
  let dir: string
  let script: string
  let client: McpClient | null = null

  beforeEach(async () => {
    dir = await makeTempDir('forja-mcp-')
    script = path.join(dir, 'fake-mcp.cjs')
    await fs.promises.writeFile(script, SERVER_SOURCE, 'utf8')
  })

  afterEach(async () => {
    await client?.stop()
    client = null
    await removeTempDir(dir)
  })

  it('initializes, lists tools and calls one, ignoring malformed/notification lines', async () => {
    client = new McpClient({ name: 'fake', command: process.execPath, args: [script] })
    await client.start(10_000)

    expect(client.state).toBe('ready')
    expect(client.name).toBe('fake')
    const tools = client.toolsList()
    expect(tools.map((t) => t.name)).toEqual(['echo', 'broken'])
    expect(tools[0].description).toBe('Echoes text back')
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' })

    const result = await client.callTool('echo', { text: 'olá' }, 5_000)
    expect(result).toMatchObject({ ok: true, text: 'echo:olá', summary: 'fake/echo' })

    // toolsList returns a copy, not the internal array.
    const copy = client.toolsList()
    copy.pop()
    expect(client.toolsList()).toHaveLength(2)
  })

  it('rejects JSON-RPC errors with code and message, and stops cleanly', async () => {
    client = new McpClient({ name: 'fake', command: process.execPath, args: [script] })
    await client.start(10_000)
    await expect(client.callTool('broken', {}, 5_000)).rejects.toThrow(/MCP 42: ferramenta quebrada/)

    await client.stop()
    expect(client.state).toBe('stopped')
    expect(client.toolsList()).toEqual([])
  })

  it('rejects requests when the server was never started', async () => {
    client = new McpClient({ name: 'offline', command: process.execPath, args: [script] })
    // stop() is a no-op and callTool goes through request(), which needs a child.
    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/não iniciado/)
  })
})

/* ------------------------------------------------------------------ */
/* Tool filter, approval tools, timeouts, cwd                          */
/* ------------------------------------------------------------------ */

/** Server whose tool list comes from FAKE_TOOLS, with a few special tools. */
const CONFIGURABLE_SERVER = String.raw`
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const names = JSON.parse(process.env.FAKE_TOOLS || '[]')
const initDelay = Number(process.env.FAKE_INIT_DELAY || 0)
let cancelled = 0

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'notifications/cancelled') {
    cancelled++
    return
  }
  if (msg.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })
  const text = (value) => reply({ content: [{ type: 'text', text: value }] })

  switch (msg.method) {
    case 'initialize':
      setTimeout(
        () => reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }),
        initDelay
      )
      break
    case 'tools/list':
      reply({ tools: names.map((name) => ({ name, description: 'tool ' + name, inputSchema: { type: 'object', properties: {} } })) })
      break
    case 'tools/call': {
      const name = msg.params.name
      if (name === 'slow') return void setTimeout(() => text('slow-done'), 600)
      if (name === 'cwd') return text(process.cwd())
      if (name === 'cancelled_count') return text(String(cancelled))
      text('called:' + name)
      break
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})

rl.on('close', () => process.exit(0))
`

// Real REA tool names (from its published catalog); used only as literals.
const REA_READ_TOOLS = [
  'open_binary',
  'binary_overview',
  'list_procedures',
  'list_strings',
  'search_strings',
  'procedure_pseudo_code',
  'procedure_assembly',
  'xrefs',
  'inspect_pe_resources',
  'trace_call_path',
  'set_comment',
  'annotate_native_function',
  'export_evidence_bundle',
  'list_adb_devices',
  'pull_adb_file',
  'list_frida_processes',
  'inspect_android_class'
]
const REA_GATED_TOOLS = [
  'capture_process_scenario',
  'capture_native_ui_scenario',
  'capture_browser_scenario',
  'capture_electron_scenario',
  'capture_adb_screen',
  'capture_web_screenshot',
  'instrument_with_frida',
  'install_adb_package',
  'uninstall_adb_package',
  'push_adb_file',
  'start_adb_app',
  'start_adb_activity',
  'start_frida_session',
  'stop_adb_app',
  'load_frida_script',
  'resume_frida_session',
  'observe_native_calls',
  'observe_web_execution'
]

describe('MCP tool patterns', () => {
  it('matches * and ? as wildcards, case-insensitively, everything else literally', () => {
    expect(matchesToolPattern('capture_*', 'capture_process_scenario')).toBe(true)
    expect(matchesToolPattern('capture_*', 'recapture_x')).toBe(false)
    expect(matchesToolPattern('*_adb_*', 'list_adb_devices')).toBe(true)
    expect(matchesToolPattern('*', 'anything_at_all')).toBe(true)
    expect(matchesToolPattern('get_?', 'get_a')).toBe(true)
    expect(matchesToolPattern('get_?', 'get_ab')).toBe(false)
    expect(matchesToolPattern('Open_Binary', 'open_binary')).toBe(true)
    // Regex metacharacters are literal.
    expect(matchesToolPattern('a.b', 'a.b')).toBe(true)
    expect(matchesToolPattern('a.b', 'axb')).toBe(false)
    expect(matchesToolPattern('(x)+', '(x)+')).toBe(true)
  })

  it('filters with include, exclude (exclude wins) and ignores junk entries', () => {
    const tools = ['open_binary', 'list_strings', 'capture_x', 'capture_screen', 'install_apk'].map((name) => ({ name }))
    const names = (config: Parameters<typeof filterMcpTools>[1]): string[] => filterMcpTools(tools, config).map((t) => t.name)

    expect(names({})).toHaveLength(5)
    expect(names({ includeTools: [] })).toHaveLength(5)
    expect(names({ includeTools: ['list_*', 'open_binary'] })).toEqual(['open_binary', 'list_strings'])
    expect(names({ excludeTools: ['capture_*', 'install_*'] })).toEqual(['open_binary', 'list_strings'])
    expect(names({ includeTools: ['capture_*'], excludeTools: ['capture_screen'] })).toEqual(['capture_x'])
    expect(names({ includeTools: ['  ', 42 as unknown as string, 'open_binary'], excludeTools: ['', null as unknown as string] })).toEqual([
      'open_binary'
    ])
    expect(isMcpToolExposed({ excludeTools: ['open_*'] }, 'open_binary')).toBe(false)
  })

  it('gives approval tools the destructive risk and everything else exec', () => {
    const config = { approvalTools: ['capture_*', 'install_apk'] }
    expect(mcpToolRisk(config, 'capture_x')).toBe('destructive')
    expect(mcpToolRisk(config, 'install_apk')).toBe('destructive')
    expect(mcpToolRisk(config, 'install_other')).toBe('exec')
    expect(mcpToolRisk({}, 'capture_x')).toBe('exec')
  })

  it('builds registry names like the orchestrator does', () => {
    expect(mcpQualifiedName('rea', 'open_binary')).toBe('mcp__rea__open_binary')
    expect(mcpQualifiedName('my server', 'do.it')).toBe('mcp__my_server__do_it')
    expect(mcpQualifiedName('s', 'x'.repeat(100))).toHaveLength(60)
  })
})

describe('normalizeMcpServerSettings', () => {
  it('keeps the legacy shape and only adds the new fields when they are valid', () => {
    expect(normalizeMcpServerSettings({ name: 'a', command: 'node', args: ['x'], env: { K: 1 }, enabled: false })).toEqual({
      name: 'a',
      command: 'node',
      args: ['x'],
      env: { K: '1' },
      enabled: false
    })
    expect(normalizeMcpServerSettings({ name: 'a', command: 'node' })).toEqual({
      name: 'a',
      command: 'node',
      args: [],
      env: undefined,
      enabled: true
    })
  })

  it('clamps numbers, trims patterns and drops junk', () => {
    const out = normalizeMcpServerSettings({
      name: 'rea',
      command: 'node',
      args: [],
      cwd: '  C:/rea  ',
      timeoutMs: 999_999_999,
      startTimeoutMs: 5,
      includeTools: ['  open_*  ', '', 7, null],
      excludeTools: [],
      approvalTools: 'capture_*'
    })
    expect(out).toMatchObject({ cwd: 'C:/rea', timeoutMs: 3_600_000, startTimeoutMs: 1000, includeTools: ['open_*'] })
    expect('excludeTools' in out).toBe(false)
    expect('approvalTools' in out).toBe(false)
    expect('timeoutMs' in normalizeMcpServerSettings({ timeoutMs: 'abc' })).toBe(false)
  })

  it('survives non-object input', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      expect(normalizeMcpServerSettings(raw)).toMatchObject({ name: '', command: '', args: [], enabled: true })
    }
  })

  it('round-trips a REA preset unchanged', () => {
    const preset = reaMcpPreset({ launch: { command: 'node', args: ['rea.mjs', 'mcp'], env: { A: 'b' }, cwd: 'C:/rea' } })!
    expect(normalizeMcpServerSettings(preset)).toEqual(preset)
  })
})

describe('McpClient server options', () => {
  let dir: string
  let script: string
  let client: McpClient | null = null

  const make = (config: Partial<ConstructorParameters<typeof McpClient>[0]> & { tools?: string[]; initDelay?: number } = {}): McpClient => {
    const { tools = ['echo'], initDelay, env, ...rest } = config
    client = new McpClient({
      name: 'cfg',
      command: process.execPath,
      args: [script],
      env: { FAKE_TOOLS: JSON.stringify(tools), FAKE_INIT_DELAY: String(initDelay ?? 0), ...env },
      ...rest
    })
    return client
  }

  beforeEach(async () => {
    dir = await makeTempDir('forja-mcp-cfg-')
    script = path.join(dir, 'fake-configurable.cjs')
    await fs.promises.writeFile(script, CONFIGURABLE_SERVER, 'utf8')
  })

  afterEach(async () => {
    await client?.stop()
    client = null
    await removeTempDir(dir)
  })

  it('exposes only the tools that pass includeTools/excludeTools and refuses the others', async () => {
    const mcp = make({
      tools: ['open_binary', 'list_strings', 'capture_process_scenario', 'install_adb_package', 'slow'],
      includeTools: ['*'],
      excludeTools: ['install_*', 'capture_process_*']
    })
    await mcp.start(10_000)

    expect(mcp.toolsList().map((t) => t.name)).toEqual(['open_binary', 'list_strings', 'slow'])
    expect(mcp.hiddenToolCount).toBe(2)
    expect(mcp.isToolExposed('install_adb_package')).toBe(false)
    await expect(mcp.callTool('install_adb_package', {}, 2000)).rejects.toThrow(/desativada pela configuração/)
    expect(await mcp.callTool('open_binary', {}, 2000)).toMatchObject({ ok: true, text: 'called:open_binary' })

    await mcp.stop()
    expect(mcp.hiddenToolCount).toBe(0)
  })

  it('an include list hides everything it does not name', async () => {
    const mcp = make({ tools: ['a_one', 'a_two', 'b_one'], includeTools: ['a_*'] })
    await mcp.start(10_000)
    expect(mcp.toolsList().map((t) => t.name)).toEqual(['a_one', 'a_two'])
  })

  it('reports which tools must always ask for approval', async () => {
    const mcp = make({ tools: ['read_it', 'capture_it', 'install_it'], approvalTools: ['capture_*', 'install_it'] })
    await mcp.start(10_000)

    expect(mcp.requiresApproval('capture_it')).toBe(true)
    expect(mcp.requiresApproval('read_it')).toBe(false)
    expect(mcp.toolRisk('install_it')).toBe('destructive')
    expect(mcp.toolRisk('read_it')).toBe('exec')
    // Approval does not hide the tool.
    expect(mcp.toolsList()).toHaveLength(3)
  })

  it('uses timeoutMs from the config as the default request timeout, but an explicit one wins', async () => {
    const mcp = make({ tools: ['slow', 'echo'], timeoutMs: 150 })
    await mcp.start(10_000)

    await expect(mcp.callTool('slow', {})).rejects.toThrow(/timeout de MCP cfg\.tools\/call \(150ms\)/)
    expect(await mcp.callTool('slow', {}, 5000)).toMatchObject({ ok: true, text: 'slow-done' })
    // The late reply to the timed-out call did not break the connection.
    expect(await mcp.callTool('echo', {})).toMatchObject({ text: 'called:echo' })
  })

  it('falls back to 120 s for a missing or invalid timeoutMs', async () => {
    for (const timeoutMs of [undefined, 0, -5, Number.NaN, '300' as unknown as number]) {
      const mcp = make({ tools: ['echo'], timeoutMs })
      await mcp.start(10_000)
      // Not observable by waiting 120 s: a fast call must simply work.
      expect(await mcp.callTool('echo', {})).toMatchObject({ ok: true })
      await mcp.stop()
    }
  })

  it('honours startTimeoutMs for the initialize handshake', async () => {
    const slow = make({ tools: ['echo'], initDelay: 800, startTimeoutMs: 150 })
    await expect(slow.start()).rejects.toThrow(/timeout de MCP cfg\.initialize \(150ms\)/)
    await slow.stop()

    const patient = make({ tools: ['echo'], initDelay: 300, startTimeoutMs: 5000 })
    await patient.start()
    expect(patient.state).toBe('ready')
  })

  it('cancels a pending call when the signal aborts and tells the server', async () => {
    const mcp = make({ tools: ['slow', 'echo', 'cancelled_count'] })
    await mcp.start(10_000)

    const controller = new AbortController()
    const pending = mcp.callTool('slow', {}, 10_000, controller.signal)
    setTimeout(() => controller.abort(), 80)
    await expect(pending).rejects.toThrow(/cancelada/)

    // Already-aborted signals never reach the server.
    await expect(mcp.callTool('echo', {}, 2000, controller.signal)).rejects.toThrow(/cancelada/)
    expect(await mcp.callTool('echo', {})).toMatchObject({ text: 'called:echo' })
    expect(await mcp.callTool('cancelled_count', {})).toMatchObject({ text: '1' })
  })

  it('starts the server in the configured cwd', async () => {
    const work = path.join(dir, 'work')
    await fs.promises.mkdir(work)
    const mcp = make({ tools: ['cwd'], cwd: work })
    await mcp.start(10_000)
    const result = await mcp.callTool('cwd', {})
    expect(fs.realpathSync(result.text)).toBe(fs.realpathSync(work))
  })
})

/* ------------------------------------------------------------------ */
/* REA preset                                                          */
/* ------------------------------------------------------------------ */

describe('REA detection and preset', () => {
  let home: string

  beforeEach(async () => {
    home = await makeTempDir('forja-rea-')
  })

  afterEach(async () => {
    await removeTempDir(home)
  })

  /** Lays out REA the way the user's Desktop\REA workspace is organised. */
  function installRea(
    base: string,
    options: { dist?: boolean; local?: boolean; ghidra?: boolean; temp?: boolean } = {}
  ): { workspace: string; pkg: string } {
    const { dist = true, local = true, ghidra = true, temp = true } = options
    const workspace = path.join(base, 'REA')
    const pkg = path.join(workspace, 'rea')
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'scripts', 'rea.mjs'), '// launcher\n')
    if (dist) {
      fs.mkdirSync(path.join(pkg, 'dist', 'mcp'), { recursive: true })
      fs.writeFileSync(path.join(pkg, 'dist', 'mcp', 'main.js'), '// compiled\n')
    }
    if (ghidra) fs.mkdirSync(path.join(workspace, 'ferramentas', 'ghidra_12.1.4_PUBLIC'), { recursive: true })
    if (temp) fs.mkdirSync(path.join(workspace, 'temporarios'))
    if (local) {
      // PowerShell writes a BOM; REA's launcher tolerates it, so must we.
      fs.writeFileSync(
        path.join(workspace, 'rea-local.json'),
        '﻿' +
          JSON.stringify({
            rea_directory: pkg,
            env: {
              REA_ANALYSIS_PROVIDER: 'ghidra',
              GHIDRA_INSTALL_DIR: path.join(workspace, 'ferramentas', 'ghidra_12.1.4_PUBLIC'),
              JAVA_HOME: path.join(workspace, 'jdk'),
              REA_GHIDRA_STARTUP_TIMEOUT_MS: '330000',
              TEMP: path.join(workspace, 'temporarios'),
              TMP: path.join(workspace, 'temporarios')
            }
          })
      )
    }
    return { workspace, pkg }
  }

  it('finds REA under Desktop\\REA\\rea and reads the launch env from rea-local.json', () => {
    const { workspace, pkg } = installRea(path.join(home, 'Desktop'))
    const found = detectRea({ env: {}, homeDir: home })

    expect(found).not.toBeNull()
    expect(found!.command).toBe(process.execPath)
    expect(found!.args).toEqual([path.join(pkg, 'scripts', 'rea.mjs'), 'mcp'])
    expect(found!.cwd).toBe(pkg)
    expect(found!.env).toMatchObject({
      REA_ANALYSIS_PROVIDER: 'ghidra',
      GHIDRA_INSTALL_DIR: path.join(workspace, 'ferramentas', 'ghidra_12.1.4_PUBLIC'),
      JAVA_HOME: path.join(workspace, 'jdk'),
      REA_GHIDRA_STARTUP_TIMEOUT_MS: '330000',
      TEMP: path.join(workspace, 'temporarios')
    })
  })

  it('prefers REA_HOME, and accepts either the package dir or the workspace dir', () => {
    installRea(path.join(home, 'Desktop'))
    const other = installRea(path.join(home, 'elsewhere'))

    expect(detectRea({ env: { REA_HOME: other.pkg }, homeDir: home })?.cwd).toBe(other.pkg)
    expect(detectRea({ env: { REA_HOME: other.workspace }, homeDir: home })?.cwd).toBe(other.pkg)
    // An unusable REA_HOME falls through to the default locations.
    expect(detectRea({ env: { REA_HOME: path.join(home, 'nada') }, homeDir: home })?.cwd).toBe(
      path.join(home, 'Desktop', 'REA', 'rea')
    )
  })

  it('does not touch the installation: no files are created or changed', () => {
    const { workspace } = installRea(path.join(home, 'Desktop'), { temp: false })
    const snapshot = (): string[] =>
      fs
        .readdirSync(workspace, { recursive: true, withFileTypes: true })
        .map((entry) => path.join(entry.parentPath ?? '', entry.name))
        .sort()
    const before = snapshot()
    detectRea({ env: {}, homeDir: home })
    expect(snapshot()).toEqual(before)
  })

  it('drops TEMP/TMP when the folder does not exist', () => {
    installRea(path.join(home, 'Desktop'), { temp: false })
    const env = detectRea({ env: {}, homeDir: home })!.env
    expect(env.TEMP).toBeUndefined()
    expect(env.TMP).toBeUndefined()
    expect(env.REA_ANALYSIS_PROVIDER).toBe('ghidra')
  })

  it('falls back to configuracao-mcp.json, then to a Ghidra found in ferramentas', () => {
    const { workspace } = installRea(path.join(home, 'Desktop'), { local: false })
    fs.writeFileSync(
      path.join(workspace, 'configuracao-mcp.json'),
      JSON.stringify({
        mcpServers: { rea: { command: process.execPath, args: [], env: { REA_ANALYSIS_PROVIDER: 'ida', JAVA_HOME: '/opt/jdk' } } }
      })
    )
    const fromMcp = detectRea({ env: {}, homeDir: home })!
    expect(fromMcp.command).toBe(process.execPath)
    expect(fromMcp.env.REA_ANALYSIS_PROVIDER).toBe('ida')
    expect(fromMcp.env.JAVA_HOME).toBe('/opt/jdk')

    fs.rmSync(path.join(workspace, 'configuracao-mcp.json'))
    const derived = detectRea({ env: {}, homeDir: home })!
    expect(derived.env.GHIDRA_INSTALL_DIR).toBe(path.join(workspace, 'ferramentas', 'ghidra_12.1.4_PUBLIC'))
    expect(derived.env.REA_ANALYSIS_PROVIDER).toBe('ghidra')
  })

  it('ignores a stale node path in configuracao-mcp.json', () => {
    const { workspace } = installRea(path.join(home, 'Desktop'), { local: false })
    fs.writeFileSync(
      path.join(workspace, 'configuracao-mcp.json'),
      JSON.stringify({ mcpServers: { rea: { command: path.join(home, 'gone', 'node.exe'), env: {} } } })
    )
    expect(detectRea({ env: {}, homeDir: home })!.command).toBe(process.execPath)
  })

  it('returns null when REA is missing or not built', () => {
    expect(detectRea({ env: {}, homeDir: home })).toBeNull()
    installRea(path.join(home, 'Desktop'), { dist: false })
    expect(detectRea({ env: {}, homeDir: home })).toBeNull()
    expect(reaMcpPreset({ launch: null })).toBeNull()
  })

  it('lists presets for the settings screen, with a reason when REA is absent', () => {
    const [absent] = listMcpPresets({ env: {}, homeDir: home })
    expect(absent).toMatchObject({ id: 'rea', server: null })
    expect(absent.unavailableReason).toMatch(/REA não encontrado/)

    installRea(path.join(home, 'Desktop'))
    const [present] = listMcpPresets({ env: {}, homeDir: home })
    expect(present.server).toMatchObject({ name: 'rea', enabled: true })
    expect(present.unavailableReason).toBeUndefined()
  })

  it('builds a preset with a long timeout and approval tools', () => {
    const { pkg } = installRea(path.join(home, 'Desktop'))
    const preset = reaMcpPreset({ launch: detectRea({ env: {}, homeDir: home }) })!

    expect(preset).toMatchObject({ name: 'rea', enabled: true, command: process.execPath, cwd: pkg, startTimeoutMs: 60_000 })
    // Ghidra may take 330 s to start: the call timeout must outlast it.
    expect(preset.timeoutMs).toBe(360_000)
    expect(preset.timeoutMs).toBeGreaterThanOrEqual(180_000)
    expect(preset.approvalTools).toEqual(REA_APPROVAL_TOOLS)
    expect(preset.includeTools).toBeUndefined()
    expect(preset.env).toMatchObject({ REA_ANALYSIS_PROVIDER: 'ghidra', REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' })

    const plain = reaMcpPreset({
      launch: { command: 'node', args: ['rea.mjs', 'mcp'], env: { REA_MCP_INPUT_SCHEMA_PROFILE: 'full' } },
      excludeTools: ['inspect_*']
    })!
    expect(plain.timeoutMs).toBe(300_000)
    expect(plain.env).toEqual({ REA_MCP_INPUT_SCHEMA_PROFILE: 'full' })
    expect(plain.excludeTools).toEqual(['inspect_*'])
    expect(plain.cwd).toBeUndefined()
  })

  it('asks for approval on tools that run or reach the target, never on analysis tools', () => {
    const preset = { approvalTools: REA_APPROVAL_TOOLS }
    for (const name of REA_GATED_TOOLS) expect(mcpToolRisk(preset, name), name).toBe('destructive')
    for (const name of REA_READ_TOOLS) expect(mcpToolRisk(preset, name), name).toBe('exec')
  })

  it('runs end to end: a client built from the preset filters and gates a REA-like server', async () => {
    const dirServer = await makeTempDir('forja-rea-srv-')
    try {
      const script = path.join(dirServer, 'fake-rea.cjs')
      await fs.promises.writeFile(script, CONFIGURABLE_SERVER, 'utf8')
      const preset = reaMcpPreset({
        launch: { command: process.execPath, args: [script], env: { FAKE_TOOLS: JSON.stringify([...REA_READ_TOOLS, ...REA_GATED_TOOLS]) } },
        excludeTools: ['uninstall_*']
      })!
      const mcp = new McpClient(preset)
      try {
        await mcp.start()
        const exposed = mcp.toolsList().map((t) => t.name)
        expect(exposed).not.toContain('uninstall_adb_package')
        expect(exposed).toContain('open_binary')
        expect(exposed).toContain('capture_process_scenario')
        expect(mcp.hiddenToolCount).toBe(1)
        expect(mcp.requiresApproval('capture_process_scenario')).toBe(true)
        expect(mcp.requiresApproval('open_binary')).toBe(false)
        expect(await mcp.callTool('open_binary', {})).toMatchObject({ ok: true })
      } finally {
        await mcp.stop()
      }
    } finally {
      await removeTempDir(dirServer)
    }
  })
})
