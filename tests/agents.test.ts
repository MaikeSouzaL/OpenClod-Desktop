import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionRunner } from '../src/core/agent/runner'
import { ScriptedProvider, type MockTurn } from '../src/core/providers/mock'
import { buildRegistry } from '../src/core/tools/registry'
import { planTools } from '../src/core/tools/plan'
import type { ToolDef } from '../src/core/tools/types'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { toolsForMode } from '../src/core/security/permissions'
import { ruleForApproval, ruleMatches } from '../src/core/security/rules'
import {
  AGENT_MODES,
  DEFAULT_LIMITS,
  type AgentDefinition,
  type AgentMode,
  type ApprovalRequest,
  type HarnessEvent,
  type HarnessLimits,
  type ModelRequest,
  type PolicyConfig,
  type ProviderConfig,
  type ProviderEvent,
  type ToolSpec
} from '../src/shared/types'
import { BUILTIN_AGENTS, SUMMARY_PROMPT, TITLE_PROMPT, WORKER_AGENT } from '../src/core/agents/definitions'
import { AgentRegistry, createAgentRegistry } from '../src/core/agents/registry'
import {
  loadAgents,
  loadAgentsFromDir,
  parseAgentMarkdown,
  serializeAgent,
  writeAgentFile
} from '../src/core/agents/loader'
import {
  childPolicy,
  resolveAgentModel,
  resolveChildTools,
  spawnAgent,
  toolMatches,
  type AgentRuntimeEnv,
  type ChildInfo
} from '../src/core/agents/runtime'
import { childLimits, type AgentCaps } from '../src/core/agents/limits'
import { makeTempDir, policy, removeTempDir } from './helpers'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let root: string

beforeEach(async () => {
  root = await makeTempDir('forja-agents-')
})

afterEach(async () => {
  await removeTempDir(root)
})

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

function agentFile(name: string, extra = '', body = `You are ${name}.`): string {
  return `---\nname: ${name}\ndescription: Does ${name} things\n${extra}---\n\n${body}\n`
}

function parse(raw: string, imported = false): AgentDefinition {
  const parsed = parseAgentMarkdown(raw, 'fallback-name', 'user', imported)
  if (!parsed.agent) throw new Error(`unexpected parse error: ${parsed.error}`)
  return parsed.agent
}

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

describe('agent files: frontmatter', () => {
  it('reads a Claude Code style file (CRLF, BOM, comma tools, escapes, model alias)', () => {
    const raw =
      '\uFEFF---\r\nname: code-reviewer\r\ndescription: "Reviews code. Use after edits.\\nExamples: <example>user: hi</example>"\r\n' +
      'tools: Read, Grep, Glob, Bash\r\nmodel: sonnet\r\ncolor: blue\r\nmaxTurns: 12\r\ndisallowedTools: Write\r\n---\r\n\r\nYou are a reviewer.\r\nSecond line.\r\n'
    const def = parse(raw)
    expect(def).toEqual({
      name: 'code-reviewer',
      description: 'Reviews code. Use after edits.\nExamples: <example>user: hi</example>',
      systemPrompt: 'You are a reviewer.\nSecond line.',
      source: 'user',
      tools: ['read_file', 'grep', 'glob', 'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process'],
      disallowedTools: ['write_file'],
      color: 'blue',
      maxTurns: 12
    })
    // "sonnet" is a Claude alias no Openclod provider knows: the agent inherits instead.
    expect(def.model).toBeUndefined()
  })

  it('accepts block lists, flow lists, block scalars and quoting styles', () => {
    expect(parse(agentFile('a', 'tools:\n  - Read\n  - Grep\n')).tools).toEqual(['read_file', 'grep'])
    expect(parse(agentFile('a', 'tools: [Read, "Glob", \'Edit\']\n')).tools).toEqual(['read_file', 'glob', 'edit_file'])
    expect(parse(agentFile('a', 'tools: "*"\n')).tools).toBeUndefined()
    expect(parse(agentFile('a', 'tools: []\n')).tools).toEqual([])

    const literal = parse('---\nname: a\ndescription: |\n  First line\n  second line\n\n  third\ncolor: red\n---\nbody')
    expect(literal.description).toBe('First line\nsecond line\n\nthird')
    expect(literal.color).toBe('red')
    const folded = parse('---\nname: a\ndescription: >\n  First line\n  second line\n---\nbody')
    expect(folded.description).toBe('First line second line')

    const multi = parse('---\nname: a\ndescription: "wraps over\n  two lines"\n---\nbody')
    expect(multi.description).toBe('wraps over two lines')
    expect(parse("---\nname: a\ndescription: 'it''s fine'\n---\nbody").description).toBe("it's fine")
    expect(parse('---\nname: a\ndescription: Use when: the build fails # not part of it\n---\nbody').description).toBe('Use when: the build fails')
    expect(parse('---\nname: a\ndescription: plain text\n  continued here\n---\nbody').description).toBe('plain text continued here')
  })

  it('ignores comments, unknown keys and nested maps', () => {
    const def = parse(
      '---\n# a comment\nname: a\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks: []\nskills: foo\nmcpServers:\n  x: y\ncolor: teal\n---\nbody'
    )
    expect(def).toMatchObject({ name: 'a', description: 'd', color: 'teal' })
    expect(Object.keys(def).sort()).toEqual(['color', 'description', 'name', 'source', 'systemPrompt'])
  })

  it('maps Task(...) / Agent entries in tools to canCall instead of tools', () => {
    const named = parse(agentFile('a', 'tools: Read, Task(worker, Researcher)\n'))
    expect(named.tools).toEqual(['read_file'])
    expect(named.canCall).toEqual(['worker', 'researcher'])
    expect(parse(agentFile('a', 'tools: Read, Task\n')).canCall).toBe('*')
    expect(parse(agentFile('a', 'tools: Agent\n')).tools).toEqual([])
    // An explicit canCall wins over the Task(...) form.
    expect(parse(agentFile('a', 'tools: Task(x)\ncanCall: [y]\n')).canCall).toEqual(['y'])
  })

  it('reads Openclod extras: mode, canCall, effort, hidden, provider/model', () => {
    const def = parse(agentFile('a', 'mode: plan\ncanCall: "*"\neffort: high\nhidden: true\nmodel: openai/gpt-4o\nmaxTurns: 5\n'))
    expect(def).toMatchObject({ mode: 'plan', canCall: '*', effort: 'high', hidden: true, model: 'openai/gpt-4o', maxTurns: 5 })
    expect(parse(agentFile('a', 'canCall: explorer, coder\n')).canCall).toEqual(['explorer', 'coder'])
    expect(parse(agentFile('a', 'model: gpt-4o\n')).model).toBe('gpt-4o')
    // Bare model names inside Claude folders name Claude models; only the explicit provider/model form survives.
    expect(parse(agentFile('a', 'model: claude-opus-4-1\n'), true).model).toBeUndefined()
    expect(parse(agentFile('a', 'model: openai/gpt-4o\n'), true).model).toBe('openai/gpt-4o')
  })

  it('normalizes the name and falls back to the file name', () => {
    expect(parse(agentFile('Code_Reviewer')).name).toBe('code-reviewer')
    expect(parse('---\ndescription: d\n---\nbody').name).toBe('fallback-name')
  })

  it.each([
    ['no frontmatter', 'just text', /frontmatter/],
    ['unterminated frontmatter', '---\nname: a\ndescription: d\nbody', /fechamento/],
    ['missing description', '---\nname: a\n---\nbody', /description/],
    ['empty body', '---\nname: a\ndescription: d\n---\n\n', /prompt/],
    ['invalid mode', agentFile('a', 'mode: wizard\n'), /modo inválido/],
    ['invalid effort', agentFile('a', 'effort: ultra\n'), /effort inválido/],
    ['zero maxTurns', agentFile('a', 'maxTurns: 0\n'), /maxTurns/],
    ['non-numeric maxTurns', agentFile('a', 'maxTurns: many\n'), /maxTurns/],
    ['unusable name', agentFile('!!!'), /nome de agente inválido/],
    ['unclosed quote', '---\nname: a\ndescription: "oops\n---\nbody', /aspas/],
    ['garbage line', '---\nname: a\nthis is not yaml\n---\nbody', /linha inválida/]
  ])('rejects a file with %s', (_label, raw, message) => {
    const parsed = parseAgentMarkdown(raw, 'x', 'user')
    expect(parsed.agent).toBeUndefined()
    expect(parsed.error).toMatch(message)
  })
})

