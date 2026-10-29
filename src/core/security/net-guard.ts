import dns from 'node:dns'
import net from 'node:net'

/**
 * Where a web tool may go. A page the model read can tell it to open a URL; this keeps that from reaching the cloud
 * metadata service or, without the user's say, the computer itself and the local network — including through a
 * public URL that redirects there or a public name that resolves there.
 *
 * - `blocked`: never (metadata, link-local, unspecified, multicast, reserved, schemes other than http/https);
 * - `internal`: this computer or the local network (loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7);
 * - `public`: anything else.
 */
export type TargetKind = 'public' | 'internal' | 'blocked'

export interface TargetCheck {
  kind: TargetKind
  /** The address that decided it, or the reason for a blocked scheme or name. */
  detail: string
}

const BLOCKED_NAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'instance-data.ec2.internal'])

function ipv4Kind(address: string): TargetKind {
  const [a, b, c] = address.split('.').map(Number)
  if (a === 0 || a >= 224) return 'blocked' // unspecified, multicast, reserved, broadcast
  if (a === 169 && b === 254) return 'blocked' // link-local: cloud metadata lives here
  if (a === 100 && b === 100 && c === 100) return 'blocked' // Alibaba metadata (100.100.100.200)
  if (a === 192 && b === 0 && c === 0) return 'blocked' // IETF protocol assignments
  if (a === 127 || a === 10) return 'internal'
  if (a === 172 && b >= 16 && b <= 31) return 'internal'
  if (a === 192 && b === 168) return 'internal'
  if (a === 100 && b >= 64 && b <= 127) return 'internal' // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return 'internal' // benchmarking networks
  return 'public'
}

export function addressKind(address: string): TargetKind {
  const plain = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (net.isIPv4(plain)) return ipv4Kind(plain)
  if (!net.isIPv6(plain)) return 'public'
  if (plain === '::' ) return 'blocked'
  if (plain === '::1') return 'internal'
  // IPv4 inside IPv6 (::ffff:10.0.0.1, ::ffff:a00:1, 64:ff9b::a00:1): judged as the IPv4 it carries.
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(plain)?.[1]
  if (mapped) return ipv4Kind(mapped)
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(plain)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return ipv4Kind(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  if (/^fe[89ab]/.test(plain)) return 'blocked' // link-local
  if (/^ff/.test(plain)) return 'blocked' // multicast
  if (/^f[cd]/.test(plain)) return 'internal' // unique local
  return 'public'
}

export type Lookup = (host: string) => Promise<string[]>

const systemLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

/** Judges a URL by its scheme, its name and every address the name resolves to (the strictest one wins). */
export async function checkTarget(url: URL, lookup: Lookup = systemLookup): Promise<TargetCheck> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', detail: `esquema ${url.protocol} não permitido` }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_NAMES.has(host)) return { kind: 'blocked', detail: `${host} (serviço de metadados da nuvem)` }
  if (host === 'localhost' || host.endsWith('.localhost')) return { kind: 'internal', detail: host }
  const literal = host.replace(/^\[|\]$/g, '')
  if (net.isIP(literal)) {
    const kind = addressKind(literal)
    return { kind, detail: literal }
  }
  let addresses: string[]
  try {
    addresses = await lookup(host)
  } catch {
    // A name that does not resolve fails in the fetch itself, with its own error.
    return { kind: 'public', detail: host }
  }
  let verdict: TargetCheck = { kind: 'public', detail: host }
  for (const address of addresses) {
    const kind = addressKind(address)
    if (kind === 'blocked') return { kind, detail: `${host} → ${address}` }
    if (kind === 'internal') verdict = { kind, detail: `${host} → ${address}` }
  }
  return verdict
}

export const MAX_REDIRECTS = 5

export interface GuardedFetchOptions {
  init: RequestInit
  /** Asked before going to this computer or the local network; false refuses. */
  allowInternal(check: TargetCheck, url: URL, via?: URL): Promise<boolean>
  lookup?: Lookup
  fetch?: typeof fetch
}

/**
 * fetch with every hop checked: redirects are followed here (at most MAX_REDIRECTS), each new address judged again,
 * so a public page cannot send the tool to the metadata service or, unasked, to the local network.
 */
export async function guardedFetch(start: URL, options: GuardedFetchOptions): Promise<{ response: Response; url: URL }> {
  let url = start
  let via: URL | undefined
  const allowed = new Set<string>()
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkTarget(url, options.lookup)
    if (check.kind === 'blocked') throw new Error(`destino bloqueado: ${check.detail}`)
    if (check.kind === 'internal' && !allowed.has(url.host)) {
      if (!(await options.allowInternal(check, url, via))) {
        throw new Error(`acesso à rede local recusado: ${check.detail}${via ? ` (redirecionado por ${via.host})` : ''}`)
      }
      allowed.add(url.host)
    }
    const response = await (options.fetch ?? fetch)(url, { ...options.init, redirect: 'manual' })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (!location) return { response, url }
    await response.body?.cancel().catch(() => undefined)
    via = url
    url = new URL(location, url)
  }
  throw new Error(`redirecionamentos demais (mais de ${MAX_REDIRECTS})`)
}
