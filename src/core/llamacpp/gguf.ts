import fs from 'node:fs'

/**
 * GGUF metadata (the header only; the weights are never read). Format: "GGUF", version (u32), tensor count (u64), pair
 * count (u64), then key/value pairs. The big arrays (the vocabulary) are skipped without building them, and the KV-cache
 * math reads the same keys as scripts/colab-catalog.mjs, so the "fits on this GPU" answer is the one the Colab notebook
 * gives for the same model.
 */

export class GgufError extends Error {}

/** Random access to the bytes of a GGUF: a file on disk, or a buffer in the tests. */
export interface ByteSource {
  size: number
  read(position: number, length: number): Buffer
}

export function bufferSource(buffer: Buffer): ByteSource {
  return { size: buffer.length, read: (position, length) => buffer.subarray(position, position + length) }
}

export function fileSource(fd: number, size: number): ByteSource {
  return {
    size,
    read(position, length) {
      const out = Buffer.alloc(length)
      const read = fs.readSync(fd, out, 0, length, position)
      return out.subarray(0, read)
    }
  }
}

const CHUNK = 1 << 20
/** A chat template is a few KB; more than this is not a template we want to hold. */
const MAX_STRING = 4 * 1024 * 1024

/** Reads forward through the header, one 1 MiB block at a time: skipping the vocabulary does not hit the disk per token. */
class Cursor {
  private chunk: Buffer = Buffer.alloc(0)
  private chunkStart = 0
  position = 0

  constructor(private readonly source: ByteSource) {}

  take(length: number): Buffer {
    if (this.position + length > this.source.size) throw new GgufError('arquivo GGUF cortado')
    const end = this.position + length
    if (this.position < this.chunkStart || end > this.chunkStart + this.chunk.length) {
      this.chunk = this.source.read(this.position, Math.min(Math.max(length, CHUNK), this.source.size - this.position))
      this.chunkStart = this.position
      if (this.chunk.length < length) throw new GgufError('arquivo GGUF cortado')
    }
    const slice = this.chunk.subarray(this.position - this.chunkStart, end - this.chunkStart)
    this.position = end
    return slice
  }

  skip(length: number): void {
    if (this.position + length > this.source.size) throw new GgufError('arquivo GGUF cortado')
    this.position += length
  }

  u32(): number {
    return this.take(4).readUInt32LE(0)
  }

  u64(): number {
    return Number(this.take(8).readBigUInt64LE(0))
  }

  string(keep: boolean): string | undefined {
    const length = this.u64()
    if (!keep) {
      this.skip(length)
      return undefined
    }
    if (length > MAX_STRING) throw new GgufError('texto grande demais no GGUF')
    return this.take(length).toString('utf8')
  }
}

const SCALAR_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
const STRING = 8
const ARRAY = 9

function scalar(cursor: Cursor, type: number): number | boolean {
  const bytes = cursor.take(SCALAR_SIZE[type])
  switch (type) {
    case 0: return bytes.readUInt8(0)
    case 1: return bytes.readInt8(0)
    case 2: return bytes.readUInt16LE(0)
    case 3: return bytes.readInt16LE(0)
    case 4: return bytes.readUInt32LE(0)
    case 5: return bytes.readInt32LE(0)
    case 6: return bytes.readFloatLE(0)
    case 7: return bytes.readUInt8(0) !== 0
    case 10: return Number(bytes.readBigUInt64LE(0))
    case 11: return Number(bytes.readBigInt64LE(0))
    default: return bytes.readDoubleLE(0)
  }
}

