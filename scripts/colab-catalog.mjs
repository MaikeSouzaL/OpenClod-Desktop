#!/usr/bin/env node
// The model catalog the Google Colab notebook shows ("modelos abertos que cabem nesta GPU"), built from OFFICIAL sources and never
// typed by hand. For each family listed in FAMILIES below (the only thing curated here: WHICH families, not any number):
//   - ollama.com listing pages: the capabilities of each family (tools / vision / thinking / audio);
//   - ollama.com/<family>/tags: the tags, their input types (Text, Image, Audio) and context window;
//   - registry.ollama.ai: the manifest of each tag (exact size of the weights file and of the vision projector, quantization, license);
//   - the GGUF header of each weights file (HTTP Range request): layers, KV heads, head size, context length and, when the model has
//     them, sliding-window or hybrid attention => the KV cache per token that the fit calculation needs.
//
//   node scripts/colab-catalog.mjs                 -> prints a summary (nothing is written)
//   node scripts/colab-catalog.mjs --write         -> rewrites the CATALOG block of resources/colab/openclod_llm_server.py
//   node scripts/colab-catalog.mjs --only qwen3.5,dolphin3 --dump <file.json>   -> raw measurements of those families
//   node scripts/colab-catalog.mjs --cache <dir>   -> keeps the pages and headers it downloads (re-runs are instant)
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_FILE = path.join(ROOT, 'resources', 'colab', 'openclod_llm_server.py')
const REGISTRY = 'https://registry.ollama.ai/v2'
const UA = 'openclod-colab-catalog/1 (+https://github.com/ollama/ollama)'
/** Weights above this never fit the biggest Colab GPU (96 GB) with room for the KV cache and the buffers. */
const MAX_GB = 90

/**
 * The families the catalog covers. Flags: u = sem censura (uncensored / abliterated), c = código, r = raciocínio.
 * `label` is how the notebook calls the family. Everything else (sizes, capabilities, memory) is measured.
 */