describe('agent folders', () => {
  it('loads valid files, skips the rest and reports a warning for each bad one', () => {
    const dir = path.join(root, 'agents')
    write(path.join(dir, 'good.md'), agentFile('good'))
    write(path.join(dir, 'also-good.md'), agentFile('also-good'))
    write(path.join(dir, 'bad.md'), 'no frontmatter at all')
    write(path.join(dir, 'worse.md'), '---\nname: worse\n---\nbody')
    write(path.join(dir, 'README.md'), '# not an agent')
    write(path.join(dir, 'notes.txt'), 'ignored')
    fs.mkdirSync(path.join(dir, 'nested.md'))
    write(path.join(dir, 'dup.md'), agentFile('good'))

    const loaded = loadAgentsFromDir(dir, 'user')
    expect(loaded.agents.map((a) => a.name).sort()).toEqual(['also-good', 'good'])
    expect(loaded.agents.every((a) => a.file?.startsWith(dir))).toBe(true)
    const warned = loaded.warnings.map((w) => path.basename(w.file)).sort()
    expect(warned).toEqual(['bad.md', 'dup.md', 'worse.md'])
    expect(loaded.warnings.find((w) => w.file.endsWith('bad.md'))?.message).toMatch(/frontmatter/)
    expect(loaded.warnings.find((w) => w.file.endsWith('dup.md'))?.message).toMatch(/duplicado/)
  })

  it('treats a missing folder as empty', () => {
    expect(loadAgentsFromDir(path.join(root, 'nope'), 'user')).toEqual({ agents: [], warnings: [] })
  })

  it('lets the project override the user, and the user override the built-ins', () => {
    const userDir = path.join(root, 'user-agents')
    const cwd = path.join(root, 'project')
    write(path.join(userDir, 'explorer.md'), agentFile('explorer', '', 'USER explorer'))
    write(path.join(userDir, 'shared.md'), agentFile('shared', '', 'USER shared'))
    write(path.join(cwd, '.forja', 'agents', 'shared.md'), agentFile('shared', '', 'PROJECT shared'))
    write(path.join(cwd, '.forja', 'agents', 'only-project.md'), agentFile('only-project'))

    const { agents } = loadAgents({ userDir, cwd })
    const byName = new Map(agents.map((a) => [a.name, a]))
    expect(byName.get('explorer')).toMatchObject({ source: 'user', systemPrompt: 'USER explorer' })
    expect(byName.get('shared')).toMatchObject({ source: 'project', systemPrompt: 'PROJECT shared' })
    expect(byName.get('only-project')?.source).toBe('project')
    expect(byName.get('coder')?.source).toBe('builtin')
    // Built-ins keep their place in the list even when overridden.
    expect(agents[0].name).toBe(BUILTIN_AGENTS[0].name)
  })

  it('reads Claude Code folders only when importClaude is set, read-only and with lower precedence', () => {
    const homeDir = path.join(root, 'home')
    const userDir = path.join(root, 'user-agents')
    const cwd = path.join(root, 'project')
    write(path.join(homeDir, '.claude', 'agents', 'home-agent.md'), agentFile('home-agent'))
    write(path.join(homeDir, '.claude', 'agents', 'clash.md'), agentFile('clash', '', 'HOME claude'))
    write(path.join(cwd, '.claude', 'agents', 'clash.md'), agentFile('clash', '', 'PROJECT claude'))
    write(path.join(cwd, '.claude', 'agents', 'native-clash.md'), agentFile('native-clash', '', 'PROJECT claude'))
    write(path.join(cwd, '.forja', 'agents', 'native-clash.md'), agentFile('native-clash', '', 'PROJECT forja'))
    write(path.join(userDir, 'home-agent.md'), agentFile('home-agent', '', 'USER forja'))
    write(path.join(cwd, '.claude', 'agents', 'broken.md'), 'nothing here')

    const off = loadAgents({ userDir, cwd, homeDir, importClaude: false })
    expect(off.agents.map((a) => a.name)).not.toContain('clash')
    expect(off.agents.find((a) => a.name === 'home-agent')).toMatchObject({ systemPrompt: 'USER forja', source: 'user' })
    expect(off.warnings).toEqual([])

    const on = loadAgents({ userDir, cwd, homeDir, importClaude: true })
    const byName = new Map(on.agents.map((a) => [a.name, a]))
    expect(byName.get('clash')).toMatchObject({ systemPrompt: 'PROJECT claude', source: 'project', imported: true })
    // Openclod's own files beat the imported ones at the same level; project beats user.
    expect(byName.get('native-clash')).toMatchObject({ systemPrompt: 'PROJECT forja' })
    expect(byName.get('native-clash')?.imported).toBeUndefined()
    expect(byName.get('home-agent')).toMatchObject({ systemPrompt: 'USER forja' })
    expect(on.warnings.map((w) => path.basename(w.file))).toEqual(['broken.md'])
  })

  it('builds a registry from the folders', () => {
    const userDir = path.join(root, 'user-agents')
    write(path.join(userDir, 'mine.md'), agentFile('mine'))
    const registry = createAgentRegistry({ userDir })
    expect(registry.get('mine')?.source).toBe('user')
    expect(registry.get('coder')).toBeDefined()
  })
})

