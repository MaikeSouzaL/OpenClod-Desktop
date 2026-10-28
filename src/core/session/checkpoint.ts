import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MAX_UNTRACKED_FILES = 5000
const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024
const MAX_GIT_OUTPUT = 64 * 1024 * 1024

export interface GitFileCheckpoint {
  version: 1
  kind: 'git'
  repo: string
  commit: string
  createdAt: number
  trackedPatch: boolean
  untracked: string[]
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await exec('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT,
      timeout: 120_000
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    return { code: typeof value.code === 'number' ? value.code : 1, stdout: value.stdout ?? '', stderr: value.stderr ?? value.message ?? '' }
  }
}

function safeRelative(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(target)) {
    throw new Error(`arquivo de checkpoint fora do repositório: ${target}`)
  }
  return normalized
}

async function readMetadata(checkpointDir: string): Promise<GitFileCheckpoint> {
  const raw = JSON.parse(await fs.promises.readFile(path.join(checkpointDir, 'checkpoint.json'), 'utf8')) as GitFileCheckpoint
  if (raw?.version !== 1 || raw.kind !== 'git' || !raw.repo || !raw.commit) throw new Error('checkpoint de arquivos inválido')
  return raw
}

/**
 * Captures the pre-existing dirty state without committing or changing the
 * user's index. Modified tracked files become a binary patch; untracked files
 * are copied verbatim under a size cap.
 */
export async function captureGitFileCheckpoint(cwd: string, checkpointDir: string): Promise<GitFileCheckpoint | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return null
  const repo = path.resolve(top.stdout.trim())
  const head = await git(repo, ['rev-parse', 'HEAD'])
  if (head.code !== 0) return null
  const commit = head.stdout.trim()
  const patch = await git(repo, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'])
  if (patch.code !== 0) throw new Error(`não foi possível criar o patch do checkpoint: ${patch.stderr.slice(0, 500)}`)
  const untrackedResult = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (untrackedResult.code !== 0) throw new Error(`não foi possível listar arquivos não rastreados: ${untrackedResult.stderr.slice(0, 500)}`)
  const untracked = untrackedResult.stdout.split('\0').filter(Boolean).map(safeRelative)
  if (untracked.length > MAX_UNTRACKED_FILES) throw new Error(`checkpoint recusado: mais de ${MAX_UNTRACKED_FILES} arquivos não rastreados`)

  await fs.promises.rm(checkpointDir, { recursive: true, force: true })
  await fs.promises.mkdir(path.join(checkpointDir, 'untracked'), { recursive: true })
  let totalBytes = 0
  for (const relative of untracked) {
    const source = path.resolve(repo, relative)
    if (!source.toLowerCase().startsWith(`${repo.toLowerCase()}${path.sep}`)) throw new Error(`arquivo fora do repositório: ${relative}`)
    const stat = await fs.promises.stat(source)
    totalBytes += stat.size
    if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error(`checkpoint recusado: arquivos não rastreados excedem ${MAX_UNTRACKED_BYTES} bytes`)
    const target = path.join(checkpointDir, 'untracked', relative)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.copyFile(source, target)
  }
  const trackedPatch = patch.stdout.length > 0
  if (trackedPatch) await fs.promises.writeFile(path.join(checkpointDir, 'tracked.patch'), patch.stdout, 'utf8')
  const metadata: GitFileCheckpoint = { version: 1, kind: 'git', repo, commit, createdAt: Date.now(), trackedPatch, untracked }
  await fs.promises.writeFile(path.join(checkpointDir, 'checkpoint.json'), JSON.stringify(metadata, null, 2), 'utf8')
  return metadata
}

/** Restores a checkpoint after saving the current state as a recovery checkpoint. */
export async function restoreGitFileCheckpoint(
  cwd: string,
  checkpointDir: string
): Promise<{ recoveryDir: string; checkpoint: GitFileCheckpoint }> {
  const checkpoint = await readMetadata(checkpointDir)
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new Error('a pasta não é um repositório Git')
  const repo = path.resolve(top.stdout.trim())
  if (repo.toLowerCase() !== checkpoint.repo.toLowerCase()) throw new Error('o checkpoint pertence a outro repositório')
  const head = await git(repo, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== checkpoint.commit) {
    throw new Error('o HEAD do repositório mudou desde o checkpoint; restauração recusada')
  }

  const recoveryDir = path.join(checkpointDir, `recovery-${Date.now()}`)
  await captureGitFileCheckpoint(repo, recoveryDir)
  const reset = await git(repo, ['reset', '--hard', checkpoint.commit])
  if (reset.code !== 0) throw new Error(`falha ao restaurar tracked: ${reset.stderr.slice(0, 500)}`)
  const clean = await git(repo, ['clean', '-fd'])
  if (clean.code !== 0) throw new Error(`falha ao remover arquivos posteriores: ${clean.stderr.slice(0, 500)}`)
  if (checkpoint.trackedPatch) {
    const apply = await git(repo, ['apply', '--binary', '--whitespace=nowarn', path.join(checkpointDir, 'tracked.patch')])
    if (apply.code !== 0) throw new Error(`falha ao aplicar o patch original: ${apply.stderr.slice(0, 500)}`)
  }
  for (const relative of checkpoint.untracked) {
    const source = path.join(checkpointDir, 'untracked', safeRelative(relative))
    const target = path.join(repo, safeRelative(relative))
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.copyFile(source, target)
  }
  return { recoveryDir, checkpoint }
}
