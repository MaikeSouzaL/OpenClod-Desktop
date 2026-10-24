import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudePermissionMode,
  codexSandbox,
  createExternalAgentTool,
  externalAgentTool,
  killExternalAgentProcesses,
  type ExternalAgentName
} from '../src/core/tools/external-agent'
import { buildRegistry, registerExternalAgents } from '../src/core/tools/registry'
import { WorkspaceGuard } from '../src/core/security/policy'
import { evaluateTool } from '../src/core/security/permissions'
import { ruleForApproval, ruleMatches } from '../src/core/security/rules'
import type { ToolContext } from '../src/core/tools/types'
import type { HarnessEvent, PermissionMode } from '../src/shared/types'
import { makeTempDir, policy, removeTempDir } from './helpers'

/**
 * The real claude/codex CLIs are never started here (they would spend the
 * user's account). A small node script plays both: it prints the JSON lines
 * those CLIs print and records how it was invoked. It is reached through a
 * `.cmd` shim on Windows / a `#!/bin/sh` wrapper elsewhere, in a directory
 * whose name contains spaces, exactly like an npm-installed CLI.
 */
const FAKE_CLI = String.raw`
const fs = require('node:fs')
const argv = process.argv.slice(2)
const kind = argv[0] === 'exec' ? 'codex' : 'claude'
const scenario = process.env.FAKE_SCENARIO || 'ok'

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (stdin += chunk))
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) {
    fs.writeFileSync(
      process.env.FAKE_LOG,
      JSON.stringify({
        kind,
        argv,
        stdin,
        cwd: process.cwd(),
        pid: process.pid,
        hasApiKey: Boolean(process.env.FAKE_API_KEY),
        scenarioSeen: scenario,
        noColor: process.env.NO_COLOR
      })
    )
  }
  Promise.resolve(kind === 'claude' ? claude() : codex()).catch((err) => {
    process.stderr.write(String(err && err.stack || err) + '\n')
    process.exitCode = 9
  })
})

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stayAlive = () => setInterval(() => {}, 1000)

const assistant = (content) => ({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content } })
const claudeResult = (extra) =>
  Object.assign(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      num_turns: 2,
      result: 'Resposta final do Claude',
      session_id: 'sess-1',
      total_cost_usd: 0.0421,
      usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 850, output_tokens: 77 },
      permission_denials: []
    },
    extra || {}
  )

async function claude() {
  emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fake', cwd: process.cwd() })
  switch (scenario) {
    case 'hang':
      stayAlive()
      return
    case 'progress':
      await sleep(450)
      emit(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]))
      await sleep(450)
      emit(assistant([{ type: 'text', text: 'testes executados' }]))
      emit(claudeResult())
      return
    case 'error':
      emit(claudeResult({ is_error: true, result: 'Invalid API key · Please run /login' }))
      process.exitCode = 1
      return
    case 'max-turns':
      emit(claudeResult({ subtype: 'error_max_turns', is_error: false, result: '' }))
      process.exitCode = 1
      return
    case 'denials':
      emit(claudeResult({ permission_denials: [{ tool_name: 'Edit' }, { tool_name: 'Bash' }, { tool_name: 'Edit' }] }))
      return
    case 'noresult':
      emit(assistant([{ type: 'text', text: 'resposta parcial' }]))
      return
    case 'stderr-exit':
      process.stderr.write('boom: algo deu errado\n')
      process.exitCode = 3
      return
    case 'garbage':
      process.stdout.write('isto nao e json\n\n{oops\n')
      process.stderr.write('aviso: ignorado\n')
      emit(claudeResult())
      return
    case 'linger':
      emit(claudeResult())
      stayAlive()
      return
    default:
      emit(assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }]))
      emit(assistant([{ type: 'text', text: 'quase pronto' }]))
      emit(claudeResult())
  }
}

async function codex() {
  emit({ type: 'thread.started', thread_id: 'thr-1' })
  emit({ type: 'turn.started' })
  switch (scenario) {
    case 'failed':
      emit({ type: 'error', message: 'Reconnecting... 1/5' })
      emit({ type: 'turn.failed', error: { message: 'quota exceeded' } })
      process.exitCode = 1
      return
    case 'reconnect':
      emit({ type: 'error', message: 'Reconnecting... 2/5' })
      emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Resposta apos reconexao' } })
      emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
      return
    case 'hang':
      stayAlive()
      return
    default:
      emit({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } })
      emit({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed' } })
      emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'primeira mensagem' } })
      emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Resposta final do Codex' } })
      emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80 } })
  }
}
`

