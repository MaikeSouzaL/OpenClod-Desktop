import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCatalogServer, catalogEntry, searchMcpCatalog } from '../src/core/mcp/catalog'
import { installFromRegistry } from '../src/core/mcp/registry'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MCP catalog', () => {
  it('finds Jira/Atlassian and keeps the curated order', () => {
    const ids = searchMcpCatalog('jira', 5).map((entry) => entry.id)
    expect(ids).toContain('jira')
    expect(ids).toContain('atlassian')
    expect(catalogEntry('atlassian')?.transport).toBe('http')
  })

  it('builds the official Atlassian server with Basic auth from email + API token', () => {
    const built = buildCatalogServer(catalogEntry('atlassian')!, {
      env: { ATLASSIAN_EMAIL: 'dev@example.com', ATLASSIAN_API_TOKEN: 'secret-token' }
    })
    expect(built.missing).toEqual([])
    expect(built.server).toMatchObject({
      name: 'atlassian',
      type: 'http',
      url: 'https://mcp.atlassian.com/v2/mcp',
      enabled: true
    })
    expect(built.server?.headers?.Authorization).toBe(
      `Basic ${Buffer.from('dev@example.com:secret-token', 'utf8').toString('base64')}`
    )
    // The secret itself is not duplicated into a visible header name or args.
    expect(JSON.stringify(built.server?.args)).not.toContain('secret-token')
  })

  it('reports every missing required credential instead of saving a broken server', () => {
    const built = buildCatalogServer(catalogEntry('atlassian')!)
    expect(built.server).toBeNull()
    expect(built.missing).toEqual(['ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'])
  })

  it('substitutes paths in stdio arguments', () => {
    const built = buildCatalogServer(catalogEntry('filesystem')!, {
      env: { ALLOWED_PATH: 'C:\\Users\\me\\Desktop' }
    })
    expect(built.server?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Desktop'])
  })

  it('marks OAuth-only connectors as needing a login instead of pretending they work', () => {
    const built = buildCatalogServer(catalogEntry('notion')!)
    expect(built.server).toBeNull()
    expect(built.needsOAuth).toBe(true)
  })
})

describe('MCP Registry mapping', () => {
  it('maps a registry npm package to a runnable npx command, asking for required env', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'io.example/demo',
                  title: 'Demo',
                  description: 'demo server',
                  version: '1.2.3',
                  packages: [
                    {
                      registryType: 'npm',
                      identifier: '@example/demo-mcp',
                      runtimeHint: 'npx',
                      runtimeArguments: [{ value: '-y', type: 'positional' }],
                      environmentVariables: [
                        { name: 'DEMO_TOKEN', isRequired: true, isSecret: true },
                        { name: 'DEMO_REGION' }
                      ]
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )

    const missing = await installFromRegistry('io.example/demo')
    expect(missing.server).toBeNull()
    expect(missing.missing).toEqual(['DEMO_TOKEN'])

    const ok = await installFromRegistry('io.example/demo', { env: { DEMO_TOKEN: 'x' } })
    expect(ok.server).toMatchObject({
      name: 'demo',
      type: 'stdio',
      command: 'npx',
      env: { DEMO_TOKEN: 'x' }
    })
    expect(ok.server?.args).toContain('@example/demo-mcp')
  })

  it('maps a remote registry entry to HTTP with its required headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'com.example/remote',
                  description: 'remote',
                  version: '2.0.0',
                  remotes: [
                    {
                      type: 'streamable-http',
                      url: 'https://mcp.example.com/mcp',
                      headers: [{ name: 'Authorization', isRequired: true, isSecret: true }]
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    const built = await installFromRegistry('com.example/remote', { headers: { Authorization: 'Bearer abc' } })
    expect(built.server).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer abc' }
    })
  })
})