describe('agent files: writing', () => {
  const sample: AgentDefinition = {
    name: 'my-agent',
    description: 'Does "quoted" things:\nacross lines',
    systemPrompt: 'Line one.\n\n---\nstill the prompt',
    mode: 'plan',
    tools: ['read_file', 'browser_*'],
    disallowedTools: ['delete_path'],
    canCall: ['explorer', 'coder'],
    model: 'inherit',
    effort: 'xhigh',
    maxTurns: 9,
    color: 'teal',
    hidden: true,
    source: 'user'
  }

  it('round-trips through serializeAgent and the parser', () => {
    const parsed = parse(serializeAgent(sample))
    expect(parsed).toEqual(sample)
  })

  it('round-trips every built-in definition', () => {
    for (const builtin of BUILTIN_AGENTS) {
      const parsed = parse(serializeAgent(builtin))
      expect(parsed, builtin.name).toEqual({ ...builtin, source: 'user' })
    }
  })

  it('writes <name>.md, refuses to overwrite unless asked, and the file loads back', () => {
    const dir = path.join(root, 'out')
    const file = writeAgentFile(dir, sample)
    expect(file).toBe(path.join(dir, 'my-agent.md'))
    expect(loadAgentsFromDir(dir, 'user').agents[0]).toMatchObject({ name: 'my-agent', mode: 'plan', canCall: ['explorer', 'coder'] })

    expect(() => writeAgentFile(dir, sample)).toThrow(/já existe/)
    expect(fs.readFileSync(file, 'utf8')).toContain('effort: xhigh')
    writeAgentFile(dir, { ...sample, effort: 'low' }, { overwrite: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('effort: low')
  })

  it.each(['../evil', '..\\evil', 'a/b', 'a\\b', '/etc/passwd', 'C:\\x', '', '.', '..', 'UPPER', 'two words', 'x'.repeat(65)])(
    'refuses the name %j and writes nothing',
    (name) => {
      const dir = path.join(root, 'out', 'agents')
      expect(() => writeAgentFile(dir, { ...sample, name })).toThrow(/agente inválido|nome/)
      expect(fs.existsSync(path.join(root, 'out', 'evil.md'))).toBe(false)
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
    }
  )

  it('refuses invalid definitions and Claude Code\'s read-only folder', () => {
    const dir = path.join(root, 'out')
    expect(() => writeAgentFile(dir, { ...sample, description: ' ' })).toThrow(/descrição/)
    expect(() => writeAgentFile(dir, { ...sample, systemPrompt: '' })).toThrow(/prompt/)
    expect(() => writeAgentFile(dir, { ...sample, mode: 'wizard' as AgentMode })).toThrow(/modo/)
    expect(() => writeAgentFile(dir, { ...sample, canCall: ['Not Valid'] })).toThrow(/canCall/)
    expect(() => writeAgentFile(path.join(root, 'proj', '.claude', 'agents'), sample)).toThrow(/\.claude/)
    expect(fs.existsSync(path.join(root, 'proj'))).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* Built-ins                                                           */
/* ------------------------------------------------------------------ */

describe('built-in agents', () => {
  const byName = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]))

  it('has the requested specialists with valid, unique definitions', () => {
    const expected = [
      'orchestrator', 'explorer', 'planner', 'coder', 'reviewer', 'tester', 'debugger', 'security-auditor',
      'researcher', 'docs-writer', 'computer-operator', 'go-specialist', 'rust-specialist', 'python-specialist',
      'typescript-specialist', 'title', 'summary'
    ]
    for (const name of expected) expect(byName.has(name), name).toBe(true)
    expect(byName.size).toBe(BUILTIN_AGENTS.length)
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.source).toBe('builtin')
      expect(agent.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(agent.description.length).toBeGreaterThan(20)
      expect(agent.systemPrompt.length).toBeGreaterThan(100)
      expect(AGENT_MODES).toContain(agent.mode ?? 'code')
    }
    expect(byName.get('computer-operator')?.mode).toBe('computer')
    expect(byName.get('orchestrator')?.canCall).toBe('*')
  })

  it('points every canCall at an agent that exists', () => {
    for (const agent of BUILTIN_AGENTS) {
      if (!Array.isArray(agent.canCall)) continue
      for (const target of agent.canCall) expect(byName.has(target), `${agent.name} -> ${target}`).toBe(true)
    }
    expect(byName.get('coder')?.canCall).toEqual(expect.arrayContaining(['explorer', 'tester', 'debugger', 'go-specialist', 'rust-specialist', 'python-specialist', 'typescript-specialist']))
    expect(byName.get('reviewer')?.canCall).toEqual(expect.arrayContaining(['explorer', 'security-auditor']))
    expect(byName.get('debugger')?.canCall).toEqual(expect.arrayContaining(['explorer', 'tester']))
  })

  it('has an acyclic explicit call graph (the orchestrator\'s "*" aside)', () => {
    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (name: string, trail: string[]): void => {
      if (done.has(name)) return
      expect(visiting.has(name), `cycle: ${[...trail, name].join(' -> ')}`).toBe(false)
      visiting.add(name)
      const calls = byName.get(name)?.canCall
      if (Array.isArray(calls)) for (const next of calls) visit(next, [...trail, name])
      visiting.delete(name)
      done.add(name)
    }
    for (const agent of BUILTIN_AGENTS) visit(agent.name, [])
  })

  it('hides the utilities and tells every visible agent to use the user\'s language', () => {
    const hidden = BUILTIN_AGENTS.filter((a) => a.hidden).map((a) => a.name).sort()
    expect(hidden).toEqual(['summary', 'title', WORKER_AGENT].sort())
    expect(byName.get('title')?.systemPrompt).toBe(TITLE_PROMPT)
    expect(byName.get('summary')?.systemPrompt).toBe(SUMMARY_PROMPT)
    expect(byName.get('title')?.tools).toEqual([])
    for (const agent of BUILTIN_AGENTS.filter((a) => !a.hidden)) {
      expect(agent.systemPrompt, agent.name).toMatch(/language of the request/i)
      expect(agent.systemPrompt, agent.name).toMatch(/concise and factual/i)
      expect(agent.systemPrompt, agent.name).toMatch(/files you read or changed/i)
    }
  })

  it('credits opencode above every prompt adapted from it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'agents', 'definitions.ts'), 'utf8')
    const credit = '// Adapted from opencode (MIT), packages/core/src/plugin/agent.ts'
    for (const constant of ['const EXPLORER_PROMPT', 'export const TITLE_PROMPT', 'export const SUMMARY_PROMPT']) {
      const at = source.indexOf(constant)
      expect(at, constant).toBeGreaterThan(0)
      expect(source.slice(Math.max(0, at - credit.length - 2), at), constant).toContain(credit)
    }
  })

  it('teaches the language specialists to detect the real toolchain', () => {
    const text = (name: string): string => byName.get(name)!.systemPrompt
    expect(text('go-specialist')).toMatch(/go build[\s\S]*go vet[\s\S]*go test/)
    expect(text('rust-specialist')).toMatch(/cargo check[\s\S]*cargo test[\s\S]*clippy/)
    expect(text('python-specialist')).toMatch(/pytest[\s\S]*ruff[\s\S]*mypy/)
    expect(text('typescript-specialist')).toMatch(/tsc[\s\S]*vitest/)
    for (const name of ['go-specialist', 'rust-specialist', 'python-specialist', 'typescript-specialist']) {
      expect(text(name), name).toMatch(/detect/i)
    }
  })
})

describe('agent registry', () => {
  const registry = new AgentRegistry()

  it('never lists hidden agents and lets the user\'s session call every visible one', () => {
    const visible = registry.list().map((a) => a.name)
    expect(visible).not.toContain('title')
    expect(visible).not.toContain('summary')
    expect(visible).not.toContain(WORKER_AGENT)
    expect(registry.list({ includeHidden: true }).map((a) => a.name)).toContain('title')
    expect(registry.callableBy(undefined).map((a) => a.name)).toEqual(visible)
  })

  it('limits a caller to its canCall list and treats "*" as every visible agent', () => {
    expect(registry.callableBy('explorer')).toEqual([])
    expect(registry.callableBy('coder').map((a) => a.name)).toEqual(registry.get('coder')!.canCall)
    expect(registry.callableBy('orchestrator').map((a) => a.name)).toEqual(registry.list().map((a) => a.name))
    expect(registry.callableBy('does-not-exist')).toEqual([])
    expect(registry.canCall('coder', 'explorer')).toBe(true)
    expect(registry.canCall('coder', 'orchestrator')).toBe(false)
    expect(registry.canCall('orchestrator', 'title')).toBe(false)
  })
})

describe('agent tools in modes and rules', () => {
  it.each(['code', 'debug', 'plan', 'review', 'autonomous', 'web', 'computer'] as const)('offers agent and list_agents in %s mode', (mode) => {
    expect(toolsForMode(mode)).toEqual(expect.arrayContaining(['agent', 'list_agents', 'task']))
  })

  it('never offers them in ask mode', () => {
    expect(toolsForMode('ask')).not.toContain('agent')
    expect(toolsForMode('ask')).not.toContain('list_agents')
  })

  it('answers to the Claude names Agent and Task', () => {
    const match = (rule: string, tool: string, subject = 'coder fix the bug'): boolean => ruleMatches(rule, tool, subject, root)
    expect(match('Agent', 'agent')).toBe(true)
    expect(match('Task', 'agent')).toBe(true)
    expect(match('Agent(coder:*)', 'agent')).toBe(true)
    expect(match('Agent(tester:*)', 'agent')).toBe(false)
    expect(match('Agent', 'task')).toBe(true)
    expect(match('ExternalAgent', 'agent')).toBe(false)
    expect(ruleForApproval('agent', 'coder fix')).toBe('Agent(coder fix)')
  })
})

/* ------------------------------------------------------------------ */
/* Pure runtime helpers                                                */
/* ------------------------------------------------------------------ */

describe('toolset resolution', () => {
  const def = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
    name: 't', description: 'd', systemPrompt: 'p', source: 'builtin', ...extra
  })
  const available = ['read_file', 'write_file', 'run_command', 'browser_open', 'browser_click', 'mcp__srv__x', 'memory_write', 'external_agent', 'agent', 'list_agents', 'task']

  it('matches exact names and globs', () => {
    expect(toolMatches('read_file', 'read_file')).toBe(true)
    expect(toolMatches('browser_*', 'browser_open')).toBe(true)
    expect(toolMatches('browser_*', 'computer_click')).toBe(false)
    expect(toolMatches('mcp__*', 'mcp__srv__x')).toBe(true)
    expect(toolMatches('read', 'read_file')).toBe(false)
  })

  it('gives every tool but the opt-in and delegation ones when the definition lists none', () => {
    const { tools } = resolveChildTools({ def: def(), generic: false, available, canDelegate: false })
    expect(tools).toEqual(['read_file', 'write_file', 'run_command', 'browser_open', 'browser_click', 'mcp__srv__x'])
  })

  it('hands out opt-in tools only when the definition names them', () => {
    const { tools } = resolveChildTools({ def: def({ tools: ['read_file', 'memory_write'] }), generic: false, available, canDelegate: false })
    expect(tools).toEqual(['read_file', 'memory_write'])
  })

  it('applies tools globs, disallowedTools and delegation', () => {
    const { tools } = resolveChildTools({
      def: def({ tools: ['read_file', 'browser_*'], disallowedTools: ['browser_click'], canCall: '*' }),
      generic: false,
      available,
      canDelegate: true
    })
    expect(tools).toEqual(['read_file', 'browser_open', 'agent', 'list_agents', 'task'])
  })

  it('adds task only for agents that can call anyone, and only when the caller has it', () => {
    const some = resolveChildTools({ def: def({ tools: ['read_file'], canCall: ['x'] }), generic: false, available, canDelegate: true })
    expect(some.tools).toEqual(['read_file', 'agent', 'list_agents'])
    const none = resolveChildTools({ def: def({ tools: ['read_file'], canCall: '*' }), generic: false, available: ['read_file'], canDelegate: true })
    expect(none.tools).toEqual(['read_file'])
  })

  it('lets a call only narrow the toolset', () => {
    const base = def({ tools: ['read_file', 'run_command'] })
    const narrowed = resolveChildTools({ def: base, generic: false, requested: ['read_file', 'write_file', 'browser_*'], available, canDelegate: false })
    expect(narrowed.tools).toEqual(['read_file'])
    expect(narrowed.ignored).toEqual(['write_file', 'browser_*'])
  })

  it('keeps the legacy task semantics: the request replaces the default, bounded by the caller', () => {
    const worker = BUILTIN_AGENTS.find((a) => a.name === WORKER_AGENT)!
    const defaults = resolveChildTools({ def: worker, generic: true, available, canDelegate: false }).tools
    expect(defaults).toContain('read_file')
    expect(defaults).toContain('run_command')
    expect(defaults).not.toContain('write_file')
    expect(defaults).not.toContain('agent')
    const asked = resolveChildTools({ def: worker, generic: true, requested: ['write_file', 'task', 'nope'], available, canDelegate: false }).tools
    expect(asked).toEqual(['write_file'])
  })
})

