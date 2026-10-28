import fs from 'node:fs'
import path from 'node:path'

export interface SkillMeta {
  name: string
  description: string
  source: 'usuario' | 'projeto'
  dir: string
  body: string
}

/**
 * Reads the `---` header of a SKILL.md. Besides `key: value` it understands what real skills use for long
 * descriptions: folded and literal block scalars (`>`, `>-`, `|`), quoted strings, plain values continued on
 * indented lines, a byte-order mark and CRLF line endings. (The old one-line reader turned a folded
 * `description: >` into the single character ">", so such skills never described themselves.)
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: text }
  const lines = text.slice(3, end).split('\n')
  const body = text.slice(end + 4).replace(/^\n/, '')
  const meta: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    // Indented lines that follow belong to this key.
    const block: string[] = []
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^[ \t]/.test(lines[i + 1]))) block.push(lines[++i])
    while (block.length && block[block.length - 1].trim() === '') block.pop()
    const indent = Math.min(...block.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length), Infinity)
    const dedented = block.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l))
    const scalar = /^([>|])([+-]?)$/.exec(value)
    if (scalar) {
      value = scalar[1] === '>' ? dedented.map((l) => l.trim()).filter(Boolean).join(' ') : dedented.join('\n')
    } else if (dedented.length) {
      const continuation = dedented.map((l) => l.trim()).filter(Boolean)
      // A list (`- a`) keeps one item per line; a wrapped plain scalar is joined with spaces.
      value = [value, ...continuation].filter(Boolean).join(continuation.some((l) => l.startsWith('- ')) ? '\n' : ' ')
    }
    if (/^"[\s\S]*"$/.test(value)) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n')
    else if (/^'[\s\S]*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    meta[key] = value
  }
  return { meta, body }
}

/** Discovers SKILL.md folders from user and project directories. */
export class SkillLibrary {
  private skills = new Map<string, SkillMeta>()

  constructor(private readonly roots: Array<{ dir: string; source: 'usuario' | 'projeto' }>) {}

  addRoot(dir: string, source: 'usuario' | 'projeto'): void {
    if (this.roots.some((root) => path.resolve(root.dir).toLowerCase() === path.resolve(dir).toLowerCase())) return
    this.roots.push({ dir, source })
  }

  removeRoot(dir: string): void {
    const target = path.resolve(dir).toLowerCase()
    for (let index = this.roots.length - 1; index >= 0; index--) {
      if (path.resolve(this.roots[index].dir).toLowerCase() === target) this.roots.splice(index, 1)
    }
  }

  async reload(): Promise<SkillMeta[]> {
    this.skills.clear()
    for (const root of this.roots) {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(root.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const file = path.join(root.dir, entry.name, 'SKILL.md')
        try {
          const raw = await fs.promises.readFile(file, 'utf8')
          const { meta, body } = parseFrontmatter(raw)
          const name = meta.name || entry.name
          this.skills.set(name, {
            name,
            description: meta.description ?? body.split('\n')[0]?.slice(0, 200) ?? '',
            source: root.source,
            dir: path.join(root.dir, entry.name),
            body
          })
        } catch {
          /* no SKILL.md in this folder */
        }
      }
    }
    return this.list()
  }

  list(): SkillMeta[] {
    return [...this.skills.values()].map(({ body: _body, ...rest }) => ({ ...rest, body: '' }))
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.get(name)
  }

  /** Full body with a hard cap so a skill cannot flood the context. */
  content(name: string, maxChars = 60_000): string | null {
    const skill = this.skills.get(name)
    if (!skill) return null
    return skill.body.length > maxChars ? `${skill.body.slice(0, maxChars)}\n…[skill truncada]` : skill.body
  }
}
