import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FAMILIES,
  catalogBlock,
  kvCache,
  leadingSize,
  parseGgufHeader,
  parseListing,
  parseTags,
  pickTags,
  pythonRow,
  sizeLabelOf,
  versionAtLeast,
  type CatalogEntry,
  type TagRow
} from '../scripts/colab-catalog.mjs'

/** scripts/colab-catalog.mjs builds the notebook's model catalog from the registry; these are the parts that need no network. */

const FIXTURES = path.join(__dirname, 'fixtures', 'colab')
const MODULE = path.join(__dirname, '..', 'resources', 'colab', 'openclod_llm_server.py')

/* ------------------------------------------------------------ a GGUF header, written by hand ------------------------------------------------------------ */

type Kv = [string, 'u32', number] | [string, 'str', string] | [string, 'u32[]', number[]] | [string, 'bool[]', boolean[]] | [string, 'str[]', string[]]

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}
const u64 = (value: number): Buffer => {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}
const str = (value: string): Buffer => {
  const data = Buffer.from(value, 'utf8')
  return Buffer.concat([u64(data.length), data])
}

function gguf(entries: Kv[]): Buffer {
  const parts: Buffer[] = [Buffer.from('GGUF'), u32(3), u64(0), u64(entries.length)]
  for (const entry of entries) {
    parts.push(str(entry[0]))
    if (entry[1] === 'u32') parts.push(u32(4), u32(entry[2]))
    else if (entry[1] === 'str') parts.push(u32(8), str(entry[2]))
    else if (entry[1] === 'u32[]') parts.push(u32(9), u32(4), u64(entry[2].length), ...entry[2].map(u32))
    else if (entry[1] === 'bool[]') parts.push(u32(9), u32(7), u64(entry[2].length), ...entry[2].map((flag) => Buffer.from([flag ? 1 : 0])))
    else parts.push(u32(9), u32(8), u64(entry[2].length), ...entry[2].map(str))
  }
  return Buffer.concat(parts)
}

const TOKENIZER: Kv = ['tokenizer.ggml.tokens', 'str[]', ['<s>', '</s>']]

function header(arch: string, keys: Record<string, number>, extra: Kv[] = []): ReturnType<typeof parseGgufHeader> {
  const entries: Kv[] = [['general.architecture', 'str', arch], ['general.name', 'str', 'ignored']]
  for (const [key, value] of Object.entries(keys)) entries.push([`${arch}.${key}`, 'u32', value])
  return parseGgufHeader(gguf([...entries, ...extra, TOKENIZER]))
}

describe('parseGgufHeader', () => {
  it('keeps only the numbers the memory math needs and stops where the tokenizer arrays start', () => {
    const meta = header('llama', { block_count: 32, context_length: 131072, 'attention.head_count': 32 })
    expect(meta['general.architecture']).toBe('llama')
    expect(meta['llama.block_count']).toBe(32)
    expect(meta['llama.context_length']).toBe(131072)
    expect(meta['general.name']).toBeUndefined()
    expect(meta['tokenizer.ggml.tokens']).toBeUndefined()
  })

  it('reads per-layer arrays whole (KV heads, sliding-window pattern)', () => {
    const meta = header('x', { block_count: 4 }, [['x.attention.head_count_kv', 'u32[]', [0, 0, 0, 4]], ['x.attention.sliding_window_pattern', 'bool[]', [true, true, true, false]]])
    expect(meta['x.attention.head_count_kv']).toEqual([0, 0, 0, 4])
    expect(meta['x.attention.sliding_window_pattern']).toEqual([true, true, true, false])
  })

  it('refuses a file that is not GGUF and asks for more bytes when the header is cut', () => {
    expect(() => parseGgufHeader(Buffer.from('not a gguf file at all, no'))).toThrow(/GGUF/)
    expect(() => parseGgufHeader(gguf([['general.architecture', 'str', 'llama'], TOKENIZER]).subarray(0, 30))).toThrow()
  })
})

