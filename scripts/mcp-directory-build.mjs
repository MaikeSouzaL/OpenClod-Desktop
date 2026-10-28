#!/usr/bin/env node
// Monta resources/mcp-directory.json a partir de:
//   1. scripts/data/mcp-directory-harvest.jsonl  (diretorio de conectores do Claude, colhido com a ferramenta
//      search_mcp_registry: uma linha JSON por conector, deduplicada por directoryUuid)
//   2. src/core/mcp/catalog.ts                   (catalogo proprio do Openclod, importado direto do TypeScript)
//   3. resources/mcp-directory.json anterior     (para nao perder `probe`/`auth` ja medidos)
//
// Uso:
//   node scripts/mcp-directory-build.mjs                       # remonta o diretorio (preserva as sondagens)
//   node scripts/mcp-directory-build.mjs --merge-shards <dir>  # antes, junta shards *.jsonl de <dir> no harvest
//   node scripts/mcp-directory-build.mjs --fresh               # ignora o diretorio anterior (zera as sondagens)
//
// Requer Node >= 22.18 (importa catalog.ts sem compilar).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mergeDirectory, validateDirectory, CATEGORIES } from './lib/mcp-directory-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HARVEST = path.join(ROOT, 'scripts', 'data', 'mcp-directory-harvest.jsonl')
const OUT = path.join(ROOT, 'resources', 'mcp-directory.json')
const CATALOG_TS = path.join(ROOT, 'src', 'core', 'mcp', 'catalog.ts')

// UUIDs com erro de transcricao na coleta (a versao correta existe em outro shard) e conectores internos da conta/sessao
// do coletor, que nao fazem parte do diretorio publico.
const DROP_UUIDS = new Set([
  '3d15fac7-4fc6-4aac-9b4e-9abfa46f7b31', // OpenSEO (o correto termina ...4aaf-9b4e-9abfa46f7b31)
  'c93e842b-830f-4b4a-bf37-9eb34144b04a', // Cloudinary (o correto e c93e842b-830f-4b4a-bbd1-6e3af0199a8f, conferido na busca)
  '6f616b42-0ed8-571e-823f-ee4aca6b7ce9', // "visualize" (servidor da sessao)
  '1a59c906-04da-521d-bda7-7f71b9f9e01c' // "Claude Docs" (servidor da conta)
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CATEGORY_SET = new Set(CATEGORIES)

function majority(values) {
  const count = new Map()
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1)
  return [...count].sort((a, b) => b[1] - a[1])[0][0]
}

function mergeShards(dir) {
  const groups = new Map()
  let lines = 0
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      lines++
      if (DROP_UUIDS.has(row.u)) continue
      if (!UUID_RE.test(row.u)) {
        console.error(`UUID malformado ignorado: ${row.u} (${row.n}, ${file})`)
        continue
      }
      if (!groups.has(row.u)) groups.set(row.u, [])
      groups.get(row.u).push(row)
    }
  }
  const merged = []
  for (const [u, list] of groups) {
    const withUrl = list.find((o) => o.url)
    const withIcon = list.find((o) => o.i)
    const bestTools = [...list].sort((a, b) => (b.t?.length ?? 0) - (a.t?.length ?? 0))[0]
    const descs = list.map((o) => o.d).filter(Boolean)
    merged.push({
      u,
      n: majority(list.map((o) => o.n)),
      d: descs.length ? majority(descs) : '',
      c: majority(list.map((o) => (CATEGORY_SET.has(o.c) ? o.c : 'outros'))),
      ...(withUrl ? { url: withUrl.url } : {}),
      ...(withIcon ? { i: withIcon.i } : {}),
      t: bestTools.t ?? [],
      tc: Math.max(...list.map((o) => o.tc ?? 0))
    })
  }
  merged.sort((a, b) => a.n.localeCompare(b.n, 'en', { sensitivity: 'base' }) || a.u.localeCompare(b.u))
  fs.mkdirSync(path.dirname(HARVEST), { recursive: true })
  fs.writeFileSync(HARVEST, merged.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`shards: ${lines} linhas -> ${merged.length} conectores unicos (${HARVEST})`)
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

async function main() {
  const args = process.argv.slice(2)
  const shardsAt = args.indexOf('--merge-shards')
  if (shardsAt >= 0) {
    const dir = args[shardsAt + 1]
    if (!dir) throw new Error('--merge-shards precisa de um diretorio')
    mergeShards(path.resolve(dir))
  }
  const fresh = args.includes('--fresh')

  const harvest = readJsonl(HARVEST)
  const mod = await import(pathToFileURL(CATALOG_TS).href)
  const catalog = mod.MCP_CATALOG
  if (!Array.isArray(catalog)) throw new Error('MCP_CATALOG nao encontrado em src/core/mcp/catalog.ts')

  let previous = []
  if (!fresh && fs.existsSync(OUT)) {
    try {
      previous = JSON.parse(fs.readFileSync(OUT, 'utf8')).entries ?? []
    } catch {
      previous = []
    }
  }

  const entries = mergeDirectory({ harvest, catalog, previous })
  const directory = { generatedAt: Date.now(), entries }
  const problems = validateDirectory(directory)
  if (problems.length) {
    console.error(`Diretorio invalido (${problems.length} problemas):`)
    for (const p of problems.slice(0, 40)) console.error('  - ' + p)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const tmp = `${OUT}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(directory, null, 1) + '\n')
  fs.renameSync(tmp, OUT)

  const bySource = {}
  for (const e of entries) bySource[e.source] = (bySource[e.source] ?? 0) + 1
  const byKind = {}
  for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
  console.log(`${OUT}: ${entries.length} entradas`, bySource, byKind, `sem url: ${entries.filter((e) => e.kind === 'remote' && !e.url).length}`)
  console.log(`preservadas ${entries.filter((e) => e.probe).length} sondagens anteriores`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