/** Reads (keep) or jumps over (skip) one value of `type`. Arrays are only built when kept. */
function value(cursor: Cursor, type: number, keep: boolean): unknown {
  if (type in SCALAR_SIZE) {
    if (keep) return scalar(cursor, type)
    cursor.skip(SCALAR_SIZE[type])
    return undefined
  }
  if (type === STRING) return cursor.string(keep)
  if (type === ARRAY) {
    const itemType = cursor.u32()
    const count = cursor.u64()
    if (!keep) {
      if (itemType in SCALAR_SIZE) cursor.skip(SCALAR_SIZE[itemType] * count)
      else for (let index = 0; index < count; index++) value(cursor, itemType, false)
      return undefined
    }
    const out: unknown[] = []
    for (let index = 0; index < count; index++) out.push(value(cursor, itemType, true))
    return out
  }
  throw new GgufError(`tipo de valor desconhecido no GGUF (${type})`)
}

/** general.file_type (llama_ftype) → quantization name. */
export const FILE_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M',
  13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS',
  21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S',
  29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4'
}

const GENERAL = new Set(['general.architecture', 'general.name', 'general.basename', 'general.size_label', 'general.file_type', 'general.type', 'split.count'])
/** Per-architecture keys the summary and the KV-cache math need (same set as scripts/colab-catalog.mjs). */
const ARCH_KEY =
  /\.(block_count|context_length|embedding_length|expert_count|expert_used_count|full_attention_interval|rope\.dimension_count|ssm\.[\w.]+|attention\.(head_count|head_count_kv|key_length|value_length|sliding_window|sliding_window_pattern|layer_types|kv_lora_rank|key_length_mla))$/
/** Per-layer arrays the KV math needs whole (hybrids give 0 KV heads to layers without attention). */
const FULL_ARRAY = /\.(attention\.head_count_kv|attention\.head_count|attention\.sliding_window_pattern|attention\.layer_types)$/

export type GgufMetadata = Record<string, unknown>

/** The metadata the app uses. GgufError when the bytes are not a GGUF. */
export function readGgufMetadata(source: ByteSource, options: { template?: boolean } = {}): GgufMetadata {
  const cursor = new Cursor(source)
  if (cursor.take(4).toString('ascii') !== 'GGUF') throw new GgufError('não é um arquivo GGUF')
  const version = cursor.u32()
  if (version < 2) throw new GgufError(`GGUF antigo demais (versão ${version})`)
  cursor.u64() // tensors
  const pairs = cursor.u64()
  const meta: GgufMetadata = { 'gguf.version': version }
  for (let index = 0; index < pairs; index++) {
    const key = cursor.string(true) ?? ''
    const type = cursor.u32()
    const isTemplate = key === 'tokenizer.chat_template'
    const wanted = GENERAL.has(key) || ARCH_KEY.test(key) || (isTemplate && options.template !== false)
    const keep = wanted && (type !== ARRAY || FULL_ARRAY.test(key))
    const read = value(cursor, type, keep)
    if (keep && read !== undefined) meta[key] = read
  }
  return meta
}

/** Opens a .gguf on disk and reads its metadata (only the header is read). */
export function readGgufFile(file: string, options: { template?: boolean } = {}): GgufMetadata {
  const fd = fs.openSync(file, 'r')
  try {
    return readGgufMetadata(fileSource(fd, fs.fstatSync(fd).size), options)
  } finally {
    fs.closeSync(fd)
  }
}

export interface KvCache {
  /** KV cache per token of context, KiB, f16. */
  kibPerToken: number
  /** The part that does not grow with the context (sliding-window layers keep only their window), MiB. */
  fixedMiB: number
  maxContext: number
  arch: string
  moe: boolean
}

/** Architectures whose sliding-window pattern is not in the file (the engines hard-code it): window layers per `n` layers. */
const SWA_PATTERN_BY_ARCH: Record<string, number> = { gemma3: 6, 'gpt-oss': 2 }

/**
 * KV cache of one token, for an f16 cache, plus the context-independent part. Ported unchanged from
 * scripts/colab-catalog.mjs (dense, grouped-query, per-layer KV-head arrays, "full attention every N layers" hybrids,
 * sliding windows). Unknown shapes — latent (MLA) caches, no layer count — return null instead of a guess.
 */
