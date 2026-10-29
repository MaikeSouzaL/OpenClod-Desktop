/**
 * Models to download: the Hugging Face GGUFs that fit this computer.
 *
 * 1. The list is the most downloaded GGUF repositories on Hugging Face (several pages), kept for 12 hours.
 * 2. Only chat models stay (the repository has a chat template) and only the architectures the llama.cpp in use opens
 *    (the names are written in its llama.dll).
 * 3. Copies of one model published by several people become one row; the best-known publisher's copy leads.
 * 4. Each model gets the best-quality quantization that fits entirely on the GPU; when none does, the one that fits
 *    splitting GPU and RAM. Sizes in the list are estimates from the parameter count; the exact ones (and the SHA-256)
 *    come from the repository's files when a model is opened or downloaded.
 *
 * Pure: the network comes in as `get`, so the tests run on recorded answers.
 */

export const HF = 'https://huggingface.co'
export const HF_API = `${HF}/api/models`
const EXPAND = ['gguf', 'pipeline_tag', 'downloads', 'cardData', 'gated', 'tags']
export const PAGE = 100
export const GENERAL_PAGES = 10
export const CACHE_HOURS = 12
export const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}$/

/** Publishers who ship GGUFs carefully: among copies of one model, the first one listed here leads. */
const TRUSTED = [
  'ggml-org', 'unsloth', 'bartowski', 'lmstudio-community', 'Qwen', 'google', 'mistralai', 'microsoft', 'meta-llama',
  'ibm-granite', 'nvidia', 'openai', 'mradermacher'
]
const VISION_PIPES = new Set(['image-text-to-text', 'any-to-any', 'video-text-to-text', 'visual-question-answering'])
/** Architectures with hybrid/linear attention or a sliding window: a much smaller KV cache per token. */
const LIGHT_KV: Record<string, number> = {
  qwen35: 0.3, qwen35moe: 0.3, qwen3next: 0.3, qwen4exp: 0.3, lfm2: 0.3, lfm2moe: 0.3, granitehybrid: 0.3, jamba: 0.3,
  mamba: 0.1, mamba2: 0.1, rwkv6: 0.1, rwkv7: 0.1, 'falcon-h1': 0.3, nemotron_h: 0.3, gemma3: 0.5, gemma3n: 0.5,
  gemma4: 0.5, cohere2: 0.5
}
/** Bits per weight of each quantization (with the embeddings' overhead), in order of preference for the automatic pick. */
export const QUANTS: Array<[quant: string, bitsPerWeight: number]> = [
  ['Q8_0', 8.7], ['Q6_K', 6.8], ['Q5_K_M', 5.9], ['Q4_K_M', 5.1], ['Q4_K_S', 4.8], ['IQ4_XS', 4.5], ['Q3_K_M', 4.1],
  ['Q3_K_S', 3.7], ['Q2_K', 3.3], ['IQ2_M', 2.9]
]
const BPW = new Map(QUANTS)
/** Below this the quality drops too much: better to split with the RAM. */
const GPU_FLOOR = 'Q3_K_M'
const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q[1-8](?:_[0-9A-Z]+)*|BF16|F16|F32|MXFP4(?:_MOE)?|TQ[12]_0))(?=[-_.]|\.gguf$)/i
const SPLIT = /-\d{5}-of-\d{5}\.gguf$/i
const NAME_SIZE = /(?<![a-z0-9.])e?(\d+(?:\.\d+)?)b(?![a-z])/i

/** A list item as kept in the cache (the full chat template is not needed, only what it supports). */
export interface HubItem {
  id?: string
  downloads?: number
  pipeline_tag?: string
  gated?: boolean | string
  tags?: string[]
  cardData?: { base_model?: string | string[]; license?: string }
  gguf?: { total?: number; architecture?: string; context_length?: number; chat_template?: string }
}

