import path from 'node:path'
import type { Decision, PermissionRules } from '../../shared/types.js'

/**
 * Claude Code tool names accepted in rules, hooks and matchers, mapped to the
 * Forja tools they cover. A rule may use either name.
 */
const CLAUDE_ALIASES: Record<string, string[]> = {
  run_command: ['Bash', 'PowerShell'],
  start_process: ['Bash', 'PowerShell'],
  read_file: ['Read'],
  write_file: ['Write'],
  edit_file: ['Edit', 'MultiEdit'],
  delete_path: ['Delete'],
  list_dir: ['LS'],
  grep: ['Grep'],
  glob: ['Glob'],
  fetch_url: ['WebFetch'],
  download_file: ['WebFetch'],
  web_search: ['WebSearch'],
  task: ['Task', 'Agent'],
  agent: ['Agent', 'Task'],
  // Specific name first: "always allow" records the first alias, and a rule on
  // the generic `Agent` would also cover the `task` sub-agent tool.
  external_agent: ['ExternalAgent', 'Agent'],
  update_plan: ['TodoWrite']
}

export type SubjectKind = 'command' | 'path' | 'url' | 'other'

const KIND_BY_TOOL: Record<string, SubjectKind> = {
  run_command: 'command',
  start_process: 'command',
  read_file: 'path',
  write_file: 'path',
  edit_file: 'path',
  delete_path: 'path',
  list_dir: 'path',
  grep: 'path',
  glob: 'path',
  fetch_url: 'url',
  download_file: 'url',
  browser_open: 'url',
  browser_navigate: 'url'
}

/** Files that hold secrets: reading or changing them asks even in auto mode. */
export const DEFAULT_RULES: PermissionRules = {
  allow: [],
  ask: [
    'Read(.env)', 'Read(.env.local)', 'Read(.env.*.local)', 'Read(.env.production)',
    'Read(*.pem)', 'Read(*.key)', 'Read(*.pfx)', 'Read(id_rsa*)', 'Read(id_ed25519*)',
    'Edit(.env)', 'Edit(.env.local)', 'Edit(.env.production)', 'Write(.env)', 'Write(.env.local)',
    'Write(.env.production)'
  ],
  deny: []
}

export function toolAliases(name: string): string[] {
  return [name, ...(CLAUDE_ALIASES[name] ?? [])]
}

export function subjectKind(toolName: string): SubjectKind {
  return KIND_BY_TOOL[toolName] ?? 'other'
}

export interface ParsedRule {
  tool: string
  pattern?: string
}

export function parseRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim()
  if (!trimmed) return null
  const match = /^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/s.exec(trimmed)
  if (!match) return null
  return { tool: match[1], pattern: match[2]?.trim() || undefined }
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** gitignore-flavoured glob: `**` crosses directories, `*` does not. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else out += escapeRegex(ch)
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '')
}

function matchCommand(pattern: string, command: string): boolean {
  const subject = command.trim()
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim()
    return subject === prefix || subject.startsWith(`${prefix} `)
  }
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i')
    return re.test(subject)
  }
  return subject === pattern
}

function matchPath(pattern: string, subject: string, cwd: string): boolean {
  const absolute = path.isAbsolute(subject) ? subject : path.resolve(cwd, subject)
  const relative = path.relative(cwd, absolute).replace(/\\/g, '/')
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  const re = globToRegExp(clean)
  if (!clean.includes('/')) return re.test(path.basename(absolute)) || re.test(relative)
  if (path.isAbsolute(pattern)) return re.test(absolute.replace(/\\/g, '/'))
  return re.test(relative)
}

function matchUrl(pattern: string, subject: string): boolean {
  if (pattern.startsWith('domain:')) {
    const domain = pattern.slice(7).toLowerCase()
    try {
      const host = new URL(subject).hostname.toLowerCase()
      return host === domain || host.endsWith(`.${domain}`)
    } catch {
      return false
    }
  }
  return matchCommand(pattern, subject)
}

export function ruleMatches(rule: string, toolName: string, subject: string, cwd: string): boolean {
  const parsed = parseRule(rule)
  if (!parsed) return false
  const names = toolAliases(toolName)
  const toolHit =
    names.includes(parsed.tool) ||
    parsed.tool === '*' ||
    (parsed.tool.startsWith('mcp__') && toolName.startsWith(`${parsed.tool}__`))
  if (!toolHit) return false
  if (!parsed.pattern || parsed.pattern === '*') return true
  switch (subjectKind(toolName)) {
    case 'command':
      return matchCommand(parsed.pattern, subject)
    case 'path':
      return matchPath(parsed.pattern, subject, cwd)
    case 'url':
      return matchUrl(parsed.pattern, subject)
    default:
      return matchCommand(parsed.pattern, subject)
  }
}

export interface RuleDecision {
  decision: Decision
  rule: string
}

/** Deny beats ask, ask beats allow — the same precedence Claude Code uses. */
export function evaluateRules(
  rules: PermissionRules | undefined,
  toolName: string,
  subject: string,
  cwd: string
): RuleDecision | null {
  if (!rules) return null
  for (const decision of ['deny', 'ask', 'allow'] as const) {
    const hit = (rules[decision] ?? []).find((rule) => ruleMatches(rule, toolName, subject, cwd))
    if (hit) return { decision, rule: hit }
  }
  return null
}

export function mergeRules(...sets: Array<Partial<PermissionRules> | undefined>): PermissionRules {
  const out: PermissionRules = { allow: [], ask: [], deny: [] }
  for (const set of sets) {
    if (!set) continue
    for (const key of ['allow', 'ask', 'deny'] as const) {
      for (const rule of set[key] ?? []) if (typeof rule === 'string' && !out[key].includes(rule)) out[key].push(rule)
    }
  }
  return out
}

/** Rule recorded when the user picks "always allow" for an approval. */
export function ruleForApproval(toolName: string, subject: string): string {
  // The rule parser anchors on the last ")", so parentheses inside the
  // subject need no escaping.
  const alias = CLAUDE_ALIASES[toolName]?.[0] ?? toolName
  return subject ? `${alias}(${subject})` : alias
}
