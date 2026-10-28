import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hintForMcpError, withMcpHint } from '../src/core/mcp/hints'
import { limitMcpErrorText, limitMcpText, maxOutputChars } from '../src/core/mcp/output'
import { approvalOf, resolveToolPolicy, sanitizeToolPolicy, riskFromAnnotations } from '../src/core/mcp/policy'
import { SseParser } from '../src/core/mcp/sse'
import {
  answersToElicitation,
  assignMcpToolNames,
  coerceMcpArgs,
  elicitationToQuestions,
  mcpToolName,
  missingRequiredArgs,
  normalizeMcpInputSchema,
  planMcpExposure,
  summarizeMcpTools
} from '../src/core/mcp/tools'
import { normalizeMcpServerSettings } from '../src/core/mcp/client'
import { evaluateTool } from '../src/core/security/permissions'
import type { ToolDef } from '../src/core/tools/types'
import { policy } from './helpers'

/* ------------------------------------------------------------------ */
/* resolveToolPolicy                                                   */
/* ------------------------------------------------------------------ */

describe('resolveToolPolicy', () => {
  it('derives risk and default from the annotations when nothing is configured', () => {
    expect(resolveToolPolicy({}, 'search', { readOnlyHint: true })).toMatchObject({ exposed: true, policy: 'allow', explicit: false, risk: 'read' })
    expect(resolveToolPolicy({}, 'delete', { destructiveHint: true })).toMatchObject({ policy: 'ask', explicit: false, risk: 'destructive' })
    expect(resolveToolPolicy({}, 'create', { readOnlyHint: false, destructiveHint: false })).toMatchObject({ policy: 'ask', explicit: false, risk: 'exec' })
    expect(resolveToolPolicy({}, 'plain')).toMatchObject({ policy: 'ask', explicit: false, risk: 'exec', source: 'default' })
    // readOnlyHint wins over a contradictory destructiveHint
    expect(riskFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe('read')
  })

  it('hides tools through includeTools/excludeTools before looking at any policy', () => {
    const config = { includeTools: ['jira_*'], excludeTools: ['jira_delete_*'], toolPolicy: { '*': 'allow' as const } }
    expect(resolveToolPolicy(config, 'jira_get').exposed).toBe(true)
    expect(resolveToolPolicy(config, 'jira_delete_issue')).toMatchObject({ exposed: false, policy: 'deny', source: 'filter' })
    expect(resolveToolPolicy(config, 'confluence_get')).toMatchObject({ exposed: false, source: 'filter' })
  })

  it('resolves exact name, then the most specific glob, then the server default', () => {
    const config = {
      toolPolicy: { '*': 'ask', 'jira_*': 'allow', 'jira_delete_*': 'deny', jira_delete_comment: 'allow' } as const
    }
    expect(resolveToolPolicy(config, 'jira_delete_comment')).toMatchObject({ exposed: true, policy: 'allow', source: 'toolPolicy' })
    expect(resolveToolPolicy(config, 'jira_delete_issue')).toMatchObject({ exposed: false, policy: 'deny' })
    expect(resolveToolPolicy(config, 'jira_get_issue')).toMatchObject({ policy: 'allow', explicit: true })
    expect(resolveToolPolicy(config, 'other_tool')).toMatchObject({ policy: 'ask', source: 'toolPolicy-default' })
  })

  it('matches names and globs case-insensitively and breaks ties alphabetically, not by key order', () => {
    expect(resolveToolPolicy({ toolPolicy: { Echo: 'deny' } }, 'echo').exposed).toBe(false)
    const a = resolveToolPolicy({ toolPolicy: { 'a*': 'allow', '*b': 'deny' } }, 'ab')
    const b = resolveToolPolicy({ toolPolicy: { '*b': 'deny', 'a*': 'allow' } }, 'ab')
    expect(a.policy).toBe(b.policy)
  })

  it('lets approvalTools ask (with destructive risk) unless a toolPolicy entry or the default overrides it', () => {
    const config = { approvalTools: ['*create*', '*delete*'] }
    expect(resolveToolPolicy(config, 'create_issue')).toMatchObject({ policy: 'ask', explicit: true, source: 'approvalTools', risk: 'destructive' })
    expect(resolveToolPolicy(config, 'get_issue')).toMatchObject({ explicit: false })
    // The user's explicit choice for one tool beats the catalog list.
    expect(resolveToolPolicy({ ...config, toolPolicy: { create_issue: 'allow' } }, 'create_issue')).toMatchObject({ policy: 'allow', source: 'toolPolicy', risk: 'exec' })
    // "Allow all" is the user's latest word: it beats approvalTools too.
    expect(resolveToolPolicy({ ...config, toolPolicy: { '*': 'allow' } }, 'delete_issue')).toMatchObject({ policy: 'allow', source: 'toolPolicy-default' })
  })

  it('honours the server demanding a human on every call, even over an allow', () => {
    const meta = { 'anthropic/requiresUserInteraction': true }
    expect(resolveToolPolicy({}, 'grant', undefined, meta)).toMatchObject({ policy: 'ask', source: 'meta', explicit: true })
    expect(resolveToolPolicy({ toolPolicy: { grant: 'allow' } }, 'grant', undefined, meta)).toMatchObject({ policy: 'ask', source: 'meta' })
    expect(resolveToolPolicy({ toolPolicy: { grant: 'deny' } }, 'grant', undefined, meta).exposed).toBe(false)
    // Only the JSON boolean true counts.
    expect(resolveToolPolicy({}, 'grant', undefined, { 'anthropic/requiresUserInteraction': 'true' }).source).toBe('default')
  })

  it('only an explicit choice becomes an approval override on the registered tool', () => {
    expect(approvalOf(resolveToolPolicy({}, 'x', { readOnlyHint: true }))).toBeUndefined()
    expect(approvalOf(resolveToolPolicy({ toolPolicy: { x: 'allow' } }, 'x'))).toBe('allow')
    expect(approvalOf(resolveToolPolicy({ toolPolicy: { x: 'ask' } }, 'x'))).toBe('ask')
    expect(approvalOf(resolveToolPolicy({ toolPolicy: { x: 'deny' } }, 'x'))).toBeUndefined()
  })

  it('drops junk from a toolPolicy map', () => {
    expect(sanitizeToolPolicy({ ok: 'allow', bad: 'maybe', '': 'ask', n: 3 })).toEqual({ ok: 'allow' })
    expect(sanitizeToolPolicy('x')).toBeUndefined()
    expect(sanitizeToolPolicy({})).toBeUndefined()
    expect(normalizeMcpServerSettings({ name: 'a', command: 'x', toolPolicy: { a: 'deny', b: 'nope' }, maxOutputTokens: 5, alwaysLoad: true })).toMatchObject({
      toolPolicy: { a: 'deny' },
      maxOutputTokens: 1000,
      alwaysLoad: true
    })
  })
})

/* ------------------------------------------------------------------ */
/* Permission decision                                                 */
/* ------------------------------------------------------------------ */

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'mcp__jira__create_issue',
    description: 'x',
    schema: z.record(z.string(), z.unknown()),
    risk: 'exec',
    parallelSafe: false,
    describe: () => ({ title: 't', detail: 'd' }),
    execute: async () => ({ ok: true, text: '' }),
    ...overrides
  }
}

