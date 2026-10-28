import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, HookDefinition, HookMatcher, McpServerSettings, ProviderConfig } from '../../shared/types.js'
import { redactSecrets } from '../security/policy.js'

const VERSION = 1
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key)/i

export interface ConfigBundle {
  kind: 'openclod-config'
  version: 1
  createdAt: string
  settings: Partial<AppSettings>
  warnings: string[]
}

export interface ConfigFileResult {
  path: string
  bytes: number
  sha256: string
  createdAt: string
  warnings: string[]
}

export interface ConfigInspectResult {
  path: string
  createdAt: string
  settings: Partial<AppSettings>
  warnings: string[]
}

function safeText(value: string): string {
  return redactSecrets(
    value
      .replace(/((?:--?|)(?:api[_-]?key|token|secret|password|passwd)\s*=\s*)([^\s]+)/gi, '$1[REDACTED]')
      .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, 'Authorization: [REDACTED]')
      .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '<USER_HOME>')
      .replace(/\/home\/[^/\s]+/g, '<USER_HOME>')
  )
}

function safeUrl(value: string): string {
  const text = safeText(value)
  try {
    const parsed = new URL(text)
    for (const key of [...parsed.searchParams.keys()]) if (SECRET_KEY.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return text
  }
}

function cleanRecord(record: Record<string, string> | undefined, warnings: string[], where: string, omitAll = false): Record<string, string> | undefined {
  if (!record) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record).slice(0, 100)) {
    // `${secret:...}` is a pointer into this machine's vault: meaningless (and misleading) in an exported file.
    if (omitAll || SECRET_KEY.test(key) || String(value).includes('${secret:')) {
      warnings.push(`${where}.${key} omitido da exportação`)
      continue
    }
    out[key] = safeText(String(value).slice(0, 4_000))
  }
  return out
}

function cleanProvider(provider: ProviderConfig, warnings: string[]): ProviderConfig {
  const apiKeyRef = typeof provider.apiKeyRef === 'string' && /^(?:env|secret):/.test(provider.apiKeyRef) ? provider.apiKeyRef : ''
  if (provider.apiKeyRef && !apiKeyRef) warnings.push(`credencial embutida do provedor ${provider.id} omitida`)
  return {
    ...provider,
    baseUrl: safeUrl(provider.baseUrl),
    apiKeyRef,
    models: Array.isArray(provider.models) ? provider.models.map((model) => safeText(String(model))).slice(0, 1_000) : []
  }
}

function cleanMcp(server: McpServerSettings, warnings: string[]): McpServerSettings {
  return {
    ...server,
    name: safeText(server.name),
    url: server.url ? safeUrl(server.url) : undefined,
    command: safeText(server.command),
    args: (server.args ?? []).slice(0, 200).map((arg) => safeText(arg)),
    cwd: server.cwd ? safeText(server.cwd) : undefined,
    env: cleanRecord(server.env, warnings, `mcp.${server.name}.env`),
    headers: cleanRecord(server.headers, warnings, `mcp.${server.name}.headers`, true)
  }
}

function cleanHook(hook: HookDefinition, warnings: string[], index: string): HookDefinition {
  if (hook.type === 'command') return { ...hook, command: safeText(hook.command) }
  return {
    ...hook,
    url: safeUrl(hook.url),
    headers: cleanRecord(hook.headers, warnings, `hook.${index}.headers`, true)
  }
}

function cleanHooks(settings: AppSettings, warnings: string[]): AppSettings['hooks'] {
  if (!settings.hooks) return undefined
  return Object.fromEntries(Object.entries(settings.hooks).map(([event, matchers]) => [
    event,
    (matchers ?? []).map((matcher: HookMatcher, index) => ({
      ...matcher,
      hooks: (matcher.hooks ?? []).map((hook, hookIndex) => cleanHook(hook, warnings, `${event}.${index}.${hookIndex}`))
    }))
  ])) as AppSettings['hooks']
}

