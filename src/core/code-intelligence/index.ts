import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_IGNORES, walkFiles } from '../util/fs-walk.js'

export type SourceLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'cpp' | 'c' | 'other'

export interface RepositoryOverview {
  root: string
  files: number
  languages: Array<{ language: SourceLanguage; files: number }>
  manifests: string[]
  testFiles: string[]
  topDirectories: Array<{ path: string; files: number }>
}

export interface CodeSymbol {
  name: string
  kind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'enum' | 'struct' | 'trait' | 'const'
  path: string
  line: number
  exported: boolean
}

export interface CodeDependency {
  from: string
  specifier: string
  kind: 'local' | 'package'
  line: number
}

export interface QualityIssue {
  severity: 'error' | 'warning' | 'info'
  message: string
  path?: string
  line?: number
  column?: number
  code?: string
}

const SOURCE_EXTENSIONS: Record<string, SourceLanguage> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp'
}

const MAX_SCAN_FILES = 20_000
const MAX_READ_BYTES = 2 * 1024 * 1024

function slash(value: string): string {
  return value.replace(/\\/g, '/')
}

export function languageOf(file: string): SourceLanguage {
  return SOURCE_EXTENSIONS[path.extname(file).toLowerCase()] ?? 'other'
}

async function sourceFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = []
  for await (const file of walkFiles(root, { maxFiles: MAX_SCAN_FILES, signal, include: (rel) => languageOf(rel) !== 'other' })) {
    out.push(file)
  }
  return out
}

export async function repositoryOverview(root: string, signal?: AbortSignal): Promise<RepositoryOverview> {
  const files = await sourceFiles(root, signal)
  const languages = new Map<SourceLanguage, number>()
  const dirs = new Map<string, number>()
  const manifests: string[] = []
  const testFiles: string[] = []
  for (const file of files) {
    const language = languageOf(file)
    languages.set(language, (languages.get(language) ?? 0) + 1)
    const rel = slash(path.relative(root, file))
    const top = rel.includes('/') ? rel.split('/')[0] : '.'
    dirs.set(top, (dirs.get(top) ?? 0) + 1)
    if (/(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.]+$/i.test(rel)) testFiles.push(rel)
    if (/(^|\/)(package\.json|tsconfig.*\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.sln)$/i.test(rel)) manifests.push(rel)
  }
  return {
    root,
    files: files.length,
    languages: [...languages.entries()].map(([language, count]) => ({ language, files: count })).sort((a, b) => b.files - a.files),
    manifests: manifests.slice(0, 80),
    testFiles: testFiles.slice(0, 300),
    topDirectories: [...dirs.entries()].map(([dir, count]) => ({ path: dir, files: count })).sort((a, b) => b.files - a.files).slice(0, 30)
  }
}

export function exported(line: string): boolean {
  return /^\s*export\s+/.test(line) || /^\s*pub(?:\([^)]*\))?\s+/.test(line) || /^(?:public|protected)\s+/.test(line)
}

export function declarations(line: string): Array<{ name: string; kind: CodeSymbol['kind'] }> {
  const out: Array<{ name: string; kind: CodeSymbol['kind'] }> = []
  const patterns: Array<[RegExp, CodeSymbol['kind']]> = [
    [/(?:^|\s)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
    [/(?:^|\s)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, 'interface'],
    [/(?:^|\s)(?:export\s+)?(?:type)\s+([A-Za-z_$][\w$]*)/g, 'type'],
    [/(?:^|\s)(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/g, 'enum'],
    [/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 'function'],
    [/(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/g, 'struct'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/g, 'trait'],
    [/^\s*(?:export\s+)?def\s+([A-Za-z_]\w*)/g, 'function'],
    [/^\s*class\s+([A-Za-z_]\w*)/g, 'class'],
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, 'function'],
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/g, 'type'],
    [/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|record|interface|enum)\s+([A-Za-z_]\w*)/g, 'class']
  ]
  for (const [pattern, kind] of patterns) {
    for (const match of line.matchAll(pattern)) if (match[1]) out.push({ name: match[1], kind })
  }
  return out
}

