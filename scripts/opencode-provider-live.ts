import electron from 'electron'
import path from 'node:path'
import { createProvider, hasCredentials } from '../src/core/providers'
import { SettingsStore, type SecretCrypto } from '../src/main/settings'

const { app, safeStorage } = electron
const crypto: SecretCrypto = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (text) => safeStorage.encryptString(text),
  decryptString: (data) => safeStorage.decryptString(data)
}

async function main(): Promise<void> {
  await app.whenReady()
  try {
    const store = new SettingsStore(path.join(app.getPath('userData'), 'config'), crypto)
    await store.init()
    const config = store.providerConfig('opencode-go')
    if (!config) throw new Error('provedor OpenCode Go ausente')
    if (!hasCredentials(config, store.resolver())) throw new Error('credencial OpenCode Go ausente no cofre')
    const provider = createProvider(config, store.resolver())
    let text = ''
    let error = ''
    let usage: unknown
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      for await (const event of provider.stream({
        system: 'Responda apenas com a palavra pong.',
        messages: [{ id: 'live', role: 'user', ts: Date.now(), parts: [{ type: 'text', text: 'ping' }] }],
        tools: [],
        maxTokens: 128,
        signal: controller.signal
      })) {
        if (event.type === 'text_delta') text += event.text
        if (event.type === 'usage') usage = event.usage
        if (event.type === 'end' && event.stopReason === 'error') error = event.error ?? 'erro do provedor'
      }
    } finally {
      clearTimeout(timer)
    }
    if (error) throw new Error(error)
    if (!text.trim()) throw new Error('o provedor respondeu vazio')
    console.log(JSON.stringify({ ok: true, provider: config.label, model: config.model, answer: text.trim().slice(0, 120), usage }, null, 2))
  } finally {
    app.quit()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
