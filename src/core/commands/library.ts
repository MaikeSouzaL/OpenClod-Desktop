import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../skills/library.js'

/**
 * Custom slash commands, as in Claude Code: every `*.md` under `.claude/commands/` (or `.forja/commands/`)
 * of the project, or under the user's commands folder, is a prompt template. `/review src/a.ts` expands the
 * template of review.md, where `$ARGUMENTS` is everything after the name and `$1`..`$9` are the words.
 * A subfolder becomes a namespace: `frontend/lint.md` is `/frontend:lint`. Project files win over user files.
 */
export interface CustomCommand {
  name: string
  description: string
  argumentHint?: string
  body: string
  source: 'projeto' | 'usuario'
  file: string
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
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(full)
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

export function expandCommand(command: CustomCommand, args: string): string {
  const trimmed = args.trim()
  const positional = words(trimmed)
  let used = false
  let text = command.body
    .replace(/\$ARGUMENTS\b/g, () => {
      used = true
      return trimmed
    })
    .replace(/\$([1-9])\b/g, (_whole, digit: string) => {
      used = true
      return positional[Number(digit) - 1] ?? ''
    })
  if (!used && trimmed) text = `${text.trimEnd()}\n\nArgumentos: ${trimmed}`
  return text.trim()
}

/** `/name rest of the line` → the command and its arguments, or null when the text is not a custom command. */
export function matchCustomCommand(text: string, commands: CustomCommand[]): { command: CustomCommand; args: string } | null {
  const match = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const command = commands.find((candidate) => candidate.name === match[1].toLowerCase())
  return command ? { command, args: match[2] ?? '' } : null
}
