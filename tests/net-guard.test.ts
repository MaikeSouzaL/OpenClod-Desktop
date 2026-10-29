import { describe, expect, it } from 'vitest'
import { addressKind, checkTarget, guardedFetch, MAX_REDIRECTS, type Lookup } from '../src/core/security/net-guard'
import { childProcessEnv } from '../src/core/security/policy'

const lookup = (table: Record<string, string[]>): Lookup => async (host) => {
  if (!table[host]) throw new Error('ENOTFOUND')
  return table[host]
}

describe('addressKind', () => {
  it('blocks metadata, link-local, unspecified and multicast; marks this computer and the LAN as internal', () => {
    for (const blocked of ['169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fe80::1', 'ff02::1', '::', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
      expect(addressKind(blocked), blocked).toBe('blocked')
    }
    for (const internal of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '[::1]']) {
      expect(addressKind(internal), internal).toBe('internal')
    }
    for (const open of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) expect(addressKind(open), open).toBe('public')
  })
})

describe('checkTarget', () => {
  it('judges the name and every address it resolves to', async () => {
    const dnsTable = lookup({ 'example.com': ['93.184.216.34'], 'rebind.example': ['93.184.216.34', '10.0.0.7'], 'meta.example': ['169.254.169.254'] })
    expect(await checkTarget(new URL('https://example.com/x'), dnsTable)).toEqual({ kind: 'public', detail: 'example.com' })
    expect(await checkTarget(new URL('https://rebind.example/'), dnsTable)).toEqual({ kind: 'internal', detail: 'rebind.example → 10.0.0.7' })
    expect((await checkTarget(new URL('http://meta.example/'), dnsTable)).kind).toBe('blocked')
    expect((await checkTarget(new URL('http://metadata.google.internal/'), dnsTable)).kind).toBe('blocked')
    expect((await checkTarget(new URL('http://localhost:5173/'), dnsTable)).kind).toBe('internal')
    expect((await checkTarget(new URL('http://[::1]:3000/'), dnsTable)).kind).toBe('internal')
    expect((await checkTarget(new URL('file:///C:/Windows/win.ini'), dnsTable)).kind).toBe('blocked')
  })
})

describe('guardedFetch', () => {
  const dnsTable = lookup({ 'public.example': ['93.184.216.34'], 'evil.example': ['93.184.216.35'] })
  const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } })

  it('follows redirects by itself and refuses one that leads to the metadata service', async () => {
    const hops: string[] = []
    const fakeFetch = (async (input: URL) => {
      hops.push(input.href)
      return input.host === 'evil.example' ? redirect('http://169.254.169.254/latest/meta-data/') : new Response('ok')
    }) as unknown as typeof fetch
    await expect(
      guardedFetch(new URL('https://evil.example/x'), { init: {}, allowInternal: async () => true, lookup: dnsTable, fetch: fakeFetch })
    ).rejects.toThrow(/destino bloqueado: 169\.254\.169\.254/)
    expect(hops).toEqual(['https://evil.example/x'])
  })

  it('asks before a redirect into the local network, says who sent it there, and refuses when not allowed', async () => {
    const asked: string[] = []
    const fakeFetch = (async (input: URL) => (input.host === 'evil.example' ? redirect('http://192.168.0.1/admin') : new Response('painel'))) as unknown as typeof fetch
    await expect(
      guardedFetch(new URL('https://evil.example/'), {
        init: {},
        allowInternal: async (check, url, via) => {
          asked.push(`${url.href} ${check.detail} via ${via?.host}`)
          return false
        },
        lookup: dnsTable,
        fetch: fakeFetch
      })
    ).rejects.toThrow(/rede local recusado: 192\.168\.0\.1 \(redirecionado por evil\.example\)/)
    expect(asked).toEqual(['http://192.168.0.1/admin 192.168.0.1 via evil.example'])
    const allowed = await guardedFetch(new URL('https://evil.example/'), { init: {}, allowInternal: async () => true, lookup: dnsTable, fetch: fakeFetch })
    expect(await allowed.response.text()).toBe('painel')
    expect(allowed.url.href).toBe('http://192.168.0.1/admin')
  })

  it('stops after too many redirects', async () => {
    let n = 0
    const fakeFetch = (async () => redirect(`https://public.example/${++n}`)) as unknown as typeof fetch
    await expect(guardedFetch(new URL('https://public.example/0'), { init: {}, allowInternal: async () => true, lookup: dnsTable, fetch: fakeFetch })).rejects.toThrow(
      /redirecionamentos demais/
    )
    expect(n).toBe(MAX_REDIRECTS + 1)
  })
})

describe('childProcessEnv (MCP servers over stdio)', () => {
  it('passes what a program needs and the server env, never the app keys', () => {
    const saved = { ...process.env }
    try {
      process.env.OPENAI_API_KEY = 'sk-segredo'
      process.env.GITHUB_TOKEN = 'ghp-segredo'
      process.env.HTTPS_PROXY = 'http://proxy:8080'
      process.env.LC_ALL = 'pt_BR.UTF-8'
      const env = childProcessEnv({ SERVER_TOKEN: 'do-servidor' })
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(Object.keys(env).some((key) => key.toUpperCase() === 'PATH')).toBe(true)
      expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
      expect(env.LC_ALL).toBe('pt_BR.UTF-8')
      expect(env.SERVER_TOKEN).toBe('do-servidor')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
})