export interface HubEntry {
  repo: string
  author: string
  name: string
  /** Same key = same model published by someone else. */
  key: string
  arch: string
  /** Billions of parameters. */
  params: number
  /** The parameter count is a guess (Hugging Face counted one part of a split model, or the projector). */
  paramsGuess?: boolean
  moe: boolean
  context: number
  vision: boolean
  tools: boolean
  thinking: boolean
  downloads: number
  license: string
  gated: boolean
  /** The llama.cpp in use opens this architecture (null: unknown). */
  supported: boolean | null
  /** Repositories merged into this row, and the total downloads of all of them. */
  sources?: number
  downloadsTotal?: number
  others?: string[]
  /** Exact size of the vision projector, once the files were read. */
  mmprojBytes?: number
}

export interface Budget {
  gpu: string
  vramMiB: number
  ramMiB: number
  /** What the model may use: the VRAM minus what Windows keeps, and the RAM left for a split model. */
  vramUseMiB: number
  ramUseMiB: number
}

/** "gpu" (all on the GPU), "misto" (GPU + RAM, slower), "cpu" (no GPU, fits the RAM) or "nao". */
export type Fit = 'gpu' | 'misto' | 'cpu' | 'nao'
export const FIT_ORDER: Record<Fit, number> = { gpu: 0, misto: 1, cpu: 1, nao: 2 }

export interface QuantChoice {
  quant: string
  bytes: number
  fit: Fit
}

export interface HubFile {
  path: string
  name: string
  bytes: number
  sha256: string
  mmproj: boolean
  quant: string
}

export interface Device {
  id: string
  name: string
  totalMiB: number
  freeMiB: number
}

// ---------------------------------------------------------------- machine

/** `llama-server --list-devices`: "  Vulkan0: NVIDIA GeForce RTX 2060 (6168 MiB, 5397 MiB free)". Any vendor, not only NVIDIA. */
export function parseListDevices(text: string): Device[] {
  const out: Device[] = []
  for (const match of text.matchAll(/^\s*(\w+\d+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)/gm)) {
    out.push({ id: match[1], name: match[2], totalMiB: Number(match[3]), freeMiB: Number(match[4]) })
  }
  return out
}

/** What fits: the VRAM of the biggest GPU (llama.cpp uses one by default) minus what Windows uses, and the RAM a split model may take. */
export function budgetFrom(devices: Device[], ramMiB: number): Budget {
  const best = devices.reduce<Device | null>((top, device) => (!top || device.totalMiB > top.totalMiB ? device : top), null)
  const vram = best?.totalMiB ?? 0
  return {
    gpu: best?.name ?? '',
    vramMiB: vram,
    ramMiB,
    vramUseMiB: vram ? Math.max(vram - 700, 0) : 0,
    ramUseMiB: Math.max(Math.floor(ramMiB * 0.8) - 3072, 0)
  }
}

/** Architectures this llama.cpp opens: their names are zero-terminated strings in llama.dll. */
export function supportedArchs(dll: Buffer): Set<string> | null {
  const text = dll.toString('latin1')
  const found = new Set<string>()
  for (const match of text.matchAll(/(?<=\x00)([a-z][a-z0-9_.-]{1,30})(?=\x00)/g)) found.add(match[1])
  return found.size ? found : null
}

// ---------------------------------------------------------------- estimates

export function kvBytesPerToken(params: number, arch: string, moe: boolean): number {
  let kib = 60 + 7 * Math.min(params, 80)
  if (moe) kib = Math.min(kib, 110)
  return kib * 1024 * (LIGHT_KV[arch] ?? 1)
}

export function quantBytes(params: number, quant: string): number {
  const bpw = BPW.get(quant.replace(/^UD-/i, '').toUpperCase())
  return bpw ? Math.floor((params * 1e9 * bpw) / 8) : 0
}

const MiB = 1 << 20

