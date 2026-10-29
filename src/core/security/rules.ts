import path from 'node:path'
import type { Decision, PermissionRules } from '../../shared/types.js'
import { patchPaths } from '../patch/apply-patch.js'

/**
 * Claude Code tool names accepted in rules, hooks and matchers, mapped to the
 * Openclod tools they cover. A rule may use either name.
 */
const CLAUDE_ALIASES: Record<string, string[]> = {
  run_command: ['Bash', 'PowerShell'],
  start_process: ['Bash', 'PowerShell'],
  read_file: ['Read'],
  write_file: ['Write'],
  edit_file: ['Edit', 'MultiEdit'],
  patch_file: ['Edit', 'MultiEdit'],
  apply_patch: ['Edit', 'MultiEdit'],
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
  patch_file: 'path',
  apply_patch: 'path',
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

/** The Openclod tools a name covers: a Claude Code name (`Bash`, `Edit`...) maps to every tool it aliases; ours stay. */
export function toolsForAlias(name: string): string[] {
  const covered = Object.entries(CLAUDE_ALIASES)
    .filter(([, aliases]) => aliases.includes(name))
    .map(([tool]) => tool)
  return covered.length ? covered : [name]
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
  // "git  commit" and "git commit" are the same command for a prefix rule.
  const subject = command.trim().replace(/\s+/g, ' ')
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim().replace(/\s+/g, ' ')
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

/**
 * A command line cut where the shell would run one command after another: `&&`, `||`, `;`, `|`, `&` and new lines
 * outside quotes. `opaque` when a part runs a command the text does not show (`$(...)`, backticks, `<(...)`): no
 * allow rule can vouch for that.
 */
export function splitCommandChain(command: string): { parts: string[]; opaque: boolean } {
  const parts: string[] = []
  let current = ''
  let quote = ''
  let opaque = false
  const push = (): void => {
    const part = current.trim()
    if (part) parts.push(part)
    current = ''
  }
  for (let index = 0; index < command.length; index++) {
    const ch = command[index]
    const next = command[index + 1]
    if (quote) {
      // A substitution runs inside double quotes too; single quotes keep it literal.
      if (quote === '"' && ((ch === '$' && next === '(') || ch === '`')) opaque = true
      if (ch === quote) quote = ''
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if ((ch === '$' && next === '(') || ch === '`' || ((ch === '<' || ch === '>') && next === '(')) opaque = true
    if (ch === '\n' || ch === '\r' || ch === ';') {
      push()
      continue
    }
    if (ch === '&' || ch === '|') {
      // `2>&1` and `>&2` are redirections, not a new command.
      if (ch === '&' && (command[index - 1] === '>' || command[index - 1] === '<')) {
        current += ch
        continue
      }
      push()
      if (next === ch) index++
      continue
    }
    current += ch
  }
  push()
  return { parts, opaque }
}

/** Words after the program that still name the operation (`git commit`, `npm run build`, `docker compose up`). */
const ARITY: Record<string, number> = {
  git: 2, npm: 2, pnpm: 2, yarn: 2, bun: 2, deno: 2, cargo: 2, go: 2, dotnet: 2, docker: 2, podman: 2, kubectl: 2,
  helm: 2, gh: 3, az: 3, gcloud: 3, aws: 3, pip: 2, pip3: 2, poetry: 2, uv: 2, composer: 2, mvn: 2, gradle: 2,
  gradlew: 2, make: 2, npx: 2, pnpx: 2, bunx: 2, winget: 2, choco: 2, scoop: 2, terraform: 2, tsc: 1, vitest: 2,
  jest: 1, pytest: 1, node: 2, python: 2, python3: 2, py: 2
}

/** Sub-commands that take one more word to say what they do. */
const DEEPER: Record<string, number> = {
  'npm run': 3, 'pnpm run': 3, 'yarn run': 3, 'bun run': 3, 'npm exec': 3, 'docker compose': 3, 'python -m': 3,
  'python3 -m': 3, 'py -m': 3, 'uv run': 3, 'poetry run': 3, 'dotnet ef': 3
}

/**
 * Operations a prefix rule must never cover: "always allow" on one of them saves the exact command only, so allowing
 * `git push origin main` does not allow `git push --force`.
 */
const EXACT_ONLY = [
  'git push', 'git reset', 'git clean', 'git rebase', 'git branch', 'git checkout', 'git restore', 'git stash',
  'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'docker rm', 'docker rmi', 'docker system',
  'kubectl delete', 'kubectl apply', 'terraform apply', 'terraform destroy', 'gh repo', 'gh release', 'gh api'
]

/** Programs a prefix rule never covers at all (removing, formatting, shutting down, elevating, running other code). */
const NEVER_PREFIX = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'format', 'diskpart', 'shutdown', 'restart-computer', 'stop-computer',
  'sudo', 'runas', 'reg', 'bcdedit', 'takeown', 'icacls', 'chmod', 'chown', 'mv', 'move', 'move-item', 'curl', 'wget',
  'invoke-webrequest', 'iwr', 'invoke-expression', 'iex', 'start-process', 'set-executionpolicy', 'cmd', 'bash', 'sh',
  'eval', 'powershell', 'pwsh'
])

/** "C:\tools\Git.EXE" → "git". */
function programOf(word: string): string {
  return word.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() ?? ''
}

/**
 * The prefix "always allow" saves for one command: as many words as name the operation (`git commit -m x` →
 * `git commit`, `npm run build -- --watch` → `npm run build`). Null when only the exact command may be saved: an
 * unknown program, a risky operation, or a flag where the operation should be.
 */
export function commandPrefix(command: string): string | null {
  const words = command.trim().split(/\s+/)
  // Leading `VAR=value` assignments are not the program.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
  if (!words.length) return null
  const program = programOf(words[0])
  if (NEVER_PREFIX.has(program)) return null
  let arity = ARITY[program]
  if (!arity) return null
  const head = [program, ...words.slice(1, 2).map((word) => word.toLowerCase())].join(' ')
  arity = DEEPER[head] ?? arity
  if (words.length < arity) return null
  const taken = words.slice(0, arity)
  // `git -C x status`, `npm --prefix x test`: a flag where the operation should be makes the prefix meaningless.
  if (taken.slice(1).some((word, index) => word.startsWith('-') && !(index === 0 && DEEPER[head] && word === '-m'))) return null
  // A quoted or path-like operation (`node script.js`) is a file, not an operation: exact only.
  if (taken.slice(1).some((word) => /["'\\/]|\.(js|mjs|cjs|ts|py|ps1|sh|bat|cmd)$/i.test(word))) return null
  const normalized = [program, ...taken.slice(1).map((word) => word.toLowerCase())].join(' ')
  if (EXACT_ONLY.some((risky) => normalized === risky || normalized.startsWith(`${risky} `))) return null
  return taken.join(' ')
}

/**
 * What the rules look at for one call. A command chain is judged part by part (`npm test && git push` is two
 * commands); a patch by every file it touches. Anything else is the preview.
 */
export function ruleSubjects(toolName: string, preview: string, args?: unknown): { subjects: string[]; opaque: boolean } {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  if (subjectKind(toolName) === 'command') {
    const command = typeof a.command === 'string' && a.command.trim() ? a.command : preview
    const chain = splitCommandChain(command)
    return { subjects: chain.parts.length ? chain.parts : [command], opaque: chain.opaque }
  }
  if (toolName === 'apply_patch') {
    // Without the arguments (an approval being saved), the preview lists the paths one per line.
    const paths = typeof a.patch === 'string' ? patchPaths(a.patch) : preview.split('\n').map((line) => line.trim()).filter(Boolean)
    return { subjects: paths.length ? paths : [preview], opaque: false }
  }
  return { subjects: [preview], opaque: false }
}

/**
 * The rules for a call with several subjects: a deny on any of them denies, an ask on any asks, and an allow needs
 * every subject allowed. A command whose text hides another command (`$(...)`) is never allowed by a rule: it asks.
 * The whole command line is judged too, so a rule written for the full line still applies.
 */
export function evaluateRulesFor(
  rules: PermissionRules | undefined,
  toolName: string,
  preview: string,
  cwd: string,
  args?: unknown
): RuleDecision | null {
  if (!rules) return null
  const { subjects, opaque } = ruleSubjects(toolName, preview, args)
  const decisions = subjects.map((subject) => evaluateRules(rules, toolName, subject, cwd))
  const whole = subjects.length > 1 || opaque ? evaluateRules(rules, toolName, preview, cwd) : null
  for (const wanted of ['deny', 'ask'] as const) {
    const hit = [whole, ...decisions].find((item) => item?.decision === wanted)
    if (hit) return hit
  }
  if (!decisions.every((item) => item?.decision === 'allow')) return null
  if (opaque) return { decision: 'ask', rule: `${decisions[0]?.rule ?? ''} (o comando roda outro por $(...) ou crase)`.trim() }
  return decisions[0] ?? null
}

/**
 * Rules recorded when the user picks "always allow" (or "always deny"): one per subject, each command by its prefix
 * when it has a safe one (`Bash(git commit:*)`), else exactly as it was. Nothing for a command that hides another one.
 */
export function rulesForApproval(toolName: string, preview: string, args?: unknown, effect: 'allow' | 'deny' = 'allow'): string[] {
  const { subjects, opaque } = ruleSubjects(toolName, preview, args)
  if (opaque && effect === 'allow') return []
  // A deny is saved for the line as it was: denying `git push --force` must not deny every `git push`.
  if (effect === 'deny') return [ruleForApproval(toolName, preview)]
  const out = subjects.map((subject) => {
    if (subjectKind(toolName) !== 'command') return ruleForApproval(toolName, subject)
    const prefix = commandPrefix(subject)
    return ruleForApproval(toolName, prefix ? `${prefix}:*` : subject)
  })
  return [...new Set(out)]
}
