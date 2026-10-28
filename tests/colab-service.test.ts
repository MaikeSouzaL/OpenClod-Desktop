import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ColabService, COLAB_PROVIDER_ID, type ColabHost } from '../src/main/colab'
import { SettingsStore, type SecretCrypto } from '../src/main/settings'
import { ProviderHealth } from '../src/core/providers/health'
import { COLAB_NOTEBOOK_VERSION, encodeColabCode } from '../src/core/colab/connection-code'
import { COLAB_FAQ_URL, COLAB_NOTEBOOK_FILE, COLAB_URL } from '../src/core/colab/notebook'
import { TUNNEL_DOWN_MESSAGE } from '../src/core/providers/tunnel'
import { startFakeColab, type FakeColab } from './support/fake-colab'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * Settings → Provedores → Google Colab (GPU): the button, the pasted code, the vault, the provider that results, and the health
 * the reserve relies on. The OS vault is replaced by a reversible fake, so the tests can look for the key in every file.
 */
const fakeCrypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (data) => {
    const raw = data.toString('utf8')
    if (!raw.startsWith('enc:')) throw new Error('not encrypted')
    return Buffer.from(raw.slice(4), 'base64').toString('utf8')
  }
}
const noCrypto: SecretCrypto = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('indisponível') }, decryptString: () => { throw new Error('indisponível') } }

const MODULE_HASH = 'abcdef012345'

let dir: string
let notebookDir: string
let store: SettingsStore
let health: ProviderHealth
let colab: FakeColab
let calls: Array<{ kind: string; target: string }>
let logs: string[]
let changed: number
let now: number

function host(over: Partial<ColabHost> = {}): ColabHost {
  return {
    notebookDir,
    openUrl: (url) => void calls.push({ kind: 'url', target: url }),
    revealFile: (file) => void calls.push({ kind: 'reveal', target: file }),
    copyText: (text) => void calls.push({ kind: 'copy', target: text }),
    ...over
  }
}

function service(over: Partial<ConstructorParameters<typeof ColabService>[0]> = {}): ColabService {
  return new ColabService({
    settings: store,
    health,
    host: host(),
    emitChanged: () => void changed++,
    log: (message) => void logs.push(message),
    readServerSource: () => 'print("servidor de teste")\n',
    serverHash: () => MODULE_HASH,
    now: () => now,
    connectWaitMs: 400,
    retryDelayMs: 40,
    ...over
  })
}

function codeFor(over: Partial<Parameters<typeof encodeColabCode>[0]> = {}): string {
  return encodeColabCode({
    baseUrl: colab.baseUrl,
    apiKey: colab.key,
    model: colab.model,
    gpu: 'Tesla T4 (15 GB)',
    vramMiB: 15360,
    vision: true,
    tools: true,
    contextWindow: 32768,
    engine: 'ollama 0.40.11',
    notebookVersion: COLAB_NOTEBOOK_VERSION,
    createdAt: now - 30_000,
    moduleHash: MODULE_HASH,
    ...over
  })
}

const settingsText = (): string => fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
const everythingOnDisk = (): string =>
  fs
    .readdirSync(dir)
    .map((name) => fs.readFileSync(path.join(dir, name), 'latin1'))
    .join('\n')

beforeEach(async () => {
  dir = await makeTempDir('openclod-colab-svc-')
  notebookDir = path.join(dir, 'Documentos', 'Openclod', 'Colab')
  store = new SettingsStore(path.join(dir, 'config'), fakeCrypto)
  dir = path.join(dir, 'config')
  await store.init()
  health = new ProviderHealth()
  colab = await startFakeColab()
  calls = []
  logs = []
  changed = 0
  now = Date.UTC(2026, 9, 27, 18, 0, 0)
})

afterEach(async () => {
  await colab.close()
  await removeTempDir(path.dirname(dir))
})