/** [bytes for everything on the GPU, bytes of model + cache] for a file of `bytes`. */
function need(entry: HubEntry, bytes: number, ctx: number): [number, number] {
  const kv = kvBytesPerToken(entry.params, entry.arch, entry.moe) * ctx
  const mmproj = entry.vision ? entry.mmprojBytes || (entry.params > 30 ? 900 : 700) * MiB : 0
  const overhead = 350 * MiB + Math.floor(entry.params * 20 * MiB)
  return [bytes + kv + mmproj + overhead, bytes + kv]
}

export function fitOf(entry: HubEntry, bytes: number, ctx: number, budget: Budget): Fit {
  const [allGpu, modelKv] = need(entry, bytes, ctx)
  const vram = budget.vramUseMiB * MiB
  const ram = budget.ramUseMiB * MiB
  if (vram && allGpu <= vram) return 'gpu'
  if (modelKv <= vram + ram) return vram ? 'misto' : 'cpu'
  return 'nao'
}

/**
 * The suggested quantization: the best one that fits entirely on the GPU (Q8_0 only for small models, nothing below
 * Q3_K_M); when none does, Q4_K_M (or the biggest below it) that fits splitting with the RAM. `files` = the
 * repository's real files; without them the sizes are estimated.
 */
export function choose(entry: HubEntry, ctx: number, budget: Budget, files?: HubFile[]): QuantChoice | null {
  const options: Array<[string, number]> = files
    ? files.filter((file) => !file.mmproj && file.quant).map((file) => [file.quant, file.bytes])
    : QUANTS.map(([quant]) => [quant, quantBytes(entry.params, quant)])
  if (!options.length) return null
  const pref = QUANTS.map(([quant]) => quant).filter((quant) => quant !== 'Q8_0' || entry.params < 3)
  const rank = (quant: string): number => {
    const index = pref.indexOf(quant.replace(/^UD-/i, '').toUpperCase())
    // An Unsloth dynamic quant ("UD-Q4_K_XL" style) ranks right after the plain one of the same level.
    return (index >= 0 ? index : pref.length) + (/^UD-/i.test(quant) ? 0.5 : 0)
  }
  const ranked = [...options].sort((a, b) => rank(a[0]) - rank(b[0]))
  const floor = pref.indexOf(GPU_FLOOR)
  for (const [quant, bytes] of ranked) {
    if (rank(quant) <= floor + 0.5 && fitOf(entry, bytes, ctx, budget) === 'gpu') return { quant, bytes, fit: 'gpu' }
  }
  const start = pref.indexOf('Q4_K_M')
  for (const [quant, bytes] of ranked) {
    const fit = fitOf(entry, bytes, ctx, budget)
    if (rank(quant) >= start && rank(quant) < pref.length && fit !== 'nao') return { quant, bytes, fit }
  }
  const [quant, bytes] = options.reduce((small, option) => (option[1] < small[1] ? option : small))
  return { quant, bytes, fit: fitOf(entry, bytes, ctx, budget) }
}

// ---------------------------------------------------------------- Hugging Face

export function listUrl(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.append(key, String(value))
  for (const field of EXPAND) query.append('expand[]', field)
  return `${HF_API}?${query.toString()}`
}

/** The next page from the `Link` header, only when it points back at the same API. */
export function nextUrl(link: string | null | undefined): string | null {
  const match = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')
  return match && match[1].startsWith(`${HF_API}?`) ? match[1] : null
}

export type HubGet = (url: string) => Promise<{ body: unknown; link?: string | null }>

export async function fetchPages(url: string, pages: number, get: HubGet, cancelled?: () => boolean): Promise<HubItem[]> {
  const out: HubItem[] = []
  let next: string | null = url
  for (let page = 0; page < pages && next; page++) {
    if (cancelled?.()) throw new Error('Cancelado.')
    const { body, link } = await get(next)
    if (!Array.isArray(body)) break
    for (const item of body) if (item && typeof item === 'object') out.push(item as HubItem)
    next = nextUrl(link)
  }
  return out
}

