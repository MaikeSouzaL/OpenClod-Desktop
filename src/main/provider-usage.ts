import fs from 'node:fs'
import path from 'node:path'
import type { ProviderUsageInfo } from '../shared/api.js'
import type { HarnessEvent } from '../shared/types.js'

interface UsageFile {
  version: 1
  items: ProviderUsageInfo[]
}

/**
 * Accumulates tokens and cost per provider across every session. The usage
 * event carries the provider config that served the call, so a session that
 * switches models attributes each call correctly.
 */
export class ProviderUsageStore {
  private readonly file: string
  private readonly items = new Map<string, ProviderUsageInfo>()
  private loaded = false
  private timer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    this.file = path.join(dir, 'provider-usage.json')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as UsageFile
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return
      for (const item of parsed.items) {
        if (!item || typeof item.providerId !== 'string') continue
        this.items.set(item.providerId, {
          providerId: item.providerId,
          label: typeof item.label === 'string' ? item.label : item.providerId,
          input: Number(item.input) || 0,
          output: Number(item.output) || 0,
          cachedInput: Number(item.cachedInput) || 0,
          costUsd: Number(item.costUsd) || 0,
          calls: Number(item.calls) || 0,
          lastModel: typeof item.lastModel === 'string' ? item.lastModel : undefined,
          updatedAt: Number(item.updatedAt) || 0
        })
      }
    } catch {
      /* first run or corrupt file: start empty */
    }
  }

  record(event: Extract<HarnessEvent, { type: 'usage' }>): void {
    const providerId = event.providerId
    if (!providerId) return
    const input = Math.max(0, event.usage.input ?? 0)
    const output = Math.max(0, event.usage.output ?? 0)
    if (!input && !output) return
    const existing = this.items.get(providerId) ?? {
      providerId,
      label: event.providerLabel || providerId,
      input: 0,
      output: 0,
      cachedInput: 0,
      costUsd: 0,
      calls: 0,
      lastModel: undefined,
      updatedAt: 0
    }
    existing.label = event.providerLabel || existing.label
    existing.input += input
    existing.output += output
    existing.cachedInput += Math.min(Math.max(0, event.usage.cachedInput ?? 0), input)
    existing.costUsd += Math.max(0, event.costUsd ?? 0)
    existing.calls += 1
    existing.lastModel = event.model || existing.lastModel
    existing.updatedAt = Date.now()
    this.items.set(providerId, existing)
    this.schedule()
  }

  list(): ProviderUsageInfo[] {
    return [...this.items.values()]
      .map((item) => ({ ...item }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))
  }

  /** One-time historical seed from existing sessions; never overwrites live data. */
  seed(items: ProviderUsageInfo[]): void {
    let changed = false
    for (const item of items) {
      if (!item.providerId || this.items.has(item.providerId)) continue
      this.items.set(item.providerId, { ...item })
      changed = true
    }
    if (changed) this.schedule()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    const payload = JSON.stringify({ version: 1, items: this.list() } satisfies UsageFile, null, 2)
    const temporary = `${this.file}.tmp`
    await fs.promises.writeFile(temporary, payload, 'utf8')
    await fs.promises.rename(temporary, this.file)
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => undefined)
    }, 500)
  }
}
