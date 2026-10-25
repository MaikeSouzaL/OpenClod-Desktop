import electron from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { SettingsStore, type SecretCrypto } from '../src/main/settings'

interface OllamaProvider {
  name?: string
  api_key?: string
}

const { app, safeStorage } = electron
const crypto: SecretCrypto = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (text) => safeStorage.encryptString(text),
  decryptString: (data) => safeStorage.decryptString(data)
}

async function main(): Promise<void> {
  await app.whenReady()
  try {
    const source = path.join(app.getPath('home'), '.ollama', 'providers.json')
    const data = JSON.parse(fs.readFileSync(source, 'utf8')) as { providers?: OllamaProvider[] }
    const key = data.providers?.find((provider) => provider.name === 'opencode-go')?.api_key?.trim()
    if (!key) throw new Error('chave opencode-go não encontrada no perfil do Ollama')
    const store = new SettingsStore(path.join(app.getPath('userData'), 'config'), crypto)
    await store.init()
    const config = store.providerConfig('opencode-go')
    if (!config) throw new Error('provedor OpenCode Go não foi inicializado pelo aplicativo atualizado')
    await store.setSecret('opencode-go', key)
    console.log(JSON.stringify({ ok: true, provider: 'opencode-go', stored: store.hasSecret('opencode-go') }))
  } finally {
    app.quit()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