describe('policy, model and limits for children', () => {
  it('never makes a child more permissive than its caller', () => {
    expect(childPolicy(policy({ mode: 'auto' })).mode).toBe('auto')
    expect(childPolicy(policy({ mode: 'ask' })).mode).toBe('ask')
    expect(childPolicy(policy({ mode: 'accept-edits' })).mode).toBe('ask')
    expect(childPolicy(policy({ mode: 'readonly' })).mode).toBe('readonly')
    const parent = policy({ mode: 'auto', rules: { allow: ['Read'], ask: [], deny: ['Bash(rm:*)'] } })
    expect(childPolicy(parent).rules).toBe(parent.rules)
  })

  it('resolves the model of a definition', () => {
    const parent = { id: 'p', label: 'P', model: 'm1' } as ProviderConfig
    const other = { id: 'other', label: 'O', model: 'x' } as ProviderConfig
    const find = (id: string): ProviderConfig | undefined => (id === 'other' ? other : undefined)
    expect(resolveAgentModel(undefined, parent, find)).toBe(parent)
    expect(resolveAgentModel('inherit', parent, find)).toBe(parent)
    expect(resolveAgentModel('other/gpt-x', parent, find)).toMatchObject({ id: 'other', model: 'gpt-x' })
    expect(resolveAgentModel('m2', parent, find)).toMatchObject({ id: 'p', model: 'm2' })
    // A slash that is not a configured provider belongs to the model id.
    expect(resolveAgentModel('meta/llama-3', parent, find)).toMatchObject({ id: 'p', model: 'meta/llama-3' })
  })

  it('shrinks the limits at every level and never exceeds the caller', () => {
    const level1 = childLimits(DEFAULT_LIMITS, 1)
    const level2 = childLimits(level1, 2)
    const level3 = childLimits(level2, 3)
    for (const key of ['maxIterations', 'maxToolCalls', 'maxWallClockMs', 'maxTokens', 'maxCostUsd'] as const) {
      expect(level1[key], key).toBeLessThan(DEFAULT_LIMITS[key])
      expect(level2[key], key).toBeLessThan(level1[key])
      expect(level3[key], key).toBeLessThan(level2[key])
    }
    expect(level1.maxParallelTools).toBe(DEFAULT_LIMITS.maxParallelTools)
    const tight = childLimits({ ...DEFAULT_LIMITS, maxIterations: 3 }, 1)
    expect(tight.maxIterations).toBe(3)
    expect(childLimits(DEFAULT_LIMITS, 1, { maxTurns: 7 }).maxIterations).toBe(7)
    expect(childLimits(DEFAULT_LIMITS, 1, { maxTurns: 500 }).maxIterations).toBe(DEFAULT_LIMITS.maxIterations)
    // "No cost cap" stays that way.
    expect(childLimits({ ...DEFAULT_LIMITS, maxCostUsd: 0 }, 2).maxCostUsd).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* The agent tool, end to end through SessionRunner                    */
/* ------------------------------------------------------------------ */

const readTool: ToolDef = {
  name: 'read_file',
  description: 'fake read tool',
  schema: z.object({ path: z.string() }),
  risk: 'read',
  parallelSafe: true,
  describe: (raw) => ({ title: 'Ler arquivo', detail: String((raw as { path: string }).path) }),
  async execute(raw) {
    return { ok: true, text: `conteúdo de ${(raw as { path: string }).path}`, summary: 'lido' }
  }
}

const writeTool: ToolDef = {
  name: 'write_file',
  description: 'fake write tool',
  schema: z.object({ path: z.string() }),
  risk: 'write',
  parallelSafe: false,
  describe: (raw) => ({ title: 'Escrever arquivo', detail: String((raw as { path: string }).path) }),
  async execute(raw, ctx) {
    const target = (raw as { path: string }).path
    ctx.tracker.recordChange(path.join(ctx.cwd, target), null, 'novo conteúdo\n')
    return { ok: true, text: `escrito ${target}`, summary: 'escrito' }
  }
}

const runTool: ToolDef = {
  name: 'run_command',
  description: 'fake shell',
  schema: z.object({ command: z.string() }),
  risk: 'exec',
  parallelSafe: false,
  describe: (raw) => ({ title: 'Comando', detail: String((raw as { command: string }).command), preview: String((raw as { command: string }).command) }),
  async execute() {
    return { ok: true, text: 'ok' }
  }
}

/** A scripted provider that can run code when a request starts and remembers the real abort signals. */
class HookedProvider extends ScriptedProvider {
  signals: AbortSignal[] = []

  constructor(
    queue: MockTurn[],
    private readonly hook?: (req: ModelRequest) => Promise<void>
  ) {
    super(queue)
  }

  override async *stream(req: ModelRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    if (req.signal) this.signals.push(req.signal)
    await this.hook?.(req)
    yield* super.stream(req)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Rejects as soon as the request is aborted, like a real network stream would. */
const hangUntilAborted = (req: ModelRequest): Promise<void> =>
  new Promise((_resolve, reject) => {
    const abort = (): void => reject(new Error('aborted'))
    if (req.signal?.aborted) abort()
    else req.signal?.addEventListener('abort', abort, { once: true })
  })

const agentCall = (id: string, agent: string, extra: Record<string, unknown> = {}): NonNullable<MockTurn['toolCalls']> => [
  { id, name: 'agent', args: { agent, label: `${agent} job`, prompt: `Faça o trabalho de ${agent} com cuidado.`, ...extra } }
]

type SubagentEvent = Extract<HarnessEvent, { type: 'subagent' }>
type ToolStart = Extract<HarnessEvent, { type: 'tool_start' }>
type ToolEnd = Extract<HarnessEvent, { type: 'tool_end' }>

const subagents = (events: HarnessEvent[]): SubagentEvent[] => events.filter((e): e is SubagentEvent => e.type === 'subagent')
const toolEnds = (events: HarnessEvent[], name?: string): ToolEnd[] =>
  events.filter((e): e is ToolEnd => e.type === 'tool_end' && (!name || e.name === name))
const toolNames = (provider: ScriptedProvider, request = 0): string[] => provider.requests[request].tools.map((t: ToolSpec) => t.name)

const customAgent = (name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name,
  description: `Custom agent ${name}`,
  systemPrompt: `You are ${name}.`,
  mode: 'code',
  source: 'user',
  ...extra
})

interface TreeOptions {
  script: MockTurn[]
  children?: Record<string, ScriptedProvider[]>
  agents?: AgentRegistry
  mode?: AgentMode
  policy?: PolicyConfig
  limits?: Partial<HarnessLimits>
  caps?: Partial<AgentCaps>
  tools?: ToolDef[]
  approve?: (request: ApprovalRequest) => Promise<boolean>
  findProvider?: (id: string) => ProviderConfig | undefined
  withAgents?: boolean
}

function makeTree(options: TreeOptions) {
  const events: HarnessEvent[] = []
  const spawned: Array<{ info: ChildInfo; provider: ScriptedProvider; config: ProviderConfig }> = []
  const queues = Object.fromEntries(Object.entries(options.children ?? {}).map(([name, list]) => [name, [...list]]))
  const registry = buildRegistry(readTool, writeTool, runTool, ...planTools, ...(options.tools ?? []))
  const agents = options.agents ?? new AgentRegistry()
  const approvals: ApprovalRequest[] = []
  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    approvals.push(request)
    return options.approve ? options.approve(request) : true
  }
  const env: AgentRuntimeEnv = {
    agents,
    tools: registry,
    createProvider: (config, info) => {
      const provider = queues[info.agent]?.shift() ?? new ScriptedProvider([{ text: `ok ${info.agent}` }])
      spawned.push({ info, provider, config })
      return provider
    },
    findProvider: options.findProvider ?? (() => undefined),
    emit: (event) => events.push(event),
    approve,
    caps: options.caps,
    retryBaseMs: 1
  }
  const tracker = new FileTracker(root)
  const provider = new ScriptedProvider(options.script)
  const runner = new SessionRunner({
    sessionId: 'ses_root',
    cwd: root,
    mode: options.mode ?? 'code',
    provider,
    providerConfig: {
      id: 'mock', kind: 'mock', label: 'Scripted', baseUrl: '', model: 'scripted',
      contextWindow: 128_000, supportsVision: false, supportsTools: true
    },
    registry,
    policy: options.policy ?? policy({ mode: 'auto' }),
    limits: { ...DEFAULT_LIMITS, maxIterations: 8, ...options.limits },
    tracker,
    workspace: new WorkspaceGuard([root]),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as never,
    project: { name: 'Teste', isGitRepo: false },
    emit: (event) => events.push(event),
    approve,
    ...(options.withAgents === false ? {} : { agents, runSubagent: (spec, caller) => spawnAgent(env, caller, spec) }),
    retryBaseMs: 1,
    depth: 0
  })
  return { runner, events, spawned, env, provider, tracker, registry, approvals, agents }
}

describe('the agent tool', () => {
  it('delegates to a specialist and returns its answer, with the right prompt, tools and effort', async () => {
    const explorer = new ScriptedProvider([
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'a.ts' } }] },
      { text: 'Achei em /x/a.ts' }
    ])
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'explorer') }, { text: 'feito' }],
      children: { explorer: [explorer] }
    })
    await tree.runner.send('onde fica o parser?')

    const result = tree.runner.messages.find((m) => m.role === 'tool')!.parts[0]
    expect(result).toMatchObject({ type: 'tool_result', name: 'agent', ok: true })
    expect((result as { text: string }).text).toContain('<agent name="explorer" label="explorer job">')
    expect((result as { text: string }).text).toContain('Achei em /x/a.ts')

    // The specialist got its own prompt, the call note and a read-only toolset at low effort.
    const request = explorer.requests[0]
    expect(request.system).toContain('codebase search specialist')
    expect(request.system).toContain('nível 1 de 3')
    expect(request.system).toContain('sessão principal do usuário')
    expect(toolNames(explorer)).toContain('read_file')
    for (const forbidden of ['write_file', 'run_command', 'agent', 'list_agents', 'task', 'memory_write']) {
      expect(toolNames(explorer), forbidden).not.toContain(forbidden)
    }
    expect(request.effort).toBe('low')
    expect(tree.runner.state).toBe('done')
  })

  it('lists the callable agents with their descriptions in the tool description, never the hidden ones', async () => {
    const tree = makeTree({ script: [{ text: 'oi' }] })
    await tree.runner.send('oi')
    const spec = tree.provider.requests[0].tools.find((t: ToolSpec) => t.name === 'agent')!
    expect(spec.description).toContain('- explorer: Read-only codebase search')
    expect(spec.description).toContain('- orchestrator:')
    expect(spec.description).toContain('nível 0 de 3')
    for (const hidden of ['title', 'summary', WORKER_AGENT]) expect(spec.description).not.toContain(`- ${hidden}:`)
    expect(toolNames(tree.provider)).toContain('list_agents')
    const properties = (spec.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties)).toEqual(['agent', 'label', 'prompt', 'tools'])
    expect((spec.parameters as { required: string[] }).required).toEqual(['agent', 'prompt'])
  })

  it('does not offer the agent tools to a session without an agent registry', async () => {
    const tree = makeTree({ script: [{ text: 'oi' }], withAgents: false })
    await tree.runner.send('oi')
    expect(toolNames(tree.provider)).not.toContain('agent')
    expect(toolNames(tree.provider)).not.toContain('list_agents')
  })

  it('lets a child call a grandchild when its definition allows it (depth 2)', async () => {
    const explorer = new ScriptedProvider([{ toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'deep.ts' } }] }, { text: 'neto: achei' }])
    const coder = new ScriptedProvider([{ toolCalls: agentCall('g1', 'explorer') }, { text: 'filho: resumo do neto = neto: achei' }])
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'fim' }],
      children: { coder: [coder], explorer: [explorer] }
    })
    await tree.runner.send('implemente')

    expect(tree.spawned.map((s) => s.info.agent)).toEqual(['coder', 'explorer'])
    // The coder was told it may delegate; its tool list carries the delegation tools.
    expect(toolNames(coder)).toEqual(expect.arrayContaining(['agent', 'list_agents', 'write_file']))
    expect(coder.requests[0].system).toContain('Você pode delegar')
    // ...and it received the grandchild's report.
    const report = coder.requests[1].messages.find((m: { role: string }) => m.role === 'tool')!.parts[0]
    expect((report as { text: string }).text).toContain('neto: achei')
    expect((tree.runner.messages.at(-1)!.parts[0] as { text: string }).text).toBe('fim')

    const events = subagents(tree.events)
    const coderStart = events.find((e) => e.agent === 'coder' && e.state === 'thinking')!
    const explorerStart = events.find((e) => e.agent === 'explorer' && e.state === 'thinking')!
    expect(coderStart).toMatchObject({ depth: 1, parentChildId: undefined, sessionId: 'ses_root' })
    expect(explorerStart).toMatchObject({ depth: 2, parentChildId: coderStart.childId, sessionId: 'ses_root' })
    // The grandchild's tool events are attributed to it, under the root session.
    const grandchildTool = tree.events.find((e): e is ToolStart => e.type === 'tool_start' && e.name === 'read_file')!
    expect(grandchildTool).toMatchObject({ sessionId: 'ses_root', agentId: explorerStart.childId })
  })

  it('refuses to go deeper than the depth limit with a clear tool error', async () => {
    const agents = new AgentRegistry([
      customAgent('a1', { canCall: ['a2'] }),
      customAgent('a2', { canCall: ['a3'] }),
      customAgent('a3', { canCall: ['a4'] }),
      customAgent('a4')
    ])
    const a3 = new ScriptedProvider([{ toolCalls: agentCall('x3', 'a4') }, { text: 'a3 sem neto' }])
    const tree = makeTree({
      agents,
      script: [{ toolCalls: agentCall('c1', 'a1') }, { text: 'fim' }],
      children: {
        a1: [new ScriptedProvider([{ toolCalls: agentCall('x1', 'a2') }, { text: 'a1 ok' }])],
        a2: [new ScriptedProvider([{ toolCalls: agentCall('x2', 'a3') }, { text: 'a2 ok' }])],
        a3: [a3]
      }
    })
    await tree.runner.send('vá fundo')

    expect(tree.spawned.map((s) => s.info.agent)).toEqual(['a1', 'a2', 'a3'])
    const refusal = a3.requests[1].messages.find((m: { role: string }) => m.role === 'tool')!.parts[0] as { ok: boolean; text: string }
    expect(refusal.ok).toBe(false)
    expect(refusal.text).toMatch(/profundidade/)
    expect(refusal.text).toContain('máximo é 3')
    expect(a3.requests[0].system).toContain('nível máximo')
    const spec = a3.requests[0].tools.find((t: ToolSpec) => t.name === 'agent')!
    expect(spec.description).toContain('nível máximo de delegação')
    // The whole chain still completes.
    expect(tree.runner.state).toBe('done')
  })

  it('honours HarnessLimits.maxAgentDepth', async () => {
    const agents = new AgentRegistry([customAgent('a1', { canCall: ['a2'] }), customAgent('a2')])
    const a1 = new ScriptedProvider([{ toolCalls: agentCall('x1', 'a2') }, { text: 'a1 ok' }])
    const tree = makeTree({
      agents,
      limits: { maxAgentDepth: 1 },
      script: [{ toolCalls: agentCall('c1', 'a1') }, { text: 'fim' }],
      children: { a1: [a1] }
    })
    await tree.runner.send('x')
    expect(tree.spawned.map((s) => s.info.agent)).toEqual(['a1'])
    const refusal = a1.requests[1].messages.find((m: { role: string }) => m.role === 'tool')!.parts[0] as { text: string }
    expect(refusal.text).toContain('máximo é 1')
  })

  it('stops an agent from appearing more than twice in its own chain', async () => {
    const agents = new AgentRegistry([customAgent('ping', { canCall: ['pong'] }), customAgent('pong', { canCall: ['ping'] })])
    const call = (id: string, target: string, tag: string): MockTurn['toolCalls'] => agentCall(id, target, { label: tag })
    const pong2 = new ScriptedProvider([{ toolCalls: call('z4', 'ping', 'ping3') }, { text: 'pong2 viu a recusa' }])
    const tree = makeTree({
      agents,
      limits: { maxAgentDepth: 6 },
      script: [{ toolCalls: call('c1', 'ping', 'ping1') }, { text: 'fim' }],
      children: {
        ping: [
          new ScriptedProvider([{ toolCalls: call('z1', 'pong', 'pong1') }, { text: 'ping1 ok' }]),
          new ScriptedProvider([{ toolCalls: call('z3', 'pong', 'pong2') }, { text: 'ping2 ok' }])
        ],
        pong: [new ScriptedProvider([{ toolCalls: call('z2', 'ping', 'ping2') }, { text: 'pong1 ok' }]), pong2]
      }
    })
    await tree.runner.send('em círculos')

    expect(tree.spawned.map((s) => s.info.agent)).toEqual(['ping', 'pong', 'ping', 'pong'])
    const refusal = pong2.requests[1].messages.find((m: { role: string }) => m.role === 'tool')!.parts[0] as { ok: boolean; text: string }
    expect(refusal.ok).toBe(false)
    expect(refusal.text).toMatch(/ciclo/)
    expect(refusal.text).toContain('ping → pong → ping → pong → ping')
  })

  it('narrows the toolset on request and never widens it', async () => {
    const coder = new ScriptedProvider([{ text: 'só leio' }])
    const explorer = new ScriptedProvider([{ text: 'ok' }])
    const tree = makeTree({
      script: [
        {
          toolCalls: [
            ...agentCall('c1', 'coder', { tools: ['read_file'] }),
            ...agentCall('c2', 'explorer', { tools: ['read_file', 'write_file'] }),
            ...agentCall('c3', 'explorer', { label: 'sem nada', tools: ['write_file', 'run_command'] })
          ]
        },
        { text: 'fim' }
      ],
      children: { coder: [coder], explorer: [explorer] }
    })
    await tree.runner.send('restrinja')

    expect(toolNames(coder)).toEqual(['read_file'])
    expect(toolNames(explorer)).toEqual(['read_file'])
    const ends = toolEnds(tree.events, 'agent')
    const byId = new Map(ends.map((e) => [e.toolCallId, e]))
    expect(byId.get('c2')!.ok).toBe(true)
    expect(byId.get('c2')!.text).toContain('ferramentas ignoradas')
    expect(byId.get('c2')!.text).toContain('write_file')
    expect(byId.get('c3')).toMatchObject({ ok: false })
    expect(byId.get('c3')!.text).toContain('nenhuma das ferramentas pedidas')
    // The refused call started nothing.
    expect(tree.spawned.map((s) => s.info.agent)).toEqual(['coder', 'explorer'])
  })

  it('refuses unknown, uncallable and hidden agents and says who can be called', async () => {
    const agents = new AgentRegistry([customAgent('boss', { canCall: ['worker-bee'] }), customAgent('worker-bee'), customAgent('outsider'), customAgent('ghost', { hidden: true })])
    const boss = new ScriptedProvider([
      { toolCalls: [...agentCall('b1', 'outsider'), ...agentCall('b2', 'ghost'), ...agentCall('b3', 'nobody')] },
      { text: 'ok' }
    ])
    const tree = makeTree({
      agents,
      script: [{ toolCalls: agentCall('c1', 'boss') }, { text: 'fim' }],
      children: { boss: [boss] }
    })
    await tree.runner.send('x')
    const results = boss.requests[1].messages.find((m: { role: string }) => m.role === 'tool')!.parts as Array<{ ok: boolean; text: string }>
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result.ok).toBe(false)
      expect(result.text).toContain('não está disponível para você')
      expect(result.text).toContain('worker-bee')
      expect(result.text).not.toContain('ghost, ')
    }
    expect(tree.spawned.map((s) => s.info.agent)).toEqual(['boss'])
  })

  it('runs parallel calls of one turn in parallel', async () => {
    let started = 0
    let open: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => (open = resolve))
    const meet = async (): Promise<void> => {
      started++
      if (started === 2) open()
      await Promise.race([barrier, sleep(3000).then(() => Promise.reject(new Error('children did not overlap')))])
    }
    const tree = makeTree({
      script: [{ toolCalls: [...agentCall('c1', 'explorer'), ...agentCall('c2', 'reviewer')] }, { text: 'fim' }],
      children: {
        explorer: [new HookedProvider([{ text: 'explorer pronto' }], meet)],
        reviewer: [new HookedProvider([{ text: 'reviewer pronto' }], meet)]
      }
    })
    await tree.runner.send('em paralelo')
    const ends = subagents(tree.events).filter((e) => e.state !== 'thinking')
    expect(ends.map((e) => e.state)).toEqual(['done', 'done'])
    expect(toolEnds(tree.events, 'agent').map((e) => e.ok)).toEqual([true, true])
  })

  it.each([
    [1, 1],
    [2, 2]
  ])('caps concurrent children per parent (cap %i -> peak %i)', async (cap, expectedPeak) => {
    let active = 0
    let peak = 0
    const busy = async (): Promise<void> => {
      active++
      peak = Math.max(peak, active)
      await sleep(40)
      active--
    }
    const children = ['explorer', 'reviewer', 'planner'].map((name) => [name, [new HookedProvider([{ text: `${name} ok` }], busy)]] as const)
    const tree = makeTree({
      caps: { maxConcurrent: cap },
      script: [{ toolCalls: ['explorer', 'reviewer', 'planner'].flatMap((name, i) => agentCall(`c${i}`, name) ?? []) }, { text: 'fim' }],
      children: Object.fromEntries(children.map(([name, list]) => [name, [...list]]))
    })
    await tree.runner.send('muitos')
    expect(peak).toBe(expectedPeak)
    expect(tree.spawned).toHaveLength(3)
    expect(toolEnds(tree.events, 'agent').every((e) => e.ok)).toBe(true)
  })

  it('limits the children started per user turn, and the allowance renews on the next turn', async () => {
    const tree = makeTree({
      caps: { maxPerTurn: 2 },
      script: [
        { toolCalls: agentCall('c1', 'explorer', { label: 'um' }) },
        { toolCalls: agentCall('c2', 'explorer', { label: 'dois' }) },
        { toolCalls: agentCall('c3', 'explorer', { label: 'três' }) },
        { text: 'turno 1 fim' },
        { toolCalls: agentCall('c4', 'explorer', { label: 'quatro' }) },
        { text: 'turno 2 fim' }
      ]
    })
    await tree.runner.send('turno 1')
    const first = toolEnds(tree.events, 'agent')
    expect(first.map((e) => e.ok)).toEqual([true, true, false])
    expect(first[2].text).toContain('limite de 2 subagentes por turno')
    await tree.runner.send('turno 2')
    expect(toolEnds(tree.events, 'agent').at(-1)).toMatchObject({ toolCallId: 'c4', ok: true })
    expect(tree.spawned).toHaveLength(3)
  })

  it('propagates the abort of the user\'s turn to the whole tree', async () => {
    const explorer = new HookedProvider([{ text: 'nunca chega' }], hangUntilAborted)
    const coder = new HookedProvider([{ toolCalls: agentCall('g1', 'explorer') }, { text: 'nunca chega' }])
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'nunca chega' }],
      children: { coder: [coder], explorer: [explorer] }
    })
    const running = tree.runner.send('longo')
    for (let i = 0; i < 200 && !explorer.signals.length; i++) await sleep(10)
    expect(explorer.signals).toHaveLength(1)
    expect(explorer.signals[0].aborted).toBe(false)

    tree.runner.abort()
    await running

    // Both levels saw the abort on the signal handed to their provider stream.
    expect(explorer.signals[0].aborted).toBe(true)
    expect(coder.signals[0].aborted).toBe(true)
    const ends = subagents(tree.events).filter((e) => e.state !== 'thinking')
    expect(ends.map((e) => [e.agent, e.state]).sort()).toEqual([['coder', 'cancelled'], ['explorer', 'cancelled']])
    expect(tree.events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'error', error: 'turno cancelado pelo usuário' })
    expect(tree.runner.state).toBe('cancelled')
  })

  it('does not start a child when the turn was already aborted', async () => {
    const explorer = new HookedProvider([{ text: 'x' }])
    const tree = makeTree({ script: [{ text: 'x' }], children: { explorer: [explorer] } })
    const controller = new AbortController()
    controller.abort()
    const outcome = await spawnAgent(
      tree.env,
      {
        sessionId: 'ses_root', rootSessionId: 'ses_root', depth: 0, chain: [], cwd: root, mode: 'code', policy: policy({ mode: 'auto' }),
        providerConfig: { id: 'mock', model: 'm', label: 'M' } as ProviderConfig, limits: DEFAULT_LIMITS, availableTools: ['read_file'],
        signal: controller.signal, workspace: new WorkspaceGuard([root]), tracker: new FileTracker(root), project: { name: 'p', isGitRepo: false },
        services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as never
      },
      { agent: 'explorer', label: 'x', prompt: 'procure alguma coisa' }
    )
    expect(outcome.ok).toBe(false)
    expect(explorer.requests).toHaveLength(0)
  })
})

