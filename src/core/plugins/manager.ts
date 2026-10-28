import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { RiskLevel, ToolResult } from '../../shared/types.js'
import type { PluginInfo, PluginToolInfo } from '../../shared/api.js'
import { sanitizedEnv } from '../security/policy.js'
import type { ToolDef } from '../tools/types.js'

const API_MAJOR = 1
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_TOOL_OUTPUT = 2 * 1024 * 1024

export interface PluginToolContribution {
  key: string
  name: string
  description: string
  risk?: RiskLevel
  inputSchema?: Record<string, unknown>
  timeoutMs?: number
}

export interface PluginManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description: string
  author?: string
  apiVersion: string
  runtime: 'node'
  main: string
  dependencies?: Record<string, string>
  permissions?: string[]
  contributions: {
    tools?: PluginToolContribution[]
    skills?: string[]
    commands?: Array<{ name: string; description?: string }>
    hooks?: string[]
  }
}

interface PluginState {
  version: 1
  enabled: string[]
}

export class PluginManager {
  private manifests = new Map<string, PluginManifest>()
  private errors = new Map<string, string>()
  private enabled = new Set<string>()
  private initialized = false

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await fs.promises.mkdir(this.root, { recursive: true })
    try {
      const state = JSON.parse(await fs.promises.readFile(path.join(this.root, 'state.json'), 'utf8')) as PluginState
      this.enabled = new Set(state.version === 1 && Array.isArray(state.enabled) ? state.enabled.filter((id) => typeof id === 'string') : [])
    } catch {
      this.enabled = new Set()
    }
    await this.scan()
  }

  list(): PluginInfo[] {
    return [...this.manifests.values()].map((manifest) => this.info(manifest)).sort((a, b) => a.name.localeCompare(b.name))
  }

  diagnostics(): PluginInfo[] {
    const installed = new Set(this.manifests.keys())
    const result = this.list().map((plugin) => {
      const manifest = this.manifests.get(plugin.id)!
      const missing = Object.keys(manifest.dependencies ?? {}).filter((dependency) => !installed.has(dependency))
      const dependents = [...this.manifests.values()].filter((candidate) => candidate.id !== plugin.id && dependencySatisfied(candidate.dependencies?.[plugin.id], plugin.version)).map((candidate) => candidate.id)
      return {
        ...plugin,
        dependencies: Object.keys(manifest.dependencies ?? {}),
        dependents,
        errors: missing.length ? [`dependências ausentes: ${missing.join(', ')}`] : plugin.errors
      }
    })
    for (const [directory, error] of this.errors) {
      if ([...this.manifests.values()].some((manifest) => manifest.id === directory)) continue
      result.push({
        id: directory,
        name: directory,
        version: '—',
        description: 'Manifesto inválido',
        apiVersion: String(API_MAJOR),
        installed: true,
        enabled: false,
        initialized: false,
        dependencies: [],
        dependents: [],
        tools: [],
        permissions: [],
        errors: [error]
      })
    }
    return result
  }

  async installDirectory(sourceDir: string): Promise<PluginInfo> {
    await this.init()
    const source = path.resolve(sourceDir)
    const manifest = await validatePluginDirectory(source)
    const target = path.join(this.root, manifest.id)
    const temp = path.join(this.root, `.install-${manifest.id}-${Date.now()}`)
    const backup = path.join(this.root, `.backup-${manifest.id}-${Date.now()}`)
    await fs.promises.cp(source, temp, { recursive: true, filter: (entry) => !/[\\/]node_modules[\\/]/.test(entry) })
    try {
      const data = path.join(target, 'data')
      if (fs.existsSync(data)) await fs.promises.cp(data, path.join(temp, 'data'), { recursive: true })
      const validated = await validatePluginDirectory(temp)
      if (validated.id !== manifest.id || validated.version !== manifest.version) throw new Error('manifesto mudou durante a instalação')
      if (fs.existsSync(target)) await fs.promises.rename(target, backup)
      await fs.promises.rename(temp, target)
      this.manifests.set(manifest.id, validated)
      this.errors.delete(manifest.id)
      await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => undefined)
      return this.info(validated)
    } catch (error) {
      await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined)
      if (fs.existsSync(backup) && !fs.existsSync(target)) await fs.promises.rename(backup, target).catch(() => undefined)
      throw error
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    await this.init()
    const manifest = this.manifests.get(id)
    if (!manifest) throw new Error(`plugin não encontrado: ${id}`)
    if (enabled) {
      await this.assertDependencies(id)
      this.enabled.add(id)
    } else {
      const dependents = [...this.manifests.values()].filter((candidate) => candidate.id !== id && this.enabled.has(candidate.id) && candidate.dependencies?.[id])
      if (dependents.length) throw new Error(`plugins dependentes ativos: ${dependents.map((candidate) => candidate.id).join(', ')}`)
      this.enabled.delete(id)
    }
    await this.saveState()
    return this.info(manifest)
  }

  async remove(id: string): Promise<boolean> {
    await this.init()
    const manifest = this.manifests.get(id)
    if (!manifest) return false
    if (this.enabled.has(id)) throw new Error('desative o plugin antes de removê-lo')
    const dependents = [...this.manifests.values()].filter((candidate) => candidate.id !== id && candidate.dependencies?.[id])
    if (dependents.length) throw new Error(`plugins dependentes instalados: ${dependents.map((candidate) => candidate.id).join(', ')}`)
    const directory = path.join(this.root, id)
    const data = path.join(directory, 'data')
    if (fs.existsSync(data)) {
      const preserved = path.join(this.root, '.data', `${id}-${Date.now()}`)
      await fs.promises.mkdir(path.dirname(preserved), { recursive: true })
      await fs.promises.cp(data, preserved, { recursive: true })
    }
    await fs.promises.rm(directory, { recursive: true, force: true })
    this.manifests.delete(id)
    return true
  }

  async rescan(): Promise<void> {
    this.manifests.clear()
    this.errors.clear()
    await this.scan()
  }

  toolDefs(): ToolDef[] {
    return [...this.manifests.values()].filter((manifest) => this.enabled.has(manifest.id)).flatMap((manifest) =>
      (manifest.contributions.tools ?? []).map((tool): ToolDef => ({
        name: qualifiedToolName(manifest.id, tool.key),
        description: `[Plugin ${manifest.name}] ${tool.description}`,
        schema: z.record(z.string(), z.unknown()),
        jsonSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
        risk: tool.risk ?? 'exec',
        parallelSafe: false,
        describe(args) {
          return { title: `${manifest.name}/${tool.name}`, detail: JSON.stringify(args ?? {}).slice(0, 500), preview: `${manifest.id}/${tool.key}` }
        },
        execute: async (args, ctx): Promise<ToolResult> => this.runTool(manifest.id, tool.key, args, ctx.signal)
      }))
    )
  }

  skillRoots(): string[] {
    return [...this.manifests.values()].filter((manifest) => this.enabled.has(manifest.id)).flatMap((manifest) =>
      (manifest.contributions.skills ?? []).flatMap((relative) => {
        const root = path.resolve(path.join(this.root, manifest.id), relative)
        return isInside(path.join(this.root, manifest.id), root) && fs.existsSync(root) ? [root] : []
      })
    )
  }

  async runTool(id: string, toolKey: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    await this.init()
    const manifest = this.manifests.get(id)
    if (!manifest || !this.enabled.has(id)) throw new Error(`plugin desativado ou ausente: ${id}`)
    const tool = manifest.contributions.tools?.find((candidate) => candidate.key === toolKey)
    if (!tool) throw new Error(`ferramenta não declarada: ${id}/${toolKey}`)
    const pluginDir = path.join(this.root, id)
    const main = path.resolve(pluginDir, manifest.main)
    if (!isInside(pluginDir, main) || !fs.existsSync(main)) throw new Error('ponto de entrada do plugin inválido')
    const request = JSON.stringify({ apiVersion: API_MAJOR, plugin: id, tool: toolKey, args, cwd: process.cwd() })
    return runNodePlugin(main, pluginDir, request, Math.max(1_000, Math.min(120_000, tool.timeoutMs ?? 20_000)), signal)
  }

  private async scan(): Promise<void> {
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const manifest = await validatePluginDirectory(path.join(this.root, entry.name))
        if (this.manifests.has(manifest.id)) throw new Error(`id duplicado: ${manifest.id}`)
        this.manifests.set(manifest.id, manifest)
      } catch (error) {
        this.errors.set(entry.name, (error as Error).message)
      }
    }
    for (const id of [...this.enabled]) {
      try { await this.assertDependencies(id) } catch (error) {
        this.enabled.delete(id)
        this.errors.set(id, (error as Error).message)
        await this.saveState()
      }
    }
  }

  private async assertDependencies(id: string, visiting = new Set<string>()): Promise<void> {
    const manifest = this.manifests.get(id)
    if (!manifest) throw new Error(`plugin não encontrado: ${id}`)
    if (visiting.has(id)) throw new Error(`ciclo de dependências: ${[...visiting, id].join(' → ')}`)
    visiting.add(id)
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      const target = this.manifests.get(dependency)
      if (!target) throw new Error(`dependência ausente: ${dependency}`)
      if (!dependencySatisfied(range, target.version)) throw new Error(`versão incompatível: ${dependency} ${range} (instalada ${target.version})`)
      await this.assertDependencies(dependency, new Set(visiting))
    }
    if (manifest.apiVersion.split('.')[0] !== String(API_MAJOR)) throw new Error(`API incompatível: ${manifest.apiVersion}`)
  }

  private info(manifest: PluginManifest): PluginInfo {
    const errors = this.errors.get(manifest.id) ? [this.errors.get(manifest.id)!] : []
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      apiVersion: manifest.apiVersion,
      installed: true,
      enabled: this.enabled.has(manifest.id),
      initialized: this.enabled.has(manifest.id) && errors.length === 0,
      dependencies: Object.keys(manifest.dependencies ?? {}),
      dependents: [],
      tools: (manifest.contributions.tools ?? []).map((tool): PluginToolInfo => ({ key: tool.key, name: tool.name, description: tool.description, risk: tool.risk ?? 'exec' })),
      permissions: manifest.permissions ?? [],
      errors
    }
  }

  private async saveState(): Promise<void> {
    const file = path.join(this.root, 'state.json')
    const temp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temp, JSON.stringify({ version: 1, enabled: [...this.enabled].sort() } satisfies PluginState, null, 2), 'utf8')
    await fs.promises.rename(temp, file)
  }
}

