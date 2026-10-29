import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverModels, localAlias, ollamaName, scanFolder } from '../src/core/llamacpp/local-models'

let home = ''

const put = (file: string, bytes = 16): string => {
  const full = path.join(home, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, Buffer.alloc(bytes))
  return full
}

const manifest = (rel: string, layers: Array<{ mediaType: string; digest: string }>): void => {
  const full = path.join(home, '.ollama', 'models', 'manifests', ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, JSON.stringify({ schemaVersion: 2, layers }))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-llama-models-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('local GGUF models', () => {
  it('names API models safely', () => {
    expect(localAlias('qwen3.5:4b')).toBe('qwen3.5-4b')
    expect(localAlias('Qwen3-8B-Q4_K_M.gguf')).toBe('qwen3-8b-q4_k_m')
    expect(localAlias('C:\\m\\Big-Model-Q4_K_M-00001-of-00003.gguf')).toBe('big-model-q4_k_m')
    expect(localAlias('***')).toBe('modelo')
  })

  it('names Ollama models the way `ollama list` does', () => {
    expect(ollamaName(['registry.ollama.ai', 'library', 'qwen3.5', '4b'])).toBe('qwen3.5:4b')
    expect(ollamaName(['registry.ollama.ai', 'someone', 'model', 'latest'])).toBe('someone/model:latest')
    expect(ollamaName(['hf.co', 'unsloth', 'Qwen3-8B-GGUF', 'Q4_K_M'])).toBe('hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M')
  })

  it('pairs an Ollama model blob with its projector and leaves cloud models (no blob) out', async () => {
    put('.ollama/models/blobs/sha256-aaaa', 64)
    put('.ollama/models/blobs/sha256-bbbb', 32)
    manifest('registry.ollama.ai/library/qwen3.5/4b', [
      { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:aaaa' },
      { mediaType: 'application/vnd.ollama.image.projector', digest: 'sha256:bbbb' },
      { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:cccc' }
    ])
    manifest('registry.ollama.ai/library/kimi-k3/cloud', [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:missing' }])
    fs.writeFileSync(path.join(home, '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'broken'), '{not json')

    const models = await discoverModels({ home, env: {}, downloaded: path.join(home, 'dl') })
    expect(models).toEqual([
      {
        path: path.join(home, '.ollama', 'models', 'blobs', 'sha256-aaaa'),
        name: 'qwen3.5:4b',
        source: 'Ollama',
        bytes: 64,
        mmproj: path.join(home, '.ollama', 'models', 'blobs', 'sha256-bbbb'),
        alias: 'qwen3.5-4b'
      }
    ])
  })

  it('reads OLLAMA_MODELS when the user moved Ollama’s folder', async () => {
    const root = path.join(home, 'elsewhere')
    put('elsewhere/blobs/sha256-dddd')
    const full = path.join(root, 'manifests', 'registry.ollama.ai', 'library', 'gemma4', 'e4b')
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:dddd' }] }))
    const models = await discoverModels({ home, env: { OLLAMA_MODELS: root }, downloaded: path.join(home, 'dl') })
    expect(models.map((model) => model.name)).toEqual(['gemma4:e4b'])
  })

  it('lists the first part of a split model, keeps projectors as the folder’s mmproj, and labels Hugging Face repos', async () => {
    put('.lmstudio/models/lmstudio-community/Big-GGUF/Big-Q4_K_M-00001-of-00002.gguf')
    put('.lmstudio/models/lmstudio-community/Big-GGUF/Big-Q4_K_M-00002-of-00002.gguf')
    put('.lmstudio/models/lmstudio-community/Big-GGUF/mmproj-Big-F16.gguf')
    put('.cache/huggingface/hub/models--unsloth--Qwen3-8B-GGUF/snapshots/abc123/Qwen3-8B-Q4_K_M.gguf')
    put('.cache/huggingface/hub/models--unsloth--Qwen3-8B-GGUF/snapshots/abc123/notes.txt')

    const models = await discoverModels({ home, env: {}, downloaded: path.join(home, 'dl') })
    expect(models.map((model) => [model.source, model.name, Boolean(model.mmproj)])).toEqual([
      ['LM Studio', 'Big-Q4_K_M-00001-of-00002.gguf', true],
      ['Hugging Face', 'unsloth/Qwen3-8B-GGUF · Qwen3-8B-Q4_K_M.gguf', false]
    ])
    expect(models[0].alias).toBe('big-q4_k_m')
  })

  it('searches the added folders once each, skipping hidden and dependency folders and empty files', async () => {
    put('work/a.gguf')
    put('work/node_modules/pkg/b.gguf')
    put('work/.hidden/c.gguf')
    put('work/empty.gguf', 0)
    const work = path.join(home, 'work')
    const models = await discoverModels({ home, env: {}, downloaded: path.join(home, 'dl'), folders: [work, work, path.join(home, 'missing')] })
    expect(models.map((model) => [model.source, model.name])).toEqual([['Pasta', 'a.gguf']])
  })

  it('stops at the limit', async () => {
    for (let index = 0; index < 5; index++) put(`many/m${index}.gguf`)
    expect(await scanFolder('Pasta', path.join(home, 'many'), 3)).toHaveLength(3)
  })
})
