import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlamaServer } from '../src/main/llamacpp/server'
import { FIRST_PROFILE, LlamaCppService } from '../src/main/llamacpp/service'
import type { ProviderConfig } from '../src/shared/types'

const help = fs.readFileSync(path.join(__dirname, 'fixtures', 'llamacpp-help-b11972.txt'), 'utf8')

let root = ''
let userData = ''
let bundled = ''

/** A minimal GGUF v3 header: general.architecture + general.name, no tensors. */
function gguf(file: string, name: string): string {
  const str = (text: string): Buffer => {
    const body = Buffer.from(text, 'utf8')
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(body.length))
    return Buffer.concat([len, body])
  }
  const kv = (key: string, value: string): Buffer => {
    const type = Buffer.alloc(4)
    type.writeUInt32LE(8)
    return Buffer.concat([str(key), type, str(value)])
  }
  const head = Buffer.alloc(4 + 4 + 8 + 8)
  head.write('GGUF', 0, 'ascii')
  head.writeUInt32LE(3, 4)
  head.writeBigUInt64LE(0n, 8)
  head.writeBigUInt64LE(2n, 16)
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, Buffer.concat([head, kv('general.architecture', 'llama'), kv('general.name', name)]))
  return full
}

function service(): LlamaCppService {
  const state: { providers: ProviderConfig[] } = { providers: [] }
  return new LlamaCppService({
    settings: {
      get: () => state as never,
      update: async (patch: never) => Object.assign(state, patch) as never,
      setSecret: async () => undefined,
      resolver: () => ({ get: () => undefined })
    },
    health: { clear: () => undefined } as never,
    userData,
    emitChanged: () => undefined,
    server: new LlamaServer({}),
    bundledDir: () => bundled,
    env: () => ({}),
    home: path.join(root, 'home'),
    help: async () => help
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-llama-service-'))
  userData = path.join(root, 'userData')
  bundled = path.join(root, 'bundled')
  fs.mkdirSync(bundled, { recursive: true })
  fs.writeFileSync(path.join(bundled, 'llama-server.exe'), '')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('llama.cpp profiles', () => {
  it('turns the first version of the file (one profile) into the profile "Padrão"', () => {
    const model = gguf('models/a.gguf', 'Model A')
    fs.mkdirSync(path.join(userData, 'config'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'config', 'llamacpp.json'), JSON.stringify({ model, ctxSize: 16384, parallel: 1, autostart: true, folders: ['C:\\m'], values: { '--flash-attn': 'on' }, extraArgs: [] }))
    const status = service().status()
    expect(status).toMatchObject({ profiles: [FIRST_PROFILE], activeProfile: FIRST_PROFILE })
    expect(status.profile).toMatchObject({ model, ctxSize: 16384, autostart: true, folders: ['C:\\m'], values: { '--flash-attn': 'on' } })
    expect(status.model?.name).toBe('Model A')
  })

  it('creates a copy, switches, renames and deletes profiles; autostart and folders are shared', async () => {
    const llama = service()
    const first = gguf('models/a.gguf', 'Model A')
    const second = gguf('models/b.gguf', 'Model B')
    await llama.setProfile({ model: first, autostart: true })
    let status = await llama.profileAction({ kind: 'create', name: 'Rápido' })
    expect(status).toMatchObject({ profiles: [FIRST_PROFILE, 'Rápido'], activeProfile: 'Rápido' })
    expect(status.profile.model).toBe(first)
    status = await llama.setProfile({ model: second, ctxSize: 8192 })
    expect(status.model?.name).toBe('Model B')

    status = await llama.profileAction({ kind: 'select', name: FIRST_PROFILE })
    expect(status.profile).toMatchObject({ model: first, ctxSize: 32768, autostart: true })
    expect(status.model?.name).toBe('Model A')

    status = await llama.profileAction({ kind: 'rename', name: 'Rápido', to: 'Leve' })
    expect(status.profiles).toEqual([FIRST_PROFILE, 'Leve'])
    await expect(llama.profileAction({ kind: 'create', name: 'Leve' })).rejects.toThrow(/Já existe/)
    await expect(llama.profileAction({ kind: 'create', name: '../evil' })).rejects.toThrow(/inválido/)

    status = await llama.profileAction({ kind: 'delete', name: FIRST_PROFILE })
    expect(status).toMatchObject({ profiles: ['Leve'], activeProfile: 'Leve' })
    expect(status.profile.model).toBe(second)
    await expect(llama.profileAction({ kind: 'delete', name: 'Leve' })).rejects.toThrow(/único perfil/)

    // All of it survives a restart of the app.
    expect(service().status()).toMatchObject({ profiles: ['Leve'], activeProfile: 'Leve', profile: { model: second, ctxSize: 8192, autostart: true } })
  })
})

describe('llama.cpp options', () => {
  it('lists the build options from its help and shows the next command line, without the key', async () => {
    const llama = service()
    await llama.setProfile({ model: gguf('models/a.gguf', 'Model A'), values: { '--flash-attn': 'on', '--gpu-layers': '20' } })
    const options = await llama.options()
    expect(options.groups.map((group) => group.id)).toContain('gpu')
    expect(options.commandLine).toContain('--host 127.0.0.1')
    expect(options.commandLine).toContain('--flash-attn on --gpu-layers 20')
    expect(options.commandLine).toContain('--port "<porta livre>"')
    expect(options.commandLine).not.toMatch(/api-key/)
  })

  it('refuses an invalid value when it is saved, not when the server starts', async () => {
    const llama = service()
    await expect(llama.setProfile({ values: { '--flash-attn': 'maybe' } })).rejects.toThrow(/aceita só/)
    await expect(llama.setProfile({ values: { '--host': '0.0.0.0' } })).rejects.toThrow(/controlada pelo Openclod/)
    expect(llama.status().profile.values).toEqual({})
  })
})

describe('llama.cpp builds', () => {
  it('runs the bundled build until another one is chosen, and refuses an unknown one', async () => {
    const llama = service()
    expect(llama.status().build).toMatchObject({ id: 'b11972-vulkan', bundled: true })
    const installed = path.join(userData, 'llamacpp', 'builds', 'b12000-cuda-12.4')
    fs.mkdirSync(installed, { recursive: true })
    fs.writeFileSync(path.join(installed, 'llama-server.exe'), '')
    fs.writeFileSync(path.join(installed, 'openclod-build.json'), '{}')
    const status = await llama.selectBuild('b12000-cuda-12.4')
    expect(status.build).toMatchObject({ id: 'b12000-cuda-12.4', kind: 'cuda-12.4', bundled: false })
    expect(status.builds.map((build) => build.id)).toEqual(['b11972-vulkan', 'b12000-cuda-12.4'])
    await expect(llama.selectBuild('b1-nope')).rejects.toThrow(/não encontrada/)
    await expect(llama.removeBuild('b11972-vulkan')).rejects.toThrow(/embutida/)
    expect((await llama.removeBuild('b12000-cuda-12.4')).build?.id).toBe('b11972-vulkan')
  })
})
