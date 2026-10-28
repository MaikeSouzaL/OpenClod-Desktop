import { describe, expect, it, vi } from 'vitest'
import { mcpInstallTool, mcpPromptTool, mcpResourceTool, mcpServersTool, mcpSearchTool } from '../src/core/tools/mcp'
import type { ToolContext } from '../src/core/tools/types'

function context(service: unknown): ToolContext {
  return {
    sessionId: 'ses_test',
    cwd: 'C:\\proj',
    mode: 'code',
    policy: {},
    workspace: {},
    signal: new AbortController().signal,
    tracker: {},
    emit: () => undefined,
    approve: async () => true,
    setPlan: () => undefined,
    runSubagent: async () => ({ ok: true, text: '' }),
    agents: { depth: 0, maxDepth: 2, callable: () => [], get: () => undefined },
    createAgent: async () => ({ path: '', agent: {} }),
    services: { mcp: service } as unknown as ToolContext['services'],
    log: () => undefined
  } as unknown as ToolContext
}

describe('MCP self-install tools', () => {
  it('searches the catalog and the registry, marking what is installed', async () => {
    const search = vi.fn(async () => ({
      catalog: [
        {
          id: 'jira',
          name: 'Jira + Confluence',
          description: 'mcp-atlassian',
          transport: 'stdio' as const,
          installed: false,
          needs: ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN'],
          source: 'catalog' as const
        }
      ],
      registry: [],
      installed: []
    }))
    const result = await mcpSearchTool.execute({ query: 'jira' }, context({ search }))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('jira')
    expect(result.text).toContain('JIRA_API_TOKEN')
    expect(result.text).toContain('mcp_install')
  })

  it('asks for the exact missing credentials without saving anything', async () => {
    const install = vi.fn(async () => ({ ok: false, missing: ['JIRA_URL', 'JIRA_API_TOKEN'] }))
    const result = await mcpInstallTool.execute({ id: 'jira' }, context({ install }))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('JIRA_URL')
    expect(result.text).toContain('Nada foi salvo')
  })

  it('reports the tools that became available after a successful install', async () => {
    const install = vi.fn(async () => ({
      ok: true,
      name: 'jira',
      state: 'ready',
      tools: ['jira_search', 'jira_create_issue']
    }))
    const result = await mcpInstallTool.execute({ id: 'jira', env: { JIRA_URL: 'https://x' } }, context({ install }))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('jira_search')
    expect(result.text).toContain('próximo passo')
  })

  it('installs OAuth connectors and explains that login completes in the browser', async () => {
    const install = vi.fn(async () => ({ ok: false, needsOAuth: true }))
    const result = await mcpInstallTool.execute({ id: 'notion' }, context({ install }))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('OAuth')
    expect(result.text).toContain('navegador padrão')
  })

  it('lists configured servers and their state', async () => {
    const list = vi.fn(() => [
      {
        name: 'jira',
        state: 'ready',
        transport: 'stdio',
        tools: ['a', 'b'],
        resources: [{ uri: 'jira://projeto/1', name: 'Projeto 1' }],
        prompts: [{ name: 'resumir', arguments: [] }]
      },
      { name: 'atlassian', state: 'error', transport: 'http', tools: [], resources: [], prompts: [], error: 'HTTP 401' }
    ])
    const result = await mcpServersTool.execute({}, context({ list }))
    expect(result.text).toContain('● jira')
    expect(result.text).toContain('1 recursos')
    expect(result.text).toContain('1 prompts')
    expect(result.text).toContain('HTTP 401')
    expect(result.summary).toBe('2 MCPs')
  })

  it('lists and reads MCP resources, selecting the only available server', async () => {
    const list = vi.fn(() => [
      {
        name: 'docs',
        state: 'ready',
        transport: 'stdio',
        tools: [],
        resources: [{ uri: 'file:///README.md', name: 'README', mimeType: 'text/markdown' }],
        prompts: []
      }
    ])
    const readResource = vi.fn(async () => [{ uri: 'file:///README.md', mimeType: 'text/markdown', text: '# Projeto' }])
    const service = { list, readResource }
    const listed = await mcpResourceTool.execute({ action: 'list' }, context(service))
    expect(listed.text).toContain('file:///README.md')
    const read = await mcpResourceTool.execute({ action: 'read', uri: 'file:///README.md' }, context(service))
    expect(read).toMatchObject({ ok: true, text: '# Projeto', summary: 'docs · 1 conteúdo(s)' })
    expect(readResource).toHaveBeenCalledWith('docs', 'file:///README.md')
  })

  it('fills and returns an MCP prompt', async () => {
    const list = vi.fn(() => [
      {
        name: 'jira',
        state: 'ready',
        transport: 'stdio',
        tools: [],
        resources: [],
        prompts: [{ name: 'revisar', arguments: [{ name: 'issue', required: true }] }]
      }
    ])
    const getPrompt = vi.fn(async () => ({
      description: 'Revisão do ticket',
      messages: [{ role: 'user', content: 'Revise CNC-42' }]
    }))
    const service = { list, getPrompt }
    const listed = await mcpPromptTool.execute({ action: 'list' }, context(service))
    expect(listed.text).toContain('jira · revisar')
    expect(listed.text).toContain('issue*')
    const result = await mcpPromptTool.execute({ name: 'revisar', arguments: { issue: 'CNC-42' } }, context(service))
    expect(result.text).toContain('Revisão do ticket')
    expect(result.text).toContain('[user]\nRevise CNC-42')
    expect(getPrompt).toHaveBeenCalledWith('jira', 'revisar', { issue: 'CNC-42' })
  })
})
