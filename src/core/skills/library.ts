import fs from 'node:fs'
import path from 'node:path'

export interface SkillMeta {
  name: string
  description: string
  source: 'usuario' | 'projeto'
  dir: string
  body: string
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: raw }
  const header = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const meta: Record<string, string> = {}
  for (const line of header.split(/\r?\n/)) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (match) meta[match[1]] = match[2].replace(/^["']|["']$/g, '')
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
