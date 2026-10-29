import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, ProviderConfig } from '../../shared/types.js'
import {
  LLAMACPP_PROVIDER_ID,
  LLAMACPP_PROVIDER_LABEL,
  type LlamaCppBuildInfo,
  type LlamaCppLogInfo,
  type LlamaCppProfile,
  type LlamaCppStatusInfo,
  type LlamaLocalModel,
  type LlamaModelInfo,
  type LlamaOptionsInfo
} from '../../shared/llamacpp.js'
import { BUNDLED_TAG } from '../../core/llamacpp/builds.js'
import { DEFAULT_CTX, DEFAULT_PARALLEL, modelAlias, serverArgs, serverEnv } from '../../core/llamacpp/args.js'
import { blockedFlags, commandLine, optionArgs, optionGroups, parseHelp, type ServerOption } from '../../core/llamacpp/options.js'
import { GgufError, readGgufFile, summarize } from '../../core/llamacpp/gguf.js'
import { discoverModels, localAlias } from '../../core/llamacpp/local-models.js'
import type { ProviderHealth } from '../../core/providers/health.js'
import { resourcePath } from '../../core/util/resources.js'
import { LlamaBuilds } from './builds.js'
import { cleanEnv } from './download.js'
import { LlamaHub } from './hub.js'
import { LlamaServer, freePort, stopStaleServer, type ServerSnapshot } from './server.js'

/** The slice of SettingsStore this service uses (the same one the Colab service uses). */
export interface LlamaCppSettings {
  get(): AppSettings
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  setSecret(providerId: string, value: string): Promise<void>
  resolver(): { get(key: string): string | undefined }
}

export interface LlamaCppServiceDeps {
  settings: LlamaCppSettings
  health: ProviderHealth
  /** `<userData>`: the profile in config/llamacpp.json, the pid file in llamacpp/. */
  userData: string
  emitChanged(): void
  log?(message: string): void
  /** Tests hand in a server with fake processes and a fake bundled build. */
  server?: LlamaServer
  bundledDir?(): string | null
  env?(): Record<string, string | undefined>
  /** The user's home, where Ollama, LM Studio and the Hugging Face cache keep models. */
  home?: string
  /** Tests hand in the help text instead of running the build's `--help`. */
  help?(exe: string): Promise<string>
}

/** What the profile file keeps: named profiles plus the settings every profile shares. */
interface StoredConfig {
  version: 2
  active: string
  profiles: Record<string, StoredProfile>
  autostart: boolean
  folders: string[]
  /** The build that runs ("b11972-vulkan" is the bundled one). */
  build?: string
}

type StoredProfile = Omit<LlamaCppProfile, 'autostart' | 'folders'>

export const FIRST_PROFILE = 'Padrão'
const PROFILE_NAME = /^[\p{L}\p{N} ._()+-]{1,40}$/u

function storedProfile(raw: Partial<LlamaCppProfile> | undefined): StoredProfile {
  const source = raw && typeof raw === 'object' ? raw : {}
  const profile: StoredProfile = {
    ctxSize: clampInt(source.ctxSize, 512, 1 << 21, DEFAULT_CTX),
    parallel: clampInt(source.parallel, 1, 64, DEFAULT_PARALLEL),
    values: source.values && typeof source.values === 'object' ? { ...source.values } : {},
    extraArgs: Array.isArray(source.extraArgs) ? source.extraArgs.map(String) : []
  }
  for (const key of ['model', 'mmproj', 'alias', 'label'] as const) if (typeof source[key] === 'string' && source[key]) profile[key] = source[key]
  return profile
}

