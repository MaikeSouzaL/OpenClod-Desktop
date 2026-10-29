import fs from 'node:fs'
import path from 'node:path'
import { walkFiles } from '../util/fs-walk.js'
import { declarations, exported, languageOf } from './index.js'

/**
 * A map of the repository for the model: the definitions that matter most, ranked the way Aider does it. Files are
 * nodes; "file A uses a name that file B defines" is an edge A → B; PageRank (biased toward the files and names the
 * task is about) says which definitions the rest of the code leans on. The map is cut to a token budget.
 *
 * Symbols come from the same per-line patterns as `code_intelligence symbols` (no parser): good enough to rank, not
 * to resolve overloads or scopes.
 */

export interface RepoMapOptions {
  /** Files the task is about (relative to the root): their neighbours rank higher. */
  focus?: string[]
  /** Names the task mentions: definitions with these names rank higher. */
  mentions?: string[]
  /** Size of the map, in tokens (≈ 4 characters each). */
  maxTokens?: number
  signal?: AbortSignal
}

export interface RankedDefinition {
  path: string
  line: number
  name: string
  kind: string
  /** The declaration line, trimmed. */
  text: string
  rank: number
}

export interface RepoMap {
  text: string
  files: number
  definitions: number
  shown: number
  tokens: number
}

const MAX_FILES = 3_000
const MAX_FILE_BYTES = 512 * 1024
const IDENT = /[A-Za-z_$][\w$]{2,}/g
/** Names too common to say anything about who uses whom. */
const COMMON = new Set([
  'const', 'let', 'var', 'function', 'return', 'export', 'import', 'from', 'class', 'interface', 'type', 'async', 'await',
  'this', 'true', 'false', 'null', 'undefined', 'new', 'string', 'number', 'boolean', 'void', 'any', 'unknown', 'self',
  'def', 'pass', 'None', 'True', 'False', 'fn', 'pub', 'use', 'impl', 'struct', 'func', 'package', 'public', 'private',
  'static', 'get', 'set', 'map', 'data', 'value', 'name', 'type', 'index', 'item', 'result', 'error', 'path', 'text',
  'default', 'props', 'state', 'args', 'options', 'config', 'main', 'init', 'test', 'run', 'start', 'stop', 'list'
])

interface FileInfo {
  rel: string
  defs: Array<{ name: string; kind: string; line: number; text: string; exported: boolean }>
  refs: Map<string, number>
}