export function kvCache(meta: GgufMetadata): KvCache | null {
  const arch = meta['general.architecture']
  if (typeof arch !== 'string') return null
  const get = (key: string): unknown => meta[`${arch}.${key}`]
  const num = (key: string): number | undefined => {
    const raw = get(key)
    return typeof raw === 'number' ? raw : undefined
  }
  const layers = num('block_count')
  if (!layers) return null
  if (get('attention.kv_lora_rank')) return null
  const heads = get('attention.head_count') as number | number[] | undefined
  const embedding = num('embedding_length')
  const headsKv = (get('attention.head_count_kv') ?? heads) as number | number[] | undefined
  const pick = (list: number | number[] | undefined, layer: number): number =>
    Array.isArray(list) ? (list[layer] ?? list[list.length - 1] ?? 0) : (list ?? 0)
  const keyLength = num('attention.key_length') ?? (embedding && pick(heads, 0) ? embedding / pick(heads, 0) : 0)
  const valueLength = num('attention.value_length') ?? keyLength
  if (!keyLength || (!Array.isArray(headsKv) && !pick(headsKv, 0))) return null
  const bytesPerLayer = (layer: number): number => (pick(headsKv, layer) || 0) * (keyLength + valueLength) * 2
  const interval = num('full_attention_interval')
  const window = num('attention.sliding_window')
  const pattern = get('attention.sliding_window_pattern')
  const archPattern = SWA_PATTERN_BY_ARCH[arch]
  const isSliding = (layer: number): boolean => {
    if (!window) return false
    if (Array.isArray(pattern)) return Boolean(pattern[layer])
    return archPattern ? layer % archPattern !== archPattern - 1 : false
  }
  let perToken = 0
  let fixed = 0
  for (let layer = 0; layer < layers; layer++) {
    if (interval && !Array.isArray(headsKv) && (layer + 1) % interval !== 0) continue
    if (isSliding(layer)) fixed += bytesPerLayer(layer) * (window ?? 0)
    else perToken += bytesPerLayer(layer)
  }
  return { kibPerToken: perToken / 1024, fixedMiB: fixed / 1048576, maxContext: num('context_length') ?? 0, arch, moe: (num('expert_count') ?? 0) > 1 }
}

export interface GgufSummary {
  arch: string
  name: string
  sizeLabel: string
  quant: string
  /** Training context, tokens. */
  context: number
  layers: number
  experts: number
  /** A vision projector (mmproj), not a model you chat with. */
  mmproj: boolean
  /** The chat template knows tools / thinking. */
  tools: boolean
  thinking: boolean
  /** Number of parts when the model is split across files (`-00001-of-00003.gguf`); 0 for one file. */
  split: number
  kv: KvCache | null
}

/** What the screens show about a GGUF: architecture, size, quantization, context, and what its chat template supports. */
export function summarize(meta: GgufMetadata): GgufSummary {
  const text = (key: string): string => (typeof meta[key] === 'string' ? (meta[key] as string) : '')
  const arch = text('general.architecture')
  const archNumber = (suffix: string): number => {
    const raw = meta[`${arch}.${suffix}`]
    return typeof raw === 'number' ? raw : 0
  }
  const template = text('tokenizer.chat_template')
  const fileType = meta['general.file_type']
  return {
    arch,
    name: text('general.name') || text('general.basename'),
    sizeLabel: text('general.size_label'),
    quant: typeof fileType === 'number' ? (FILE_TYPES[fileType] ?? '') : '',
    context: archNumber('context_length'),
    layers: archNumber('block_count'),
    experts: archNumber('expert_count'),
    mmproj: arch === 'clip' || text('general.type') === 'mmproj',
    tools: /tool/.test(template),
    thinking: /enable_thinking|<think>|reasoning_effort|thinking/.test(template),
    split: typeof meta['split.count'] === 'number' ? (meta['split.count'] as number) : 0,
    kv: kvCache(meta)
  }
}