/** A GGUF's name, quantization and what its template supports, read from its header; plus a projector next to it. */
export function inspectModel(file: string): LlamaModelInfo {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error(`Não achei o modelo: ${file}`)
  }
  if (!stat.isFile()) throw new Error(`Não é um arquivo: ${file}`)
  let summary
  try {
    summary = summarize(readGgufFile(file))
  } catch (err) {
    throw new Error(err instanceof GgufError ? `${path.basename(file)} não é um modelo GGUF válido (${err.message}).` : (err as Error).message)
  }
  if (summary.mmproj) throw new Error(`${path.basename(file)} é um projetor de visão (mmproj), não um modelo de conversa.`)
  if (summary.split > 1) throw new Error(`${path.basename(file)} é uma parte de um modelo dividido: escolha a primeira parte (-00001-of-…).`)
  const base = path.basename(file).replace(/\.gguf$/i, '')
  // Converters often write a placeholder name; an Ollama blob's file name is only its hash.
  const named = summary.name && summary.name !== 'Source' ? summary.name : ''
  return {
    path: file,
    name: named || (isBlobName(base) ? [summary.arch, summary.sizeLabel].filter(Boolean).join(' ') || base : base),
    arch: summary.arch,
    sizeLabel: summary.sizeLabel,
    quant: summary.quant,
    context: summary.context,
    layers: summary.layers,
    tools: summary.tools,
    thinking: summary.thinking,
    bytes: stat.size,
    mmproj: projectorNextTo(file)
  }
}

/** Ollama keeps models as content-addressed blobs: "sha256-<hash>", no name, no extension. */
function isBlobName(base: string): boolean {
  return /^sha256-[0-9a-f]{20,}$/i.test(base)
}

/** The model name the API and the model picker show: the file name, or — for a nameless blob — what the header says. */
export function aliasFor(model: Pick<LlamaModelInfo, 'path' | 'name'>): string {
  const base = path.basename(model.path)
  return localAlias(isBlobName(base) ? model.name : base)
}

/** A vision projector in the same folder (the Hugging Face layout: model-Q4_K_M.gguf + mmproj-…-f16.gguf). */
function projectorNextTo(file: string): string | undefined {
  let names: string[] = []
  try {
    names = fs.readdirSync(path.dirname(file))
  } catch {
    return undefined
  }
  for (const name of names.filter((item) => /mmproj/i.test(item) && /\.gguf$/i.test(item)).sort()) {
    const candidate = path.join(path.dirname(file), name)
    try {
      if (summarize(readGgufFile(candidate, { template: false })).mmproj) return candidate
    } catch {
      /* not a projector after all */
    }
  }
  return undefined
}

/**
 * Configurações → Provedores → llama.cpp: runs llama.cpp's own server on this computer (no Ollama to install or keep
 * running) and turns it into the `llamacpp` provider while it is up, the way the Colab service does for the notebook.
 */
export class LlamaCppService {
  private readonly server: LlamaServer
  /** Baixar: the Hugging Face models that fit this computer, and their downloads. */
  readonly hub: LlamaHub
  /** Versões: the bundled build and the ones downloaded from GitHub. */
  readonly builds: LlamaBuilds
  private config: StoredConfig
  /** The active profile with the shared settings: what the screens edit and the next start uses. */
  private profile: LlamaCppProfile
  /** Options of each build, read from its --help once. */
  private helps = new Map<string, ServerOption[]>()
  /** The provider being written after the server answered (ensureReady waits for it). */
  private registering: Promise<void> = Promise.resolve()
  private model?: LlamaModelInfo
  /** Model name of the running server (the profile alias, or one derived from the model). */
  private alias = ''
  /** The last search for models on this computer, by path: picking one of them brings its name and projector. */
  private found = new Map<string, LlamaLocalModel>()

  constructor(private readonly deps: LlamaCppServiceDeps) {
    this.config = this.readConfig()
    this.profile = this.merged()
    this.builds = new LlamaBuilds({
      userData: deps.userData,
      bundledDir: () => (this.deps.bundledDir ? this.deps.bundledDir() : resourcePath('llamacpp', `${BUNDLED_TAG}-vulkan`)),
      log: deps.log
    })
    const pidFile = path.join(deps.userData, 'llamacpp', 'server.pid')
    // An app that crashed left its server on the GPU: stop it before anything starts a new one.
    if (stopStaleServer(pidFile)) deps.log?.('llama.cpp: encerrei um llama-server que ficou rodando de uma sessão anterior do app')
    this.server =
      deps.server ??
      new LlamaServer({
        pidFile,
        onReady: (snapshot) => {
          this.registering = this.ready(snapshot)
        },
        onExit: () => this.deps.emitChanged()
      })
    this.hub = new LlamaHub({
      userData: deps.userData,
      exe: () => this.build()?.exe ?? null,
      ctx: () => this.profile.ctxSize,
      modelsDir: () => this.modelsDir(),
      // A finished download is the next run's model, with its projector and its name.
      onDownloaded: async ({ model, mmproj, label, alias }) => void (await this.setProfile({ model, mmproj, label, alias })),
      log: deps.log
    })
    if (this.profile.model) {
      try {
        this.model = this.read(this.profile.model)
      } catch {
        this.model = undefined
      }
    }
  }

