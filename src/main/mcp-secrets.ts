import type { McpServerSettings } from '../shared/types.js'

/**
 * Pure helpers for MCP secrets (no Electron, no disk). The vault itself lives in SettingsStore
 * (`secrets.bin`, OS-encrypted); settings.json only ever holds references of the form
 * `${secret:<servidor>.<NOME>}`, resolved when the server starts.
 */

/** Names whose value is a credential: matched against env variable names and header names. */
const SECRET_NAME = /key|token|secret|password|authorization|bearer/i
/** Names that match above but only carry numbers/flags ("MAX_TOKENS", "TOKEN_LIMIT"...). */
const NOT_SECRET_NAME =
  /(?:max|min|limit|count|budget|ttl|expir\w*|timeout|size)[_-]?tokens?$|tokens?[_-]?(?:max|min|limit|count|budget|ttl|expir\w*|timeout|size|type)$/i

export const MASK = '••••••'

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) && !NOT_SECRET_NAME.test(name)
}

/** A connection string with the password inside (`postgres://user:pass@host/db`): secret whatever its name. */
export function looksLikeCredentialUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i.test(value.trim())
}

/** `%`, `.` and `}` are escaped so a name cannot break the reference or the first-dot split. */
function encodePart(value: string): string {
  return value.replace(/[%.}]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** `<servidor>.<NOME>`: the text between `${secret:` and `}`. */
export function secretRefInner(server: string, key: string): string {
  return `${encodePart(server)}.${encodePart(key)}`
}

export function secretRef(server: string, key: string): string {
  return `\${secret:${secretRefInner(server, key)}}`
}

/** Key of the vault entry (`secrets.bin`) behind a reference inner. Never collides with provider ids. */
export function vaultKey(inner: string): string {
  return `mcp:${inner}`
}

export function vaultKeyFor(server: string, key: string): string {
  return vaultKey(secretRefInner(server, key))
}

/** Prefix of every vault entry of one server. */
export function vaultPrefixFor(server: string): string {
  return `mcp:${encodePart(server)}.`
}

const REF_PATTERN = /\$\{secret:([^}]+)\}/g

export function hasSecretRef(value: string): boolean {
  return /\$\{secret:[^}]+\}/.test(value)
}

/** Inner parts (`servidor.NOME`) of every reference in a text. */
export function secretRefsIn(value: string): string[] {
  return [...value.matchAll(REF_PATTERN)].map((match) => match[1])
}

/**
 * Replaces each reference with its secret. A reference without a value is left out of the text
 * and reported in `missing`; the caller decides what to do (the server is not started with half a credential).
 */
export function resolveSecretRefs(
  value: string,
  lookup: (inner: string) => string | undefined,
  missing?: string[]
): string {
  return value.replace(REF_PATTERN, (_whole, inner: string) => {
    const secret = lookup(inner)
    if (secret === undefined) {
      missing?.push(inner)
      return ''
    }
    return secret
  })
}

const SCHEME = /^(Bearer|Basic|Token)\s+(.*)$/i

/** "••••••" + last two characters (only when the secret is long enough that this reveals little). */
export function maskSecret(value: string): string {
  const scheme = SCHEME.exec(value)
  const prefix = scheme ? `${scheme[1]} ` : ''
  const body = scheme ? scheme[2] : value
  return `${prefix}${MASK}${body.length >= 8 ? body.slice(-2) : ''}`
}

/** A value that is still the placeholder shown by `maskSecret` (nothing was typed over it). */
export function isMaskedSecret(value: string): boolean {
  return /^(?:(?:Bearer|Basic|Token)\s+)?•{6}.{0,2}$/i.test(value.trim())
}

export interface ResolvedServer {
  server: McpServerSettings
  /** Reference inners that had no value in the vault. */
  missing: string[]
}

/**
 * The server exactly as the MCP client must run it: env, headers, args and url with the secrets filled in.
 * Entries whose reference is missing are dropped (never sent half-filled) and listed in `missing`.
 */
