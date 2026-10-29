import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LlamaLocalModel } from '../../shared/llamacpp.js'

/**
 * Where the GGUFs of this computer are: the ones Ollama downloaded (llama.cpp opens the same files), LM Studio's, the
 * Hugging Face cache, llama.cpp's own cache, what Openclod downloaded and the folders the user added. Only names and
 * sizes are read here; a file's header is read when it is chosen.
 */

const MAX_DEPTH = 6
const MAX_MODELS = 2_000
/** Directories visited per folder: a Downloads folder with years of files must not hold the screen. */
const MAX_DIRS = 4_000
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '$recycle.bin', 'appdata'])

export type Env = Record<string, string | undefined>

export function ollamaRoot(home: string, env: Env): string {
  return env.OLLAMA_MODELS || path.join(home, '.ollama', 'models')
}

/** Short, safe API name: "qwen3.5:4b" → "qwen3.5-4b"; "Qwen3-8B-Q4_K_M.gguf" → "qwen3-8b-q4_k_m"; split parts lose "-00001-of-00003". */
export function localAlias(name: string): string {
  const base = path.basename(name).replace(SPLIT, '').replace(/\.gguf$/i, '')
  const alias = base.toLowerCase().replace(/:/g, '-').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return alias.slice(0, 80) || 'modelo'
}

/** The known folders that exist, with the name of their source, in search order. */
export async function knownFolders(home: string, env: Env, downloaded: string): Promise<Array<[source: string, folder: string]>> {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const hfHome = env.HF_HOME || path.join(home, '.cache', 'huggingface')
  const candidates: Array<[string, string]> = [
    ['Baixados', downloaded],
    ['LM Studio', path.join(home, '.lmstudio', 'models')],
    ['LM Studio', path.join(home, '.cache', 'lm-studio', 'models')],
    ['Hugging Face', env.HF_HUB_CACHE || path.join(hfHome, 'hub')],
    ['llama.cpp', env.LLAMA_CACHE || path.join(local, 'llama.cpp')],
    ['llama.cpp', path.join(home, '.cache', 'llama.cpp')],
    ['Pasta', path.join(home, 'models')],
    ['Downloads', path.join(home, 'Downloads')]
  ]
  const out: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const [source, folder] of candidates) {
    const key = pathKey(folder)
    if (seen.has(key) || !(await isDir(folder))) continue
    seen.add(key)
    out.push([source, folder])
  }
  return out
}