  /** The model's header, under the name it was chosen by ("qwen3.5:4b" for an Ollama model). */
  private read(file: string, label = this.profile.label): LlamaModelInfo {
    const model = inspectModel(file)
    return label ? { ...model, name: label } : model
  }

  /** Where the models Openclod downloads go. */
  modelsDir(): string {
    return path.join(this.deps.userData, 'llamacpp', 'models')
  }

  /** The GGUFs on this computer: Ollama's, LM Studio's, the Hugging Face cache, the downloads and the added folders. */
  async models(): Promise<LlamaLocalModel[]> {
    const env = this.deps.env ? this.deps.env() : process.env
    const list = await discoverModels({ home: this.deps.home ?? os.homedir(), env, downloaded: this.modelsDir(), folders: this.profile.folders })
    this.found = new Map(list.map((model) => [model.path, model]))
    return list
  }

  private profileFile(): string {
    return path.join(this.deps.userData, 'config', 'llamacpp.json')
  }

  /** Reads `config/llamacpp.json`; the first version (one profile, no names) becomes the profile "Padrão". */
  private readConfig(): StoredConfig {
    let saved: Record<string, unknown> = {}
    try {
      saved = JSON.parse(fs.readFileSync(this.profileFile(), 'utf8')) as Record<string, unknown>
    } catch {
      /* first run */
    }
    const folders = Array.isArray(saved.folders) ? saved.folders.map(String) : []
    const autostart = saved.autostart === true
    const build = typeof saved.build === 'string' ? saved.build : undefined
    if (saved.version === 2 && saved.profiles && typeof saved.profiles === 'object') {
      const profiles: Record<string, StoredProfile> = {}
      for (const [name, raw] of Object.entries(saved.profiles as Record<string, Partial<LlamaCppProfile>>)) {
        if (PROFILE_NAME.test(name)) profiles[name] = storedProfile(raw)
      }
      if (!Object.keys(profiles).length) profiles[FIRST_PROFILE] = storedProfile(undefined)
      const active = typeof saved.active === 'string' && profiles[saved.active] ? saved.active : Object.keys(profiles)[0]
      return { version: 2, active, profiles, autostart, folders, ...(build ? { build } : {}) }
    }
    return { version: 2, active: FIRST_PROFILE, profiles: { [FIRST_PROFILE]: storedProfile(saved as Partial<LlamaCppProfile>) }, autostart, folders }
  }

  private merged(): LlamaCppProfile {
    const stored = this.config.profiles[this.config.active]
    return { ...stored, values: { ...stored.values }, extraArgs: [...stored.extraArgs], autostart: this.config.autostart, folders: [...this.config.folders] }
  }

  private saveProfile(): void {
    const { autostart, folders, ...stored } = this.profile
    this.config = { ...this.config, autostart, folders, profiles: { ...this.config.profiles, [this.config.active]: storedProfile(stored) } }
    fs.mkdirSync(path.dirname(this.profileFile()), { recursive: true })
    fs.writeFileSync(this.profileFile(), `${JSON.stringify(this.config, null, 2)}\n`)
  }