export async function validatePluginDirectory(directory: string): Promise<PluginManifest> {
  const root = path.resolve(directory)
  const manifestFile = path.join(root, 'plugin.json')
  const stat = await fs.promises.stat(manifestFile).catch(() => null)
  if (!stat?.isFile()) throw new Error('plugin.json não encontrado')
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('plugin.json maior que 512 KB')
  let parsed: unknown
  try { parsed = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8')) } catch { throw new Error('plugin.json inválido') }
  const manifest = validateManifest(parsed)
  const main = path.resolve(root, manifest.main)
  if (!isInside(root, main)) throw new Error('main não pode sair da pasta do plugin')
  if (!fs.existsSync(main)) throw new Error(`ponto de entrada não encontrado: ${manifest.main}`)
  for (const skill of manifest.contributions.skills ?? []) {
    const target = path.resolve(root, skill)
    if (!isInside(root, target) || !fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`pasta de skill inválida: ${skill}`)
  }
  return manifest
}

export function validateManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object') throw new Error('manifesto inválido')
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1) throw new Error('schemaVersion deve ser 1')
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error('id do plugin inválido')
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('name é obrigatório')
  if (typeof raw.version !== 'string' || !isSemver(raw.version)) throw new Error('version deve ser semver')
  if (typeof raw.description !== 'string' || !raw.description.trim()) throw new Error('description é obrigatória')
  if (typeof raw.apiVersion !== 'string' || raw.apiVersion.split('.')[0] !== String(API_MAJOR)) throw new Error(`apiVersion incompatível; use ${API_MAJOR}.x`)
  if (raw.runtime !== 'node') throw new Error('runtime suportado: node')
  if (typeof raw.main !== 'string' || !/\.(?:c?js|mjs)$/i.test(raw.main)) throw new Error('main deve ser um arquivo JavaScript')
  const contributions = raw.contributions && typeof raw.contributions === 'object' ? raw.contributions as Record<string, unknown> : {}
  const tools = Array.isArray(contributions.tools) ? contributions.tools : []
  const seen = new Set<string>()
  const normalizedTools = tools.slice(0, 50).map((entry, index): PluginToolContribution => {
    if (!entry || typeof entry !== 'object') throw new Error(`tools[${index}] inválida`)
    const tool = entry as Record<string, unknown>
    const key = typeof tool.key === 'string' ? tool.key : ''
    if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(key) || seen.has(key)) throw new Error(`chave de ferramenta inválida ou duplicada: ${key}`)
    seen.add(key)
    const risk = tool.risk === 'read' || tool.risk === 'write' || tool.risk === 'exec' || tool.risk === 'network' || tool.risk === 'destructive' ? tool.risk : 'exec'
    return {
      key,
      name: typeof tool.name === 'string' ? tool.name.slice(0, 120) : key,
      description: typeof tool.description === 'string' ? tool.description.slice(0, 2_000) : '',
      risk,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema as Record<string, unknown> : undefined,
      timeoutMs: Number.isFinite(tool.timeoutMs) ? Math.max(1_000, Math.min(120_000, Number(tool.timeoutMs))) : undefined
    }
  })
  const dependencies = raw.dependencies && typeof raw.dependencies === 'object' && !Array.isArray(raw.dependencies)
    ? Object.fromEntries(Object.entries(raw.dependencies as Record<string, unknown>).slice(0, 50).filter(([, range]) => typeof range === 'string') as Array<[string, string]>)
    : undefined
  return {
    schemaVersion: 1,
    id,
    name: raw.name.trim().slice(0, 120),
    version: raw.version,
    description: raw.description.trim().slice(0, 2_000),
    author: typeof raw.author === 'string' ? raw.author.slice(0, 200) : undefined,
    apiVersion: raw.apiVersion,
    runtime: 'node',
    main: raw.main.replace(/\\/g, '/'),
    dependencies,
    permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((item): item is string => typeof item === 'string').slice(0, 50) : [],
    contributions: {
      tools: normalizedTools,
      skills: Array.isArray(contributions.skills) ? contributions.skills.filter((item): item is string => typeof item === 'string').slice(0, 30) : [],
      commands: Array.isArray(contributions.commands) ? contributions.commands.slice(0, 30) as Array<{ name: string; description?: string }> : [],
      hooks: Array.isArray(contributions.hooks) ? contributions.hooks.filter((item): item is string => typeof item === 'string').slice(0, 30) : []
    }
  }
}