let dir: string
let project: string
let script: string
let bins: Record<ExternalAgentName, string>
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['FORJA_CLAUDE_BIN', 'FORJA_CODEX_BIN', 'PATH', 'FAKE_API_KEY']

function writeWrapper(file: string): string {
  if (process.platform === 'win32') {
    const cmd = `${file}.cmd`
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    return cmd
  }
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  return file
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  dir = await makeTempDir('forja ext agent ')
  project = path.join(dir, 'proj ect')
  fs.mkdirSync(project)
  script = path.join(dir, 'fake-cli.cjs')
  fs.writeFileSync(script, FAKE_CLI, 'utf8')
  bins = { claude: writeWrapper(path.join(dir, 'fake-claude')), codex: writeWrapper(path.join(dir, 'fake-codex')) }
  process.env.FAKE_API_KEY = 'segredo-que-nao-deve-vazar'
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await removeTempDir(dir)
})

function toolFor(scenario: string, log?: string, doneGraceMs = 300) {
  return createExternalAgentTool({
    bin: bins,
    doneGraceMs,
    env: { FAKE_SCENARIO: scenario, ...(log ? { FAKE_LOG: log } : {}) }
  })
}

interface Harness {
  ctx: ToolContext
  events: HarnessEvent[]
  controller: AbortController
}

function harness(mode: PermissionMode = 'ask', cwd = project): Harness {
  const events: HarnessEvent[] = []
  const controller = new AbortController()
  const ctx = {
    sessionId: 'ses_ext',
    cwd,
    mode: 'code',
    policy: policy({ mode }),
    workspace: new WorkspaceGuard([project]),
    signal: controller.signal,
    emit: (event: HarnessEvent) => events.push(event),
    log: () => undefined
  } as unknown as ToolContext
  return { ctx, events, controller }
}

interface Invocation {
  kind: 'claude' | 'codex'
  argv: string[]
  stdin: string
  cwd: string
  pid: number
  hasApiKey: boolean
  noColor?: string
}