describe('permission decision for MCP tools', () => {
  it('asks in ask mode and runs in auto mode for a tool with no explicit choice', () => {
    expect(evaluateTool(tool(), 'p', policy({ mode: 'ask' })).decision).toBe('ask')
    expect(evaluateTool(tool(), 'p', policy({ mode: 'auto' })).decision).toBe('allow')
    expect(evaluateTool(tool({ risk: 'destructive' }), 'p', policy({ mode: 'auto' })).decision).toBe('ask')
    expect(evaluateTool(tool({ risk: 'read' }), 'p', policy({ mode: 'ask' })).decision).toBe('allow')
  })

  it("'ask' always asks, in every mode including unrestricted", () => {
    for (const mode of ['ask', 'accept-edits', 'auto', 'unrestricted'] as const) {
      expect(evaluateTool(tool({ approval: 'ask', risk: 'read' }), 'p', policy({ mode })).decision, mode).toBe('ask')
    }
  })

  it("'allow' skips the prompt, but never overrides a deny rule, read-only mode, the network switch or the credential block", () => {
    expect(evaluateTool(tool({ approval: 'allow' }), 'p', policy({ mode: 'ask' })).decision).toBe('allow')
    expect(evaluateTool(tool({ approval: 'allow', risk: 'destructive' }), 'p', policy({ mode: 'auto' })).decision).toBe('allow')
    expect(evaluateTool(tool({ approval: 'allow' }), 'p', policy({ mode: 'readonly' })).decision).toBe('deny')
    expect(evaluateTool(tool({ approval: 'allow', requires: 'network' }), 'p', policy({ mode: 'auto', allowNetwork: false })).decision).toBe('deny')
    const denied = policy({ mode: 'ask', rules: { allow: [], ask: [], deny: ['mcp__jira'] } })
    expect(evaluateTool(tool({ approval: 'allow' }), 'p', denied).decision).toBe('deny')
  })

  it('mcp_call resolves the target tool per call: deny blocks, risk and approval come from the policy', () => {
    const front = tool({
      name: 'mcp_call',
      resolveCall: (args) => {
        const target = (args as { tool: string }).tool
        if (target === 'hidden') return { deny: 'ferramenta desativada' }
        if (target === 'read') return { risk: 'read' }
        return { risk: 'destructive', approval: 'ask' }
      }
    })
    expect(evaluateTool(front, 'p', policy({ mode: 'auto' }), undefined, { tool: 'hidden' })).toMatchObject({ decision: 'deny', reason: 'ferramenta desativada' })
    expect(evaluateTool(front, 'p', policy({ mode: 'unrestricted' }), undefined, { tool: 'hidden' }).decision).toBe('deny')
    expect(evaluateTool(front, 'p', policy({ mode: 'ask' }), undefined, { tool: 'read' })).toMatchObject({ decision: 'allow', risk: 'read' })
    expect(evaluateTool(front, 'p', policy({ mode: 'auto' }), undefined, { tool: 'write' })).toMatchObject({ decision: 'ask', risk: 'destructive' })
  })
})

