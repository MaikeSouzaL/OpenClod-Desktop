import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings, PolicyConfig, ProviderConfig } from '../shared/types.js'
import { DEFAULT_LIMITS } from '../shared/types.js'
import { PROVIDER_PRESETS, presetToConfig } from '../core/providers/presets.js'
import { DEFAULT_RULES, mergeRules } from '../core/security/rules.js'

/** Current settings schema; bump with a migration in SettingsStore.init(). */
export const SETTINGS_VERSION = 2

/**
 * Autonomous by default, as the project brief asks: edits, commands and
 * browsing run without prompts; destructive actions and secret files still
 * ask. Real mouse/keyboard control stays an explicit opt-in.
 */
const DEFAULT_POLICY: PolicyConfig = {
  mode: 'auto',
  blockedCommands: [],
  allowedRoots: [],
  // The user asked the agent to work on the whole computer, not only inside
  // the project folder. Dangerous commands and secret files still ask.
  fullAccess: true,
  allowNetwork: true,
  allowComputerControl: false,
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
    'ollama',
    'lmstudio',
    'mock'
  ].map((key) => presetToConfig(key))
  return {
    providers,
    defaultProviderId: 'mock',
    policy: DEFAULT_POLICY,
    limits: { ...DEFAULT_LIMITS },
    theme: 'dark',
    profileName: '',
    telemetry: false,
    autoAgents: false,
    useAllModels: false,
    claudeCatalogImported: false,
    mcpServers: [],
    hooks: {},
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
      if ((parsed.settingsVersion ?? 1) < SETTINGS_VERSION) {
        this.migrate(parsed)
        await this.save()
      }
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
  }

  /**
   * v1 → v2: 0.1.0 shipped "ask" as the default mode, which prompted for every
   * edit and command; v2 defaults to autonomous mode. Only the untouched
   * default is changed — a readonly or accept-edits choice is kept.
   */
  private migrate(parsed: Partial<AppSettings>): void {
    this.migrations = []
    if ((parsed.policy?.mode ?? 'ask') === 'ask') {
      this.settings.policy.mode = 'auto'
      this.migrations.push('modo de permissão: ask → auto (autônomo; destrutivo e arquivos de segredo continuam pedindo confirmação)')
    }
    this.settings.policy.rules = mergeRules(DEFAULT_RULES, parsed.policy?.rules)
    this.settings.settingsVersion = SETTINGS_VERSION
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = {
      ...this.settings,
      ...patch,
      policy: { ...this.settings.policy, ...(patch.policy ?? {}) },
      limits: { ...this.settings.limits, ...(patch.limits ?? {}) }
    }
    await this.save()
    return this.get()
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    await fs.promises.rename(tmp, this.file)
  }

  private async saveSecrets(): Promise<void> {
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

  providerConfig(id: string): ProviderConfig | undefined {
    return this.settings.providers.find((p) => p.id === id)
  }

  presetCatalog(): Record<string, unknown> {
    return PROVIDER_PRESETS
  }
}
