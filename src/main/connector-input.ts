import type { ConnectInput } from '../shared/mcp-connectors.js'

/**
 * What the renderer may hand to `connectConnector`. The renderer is not trusted to send well-formed data: only the
 * known fields get through, strings are bounded and the shapes are checked. Credential values are never logged.
 * The limits that the service itself enforces with a message the user can act on (100 arguments, 60 variables) are
 * passed one over, so it still sees "too many" instead of a silently shortened list.
 */

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`campo inválido: ${field}`)
  return value.slice(0, max)
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, field, max)
}

function stringMap(candidate: unknown, field: string, limit: number): Record<string, string> | undefined {
  if (candidate === undefined || candidate === null) return undefined
  if (typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`campo inválido: ${field}`)
  return Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>)
      .slice(0, limit)
      .map(([key, item]) => [key.slice(0, 120), String(item ?? '').slice(0, 4000)])
  )
}

export function connectInputFrom(raw: unknown): ConnectInput {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('campo inválido: input')
  const value = raw as Record<string, unknown>
  const input: ConnectInput = {}
  const credentials = stringMap(value.credentials, 'credentials', 40)
  if (credentials) input.credentials = credentials

  if (value.custom !== undefined && value.custom !== null) {
    if (typeof value.custom !== 'object' || Array.isArray(value.custom)) throw new Error('campo inválido: custom')
    const custom = value.custom as Record<string, unknown>
    // A local program has a command and no address; a remote server must have an address.
    const command = optionalText(custom.command, 'custom.command', 1200)
    const url = command ? optionalText(custom.url, 'custom.url', 2000) : text(custom.url, 'custom.url', 2000)
    input.custom = {
      // Ignored for a directory entry that only lacks a URL; a hand-made connector without a name is refused by the service.
      name: typeof custom.name === 'string' ? custom.name.slice(0, 60) : '',
      transport: custom.transport === 'sse' ? 'sse' : 'http'
    }
    if (url) input.custom.url = url
    const headers = stringMap(custom.headers, 'custom.headers', 40)
    if (headers) input.custom.headers = headers
    if (command) {
      input.custom.command = command
      if (custom.args !== undefined && custom.args !== null) {
        if (!Array.isArray(custom.args)) throw new Error('campo inválido: custom.args')
        input.custom.args = custom.args.slice(0, 101).map((item) => String(item ?? '').slice(0, 4000))
      }
      const env = stringMap(custom.env, 'custom.env', 61)
      if (env) input.custom.env = env
      const cwd = optionalText(custom.cwd, 'custom.cwd', 1200)
      if (cwd) input.custom.cwd = cwd
    }
    // Applies to a remote server too (a slow one); the service clamps it to 5 s - 10 min.
    const startTimeout = Number(custom.startTimeoutMs)
    if (Number.isFinite(startTimeout) && startTimeout > 0) input.custom.startTimeoutMs = Math.round(startTimeout)
  }
  if (value.update === true) input.update = true

  // The user's own OAuth app: the id is public, the secret goes to the vault (never logged, never written to settings.json).
  if (value.oauthClient !== undefined && value.oauthClient !== null) {
    if (typeof value.oauthClient !== 'object' || Array.isArray(value.oauthClient)) throw new Error('campo inválido: oauthClient')
    const client = value.oauthClient as Record<string, unknown>
    const clientSecret = typeof client.clientSecret === 'string' ? client.clientSecret.trim().slice(0, 2000) : ''
    input.oauthClient = {
      clientId: text(client.clientId, 'oauthClient.clientId', 500).trim(),
      ...(clientSecret ? { clientSecret } : {})
    }
  }
  // Rehearsal: true, or { minIntervalMs } to space the requests to one host (0 to 60 s).
  if (value.dryRun === true) input.dryRun = true
  else if (value.dryRun && typeof value.dryRun === 'object' && !Array.isArray(value.dryRun)) {
    const spacing = Number((value.dryRun as Record<string, unknown>).minIntervalMs)
    input.dryRun = Number.isFinite(spacing) && spacing > 0 ? { minIntervalMs: Math.min(60_000, Math.round(spacing)) } : true
  }
  return input
}
