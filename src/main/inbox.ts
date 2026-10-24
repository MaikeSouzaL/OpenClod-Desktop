import fs from 'node:fs'
import path from 'node:path'
import type { ImagePart } from '../shared/types.js'

export interface InboxItem {
  id: string
  text: string
  images: ImagePart[]
  mode: 'steer' | 'queue'
  /** `ui` items are drained by the renderer; `agent` items by the main process. */
  origin: 'ui' | 'agent'
  createdAt: number
}

/**
 * Durable per-session inbox. Queued prompts and steer instructions survive a
 * restart, so a turn that was running when the app closed is not lost.
 */
export class InboxStore {
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    return path.join(this.dir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  list(sessionId: string): InboxItem[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(sessionId), 'utf8')) as { items?: InboxItem[] }
      return Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item.text === 'string') : []
    } catch {
      return []
    }
  }

  add(sessionId: string, input: { text: string; images?: ImagePart[]; mode?: 'steer' | 'queue'; origin?: 'ui' | 'agent' }): InboxItem {
    const item: InboxItem = {
      id: `inb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: input.text.slice(0, 200_000),
      images: (input.images ?? []).slice(0, 8),
      mode: input.mode ?? 'queue',
      origin: input.origin ?? 'agent',
      createdAt: Date.now()
    }
    this.write(sessionId, [...this.list(sessionId).slice(-49), item])
    return item
  }

  remove(sessionId: string, itemId: string): boolean {
    const items = this.list(sessionId)
    const next = items.filter((item) => item.id !== itemId)
    if (next.length === items.length) return false
    this.write(sessionId, next)
    return true
  }

  clear(sessionId: string): void {
    fs.rmSync(this.file(sessionId), { force: true })
  }

  private write(sessionId: string, items: InboxItem[]): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const target = this.file(sessionId)
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8')
    fs.renameSync(`${target}.tmp`, target)
  }
}
