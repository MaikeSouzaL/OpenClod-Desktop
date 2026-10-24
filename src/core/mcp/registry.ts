import type { McpServerSettings } from '../../shared/types.js'

/**
 * Thin client for the official MCP Registry (registry.modelcontextprotocol.io).
 * It is used only when the curated catalog has no answer, so the harness can
 * discover and install a server it has never seen before.
 */
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers'

interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  runtimeArguments?: Array<{ value?: string; type?: string } | string>
  packageArguments?: Array<{ value?: string; type?: string } | string>
  environmentVariables?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }>
  transport?: { type?: string }
}

interface RegistryRemote {
  type?: string
  url?: string
  headers?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }>
}

interface RegistryServer {
  name?: string
  title?: string
  description?: string
  version?: string
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
  repository?: { url?: string }
}

interface RegistryResponse {
  servers?: Array<{ server?: RegistryServer; _meta?: { 'io.modelcontextprotocol.registry/official'?: { isLatest?: boolean } } }>
}

export interface RegistrySearchResult {
  id: string
  name: string
  description: string
  version: string
  transport: 'stdio' | 'http' | 'sse'
  installable: boolean
  needs: string[]
  docs?: string
  source: 'registry'
}

export interface RegistryInstall {
  server: McpServerSettings | null
  missing: string[]
  error?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function versionParts(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((part) => Number(part))
}

function newestFirst(a: RegistryServer, b: RegistryServer): number {
  const av = versionParts(str(a.version))
  const bv = versionParts(str(b.version))
  for (let index = 0; index < Math.max(av.length, bv.length); index++) {
    const diff = (bv[index] ?? 0) - (av[index] ?? 0)
    if (diff) return diff
  }
  return 0
}

function packageArgs(pkg: RegistryPackage): string[] {
  const list = [...(pkg.runtimeArguments ?? []), ...(pkg.packageArguments ?? [])]
  const out: string[] = []
  for (const arg of list) {
    if (typeof arg === 'string') out.push(arg)
    else if (arg && typeof arg.value === 'string') out.push(arg.value)
  }
  return out
}

function registryToResult(entry: RegistryServer): RegistrySearchResult | null {
  const name = str(entry.name)
  if (!name) return null
  const remote = entry.remotes?.find((item) => str(item.url))
  if (remote) {
    const transport = str(remote.type) === 'sse' ? 'sse' : 'http'
    const needs = (remote.headers ?? []).filter((header) => header.isRequired).map((header) => str(header.name))
    return {
      id: name,
      name: str(entry.title) || name,
      description: str(entry.description),
      version: str(entry.version),
      transport,
      installable: true,
      needs,
      docs: str(entry.repository?.url) || undefined,
      source: 'registry'
    }
  }
  const pkg = entry.packages?.find((item) => str(item.identifier))
  if (!pkg) return null
  const registryType = str(pkg.registryType)
  const needs = (pkg.environmentVariables ?? []).filter((item) => item.isRequired).map((item) => str(item.name))
  return {
    id: name,
    name: str(entry.title) || name,
    description: str(entry.description),
    version: str(entry.version),
    transport: 'stdio',
    installable: registryType === 'npm' || registryType === 'pypi' || registryType === 'oci',
    needs,
    docs: str(entry.repository?.url) || undefined,
    source: 'registry'
  }
}

async function fetchRegistry(params: URLSearchParams, timeoutMs = 9000): Promise<RegistryServer[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${REGISTRY_URL}?${params.toString()}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`registro MCP respondeu HTTP ${response.status}`)
    const json = (await response.json()) as RegistryResponse
    return (json.servers ?? [])
      .map((item) => item.server)
      .filter((server): server is RegistryServer => Boolean(server && str(server.name)))
  } finally {
    clearTimeout(timer)
  }
}

/** Registry search; failures are non-fatal because the curated catalog still answers. */
export async function searchMcpRegistry(query: string, limit = 8): Promise<RegistrySearchResult[]> {
  const params = new URLSearchParams({ search: query, limit: String(Math.max(limit * 3, 12)) })
  const servers = await fetchRegistry(params)
  const sorted = [...servers].sort(newestFirst)
  const seen = new Set<string>()
  const out: RegistrySearchResult[] = []
  for (const server of sorted) {
    const name = str(server.name)
    if (seen.has(name)) continue
    const result = registryToResult(server)
    if (!result) continue
    seen.add(name)
    out.push(result)
    if (out.length >= limit) break
  }
  return out
}

/** Resolves an exact registry name (with or without @version) and builds a config. */
export async function installFromRegistry(
  id: string,
  values: { env?: Record<string, string>; headers?: Record<string, string>; name?: string } = {}
): Promise<RegistryInstall> {
  const [rawName, version] = id.split('@')
  const servers = await fetchRegistry(new URLSearchParams({ search: rawName, limit: '50' }))
  const matches = servers
    .filter((server) => str(server.name) === rawName && (!version || str(server.version) === version))
    .sort(newestFirst)
  const entry = matches[0]
  if (!entry) return { server: null, missing: [], error: `servidor "${id}" não encontrado no registro MCP` }

  const remote = entry.remotes?.find((item) => str(item.url))
  if (remote) {
    const headers = { ...(values.headers ?? {}) }
    const missing: string[] = []
    for (const header of remote.headers ?? []) {
      const key = str(header.name)
      if (!key) continue
      if (!headers[key]?.trim()) {
        if (header.isRequired) missing.push(key)
        else delete headers[key]
      }
    }
    if (missing.length) return { server: null, missing, error: `faltam headers: ${missing.join(', ')}` }
    const server: McpServerSettings = {
      name: (values.name || rawName.split('/').pop() || rawName).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60),
      type: str(remote.type) === 'sse' ? 'sse' : 'http',
      url: str(remote.url),
      command: '',
      args: [],
      enabled: true
    }
    if (Object.keys(headers).length) server.headers = headers
    return { server, missing: [] }
  }

  const pkg = entry.packages?.find((item) => str(item.identifier))
  if (!pkg) return { server: null, missing: [], error: `"${id}" não publica pacote nem endpoint remoto` }
  const registryType = str(pkg.registryType)
  const identifier = str(pkg.identifier)
  const env = { ...(values.env ?? {}) }
  const missing: string[] = []
  for (const variable of pkg.environmentVariables ?? []) {
    const key = str(variable.name)
    if (!key) continue
    if (!env[key]?.trim()) {
      if (variable.isRequired) missing.push(key)
      else delete env[key]
    }
  }
  if (missing.length) return { server: null, missing, error: `faltam variáveis: ${missing.join(', ')}` }

  let command = str(pkg.runtimeHint)
  if (registryType === 'npm') command = command || 'npx'
  else if (registryType === 'pypi') command = command || 'uvx'
  else if (registryType === 'oci') command = command || 'docker'
  else return { server: null, missing: [], error: `tipo de pacote não suportado: ${registryType}` }

  const args = packageArgs(pkg)
  if (registryType === 'npm' && !args.includes('-y')) args.unshift('-y')
  if (registryType === 'pypi' && command === 'uvx' && !args.includes(identifier)) args.unshift(identifier)
  if (registryType === 'npm' && !args.includes(identifier)) args.unshift(identifier)
  if (registryType === 'oci') args.unshift('run', '-i', '--rm', identifier)

  const server: McpServerSettings = {
    name: (values.name || rawName.split('/').pop() || rawName).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60),
    type: 'stdio',
    command,
    args,
    enabled: true
  }
  if (Object.keys(env).length) server.env = env
  return { server, missing: [] }
}