  /** Perfis: switch to, create (a copy of the current one), rename or delete a named set of model and options. */
  async profileAction(action: { kind: 'select' | 'create' | 'rename' | 'delete'; name: string; to?: string }): Promise<LlamaCppStatusInfo> {
    const name = action.name.trim()
    const names = Object.keys(this.config.profiles)
    if (action.kind === 'create' || action.kind === 'rename') {
      const target = (action.kind === 'create' ? name : (action.to ?? '')).trim()
      if (!PROFILE_NAME.test(target)) throw new Error('Nome de perfil inválido: até 40 letras, números, espaço e . _ ( ) + -.')
      if (names.includes(target)) throw new Error(`Já existe um perfil "${target}".`)
      if (action.kind === 'create') {
        this.saveProfile()
        this.config = { ...this.config, active: target, profiles: { ...this.config.profiles, [target]: storedProfile(this.config.profiles[this.config.active]) } }
      } else {
        if (!this.config.profiles[name]) throw new Error(`Não existe o perfil "${name}".`)
        const profiles = Object.fromEntries(Object.entries(this.config.profiles).map(([key, value]) => [key === name ? target : key, value]))
        this.config = { ...this.config, profiles, active: this.config.active === name ? target : this.config.active }
      }
    } else if (action.kind === 'select') {
      if (!this.config.profiles[name]) throw new Error(`Não existe o perfil "${name}".`)
      this.saveProfile()
      this.config = { ...this.config, active: name }
    } else {
      if (!this.config.profiles[name]) throw new Error(`Não existe o perfil "${name}".`)
      if (names.length < 2) throw new Error('Este é o único perfil: crie outro antes de apagar este.')
      const { [name]: _gone, ...profiles } = this.config.profiles
      this.config = { ...this.config, profiles, active: this.config.active === name ? Object.keys(profiles)[0] : this.config.active }
    }
    this.profile = this.merged()
    try {
      this.model = this.profile.model ? this.read(this.profile.model) : undefined
    } catch {
      this.model = undefined
    }
    this.saveProfile()
    this.deps.emitChanged()
    return this.status()
  }

  /** Chooses the build the next start runs. */
  async selectBuild(id: string): Promise<LlamaCppStatusInfo> {
    const build = this.builds.list().find((item) => item.id === id)
    if (!build) throw new Error('Versão não encontrada.')
    this.config = { ...this.config, build: build.id }
    this.saveProfile()
    this.deps.emitChanged()
    return this.status()
  }

  async removeBuild(id: string): Promise<LlamaCppStatusInfo> {
    if (this.server.running && this.build()?.id === id) throw new Error('Esta versão está rodando: pare o servidor antes de removê-la.')
    this.builds.remove(id)
    if (this.config.build === id) this.config = { ...this.config, build: undefined }
    this.saveProfile()
    this.deps.emitChanged()
    return this.status()
  }

  /** The options of a build, from its own `llama-server --help` (read once). Empty when the help could not be read. */
  private async serverOptions(build: LlamaCppBuildInfo): Promise<ServerOption[]> {
    const cached = this.helps.get(build.exe)
    if (cached) return cached
    const text = this.deps.help
      ? await this.deps.help(build.exe)
      : await new Promise<string>((resolve) =>
          execFile(build.exe, ['--help'], { cwd: path.dirname(build.exe), windowsHide: true, timeout: 20_000, maxBuffer: 4 << 20, env: cleanEnv() }, (_err, stdout, stderr) =>
            resolve(`${stdout ?? ''}\n${stderr ?? ''}`)
          )
        )
    const options = parseHelp(text)
    if (options.length > 20) this.helps.set(build.exe, options)
    return options
  }

  /** Opções do servidor: every option of the running build, grouped, and the command line of the next start. */
  async options(): Promise<LlamaOptionsInfo> {
    const build = this.build()
    if (!build) throw new Error(this.status().reason)
    const options = await this.serverOptions(build)
    const groups = optionGroups(options).map((group) => ({
      id: group.id,
      name: group.name,
      fields: group.fields.map(({ section: _section, on: _on, off: _off, group: _group, ...field }) => field)
    }))
    let line = ''
    let error: string | undefined
    try {
      const model = this.profile.model ?? '<modelo.gguf>'
      const alias = this.profile.alias?.trim() || (this.model ? aliasFor(this.model) : modelAlias({ model }))
      const args = serverArgs(
        { ...this.profile, model, mmproj: this.profile.mmproj ?? this.model?.mmproj, alias },
        { port: 0, optionArgs: options.length ? optionArgs(this.profile.values, options) : undefined, blocked: blockedFlags(options) }
      )
      const port = args.indexOf('--port')
      if (port >= 0) args[port + 1] = '<porta livre>'
      line = commandLine(build.exe, args)
    } catch (err) {
      error = (err as Error).message
    }
    return { build: build.label, groups, commandLine: line, ...(error ? { error } : {}) }
  }

  /** The build that runs: the one chosen in Versões, else the Vulkan one shipped with the app. */
  build(): LlamaCppBuildInfo | null {
    return this.builds.find(this.config.build) ?? null
  }