/* ------------------------------------------------------------------ */
/* hintForMcpError                                                     */
/* ------------------------------------------------------------------ */

describe('hintForMcpError', () => {
  const atlassian = { url: 'https://mcp.atlassian.com/v1/mcp', headers: { Authorization: 'Basic xxx' } }

  it('explains the Atlassian "API token" refusal and what to do instead', () => {
    const hint = hintForMcpError('atlassian', atlassian, "MCP -32001: You don't have permission to connect via API token")
    expect(hint).toContain('Rovo MCP')
    expect(hint).toContain('Authorization')
    expect(hint).toContain('Entrar com OAuth')
    expect(hint).toContain('jira')
    expect(hintForMcpError('atlassian', atlassian, 'HTTP 403 em initialize: token is missing the scope claim')).toContain('Rovo MCP')
    // A 401 from atlassian.com with a static Authorization header gets the same advice without the exact phrase.
    expect(hintForMcpError('atlassian', atlassian, 'HTTP 401 em initialize: {}')).toContain('Rovo MCP')
  })

  it('tells the user to sign in with OAuth when the server challenged with resource_metadata', () => {
    const message = 'HTTP 401 em initialize: {"error":"invalid_token"} [desafio: Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"]'
    const hint = hintForMcpError('notion', { url: 'https://mcp.notion.com/mcp' }, message)
    expect(hint).toContain('OAuth')
    expect(hint).toContain('Personalização → Conectores')
  })

  it('blames an invalid or expired token when a static credential header was sent', () => {
    const hint = hintForMcpError('api', { url: 'https://api.example.com/mcp', headers: { 'X-Api-Key': 'abc' } }, 'HTTP 401 em tools/list: nope')
    expect(hint).toContain('X-Api-Key')
    expect(hint).toContain('inválido')
    expect(hintForMcpError('api', { url: 'https://api.example.com/mcp' }, 'HTTP 403 em tools/list: nope')).toContain('não tem credencial')
  })

  it('names the missing command and how to install it', () => {
    expect(hintForMcpError('x', { command: 'npx', args: [] }, 'spawn npx ENOENT')).toContain('Node.js')
    expect(hintForMcpError('x', { command: 'uvx', args: [] }, "servidor MCP x encerrou (código 1): 'uvx' não é reconhecido como um comando interno")).toContain('uv')
    expect(hintForMcpError('x', { command: 'C:\\tools\\meu-mcp.exe', args: [] }, 'spawn C:\\tools\\meu-mcp.exe ENOENT')).toContain('meu-mcp')
  })

  it('explains a refused dynamic registration, a start timeout, a wrong url and an unreachable server', () => {
    expect(hintForMcpError('s', { url: 'https://s/mcp' }, 'registro dinâmico recusado: HTTP 400')).toContain('chave de API')
    expect(hintForMcpError('s', { url: 'https://s/mcp' }, 'Dynamic client registration is not supported')).toContain('client id')
    expect(hintForMcpError('s', { command: 'npx', args: ['-y', 'x'], startTimeoutMs: 20_000 }, 'timeout de MCP s.initialize (20000ms)')).toContain('20 s')
    expect(hintForMcpError('s', { url: 'https://s/mcp' }, 'timeout de MCP s.initialize (5000ms)')).toContain('URL')
    expect(hintForMcpError('s', { url: 'https://s/mcp' }, 'HTTP 404 em initialize: Not Found')).toContain('404')
    expect(hintForMcpError('s', { url: 'https://s/mcp' }, 'falha de rede em initialize: fetch failed (ECONNREFUSED)')).toContain('Sem conexão')
    expect(hintForMcpError('s', { url: 'https://s/mcp' }, 'versão de protocolo MCP não suportada: x')).toContain('2025-06-18')
  })

  it('tells the user to open the app when a server on this computer is not listening (Figma Desktop at 127.0.0.1:3845)', () => {
    const hint = hintForMcpError('figma', { url: 'http://127.0.0.1:3845/mcp' }, 'falha de rede em initialize: fetch failed (ECONNREFUSED)')
    expect(hint).toContain('Figma Desktop')
    expect(hint).toContain('127.0.0.1:3845')
    // A remote host keeps the generic advice.
    expect(hintForMcpError('x', { url: 'https://s.example.com/mcp' }, 'falha de rede em initialize: fetch failed (ECONNREFUSED)')).toContain('Sem conexão')
  })

  it('explains a uv cache with files in use (uvx mcp-server-* on Windows: pywin32 "os error 32") and how to get around it', () => {
    const stderr =
      'servidor MCP fetch encerrou (código 2): error: Failed to install: pywin32-312-cp313-cp313-win_amd64.whl (pywin32==312) | ' +
      'Caused by: failed to remove directory `C:\\Users\\Ana\\AppData\\Local\\uv\\cache\\builds-v0\\.tmpuCoLR3\\Lib\\site-packages\\pywin32-'
    const hint = hintForMcpError('fetch', { command: 'uvx', args: ['mcp-server-fetch'] }, stderr)
    expect(hint).toContain('UV_CACHE_DIR')
    expect(hint).toContain('cache')
    // A different installation failure is not blamed on the cache.
    expect(hintForMcpError('x', { command: 'uvx', args: [] }, 'error: Failed to install: foo (No matching distribution)')).toBeUndefined()
  })

  it('returns nothing for an error it does not know and appends the hint to a message otherwise', () => {
    expect(hintForMcpError('s', undefined, 'algo estranho aconteceu')).toBeUndefined()
    expect(hintForMcpError('s', undefined, '')).toBeUndefined()
    expect(withMcpHint('s', undefined, 'algo estranho')).toBe('algo estranho')
    expect(withMcpHint('x', { command: 'npx', args: [] }, 'spawn npx ENOENT')).toMatch(/^spawn npx ENOENT\nDica: /)
  })
})

