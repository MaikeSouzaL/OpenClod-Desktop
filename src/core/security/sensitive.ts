import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchPaths } from '../patch/apply-patch.js'

/**
 * Hard block for credential locations (SSH keys, cloud CLIs, DPAPI stores...).
 *
 * Unlike permission rules this is not configurable: the verdict is a deny in
 * every mode, even when an allow rule matches. It exists so a prompt-injected
 * or simply over-eager model cannot read or overwrite the user's keys.
 * Reference idea: openharness' SENSITIVE_PATH_PATTERNS, extended to resolve
 * `~`, environment variables, relative paths and symlinks, and to scan shell
 * commands.
 */

export interface SensitiveContext {
  /** Directory that relative paths resolve against. */
  cwd: string
  /** Home directory; defaults to os.homedir(). */
  home?: string
  /** Environment used for variable expansion; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Defaults to true on Windows. */
  caseInsensitive?: boolean
  /** Also compare the symlink/junction-resolved path. Defaults to true. */
  followLinks?: boolean
}

export interface SensitiveHit {
  /** Friendly name of the protected location, e.g. "~/.ssh". */
  label: string
  /** The path or command token that matched, as the caller wrote it. */
  target: string
  /** `inside`: the target is the location or below it. `contains`: the target is a directory that holds it. */
  kind: 'inside' | 'contains'
}

interface Location {
  label: string
  /** Lowercase path segments. */
  segments: string[]
  /** Compare case-insensitively even on case-sensitive hosts (Windows paths seen through WSL). */
  ci: boolean
}

const loc = (label: string, spec: string, ci = false): Location => ({ label, segments: spec.split('/'), ci })

/**
 * Directory-style locations: protected wherever the segment run appears
 * (the reference matches any ".ssh" directory the same way), so other users'
 * homes, WSL mounts and redirected profiles are covered too.
 */
const ANYWHERE: Location[] = [
  loc('~/.ssh', '.ssh'),
  loc('~/.aws', '.aws'),
  loc('~/.kube', '.kube'),
  loc('~/.gnupg', '.gnupg'),
  loc('~/.azure', '.azure'),
  loc('~/.config/gcloud', '.config/gcloud'),
  loc('%APPDATA%\\gcloud', 'appdata/roaming/gcloud', true),
  loc('%APPDATA%\\Microsoft\\Credentials', 'appdata/roaming/microsoft/credentials', true),
  loc('%APPDATA%\\Microsoft\\Protect', 'appdata/roaming/microsoft/protect', true),
  loc('%APPDATA%\\Microsoft\\Vault', 'appdata/roaming/microsoft/vault', true),
  loc('%LOCALAPPDATA%\\Microsoft\\Credentials', 'appdata/local/microsoft/credentials', true),
  loc('%LOCALAPPDATA%\\Microsoft\\Vault', 'appdata/local/microsoft/vault', true)
]

/**
 * File-style locations that are only sensitive in a home directory: a
 * project may legitimately commit its own `.npmrc`, but `~/.npmrc` carries
 * the user's registry tokens.
 */
const HOME_ONLY: Location[] = [
  loc('~/.docker/config.json', '.docker/config.json'),
  loc('~/.git-credentials', '.git-credentials'),
  loc('~/.netrc', '.netrc'),
  loc('~/_netrc', '_netrc'),
  loc('~/.npmrc', '.npmrc'),
  loc('~/.pypirc', '.pypirc'),
  loc('~/.config/gh/hosts.yml', '.config/gh/hosts.yml'),
  loc('~/.config/git/credentials', '.config/git/credentials'),
  loc('~/.cargo/credentials', '.cargo/credentials'),
  loc('~/.cargo/credentials.toml', '.cargo/credentials.toml')
]

