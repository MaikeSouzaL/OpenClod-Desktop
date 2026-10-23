import fs from 'node:fs'
import path from 'node:path'
import type { HookEvent, HooksConfig, PermissionRules } from '../../shared/types.js'
import { mergeRules } from '../security/rules.js'

export interface ProjectSettings {
  rules: PermissionRules
  hooks: HooksConfig
  /** Files that contributed, for the audit log. */
  sources: string[]
}

interface SettingsFile {
  permissions?: Partial<PermissionRules>
  hooks?: HooksConfig
}

function readJson(file: string): SettingsFile | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as SettingsFile
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Concatenates matcher lists event by event (all sources run, like Claude Code). */
export function mergeHooks(...configs: Array<HooksConfig | undefined>): HooksConfig {
  const out: HooksConfig = {}
  for (const config of configs) {
    if (!config) continue
    for (const [event, matchers] of Object.entries(config) as Array<[HookEvent, HooksConfig[HookEvent]]>) {
      if (!Array.isArray(matchers)) continue
      out[event] = [...(out[event] ?? []), ...matchers]
    }
  }
  return out
}

/**
 * Project-level permissions and hooks, in the same JSON shape as Claude
 * Code's settings: `{ "permissions": {allow, ask, deny}, "hooks": {...} }`.
 * Reads `.forja/settings.json` and `.forja/settings.local.json`; with
 * `importClaude`, also `.claude/settings.json` and `.claude/settings.local.json`.
 */
export function loadProjectSettings(cwd: string, options: { importClaude?: boolean } = {}): ProjectSettings {
  const dirs = ['.forja', ...(options.importClaude ? ['.claude'] : [])]
  const files = dirs.flatMap((dir) => [path.join(cwd, dir, 'settings.json'), path.join(cwd, dir, 'settings.local.json')])
  const rules: Array<Partial<PermissionRules> | undefined> = []
  const hooks: HooksConfig[] = []
  const sources: string[] = []
  for (const file of files) {
    const data = readJson(file)
    if (!data) continue
    sources.push(file)
    rules.push(data.permissions)
    if (data.hooks) hooks.push(data.hooks)
  }
  return { rules: mergeRules(...rules), hooks: mergeHooks(...hooks), sources }
}

/** "Always allow" choices, persisted per project outside the repository. */
export class ApprovalStore {
  constructor(private readonly dir: string) {}

  private file(projectId: string): string {
    return path.join(this.dir, `${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  load(projectId: string): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(projectId), 'utf8')) as { allow?: unknown }
      return Array.isArray(parsed.allow) ? parsed.allow.filter((r): r is string => typeof r === 'string') : []
    } catch {
      return []
    }
  }

  add(projectId: string, rule: string): void {
    const rules = this.load(projectId)
    if (rules.includes(rule)) return
    rules.push(rule)
    fs.mkdirSync(this.dir, { recursive: true })
    const target = this.file(projectId)
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ allow: rules }, null, 2), 'utf8')
    fs.renameSync(`${target}.tmp`, target)
  }
}
