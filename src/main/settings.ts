import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings, McpServerSettings, PolicyConfig, ProviderConfig, ReasoningEffort } from '../shared/types.js'
import { DEFAULT_LIMITS } from '../shared/types.js'
import { PROVIDER_PRESETS, presetToConfig } from '../core/providers/presets.js'
import { DEFAULT_RULES, mergeRules } from '../core/security/rules.js'
import { isDeepSeekV4Model } from '../shared/reasoning.js'
import {
  hasSecretRef,
  isMaskedSecret,
  isSecretName,
  looksLikeCredentialUrl,
  maskServerSecrets,
  resolveServerSecrets,
  secretRef,
  secretRefsIn,
  vaultKey,
  vaultKeyFor,
  vaultPrefixFor,
  type CredentialSource,
  type ResolvedServer
} from './mcp-secrets.js'

/** Current settings schema; bump with a migration in SettingsStore.init(). */
export const SETTINGS_VERSION = 8

/**
 * The user explicitly selected an unrestricted harness: local rules, command
 * blocklists and confirmation prompts are bypassed. Provider refusals and
 * operating-system permissions remain outside the harness.
 */
const DEFAULT_POLICY: PolicyConfig = {
  mode: 'unrestricted',
  blockedCommands: [],
  allowedRoots: [],
  // The user asked the agent to work on the whole computer, not only inside
  // the project folder. In `unrestricted` mode nothing asks: evaluateTool allows
  // every call first, so dangerous commands, secret files and the credential-location
  // guard do NOT apply (audit 2026-10-27). Pick `auto`/`ask` to get them back.
  fullAccess: true,
  allowNetwork: true,
  allowComputerControl: true,
  shellTimeoutSec: 300,
  rules: mergeRules(DEFAULT_RULES)
}

/** OS-backed string encryption (DPAPI via Electron safeStorage on Windows). */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

const electronCrypto: SecretCrypto = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (text) => safeStorage.encryptString(text),
  decryptString: (data) => safeStorage.decryptString(data)
}

/**
 * Reads the secrets file. Current format: encrypt(JSON {id: key}). Files
 * written by 0.1.0 hold encrypt(base64(JSON {id: base64(key)})) and are
 * converted on load.
 */
export function decodeSecretsFile(raw: Buffer, crypto: SecretCrypto): Record<string, string> {
  const plain = crypto.decryptString(raw)
  try {
    const parsed = JSON.parse(plain) as Record<string, string>
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* legacy format below */
  }
  const legacy = JSON.parse(Buffer.from(plain, 'base64').toString('utf8')) as Record<string, string>
  return Object.fromEntries(Object.entries(legacy).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]))
}

export function defaultSettings(): AppSettings {
  const providers: ProviderConfig[] = [
    'anthropic',
    'openai',
    'deepseek',
    'kimi',
    'qwen',
    'openrouter',
    'opencode-go',
    'opencode',
    'ollama',
    'lmstudio'
  ].map((key) => presetToConfig(key))
  return {
    providers,
    defaultProviderId: 'deepseek',
    policy: DEFAULT_POLICY,
    limits: { ...DEFAULT_LIMITS },
    theme: 'dark',
    profileName: '',
    telemetry: false,
    autoAgents: false,
    // "Never stop for lack of credit": when a model runs out of balance or hits a limit, the conversation moves to the
    // next provider that works (ordered in Settings → Provedores). Off only if the user turns it off.
    useAllModels: true,
    selfRepair: { enabled: false, repoPath: '', restartAfterRepair: true },
    environments: [
      { id: 'local', label: 'Local', kind: 'local' },
      { id: 'wsl', label: 'WSL', kind: 'wsl' }
    ],
    claudeCatalogImported: false,
    mcpServers: [],
    hooks: {},
    browser: { mode: 'auto', groupBySession: true },
    notifications: {
      desktop: true,
      turnFinished: true,
      failures: true,
      approvals: true,
      minimumSeverity: 'success',
      quietStart: '22:00',
      quietEnd: '07:00'
    },
    updates: { feedUrl: '', autoCheck: false },
    importClaudeSettings: false,
    settingsVersion: SETTINGS_VERSION
  }
}

