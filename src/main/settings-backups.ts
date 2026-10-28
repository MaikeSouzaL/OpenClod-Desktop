import fs from 'node:fs'
import path from 'node:path'
import type { SettingsBackupInfo } from '../shared/api.js'
import { isSecretName } from './mcp-secrets.js'

/**
 * `settings.json.bak-<date>` copies are made before the MCP credentials move to the system vault, so an old copy
 * can still hold them in plain text. This lists and removes exactly those files (never anything else, never
 * recursively) so the interface can warn about them and let the user delete them.
 */

const BACKUP_NAME = /^settings\.json\.bak-[A-Za-z0-9._-]{1,60}$/

/** True when an `env`/`headers` value of an MCP server in this text is a literal credential rather than a vault reference. */
export function hasPlainMcpSecrets(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return true
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
  if (!Array.isArray(servers)) return false
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue
    for (const section of ['env', 'headers'] as const) {
      const record = (server as Record<string, unknown>)[section]
      if (!record || typeof record !== 'object') continue
      for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim() && !value.includes('${secret:') && isSecretName(key)) return true
      }
    }
  }
  return false
}

async function backupFiles(dir: string): Promise<Array<{ name: string; full: string; stat: fs.Stats }>> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out: Array<{ name: string; full: string; stat: fs.Stats }> = []
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue
    const full = path.join(dir, name)
    try {
      const stat = await fs.promises.lstat(full)
      // A link could point anywhere: only plain files count.
      if (stat.isFile() && !stat.isSymbolicLink()) out.push({ name, full, stat })
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return out
}

export async function listSettingsBackups(dir: string): Promise<SettingsBackupInfo[]> {
  const files = await backupFiles(dir)
  const out: SettingsBackupInfo[] = []
  for (const file of files) {
    let mayHaveSecrets = true
    try {
      // The copies are settings files (a few KB); a huge one is not ours and is reported as "may have secrets".
      if (file.stat.size <= 5_000_000) mayHaveSecrets = hasPlainMcpSecrets(await fs.promises.readFile(file.full, 'utf8'))
    } catch {
      mayHaveSecrets = true
    }
    out.push({ name: file.name, bytes: file.stat.size, modifiedAt: file.stat.mtimeMs, mayHaveSecrets })
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Deletes every `settings.json.bak-*` file of the folder; returns how many were removed. */
export async function clearSettingsBackups(dir: string): Promise<number> {
  let removed = 0
  for (const file of await backupFiles(dir)) {
    try {
      await fs.promises.unlink(file.full)
      removed += 1
    } catch {
      // Left in place; the next listing still shows it.
    }
  }
  return removed
}