export function dependencySatisfied(range: string | undefined, version: string): boolean {
  if (!range) return true
  if (range === '*' || range === version) return true
  const match = /^(>=|>|<=|<|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim())
  if (!match || !isSemver(version)) return false
  const compare = compareSemver(version, `${match[2]}.${match[3]}.${match[4]}`)
  const operator = match[1] ?? '='
  return operator === '>=' ? compare >= 0 : operator === '>' ? compare > 0 : operator === '<=' ? compare <= 0 : operator === '<' ? compare < 0 : compare === 0
}

function isSemver(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) }
function compareSemver(a: string, b: string): number {
  const [ac, bc] = [a.split('-')[0].split('.').map(Number), b.split('-')[0].split('.').map(Number)]
  for (let index = 0; index < 3; index++) if (ac[index] !== bc[index]) return ac[index] - bc[index]
  return 0
}
function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function qualifiedToolName(plugin: string, tool: string): string {
  return `plugin__${plugin}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
}

function runNodePlugin(main: string, cwd: string, request: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('execução cancelada'))
    const child = spawn(process.execPath, [main], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // In Electron, execPath is electron.exe. This runs it as a plain Node
      // process instead of trying to launch a second desktop application.
      env: { ...sanitizedEnv(), ELECTRON_RUN_AS_NODE: '1' }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn() }
    const abort = (): void => {
      try { if (child.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill() } catch {}
      finish(() => reject(new Error('execução cancelada')))
    }
    const timer = setTimeout(() => abort(), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_TOOL_OUTPUT) abort()
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000) })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      if (code !== 0) return reject(new Error(`plugin terminou com código ${code}${stderr ? `: ${stderr.slice(-1_000)}` : ''}`))
      try {
        const response = JSON.parse(stdout.trim() || '{}') as ToolResult
        if (typeof response.ok !== 'boolean' || typeof response.text !== 'string') throw new Error('resposta sem ok/text')
        resolve({ ...response, text: response.text.slice(0, 100_000), summary: response.summary?.slice(0, 500) })
      } catch (error) {
        reject(new Error(`resposta inválida do plugin: ${(error as Error).message}`))
      }
    }))
    child.stdin.end(request)
  })
}