export const FAMILIES = [
  // --- agentes e gerais com ferramentas (e visão onde há) ---
  { name: 'qwen3.8', label: 'Qwen3.8' },
  { name: 'qwen3.6', label: 'Qwen3.6' },
  { name: 'qwen3.5', label: 'Qwen3.5' },
  { name: 'qwen3', label: 'Qwen3' },
  { name: 'qwen3-vl', label: 'Qwen3-VL' },
  { name: 'gemma4', label: 'Gemma 4' },
  { name: 'gemma3', label: 'Gemma 3' },
  { name: 'gpt-oss', label: 'gpt-oss' },
  { name: 'nemotron-3-nano', label: 'Nemotron 3 Nano' },
  { name: 'glm-4.7-flash', label: 'GLM-4.7-Flash' },
  { name: 'ministral-3', label: 'Ministral 3' },
  { name: 'mistral-small3.2', label: 'Mistral Small 3.2' },
  { name: 'mistral-nemo', label: 'Mistral Nemo' },
  { name: 'llama3.3', label: 'Llama 3.3' },
  { name: 'llama3.1', label: 'Llama 3.1' },
  { name: 'llama3.2', label: 'Llama 3.2' },
  { name: 'llama3.2-vision', label: 'Llama 3.2 Vision' },
  { name: 'phi4-mini', label: 'Phi-4 mini' },
  { name: 'phi4', label: 'Phi-4' },
  { name: 'granite4', label: 'Granite 4' },
  { name: 'smollm2', label: 'SmolLM2' },
  { name: 'cogito', label: 'Cogito' },
  { name: 'hermes3', label: 'Hermes 3' },
  { name: 'olmo2', label: 'OLMo 2' },
  { name: 'minicpm-v', label: 'MiniCPM-V' },
  { name: 'llama4', label: 'Llama 4' },
  { name: 'qwen3-next', label: 'Qwen3-Next' },
  { name: 'nemotron-3-super', label: 'Nemotron 3 Super' },
  { name: 'gemma3n', label: 'Gemma 3n' },
  { name: 'command-r', label: 'Command R' },
  { name: 'command-r7b', label: 'Command R7B' },
  { name: 'aya-expanse', label: 'Aya Expanse' },
  { name: 'exaone3.5', label: 'EXAONE 3.5' },
  { name: 'falcon3', label: 'Falcon 3' },
  { name: 'lfm2', label: 'LFM2' },
  { name: 'lfm2.5', label: 'LFM2.5' },
  // --- código ---
  { name: 'qwen3-coder', label: 'Qwen3-Coder', flags: 'c' },
  { name: 'qwen3-coder-next', label: 'Qwen3-Coder-Next', flags: 'c' },
  { name: 'qwen2.5-coder', label: 'Qwen2.5-Coder', flags: 'c' },
  { name: 'devstral-small-2', label: 'Devstral Small 2', flags: 'c' },
  { name: 'devstral', label: 'Devstral', flags: 'c' },
  { name: 'codestral', label: 'Codestral', flags: 'c' },
  // --- raciocínio ---
  { name: 'deepseek-r1', label: 'DeepSeek-R1 (destilados)', flags: 'r' },
  { name: 'qwq', label: 'QwQ', flags: 'r' },
  { name: 'magistral', label: 'Magistral', flags: 'r' },
  { name: 'phi4-reasoning', label: 'Phi-4 reasoning', flags: 'r' },
  { name: 'lfm2.5-thinking', label: 'LFM2.5 Thinking', flags: 'r' },
  { name: 'exaone-deep', label: 'EXAONE Deep', flags: 'r' },
  { name: 'openthinker', label: 'OpenThinker', flags: 'r' },
  // --- sem censura: biblioteca oficial do Ollama ---
  { name: 'dolphin3', label: 'Dolphin 3', flags: 'u' },
  { name: 'dolphin-llama3', label: 'Dolphin Llama 3', flags: 'u' },
  { name: 'dolphin-mistral', label: 'Dolphin Mistral', flags: 'u' },
  { name: 'dolphin-mixtral', label: 'Dolphin Mixtral', flags: 'u' },
  { name: 'dolphincoder', label: 'DolphinCoder', flags: 'uc' },
  { name: 'llama2-uncensored', label: 'Llama 2 Uncensored', flags: 'u' },
  { name: 'wizard-vicuna-uncensored', label: 'Wizard Vicuna Uncensored', flags: 'u' },
  { name: 'wizardlm-uncensored', label: 'WizardLM Uncensored', flags: 'u' },
  // --- sem censura: comunidade (huihui_ai é a publicação de modelos "abliterated" mais baixada do Ollama; orcarouter tem a versão
  //     sem censura mais baixada do Qwen3.8). Qualquer outra etiqueta pode ser digitada em `modelo_manual`. ---
  { name: 'huihui_ai/Qwen3.8-abliterated', label: 'Qwen3.8 abliterated', flags: 'u' },
  { name: 'huihui_ai/Qwen3.6-abliterated', label: 'Qwen3.6 abliterated', flags: 'u' },
  { name: 'huihui_ai/qwen3.5-abliterated', label: 'Qwen3.5 abliterated', flags: 'u' },
  { name: 'huihui_ai/qwen3-abliterated', label: 'Qwen3 abliterated', flags: 'u' },
  { name: 'huihui_ai/qwen3-vl-abliterated', label: 'Qwen3-VL abliterated', flags: 'u' },
  { name: 'huihui_ai/gemma-4-abliterated', label: 'Gemma 4 abliterated', flags: 'u' },
  { name: 'huihui_ai/gemma3-abliterated', label: 'Gemma 3 abliterated', flags: 'u' },
  { name: 'huihui_ai/gpt-oss-abliterated', label: 'gpt-oss abliterated', flags: 'u' },
  { name: 'huihui_ai/glm-4.7-flash-abliterated', label: 'GLM-4.7-Flash abliterated', flags: 'u' },
  { name: 'huihui_ai/qwen2.5-coder-abliterate', label: 'Qwen2.5-Coder abliterated', flags: 'uc' },
  { name: 'huihui_ai/devstral-abliterated', label: 'Devstral abliterated', flags: 'uc' },
  { name: 'huihui_ai/mistral-small-abliterated', label: 'Mistral Small abliterated', flags: 'u' },
  { name: 'huihui_ai/llama3.3-abliterated', label: 'Llama 3.3 abliterated', flags: 'u' },
  { name: 'huihui_ai/deepseek-r1-abliterated', label: 'DeepSeek-R1 abliterated', flags: 'ur' },
  { name: 'huihui_ai/dolphin3-abliterated', label: 'Dolphin 3 abliterated', flags: 'u' },
  { name: 'huihui_ai/phi4-mini-abliterated', label: 'Phi-4 mini abliterated', flags: 'u' },
  // Mais sem censura do huihui_ai (2026-10-28, a pedido do usuário): as famílias da página do publicador que faltavam.
  { name: 'huihui_ai/qwen3-coder-abliterated', label: 'Qwen3-Coder abliterated', flags: 'uc' },
  { name: 'huihui_ai/qwen3-coder-next-abliterated', label: 'Qwen3-Coder-Next abliterated', flags: 'uc' },
  { name: 'huihui_ai/qwen3-next-abliterated', label: 'Qwen3-Next abliterated', flags: 'u' },
  { name: 'huihui_ai/qwen2.5-abliterate', label: 'Qwen2.5 abliterated', flags: 'u' },
  { name: 'huihui_ai/qwen2.5-vl-abliterated', label: 'Qwen2.5-VL abliterated', flags: 'u' },
  { name: 'huihui_ai/qwq-abliterated', label: 'QwQ abliterated', flags: 'ur' },
  { name: 'huihui_ai/llama3.2-abliterate', label: 'Llama 3.2 abliterated', flags: 'u' },
  { name: 'huihui_ai/Hermes-3-Llama-3.2-abliterated', label: 'Hermes 3 (Llama 3.2) abliterated', flags: 'u' },
  { name: 'huihui_ai/deephermes3-abliterated', label: 'DeepHermes 3 abliterated', flags: 'ur' },
  { name: 'huihui_ai/phi4-abliterated', label: 'Phi-4 abliterated', flags: 'u' },
  { name: 'huihui_ai/phi4-reasoning-abliterated', label: 'Phi-4 reasoning abliterated', flags: 'ur' },
  { name: 'huihui_ai/magistral-abliterated', label: 'Magistral abliterated', flags: 'ur' },
  { name: 'huihui_ai/exaone3.5-abliterated', label: 'EXAONE 3.5 abliterated', flags: 'u' },
  { name: 'huihui_ai/granite4.1-abliterated', label: 'Granite 4.1 abliterated', flags: 'u' },
  { name: 'huihui_ai/granite3.2-vision-abliterated', label: 'Granite 3.2 Vision abliterated', flags: 'u' },
  { name: 'huihui_ai/aya-expanse-abliterated', label: 'Aya Expanse abliterated', flags: 'u' },
  { name: 'huihui_ai/nemotron-abliterated', label: 'Nemotron abliterated', flags: 'u' },
  { name: 'huihui_ai/acereason-nemotron-abliterated', label: 'AceReason-Nemotron abliterated', flags: 'ur' },
  { name: 'huihui_ai/openthinker-abliterated', label: 'OpenThinker abliterated', flags: 'ur' },
  { name: 'huihui_ai/dolphin3-r1-abliterated', label: 'Dolphin 3 R1 abliterated', flags: 'ur' },
  { name: 'huihui_ai/lfm2.5-abliterated', label: 'LFM2.5 abliterated', flags: 'u' },
  { name: 'huihui_ai/seed-coder-abliterate', label: 'Seed-Coder abliterated', flags: 'uc' },
  { name: 'huihui_ai/jan-nano-abliterated', label: 'Jan-nano abliterated', flags: 'u' },
  { name: 'orcarouter/Qwen3.8-27B-Uncensored', label: 'Qwen3.8 Uncensored (orcarouter)', flags: 'u' }
]

