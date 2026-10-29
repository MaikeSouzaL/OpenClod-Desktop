import { describe, expect, it } from 'vitest'
import {
  budgetFrom,
  choose,
  fetchPages,
  fitOf,
  fixParams,
  merge,
  nextUrl,
  normalize,
  parseListDevices,
  parseTree,
  pickMmproj,
  repoAlias,
  resolveUrl,
  slim,
  supportedArchs,
  type HubEntry,
  type HubItem
} from '../src/core/llamacpp/hub'

const SHA = 'a'.repeat(64)
const rtx2060 = budgetFrom([{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 2060', totalMiB: 6168, freeMiB: 5397 }], 32_679)

const item = (id: string, extra: Partial<HubItem> = {}): HubItem => ({
  id,
  downloads: 100,
  pipeline_tag: 'text-generation',
  tags: [],
  cardData: { license: 'apache-2.0' },
  gguf: { total: 8.03e9, architecture: 'qwen3', context_length: 40_960, chat_template: '{% if tools %}…{% endif %}<think>' },
  ...extra
})

const entry = (params: number, arch = 'llama'): HubEntry =>
  normalize(item('unsloth/Model-GGUF', { gguf: { total: params * 1e9, architecture: arch, chat_template: 'chat' } }), null) as HubEntry

describe('this computer', () => {
  it('reads every device llama.cpp lists, any vendor', () => {
    const text = 'ggml_vulkan: Found 2 devices\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 2060 (6168 MiB, 5397 MiB free)\n  Vulkan1: AMD Radeon(TM) Graphics (2048 MiB, 1900 MiB free)\n'
    expect(parseListDevices(text)).toEqual([
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 2060', totalMiB: 6168, freeMiB: 5397 },
      { id: 'Vulkan1', name: 'AMD Radeon(TM) Graphics', totalMiB: 2048, freeMiB: 1900 }
    ])
  })

  it('budgets the biggest GPU minus what Windows keeps, and 80% of the RAM minus 3 GB', () => {
    expect(rtx2060).toEqual({ gpu: 'NVIDIA GeForce RTX 2060', vramMiB: 6168, ramMiB: 32_679, vramUseMiB: 5468, ramUseMiB: 23_071 })
    expect(budgetFrom([], 8192)).toMatchObject({ gpu: '', vramUseMiB: 0, ramUseMiB: 3481 })
  })

  it('finds architecture names written in llama.dll', () => {
    const dll = Buffer.from('\x00MZ\x00llama\x00qwen35\x00gemma4\x00Some Text\x00', 'latin1')
    const archs = supportedArchs(dll)
    expect(archs?.has('qwen35')).toBe(true)
    expect(archs?.has('gemma4')).toBe(true)
    expect(archs?.has('Some Text')).toBe(false)
  })
})

describe('the Hugging Face list', () => {
  it('keeps chat models in GGUF only, with what the template supports', () => {
    const model = normalize(item('unsloth/Qwen3-8B-GGUF', { tags: ['base_model:quantized:Qwen/Qwen3-8B'], cardData: { base_model: 'Qwen/Qwen3-8B' } }), new Set(['qwen3']))
    expect(model).toMatchObject({ repo: 'unsloth/Qwen3-8B-GGUF', author: 'unsloth', name: 'Qwen3-8B', key: 'qwen3-8b', params: 8.03, tools: true, thinking: true, supported: true })
    expect(normalize(item('audio/tts-gguf', { gguf: { total: 1e8, architecture: 'audiocpp' } }), null)).toBeNull()
    expect(normalize(item('bad repo name'), null)).toBeNull()
    expect(normalize(item('x/y-GGUF'), new Set(['llama']))?.supported).toBe(false)
  })

  it('keeps what supports tools and thinking when the template is slimmed for the cache', () => {
    const cached = slim(item('unsloth/Qwen3-8B-GGUF'))
    expect(cached.gguf?.chat_template).toBe('tool <think> chat')
    expect(normalize(cached, null)).toMatchObject({ tools: true, thinking: true })
  })

  it('reads vision from the pipeline or the tags', () => {
    expect(normalize(item('ggml-org/gemma-4-E2B-it-GGUF', { pipeline_tag: 'image-text-to-text' }), null)?.vision).toBe(true)
    expect(normalize(item('a/b-GGUF', { tags: ['vision'] }), null)?.vision).toBe(true)
  })

  it('merges copies of one model under the most trusted publisher, adding up downloads', () => {
    const copies = ['someone/Qwen3-8B-GGUF', 'bartowski/Qwen3-8B-GGUF', 'unsloth/Qwen3-8B-GGUF'].map((repo, index) =>
      normalize(item(repo, { downloads: (index + 1) * 10, tags: ['base_model:quantized:Qwen/Qwen3-8B'], cardData: { base_model: 'Qwen/Qwen3-8B' } }), null)
    ) as HubEntry[]
    const [row] = merge(copies)
    expect(row).toMatchObject({ repo: 'unsloth/Qwen3-8B-GGUF', sources: 3, downloadsTotal: 60 })
    expect(row.others).toEqual(['bartowski/Qwen3-8B-GGUF', 'someone/Qwen3-8B-GGUF'])
  })

  it('fixes a parameter count Hugging Face took from one part of a split model', () => {
    const big = normalize(item('a/Huge-748B-GGUF', { gguf: { total: 1.7e9, architecture: 'deepseek2', chat_template: 'chat' } }), null) as HubEntry
    const unnamed = normalize(item('b/Mystery-GGUF', { gguf: { total: 0.5e9, architecture: 'qwen3', chat_template: 'chat' } }), null) as HubEntry
    const peers = [8, 8, 14].map((size, index) => normalize(item(`c/Peer${index}-GGUF`, { gguf: { total: size * 1e9, architecture: 'qwen3', chat_template: 'chat' } }), null) as HubEntry)
    fixParams([big, unnamed, ...peers])
    expect(big).toMatchObject({ params: 748, paramsGuess: true })
    expect(unnamed).toMatchObject({ params: 8, paramsGuess: true })
    expect(peers[0].paramsGuess).toBeUndefined()
  })

  it('follows the next page only on the same API', async () => {
    expect(nextUrl('<https://huggingface.co/api/models?cursor=abc>; rel="next"')).toBe('https://huggingface.co/api/models?cursor=abc')
    expect(nextUrl('<https://evil.example/api/models?x>; rel="next"')).toBeNull()
    const pages = [
      { body: [item('a/one-GGUF')], link: '<https://huggingface.co/api/models?p=2>; rel="next"' },
      { body: [item('a/two-GGUF')], link: null }
    ]
    let calls = 0
    const items = await fetchPages('https://huggingface.co/api/models?p=1', 10, async () => pages[calls++])
    expect(items.map((value) => value.id)).toEqual(['a/one-GGUF', 'a/two-GGUF'])
    expect(calls).toBe(2)
  })
})

describe('what fits', () => {
  it('suggests the best quantization that fits entirely on a 6 GB GPU at 32k', () => {
    // A 4B with full attention spends ~3 GB on the KV cache at 32k: only IQ4_XS fits whole.
    expect(choose(entry(4), 32_768, rtx2060)).toMatchObject({ quant: 'IQ4_XS', fit: 'gpu' })
    // Hybrid attention (qwen35) keeps a fraction of that cache: Q6_K fits.
    expect(choose(entry(4, 'qwen35'), 32_768, rtx2060)).toMatchObject({ quant: 'Q6_K', fit: 'gpu' })
    // A 14B does not fit whole: Q4_K_M split with the RAM.
    expect(choose(entry(14), 32_768, rtx2060)).toMatchObject({ quant: 'Q4_K_M', fit: 'misto' })
    // Q8_0 only for small models.
    expect(choose(entry(1.5), 8_192, rtx2060)).toMatchObject({ quant: 'Q8_0', fit: 'gpu' })
  })

  it('a smaller context makes the same model fit on the GPU', () => {
    expect(choose(entry(8), 65_536, rtx2060)?.fit).toBe('misto')
    expect(choose(entry(8), 4_096, rtx2060)).toMatchObject({ quant: 'IQ4_XS', fit: 'gpu' })
  })

  it('without a GPU, what fits the RAM runs on the CPU', () => {
    const cpuOnly = budgetFrom([], 16_384)
    expect(fitOf(entry(4), 2.5e9, 8_192, cpuOnly)).toBe('cpu')
    expect(fitOf(entry(70), 40e9, 8_192, cpuOnly)).toBe('nao')
  })

  it('uses the real files when it has them', () => {
    const files = parseTree([
      { type: 'file', path: 'Model-Q8_0.gguf', size: 8.5e9, lfs: { oid: SHA, size: 8.5e9 } },
      { type: 'file', path: 'Model-Q4_K_M.gguf', size: 2.5e9, lfs: { oid: SHA } },
      { type: 'file', path: 'Model-UD-Q4_K_XL.gguf', size: 2.6e9, lfs: { oid: SHA } }
    ])
    // Q8_0 is for small models only, and a quant with no level in the list (UD-Q4_K_XL) is never auto-picked.
    expect(choose(entry(4), 16_384, rtx2060, files)).toMatchObject({ quant: 'Q4_K_M', bytes: 2.5e9, fit: 'gpu' })
  })
})

describe('repository files', () => {
  const tree = [
    { type: 'file', path: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2_700_000_000, lfs: { oid: SHA, size: 2_700_000_000 } },
    { type: 'file', path: 'Qwen3.5-4B-Q8_0.gguf', size: 4_500_000_000, lfs: { oid: SHA } },
    { type: 'file', path: 'mmproj-F32.gguf', size: 1_300_000_000, lfs: { oid: SHA } },
    { type: 'file', path: 'mmproj-F16.gguf', size: 650_000_000, lfs: { oid: SHA } },
    { type: 'file', path: 'BF16/Qwen3.5-4B-BF16-00001-of-00002.gguf', size: 5e9, lfs: { oid: SHA } },
    { type: 'file', path: 'README.md', size: 10 },
    { type: 'file', path: 'no-sha.gguf', size: 10, lfs: { oid: 'short' } },
    { type: 'directory', path: 'BF16' }
  ]

  it('keeps whole .gguf files with a SHA-256, models first by size', () => {
    expect(parseTree(tree).map((file) => [file.name, file.quant, file.mmproj])).toEqual([
      ['Qwen3.5-4B-Q4_K_M.gguf', 'Q4_K_M', false],
      ['Qwen3.5-4B-Q8_0.gguf', 'Q8_0', false],
      ['mmproj-F16.gguf', 'F16', true],
      ['mmproj-F32.gguf', 'F32', true]
    ])
  })

  it('picks the F16 projector, never F32 when there is another', () => {
    expect(pickMmproj(parseTree(tree))?.name).toBe('mmproj-F16.gguf')
    expect(pickMmproj(parseTree(tree.filter((file) => file.path !== 'mmproj-F16.gguf')))?.name).toBe('mmproj-F32.gguf')
    expect(pickMmproj(parseTree(tree.slice(0, 2)))).toBeUndefined()
  })

  it('builds download URLs and API names safely', () => {
    expect(resolveUrl('unsloth/Qwen3.5-4B-GGUF', 'sub dir/Qwen3.5 4B.gguf')).toBe('https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/sub%20dir/Qwen3.5%204B.gguf')
    expect(repoAlias('unsloth/Qwen3.5-4B-GGUF')).toBe('qwen3.5-4b')
    expect(repoAlias('mradermacher/Model-i1-GGUF')).toBe('model')
  })
})