describe('the button: prepare', () => {
  it('writes the notebook in a visible folder, selects it, copies its path and opens Colab (nothing is published)', async () => {
    const info = await service({ fetch: (() => { throw new Error('o botão não pode usar a rede') }) as unknown as typeof fetch }).prepare()
    const file = path.join(notebookDir, COLAB_NOTEBOOK_FILE)
    expect(info.path).toBe(file)
    expect(info.version).toBe(COLAB_NOTEBOOK_VERSION)
    expect(info.url).toBe(COLAB_URL)
    expect(info.opened).toEqual({ colab: true, folder: true, clipboard: true })
    expect(calls).toEqual([{ kind: 'copy', target: file }, { kind: 'reveal', target: file }, { kind: 'url', target: COLAB_URL }])
    const notebook = JSON.parse(fs.readFileSync(file, 'utf8')) as { nbformat: number; metadata: { accelerator: string }; cells: unknown[] }
    expect(notebook.nbformat).toBe(4)
    expect(notebook.metadata.accelerator).toBe('GPU')
    expect(notebook.cells.length).toBeGreaterThan(8)
    expect(JSON.stringify(notebook)).toContain('print(\\"servidor de teste\\")')
    expect(JSON.stringify(notebook)).toContain(COLAB_FAQ_URL)
  })

  it('gives five steps in Portuguese, the shortest path to a first run', async () => {
    const info = await service().prepare()
    expect(info.steps).toHaveLength(5)
    expect(info.steps[0]).toMatch(/Fazer upload de notebook/)
    expect(info.steps[1]).toMatch(/Executar tudo/)
    expect(info.steps[3]).toMatch(/CÓDIGO DE CONEXÃO/)
  })

  it('still works when the browser, Explorer or the clipboard fail, and says which one did not', async () => {
    const info = await service({
      host: host({
        openUrl: () => { throw new Error('sem navegador') },
        revealFile: () => { throw new Error('sem explorer') },
        copyText: () => { throw new Error('sem área de transferência') }
      })
    }).prepare()
    expect(info.opened).toEqual({ colab: false, folder: false, clipboard: false })
    expect(fs.existsSync(info.path)).toBe(true)
    expect(logs.join('\n')).toContain('sem navegador')
  })

  it('overwrites the previous notebook instead of piling up copies', async () => {
    await service().prepare()
    await service().prepare()
    expect(fs.readdirSync(notebookDir)).toEqual([COLAB_NOTEBOOK_FILE])
  })
})

describe('the file the user drags into Colab', () => {
  it('tells the card the file name and size to show as a tile', async () => {
    const info = await service().prepare()
    expect(info.fileName).toBe(COLAB_NOTEBOOK_FILE)
    expect(info.sizeBytes).toBe(fs.statSync(info.path).size)
    expect(info.sizeBytes).toBeGreaterThan(1000)
  })

  it('offers for dragging only the notebook the button wrote, never a path from the page', async () => {
    const colabService = service()
    expect(colabService.notebookFile()).toBeNull()
    const info = await colabService.prepare()
    expect(colabService.notebookFile()).toBe(info.path)
    // A second service (a restart) has not written anything: it has nothing to hand to the drag, even with the file still on disk.
    expect(service().notebookFile()).toBeNull()
  })

  it('stops offering it when the file was deleted', async () => {
    const colabService = service()
    const info = await colabService.prepare()
    fs.rmSync(info.path)
    expect(colabService.notebookFile()).toBeNull()
    expect(colabService.revealNotebook()).toBe(false)
  })

  it('shows the file in Explorer again on request, and says false when nothing was prepared', async () => {
    const colabService = service()
    expect(colabService.revealNotebook()).toBe(false)
    const info = await colabService.prepare()
    calls.length = 0
    expect(colabService.revealNotebook()).toBe(true)
    expect(calls).toEqual([{ kind: 'reveal', target: info.path }])
  })

  it('tells the user to drag the file in the first step', async () => {
    const info = await service().prepare()
    expect(info.steps[0]).toMatch(/arraste/i)
  })
})

describe('inspect: what the user confirms, before anything is saved or contacted', () => {
  it('shows host, model, GPU, vision, context and version; marks a notebook of this build as verified; hides the key', () => {
    const result = service().inspect(codeFor())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview).toMatchObject({
      host: `127.0.0.1:${new URL(colab.origin).port}`,
      model: 'qwen3.5:9b-q8_0',
      gpu: 'Tesla T4 (15 GB)',
      vision: true,
      tools: true,
      contextWindow: 32768,
      notebookVersion: COLAB_NOTEBOOK_VERSION,
      verified: true,
      replacesExisting: false
    })
    expect(JSON.stringify(result)).not.toContain(colab.key)
    expect(colab.requests).toHaveLength(0)
    expect(settingsText()).not.toContain('"colab"')
  })

  it('warns when the server is not the one this build generates', () => {
    const result = service().inspect(codeFor({ moduleHash: '000000000000' }))
    expect(result.ok && result.preview.verified).toBe(false)
    expect(result.ok && result.preview.warnings.join(' ')).toMatch(/não é idêntico/)
  })

  it('explains a bad paste in plain words', () => {
    expect(service().inspect('qualquer coisa')).toEqual({ ok: false, error: expect.stringMatching(/não parece um código/) })
    expect(service().inspect(codeFor().slice(0, -2))).toEqual({ ok: false, error: expect.stringMatching(/incompleto: faltou o final/) })
    const code = codeFor()
    expect(service().inspect(`${code.slice(0, 30)}X${code.slice(31)}`)).toEqual({ ok: false, error: expect.stringMatching(/incompleto ou foi alterado/) })
  })
})

