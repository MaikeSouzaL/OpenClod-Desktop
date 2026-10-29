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
 * Reads `.openclod/settings.json` and `.openclod/settings.local.json`; with
 * `importClaude`, also `.claude/settings.json` and `.claude/settings.local.json`.
 */
export function loadProjectSettings(cwd: string, options: { importClaude?: boolean } = {}): ProjectSettings {
  const dirs = ['.openclod', ...(options.importClaude ? ['.claude'] : [])]
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

/** "Always allow" and "always deny" choices, persisted per project outside the repository. */
export class ApprovalStore {
  constructor(private readonly dir: string) {}

  private file(projectId: string): string {
    return path.join(this.dir, `${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  /** Both lists. A file from before "always deny" existed has only `allow`. */
  rules(projectId: string): { allow: string[]; deny: string[] } {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(projectId), 'utf8')) as { allow?: unknown; deny?: unknown }
      const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string') : [])
      return { allow: list(parsed.allow), deny: list(parsed.deny) }
    } catch {
      return { allow: [], deny: [] }
    }
  }

  load(projectId: string): string[] {
    return this.rules(projectId).allow
  }

  private save(projectId: string, rules: { allow: string[]; deny: string[] }): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const target = this.file(projectId)
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(rules, null, 2), 'utf8')
    fs.renameSync(`${target}.tmp`, target)
  }

  add(projectId: string, rule: string, effect: 'allow' | 'deny' = 'allow'): void {
    const rules = this.rules(projectId)
    if (rules[effect].includes(rule)) return
    rules[effect].push(rule)
    // One choice per rule: denying what was allowed before takes it off the allow list, and the other way round.
    const other = effect === 'allow' ? 'deny' : 'allow'
    rules[other] = rules[other].filter((item) => item !== rule)
    this.save(projectId, rules)
  }

  /** Takes back one saved choice; true when it was there. */
  remove(projectId: string, rule: string, effect: 'allow' | 'deny'): boolean {
    const rules = this.rules(projectId)
    if (!rules[effect].includes(rule)) return false
    rules[effect] = rules[effect].filter((item) => item !== rule)
    this.save(projectId, rules)
    return true
  }

  /** Projects with saved choices, by id. */
  projects(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    } catch {
      return []
    }
  }

  /** Removes every remembered "always allow" rule of a deleted project. */
  clear(projectId: string): void {
    fs.rmSync(this.file(projectId), { force: true })
  }
}