describe('events of the agent tree', () => {
  it('emits start and end events with the documented fields', async () => {
    const answer = 'r'.repeat(1000)
    const explorer = new ScriptedProvider([
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'a.ts' } }] },
      { text: answer }
    ])
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'explorer') }, { text: 'fim' }],
      children: { explorer: [explorer] }
    })
    await tree.runner.send('evento')

    const [start, end, ...rest] = subagents(tree.events)
    expect(rest).toEqual([])
    expect(start).toMatchObject({
      type: 'subagent', sessionId: 'ses_root', label: 'explorer job', state: 'thinking', agent: 'explorer',
      model: 'mock/scripted', depth: 1, prompt: 'Faça o trabalho de explorer com cuidado.'
    })
    expect(start.parentChildId).toBeUndefined()
    expect(start.startedAt).toBeTypeOf('number')
    expect(start.childId).toMatch(/^sub_/)
    expect(end).toMatchObject({ childId: start.childId, sessionId: 'ses_root', state: 'done', agent: 'explorer', depth: 1, startedAt: start.startedAt })
    expect(end.endedAt).toBeGreaterThanOrEqual(start.startedAt!)
    expect(end.summary).toBe(answer.slice(0, 400))

    // Order: start, the child's tool events, end.
    const types = tree.events
      .filter((e) => ['subagent', 'tool_start', 'tool_end'].includes(e.type))
      .map((e) => `${e.type}:${'name' in e ? e.name : 'state' in e ? e.state : ''}`)
    expect(types).toEqual(['tool_start:agent', 'subagent:thinking', 'tool_start:read_file', 'tool_end:read_file', 'subagent:done', 'tool_end:agent'])

    // Forwarded tool events carry the child as agentId, the root as sessionId and a collision-proof id.
    const childStart = tree.events.find((e): e is ToolStart => e.type === 'tool_start' && e.name === 'read_file')!
    const childEnd = toolEnds(tree.events, 'read_file')[0]
    expect(childStart).toMatchObject({ sessionId: 'ses_root', agentId: start.childId, toolCallId: `${start.childId}:r1` })
    expect(childEnd).toMatchObject({ sessionId: 'ses_root', agentId: start.childId, toolCallId: `${start.childId}:r1`, ok: true })
    // The session's own tool events carry no agentId.
    const own = tree.events.find((e): e is ToolStart => e.type === 'tool_start' && e.name === 'agent')!
    expect(own.agentId).toBeUndefined()
    // Text and reasoning deltas of the child never leave it.
    const deltas = tree.events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')
    expect(deltas).toContain('fim')
    expect(deltas).not.toContain('rrrr')
  })

  it('reports a failing child as an error with its reason as the summary', async () => {
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'explorer') }, { text: 'fim' }],
      children: { explorer: [new ScriptedProvider([{ error: 'modelo indisponível' }])] }
    })
    await tree.runner.send('falhe')
    const end = subagents(tree.events).find((e) => e.state !== 'thinking')!
    expect(end).toMatchObject({ state: 'error', agent: 'explorer' })
    expect(end.summary).toContain('modelo indisponível')
    const result = toolEnds(tree.events, 'agent')[0]
    expect(result.ok).toBe(false)
    expect(result.text).toContain('subagente falhou: modelo indisponível')
    expect(tree.runner.state).toBe('done')
  })

  it('gives parallel children distinct ids even when their tool call ids repeat', async () => {
    const read = (): MockTurn[] => [{ toolCalls: [{ id: 'same', name: 'read_file', args: { path: 'a.ts' } }] }, { text: 'ok' }]
    const tree = makeTree({
      script: [{ toolCalls: [...agentCall('c1', 'explorer'), ...agentCall('c2', 'reviewer')] }, { text: 'fim' }],
      children: { explorer: [new ScriptedProvider(read())], reviewer: [new ScriptedProvider(read())] }
    })
    await tree.runner.send('ids')
    const ids = tree.events.filter((e): e is ToolStart => e.type === 'tool_start' && e.name === 'read_file').map((e) => e.toolCallId)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('what a child inherits', () => {
  const writeCall: MockTurn = { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'out.txt' } }] }

  it('asks the user (as the root session) when the caller is not in auto mode, and says which agent asks', async () => {
    const tree = makeTree({
      policy: policy({ mode: 'ask' }),
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'fim' }],
      children: { coder: [new ScriptedProvider([writeCall, { text: 'escrevi' }])] }
    })
    await tree.runner.send('escreva')
    // Delegating itself needs no approval; the child's write does, addressed to the user's session.
    expect(tree.approvals.map((a) => a.tool)).toEqual(['write_file'])
    expect(tree.approvals[0]).toMatchObject({ sessionId: 'ses_root', title: '[coder] Escrever arquivo' })
  })

  it('acts without asking when the caller is in auto mode', async () => {
    const tree = makeTree({
      policy: policy({ mode: 'auto' }),
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'fim' }],
      children: { coder: [new ScriptedProvider([writeCall, { text: 'escrevi' }])] }
    })
    await tree.runner.send('escreva')
    expect(tree.approvals).toEqual([])
  })

  it('stays read-only under a read-only caller', async () => {
    const tree = makeTree({
      policy: policy({ mode: 'readonly' }),
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'fim' }],
      children: { coder: [new ScriptedProvider([writeCall, { text: 'não consegui' }])] }
    })
    await tree.runner.send('escreva')
    const denied = toolEnds(tree.events, 'write_file')[0]
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('negado')
    expect(tree.approvals).toEqual([])
  })

  it('never gets tools the caller\'s mode does not have', async () => {
    const coder = new ScriptedProvider([{ text: 'só olhei' }])
    const tree = makeTree({
      mode: 'plan',
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'fim' }],
      children: { coder: [coder] }
    })
    await tree.runner.send('planeje')
    expect(toolNames(coder)).toContain('read_file')
    expect(toolNames(coder)).not.toContain('write_file')
    expect(toolNames(coder)).not.toContain('run_command')
    expect(coder.requests[0].system).toContain('MODO PLAN')
  })

  it('lets the child\'s file changes show up in the caller\'s tracker', async () => {
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'coder') }, { text: 'fim' }],
      children: { coder: [new ScriptedProvider([writeCall, { text: 'escrevi' }])] }
    })
    await tree.runner.send('escreva')
    expect(tree.tracker.changes().map((c) => c.path)).toEqual(['out.txt'])
  })

  it('uses the model and effort of the definition', async () => {
    const other = { id: 'other', kind: 'mock', label: 'Other', baseUrl: '', model: 'default', contextWindow: 1000, supportsVision: false, supportsTools: true } as ProviderConfig
    const agents = new AgentRegistry([
      customAgent('cross', { model: 'other/gpt-x', effort: 'max' }),
      customAgent('same', { model: 'meta/llama-3' }),
      customAgent('plain')
    ])
    const cross = new ScriptedProvider([{ text: 'a' }])
    const tree = makeTree({
      agents,
      findProvider: (id) => (id === 'other' ? other : undefined),
      script: [{ toolCalls: [...agentCall('c1', 'cross'), ...agentCall('c2', 'same'), ...agentCall('c3', 'plain')] }, { text: 'fim' }],
      children: { cross: [cross] }
    })
    await tree.runner.send('modelos')
    const byAgent = new Map(tree.spawned.map((s) => [s.info.agent, s.config]))
    expect(byAgent.get('cross')).toMatchObject({ id: 'other', model: 'gpt-x' })
    expect(byAgent.get('same')).toMatchObject({ id: 'mock', model: 'meta/llama-3' })
    expect(byAgent.get('plain')).toMatchObject({ id: 'mock', model: 'scripted' })
    expect(cross.requests[0].effort).toBe('max')
    const models = subagents(tree.events).filter((e) => e.state === 'thinking').map((e) => [e.agent, e.model])
    expect(models).toEqual(expect.arrayContaining([['cross', 'other/gpt-x'], ['same', 'mock/meta/llama-3'], ['plain', 'mock/scripted']]))
  })

  it('inherits the caller\'s effort when the definition sets none, and caps iterations with maxTurns', async () => {
    const agents = new AgentRegistry([customAgent('brief', { maxTurns: 2 })])
    const brief = new ScriptedProvider([
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'a' } }] },
      { text: 'resumo no limite' }
    ])
    const tree = makeTree({ agents, script: [{ toolCalls: agentCall('c1', 'brief') }, { text: 'fim' }], children: { brief: [brief] } })
    await tree.runner.send('curto')
    // maxTurns 2: the second request is the forced wrap-up (no more tool calls allowed).
    expect(brief.requests).toHaveLength(2)
    expect(brief.requests[0].toolChoice).toBeUndefined()
    expect(brief.requests[1].toolChoice).toBe('none')
  })
})

