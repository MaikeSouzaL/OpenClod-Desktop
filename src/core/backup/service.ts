import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const VERSION = 1
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024

export interface BackupStats {
  version: number
  createdAt: string
  appVersion?: string
  files: number
  bytes: number
  sha256: string
  /** Files left out on purpose (audit journals, anything that looks like a secret). */
  skipped?: string[]
}

interface BackupEntry {
  path: string
  bytes: number
  data: string
}

interface BackupBundle extends BackupStats {
  kind: 'openclod-backup'
  entries: BackupEntry[]
}

function slash(value: string): string {
  return value.replace(/\\/g, '/')
}

function hash(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function safeRelative(relative: string): string {
  const normalized = slash(relative).replace(/^\/+/, '')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(relative)) {
    throw new Error(`caminho de backup inválido: ${relative}`)
  }
  if (!/^(data\/(?:projects\.json|sessions\/[^/]+\.(?:json|events\.jsonl)$|memory\/projects\/)|agents\/|skills\/|config\/settings\.json$|schedules\.json$)/.test(normalized)) {
    throw new Error(`arquivo não permitido no backup: ${normalized}`)
  }
  if (/(?:^|\/)(?:auth\.json|oauth|secrets?|\.env)(?:\/|$)/i.test(normalized)) throw new Error(`segredo não pode entrar no backup: ${normalized}`)
  return normalized
}

async function walk(root: string, relRoot: string, files: string[]): Promise<void> {
  const absolute = path.join(root, relRoot)
  let entries: fs.Dirent[]
  try { entries = await fs.promises.readdir(absolute, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const rel = slash(path.join(relRoot, entry.name))
    if (entry.isDirectory()) await walk(root, rel, files)
    else if (entry.isFile() && !/\.(?:tmp|lock)$/i.test(entry.name)) files.push(rel)
  }
}

export class BackupService {
  constructor(private readonly userData: string, private readonly appVersion?: string) {}

  private async collect(): Promise<{ entries: BackupEntry[]; skipped: string[] }> {
    const paths: string[] = []
    const skipped: string[] = []
    for (const relative of ['data/projects.json', 'config/settings.json', 'schedules.json']) {
      const file = path.join(this.userData, relative)
      if (fs.existsSync(file)) paths.push(relative)
    }
    await walk(this.userData, 'data/sessions', paths)
    await walk(this.userData, 'data/memory/projects', paths)
    await walk(this.userData, 'agents', paths)
    await walk(this.userData, 'skills', paths)
    const entries: BackupEntry[] = []
    let total = 0
    const candidates: string[] = []
    for (const raw of new Set(paths.map(slash))) {
      // Event journals are an audit trail that can reach hundreds of MB; they are not needed to restore a session.
      if (/\.events\.jsonl(?:\.\d+)?$/.test(raw)) {
        skipped.push(raw)
        continue
      }
      try {
        candidates.push(safeRelative(raw))
      } catch {
        // A stray .env or secrets file inside a skill must not abort the whole backup; it is simply left out.
        skipped.push(raw)
      }
    }
    for (const relative of candidates.sort()) {
      const file = path.join(this.userData, relative)
      const stat = await fs.promises.stat(file).catch(() => null)
      if (!stat?.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push(`${relative} (maior que ${MAX_FILE_BYTES / 1024 / 1024} MB)`)
        continue
      }
      total += stat.size
      if (total > MAX_BUNDLE_BYTES) throw new Error(`backup excede o limite de ${MAX_BUNDLE_BYTES} bytes`)
      const data = await fs.promises.readFile(file)
      entries.push({ path: relative, bytes: data.length, data: data.toString('base64') })
    }
    return { entries, skipped }
  }

  async create(destination: string): Promise<BackupStats> {
    const { entries, skipped } = await this.collect()
    const createdAt = new Date().toISOString()
    const unsigned = { kind: 'openclod-backup' as const, version: VERSION, createdAt, appVersion: this.appVersion, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries, ...(skipped.length ? { skipped } : {}) }
    const sha256 = hash(JSON.stringify(unsigned))
    const bundle: BackupBundle = { ...unsigned, sha256 }
    await fs.promises.mkdir(path.dirname(path.resolve(destination)), { recursive: true })
    await fs.promises.writeFile(destination, gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 }))
    return { version: VERSION, createdAt, appVersion: this.appVersion, files: entries.length, bytes: unsigned.bytes, sha256, ...(skipped.length ? { skipped } : {}) }
  }

  async inspect(file: string): Promise<BackupStats> {
    const compressed = await fs.promises.readFile(file)
    if (compressed.length > MAX_BUNDLE_BYTES) throw new Error('backup grande demais')
    let bundle: BackupBundle
    try { bundle = JSON.parse(gunzipSync(compressed).toString('utf8')) as BackupBundle } catch { throw new Error('backup corrompido ou formato inválido') }
    if (bundle?.kind !== 'openclod-backup' || bundle.version !== VERSION || !Array.isArray(bundle.entries)) throw new Error('versão de backup incompatível')
    const { sha256, ...unsigned } = bundle
    if (sha256 !== hash(JSON.stringify(unsigned))) throw new Error('checksum do backup não confere')
    for (const entry of bundle.entries) {
      safeRelative(entry.path)
      if (typeof entry.data !== 'string' || Buffer.from(entry.data, 'base64').length !== entry.bytes) throw new Error(`entrada inválida no backup: ${entry.path}`)
    }
    return { version: bundle.version, createdAt: bundle.createdAt, appVersion: bundle.appVersion, files: bundle.files, bytes: bundle.bytes, sha256: bundle.sha256, ...(bundle.skipped?.length ? { skipped: bundle.skipped } : {}) }
  }

  async restore(file: string): Promise<{ stats: BackupStats; preRestore: BackupStats; files: number }> {
    const compressed = await fs.promises.readFile(file)
    const inspected = await this.inspect(file)
    const bundle = JSON.parse(gunzipSync(compressed).toString('utf8')) as BackupBundle
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const preRestore = await this.create(path.join(this.userData, 'backups', `pre-restore-${stamp}.openclod-backup.json.gz`))
    const currentProjects = await this.readJson(path.join(this.userData, 'data', 'projects.json')) as { projects?: Array<Record<string, unknown>> } | null
    let restoredProjects: Array<Record<string, unknown>> | null = null
    for (const entry of bundle.entries) {
      const relative = safeRelative(entry.path)
      const target = path.join(this.userData, relative)
      const bytes = Buffer.from(entry.data, 'base64')
      if (relative === 'data/projects.json') {
        try {
          const parsed = JSON.parse(bytes.toString('utf8')) as { projects?: Array<Record<string, unknown>> }
          restoredProjects = Array.isArray(parsed.projects) ? parsed.projects : []
        } catch { throw new Error('lista de projetos do backup é inválida') }
        continue
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(target, bytes)
    }
    if (restoredProjects) {
      const merged = [...(currentProjects?.projects ?? [])]
      const known = new Set(merged.map((project) => String(project.id)))
      for (const project of restoredProjects) {
        if (String(project.id) && !known.has(String(project.id))) {
          merged.push(project)
          known.add(String(project.id))
        }
      }
      await fs.promises.mkdir(path.dirname(path.join(this.userData, 'data', 'projects.json')), { recursive: true })
      await fs.promises.writeFile(path.join(this.userData, 'data', 'projects.json'), JSON.stringify({ projects: merged }, null, 2), 'utf8')
    }
    return { stats: inspected, preRestore, files: bundle.entries.length }
  }

  private async readJson(file: string): Promise<unknown | null> {
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch { return null }
  }
}