  status(): LlamaCppStatusInfo {
    const build = this.build()
    const snap = this.server.status()
    return {
      available: Boolean(build),
      ...(build
        ? { build }
        : { reason: 'O llama-server não está nesta instalação. Em desenvolvimento, rode node scripts/embed-llamacpp.mjs.' }),
      state: snap.state,
      ...(snap.error ? { error: snap.error } : {}),
      ...(snap.hint ? { hint: snap.hint } : {}),
      ...(snap.port ? { port: snap.port } : {}),
      ...(snap.pid ? { pid: snap.pid } : {}),
      ...(snap.startedAt ? { startedAt: snap.startedAt } : {}),
      ...(snap.readyAt ? { readyAt: snap.readyAt } : {}),
      speed: snap.speed,
      offload: snap.offload,
      ...(snap.device ? { device: snap.device } : {}),
      ...(snap.deviceMiB ? { deviceMiB: snap.deviceMiB } : {}),
      ...(snap.nCtx ? { nCtx: snap.nCtx } : {}),
      ...(snap.slots ? { slots: snap.slots } : {}),
      vision: snap.vision,
      ...(snap.build ? { serverBuild: snap.build } : {}),
      ...(this.model ? { model: this.model } : {}),
      profile: { ...this.profile, folders: [...this.profile.folders], values: { ...this.profile.values }, extraArgs: [...this.profile.extraArgs] },
      profiles: Object.keys(this.config.profiles),
      activeProfile: this.config.active,
      builds: this.builds.list(),
      providerId: LLAMACPP_PROVIDER_ID
    }
  }

  log(since = 0): LlamaCppLogInfo {
    return this.server.log(since)
  }

  inspect(file: string): LlamaModelInfo {
    return inspectModel(file)
  }

  /** Saves the options of the next run. A new model is read right away, so a wrong file is refused here, not at start. */
  async setProfile(patch: Partial<LlamaCppProfile>): Promise<LlamaCppStatusInfo> {
    const next: LlamaCppProfile = { ...this.profile, ...patch }
    if (patch.model !== undefined && patch.model !== this.profile.model) {
      // A new model brings its own name, API name and projector unless they came with it: from the search when it was
      // found there (an Ollama blob has its projector in the manifest), else from the file.
      const listed = patch.model ? this.found.get(patch.model) : undefined
      if (patch.label === undefined) next.label = listed?.name
      if (patch.alias === undefined) next.alias = listed?.alias
      if (patch.model) {
        const model = this.read(patch.model, next.label)
        this.model = model
        if (patch.mmproj === undefined) next.mmproj = listed?.mmproj ?? model.mmproj
      } else {
        this.model = undefined
        next.mmproj = undefined
      }
    }
    next.folders = [...new Set(next.folders.map((folder) => folder.trim()).filter(Boolean))].slice(0, 20)
    if (patch.values) {
      const build = this.build()
      const options = build ? await this.serverOptions(build) : []
      // A wrong value is refused here, with the reason, not when the server fails to start.
      if (options.length) optionArgs(next.values, options)
    }
    next.ctxSize = clampInt(next.ctxSize, 512, 1 << 21, DEFAULT_CTX)
    next.parallel = clampInt(next.parallel, 1, 64, DEFAULT_PARALLEL)
    next.autostart = Boolean(next.autostart)
    this.profile = next
    this.saveProfile()
    this.deps.emitChanged()
    return this.status()
  }

  /** The key the provider authenticates with. One per installation, in the OS vault, so a session opened before a restart keeps working. */
  private async apiKey(): Promise<string> {
    const saved = this.deps.settings.resolver().get(LLAMACPP_PROVIDER_ID)
    if (saved) return saved
    const key = crypto.randomBytes(24).toString('base64url')
    await this.deps.settings.setSecret(LLAMACPP_PROVIDER_ID, key)
    return key
  }