function readLog(file: string): Invocation {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Invocation
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condição não atingida a tempo')
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('permission mapping', () => {
  it('maps Openclod modes to Claude Code modes, never bypassing permissions', () => {
    expect(claudePermissionMode('readonly')).toBe('plan')
    expect(claudePermissionMode('ask')).toBe('default')
    expect(claudePermissionMode('accept-edits')).toBe('acceptEdits')
    expect(claudePermissionMode('auto')).toBe('acceptEdits')
    // A corrupted setting falls back to the most restrictive mode.
    expect(claudePermissionMode('whatever' as PermissionMode)).toBe('plan')
  })

  it('maps Openclod modes to Codex sandboxes, never full access', () => {
    expect(codexSandbox('readonly')).toBe('read-only')
    expect(codexSandbox('ask')).toBe('read-only')
    expect(codexSandbox('accept-edits')).toBe('workspace-write')
    expect(codexSandbox('auto')).toBe('workspace-write')
    expect(codexSandbox('whatever' as PermissionMode)).toBe('read-only')
  })
})

describe('external_agent: Claude Code', () => {
  it('runs print mode in the session cwd, feeds the prompt over stdin and parses the result', async () => {
    const log = path.join(dir, 'claude.json')
    const { ctx } = harness('ask')
    // Quotes, newlines and cmd.exe metacharacters must reach the CLI untouched.
    const prompt = 'Corrija "isso" & aquilo\n%PATH% | echo oi ^ > x (ok)'
    const result = await toolFor('ok', log).execute({ agent: 'claude', prompt }, ctx)

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Resposta final do Claude')
    expect(result.text).toContain('US$ 0.04')
    expect(result.data).toMatchObject({
      agent: 'claude',
      exitCode: 0,
      sessionId: 'sess-1',
      costUsd: 0.0421,
      turns: 2,
      usage: { input: 1000, output: 77, cachedInput: 850, costUsd: 0.0421 }
    })

    const seen = readLog(log)
    expect(seen.kind).toBe('claude')
    expect(seen.argv).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--disallowedTools=AskUserQuestion'
    ])
    expect(seen.stdin).toBe(prompt)
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(project))
    expect(seen.noColor).toBe('1')
    // Provider secrets of the parent are not inherited.
    expect(seen.hasApiKey).toBe(false)
  })

  it.each([
    ['readonly', 'plan'],
    ['ask', 'default'],
    ['accept-edits', 'acceptEdits'],
    ['auto', 'acceptEdits']
  ] as Array<[PermissionMode, string]>)('passes --permission-mode for %s as %s and nothing dangerous', async (mode, expected) => {
    const log = path.join(dir, `claude-${mode}.json`)
    const { ctx } = harness(mode)
    const result = await toolFor('ok', log).execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(true)
    const { argv } = readLog(log)
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe(expected)
    expect(argv.join(' ')).not.toMatch(/bypassPermissions|dangerously|skip-permissions/i)
  })

  it('streams progress as info notices when the context has emit', async () => {
    const { ctx, events } = harness('ask')
    const result = await toolFor('progress').execute({ agent: 'claude', prompt: 'rode os testes' }, ctx)

    expect(result.ok).toBe(true)
    const notices = events.filter((e): e is Extract<HarnessEvent, { type: 'notice' }> => e.type === 'notice')
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.every((n) => n.level === 'info' && n.text.startsWith('[Claude Code] ') && n.sessionId === 'ses_ext')).toBe(true)
    expect(notices.some((n) => n.text.includes('Bash: npm test'))).toBe(true)
  })

  it('reports a failed run with the CLI message and a non-ok result', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('error').execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('falhou')
    expect(result.text).toContain('Invalid API key')
    expect(result.data).toMatchObject({ exitCode: 1 })
  })

  it('reports the turn limit', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('max-turns').execute({ agent: 'claude', prompt: 'x' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('limite de turnos')
  })

  it('tells the model which actions the permission mode denied', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('denials').execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Ações negadas')
    expect(result.text).toContain('Edit, Bash')
    expect(result.data).toMatchObject({ permissionDenials: ['Edit', 'Bash'] })
  })

  it('fails with the partial answer when the CLI exits without a result line', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('noresult').execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('sem enviar o resultado final')
    expect(result.text).toContain('Resposta parcial')
    expect(result.text).toContain('resposta parcial')
  })

  it('includes stderr when the CLI dies without any JSON', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('stderr-exit').execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('código de saída 3')
    expect(result.text).toContain('boom: algo deu errado')
  })

  it('ignores blank, non-JSON and malformed lines between events', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('garbage').execute({ agent: 'claude', prompt: 'x' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Resposta final do Claude')
  })

  it('ends a CLI that delivers its result but does not exit, and still succeeds', async () => {
    const log = path.join(dir, 'linger.json')
    const { ctx } = harness('ask')
    const started = Date.now()
    const result = await toolFor('linger', log, 300).execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Resposta final do Claude')
    expect(Date.now() - started).toBeLessThan(8000)
    const { pid } = readLog(log)
    await waitFor(() => !alive(pid))
  })
})