/** Models Ollama downloaded: the model blob and its vision projector. Ollama's "cloud" models have no file and stay out. */
export async function ollamaModels(home: string, env: Env): Promise<LlamaLocalModel[]> {
  const root = ollamaRoot(home, env)
  const manifests = path.join(root, 'manifests')
  const out: LlamaLocalModel[] = []
  for (const file of await walkFiles(manifests)) {
    let layers: unknown
    try {
      layers = (JSON.parse(await fs.readFile(file, 'utf8')) as { layers?: unknown }).layers
    } catch {
      continue
    }
    if (!Array.isArray(layers)) continue
    const blob = async (kind: string): Promise<string | undefined> => {
      for (const layer of layers as Array<{ mediaType?: unknown; digest?: unknown }>) {
        if (!String(layer?.mediaType ?? '').endsWith(`.${kind}`)) continue
        const digest = String(layer.digest ?? '')
        if (!digest.startsWith('sha256:')) continue
        const candidate = path.join(root, 'blobs', `sha256-${digest.slice(7)}`)
        if (await isFile(candidate)) return candidate
      }
      return undefined
    }
    const model = await blob('model')
    if (!model) continue
    const name = ollamaName(path.relative(manifests, file).split(path.sep))
    const mmproj = await blob('projector')
    out.push({ path: model, name, source: 'Ollama', bytes: await sizeOf(model), ...(mmproj ? { mmproj } : {}), alias: localAlias(name) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** registry/namespace/model/tag → "model:tag" (Ollama's library), "namespace/model:tag" or "registry/namespace/model:tag". */
export function ollamaName(parts: string[]): string {
  if (parts.length < 4) return `${parts.slice(0, -1).join('/')}:${parts[parts.length - 1]}`
  const [registry, ...rest] = parts
  const tag = rest.pop() as string
  const model = rest.pop() as string
  const namespace = rest.join('/')
  const label =
    registry === 'registry.ollama.ai' ? (namespace === 'library' ? model : `${namespace}/${model}`) : `${registry}/${namespace}/${model}`
  return `${label}:${tag}`
}

/**
 * GGUFs of one folder, up to MAX_DEPTH levels. Parts 2..N of a split model and projectors (mmproj) are not items: the
 * projector becomes the `mmproj` of the models in the same folder.
 */
export async function scanFolder(source: string, folder: string, limit = MAX_MODELS): Promise<LlamaLocalModel[]> {
  const found: LlamaLocalModel[] = []
  const queue: Array<[dir: string, depth: number]> = [[folder, 0]]
  let visited = 0
  while (queue.length && visited < MAX_DIRS && found.length < limit) {
    const [dir, depth] = queue.shift() as [string, number]
    visited++
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const ggufs: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth + 1 < MAX_DEPTH && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) queue.push([path.join(dir, entry.name), depth + 1])
      } else if (/\.gguf$/i.test(entry.name)) {
        // The Hugging Face cache keeps snapshots as symbolic links to its blobs.
        ggufs.push(entry.name)
      }
    }
    if (!ggufs.length) continue
    const projectors = ggufs.filter((name) => /mmproj/i.test(name)).sort()
    for (const name of ggufs.sort()) {
      if (projectors.includes(name)) continue
      const split = SPLIT.exec(name)
      if (split && split[1] !== '00001') continue
      const file = path.join(dir, name)
      const bytes = await sizeOf(file)
      if (!bytes) continue
      found.push({
        path: file,
        name: source === 'Hugging Face' ? hfLabel(file, name) : name,
        source,
        bytes,
        ...(projectors.length ? { mmproj: path.join(dir, projectors[0]) } : {}),
        alias: localAlias(name)
      })
      if (found.length >= limit) break
    }
  }
  return found
}

/** ".../hub/models--unsloth--Qwen3-8B-GGUF/snapshots/<rev>/Qwen3-8B-Q4_K_M.gguf" → "unsloth/Qwen3-8B-GGUF · Qwen3-8B-Q4_K_M.gguf". */
function hfLabel(file: string, name: string): string {
  const repo = file.split(/[\\/]/).find((part) => part.startsWith('models--'))
  return repo ? `${repo.slice('models--'.length).replace(/--/g, '/')} · ${name}` : name
}

export interface DiscoverOptions {
  home: string
  env: Env
  /** Where Openclod's downloads go. */
  downloaded: string
  /** Folders the user added. */
  folders?: string[]
}

/** Every model, each file once: Ollama first, then the known folders and the user's. */
export async function discoverModels(options: DiscoverOptions): Promise<LlamaLocalModel[]> {
  const out: LlamaLocalModel[] = []
  const seen = new Set<string>()
  const add = (models: LlamaLocalModel[]): void => {
    for (const model of models) {
      const key = pathKey(model.path)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(model)
    }
  }
  add(await ollamaModels(options.home, options.env))
  const folders = await knownFolders(options.home, options.env, options.downloaded)
  for (const folder of options.folders ?? []) if (await isDir(folder)) folders.push(['Pasta', folder])
  const done = new Set<string>()
  for (const [source, folder] of folders) {
    const key = pathKey(folder)
    if (done.has(key)) continue
    done.add(key)
    add(await scanFolder(source, folder))
  }
  return out
}

async function walkFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(full, depth + 1)))
    else out.push(full)
  }
  return out
}

function pathKey(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function isDir(folder: string): Promise<boolean> {
  try {
    return (await fs.stat(folder)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}