/* ------------------------------------------------------------------ */
/* Names, schemas, deferral                                            */
/* ------------------------------------------------------------------ */

describe('MCP tool names', () => {
  it('builds mcp__server__tool with only [a-zA-Z0-9_-] and at most 64 characters', () => {
    expect(mcpToolName('jira', 'create-issue')).toBe('mcp__jira__create-issue')
    expect(mcpToolName('my server', 'do.it!')).toBe('mcp__my_server__do_it_')
    const long = mcpToolName('s'.repeat(40), 't'.repeat(100))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/)
    // Stable: the same pair always gets the same name, and different long tools never collide.
    expect(mcpToolName('s'.repeat(40), 't'.repeat(100))).toBe(long)
    expect(mcpToolName('s'.repeat(40), 't'.repeat(99) + 'u')).not.toBe(long)
  })

  it('resolves collisions deterministically: the first keeps the clean name', () => {
    const names = assignMcpToolNames([
      { server: 'a b', tool: 'x' },
      { server: 'a_b', tool: 'x' },
      { server: 'a.b', tool: 'x' }
    ])
    expect(names[0]).toBe('mcp__a_b__x')
    expect(new Set(names).size).toBe(3)
    expect(names.every((name) => name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true)
    expect(assignMcpToolNames([{ server: 'a b', tool: 'x' }, { server: 'a_b', tool: 'x' }, { server: 'a.b', tool: 'x' }])).toEqual(names)
  })
})