describe('the legacy task tool', () => {
  it('still delegates to a generic worker with the old toolset', async () => {
    const worker = new ScriptedProvider([{ text: 'resumo do worker' }])
    const tree = makeTree({
      script: [
        { toolCalls: [{ id: 't1', name: 'task', args: { label: 'pesquisa', prompt: 'Pesquise o formato do arquivo.' } }] },
        { text: 'fim' }
      ],
      children: { [WORKER_AGENT]: [worker] }
    })
    await tree.runner.send('delegue')
    const result = tree.runner.messages.find((m) => m.role === 'tool')!.parts[0] as { ok: boolean; text: string }
    expect(result.ok).toBe(true)
    expect(result.text).toBe('<subagent label="pesquisa">\nresumo do worker\n</subagent>')
    expect(toolNames(worker)).toContain('read_file')
    expect(toolNames(worker)).toContain('run_command')
    for (const forbidden of ['write_file', 'agent', 'list_agents', 'task']) expect(toolNames(worker)).not.toContain(forbidden)
    expect(subagents(tree.events)[0]).toMatchObject({ agent: WORKER_AGENT, label: 'pesquisa', state: 'thinking', depth: 1 })
  })

  it('lets the request choose the worker\'s tools, but only among the caller\'s', async () => {
    const worker = new ScriptedProvider([{ text: 'escrevi' }])
    const tree = makeTree({
      script: [
        { toolCalls: [{ id: 't1', name: 'task', args: { label: 'escreve', prompt: 'Escreva o arquivo.', tools: ['write_file', 'task', 'external_agent'] } }] },
        { text: 'fim' }
      ],
      children: { [WORKER_AGENT]: [worker] }
    })
    await tree.runner.send('delegue')
    expect(toolNames(worker)).toEqual(['write_file'])

    const planWorker = new ScriptedProvider([{ text: 'nada' }])
    const plan = makeTree({
      mode: 'plan',
      script: [
        { toolCalls: [{ id: 't1', name: 'task', args: { label: 'escreve', prompt: 'Escreva o arquivo.', tools: ['write_file', 'read_file'] } }] },
        { text: 'fim' }
      ],
      children: { [WORKER_AGENT]: [planWorker] }
    })
    await plan.runner.send('delegue')
    expect(toolNames(planWorker)).toEqual(['read_file'])
  })
})