export function providerPreset(key: string): ProviderConfig | null {
  try {
    return presetToConfig(key)
  } catch {
    return null
  }
}

/**
 * Provider keys are encrypted with the OS keychain (DPAPI on Windows) and never
 * cross the IPC boundary back to the renderer.
 */
export class SettingsStore {
  private settings: AppSettings
  private secrets: Record<string, string> = {}
  private readonly file: string
  private readonly secretsFile: string

  /** Changes applied by the last init() migration, for the startup log. */
  migrations: string[] = []

  constructor(
    private readonly dir: string,
    private readonly crypto: SecretCrypto = electronCrypto
  ) {
    this.file = path.join(dir, 'settings.json')
    this.secretsFile = path.join(dir, 'secrets.bin')
    this.settings = defaultSettings()
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true })
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.settings = {
        ...defaultSettings(),
        ...parsed,
        policy: { ...DEFAULT_POLICY, ...(parsed.policy ?? {}) },
        limits: { ...DEFAULT_LIMITS, ...(parsed.limits ?? {}) },
        providers: Array.isArray(parsed.providers) && parsed.providers.length ? parsed.providers : defaultSettings().providers
      }
      const savedProviderIds = new Set(this.settings.providers.map((provider) => provider.id))
      for (const key of ['opencode-go', 'opencode']) {
        if (!savedProviderIds.has(key)) this.settings.providers.push(presetToConfig(key))
      }
      const dropped = this.dropScriptedProvider()
      if ((parsed.settingsVersion ?? 1) < SETTINGS_VERSION) {
        this.migrate(parsed)
        await this.save()
      } else if (dropped) {
        await this.save()
      }
      if (dropped) this.migrations.push('provedor Scripted (autoteste) removido: o Openclod usa só modelos reais')
    } catch {
      this.settings = defaultSettings()
      await this.save()
    }

    try {
      const raw = await fs.promises.readFile(this.secretsFile)
      this.secrets = decodeSecretsFile(raw, this.crypto)
    } catch {
      this.secrets = {}
    }
    // A key in the OS vault is the source of truth. Older builds could save
    // the provider list with `env:...` after the key was stored, which left
    // the key orphaned and the provider marked as not configured.
    if (this.adoptStoredSecrets()) await this.save()
    // MCP credentials left in plain text by older builds move to the vault (with a backup of the file).
    await this.migrateMcpSecrets().catch((err) => {
      this.migrations.push(`segredos de MCP continuam no settings.json (migração adiada): ${(err as Error).message}`)
    })
  }

  /**
   * The scripted test provider is gone from the app (the product always talks to real models). Older settings
   * files still list it, sometimes as the default provider, so it is removed on load and the default falls back
   * to DeepSeek (or the first real provider). Returns whether anything changed.
   */
  private dropScriptedProvider(): boolean {
    const scripted = (provider: { id: string; kind: string }): boolean => provider.kind === 'mock' || provider.id === 'mock'
    const before = this.settings.providers.length
    this.settings.providers = this.settings.providers.filter((provider) => !scripted(provider))
    let changed = this.settings.providers.length !== before
    if (!this.settings.providers.some((provider) => provider.id === this.settings.defaultProviderId)) {
      this.settings.defaultProviderId = this.settings.providers.find((provider) => provider.id === 'deepseek')?.id ?? this.settings.providers[0]?.id ?? 'deepseek'
      changed = true
    }
    if (this.settings.lastModel && !this.settings.providers.some((provider) => provider.id === this.settings.lastModel?.providerId)) {
      delete this.settings.lastModel
      changed = true
    }
    return changed
  }

  /** Migrates the two former defaults to the explicitly requested unrestricted mode. */
  private migrate(parsed: Partial<AppSettings>): void {
    this.migrations = []
    const previousMode = parsed.policy?.mode ?? 'ask'
    if (previousMode === 'ask' || previousMode === 'auto') {
      this.settings.policy.mode = 'unrestricted'
      this.migrations.push('modo de permissão: legado → ultrarrrestrito (política local liberada pelo usuário)')
    }
    this.settings.policy.fullAccess = true
    this.settings.policy.allowNetwork = true
    this.settings.policy.allowComputerControl = true
    this.settings.policy.rules = mergeRules(DEFAULT_RULES, parsed.policy?.rules)
    // v3 -> v4: the old 3M per-turn cap killed long turns on 1M-context models.
    // 0 means automatic (max(6M, 10 × contextWindow)); manual values are kept.
    if (this.settings.limits.maxTokens === 3_000_000) {
      this.settings.limits.maxTokens = 0
      this.migrations.push('tokens por turno: 3M → automático (10× a janela do modelo)')
    }
    // v4 -> v5: dictation is click-first. The old default global shortcut is
    // removed; a custom shortcut chosen by the user is preserved.
    if (this.settings.voice?.shortcut?.replace(/\s+/g, '').toLowerCase() === 'control+alt+space') {
      this.settings.voice.shortcut = ''
      this.migrations.push(
        'atalho do microfone: Ctrl+Alt+Espaço removido por padrão; o microfone funciona pelo botão (Configurações → Voz)'
      )
    }
    // Fill the DeepSeek rates on configs created before cost tracking existed.
    for (const provider of this.settings.providers) {
      if (provider.id !== 'deepseek') continue
      let changed = false
      if (provider.inputCostPerMTok === undefined) {
        provider.inputCostPerMTok = 0.3
        changed = true
      }
      if (provider.outputCostPerMTok === undefined) {
        provider.outputCostPerMTok = 1.2
        changed = true
      }
      if (provider.cachedInputCostPerMTok === undefined) {
        provider.cachedInputCostPerMTok = 0.006
        changed = true
      }
      if (changed) this.migrations.push('custos do DeepSeek preenchidos (deepseek-flash, tarifa de pico)')
      break
    }
    // v5 -> v6: DeepSeek V4 exposes low/high/max thinking levels. Add them to
    // existing configs so the composer picker is not stuck on a single level.
    for (const provider of this.settings.providers) {
      if (provider.id !== 'deepseek' && !isDeepSeekV4Model(provider.model)) continue
      const supported: ReasoningEffort[] = ['low', 'high', 'max']
      const current = provider.effortLevels ?? []
      if (supported.every((level) => current.includes(level))) continue
      provider.effortLevels = [...supported, ...current.filter((level) => !supported.includes(level))]
      this.migrations.push('DeepSeek V4: níveis de esforço low/high/max disponíveis')
    }
    // v7 -> v8: the reserve between providers is on. Until now `useAllModels` only offered the other models of the SAME
    // provider (which fail the same way when the account has no balance) and defaulted to off, so files written by
    // earlier builds carry an explicit `false` that the user never chose.
    if ((parsed.settingsVersion ?? 1) < 8 && parsed.useAllModels === false) {
      this.settings.useAllModels = true
      this.migrations.push('reserva automática entre provedores ligada: se um LLM ficar sem saldo ou limite, a conversa passa para o próximo que funciona')
    }
    this.settings.settingsVersion = SETTINGS_VERSION
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    // MCP credentials never reach settings.json: new ones go to the vault, masked ones keep the stored value.
    if (Array.isArray(patch.mcpServers)) patch = { ...patch, mcpServers: await this.secureMcpPatch(patch.mcpServers) }
    this.settings = {
      ...this.settings,
      ...patch,
      policy: { ...this.settings.policy, ...(patch.policy ?? {}) },
      limits: { ...this.settings.limits, ...(patch.limits ?? {}) }
    }
    this.adoptStoredSecrets()
    await this.save()
    return this.get()
  }

  /**
   * Keeps every provider whose key is in the vault linked to that key. The
   * settings dialog may still hold an `env:` ref from before the key was
   * saved; writing that stale list must not orphan the stored secret.
   */
  private adoptStoredSecrets(): boolean {
    let changed = false
    for (const provider of this.settings.providers) {
      if (this.secrets[provider.id] && provider.apiKeyRef !== `secret:${provider.id}`) {
        provider.apiKeyRef = `secret:${provider.id}`
        changed = true
      }
    }
    return changed
  }

  /** Exposes the OS-backed cipher without exposing the secret map. */
  get secretCrypto(): SecretCrypto {
    return this.crypto
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    await fs.promises.rename(tmp, this.file)
  }

  /** Serialized: two writers (a connect and a save) must not race on the same temp file. */
  private vaultQueue: Promise<void> = Promise.resolve()

  private saveSecrets(): Promise<void> {
    const run = this.vaultQueue.then(() => this.writeSecrets())
    this.vaultQueue = run.catch(() => undefined)
    return run
  }

  private async writeSecrets(): Promise<void> {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error('armazenamento seguro indisponível neste sistema')
    }
    const encrypted = this.crypto.encryptString(JSON.stringify(this.secrets))
    const tmp = `${this.secretsFile}.tmp`
    await fs.promises.writeFile(tmp, encrypted)
    await fs.promises.rename(tmp, this.secretsFile)
  }

  async setSecret(providerId: string, value: string): Promise<void> {
    if (this.crypto.isEncryptionAvailable()) {
      this.secrets[providerId] = value.trim()
      await this.saveSecrets()
    } else {
      // Last resort: env var only. We refuse to write plaintext secrets to disk.
      throw new Error(
        'criptografia do sistema indisponível; defina a chave por variável de ambiente (ex.: ANTHROPIC_API_KEY)'
      )
    }
    const provider = this.settings.providers.find((p) => p.id === providerId)
    if (provider) {
      provider.apiKeyRef = `secret:${providerId}`
      await this.save()
    }
  }

  async clearSecret(providerId: string): Promise<void> {
    delete this.secrets[providerId]
    await this.saveSecrets().catch(() => undefined)
  }

  hasSecret(providerId: string): boolean {
    return Boolean(this.secrets[providerId])
  }

  /** Secrets live decrypted only in memory; the file on disk is the encrypted blob. */
  secretValue(providerId: string): string | undefined {
    return this.secrets[providerId] || undefined
  }

  /** Resolver handed to providers; never logged. */
  resolver(): { get(key: string): string | undefined } {
    return {
      get: (key: string) => {
        const direct = this.settings.providers.find((p) => p.id === key)
        if (direct) return this.secretValue(direct.id)
        return this.secretValue(key)
      }
    }
  }

  /* ----------------------------- MCP credentials ---------------------------- */

  /** What settings.json stores in place of a credential: `${secret:<servidor>.<NOME>}`. */
  mcpSecretRef(serverName: string, key: string): string {
    return secretRef(serverName, key)
  }

  /** Decrypted value of one MCP credential (in memory only; never log it). */
  mcpSecretValue(serverName: string, key: string): string | undefined {
    return this.secrets[vaultKeyFor(serverName, key)] || undefined
  }

  /** Whether the vault holds any credential of this server. */
  hasMcpSecrets(serverName: string): boolean {
    const prefix = vaultPrefixFor(serverName)
    return Object.keys(this.secrets).some((key) => key.startsWith(prefix))
  }

  /** Stores credentials of one server in the vault (one write) and returns the references to save in settings. */
  async setMcpSecrets(serverName: string, values: Record<string, string>): Promise<Record<string, string>> {
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error('criptografia do sistema indisponível; não é possível guardar credenciais com segurança')
    }
    const before = { ...this.secrets }
    const refs: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      const text = value.trim()
      if (!text) continue
      this.secrets[vaultKeyFor(serverName, key)] = text
      refs[key] = secretRef(serverName, key)
    }
    try {
      await this.saveSecrets()
    } catch (err) {
      this.secrets = before
      throw err
    }
    return refs
  }

  /** Removes one credential of a server from the vault (a no-op when it is not there). */
  async clearMcpSecret(serverName: string, key: string): Promise<void> {
    const vk = vaultKeyFor(serverName, key)
    if (!(vk in this.secrets)) return
    const before = { ...this.secrets }
    delete this.secrets[vk]
    try {
      await this.saveSecrets()
    } catch (err) {
      this.secrets = before
      throw err
    }
  }

  /** Removes every credential of one server from the vault. Returns how many entries were deleted. */
  async clearMcpSecrets(serverName: string): Promise<number> {
    const prefix = vaultPrefixFor(serverName)
    const keys = Object.keys(this.secrets).filter((key) => key.startsWith(prefix))
    if (!keys.length) return 0
    const before = { ...this.secrets }
    for (const key of keys) delete this.secrets[key]
    try {
      await this.saveSecrets()
    } catch (err) {
      this.secrets = before
      throw err
    }
    return keys.length
  }

  /** The server as the MCP client must run it (secrets filled in); missing references are reported, never sent. */
  resolveMcpServer(server: McpServerSettings): ResolvedServer {
    return resolveServerSecrets(server, (inner) => this.secrets[vaultKey(inner)] || undefined)
  }

  /** `mcpServers` for the JSON editor: every credential masked ("••••••" + last 2 characters). */
  maskedMcpServers(): McpServerSettings[] {
    const lookup = (inner: string): string | undefined => this.secrets[vaultKey(inner)] || undefined
    return (this.settings.mcpServers ?? []).map((server) => maskServerSecrets(structuredClone(server), lookup))
  }

  /** Resolved env/headers of a configured server, to lend its credentials to another one. */
  mcpCredentialSource(serverName: string): CredentialSource | undefined {
    const server = (this.settings.mcpServers ?? []).find((item) => item.name === serverName)
    if (!server) return undefined
    const resolved = this.resolveMcpServer(server).server
    return { env: resolved.env, headers: resolved.headers }
  }

  private serverRefs(server: McpServerSettings): string[] {
    const texts = [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {}), ...(server.args ?? [])]
    if (server.url) texts.push(server.url)
    return texts.flatMap((text) => secretRefsIn(String(text)))
  }

  /** Value behind a masked placeholder: the vault first, then the previous plain value, then a renamed twin. */
  private restoreMasked(
    server: McpServerSettings,
    section: 'env' | 'headers',
    key: string,
    previous: McpServerSettings[],
    names: Set<string>
  ): string | undefined {
    const stored = this.secrets[vaultKeyFor(server.name, key)]
    if (stored) return stored
    const valueOf = (candidate: McpServerSettings): string | undefined => {
      const vaulted = this.secrets[vaultKeyFor(candidate.name, key)]
      if (vaulted) return vaulted
      const raw = candidate[section]?.[key]
      if (typeof raw !== 'string' || !raw || isMaskedSecret(raw)) return undefined
      // Resolves just this entry; a dangling reference yields undefined.
      return this.resolveMcpServer({ ...candidate, [section]: { [key]: raw } }).server[section]?.[key]
    }
    const same = previous.find((candidate) => candidate.name === server.name)
    if (same) return valueOf(same)
    // The server was renamed in the editor: its twin (same transport and target) lends the value.
    const signature = (item: McpServerSettings): string => [item.type ?? '', item.url ?? '', item.command, (item.args ?? []).join(' ')].join('|')
    const twins = previous.filter((candidate) => !names.has(candidate.name) && signature(candidate) === signature(server))
    return twins.length === 1 ? valueOf(twins[0]) : undefined
  }

  /**
   * Moves credentials out of the servers: env/header values with a secret-looking name (or a masked placeholder
   * being saved back) become `${secret:servidor.NOME}` references and their values go to `pending` (the vault).
   * A secret that was also written into args/url is replaced there too. Pure with respect to disk.
   */
  private secureServers(
    servers: McpServerSettings[],
    previous: McpServerSettings[],
    options: { restoreMasked: boolean; canVault: boolean }
  ): { servers: McpServerSettings[]; pending: Record<string, string>; moved: Array<{ server: string; key: string }>; changed: boolean } {
    const pending: Record<string, string> = {}
    const moved: Array<{ server: string; key: string }> = []
    const names = new Set(servers.map((server) => server.name))
    let changed = false
    const out = servers.map((server) => {
      const next: McpServerSettings = { ...server }
      const literals: Array<[string, string]> = []
      for (const section of ['env', 'headers'] as const) {
        const record = server[section]
        if (!record) continue
        const copy: Record<string, string> = {}
        for (const [key, raw] of Object.entries(record)) {
          let value = typeof raw === 'string' ? raw : String(raw)
          let wasMasked = false
          if (hasSecretRef(value)) {
            copy[key] = value
            continue
          }
          if (options.restoreMasked && isMaskedSecret(value)) {
            changed = true
            const restored = this.restoreMasked(server, section, key, previous, names)
            // Nothing to restore (renamed server, vault lost): the placeholder is dropped, never saved as a "secret".
            if (restored === undefined) continue
            value = restored
            wasMasked = true
          }
          if (options.canVault && value.trim() && (wasMasked || isSecretName(key) || looksLikeCredentialUrl(value))) {
            const vk = vaultKeyFor(server.name, key)
            if (this.secrets[vk] !== value) pending[vk] = value
            copy[key] = secretRef(server.name, key)
            literals.push([value, copy[key]])
            moved.push({ server: server.name, key })
            changed = true
          } else {
            copy[key] = value
          }
        }
        next[section] = copy
      }
      if (literals.length) {
        const swap = (text: string): string =>
          literals.reduce((acc, [value, ref]) => (value.length >= 8 && acc.includes(value) ? acc.split(value).join(ref) : acc), text)
        const args = (server.args ?? []).map(swap)
        if (args.some((arg, index) => arg !== server.args[index])) next.args = args
        if (server.url) next.url = swap(server.url)
      }
      return next
    })
    return { servers: out, pending, moved, changed }
  }

  /** `update({ mcpServers })`: secure the list, write the vault first, forget the secrets of removed servers. */
  private async secureMcpPatch(servers: McpServerSettings[]): Promise<McpServerSettings[]> {
    const previous = this.settings.mcpServers ?? []
    const result = this.secureServers(servers, previous, { restoreMasked: true, canVault: this.crypto.isEncryptionAvailable() })
    const kept = new Set(result.servers.flatMap((server) => this.serverRefs(server)).map(vaultKey))
    const stale = previous.flatMap((server) => this.serverRefs(server)).map(vaultKey).filter((key) => !kept.has(key) && key in this.secrets)
    // Entries no reference points to (a connector's OAuth client id/secret) go away with the server that owned them.
    const names = new Set(result.servers.map((server) => server.name))
    for (const server of previous) {
      if (names.has(server.name)) continue
      const prefix = vaultPrefixFor(server.name)
      for (const key of Object.keys(this.secrets)) if (key.startsWith(prefix) && !stale.includes(key)) stale.push(key)
    }
    if (Object.keys(result.pending).length || stale.length) {
      const before = { ...this.secrets }
      Object.assign(this.secrets, result.pending)
      for (const key of stale) delete this.secrets[key]
      try {
        await this.saveSecrets()
      } catch (err) {
        this.secrets = before
        throw err
      }
    }
    return result.servers
  }

  /** One-time move of plain-text MCP credentials into the vault, after a backup of settings.json. Idempotent. */
  private async migrateMcpSecrets(): Promise<void> {
    const servers = this.settings.mcpServers ?? []
    if (!servers.length || !this.crypto.isEncryptionAvailable()) return
    const result = this.secureServers(servers, servers, { restoreMasked: false, canVault: true })
    if (!result.changed) return
    // Order matters: backup of the file, then the vault, and only then the file without the values.
    const backup = await this.backupSettingsFile()
    const before = { ...this.secrets }
    Object.assign(this.secrets, result.pending)
    try {
      await this.saveSecrets()
    } catch (err) {
      this.secrets = before
      throw err
    }
    this.settings.mcpServers = result.servers
    await this.save()
    const names = [...new Set(result.moved.map((entry) => entry.server))]
    this.migrations.push(
      `${result.moved.length} segredo(s) de MCP movido(s) para o cofre do sistema (${names.join(', ')}); cópia anterior do arquivo: ${path.basename(backup)}`
    )
  }

  /** `settings.json.bak-<yyyy-mm-dd>`; never overwrites an older backup. */
  private async backupSettingsFile(): Promise<string> {
    const stamp = new Date().toISOString()
    const day = stamp.slice(0, 10)
    const clock = stamp.slice(11, 19).replace(/:/g, '')
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = attempt === 0 ? day : `${day}-${clock}${attempt > 1 ? `-${attempt}` : ''}`
      const target = `${this.file}.bak-${suffix}`
      try {
        await fs.promises.copyFile(this.file, target, fs.constants.COPYFILE_EXCL)
        await fs.promises.chmod(target, 0o600).catch(() => undefined)
        return target
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new Error('não foi possível criar o backup do settings.json')
  }

  providerConfig(id: string): ProviderConfig | undefined {
    return this.settings.providers.find((p) => p.id === id)
  }

  presetCatalog(): Record<string, unknown> {
    return PROVIDER_PRESETS
  }
}