describe('connect', () => {
  it('asks the server, keeps the key only in the vault and creates the provider with what the server really said', async () => {
    const result = await service().connect(codeFor())
    expect(result.ok).toBe(true)
    expect(result.status).toMatchObject({ state: 'conectado', model: 'qwen3.5:9b-q8_0', gpu: 'Tesla T4 (15 GB)', vision: true, contextWindow: 65536 })
    expect(changed).toBe(1)

    const saved = store.get().providers.find((provider) => provider.id === COLAB_PROVIDER_ID)!
    expect(saved).toMatchObject({
      kind: 'openai',
      label: 'Google Colab (GPU)',
      baseUrl: colab.baseUrl,
      model: 'qwen3.5:9b-q8_0',
      apiKeyRef: 'secret:colab',
      supportsVision: true,
      supportsTools: true,
      models: ['qwen3.5:9b-q8_0'],
      visionModels: ['qwen3.5:9b-q8_0'],
      // The window the SERVER reports (65536) wins over the code's (32768).
      contextWindow: 65536,
      colab: { host: new URL(colab.origin).host, gpu: 'Tesla T4 (15 GB)', notebookVersion: '1.0.0', verified: true }
    })
    expect(store.hasSecret('colab')).toBe(true)
    expect(store.resolver().get('colab')).toBe(colab.key)
  })

  it('never writes the key to settings.json, to the log, or to what it returns', async () => {
    const result = await service().connect(codeFor())
    expect(settingsText()).not.toContain(colab.key)
    expect(JSON.stringify(result)).not.toContain(colab.key)
    expect(logs.join('\n')).not.toContain(colab.key)
    // Not even the code it was made from (it contains the key).
    expect(logs.join('\n')).not.toContain('OCLC1.')
    // It is only in the encrypted vault file (the fake cipher here is base64, so look for the plain text elsewhere).
    for (const name of fs.readdirSync(dir)) {
      if (name === 'secrets.bin') continue
      expect(fs.readFileSync(path.join(dir, name), 'latin1'), name).not.toContain(colab.key)
    }
    expect(everythingOnDisk()).not.toContain(colab.key)
  })

  it('survives a restart: a new store reads the provider and the key back', async () => {
    await service().connect(codeFor())
    const again = new SettingsStore(dir, fakeCrypto)
    await again.init()
    expect(again.get().providers.some((provider) => provider.id === 'colab')).toBe(true)
    expect(again.resolver().get('colab')).toBe(colab.key)
  })

  it('does not take what the code says for granted: the server\'s own vision and tools flags win', async () => {
    await colab.close()
    colab = await startFakeColab({ vision: false, tools: false, context: 16384 })
    await service().connect(codeFor({ vision: true, tools: true }))
    const saved = store.get().providers.find((provider) => provider.id === 'colab')!
    expect(saved).toMatchObject({ supportsVision: false, supportsTools: false, contextWindow: 16384 })
    expect(saved.visionModels).toBeUndefined()
  })

  it('connecting again replaces the same provider (new address, new key) instead of adding another', async () => {
    await service().connect(codeFor())
    await colab.close()
    colab = await startFakeColab({ key: 'occ_outra-chave-depois-do-reinicio' })
    expect(service().inspect(codeFor()).ok && (service().inspect(codeFor()) as { preview: { replacesExisting: boolean } }).preview.replacesExisting).toBe(true)
    await service().connect(codeFor())
    const colabProviders = store.get().providers.filter((provider) => provider.id === 'colab')
    expect(colabProviders).toHaveLength(1)
    expect(colabProviders[0].baseUrl).toBe(colab.baseUrl)
    expect(store.resolver().get('colab')).toBe('occ_outra-chave-depois-do-reinicio')
  })

  it('keeps trying for a moment, because the name of a brand-new tunnel takes seconds to reach this computer', async () => {
    colab.mode = 'tunnel-down'
    setTimeout(() => { colab.mode = 'ok' }, 120)
    const result = await service({ connectWaitMs: 3000, retryDelayMs: 40 }).connect(codeFor())
    expect(result.ok).toBe(true)
    expect(colab.requests.length).toBeGreaterThan(1)
  })

  describe('refusals leave nothing behind', () => {
    const untouched = (): void => {
      expect(store.get().providers.some((provider) => provider.id === 'colab')).toBe(false)
      expect(store.hasSecret('colab')).toBe(false)
      expect(changed).toBe(0)
    }

    it('a wrong key: says the notebook restarted', async () => {
      const result = await service().connect(codeFor({ apiKey: 'occ_chave-que-o-servidor-nao-conhece' }))
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/gerou outra|código de conexão novo/) })
      expect(result.status?.state).toBe('chave')
      untouched()
    })

    it('a tunnel that is gone: says so, with what to do', async () => {
      colab.mode = 'tunnel-down'
      const result = await service().connect(codeFor())
      expect(result).toMatchObject({ ok: false, error: TUNNEL_DOWN_MESSAGE })
      expect(result.status?.state).toBe('caiu')
      untouched()
    })

    it('a server that serves another model than the code says', async () => {
      const result = await service().connect(codeFor({ model: 'qwen3.5:4b' }))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/serve outro modelo/)
      untouched()
    })

    it('a code that is not valid at all', async () => {
      expect(await service().connect('lixo')).toMatchObject({ ok: false, error: expect.stringMatching(/não parece um código/) })
      untouched()
    })

    it('a computer where the vault is unavailable: does not save a provider without its key', async () => {
      const bare = new SettingsStore(path.join(path.dirname(dir), 'sem-cofre'), noCrypto)
      await bare.init()
      const result = await service({ settings: bare }).connect(codeFor())
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/cofre do Windows/)
      expect(bare.get().providers.some((provider) => provider.id === 'colab')).toBe(false)
    })
  })
})

