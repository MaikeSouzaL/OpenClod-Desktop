import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandCommand, loadCustomCommands, matchCustomCommand, parseAllowedTools, slashWord, withIncludedFiles } from '../src/core/commands/library'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { ScriptedProvider } from './support/scripted-provider'
import { buildRegistry } from '../src/core/tools/registry'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { DEFAULT_LIMITS } from '../src/shared/types'
import { z } from 'zod'
import type { ToolDef } from '../src/core/tools/types'
import { policy } from './helpers'

const BUNDLED = path.join(__dirname, '..', 'resources', 'commands')
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-commands-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the commands that ship with the app', () => {
  const commands = loadCustomCommands([{ dir: BUNDLED, source: 'app' }])

  it('load from resources/commands, in Portuguese, without the README', () => {
    expect(commands.map((command) => command.name)).toEqual([
      'buscar-codigo', 'commit', 'dependencias', 'issues', 'learn', 'polish', 'review-pr', 'revisar', 'rmslop', 'spellcheck'
    ])
    for (const command of commands) {
      expect(command.source).toBe('app')
      expect(command.description.length, command.name).toBeGreaterThan(10)
    }
  })

  it('never push, comment, approve or merge; the reviews are read-only', () => {
    const byName = new Map(commands.map((command) => [command.name, command]))
    expect(byName.get('commit')?.body).toMatch(/Não faça push/)
    expect(byName.get('review-pr')?.body).toMatch(/não comente, não aprove, não faça merge/)
    // The reviews cannot write: no edit or command tool in their list.
    expect(byName.get('revisar')?.allowedTools).toEqual(['code_intelligence', 'git_diff', 'git_log', 'git_status', 'glob', 'grep', 'list_dir', 'read_file'])
    expect(byName.get('buscar-codigo')?.allowedTools?.some((tool) => /write|edit|patch|run_command/.test(tool))).toBe(false)
  })

  it('a user or project command with the same name replaces the bundled one', () => {
    fs.writeFileSync(path.join(dir, 'commit.md'), '---\ndescription: meu commit\n---\ncommit do meu jeito')
    const merged = loadCustomCommands([{ dir: BUNDLED, source: 'app' }, { dir, source: 'projeto' }])
    expect(merged.find((command) => command.name === 'commit')).toMatchObject({ description: 'meu commit', source: 'projeto' })
  })
})

describe('frontmatter and text', () => {
  it('maps allowed-tools from Claude Code names to Openclod tools, ignoring the patterns', () => {
    expect(parseAllowedTools('Bash(git add:*), Bash(git status:*), Read, Edit, git_diff')).toEqual([
      'apply_patch', 'edit_file', 'git_diff', 'patch_file', 'read_file', 'run_command', 'start_process'
    ])
    expect(parseAllowedTools('')).toBeUndefined()
    expect(parseAllowedTools('- Grep\n- Glob')).toEqual(['glob', 'grep'])
  })

  it('reads model and argument-hint, and expands {{args}} like $ARGUMENTS', () => {
    fs.writeFileSync(path.join(dir, 'x.md'), '---\nmodel: haiku\nargument-hint: <texto>\n---\nPolir: {{args}}')
    const [command] = loadCustomCommands([{ dir, source: 'usuario' }])
    expect(command).toMatchObject({ model: 'haiku', argumentHint: '<texto>' })
    expect(expandCommand(command, 'olá mundo')).toBe('Polir: olá mundo')
  })

  it('brings @files of the project into the message, never a file outside it', () => {
    fs.mkdirSync(path.join(dir, 'proj', 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'proj', 'package.json'), '{"name":"x"}')
    fs.writeFileSync(path.join(dir, 'proj', 'src', 'a.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(dir, 'segredo.txt'), 'NAO')
    const text = withIncludedFiles('Leia @package.json e @src/a.ts, mas não @../segredo.txt nem @nao-existe.md; fale com @fulano.', path.join(dir, 'proj'))
    expect(text).toContain('<arquivo path="package.json">\n{"name":"x"}\n</arquivo>')
    expect(text).toContain('<arquivo path="src/a.ts">')
    expect(text).not.toContain('NAO')
    expect(text.match(/<arquivo /g)).toHaveLength(2)
  })

  it('tells a command apart from a path', () => {
    expect(slashWord('/commit agora')).toEqual({ name: 'commit', args: 'agora' })
    expect(slashWord('/revisar')).toEqual({ name: 'revisar', args: '' })
    expect(slashWord('/usr/bin/python não roda')).toBeNull()
    expect(slashWord('/ espaço')).toBeNull()
    expect(matchCustomCommand('/nada', [])).toBeNull()
  })
})

describe('allowed-tools limits the turn', () => {
  const tool = (name: string): ToolDef => ({
    name,
    description: name,
    schema: z.object({}),
    risk: 'read',
    parallelSafe: true,
    describe: () => ({ title: name, detail: '' }),
    execute: async () => ({ ok: true, text: `${name} rodou` })
  })

  it('sends only the listed tools (plus plan and questions) in that turn, and everything again in the next', async () => {
    const cwd = dir
    const provider = new ScriptedProvider([{ text: 'feito' }, { text: 'feito de novo' }])
    const runner = new SessionRunner({
      sessionId: 'ses_cmd',
      cwd,
      mode: 'code',
      provider,
      providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
      registry: buildRegistry(tool('read_file'), tool('grep'), tool('write_file'), tool('update_plan'), tool('git_diff')),
      policy: policy({ mode: 'auto' }),
      limits: { ...DEFAULT_LIMITS, maxIterations: 4 },
      tracker: new FileTracker(cwd),
      workspace: new WorkspaceGuard([cwd]),
      services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: {} } as unknown as RunnerDeps['services'],
      project: { name: 'Teste', isGitRepo: false },
      emit: () => undefined,
      approve: async () => true
    } as RunnerDeps)
    await runner.send('revise', { allowedTools: ['read_file', 'git_diff'] })
    const limited = provider.requests[0].tools?.map((item) => item.name) ?? []
    expect(limited).toContain('read_file')
    // A tool that waits for tool_load comes in when the command names it.
    expect(limited).toContain('git_diff')
    expect(limited).toContain('update_plan')
    expect(limited).not.toContain('write_file')
    expect(limited).not.toContain('grep')
    await runner.send('agora sem limite')
    const free = provider.requests[1].tools?.map((item) => item.name) ?? []
    expect(free).toContain('write_file')
    expect(free).toContain('grep')
  })
})