async function scan(root: string, signal?: AbortSignal): Promise<FileInfo[]> {
  const files: FileInfo[] = []
  for await (const file of walkFiles(root, { maxFiles: MAX_FILES, signal, include: (rel) => languageOf(rel) !== 'other' })) {
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat || stat.size > MAX_FILE_BYTES) continue
    const source = await fs.promises.readFile(file, 'utf8').catch(() => '')
    const lines = source.split(/\r?\n/)
    const defs: FileInfo['defs'] = []
    const refs = new Map<string, number>()
    // In JavaScript and TypeScript only what a file exports can be used by another one.
    const exportsOnly = /^(typescript|javascript)$/.test(languageOf(file))
    lines.forEach((line, index) => {
      // Comments and imports declare nothing ("the function that…", `type X,` inside an import list).
      const declares = !/^\s*(\/\/|\/?\*|#|import\b|from\b)/.test(line)
      for (const declaration of declares ? declarations(line) : []) {
        if (declaration.name.length < 3 || COMMON.has(declaration.name)) continue
        if (declaration.kind === 'type' && !/\btype\s+[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*=|\btype\s+\w+\s+(struct|interface)\b/.test(line)) continue
        const isExported = exported(line)
        defs.push({ ...declaration, line: index + 1, text: line.trim().slice(0, 160), exported: isExported || !exportsOnly })
      }
      for (const match of line.matchAll(IDENT)) {
        const name = match[0]
        if (!COMMON.has(name)) refs.set(name, (refs.get(name) ?? 0) + 1)
      }
    })
    files.push({ rel: path.relative(root, file).replace(/\\/g, '/'), defs, refs })
  }
  return files
}

/** PageRank by power iteration over weighted edges, with a personalization vector (teleport). */
export function pageRank(nodes: number, edges: Array<[from: number, to: number, weight: number]>, personal?: number[], damping = 0.85, rounds = 40): number[] {
  if (!nodes) return []
  const out = new Array<number>(nodes).fill(0)
  for (const [from, , weight] of edges) out[from] += weight
  const teleportTotal = personal?.reduce((sum, value) => sum + value, 0) ?? 0
  const teleport = personal && teleportTotal > 0 ? personal.map((value) => value / teleportTotal) : new Array<number>(nodes).fill(1 / nodes)
  let rank = [...teleport]
  for (let round = 0; round < rounds; round++) {
    const next = teleport.map((value) => (1 - damping) * value)
    // A node with no way out hands its rank back to the teleport (no rank leaks away).
    let dangling = 0
    for (let node = 0; node < nodes; node++) if (!out[node]) dangling += rank[node]
    for (let node = 0; node < nodes; node++) next[node] += damping * dangling * teleport[node]
    for (const [from, to, weight] of edges) next[to] += (damping * rank[from] * weight) / out[from]
    rank = next
  }
  return rank
}

/** Ranks every definition by how much the (focused) rest of the code leans on it. */
export async function rankDefinitions(root: string, options: RepoMapOptions = {}): Promise<{ files: number; ranked: RankedDefinition[] }> {
  const files = await scan(root, options.signal)
  const definedIn = new Map<string, Set<number>>()
  files.forEach((file, position) => {
    // Only what other files can reach makes an edge.
    for (const def of file.defs.filter((item) => item.exported)) {
      const set = definedIn.get(def.name) ?? new Set<number>()
      set.add(position)
      definedIn.set(def.name, set)
    }
  })
  const mentions = new Set((options.mentions ?? []).map((name) => name.trim()).filter(Boolean))
  const focus = new Set((options.focus ?? []).map((file) => file.replace(/\\/g, '/').replace(/^\.\//, '')))
  // How specific a name is: long, camelCase or snake_case names say more; a name many files define says little.
  const weightOf = (name: string): number => {
    let weight = 1
    if (mentions.has(name)) weight *= 10
    if (name.length >= 8 && (/[a-z][A-Z]/.test(name) || name.includes('_'))) weight *= 10
    // A short plain word (`lines`, `tokens`) is as often a variable of the same name as a use of the definition.
    else if (name.length <= 6 && /^[a-z]+$/.test(name)) weight *= 0.1
    if (name.startsWith('_')) weight *= 0.1
    if ((definedIn.get(name)?.size ?? 0) > 5) weight *= 0.1
    return weight
  }
  const edges: Array<[number, number, number]> = []
  const edgeNames: Array<{ from: number; to: number; name: string; weight: number }> = []
  files.forEach((file, from) => {
    for (const [name, count] of file.refs) {
      const targets = definedIn.get(name)
      if (!targets) continue
      for (const to of targets) {
        if (to === from) continue
        const weight = weightOf(name) * Math.sqrt(count)
        edges.push([from, to, weight])
        edgeNames.push({ from, to, name, weight })
      }
    }
  })
  const personal = focus.size ? files.map((file) => (focus.has(file.rel) ? 1 : 0)) : undefined
  const rank = pageRank(files.length, edges, personal && personal.some(Boolean) ? personal : undefined)
  // A definition gets the rank that flows to its file through edges carrying its name.
  const outWeight = new Array<number>(files.length).fill(0)
  for (const edge of edgeNames) outWeight[edge.from] += edge.weight
  const defRank = new Map<string, number>()
  for (const edge of edgeNames) {
    const key = `${edge.to}\u0000${edge.name}`
    defRank.set(key, (defRank.get(key) ?? 0) + (rank[edge.from] * edge.weight) / (outWeight[edge.from] || 1))
  }
  const ranked: RankedDefinition[] = []
  files.forEach((file, position) => {
    for (const def of file.defs) {
      const flow = defRank.get(`${position}\u0000${def.name}`) ?? 0
      // Unused but exported, or in a focused file: still worth a line, below what others use.
      const base = (def.exported ? 0.05 : 0.01) * rank[position] + (focus.has(file.rel) ? 1e-6 : 0)
      // A name the task mentions is what the map is for: it comes up whatever uses it.
      const mentioned = mentions.has(def.name) ? 10 : 1
      ranked.push({ path: file.rel, line: def.line, name: def.name, kind: def.kind, text: def.text, rank: (flow + base) * mentioned })
    }
  })
  ranked.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path) || a.line - b.line)
  return { files: files.length, ranked }
}

/** The map text for the top `count` definitions: grouped by file, in line order, Aider style. */
export function renderMap(definitions: RankedDefinition[]): string {
  const byFile = new Map<string, RankedDefinition[]>()
  for (const def of definitions) byFile.set(def.path, [...(byFile.get(def.path) ?? []), def])
  const order = [...byFile.keys()].sort()
  return order
    .map((file) => {
      const defs = (byFile.get(file) ?? []).sort((a, b) => a.line - b.line)
      return [`${file}:`, ...defs.map((def) => `│ ${def.line}: ${def.text}`), '⋮'].join('\n')
    })
    .join('\n')
}

const tokensOf = (text: string): number => Math.ceil(text.length / 4)

/** The repository map within `maxTokens`: as many top-ranked definitions as fit. */
export async function repoMap(root: string, options: RepoMapOptions = {}): Promise<RepoMap> {
  const budget = Math.max(200, Math.min(options.maxTokens ?? 2_000, 16_000))
  const { files, ranked } = await rankDefinitions(root, options)
  // Binary search for the most definitions whose rendering fits the budget.
  let low = 0
  let high = Math.min(ranked.length, 2_000)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (tokensOf(renderMap(ranked.slice(0, middle))) <= budget) low = middle
    else high = middle - 1
  }
  const text = renderMap(ranked.slice(0, low))
  return { text, files, definitions: ranked.length, shown: low, tokens: tokensOf(text) }
}
