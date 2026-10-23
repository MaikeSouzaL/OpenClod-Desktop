import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { patchFileTool } from '../src/core/tools/fs'
import { webResearchTool } from '../src/core/tools/web'
import { createAgentTool } from '../src/core/agents/tools'
import { buildSystemPrompt, ensureProjectInstructions, loadProjectInstructions } from '../src/core/agent/context'
import { WorkspaceGuard } from '../src/core/security/policy'
import { FileTracker } from '../src/core/session/tracker'
import type { CreateAgentInput, ToolContext } from '../src/core/tools/types'
import type { PolicyConfig } from '../src/shared/types'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-new-tools-'))
  dirs.push(dir)
  return dir
}

function policy(): PolicyConfig {
  return {
    mode: 'auto',
    blockedCommands: [],
    allowedRoots: [],
    allowNetwork: true,
    allowComputerControl: false,
    shellTimeoutSec: 300
  }
}

function context(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const tracker = new FileTracker(dir)
  return {
    sessionId: 'ses_test',
    cwd: dir,
    mode: 'code',
    policy: policy(),
    workspace: new WorkspaceGuard([dir]),
    signal: new AbortController().signal,
    tracker,
    emit: () => undefined,
    approve: async () => true,
    setPlan: () => undefined,
    runSubagent: async () => ({ ok: false, text: 'não usado', sessionId: '' }),
    agents: { depth: 0, maxDepth: 3, callable: () => [], get: () => undefined },
    createAgent: async () => {
      throw new Error('não usado')
    },
    services: {} as never,
    log: () => undefined,
    ...overrides
  }
}

describe('patch_file', () => {
  it('applies only the hunks of a unified diff', async () => {
    const dir = temp()
    const file = path.join(dir, 'app.ts')
    fs.writeFileSync(file, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
    const ctx = context(dir)
    ctx.tracker.markRead(file)

    const result = await patchFileTool.execute(
      {
        path: 'app.ts',
        patch: '--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 42\n const c = 3\n'
      },
      ctx
    )
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('const a = 1\nconst b = 42\nconst c = 3\n')
  })

  it('validates with dry_run and writes nothing', async () => {
    const dir = temp()
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'one\ntwo\n', 'utf8')
    const ctx = context(dir)
    ctx.tracker.markRead(file)
    const result = await patchFileTool.execute(
      { path: 'a.txt', patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n', dry_run: true },
      ctx
    )
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n')
  })

  it('refuses an invalid patch and leaves the file untouched', async () => {
    const dir = temp()
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'one\ntwo\n', 'utf8')
    const ctx = context(dir)
    ctx.tracker.markRead(file)
    const result = await patchFileTool.execute(
      { path: 'a.txt', patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-inexistente\n+outra\n dois\n' },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n')
  })
})

describe('web_research', () => {
  it('searches, reads the sources and keeps the URL next to the excerpt', async () => {
    const ctx = context(temp())
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('duckduckgo')) {
        return new Response(
          '<div class="result"><a class="result__a" href="https://example.com/doc">Documentação</a><a class="result__snippet">Trecho</a></div>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        )
      }
      return new Response(
        '<html><head><title>Doc oficial</title></head><body><p>Conteúdo oficial da API.</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }) as typeof fetch
    try {
      const result = await webResearchTool.execute({ query: 'api oficial', max_sources: 1 }, ctx)
      expect(result.ok).toBe(true)
      expect(result.text).toContain('https://example.com/doc')
      expect(result.text).toContain('Conteúdo oficial da API')
      expect(calls.some((url) => url.includes('duckduckgo'))).toBe(true)
      expect(calls.some((url) => url === 'https://example.com/doc')).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('create_agent tool', () => {
  it('passes a validated definition to the host and reports the path', async () => {
    const dir = temp()
    let captured: CreateAgentInput | null = null
    const ctx = context(dir, {
      createAgent: async (input) => {
        captured = input
        return {
          path: path.join(dir, 'agents', `${input.name}.md`),
          agent: {
            name: input.name,
            description: input.description,
            systemPrompt: input.systemPrompt,
            source: 'user'
          }
        }
      }
    })
    const result = await createAgentTool.execute(
      {
        name: 'kubernetes-specialist',
        description: 'Especialista em manifests, Helm e depuração de pods.',
        system_prompt: 'Você é um engenheiro de Kubernetes. Verifique com kubectl antes de concluir.',
        tools: ['read_file', 'run_command'],
        can_call: ['explorer'],
        mode: 'code',
        effort: 'high',
        max_turns: 12
      },
      ctx
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('kubernetes-specialist.md')
    expect(captured).toMatchObject({
      name: 'kubernetes-specialist',
      tools: ['read_file', 'run_command'],
      canCall: ['explorer'],
      mode: 'code',
      effort: 'high',
      maxTurns: 12
    })
  })
})

describe('team mode prompt', () => {
  it('adds the delegation instructions only when enabled', () => {
    const base = {
      mode: 'code' as const,
      cwd: temp(),
      policy: policy(),
      model: 'm',
      provider: 'p',
      skills: [],
      memory: [],
      isGitRepo: false
    }
    expect(buildSystemPrompt({ ...base, teamMode: true })).toContain('Modo equipe')
    expect(buildSystemPrompt({ ...base, teamMode: true })).toContain('agent-smith')
    expect(buildSystemPrompt({ ...base, teamMode: false })).not.toContain('Modo equipe')
  })
})

describe('CLAUDE.md', () => {
  it('creates the canonical file once and never overwrites it', () => {
    const dir = temp()
    const created = ensureProjectInstructions(dir, 'Meu Projeto')
    expect(created).toBe(path.join(dir, 'CLAUDE.md'))
    const first = fs.readFileSync(created as string, 'utf8')
    expect(first).toContain('forja:generated')
    expect(first).toContain('Meu Projeto')
    expect(first).toContain('Regras para o agente')

    fs.writeFileSync(created as string, '# meu arquivo\n', 'utf8')
    expect(ensureProjectInstructions(dir, 'Outro')).toBeNull()
    expect(fs.readFileSync(created as string, 'utf8')).toBe('# meu arquivo\n')
  })

  it('loads CLAUDE.md first and does not duplicate identical files', () => {
    const dir = temp()
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'regras do claude\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'regras do claude\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'FORJA.md'), 'regras do forja\n', 'utf8')
    const text = loadProjectInstructions(dir) ?? ''
    expect(text.indexOf('CLAUDE.md')).toBeLessThan(text.indexOf('FORJA.md'))
    expect(text.match(/regras do claude/g)).toHaveLength(1)
    expect(text).toContain('regras do forja')
  })
})
