import fs from 'node:fs'
import path from 'node:path'
import type { FileSearchHit } from '../shared/api.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', '__pycache__', '.cache', 'release'])
const MAX_WRITE_BYTES = 5 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_FILES = 5000
const MAX_HITS = 300

/** Resolves `relative` inside `root`, rejecting traversal and the .git folder. */
export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root)
  const target = path.resolve(base, relative)
  const rel = path.relative(base, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('caminho fora do projeto')
  if (rel.split(/[\\/]/)[0].toLowerCase() === '.git') throw new Error('a pasta .git não pode ser editada por aqui')
  return target
}

/**
 * Saves a file edited by the user in the files pane. Only existing text files
 * are overwritten (new files are allowed inside existing folders); writes are
 * atomic so a crash never leaves a half-written file.
 */
export async function writeProjectFile(root: string, relative: string, content: string): Promise<{ size: number }> {
  const target = resolveInside(root, relative)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE_BYTES) throw new Error('arquivo grande demais para salvar pelo editor (máx. 5 MB)')
  const stat = await fs.promises.stat(target).catch(() => null)
  if (stat && !stat.isFile()) throw new Error('o destino não é um arquivo')
  if (stat) {
    const current = await fs.promises.readFile(target)
    if (current.includes(0)) throw new Error('arquivo binário: não pode ser salvo pelo editor')
  } else if (!(await fs.promises.stat(path.dirname(target)).catch(() => null))?.isDirectory()) {
    throw new Error('a pasta de destino não existe')
  }
  const temp = `${target}.forja-${process.pid}.tmp`
  await fs.promises.writeFile(temp, content, 'utf8')
  await fs.promises.rename(temp, target)
  return { size: bytes }
}

/** Case-insensitive literal search over the project's text files. */
export async function searchProjectFiles(root: string, query: string): Promise<FileSearchHit[]> {
  const needle = query.toLowerCase()
  if (needle.length < 2) return []
  const hits: FileSearchHit[] = []
  let files = 0
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= MAX_HITS || files >= MAX_SEARCH_FILES) return
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (hits.length >= MAX_HITS || files >= MAX_SEARCH_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      files++
      const stat = await fs.promises.stat(full).catch(() => null)
      if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) continue
      const buffer = await fs.promises.readFile(full).catch(() => null)
      if (!buffer || buffer.includes(0)) continue
      const lines = buffer.toString('utf8').split(/\r?\n/)
      const relative = path.relative(root, full).replace(/\\/g, '/')
      for (let index = 0; index < lines.length && hits.length < MAX_HITS; index++) {
        if (lines[index].toLowerCase().includes(needle)) {
          hits.push({ path: relative, line: index + 1, text: lines[index].trim().slice(0, 240) })
        }
      }
    }
  }
  await walk(path.resolve(root))
  return hits
}