describe('kvCache: the KV cache of one token, per architecture', () => {
  it('dense attention: layers x KV heads x (key + value) x 2 bytes (Llama 3.1 8B = 128 KiB per token)', () => {
    const kv = kvCache(header('llama', { block_count: 32, embedding_length: 4096, 'attention.head_count': 32, 'attention.head_count_kv': 8, context_length: 131072 }))
    expect(kv).toMatchObject({ kibPerToken: 128, fixedMiB: 0, maxContext: 131072, arch: 'llama', moe: false })
  })

  it('a hybrid with full attention every 4th layer keeps KV only in those layers (Qwen3.5 9B = 32 KiB per token)', () => {
    const kv = kvCache(header('qwen35', { block_count: 32, embedding_length: 4096, 'attention.head_count': 16, 'attention.head_count_kv': 4, 'attention.key_length': 256, 'attention.value_length': 256, full_attention_interval: 4, context_length: 262144 }))
    expect(kv?.kibPerToken).toBe(32)
  })

  it('a per-layer KV-head array counts only the layers that have KV (zeros are layers without it)', () => {
    const heads = Array.from({ length: 48 }, (_, layer) => ((layer + 1) % 4 === 0 ? 2 : 0))
    const kv = kvCache(header('qwen3next', { block_count: 48, 'attention.head_count': 16, 'attention.key_length': 256, 'attention.value_length': 256, full_attention_interval: 4 }, [['qwen3next.attention.head_count_kv', 'u32[]', heads]]))
    expect(kv?.kibPerToken).toBe(24)
  })

  it('Gemma 3: 5 sliding-window layers per global one (the pattern is not in the file): the window part does not grow with the context', () => {
    const kv = kvCache(header('gemma3', { block_count: 62, 'attention.head_count': 32, 'attention.head_count_kv': 16, 'attention.key_length': 128, 'attention.value_length': 128, 'attention.sliding_window': 1024 }))
    expect(kv?.kibPerToken).toBe(80) // 10 global layers x 16 heads x 256 x 2 bytes
    expect(kv?.fixedMiB).toBe(416) // 52 window layers x 8 KiB x 1024 tokens
  })

  it('gpt-oss alternates window and global layers', () => {
    const kv = kvCache(header('gpt-oss', { block_count: 24, 'attention.head_count': 64, 'attention.head_count_kv': 8, 'attention.key_length': 64, 'attention.value_length': 64, 'attention.sliding_window': 128 }))
    expect(kv?.kibPerToken).toBe(24)
    expect(kv?.fixedMiB).toBe(3)
  })

  it('an explicit sliding-window pattern in the file wins', () => {
    const kv = kvCache(header('gemma4', { block_count: 6, 'attention.head_count': 8, 'attention.head_count_kv': 2, 'attention.key_length': 512, 'attention.value_length': 512, 'attention.sliding_window': 512 }, [['gemma4.attention.sliding_window_pattern', 'bool[]', [true, true, true, true, true, false]]]))
    expect(kv?.kibPerToken).toBe(4) // one global layer x 2 heads x 1024 x 2 bytes
    expect(kv?.fixedMiB).toBe(10) // five window layers x 4 KiB x 512 tokens
  })

  it('flags mixture-of-experts models', () => {
    const kv = kvCache(header('qwen3moe', { block_count: 48, embedding_length: 2048, 'attention.head_count': 32, 'attention.head_count_kv': 4, expert_count: 128 }))
    expect(kv?.moe).toBe(true)
  })

  it('leaves out what it cannot model instead of guessing (latent-attention caches, no layer count)', () => {
    expect(kvCache(header('deepseek2', { block_count: 27, 'attention.head_count': 16, 'attention.kv_lora_rank': 512 }))).toBeNull()
    expect(kvCache(header('llama', { 'attention.head_count': 32 }))).toBeNull()
  })
})

describe('the ollama.com pages', () => {
  it('reads the capabilities and sizes of a family from the library listing', () => {
    const cards = parseListing(fs.readFileSync(path.join(FIXTURES, 'ollama-biblioteca-trecho.html'), 'utf8'))
    expect([...cards.keys()]).toEqual(['qwen3.5', 'gpt-oss', 'llama3.1'])
    expect(cards.get('qwen3.5')).toEqual({ caps: ['vision', 'tools', 'thinking'], sizes: ['0.8b', '2b', '4b', '9b', '27b', '35b', '122b'] })
    expect(cards.get('gpt-oss')?.caps).toEqual(['tools', 'thinking'])
    expect(cards.get('llama3.1')?.caps).toEqual(['tools'])
  })

  it('reads tag, digest, context window and input types from the tags page', () => {
    const rows = parseTags(fs.readFileSync(path.join(FIXTURES, 'ollama-tags-trecho.html'), 'utf8'), 'qwen3.5')
    expect(rows.map((row) => row.tag)).toEqual(['latest', '9b', '9b-q8_0', '0.8b'])
    const nine = rows.find((row) => row.tag === '9b')!
    expect(nine).toMatchObject({ ref: 'qwen3.5:9b', context: '256K', inputs: ['Text', 'Image'] })
    expect(nine.digest).toMatch(/^[0-9a-f]{12}$/)
    expect(rows.find((row) => row.tag === 'latest')?.digest).toBe(nine.digest) // "latest" is the same file as "9b"
  })
})