export class ConfigTransferService {
  build(settings: AppSettings): ConfigBundle {
    const warnings: string[] = []
    const safeSettings: Partial<AppSettings> = {
      providers: settings.providers.map((provider) => cleanProvider(provider, warnings)),
      defaultProviderId: settings.defaultProviderId,
      policy: structuredClone(settings.policy),
      limits: structuredClone(settings.limits),
      theme: settings.theme,
      profileName: settings.profileName,
      telemetry: false,
      autoAgents: settings.autoAgents,
      environments: (settings.environments ?? []).map((environment) => ({
        ...environment,
        command: environment.command ? safeText(environment.command) : undefined,
        remoteCwd: environment.remoteCwd ? safeText(environment.remoteCwd) : undefined
      })),
      useAllModels: settings.useAllModels,
      fallbackOrder: settings.fallbackOrder,
      fallbackExclude: settings.fallbackExclude,
      fallbackModels: settings.fallbackModels,
      visionModel: settings.visionModel,
      lastModel: settings.lastModel,
      claudeCatalogImported: settings.claudeCatalogImported,
      mcpServers: (settings.mcpServers ?? []).map((server) => cleanMcp(server, warnings)),
      hooks: cleanHooks(settings, warnings),
      browser: settings.browser,
      importClaudeSettings: settings.importClaudeSettings,
      voice: settings.voice,
      settingsVersion: settings.settingsVersion
    }
    return { kind: 'openclod-config', version: VERSION, createdAt: new Date().toISOString(), settings: safeSettings, warnings }
  }

  async create(destination: string, settings: AppSettings): Promise<ConfigFileResult> {
    const bundle = this.build(settings)
    const json = `${JSON.stringify(bundle, null, 2)}\n`
    const bytes = Buffer.from(json, 'utf8')
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    await fs.promises.mkdir(path.dirname(path.resolve(destination)), { recursive: true })
    await fs.promises.writeFile(destination, bytes)
    return { path: destination, bytes: bytes.length, sha256, createdAt: bundle.createdAt, warnings: bundle.warnings }
  }

  async inspect(file: string): Promise<ConfigInspectResult> {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) throw new Error('configuração não é um arquivo')
    if (stat.size > MAX_FILE_BYTES) throw new Error('configuração maior que 2 MB')
    let parsed: ConfigBundle
    try {
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as ConfigBundle
    } catch {
      throw new Error('JSON de configuração inválido')
    }
    if (parsed?.kind !== 'openclod-config') throw new Error('arquivo não é uma configuração do Openclod')
    if (parsed.version !== VERSION) throw new Error(`versão de configuração incompatível: ${String(parsed.version)}`)
    if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) throw new Error('configuração sem objeto settings')
    return {
      path: file,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
      settings: parsed.settings,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === 'string').slice(0, 200) : []
    }
  }

  mergeSensitiveMcp(current: McpServerSettings[], imported: McpServerSettings[]): { servers: McpServerSettings[]; mergedFields: number } {
    let mergedFields = 0
    const byName = new Map(current.map((server) => [server.name, server]))
    const servers = imported.map((server) => {
      const existing = byName.get(server.name)
      if (!existing) return server
      const env = { ...(server.env ?? {}) }
      for (const [key, value] of Object.entries(existing.env ?? {})) {
        if (SECRET_KEY.test(key) && env[key] === undefined) {
          env[key] = value
          mergedFields++
        }
      }
      const headers = { ...(server.headers ?? {}) }
      for (const [key, value] of Object.entries(existing.headers ?? {})) {
        if (SECRET_KEY.test(key) && headers[key] === undefined) {
          headers[key] = value
          mergedFields++
        }
      }
      return { ...server, env: Object.keys(env).length ? env : undefined, headers: Object.keys(headers).length ? headers : undefined }
    })
    return { servers, mergedFields }
  }
}
