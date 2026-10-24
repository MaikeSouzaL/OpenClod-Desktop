import { describe, expect, it, vi } from 'vitest'
import { mcpInstallTool, mcpServersTool, mcpSearchTool } from '../src/core/tools/mcp'
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

  it('explains OAuth-only connectors instead of claiming success', async () => {
    const install = vi.fn(async () => ({ ok: false, needsOAuth: true }))
    const result = await mcpInstallTool.execute({ id: 'notion' }, context({ install }))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('OAuth')
  })

  it('lists configured servers and their state', async () => {
    const list = vi.fn(() => [
      { name: 'jira', state: 'ready', transport: 'stdio', tools: ['a', 'b'] },
      { name: 'atlassian', state: 'error', transport: 'http', tools: [], error: 'HTTP 401' }
    ])
    const result = await mcpServersTool.execute({}, context({ list }))
    expect(result.text).toContain('● jira')
    expect(result.text).toContain('HTTP 401')
    expect(result.summary).toBe('2 MCPs')
  })
})