describe('which tags of a family become catalog entries', () => {
  const rows = (...tags: string[]): TagRow[] => tags.map((tag) => ({ ref: `m:${tag}`, tag, digest: tag, context: '', inputs: [] }))

  it('takes each size and ONE q8_0 build of it: the shortest tag, never a fine-tune, a base build or a draft', () => {
    const picked = pickTags(rows('latest', '9b', '9b-q8_0', '9b-mtp-q8_0', '9b-Claude-q8_0', '9b-text-q8_0', '27b', '27b-q4_K_M', '27b-q8_0', '0.8b')).map((row) => row.tag)
    expect(picked).toEqual(['9b', '27b', '0.8b', '9b-q8_0', '27b-q8_0'])
  })

  it('a family with a single size uses "latest" and its q8_0', () => {
    expect(pickTags(rows('latest', 'q8_0', 'q4_K_M', 'bf16')).map((row) => row.tag)).toEqual(['latest', 'q8_0'])
  })

  it('reads the size a tag starts with', () => {
    expect(leadingSize('9b-q8_0')).toBe('9b')
    expect(leadingSize('e4b-it-q8_0')).toBe('e4b')
    expect(leadingSize('26b-a4b-it-q8_0')).toBe('26b')
    expect(leadingSize('8x7b-v2.5-q8_0')).toBe('8x7b')
    expect(leadingSize('latest')).toBe('')
  })

  it('labels a size the way people write it', () => {
    expect(sizeLabelOf('9b')).toBe('9B')
    expect(sizeLabelOf('e4b')).toBe('E4B')
    expect(sizeLabelOf('8x7b')).toBe('8x7B')
    expect(sizeLabelOf('270m')).toBe('270M')
    expect(sizeLabelOf('1.5b')).toBe('1.5B')
    expect(sizeLabelOf('latest', '30.5B')).toBe('30.5B')
    expect(sizeLabelOf('latest', '9.0B')).toBe('9B')
  })
})

describe('the Ollama version a model needs', () => {
  it('compares part by part, numerically', () => {
    expect(versionAtLeast('0.40.11', '0.32.12')).toBe(true)
    expect(versionAtLeast('0.30.0', '0.30.0')).toBe(true)
    expect(versionAtLeast('0.30.0', '0.30.9')).toBe(false)
    expect(versionAtLeast('0.9.0', '0.30.0')).toBe(false)
    expect(versionAtLeast('1', '0.9.9')).toBe(true)
  })
})

describe('the Python rows', () => {
  const entry: CatalogEntry = {
    tag: 'qwen3.5:9b',
    family: 'qwen3.5',
    label: 'Qwen3.5',
    flags: '',
    sizeLabel: '9B',
    quant: 'Q4_K_M',
    weightsGB: 5.63,
    projectorGB: 0.92,
    kvKiB: 32,
    kvFixedMiB: 0,
    maxContext: 262144,
    arch: 'qwen35',
    moe: false,
    vision: true,
    audio: false,
    tools: true,
    thinking: true,
    license: 'Apache-2.0',
    requires: '0.30.0'
  }

  it('writes one tuple per tag, in the field order the module reads (weights include the vision projector)', () => {
    expect(pythonRow(entry)).toBe('    ("qwen3.5:9b", "Qwen3.5 9B", "Q4_K_M", 6.55, 32, 0, 262144, "vtk", "", "Apache-2.0"),')
    expect(pythonRow({ ...entry, flags: 'uc', moe: true, vision: false, thinking: false })).toContain('"tm", "uc"')
  })

  it('wraps the rows in the markers the generator rewrites', () => {
    const block = catalogBlock([entry], '2026-10-27')
    expect(block.startsWith('# <catalogo-gerado>')).toBe(true)
    expect(block.endsWith('# </catalogo-gerado>')).toBe(true)
    expect(block).toContain('CATALOG = [\n')
    expect(block).toContain('2026-10-27')
  })

  it('the block in the module is made of rows in exactly that format (nothing was edited by hand)', () => {
    const source = fs.readFileSync(MODULE, 'utf8')
    const block = /# <catalogo-gerado>([\s\S]*?)# <\/catalogo-gerado>/.exec(source)?.[1] ?? ''
    const rows = block.split('\n').filter((line) => line.startsWith('    ('))
    expect(rows.length).toBeGreaterThan(200)
    const format = /^ {4}\("[^"]+:[^"]+", "[^"]+", "[^"]+", [\d.]+, [\d.]+, \d+, \d+, "[vtkam]*", "[ucr]*", "[^"]*"\),$/
    for (const row of rows) expect(row).toMatch(format)
  })
})

describe('the families the catalog covers', () => {
  it('are unique, labelled, and flagged only with u (sem censura), c (código) and r (raciocínio)', () => {
    expect(new Set(FAMILIES.map((family) => family.name)).size).toBe(FAMILIES.length)
    for (const family of FAMILIES) {
      expect(family.label.trim()).not.toBe('')
      expect(family.flags ?? '').toMatch(/^[ucr]*$/)
    }
  })

  it('include every kind the user asked for: agents, code, reasoning and uncensored (official and community)', () => {
    const flags = FAMILIES.map((family) => family.flags ?? '')
    expect(flags.some((flag) => flag.includes('c'))).toBe(true)
    expect(flags.some((flag) => flag.includes('r'))).toBe(true)
    expect(FAMILIES.filter((family) => (family.flags ?? '').includes('u') && !family.name.includes('/')).length).toBeGreaterThanOrEqual(5)
    expect(FAMILIES.filter((family) => (family.flags ?? '').includes('u') && family.name.includes('/')).length).toBeGreaterThanOrEqual(5)
    expect(FAMILIES.some((family) => family.name === 'qwen3.5')).toBe(true)
  })

  it('every family marked as uncensored says so in its name (a model is never marked by guesswork)', () => {
    for (const family of FAMILIES.filter((item) => (item.flags ?? '').includes('u'))) {
      expect(family.name.toLowerCase()).toMatch(/abliterat|uncensor|dolphin|wizard/)
    }
  })
})
