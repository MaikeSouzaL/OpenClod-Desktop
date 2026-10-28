import type { Provider, ProviderConfig } from '../../shared/types.js'
import { OpenAICompatibleProvider } from './openai.js'
import { AnthropicProvider } from './anthropic.js'

export { PROVIDER_PRESETS, presetToConfig } from './presets.js'

export function resolveApiKey(config: ProviderConfig, secrets?: { get(key: string): string | undefined }): string {
  const ref = config.apiKeyRef ?? ''
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] ?? ''
  if (ref.startsWith('secret:')) return secrets?.get(ref.slice(7)) ?? ''
  return ref
}

export function createProvider(
  config: ProviderConfig,
  secrets?: { get(key: string): string | undefined }
): Provider {
  const apiKey = resolveApiKey(config, secrets)
  if (config.kind === 'anthropic') return new AnthropicProvider(config, apiKey)
  return new OpenAICompatibleProvider(config, apiKey)
}

export function hasCredentials(config: ProviderConfig, secrets?: { get(key: string): string | undefined }): boolean {
  const ref = config.apiKeyRef ?? ''
  if (ref.startsWith('secret:')) return Boolean(secrets?.get(ref.slice(7)))
  if (ref.startsWith('env:')) return Boolean(process.env[ref.slice(4)])
  if (!ref) {
    // Local OpenAI-compatible servers generally accept any bearer token.
    return /127\.0\.0\.1|localhost/.test(config.baseUrl)
  }
  return true
}