export async function findSymbols(root: string, query?: string, signal?: AbortSignal): Promise<CodeSymbol[]> {
  const wanted = query?.trim().toLowerCase()
  const symbols: CodeSymbol[] = []
  for await (const file of walkFiles(root, { maxFiles: MAX_SCAN_FILES, signal, include: (rel) => languageOf(rel) !== 'other' })) {
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat || stat.size > MAX_READ_BYTES) continue
    const text = await fs.promises.readFile(file, 'utf8').catch(() => '')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      for (const declaration of declarations(lines[i])) {
        if (wanted && !declaration.name.toLowerCase().includes(wanted)) continue
        symbols.push({ ...declaration, path: slash(path.relative(root, file)), line: i + 1, exported: exported(lines[i]) })
        if (symbols.length >= 2000) return symbols
      }
    }
  }
  return symbols
}

function importSpecifiers(line: string, language: SourceLanguage): string[] {
  const out: string[] = []
  const from = /\bfrom\s+['"]([^'"]+)['"]/g
  const require = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  const direct = /^\s*import\s+['"]([^'"]+)['"]/g
  const patterns: RegExp[] = [from, require, direct]
  if (language === 'python') patterns.push(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/g)
  if (language === 'rust') patterns.push(/^\s*use\s+([^;]+);/g)
  if (language === 'go') patterns.push(/^\s*import\s+(?:[._A-Za-z0-9]+\s+)?["`]([^"`]+)["`]/g)
  for (const re of patterns) {
    for (const match of line.matchAll(re)) if (match[1] ?? match[2]) out.push((match[1] ?? match[2])!.trim())
  }
  return out
}

export async function fileDependencies(root: string, relative: string): Promise<CodeDependency[]> {
  const file = path.resolve(root, relative)
  const rel = path.relative(root, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('arquivo fora do repositório')
  const text = await fs.promises.readFile(file, 'utf8')
  const deps: CodeDependency[] = []
  const lines = text.split(/\r?\n/)
  const language = languageOf(file)
  for (let i = 0; i < lines.length; i++) {
    for (const specifier of importSpecifiers(lines[i], language)) {
      const local = specifier.startsWith('.') || specifier.startsWith('/') || (language === 'python' && specifier.startsWith('.'))
      deps.push({ from: slash(rel), specifier, kind: local ? 'local' : 'package', line: i + 1 })
    }
  }
  return deps
}

function issueFromLine(line: string): QualityIssue | null {
  const ts = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/i)
  if (ts) return { severity: ts[4].toLowerCase() as 'error' | 'warning', path: ts[1], line: Number(ts[2]), column: Number(ts[3]), code: ts[5], message: ts[6] }
  const generic = line.match(/^(.+?):(\d+):(\d+):\s+(error|syntax error|warning|fatal):\s+(.+)$/i)
  if (generic) {
    const severity = generic[4].toLowerCase() === 'warning' ? 'warning' : 'error'
    return { severity, path: generic[1], line: Number(generic[2]), column: Number(generic[3]), message: generic[5] }
  }
  const failed = line.match(/(?:FAILED|FAIL)\s+(.+?)(?:\s+-\s+(.+))?$/)
  if (failed) return { severity: 'error', path: failed[1], message: failed[2] ?? 'teste falhou' }
  if (/\berror(?:\[[A-Z0-9]+\])?:/i.test(line)) return { severity: 'error', message: line.trim().slice(0, 500) }
  return null
}

export function analyzeFailureOutput(text: string, limit = 200): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const raw of text.split(/\r?\n/)) {
    const issue = issueFromLine(raw.trim())
    if (!issue) continue
    issues.push({ ...issue, message: issue.message.slice(0, 1000) })
    if (issues.length >= limit) break
  }
  return issues
}

export function isIgnoredName(name: string): boolean {
  return DEFAULT_IGNORES.has(name)
}