describe('list_agents', () => {
  it('returns name, description and canCall of the agents the caller may call', async () => {
    const tree = makeTree({ script: [{ toolCalls: [{ id: 'l1', name: 'list_agents', args: {} }] }, { text: 'fim' }] })
    await tree.runner.send('quem?')
    const end = toolEnds(tree.events, 'list_agents')[0]
    expect(end.ok).toBe(true)
    const result = tree.runner.messages.find((m) => m.role === 'tool')!.parts[0] as { text: string }
    expect(result.text).toContain('nível 0 de 3')
    expect(result.text).toMatch(/- coder: Implementation engineer.*\(pode chamar: agent-smith, explorer, tester, debugger,/)
    expect(result.text).toMatch(/- explorer: .*\(pode chamar: nenhum\)/)
    expect(result.text).toMatch(/- orchestrator: .*\(pode chamar: qualquer agente\)/)
    expect(result.text).not.toContain('- title:')
    const data = end.data as { agents: Array<{ name: string; canCall: unknown }> }
    expect(data.agents.find((a) => a.name === 'coder')?.canCall).toEqual(BUILTIN_AGENTS.find((a) => a.name === 'coder')!.canCall)
  })

  it('is scoped to the caller: a child sees only what its definition allows', async () => {
    const reviewer = new ScriptedProvider([{ toolCalls: [{ id: 'l1', name: 'list_agents', args: {} }] }, { text: 'visto' }])
    const tree = makeTree({
      script: [{ toolCalls: agentCall('c1', 'reviewer') }, { text: 'fim' }],
      children: { reviewer: [reviewer] }
    })
    await tree.runner.send('x')
    const listed = reviewer.requests[1].messages.find((m: { role: string }) => m.role === 'tool')!.parts[0] as { text: string }
    expect(listed.text).toContain('- explorer:')
    expect(listed.text).toContain('- security-auditor:')
    expect(listed.text).not.toContain('- coder:')
    expect(listed.text).toContain('nível 1 de 3')
  })
})
