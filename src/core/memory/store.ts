import fs from 'node:fs'
import path from 'node:path'

export interface MemoryFact {
  id: string
  text: string
  ts: number
  tags: string[]
}

/**
 * Small, explicit project memory. Only facts the agent deliberately wrote are
 * stored — file contents and web pages are never persisted here automatically.
 */
export class MemoryStore {
  private facts: MemoryFact[] = []
  private loaded = false

  constructor(private readonly file: string, private readonly limit = 200) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { facts?: MemoryFact[] }
      this.facts = Array.isArray(parsed.facts) ? parsed.facts : []
    } catch {
      this.facts = []
    }
  }

  private async save(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify({ facts: this.facts }, null, 2), 'utf8')
    await fs.promises.rename(tmp, this.file)
  }

  async add(text: string, tags: string[] = []): Promise<MemoryFact> {
    await this.load()
    const fact: MemoryFact = { id: `mem_${Date.now().toString(36)}`, text: text.slice(0, 4000), ts: Date.now(), tags }
    this.facts.push(fact)
    if (this.facts.length > this.limit) this.facts = this.facts.slice(-this.limit)
    await this.save()
    return fact
  }

  async all(): Promise<MemoryFact[]> {
    await this.load()
    return [...this.facts]
  }

  async search(query: string, limit = 10): Promise<MemoryFact[]> {
    await this.load()
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return this.facts.slice(-limit)
    return this.facts
      .map((fact) => ({
        fact,
        score: terms.reduce((s, t) => s + (fact.text.toLowerCase().includes(t) ? 1 : 0), 0)
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.ts - a.fact.ts)
      .slice(0, limit)
      .map((r) => r.fact)
  }
}
