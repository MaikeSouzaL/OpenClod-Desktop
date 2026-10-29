import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../skills/library.js'
import { toolsForAlias } from '../security/rules.js'

/**
 * Custom slash commands, as in Claude Code: every `*.md` under `.claude/commands/` (or `.openclod/commands/`)
 * of the project, or under the user's commands folder, is a prompt template. `/review src/a.ts` expands the
 * template of review.md, where `$ARGUMENTS` is everything after the name and `$1`..`$9` are the words.
 * A subfolder becomes a namespace: `frontend/lint.md` is `/frontend:lint`. Project files win over user files, and
 * user files over the ones that ship with the app.
 *
 * Frontmatter: `description`, `argument-hint`, `allowed-tools` (the tools the command's turn may use: a restriction,
 * never an approval) and `model` (shown as a suggestion; the session keeps its model). `@caminho` in the text brings
 * that project file into the message.
 */
export interface CustomCommand {
  name: string
  description: string
  argumentHint?: string
  /** Openclod tool names the command's turn is limited to (from `allowed-tools`, Claude names mapped). */
  allowedTools?: string[]
  /** `model` of the frontmatter: a suggestion shown in the menu. */
  model?: string
  body: string
  source: 'projeto' | 'usuario' | 'app'
  file: string
}

/**
 * `allowed-tools: Bash(git status:*), Read, Grep` → the Openclod tools those names cover. The pattern in parentheses is
 * not a permission: approvals stay with the permission mode and rules.
 */
export function parseAllowedTools(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined
  const names = new Set<string>()
  // Commas and new lines separate entries; a comma inside parentheses belongs to the pattern.
  for (const entry of value.split(/,(?![^(]*\))|\n/)) {
    const name = entry.trim().replace(/^-\s*/, '').replace(/\(.*\)$/s, '').trim()
    if (!name) continue
    for (const tool of toolsForAlias(name)) names.add(tool)
  }
  return names.size ? [...names].sort() : undefined
}

const MAX_COMMANDS = 200
const MAX_DEPTH = 3
const MAX_FILE_BYTES = 64 * 1024

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_COMMANDS) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full, depth + 1, out)
    // A README explains the folder; it is not a command.
    else if (entry.isFile() && /\.md$/i.test(entry.name) && !/^readme\.md$/i.test(entry.name)) out.push(full)
  }
}

/** Later entries of `roots` override earlier ones with the same name (pass user roots first, project roots last). */
export function loadCustomCommands(roots: Array<{ dir: string; source: CustomCommand['source'] }>): CustomCommand[] {
  const byName = new Map<string, CustomCommand>()
  for (const root of roots) {
    const files: string[] = []
    walk(root.dir, 0, files)
    for (const file of files) {
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue
        const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
        const name = path
          .relative(root.dir, file)
          .replace(/\.md$/i, '')
          .split(path.sep)
          .join(':')
          .toLowerCase()
          .replace(/[^a-z0-9:_-]+/g, '-')
        if (!name || !body.trim()) continue
        const firstLine = body.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? ''
        byName.set(name, {
          name,
          description: (meta.description || firstLine).slice(0, 200),
          argumentHint: meta['argument-hint'] || undefined,
          allowedTools: parseAllowedTools(meta['allowed-tools']),
          model: meta.model?.trim() || undefined,
          body,
          source: root.source,
          file
        })
      } catch {
        /* unreadable file: skip it */
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function words(args: string): string[] {
  const out: string[] = []
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

export function expandCommand(command: CustomCommand, args: string, options: { cwd?: string } = {}): string {
  const trimmed = args.trim()
  const positional = words(trimmed)
  let used = false
  let text = command.body
    // `{{args}}` is how Cline writes it.
    .replace(/\$ARGUMENTS\b|\{\{\s*args\s*\}\}/g, () => {
      used = true
      return trimmed
    })
    .replace(/\$([1-9])\b/g, (_whole, digit: string) => {
      used = true
      return positional[Number(digit) - 1] ?? ''
    })
  if (!used && trimmed) text = `${text.trimEnd()}\n\nArgumentos: ${trimmed}`
  text = text.trim()
  return options.cwd ? withIncludedFiles(text, options.cwd) : text
}

const MAX_INCLUDES = 5
const MAX_INCLUDE_BYTES = 64 * 1024

/**
 * `@caminho/arquivo` (at the start of the text or after a space) brings that file of the project into the message, as
 * Claude Code does. Only files inside `cwd`: a path that leaves the project, a folder, a binary or a missing file is
 * left as written (it may be an @mention).
 */
export function withIncludedFiles(text: string, cwd: string): string {
  const root = path.resolve(cwd)
  const blocks: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/(?:^|[\s(])@([^\s@`'"<>|]+)/g)) {
    if (blocks.length >= MAX_INCLUDES) break
    const relative = match[1].replace(/[.,;:!?)\]]+$/, '')
    if (!relative || seen.has(relative)) continue
    seen.add(relative)
    const target = path.resolve(root, relative)
    const inside = path.relative(root, target)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue
    try {
      // The real path too: a link inside the project must not reach out of it.
      const real = fs.realpathSync(target)
      const realInside = path.relative(fs.realpathSync(root), real)
      if (realInside.startsWith('..') || path.isAbsolute(realInside)) continue
      const stat = fs.statSync(real)
      if (!stat.isFile()) continue
      const buffer = fs.readFileSync(real).subarray(0, MAX_INCLUDE_BYTES)
      if (buffer.includes(0)) continue
      const cut = stat.size > MAX_INCLUDE_BYTES ? `\n… (cortado em ${MAX_INCLUDE_BYTES / 1024} KB de ${Math.round(stat.size / 1024)} KB)` : ''
      blocks.push(`<arquivo path="${inside.replace(/\\/g, '/')}">\n${buffer.toString('utf8')}${cut}\n</arquivo>`)
    } catch {
      /* missing or unreadable: left as written */
    }
  }
  return blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text
}

/** `/name rest of the line` → the command and its arguments, or null when the text is not a custom command. */
export function matchCustomCommand(text: string, commands: CustomCommand[]): { command: CustomCommand; args: string } | null {
  const match = slashWord(text)
  if (!match) return null
  const command = commands.find((candidate) => candidate.name === match.name)
  return command ? { command, args: match.args } : null
}

/**
 * The command a text names, when it has the shape of one: `/word` alone or followed by a space. `/usr/bin/x` or
 * `/c:\pasta` are paths, not commands.
 */
export function slashWord(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1].toLowerCase(), args: match[2] ?? '' } : null
}
