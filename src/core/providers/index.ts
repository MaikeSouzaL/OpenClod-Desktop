import fs from 'node:fs'
import type { Provider, ProviderConfig } from '../../shared/types.js'
import { OpenAICompatibleProvider } from './openai.js'
import { AnthropicProvider } from './anthropic.js'
import { ScriptedProvider, type MockTurn } from './mock.js'

export { PROVIDER_PRESETS, presetToConfig } from './presets.js'
export { ScriptedProvider } from './mock.js'

export function resolveApiKey(config: ProviderConfig, secrets?: { get(key: string): string | undefined }): string {
  const ref = config.apiKeyRef ?? ''
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] ?? ''
  if (ref.startsWith('secret:')) return secrets?.get(ref.slice(7)) ?? ''
  return ref
}

let scriptCursor = 0

/**
 * Test hook for end-to-end UI runs without a real model: FORJA_MOCK_SCRIPT points
 * to {"scripts": [[turn, ...], [turn, ...]]}. Each Scripted provider created
 * (the session's, then each sub-agent's) takes the next script, in order.
 * Without the variable the Scripted provider has no script and says so.
 */
function nextScriptedTurns(): MockTurn[] {
  const file = process.env.FORJA_MOCK_SCRIPT
  if (!file) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: MockTurn[][] }
    const turns = data.scripts?.[scriptCursor++]
    return Array.isArray(turns) ? structuredClone(turns) : []
  } catch {
    return []
  }
}

export function createProvider(
  config: ProviderConfig,
  secrets?: { get(key: string): string | undefined }
): Provider {
  const apiKey = resolveApiKey(config, secrets)
  if (config.kind === 'anthropic') return new AnthropicProvider(config, apiKey)
  if (config.kind === 'mock') return new ScriptedProvider(nextScriptedTurns())
  return new OpenAICompatibleProvider(config, apiKey)
}

export function hasCredentials(config: ProviderConfig, secrets?: { get(key: string): string | undefined }): boolean {
  if (config.kind === 'mock') return true
  const ref = config.apiKeyRef ?? ''
  if (ref.startsWith('secret:')) return Boolean(secrets?.get(ref.slice(7)))
  if (ref.startsWith('env:')) return Boolean(process.env[ref.slice(4)])
  if (!ref) {
    // Local OpenAI-compatible servers generally accept any bearer token.
    return /127\.0\.0\.1|localhost/.test(config.baseUrl)
  }
  return true
}