  async start(): Promise<LlamaCppStatusInfo> {
    const build = this.build()
    if (!build) throw new Error(this.status().reason)
    if (!this.profile.model) throw new Error('Escolha um modelo .gguf antes de iniciar.')
    this.model = this.read(this.profile.model)
    if (this.server.running) await this.server.stop()
    const port = await freePort()
    const apiKey = await this.apiKey()
    this.alias = this.profile.alias?.trim() || aliasFor(this.model)
    const profile = { ...this.profile, model: this.model.path, mmproj: this.profile.mmproj ?? this.model.mmproj, alias: this.alias }
    const options = await this.serverOptions(build)
    const args = serverArgs(profile, {
      port,
      ...(options.length ? { optionArgs: optionArgs(this.profile.values, options), blocked: blockedFlags(options) } : {})
    })
    const env = serverEnv(this.deps.env ? this.deps.env() : process.env, { apiKey })
    this.server.start({ exe: build.exe, args, port, apiKey, env })
    this.deps.log?.(`llama.cpp: iniciando ${this.model.name} (${build.label}) na porta ${port}`)
    this.deps.emitChanged()
    return this.status()
  }

  async stop(): Promise<LlamaCppStatusInfo> {
    await this.server.stop()
    this.deps.emitChanged()
    return this.status()
  }

  /** When the server answers, it becomes the `llamacpp` provider: the model picker shows it without restarting. */
  private async ready(snapshot: ServerSnapshot): Promise<void> {
    const alias = this.alias || modelAlias(this.profile)
    const config: ProviderConfig = {
      id: LLAMACPP_PROVIDER_ID,
      kind: 'openai',
      label: LLAMACPP_PROVIDER_LABEL,
      baseUrl: `http://127.0.0.1:${snapshot.port}/v1`,
      model: alias,
      apiKeyRef: `secret:${LLAMACPP_PROVIDER_ID}`,
      // n_ctx from /props is per slot: what one request gets.
      contextWindow: snapshot.nCtx ?? this.profile.ctxSize,
      supportsVision: snapshot.vision,
      supportsTools: this.model?.tools ?? true,
      models: [alias],
      visionModels: snapshot.vision ? [alias] : undefined
    }
    try {
      const current = this.deps.settings.get().providers
      const providers = current.some((provider) => provider.id === LLAMACPP_PROVIDER_ID)
        ? current.map((provider) => (provider.id === LLAMACPP_PROVIDER_ID ? config : provider))
        : [...current, config]
      await this.deps.settings.update({ providers })
      this.deps.health.clear(LLAMACPP_PROVIDER_ID)
      this.deps.log?.(`llama.cpp pronto: ${alias} na porta ${snapshot.port} (contexto ${config.contextWindow}${snapshot.vision ? ', visão' : ''})`)
    } catch (err) {
      this.deps.log?.(`llama.cpp: não consegui registrar o provedor: ${(err as Error).message}`)
    }
    this.deps.emitChanged()
  }

  /**
   * A session on llama.cpp (local) while the server is stopped: starts it with the saved model and waits until it
   * answers, then returns the provider as it is now (the port changes on every start). When it cannot start, the
   * provider goes back unchanged: the request fails and the reserve moves the conversation on, as for any local server.
   */
  async ensureReady(config: ProviderConfig, timeoutMs = 10 * 60_000): Promise<ProviderConfig> {
    try {
      const state = this.server.status().state
      if (state === 'parado' || state === 'erro') {
        if (!this.profile.model || !this.build()) return config
        this.deps.log?.('llama.cpp: uma conversa pediu o modelo local; iniciando o servidor')
        await this.start()
      }
      const until = Date.now() + timeoutMs
      for (;;) {
        const now = this.server.status()
        if (now.state === 'pronto') break
        if (now.state !== 'iniciando') throw new Error(now.error || 'o servidor fechou')
        if (Date.now() > until) throw new Error('o modelo demorou demais para carregar')
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      await this.registering
      return this.deps.settings.get().providers.find((provider) => provider.id === LLAMACPP_PROVIDER_ID) ?? config
    } catch (err) {
      this.deps.log?.(`llama.cpp: não iniciou para a conversa: ${(err as Error).message}`)
      return config
    }
  }

  /** "Iniciar com o Openclod": starts the saved model when the app opens. */
  async autostart(): Promise<void> {
    if (!this.profile.autostart || !this.profile.model || !this.build()) return
    try {
      await this.start()
    } catch (err) {
      this.deps.log?.(`llama.cpp: não iniciou sozinho: ${(err as Error).message}`)
    }
  }

  /** The app is closing: the server goes with it. */
  async dispose(): Promise<void> {
    await this.server.stop(5_000)
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}