describe('MCP input schemas', () => {
  it('accepts a normal schema and strips $schema', () => {
    const out = normalizeMcpInputSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { q: { type: 'string' } }, required: ['q'] })
    expect(out.error).toBeUndefined()
    expect(out.schema).toEqual({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] })
    expect(normalizeMcpInputSchema(undefined).schema).toEqual({ type: 'object', properties: {} })
  })

  it('flattens a root anyOf/oneOf/allOf into one object', () => {
    const any = normalizeMcpInputSchema({
      anyOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
      ]
    })
    expect(any.schema).toMatchObject({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } })
    expect(any.schema?.anyOf).toBeUndefined()
    expect(any.schema?.required).toBeUndefined()
    expect(any.note).toContain('(id) ou (name)')
    const all = normalizeMcpInputSchema({ allOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } }, required: ['b'] }] })
    expect(all.schema?.required).toEqual(['a', 'b'])
  })

  it('rejects schemas a model API would refuse, so only that tool is skipped', () => {
    expect(normalizeMcpInputSchema({ type: 'object', properties: { 'campo inválido': { type: 'string' } } }).error).toContain('nome inválido')
    expect(normalizeMcpInputSchema({ type: 'array' }).error).toContain('object')
    expect(normalizeMcpInputSchema('x').error).toBeDefined()
    expect(normalizeMcpInputSchema({ type: 'object', properties: { 'a.b-c_1': { type: 'string' } } }).error).toBeUndefined()
  })

  it('coerces strings to the declared types and reports missing required arguments', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' }, ok: { type: 'boolean' }, list: { type: 'array' }, s: { type: 'string' } }, required: ['n'] }
    expect(coerceMcpArgs(schema, { n: '5', ok: 'TRUE', list: '[1,2]', s: 7 })).toEqual({ n: 5, ok: true, list: [1, 2], s: '7' })
    expect(coerceMcpArgs(schema, { n: 'abc' })).toEqual({ n: 'abc' })
    expect(missingRequiredArgs(schema, {})).toEqual(['n'])
    expect(missingRequiredArgs(schema, { n: 0 })).toEqual([])
    expect(missingRequiredArgs(schema, { n: null })).toEqual(['n'])
  })
})

describe('planMcpExposure', () => {
  it('keeps small servers inline and defers the big one whole', () => {
    const plan = planMcpExposure([
      { name: 'jira', toolCount: 31 },
      { name: 'docs', toolCount: 4 },
      { name: 'git', toolCount: 9 }
    ])
    expect(plan.get('docs')).toBe('inline')
    expect(plan.get('git')).toBe('inline')
    expect(plan.get('jira')).toBe('deferred')
  })

  it('defers nothing when the total is within the limit and honours alwaysLoad both ways', () => {
    expect([...planMcpExposure([{ name: 'a', toolCount: 8 }, { name: 'b', toolCount: 7 }]).values()]).toEqual(['inline', 'inline'])
    const plan = planMcpExposure([
      { name: 'big', toolCount: 40, alwaysLoad: true },
      { name: 'small', toolCount: 2, alwaysLoad: false },
      { name: 'mid', toolCount: 15 },
      { name: 'other', toolCount: 1 }
    ])
    expect(plan.get('big')).toBe('inline')
    expect(plan.get('small')).toBe('deferred')
    // an exempt server does not use up the budget
    expect(plan.get('other')).toBe('inline')
    expect(plan.get('mid')).toBe('deferred')
  })

  it('is deterministic whatever the input order', () => {
    const a = planMcpExposure([{ name: 'x', toolCount: 10 }, { name: 'y', toolCount: 10 }])
    const b = planMcpExposure([{ name: 'y', toolCount: 10 }, { name: 'x', toolCount: 10 }])
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort())
  })

  it('summarizes servers for the system prompt without server-provided prose', () => {
    const defs = [
      { name: 'mcp__docs__search', mcp: { server: 'docs', tool: 'search', deferred: false } },
      { name: 'mcp__jira__a', mcp: { server: 'jira', tool: 'a', deferred: true } },
      { name: 'mcp__jira__b', mcp: { server: 'jira', tool: 'b', deferred: true } }
    ]
    const text = summarizeMcpTools(defs)
    expect(text).toContain('- docs: 1 direta(s): mcp__docs__search')
    expect(text).toContain('- jira: 2 sob demanda (tool_search("jira") e tool_load)')
    expect(summarizeMcpTools([])).toBe('')
  })
})

/* ------------------------------------------------------------------ */
/* Elicitation mapping, output limits, SSE parser                      */
/* ------------------------------------------------------------------ */