describe('status: the link as the reserve sees it', () => {
  beforeEach(async () => {
    await service().connect(codeFor())
    changed = 0
  })

  it('connected: answers with the server\'s facts and clears any earlier mark', async () => {
    const config = store.get().providers.find((provider) => provider.id === 'colab')!
    health.mark(config, 'network')
    const status = await service().status({ fresh: true })
    expect(status).toMatchObject({ state: 'conectado', model: 'qwen3.5:9b-q8_0', gpu: 'Tesla T4 (15 GB)' })
    expect(status.latencyMs).toBeGreaterThanOrEqual(0)
    expect(health.unavailable(config)).toBeUndefined()
  })

  it('tunnel gone: "caiu", and the reserve is told so it moves on without trying a request', async () => {
    const svc = service()
    colab.mode = 'tunnel-down'
    const status = await svc.status({ fresh: true })
    expect(status.state).toBe('caiu')
    expect(status.detail).toBe(TUNNEL_DOWN_MESSAGE)
    const config = store.get().providers.find((provider) => provider.id === 'colab')!
    expect(health.unavailable(config)).toMatchObject({ providerId: 'colab', kind: 'network' })
    // It comes back by itself: the next good answer clears the mark.
    colab.mode = 'ok'
    expect((await svc.status({ fresh: true })).state).toBe('conectado')
    expect(health.unavailable(config)).toBeUndefined()
  })

  it('notebook restarted with another key: "chave", marked as an auth failure', async () => {
    await colab.close()
    colab = await startFakeColab({ key: 'occ_a-chave-mudou-no-reinicio' })
    // Same address as before is not possible with a new port, so point the saved provider at the new server.
    await store.update({ providers: store.get().providers.map((provider) => (provider.id === 'colab' ? { ...provider, baseUrl: colab.baseUrl } : provider)) })
    const status = await service().status({ fresh: true })
    expect(status.state).toBe('chave')
    expect(health.unavailable(store.get().providers.find((provider) => provider.id === 'colab')!)).toMatchObject({ kind: 'auth' })
  })

  it('caches for a few seconds so a screen that polls does not hammer the tunnel', async () => {
    const svc = service()
    colab.requests.length = 0
    await svc.status()
    await svc.status()
    expect(colab.requests).toHaveLength(1)
    now += 5000
    await svc.status()
    expect(colab.requests).toHaveLength(2)
    await svc.status({ fresh: true })
    expect(colab.requests).toHaveLength(3)
  })

  it('with nothing connected: "nao-conectado", no request', async () => {
    await service().disconnect()
    colab.requests.length = 0
    expect(await service().status()).toMatchObject({ state: 'nao-conectado' })
    expect(colab.requests).toHaveLength(0)
  })
})

describe('disconnect', () => {
  it('removes the provider, the key, and every place the reserve and the pickers remembered it', async () => {
    await service().connect(codeFor())
    await store.update({ fallbackOrder: ['colab', 'deepseek'], fallbackExclude: ['colab'], defaultProviderId: 'colab', visionModel: { providerId: 'colab', model: colab.model }, lastModel: { providerId: 'colab', model: colab.model } })
    changed = 0
    const status = await service().disconnect()
    const settings = store.get()
    expect(status.state).toBe('nao-conectado')
    expect(settings.providers.some((provider) => provider.id === 'colab')).toBe(false)
    expect(store.hasSecret('colab')).toBe(false)
    expect(settings.fallbackOrder).toEqual(['deepseek'])
    expect(settings.fallbackExclude).toEqual([])
    expect(settings.defaultProviderId).toBe('deepseek')
    expect(settings.visionModel).toBeUndefined()
    expect(settings.lastModel).toBeUndefined()
    expect(changed).toBe(1)
    expect(everythingOnDisk()).not.toContain(colab.key)
  })

  it('is harmless when nothing is connected', async () => {
    await expect(service().disconnect()).resolves.toMatchObject({ state: 'nao-conectado' })
  })
})