/** Environment variables that relocate a credential store. */
const ENV_LOCATIONS: Array<{ name: string; list?: boolean }> = [
  { name: 'AWS_SHARED_CREDENTIALS_FILE' },
  { name: 'AWS_CONFIG_FILE' },
  { name: 'KUBECONFIG', list: true },
  { name: 'GNUPGHOME' },
  { name: 'AZURE_CONFIG_DIR' },
  { name: 'DOCKER_CONFIG' },
  { name: 'CLOUDSDK_CONFIG' },
  { name: 'NPM_CONFIG_USERCONFIG' }
]

/** Home directories of other users, WSL/Cygwin mounts included. */
const FOREIGN_HOMES: RegExp[] = [
  /^(?:[a-z]:)?(?:\/mnt\/[a-z]|\/cygdrive\/[a-z])?\/users\/[^/]+(?:\/(.*))?$/i,
  /^(?:[a-z]:)?\/home\/[^/]+(?:\/(.*))?$/i,
  /^(?:[a-z]:)?\/root(?:\/(.*))?$/i
]

function hasRun(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

function startsWithRun(haystack: string[], needle: string[]): boolean {
  return needle.length <= haystack.length && needle.every((segment, i) => haystack[i] === segment)
}

/** Forward slashes, no `\\?\` prefix, no trailing slash; lowercase when case-insensitive. */
function normalizeAbsolute(abs: string, ci: boolean): string {
  let out = abs.replace(/\\/g, '/').replace(/^\/\/[?.]\//, '')
  out = out.replace(/\/{2,}/g, '/')
  if (out.length > 1) out = out.replace(/\/+$/, '')
  return ci ? out.toLowerCase() : out
}

function splitSegments(normalized: string): string[] {
  return normalized.split('/').filter(Boolean)
}

/** Deepest existing ancestor resolved through symlinks/junctions/8.3 names, re-joined with the missing tail. */
function resolveThroughLinks(abs: string): string | null {
  let probe = abs
  const tail: string[] = []
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return null
    tail.unshift(path.basename(probe))
    probe = parent
  }
  try {
    return path.join(fs.realpathSync.native(probe), ...tail)
  } catch {
    return null
  }
}

/** Splits a shell command line into words; quoted text is re-split so `sh -c "cat ~/.ssh/x"` is seen. */
function commandWords(command: string, depth = 0): string[] {
  const words: string[] = []
  let current = ''
  let quote: string | null = null
  const flush = (): void => {
    if (current) words.push(current)
    current = ''
  }
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch) || ';|&<>()`'.includes(ch)) flush()
    else current += ch
  }
  flush()
  if (depth >= 3) return words
  return words.flatMap((word) => (/\s/.test(word) ? [word, ...commandWords(word, depth + 1)] : [word]))
}

/** Path-looking fragments of one shell word (`--key=~/.ssh/k`, `-i~/.ssh/k`, `~/.ssh:/root/.ssh`, `@file`). */
function wordFragments(word: string): string[] {
  const out = new Set<string>()
  const add = (text: string): void => {
    const clean = text.replace(/^@+/, '').trim()
    if (clean) out.add(clean)
  }
  add(word)
  for (const piece of word.split(/[=,]/)) {
    add(piece)
    // A leading drive letter keeps its colon; other colons separate docker-style "host:container" pairs.
    const drive = /^[A-Za-z]:(?=[\\/])/.exec(piece)?.[0] ?? ''
    const rest = piece.slice(drive.length)
    if (rest.includes(':')) rest.split(':').forEach((part, i) => add(i === 0 ? drive + part : part))
    for (const m of piece.matchAll(/[~$%]|[A-Za-z]:[\\/]/g)) {
      if (m.index !== undefined && m.index > 0) add(piece.slice(m.index))
    }
  }
  return [...out]
}

function looksLikePath(text: string): boolean {
  return /[\\/]|^~|^\.|^[A-Za-z]:|^%|^\$/.test(text)
}