/** The whole list, without the files' sizes: the most downloaded GGUF repositories. */
export function generalListUrl(): string {
  return listUrl({ filter: 'gguf', sort: 'downloads', direction: -1, limit: PAGE })
}

export function searchUrl(query: string): string {
  return listUrl({ search: query.slice(0, 80), filter: 'gguf', sort: 'downloads', direction: -1, limit: PAGE })
}

function capsOf(template: string): { tools: boolean; thinking: boolean } {
  return {
    tools: template.includes('tool'),
    thinking: ['enable_thinking', '<think>', 'reasoning_effort', 'reasoning_content', 'thinking'].some((needle) => template.includes(needle))
  }
}

/** What the cache keeps of an item: the template becomes markers of what it supports. */
export function slim(item: HubItem): HubItem {
  const gguf = item.gguf && typeof item.gguf === 'object' ? item.gguf : {}
  const template = typeof gguf.chat_template === 'string' ? gguf.chat_template : ''
  const caps = capsOf(template)
  const card = item.cardData && typeof item.cardData === 'object' ? item.cardData : undefined
  return {
    id: item.id,
    downloads: item.downloads,
    pipeline_tag: item.pipeline_tag,
    gated: item.gated,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string' && (tag.startsWith('base_model:') || tag === 'vision' || tag === 'image-text-to-text')) : [],
    cardData: card ? { base_model: card.base_model, license: card.license } : {},
    gguf: {
      total: gguf.total,
      architecture: gguf.architecture,
      context_length: gguf.context_length,
      chat_template: template ? `${caps.tools ? 'tool ' : ''}${caps.thinking ? '<think> ' : ''}chat` : ''
    }
  }
}

/** API item → a row of the list, or null when it is not a chat model in GGUF. */
export function normalize(item: HubItem, archs: Set<string> | null): HubEntry | null {
  const repo = typeof item.id === 'string' ? item.id : ''
  const gguf = item.gguf && typeof item.gguf === 'object' ? item.gguf : {}
  const template = typeof gguf.chat_template === 'string' ? gguf.chat_template : ''
  const total = typeof gguf.total === 'number' ? gguf.total : 0
  const arch = typeof gguf.architecture === 'string' ? gguf.architecture : ''
  if (!REPO.test(repo) || !template || total <= 0 || !arch) return null
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const card = item.cardData && typeof item.cardData === 'object' ? item.cardData : {}
  const base = Array.isArray(card.base_model) ? card.base_model[0] : card.base_model
  const quantized = tags.some((tag) => tag.startsWith('base_model:quantized:'))
  const [author, rest] = repo.split('/')
  const name = rest.replace(/[-_.](i1-)?gguf$/i, '')
  let key = (quantized && typeof base === 'string' ? base : repo.replace(/[-_.](i1-)?gguf$/i, '')).toLowerCase()
  if (key.includes('/')) key = key.slice(key.indexOf('/') + 1)
  return {
    repo,
    author,
    name,
    key,
    arch,
    params: Math.round((total / 1e9) * 100) / 100,
    moe: arch.endsWith('moe') || /\b\d+(\.\d+)?B-A\d+(\.\d+)?B\b/i.test(repo) || ['deepseek2', 'deepseek4', 'qwen4exp', 'gptoss', 'gpt-oss'].includes(arch),
    context: Number(gguf.context_length) || 0,
    vision: VISION_PIPES.has(item.pipeline_tag ?? '') || tags.includes('image-text-to-text') || tags.includes('vision'),
    ...capsOf(template),
    downloads: Number(item.downloads) || 0,
    license: typeof card.license === 'string' ? card.license : '',
    gated: item.gated !== undefined && item.gated !== false && item.gated !== 'false',
    supported: archs ? archs.has(arch) : null
  }
}

/**
 * The parameter count Hugging Face reports comes from ONE file of the repository: for a split model or a projector it
 * is far too small (1.7B for a 748B model). With a size in the name, the name wins; without one and under 10% of the
 * median of the same architecture, the median does.
 */