/* ------------------------------------------------------------------ download (with an optional disk cache) ------------------------------------------------------------------ */

let cacheDir = ''

function cached(key, make) {
  if (!cacheDir) return make()
  const file = path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex'))
  if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file))
  return make().then((data) => {
    fs.writeFileSync(file, data)
    return data
  })
}

async function http(url, { headers = {}, timeoutMs = 60000, retries = 3 } = {}) {
  let last
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      if (res.status === 404) throw Object.assign(new Error(`HTTP 404 ${url}`), { status: 404 })
      if (headers.range && res.status !== 206) {
        // A server that ignores Range would send the whole weights file (many GB): never read that body.
        await res.body?.cancel()
        throw Object.assign(new Error(`o servidor ignorou o Range (HTTP ${res.status}) ${url}`), { status: 404 })
      }
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status} ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      last = err
      if (err.status === 404) throw err
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
    }
  }
  throw last
}

const text = (url, options) => cached(`T ${url}`, () => http(url, options)).then((buf) => buf.toString('utf8'))

async function pool(items, size, work) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await work(items[index], index)
      }
    })
  )
  return out
}

/* ------------------------------------------------------------------ ollama.com pages ------------------------------------------------------------------ */

/** The cards of a listing page (library or a namespace): name -> capabilities and sizes. */
export function parseListing(html) {
  const cards = new Map()
  for (const part of html.split(/(?=<a\s+href="\/[A-Za-z0-9._/-]+"\s+class="group w-full)/)) {
    const link = /^<a\s+href="\/((?:library\/)?[A-Za-z0-9._/-]+)"/.exec(part)
    if (!link) continue
    const name = link[1].replace(/^library\//, '')
    const caps = [...part.matchAll(/<span\s+class="inline-flex items-center rounded-md bg-indigo-50[^"]*">([^<]+)<\/span>/g)].map((m) => m[1].trim())
    const sizes = [...part.matchAll(/<span\s+class="inline-flex items-center rounded-md bg-\[#ddf4ff\][^"]*">([^<]+)<\/span>/g)].map((m) => m[1].trim())
    cards.set(name, { caps, sizes })
  }
  return cards
}

/** The rows of a /tags page: tag, digest, listed size, context window and input types. */
export function parseTags(html, family) {
  const rows = []
  const seen = new Set()
  for (const part of html.split(/(?=<a\s+href="\/[^"]+:[^"]+"\s+class="md:hidden)/)) {
    const link = /^<a\s+href="\/(?:library\/)?([^"]+:[^"]+)"\s+class="md:hidden/.exec(part)
    if (!link) continue
    const full = link[1]
    if (seen.has(full)) continue
    seen.add(full)
    const flat = part.slice(0, part.indexOf('</a>')).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    const digest = /\b([0-9a-f]{12})\b/.exec(flat)
    const context = /(\d+(?:\.\d+)?[KM]) context window/.exec(flat)
    const inputs = /•\s*([A-Za-z, ]+?) input/.exec(flat)
    rows.push({
      ref: full,
      tag: full.slice(full.indexOf(':') + 1),
      digest: digest ? digest[1] : '',
      context: context ? context[1] : '',
      inputs: inputs ? inputs[1].split(',').map((item) => item.trim()) : []
    })
  }
  return rows.filter((row) => row.ref.startsWith(`${family}:`))
}

function contextNumber(label) {
  const m = /^(\d+(?:\.\d+)?)([KM])$/.exec(label)
  return m ? Math.round(Number(m[1]) * (m[2] === 'M' ? 1048576 : 1024)) : 0
}

/* ------------------------------------------------------------------ registry ------------------------------------------------------------------ */

async function manifest(family, tag) {
  const repo = family.includes('/') ? family : `library/${family}`
  const raw = await cached(`M ${repo}:${tag}`, () => http(`${REGISTRY}/${repo}/manifests/${tag}`, { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } }))
  const json = JSON.parse(raw.toString('utf8'))
  const layer = (kind) => json.layers.find((item) => item.mediaType === `application/vnd.ollama.image.${kind}`)
  const configRaw = await cached(`C ${json.config.digest}`, () => http(`${REGISTRY}/${repo}/blobs/${json.config.digest}`))
  return { repo, config: JSON.parse(configRaw.toString('utf8')), model: layer('model'), projector: layer('projector'), license: layer('license') }
}

async function licenseName(repo, layer) {
  if (!layer) return ''
  const head = await cached(`L ${layer.digest}`, () => http(`${REGISTRY}/${repo}/blobs/${layer.digest}`, { headers: { range: 'bytes=0-1999' } })).then((buf) => buf.toString('utf8'))
  const flat = head.replace(/\s+/g, ' ')
  if (/Apache License/i.test(flat)) return 'Apache-2.0'
  if (/\bMIT License/i.test(flat)) return 'MIT'
  if (/Llama.{0,40}Community License|LLAMA \d.{0,40}COMMUNITY LICENSE/i.test(flat)) return 'Licença Llama'
  if (/Gemma (Terms|Prohibited)/i.test(flat)) return 'Termos do Gemma'
  if (/Qwen.{0,20}LICENSE/i.test(flat)) return 'Licença Qwen'
  if (/Mistral (AI )?Research/i.test(flat)) return 'Mistral Research'
  if (/Creative Commons|CC BY/i.test(flat)) return 'Creative Commons'
  if (/OpenRAIL|RAIL/i.test(flat)) return 'OpenRAIL'
  return 'ver a página do modelo'
}

/* ------------------------------------------------------------------ GGUF header ------------------------------------------------------------------ */

class NeedMore extends Error {}

/** Architectures whose sliding-window pattern is not in the file (the engines hard-code it): window layers per `n` layers. */
const SWA_PATTERN_BY_ARCH = { gemma3: 6, 'gpt-oss': 2 }

/** "0.32.12" >= "0.30.0"? (numeric, part by part) */
export function versionAtLeast(version, minimum) {
  const a = String(version).split('.').map(Number)
  const b = String(minimum).split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return true
}

/** The Ollama version the notebook installs (the module is the single source of that pin). */
function pinnedOllama() {
  const match = /^OLLAMA_VERSION = "([\d.]+)"/m.exec(fs.readFileSync(MODULE_FILE, 'utf8'))
  if (!match) throw new Error('OLLAMA_VERSION não encontrada no módulo')
  return match[1]
}

const FULL_ARRAY = /\.(attention\.head_count_kv|attention\.head_count|attention\.sliding_window_pattern|attention\.layer_types)$/
const KEEP = /^(general\.(architecture|size_label)|.*\.(block_count|context_length|embedding_length|attention\.(head_count|head_count_kv|key_length|value_length|sliding_window|sliding_window_pattern|layer_types|kv_lora_rank|key_length_mla)|full_attention_interval|rope\.dimension_count|ssm\..*|expert_count|expert_used_count))$/

/** Parses the metadata of a GGUF file up to the tokenizer (where the huge arrays start). Returns only the keys the memory math needs. */
export function parseGgufHeader(buf) {
  let o = 0
  const need = (n) => {
    if (o + n > buf.length) throw new NeedMore()
  }
  const u32 = () => (need(4), (o += 4), buf.readUInt32LE(o - 4))
  const u64 = () => (need(8), (o += 8), Number(buf.readBigUInt64LE(o - 8)))
  const str = () => {
    const n = u64()
    need(n)
    o += n
    return buf.toString('utf8', o - n, o)
  }
  const value = (type, keep) => {
    switch (type) {
      case 0: return (need(1), buf.readUInt8(o++))
      case 1: return (need(1), buf.readInt8(o++))
      case 2: return (need(2), (o += 2), buf.readUInt16LE(o - 2))
      case 3: return (need(2), (o += 2), buf.readInt16LE(o - 2))
      case 4: return u32()
      case 5: return (need(4), (o += 4), buf.readInt32LE(o - 4))
      case 6: return (need(4), (o += 4), buf.readFloatLE(o - 4))
      case 7: return (need(1), buf.readUInt8(o++) !== 0)
      case 8: return str()
      case 9: {
        const elementType = u32()
        const count = u64()
        const out = []
        for (let i = 0; i < count; i++) {
          const v = value(elementType, keep)
          if (keep) out.push(v)
        }
        return keep ? out : { count }
      }
      case 10: return u64()
      case 11: return (need(8), (o += 8), Number(buf.readBigInt64LE(o - 8)))
      case 12: return (need(8), (o += 8), buf.readDoubleLE(o - 8))
      default: throw new Error(`GGUF: tipo ${type} desconhecido`)
    }
  }
  need(24)
  if (buf.toString('ascii', 0, 4) !== 'GGUF') throw new Error('não é um arquivo GGUF')
  o = 4
  u32() // version
  u64() // tensor count
  const entries = u64()
  const kv = {}
  for (let i = 0; i < entries; i++) {
    const key = str()
    const type = u32()
    if (key.startsWith('tokenizer.') && type === 9) {
      kv._complete = true
      break
    }
    const keep = KEEP.test(key) && (type !== 9 || FULL_ARRAY.test(key))
    const v = value(type, keep || type !== 9)
    if (KEEP.test(key)) kv[key] = v
  }
  return kv
}

async function ggufHeader(repo, digest) {
  const url = `${REGISTRY}/${repo}/blobs/${digest}`
  let size = 256 * 1024
  for (let attempt = 0; attempt < 6; attempt++) {
    const buf = await cached(`G ${digest} ${size}`, () => http(url, { headers: { range: `bytes=0-${size - 1}` }, timeoutMs: 120000 }))
    try {
      return parseGgufHeader(buf)
    } catch (err) {
      if (!(err instanceof NeedMore)) throw err
      size *= 4
    }
  }
  throw new Error('cabeçalho GGUF grande demais')
}

/**
 * KV cache of one token, in KiB, for an f16 cache; plus the part that does not grow with the context (sliding-window layers keep only
 * their window). Handles dense attention, grouped-query attention, per-layer KV-head arrays (hybrids use 0 for layers without KV),
 * "full attention every N layers" hybrids and sliding-window patterns. Unknown shapes return null (the entry is left out, not guessed).
 */
export function kvCache(kv) {
  const arch = kv['general.architecture']
  const get = (key) => kv[`${arch}.${key}`]
  const layers = get('block_count')
  if (!arch || !layers) return null
  if (get('attention.kv_lora_rank')) return null // latent (MLA) caches: a different formula, not modelled here
  const heads = get('attention.head_count')
  const embedding = get('embedding_length')
  const headsKv = get('attention.head_count_kv') ?? heads
  const perLayerHeads = (layer) => (Array.isArray(headsKv) ? headsKv[layer] ?? headsKv[headsKv.length - 1] : headsKv)
  const headsAtLayer = (layer) => (Array.isArray(heads) ? heads[layer] ?? heads[heads.length - 1] : heads)
  const keyLength = get('attention.key_length') ?? (embedding && headsAtLayer(0) ? embedding / headsAtLayer(0) : 0)
  const valueLength = get('attention.value_length') ?? keyLength
  if (!keyLength || (!Array.isArray(headsKv) && !perLayerHeads(0))) return null
  const bytesPerLayer = (layer) => (perLayerHeads(layer) || 0) * (keyLength + valueLength) * 2
  const interval = get('full_attention_interval')
  const window = get('attention.sliding_window')
  const pattern = get('attention.sliding_window_pattern')
  // Some architectures do not write the pattern: the engines hard-code it (llama.cpp set_swa_pattern: layer `il` is a sliding-window
  // layer when il % n < n - 1). Gemma 3 is 5 local : 1 global, gpt-oss alternates.
  const archPattern = SWA_PATTERN_BY_ARCH[arch]
  const isSliding = (layer) => {
    if (!window) return false
    if (Array.isArray(pattern)) return Boolean(pattern[layer])
    return archPattern ? layer % archPattern !== archPattern - 1 : false
  }
  let perToken = 0
  let fixed = 0
  for (let layer = 0; layer < layers; layer++) {
    if (interval && !Array.isArray(headsKv) && (layer + 1) % interval !== 0) continue // linear-attention layers keep no KV cache
    if (isSliding(layer)) fixed += bytesPerLayer(layer) * window
    else perToken += bytesPerLayer(layer)
  }
  return { kibPerToken: perToken / 1024, fixedMiB: fixed / 1048576, maxContext: get('context_length') ?? 0, arch, moe: (get('expert_count') || 0) > 1 }
}

/* ------------------------------------------------------------------ one family ------------------------------------------------------------------ */

const SIZE_TAG = /^(\d+(?:\.\d+)?[bm]|e\d+b|\d+x\d+b)$/i

/** "9b" -> "9B", "e4b" -> "E4B", "8x7b" -> "8x7B", "270m" -> "270M"; a tag without a size ("latest") uses the parameter count the file declares. */
export function sizeLabelOf(tag, modelType) {
  const lower = String(tag).toLowerCase()
  if (/^e\d+b$/.test(lower)) return `E${lower.slice(1, -1)}B`
  const moe = /^(\d+)x(\d+(?:\.\d+)?)b$/.exec(lower)
  if (moe) return `${moe[1]}x${moe[2]}B`
  const plain = /^(\d+(?:\.\d+)?)([bm])$/.exec(lower)
  if (plain) return `${plain[1]}${plain[2].toUpperCase()}`
  return String(modelType || '').replace(/\.0([BM])$/, '$1') || String(tag)
}

/** The size a tag starts with ("9b-q8_0" -> "9b", "e4b-it-q8_0" -> "e4b"); "" when it has none ("latest"). */
export function leadingSize(tag) {
  const m = /^(\d+(?:\.\d+)?[bm]|e\d+b|\d+x\d+(?:\.\d+)?b)(?=$|-)/i.exec(tag)
  return m ? m[1] : ''
}

export function pickTags(rows) {
  // The default tag of each size and ONE q8_0 build of it: the shortest tag, which is the plain instruction-tuned one (the other
  // q8_0 tags are fine-tunes, "text"/"base" completion builds or multi-token-prediction drafts, which are different models).
  const sizeRows = rows.filter((row) => SIZE_TAG.test(row.tag))
  const wanted = [...sizeRows]
  for (const size of sizeRows) {
    const prefix = `${size.tag.toLowerCase()}-`
    const q8 = rows
      .filter((row) => row.tag.toLowerCase().startsWith(prefix) && /(^|-)q8_0$/.test(row.tag) && !/(^|-)(text|base|pretrain|mtp)(-|$)/.test(row.tag))
      .sort((a, b) => a.tag.length - b.tag.length || a.tag.localeCompare(b.tag))
    if (q8.length) wanted.push(q8[0])
  }
  if (!sizeRows.length) {
    // a family with a single size: "latest" and its q8_0
    for (const tag of ['latest', 'q8_0']) {
      const row = rows.find((item) => item.tag === tag)
      if (row) wanted.push(row)
    }
  }
  return wanted
}

async function measureFamily(family, listing) {
  const html = await text(`https://ollama.com/${family.name.includes('/') ? family.name : `library/${family.name}`}/tags`)
  const rows = parseTags(html, family.name)
  const card = listing.get(family.name)
  const caps = new Set(card ? card.caps : [])
  const out = []
  const skipped = []
  const picked = pickTags(rows)
  // the same weights under two tags (e.g. "latest" and "9b") are one entry
  const seenDigest = new Set()
  for (const row of picked) {
    if (row.digest && seenDigest.has(row.digest)) continue
    if (row.digest) seenDigest.add(row.digest)
    try {
      const info = await manifest(family.name, row.tag)
      if (!info.model) throw new Error('sem camada de pesos')
      const gb = (info.model.size + (info.projector ? info.projector.size : 0)) / 1e9
      if (gb > MAX_GB) {
        skipped.push(`${row.ref}: ${gb.toFixed(0)} GB (acima de ${MAX_GB})`)
        continue
      }
      if (info.config.requires && !versionAtLeast(pinnedOllama(), info.config.requires)) {
        skipped.push(`${row.ref}: exige o Ollama ${info.config.requires} e o notebook instala o ${pinnedOllama()}`)
        continue
      }
      const header = await ggufHeader(info.repo, info.model.digest)
      const kv = kvCache(header)
      if (!kv) {
        skipped.push(`${row.ref}: memória do KV não modelada (${header['general.architecture']})`)
        continue
      }
      const hasImage = row.inputs.includes('Image') || Boolean(info.projector)
      const hasAudio = row.inputs.includes('Audio')
      out.push({
        tag: row.ref,
        family: family.name,
        label: family.label,
        flags: family.flags || '',
        sizeLabel: sizeLabelOf(leadingSize(row.tag) || row.tag, info.config.model_type),
        moe: kv.moe,
        quant: info.config.file_type || '',
        weightsGB: Number((info.model.size / 1e9).toFixed(2)),
        projectorGB: Number(((info.projector ? info.projector.size : 0) / 1e9).toFixed(2)),
        kvKiB: Number(kv.kibPerToken.toFixed(1)),
        kvFixedMiB: Math.ceil(kv.fixedMiB),
        maxContext: kv.maxContext || contextNumber(row.context),
        arch: kv.arch,
        vision: hasImage || (!row.inputs.length && caps.has('vision')),
        audio: hasAudio,
        tools: caps.has('tools'),
        thinking: caps.has('thinking'),
        license: await licenseName(info.repo, info.license),
        requires: info.config.requires || ''
      })
    } catch (err) {
      skipped.push(`${row.ref}: ${err.message}`)
    }
  }
  return { out, skipped, found: Boolean(card), rows: rows.length }
}

/* ------------------------------------------------------------------ output ------------------------------------------------------------------ */

const py = (value) => JSON.stringify(value)

/** One catalog line: the tuple the Python module reads (see CATALOG_FIELDS there). */
export function pythonRow(entry) {
  const caps = `${entry.vision ? 'v' : ''}${entry.tools ? 't' : ''}${entry.thinking ? 'k' : ''}${entry.audio ? 'a' : ''}${entry.moe ? 'm' : ''}`
  const name = `${entry.label} ${entry.sizeLabel}`.replace(/\s+/g, ' ').trim()
  const gb = Number((entry.weightsGB + entry.projectorGB).toFixed(2))
  return `    (${[py(entry.tag), py(name), py(entry.quant), gb, entry.kvKiB, entry.kvFixedMiB, entry.maxContext, py(caps), py(entry.flags), py(entry.license)].join(', ')}),`
}

export function catalogBlock(entries, stamp) {
  const rows = entries.map(pythonRow).join('\n')
  return `# <catalogo-gerado>\n# Gerado por scripts/colab-catalog.mjs em ${stamp} a partir do registro do Ollama (tamanhos e cabeçalhos GGUF) e das páginas do ollama.com\n# (capacidades). Não edite à mão: rode o script de novo. Campos: ver CATALOG_FIELDS.\nCATALOG = [\n${rows}\n]\n# </catalogo-gerado>`
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '')
  if (option('--cache')) {
    cacheDir = path.resolve(option('--cache'))
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  const only = option('--only') ? option('--only').split(',') : null
  const families = FAMILIES.filter((family) => !only || only.includes(family.name))
  const listing = new Map()
  for (const url of ['https://ollama.com/library?sort=popular', 'https://ollama.com/huihui_ai', 'https://ollama.com/orcarouter']) {
    try {
      for (const [name, card] of parseListing(await text(url))) listing.set(name, card)
    } catch (err) {
      console.error(`aviso: não consegui ler ${url}: ${err.message}`)
    }
  }
  const results = await pool(families, 3, (family) => measureFamily(family, listing).then((r) => ({ family, ...r })))
  // The same weights listed under two tags (e.g. a small model whose default tag is already Q8_0) are one entry.
  const seenWeights = new Set()
  const entries = results
    .flatMap((r) => r.out)
    .filter((entry) => {
      const key = `${entry.family}|${entry.sizeLabel}|${entry.quant}|${entry.weightsGB}`
      if (seenWeights.has(key)) return false
      seenWeights.add(key)
      return true
    })
  for (const r of results) {
    const note = r.found ? '' : '  (família ausente da listagem do ollama.com: capacidades desconhecidas)'
    console.error(`${r.family.name.padEnd(40)} ${String(r.out.length).padStart(2)} etiquetas, ${r.skipped.length} puladas${note}`)
    for (const line of r.skipped) console.error(`    pulada: ${line}`)
  }
  if (option('--dump')) fs.writeFileSync(path.resolve(option('--dump')), JSON.stringify(entries, null, 1))
  const stamp = new Date().toISOString().slice(0, 10)
  console.error(`\n${entries.length} entradas em ${results.filter((r) => r.out.length).length} famílias (${stamp})`)
  if (args.includes('--write')) {
    if (only) throw new Error('--write exige todas as famílias (sem --only)')
    const source = fs.readFileSync(MODULE_FILE, 'utf8')
    const block = catalogBlock(entries, stamp)
    const pattern = /# <catalogo-gerado>[\s\S]*?# <\/catalogo-gerado>/
    if (!pattern.test(source)) throw new Error('o módulo não tem o bloco # <catalogo-gerado> ... # </catalogo-gerado>')
    fs.writeFileSync(MODULE_FILE, source.replace(pattern, () => block), 'utf8')
    console.error(`bloco CATALOG gravado em ${path.relative(ROOT, MODULE_FILE)}`)
  } else {
    for (const entry of entries.slice(0, 400)) console.log(pythonRow(entry))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('ERRO', err.stack || err.message)
    process.exit(1)
  })
}