export function resolveServerSecrets(
  server: McpServerSettings,
  lookup: (inner: string) => string | undefined
): ResolvedServer {
  const missing: string[] = []
  const next: McpServerSettings = { ...server }
  for (const section of ['env', 'headers'] as const) {
    const record = server[section]
    if (!record) continue
    const copy: Record<string, string> = {}
    for (const [key, raw] of Object.entries(record)) {
      const gaps: string[] = []
      const value = resolveSecretRefs(String(raw), lookup, gaps)
      if (gaps.length) missing.push(...gaps)
      else copy[key] = value
    }
    next[section] = copy
  }
  const fill = (text: string): string => {
    const gaps: string[] = []
    const value = resolveSecretRefs(text, lookup, gaps)
    if (gaps.length) missing.push(...gaps)
    return gaps.length ? text : value
  }
  if (server.args?.some((arg) => hasSecretRef(arg))) next.args = server.args.map(fill)
  if (server.url && hasSecretRef(server.url)) next.url = fill(server.url)
  return { server: next, missing: [...new Set(missing)] }
}

/** Display form for the JSON editor: every credential masked, references resolved first so the tail is the real one. */
export function maskServerSecrets(
  server: McpServerSettings,
  lookup: (inner: string) => string | undefined
): McpServerSettings {
  const next: McpServerSettings = { ...server }
  for (const section of ['env', 'headers'] as const) {
    const record = server[section]
    if (!record) continue
    const copy: Record<string, string> = {}
    for (const [key, raw] of Object.entries(record)) {
      const value = String(raw)
      const gaps: string[] = []
      const real = resolveSecretRefs(value, lookup, gaps)
      if (gaps.length) copy[key] = value
      else if ((hasSecretRef(value) || isSecretName(key) || looksLikeCredentialUrl(real)) && real) copy[key] = maskSecret(real)
      else copy[key] = value
    }
    next[section] = copy
  }
  return next
}

/** What one server can lend to another (resolved values, never logged). */
export interface CredentialSource {
  env?: Record<string, string>
  headers?: Record<string, string>
}

function decodeBasic(value: string | undefined): { user: string; token: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(value?.trim() ?? '')
  if (!match) return null
  try {
    const text = Buffer.from(match[1], 'base64').toString('utf8')
    const split = text.indexOf(':')
    if (split <= 0) return null
    const user = text.slice(0, split)
    const token = text.slice(split + 1)
    return user && token ? { user, token } : null
  } catch {
    return null
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const hit = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return hit?.[1]
}

const USER_ROLE = /(?:^|[_-])(?:user(?:name)?|email|login)$/i
const TOKEN_ROLE = /(?:^|[_-])(?:api[_-]?token|access[_-]?token|token|password|api[_-]?key)$/i

/**
 * Credentials of an already configured server for the keys another server asks for. Same-name keys are copied;
 * otherwise an identity (user + token) is derived from a Basic `Authorization` header (Atlassian email:token),
 * a Bearer token or the `*_EMAIL/_USERNAME` and `*_API_TOKEN/_TOKEN` variables, and fills the keys by role.
 */
export function deriveCredentials(
  source: CredentialSource,
  targetKeys: string[]
): { values: Record<string, string>; keys: string[] } {
  const values: Record<string, string> = {}
  const pool = new Map<string, string>()
  for (const [key, value] of Object.entries(source.env ?? {})) if (value) pool.set(key.toLowerCase(), value)
  for (const [key, value] of Object.entries(source.headers ?? {})) if (value) pool.set(key.toLowerCase(), value)
  for (const key of targetKeys) {
    const same = pool.get(key.toLowerCase())
    if (same) values[key] = same
  }

  const authorization = headerValue(source.headers, 'authorization')
  const basic = decodeBasic(authorization)
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '')?.[1]
  const envEntries = Object.entries(source.env ?? {}).filter(([, value]) => value)
  const user = basic?.user ?? envEntries.find(([key]) => USER_ROLE.test(key))?.[1]
  const token = basic?.token ?? bearer ?? envEntries.find(([key]) => TOKEN_ROLE.test(key))?.[1]
  for (const key of targetKeys) {
    if (values[key]) continue
    if (USER_ROLE.test(key) && user) values[key] = user
    else if (TOKEN_ROLE.test(key) && token) values[key] = token
  }
  return { values, keys: Object.keys(values) }
}