describe('elicitation', () => {
  const request = {
    message: 'Qual projeto?',
    requestedSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', title: 'Projeto', enum: ['Alfa', 'Beta'] },
        urgent: { type: 'boolean', title: 'Urgente?' },
        points: { type: 'integer', title: 'Pontos' },
        note: { type: 'string', description: 'Observação' }
      },
      required: ['project']
    }
  }

  it('turns a form into questions and the answers back into typed content', () => {
    const { questions, fields } = elicitationToQuestions(request)
    expect(questions).toHaveLength(4)
    expect(questions[0].question).toContain('Qual projeto?')
    expect(questions[0].options?.map((option) => option.label)).toEqual(['Alfa', 'Beta'])
    expect(questions[1].options?.map((option) => option.label)).toEqual(['Sim', 'Não'])
    expect(questions[2].options).toBeUndefined()
    const result = answersToElicitation(fields, [{ answers: ['Beta'] }, { answers: ['Sim'] }, { answers: ['3,0'] }, { answers: [''] }])
    expect(result).toEqual({ action: 'accept', content: { project: 'Beta', urgent: true, points: 3 } })
  })

  it('declines when a required field is empty or a number is not a number, and cancels when the user skips', () => {
    const { fields } = elicitationToQuestions(request)
    expect(answersToElicitation(fields, [{ answers: [] }, { answers: [] }, { answers: [] }, { answers: [] }])).toEqual({ action: 'decline' })
    expect(answersToElicitation(fields, [{ answers: ['Alfa'] }, { answers: ['Não'] }, { answers: ['muitos'] }, { answers: [] }])).toEqual({ action: 'decline' })
    expect(answersToElicitation(fields, null)).toEqual({ action: 'cancel' })
  })
})

describe('output limits', () => {
  it('uses the server setting, then the tool meta, then MAX_MCP_OUTPUT_TOKENS, then 25 000 tokens', () => {
    expect(maxOutputChars({ env: {} })).toBe(100_000)
    expect(maxOutputChars({ env: { MAX_MCP_OUTPUT_TOKENS: '50000' } })).toBe(200_000)
    expect(maxOutputChars({ toolMaxChars: 200_000, env: { MAX_MCP_OUTPUT_TOKENS: '50000' } })).toBe(200_000)
    expect(maxOutputChars({ toolMaxChars: 9_000_000, env: {} })).toBe(500_000)
    expect(maxOutputChars({ maxOutputTokens: 2000, toolMaxChars: 200_000, env: {} })).toBe(8_000)
    expect(maxOutputChars({ env: { MAX_MCP_OUTPUT_TOKENS: 'abc' } })).toBe(100_000)
  })

  it('keeps the start and the end of a long text and says what was cut', () => {
    const text = `INICIO-${'x'.repeat(5000)}-FIM`
    const small = limitMcpText(text, 100)
    expect(small.truncated).toBe(true)
    expect(small.text.startsWith('INICIO-')).toBe(true)
    expect(small.text.endsWith('-FIM')).toBe(true)
    expect(small.text).toContain('caracteres omitidos')
    expect(small.text).toContain('maxOutputTokens')
    expect(small.omittedChars).toBe(text.length - 100)
    expect(limitMcpText('curto', 100)).toMatchObject({ truncated: false, text: 'curto' })
  })

  it('shortens only very long error text, by the middle', () => {
    expect(limitMcpErrorText('erro curto')).toBe('erro curto')
    const long = `A${'b'.repeat(20_000)}Z`
    const out = limitMcpErrorText(long)
    expect(out.length).toBeLessThan(11_000)
    expect(out.startsWith('A')).toBe(true)
    expect(out.endsWith('Z')).toBe(true)
  })
})

describe('SseParser', () => {
  it('parses events split across chunks, CRLF line ends, comments and multi-line data', () => {
    const parser = new SseParser()
    const events = [
      ...parser.push('event: endpoint\r\ndata: /messages?sessionId=1\r\n\r\n: keep-alive\n\nda'),
      ...parser.push('ta: {"a":\ndata: 1}\nid: 7\n\nevent: message\ndata: {"b":2}\n'),
      ...parser.push('\n')
    ]
    expect(events).toEqual([
      { event: 'endpoint', data: '/messages?sessionId=1' },
      { event: 'message', data: '{"a":\n1}', id: '7' },
      { event: 'message', data: '{"b":2}' }
    ])
  })

  it('flushes an event the stream ended in the middle of', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"x":1}')).toEqual([])
    expect(parser.end()).toEqual([{ event: 'message', data: '{"x":1}' }])
  })

  it('handles a lone carriage return split from its line feed', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\r')).toEqual([])
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'a' }])
  })
})
