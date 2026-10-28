import { describe, expect, it } from 'vitest'
import { connectInputFrom } from '../src/main/connector-input'

/**
 * The filter between the renderer and `connectConnector`. The form for a program on this computer sent `command`,
 * `args`, `env` and `cwd`, and editing sent `update`: the filter only knew `url`, so the form failed with "campo
 * inválido: custom.url" and an edit would have been taken for a new connector.
 */
describe('input of connectConnector', () => {
  it('lets a remote custom connector through with its address, transport and headers', () => {
    expect(
      connectInputFrom({ custom: { name: 'painel', url: 'https://painel.example/mcp', transport: 'sse', headers: { Authorization: 'Bearer x' }, evil: 'ignorado' }, extra: 1 })
    ).toEqual({ custom: { name: 'painel', url: 'https://painel.example/mcp', transport: 'sse', headers: { Authorization: 'Bearer x' } } })
  })

  it('lets a program on this computer through without an address, with arguments, variables, folder and start time', () => {
    const input = connectInputFrom({
      custom: {
        name: 'meu-local',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\voce'],
        env: { API_KEY: 'abc', REGIAO: 'sa-east-1' },
        cwd: 'C:\\projetos',
        startTimeoutMs: 45_000.4
      }
    })
    expect(input).toEqual({
      custom: {
        name: 'meu-local',
        transport: 'http',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\voce'],
        env: { API_KEY: 'abc', REGIAO: 'sa-east-1' },
        cwd: 'C:\\projetos',
        startTimeoutMs: 45_000
      }
    })
    expect(input.custom).not.toHaveProperty('url')
  })

  it('carries the edit flag only when it is exactly true', () => {
    const custom = { name: 'x', command: 'node' }
    expect(connectInputFrom({ custom, update: true }).update).toBe(true)
    expect(connectInputFrom({ custom, update: 'true' })).not.toHaveProperty('update')
    expect(connectInputFrom({ custom })).not.toHaveProperty('update')
  })

  it('still requires an address for a remote connector, and refuses malformed pieces', () => {
    expect(() => connectInputFrom({ custom: { name: 'x' } })).toThrow(/custom\.url/)
    expect(() => connectInputFrom({ custom: { name: 'x', url: '   ' } })).toThrow(/custom\.url/)
    expect(() => connectInputFrom({ custom: { name: 'x', command: 'node', args: 'um texto' } })).toThrow(/custom\.args/)
    expect(() => connectInputFrom({ custom: { name: 'x', command: 'node', env: ['A=1'] } })).toThrow(/custom\.env/)
    expect(() => connectInputFrom({ custom: { name: 'x', command: 'node', cwd: 42 } })).toThrow(/custom\.cwd/)
    expect(() => connectInputFrom({ custom: 'texto' })).toThrow(/custom/)
    expect(() => connectInputFrom('texto')).toThrow(/input/)
    expect(() => connectInputFrom([])).toThrow(/input/)
    expect(connectInputFrom(undefined)).toEqual({})
    expect(connectInputFrom(null)).toEqual({})
  })

  it('bounds what it passes on, one over where the service explains the limit itself', () => {
    const many = Array.from({ length: 300 }, (_, index) => `arg${index}`)
    const env = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`VAR_${index}`, 'x']))
    const input = connectInputFrom({ custom: { name: 'n'.repeat(200), command: 'c'.repeat(5000), args: [...many.slice(0, 1), 'a'.repeat(9000), ...many], env, startTimeoutMs: -5 } })
    expect(input.custom?.name).toHaveLength(60)
    expect(input.custom?.command).toHaveLength(1200)
    expect(input.custom?.args).toHaveLength(101)
    expect(input.custom?.args?.[1]).toHaveLength(4000)
    expect(Object.keys(input.custom?.env ?? {})).toHaveLength(61)
    expect(input.custom).not.toHaveProperty('startTimeoutMs')
    expect(connectInputFrom({ custom: { name: 'x', command: 'node', startTimeoutMs: 'logo' } }).custom).not.toHaveProperty('startTimeoutMs')
  })

  it('keeps the other parts as they were: credentials, the user\'s own OAuth app and the rehearsal', () => {
    expect(connectInputFrom({ credentials: { A: 1, B: null, C: 'texto' } })).toEqual({ credentials: { A: '1', B: '', C: 'texto' } })
    expect(connectInputFrom({ oauthClient: { clientId: ' abc ', clientSecret: ' s ' } })).toEqual({ oauthClient: { clientId: 'abc', clientSecret: 's' } })
    expect(connectInputFrom({ oauthClient: { clientId: 'abc', clientSecret: '  ' } })).toEqual({ oauthClient: { clientId: 'abc' } })
    expect(() => connectInputFrom({ oauthClient: { clientId: '' } })).toThrow(/clientId/)
    expect(() => connectInputFrom({ oauthClient: [] })).toThrow(/oauthClient/)
    expect(connectInputFrom({ dryRun: true })).toEqual({ dryRun: true })
    expect(connectInputFrom({ dryRun: { minIntervalMs: 120_000 } })).toEqual({ dryRun: { minIntervalMs: 60_000 } })
    expect(connectInputFrom({ dryRun: { minIntervalMs: 0 } })).toEqual({ dryRun: true })
    expect(connectInputFrom({ dryRun: 'sim' })).toEqual({})
  })
})