/** Fixed part of a glob (`.ssh/**` → `.ssh/`), so a glob cannot sidestep the path check. */
export function globLiteralPrefix(pattern: string): string {
  const wild = pattern.search(/[*?[{]/)
  if (wild === -1) return pattern
  const head = pattern.slice(0, wild)
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  return cut === -1 ? '' : head.slice(0, cut + 1)
}

export interface SensitiveMatcher {
  /** Is `input` (a path, `~`/env forms allowed) a credential location or inside one? */
  matchPath(input: string, base?: string): SensitiveHit | null
  /** Is `input` a directory that contains a credential location (recursive reads would reach it)? */
  matchAncestor(input: string, base?: string): SensitiveHit | null
  /** Does a shell command reference a credential location? */
  matchCommand(command: string, base?: string): SensitiveHit | null
  /** Does a file: URL (also behind view-source:) point at a credential location? Other schemes never match. */
  matchFileUrl(url: string): SensitiveHit | null
}

export function createSensitiveMatcher(ctx: SensitiveContext): SensitiveMatcher {
  const ci = ctx.caseInsensitive ?? process.platform === 'win32'
  const env = ctx.env ?? process.env
  const home = ctx.home ?? os.homedir()
  const follow = ctx.followLinks ?? true
  const homeNorm = normalizeAbsolute(path.resolve(home), ci)

  const envValue = (name: string): string | undefined => {
    const direct = env[name]
    if (direct !== undefined) return direct
    if (!ci) return undefined
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : env[key]
  }

  const variable = (name: string): string | undefined => {
    const upper = name.toUpperCase()
    if (upper === 'HOME' || upper === 'USERPROFILE') return home
    return envValue(name)
  }

  const expandVariables = (text: string): string => {
    const sub = (match: string, name: string): string => variable(name) ?? match
    return text
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, sub)
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, sub)
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, sub)
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, sub)
  }

  const expandInput = (input: string): string => {
    let text = input.trim().replace(/^file:\/\/(?:\/(?=[A-Za-z]:))?/i, '')
    text = expandVariables(text)
    return text.replace(/^~(?=$|[\\/])/, () => home)
  }

  const candidates = (input: string, base: string): string[] => {
    const text = expandInput(input)
    if (!text || text.includes('\0')) return []
    const out = [path.resolve(base, text)]
    if (process.platform === 'win32') {
      // MSYS/Git Bash spelling of a drive: /c/Users/me → C:/Users/me
      const msys = /^\/([A-Za-z])(?=\/|$)(.*)$/s.exec(text.replace(/\\/g, '/'))
      if (msys) out.push(path.resolve(`${msys[1]}:/${msys[2]}`))
    }
    return out
  }

  // Relocated stores: concrete absolute roots computed from the environment.
  const envRoots: Array<{ label: string; root: string }> = []
  const addRoot = (label: string, value: string | undefined): void => {
    if (!value || !value.trim()) return
    const root = normalizeAbsolute(path.resolve(ctx.cwd, value.trim()), ci)
    if (splitSegments(root).length < 2) return // never turn a stray "/" or "C:\" into a blanket deny
    envRoots.push({ label, root })
  }
  for (const entry of ENV_LOCATIONS) {
    const value = envValue(entry.name)
    for (const part of entry.list && value ? value.split(path.delimiter) : [value]) addRoot(`$${entry.name}`, part)
  }
  const profileStores: Array<[string, string[]]> = [
    ['APPDATA', ['Microsoft/Credentials', 'Microsoft/Protect', 'Microsoft/Vault', 'gcloud']],
    ['LOCALAPPDATA', ['Microsoft/Credentials', 'Microsoft/Vault']]
  ]
  for (const [name, subs] of profileStores) {
    const root = envValue(name)
    if (!root) continue
    for (const sub of subs) addRoot(`%${name}%\\${sub.replace('/', '\\')}`, path.join(root, sub))
  }

  const isUnder = (norm: string, root: string): boolean => norm === root || norm.startsWith(`${root}/`)

  const homeRelatives = (norm: string): string[][] => {
    const out: string[][] = []
    if (isUnder(norm, homeNorm)) out.push(splitSegments(norm.slice(homeNorm.length)))
    for (const re of FOREIGN_HOMES) {
      const m = re.exec(norm)
      if (m) out.push(splitSegments(m[1] ?? ''))
    }
    return out
  }

  const matchNormalized = (norm: string): string | null => {
    const segments = splitSegments(norm)
    const lower = ci ? segments : segments.map((s) => s.toLowerCase())
    for (const location of ANYWHERE) {
      if (hasRun(location.ci ? lower : segments, location.segments)) return location.label
    }
    for (const rel of homeRelatives(norm)) {
      const relLower = ci ? rel : rel.map((s) => s.toLowerCase())
      for (const location of HOME_ONLY) {
        if (startsWithRun(location.ci ? relLower : rel, location.segments)) return location.label
      }
    }
    for (const entry of envRoots) if (isUnder(norm, entry.root)) return entry.label
    return null
  }

  // Concrete roots under the current home, for the "directory contains a credential store" check.
  const concreteRoots: Array<{ label: string; root: string }> = [
    ...[...ANYWHERE, ...HOME_ONLY].map((l) => ({ label: l.label, root: `${homeNorm}/${l.segments.join('/')}` })),
    ...envRoots
  ]

  const matchPath = (input: string, base: string = ctx.cwd): SensitiveHit | null => {
    for (const abs of candidates(input, base)) {
      let label = matchNormalized(normalizeAbsolute(abs, ci))
      if (!label && follow && looksLikePath(input)) {
        const real = resolveThroughLinks(abs)
        if (real) label = matchNormalized(normalizeAbsolute(real, ci))
      }
      if (label) return { label, target: input, kind: 'inside' }
    }
    return null
  }

  const matchAncestor = (input: string, base: string = ctx.cwd): SensitiveHit | null => {
    for (const abs of candidates(input, base)) {
      const norm = normalizeAbsolute(abs, ci)
      const prefix = norm.endsWith('/') ? norm : `${norm}/`
      const found = concreteRoots.find((entry) => entry.root.startsWith(prefix))
      if (found) return { label: found.label, target: input, kind: 'contains' }
    }
    return null
  }

  const matchCommand = (command: string, base: string = ctx.cwd): SensitiveHit | null => {
    const seen = new Set<string>()
    for (const word of commandWords(command)) {
      for (const fragment of wordFragments(word)) {
        if (seen.has(fragment)) continue
        seen.add(fragment)
        const hit = matchPath(fragment, base)
        if (hit) return { ...hit, target: word.length > 200 ? `${word.slice(0, 200)}…` : word }
      }
    }
    return null
  }

  const matchFileUrl = (url: string): SensitiveHit | null => {
    const raw = url.trim().replace(/^view-source:/i, '')
    if (!/^file:/i.test(raw)) return null
    let target: string
    try {
      target = fileURLToPath(new URL(raw))
    } catch {
      // Unusual hosts or malformed escapes: decode what we can and let the path check decide.
      const bare = raw.replace(/^file:\/*/i, '').replace(/[?#].*$/, '')
      try {
        target = decodeURIComponent(bare)
      } catch {
        target = bare
      }
    }
    const hit = matchPath(target)
    return hit ? { ...hit, target: url } : null
  }

  return { matchPath, matchAncestor, matchCommand, matchFileUrl }
}

/** One-shot helpers for callers that do not need to reuse the matcher. */
export function matchSensitivePath(input: string, ctx: SensitiveContext): SensitiveHit | null {
  return createSensitiveMatcher(ctx).matchPath(input)
}

export function findSensitiveInCommand(command: string, ctx: SensitiveContext): SensitiveHit | null {
  return createSensitiveMatcher(ctx).matchCommand(command)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Tools whose first path argument names the file they read, write or remove. */
const FILE_TARGET_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'patch_file', 'delete_path'])
const COMMAND_TOOLS = new Set(['run_command', 'start_process'])

/**
 * Decides whether a tool call touches a credential location.
 *
 * `preview` is what the permission layer already has (a path, a pattern or a
 * command); `args` are the validated tool arguments and are preferred because
 * some previews are not the path (grep/glob show the pattern, download_file
 * shows the URL). Returns null when the call is fine.
 */
export function checkSensitiveAccess(
  toolName: string,
  preview: string,
  args: unknown,
  ctx: SensitiveContext
): SensitiveHit | null {
  const a: Record<string, unknown> = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const matcher = createSensitiveMatcher(ctx)

  if (FILE_TARGET_TOOLS.has(toolName)) {
    const target = text(a.path) ?? preview
    const hit = matcher.matchPath(target)
    if (hit) return hit
    // Removing a directory also removes the stores inside it (home, C:\Users...).
    return toolName === 'delete_path' ? matcher.matchAncestor(target) : null
  }

  switch (toolName) {
    case 'apply_patch': {
      // Every file the patch creates, changes, moves to or removes.
      for (const file of patchPaths(text(a.patch) ?? '')) {
        const hit = matcher.matchPath(file)
        if (hit) return hit
      }
      return null
    }

    case 'browser_open':
    case 'browser_navigate':
      // A file: URL would render the credential file in the page the model can then read.
      return matcher.matchFileUrl(text(a.url) ?? preview)

    case 'list_dir':
      // Names only, so listing a parent directory (such as home) stays allowed.
      return matcher.matchPath(text(a.path) ?? (preview || '.'))

    case 'download_file': {
      // The preview is the URL; the destination is what lands on disk.
      const dest = text(a.path) ?? (preview && !/^[a-z][a-z0-9+.-]*:\/\//i.test(preview) ? preview : undefined)
      return dest ? matcher.matchPath(dest) : null
    }

    case 'grep':
    case 'glob': {
      const rootInput = text(a.path) ?? '.'
      const root = path.resolve(ctx.cwd, rootInput)
      const hit = matcher.matchPath(rootInput)
      if (hit) return hit
      // grep returns file contents, so a root that holds a credential store would leak it.
      if (toolName === 'grep') {
        const above = matcher.matchAncestor(rootInput)
        if (above) return above
      }
      // The glob (grep's include / glob's pattern) is relative to the root; its fixed prefix may point at a store.
      const filter = toolName === 'grep' ? text(a.include) : (text(a.pattern) ?? text(preview))
      const prefix = filter ? globLiteralPrefix(filter) : ''
      return prefix ? matcher.matchPath(prefix, root) : null
    }

    default:
      break
  }

  if (COMMAND_TOOLS.has(toolName)) {
    const command = text(a.command) ?? preview
    const cwdInput = text(a.cwd)
    const cwdHit = cwdInput ? matcher.matchPath(cwdInput) : null
    if (cwdHit) return cwdHit
    const base = cwdInput ? path.resolve(ctx.cwd, cwdInput) : ctx.cwd
    return command ? matcher.matchCommand(command, base) : null
  }
  return null
}

/** Portuguese explanation shown to the model and the user. */
export function sensitiveReason(hit: SensitiveHit, toolName: string): string {
  const where = hit.target.length > 160 ? `${hit.target.slice(0, 160)}…` : hit.target
  const tail = 'Esse bloqueio vale em todos os modos, inclusive o automático, e nenhuma regra de permissão o libera. Peça ao usuário para executar a ação por conta própria, se for mesmo necessária.'
  if (COMMAND_TOOLS.has(toolName)) {
    return `o comando referencia "${where}", dentro de ${hit.label}, um local de credenciais. ${tail}`
  }
  if (hit.kind === 'contains') {
    const why = toolName === 'delete_path' ? 'remover esse diretório apagaria o que há nele' : 'uma busca recursiva ali o exporia. Restrinja o diretório da busca'
    return `"${where}" contém ${hit.label}, um local de credenciais: ${why}. ${tail}`
  }
  return `"${where}" está em ${hit.label}, um local de credenciais. ${tail}`
}