export function fixParams(entries: HubEntry[]): HubEntry[] {
  const byArch = new Map<string, number[]>()
  for (const entry of entries) byArch.set(entry.arch, [...(byArch.get(entry.arch) ?? []), entry.params])
  const medians = new Map([...byArch].map(([arch, values]) => [arch, [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]]))
  for (const entry of entries) {
    const named = NAME_SIZE.exec(entry.repo.split('/')[1])
    if (named) {
      const size = Number(named[1])
      if (entry.params < size * 0.4) Object.assign(entry, { params: size, paramsGuess: true })
    } else if (entry.params < (medians.get(entry.arch) ?? 0) * 0.1) {
      Object.assign(entry, { params: medians.get(entry.arch), paramsGuess: true })
    }
  }
  return entries
}

/** One row per model: the most trusted publisher's copy, then the most downloaded. Downloads are added up. */
export function merge(entries: HubEntry[]): HubEntry[] {
  const groups = new Map<string, HubEntry[]>()
  for (const entry of entries) groups.set(entry.key, [...(groups.get(entry.key) ?? []), entry])
  const priority = (entry: HubEntry): number => {
    const index = TRUSTED.indexOf(entry.author)
    return index >= 0 ? index : TRUSTED.length
  }
  const out: HubEntry[] = []
  for (const items of groups.values()) {
    items.sort((a, b) => priority(a) - priority(b) || b.downloads - a.downloads)
    const unique = new Map(items.map((item) => [item.repo, item]))
    out.push({
      ...items[0],
      sources: unique.size,
      downloadsTotal: [...unique.values()].reduce((sum, item) => sum + item.downloads, 0),
      others: [...unique.keys()].slice(1, 6)
    })
  }
  return out
}

/** The repository's whole .gguf files (split ones are left out) with size, SHA-256 and quantization. */
export function parseTree(tree: unknown): HubFile[] {
  const out: HubFile[] = []
  for (const entry of Array.isArray(tree) ? tree : []) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as { type?: unknown; path?: unknown; size?: unknown; lfs?: { oid?: unknown; sha256?: unknown; size?: unknown } }
    const file = typeof item.path === 'string' ? item.path : ''
    if (item.type !== 'file' || !/\.gguf$/i.test(file) || SPLIT.test(file)) continue
    const sha = String(item.lfs?.oid ?? item.lfs?.sha256 ?? '')
    if (!/^[0-9a-f]{64}$/.test(sha)) continue
    const name = file.split('/').pop() as string
    out.push({
      path: file,
      name,
      bytes: Number(item.size ?? item.lfs?.size) || 0,
      sha256: sha,
      mmproj: /mmproj/i.test(name),
      quant: QUANT.exec(name)?.[1].toUpperCase() ?? ''
    })
  }
  return out.sort((a, b) => Number(a.mmproj) - Number(b.mmproj) || a.bytes - b.bytes)
}

/** The vision projector: F16, then BF16, then the smallest (never F32, twice the size). */
export function pickMmproj(files: HubFile[]): HubFile | undefined {
  const projectors = files.filter((file) => file.mmproj)
  for (const want of ['F16', 'BF16']) {
    const hit = projectors.find((file) => new RegExp(`[-_.]${want}\\.gguf$`, 'i').test(file.name))
    if (hit) return hit
  }
  const candidates = projectors.filter((file) => !/F32/i.test(file.name))
  const pool = candidates.length ? candidates : projectors
  return pool.reduce<HubFile | undefined>((small, file) => (!small || file.bytes < small.bytes ? file : small), undefined)
}

export function resolveUrl(repo: string, file: string): string {
  return `${HF}/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`
}

/** API name of a downloaded repository's model: "unsloth/Qwen3-8B-GGUF" → "qwen3-8b". */
export function repoAlias(repo: string): string {
  const name = (repo.split('/')[1] ?? repo).replace(/[-_.](i1-)?gguf$/i, '')
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'modelo'
}