describe('external_agent: Codex', () => {
  it('runs `codex exec --json` with a read-only sandbox and returns the last agent message', async () => {
    const log = path.join(dir, 'codex.json')
    const { ctx } = harness('ask')
    const result = await toolFor('ok', log).execute({ agent: 'codex', prompt: 'resuma o projeto' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Resposta final do Codex')
    expect(result.text).not.toContain('primeira mensagem')
    expect(result.data).toMatchObject({ agent: 'codex', sessionId: 'thr-1', usage: { input: 1200, output: 80, cachedInput: 1000 } })

    const seen = readLog(log)
    expect(seen.kind).toBe('codex')
    expect(seen.argv).toEqual(['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', 'read-only', '-'])
    expect(seen.stdin).toBe('resuma o projeto')
  })

  it.each([
    ['readonly', 'read-only'],
    ['ask', 'read-only'],
    ['accept-edits', 'workspace-write'],
    ['auto', 'workspace-write']
  ] as Array<[PermissionMode, string]>)('uses sandbox %s -> %s and never full access', async (mode, expected) => {
    const log = path.join(dir, `codex-${mode}.json`)
    const { ctx } = harness(mode)
    await toolFor('ok', log).execute({ agent: 'codex', prompt: 'x' }, ctx)

    const { argv } = readLog(log)
    expect(argv[argv.indexOf('-s') + 1]).toBe(expected)
    expect(argv.join(' ')).not.toMatch(/danger|bypass/i)
  })

  it('treats a turn.failed event as failure, with the model message', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('failed').execute({ agent: 'codex', prompt: 'x' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('quota exceeded')
  })

  it('does not treat a transient error event as failure when the answer arrives', async () => {
    const { ctx } = harness('ask')
    const result = await toolFor('reconnect').execute({ agent: 'codex', prompt: 'x' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Resposta apos reconexao')
  })
})

describe('external_agent: abort, timeout, missing CLI, policy', () => {
  it('kills the whole process tree when the signal aborts', async () => {
    const log = path.join(dir, 'hang.json')
    const { ctx, controller } = harness('ask')
    const pending = toolFor('hang', log).execute({ agent: 'claude', prompt: 'x', timeout_ms: 60_000 }, ctx)

    await waitFor(() => fs.existsSync(log) && fs.statSync(log).size > 0)
    const { pid } = readLog(log)
    expect(alive(pid)).toBe(true)

    controller.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.text).toContain('cancelada')
    expect(result.data).toMatchObject({ aborted: true })
    await waitFor(() => !alive(pid))
  })

  it('does not even start when the signal is already aborted', async () => {
    const log = path.join(dir, 'pre-aborted.json')
    const { ctx, controller } = harness('ask')
    controller.abort()
    const result = await toolFor('hang', log).execute({ agent: 'claude', prompt: 'x' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('cancelada')
    // The process may have been spawned a hair before the kill; make sure it is gone.
    if (fs.existsSync(log) && fs.statSync(log).size > 0) await waitFor(() => !alive(readLog(log).pid))
  })

  it('stops a run that exceeds timeout_ms', async () => {
    const log = path.join(dir, 'timeout.json')
    const { ctx } = harness('ask')
    const started = Date.now()
    const result = await toolFor('hang', log).execute({ agent: 'codex', prompt: 'x', timeout_ms: 1000 }, ctx)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('Tempo esgotado')
    expect(result.data).toMatchObject({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(15_000)
    await waitFor(() => !alive(readLog(log).pid))
  })

  it('killExternalAgentProcesses ends the runs of a session', async () => {
    const log = path.join(dir, 'session-kill.json')
    const { ctx } = harness('ask')
    const pending = toolFor('hang', log).execute({ agent: 'claude', prompt: 'x', timeout_ms: 60_000 }, ctx)
    await waitFor(() => fs.existsSync(log) && fs.statSync(log).size > 0)

    expect(killExternalAgentProcesses('ses_ext')).toBe(1)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(killExternalAgentProcesses('ses_ext')).toBe(0)
  })

  it('returns a Portuguese error when the CLI is not installed', async () => {
    const emptyBin = path.join(dir, 'empty-bin')
    fs.mkdirSync(emptyBin)
    process.env.PATH = emptyBin
    delete process.env.FORJA_CLAUDE_BIN
    delete process.env.FORJA_CODEX_BIN
    const { ctx } = harness('ask')

    const claude = await externalAgentTool.execute({ agent: 'claude', prompt: 'x' }, ctx)
    expect(claude.ok).toBe(false)
    expect(claude.text).toContain('Claude Code não está instalado')
    expect(claude.text).toContain('FORJA_CLAUDE_BIN')

    const codex = await externalAgentTool.execute({ agent: 'codex', prompt: 'x' }, ctx)
    expect(codex.ok).toBe(false)
    expect(codex.text).toContain('Codex não está instalado')
    expect(codex.text).toContain('FORJA_CODEX_BIN')
  })

  it('honours FORJA_CLAUDE_BIN / FORJA_CODEX_BIN and reports a bad path', async () => {
    const log = path.join(dir, 'env-bin.json')
    process.env.FORJA_CLAUDE_BIN = bins.claude
    const { ctx } = harness('ask')
    // The default tool reads the env at call time; FAKE_* reaches the child through the sanitized env copy.
    process.env.FAKE_SCENARIO = 'ok'
    process.env.FAKE_LOG = log
    try {
      const result = await externalAgentTool.execute({ agent: 'claude', prompt: 'via env' }, ctx)
      expect(result.ok).toBe(true)
      expect(readLog(log).stdin).toBe('via env')
    } finally {
      delete process.env.FAKE_SCENARIO
      delete process.env.FAKE_LOG
    }

    process.env.FORJA_CODEX_BIN = path.join(dir, 'does-not-exist')
    const missing = await externalAgentTool.execute({ agent: 'codex', prompt: 'x' }, ctx)
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('FORJA_CODEX_BIN aponta para um arquivo que não existe')
  })

  it('refuses a cwd outside the workspace and a cwd that does not exist', async () => {
    const { ctx } = harness('ask')
    const tool = toolFor('ok')

    const outside = await tool.execute({ agent: 'claude', prompt: 'x', cwd: dir }, ctx)
    expect(outside.ok).toBe(false)
    expect(outside.text).toContain('BLOQUEADO')

    const missing = await tool.execute({ agent: 'claude', prompt: 'x', cwd: 'nao-existe' }, ctx)
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('diretório de trabalho inexistente')
  })

  it('accepts a cwd inside the workspace', async () => {
    const sub = path.join(project, 'sub')
    fs.mkdirSync(sub)
    const log = path.join(dir, 'cwd.json')
    const { ctx } = harness('ask')
    const result = await toolFor('ok', log).execute({ agent: 'claude', prompt: 'x', cwd: 'sub' }, ctx)

    expect(result.ok).toBe(true)
    expect(fs.realpathSync(readLog(log).cwd)).toBe(fs.realpathSync(sub))
  })

  it('validates its input', async () => {
    const { ctx } = harness('ask')
    const tool = toolFor('ok')
    await expect(tool.execute({ agent: 'gemini', prompt: 'x' }, ctx)).rejects.toThrow()
    await expect(tool.execute({ agent: 'claude', prompt: '' }, ctx)).rejects.toThrow()
    await expect(tool.execute({ agent: 'claude', prompt: 'x', timeout_ms: 5 }, ctx)).rejects.toThrow()
  })
})

describe('external_agent: registration and approval', () => {
  it('is an approval-requiring exec tool, like run_command', () => {
    expect(externalAgentTool).toMatchObject({ name: 'external_agent', risk: 'exec', parallelSafe: false, requires: 'network' })

    const ask = evaluateTool(externalAgentTool, 'claude x', policy({ mode: 'ask' }), project)
    expect(ask.decision).toBe('ask')
    expect(evaluateTool(externalAgentTool, 'claude x', policy({ mode: 'accept-edits' }), project).decision).toBe('ask')
    expect(evaluateTool(externalAgentTool, 'claude x', policy({ mode: 'auto' }), project).decision).toBe('allow')
    expect(evaluateTool(externalAgentTool, 'claude x', policy({ mode: 'readonly' }), project).decision).toBe('deny')
    expect(evaluateTool(externalAgentTool, 'claude x', policy({ mode: 'auto', allowNetwork: false }), project).decision).toBe('deny')
  })

  it('registers in the registry and exposes a JSON schema to the model', () => {
    const registry = registerExternalAgents(buildRegistry())
    expect(registry.names()).toEqual(['external_agent'])
    const [spec] = registry.specs()
    expect(spec.name).toBe('external_agent')
    const properties = (spec.parameters as { properties: Record<string, { enum?: string[] }> }).properties
    expect(properties.agent.enum).toEqual(['claude', 'codex'])
    expect(Object.keys(properties)).toEqual(['agent', 'prompt', 'cwd', 'timeout_ms'])
    expect(() => registerExternalAgents(registry)).toThrow(/duplicada/)
  })

  it('answers to the Claude-style names Agent and ExternalAgent', () => {
    const match = (rule: string, tool: string, subject = 'claude faça algo'): boolean => ruleMatches(rule, tool, subject, project)

    expect(match('ExternalAgent', 'external_agent')).toBe(true)
    expect(match('Agent', 'external_agent')).toBe(true)
    expect(match('ExternalAgent(claude:*)', 'external_agent')).toBe(true)
    expect(match('ExternalAgent(codex:*)', 'external_agent')).toBe(false)
    // The specific name must not leak onto the sub-agent tool.
    expect(match('ExternalAgent', 'task')).toBe(false)
    expect(match('Agent', 'task')).toBe(true)
    // "Always allow" records the specific alias.
    expect(ruleForApproval('external_agent', 'claude x')).toBe('ExternalAgent(claude x)')
  })

  it('describes the call for the approval dialog', () => {
    const description = externalAgentTool.describe({ agent: 'codex', prompt: 'refatore\n  o módulo   de auth' })
    expect(description.title).toContain('Codex')
    expect(description.preview).toBe('codex refatore o módulo de auth')
    expect(externalAgentTool.describe(undefined).preview).toMatch(/^claude/)
  })
})
