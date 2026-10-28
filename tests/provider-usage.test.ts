import { afterEach, describe, expect, it } from 'vitest'
import { ProviderUsageStore } from '../src/main/provider-usage'
import type { HarnessEvent } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir)
})

function usageEvent(
  providerId: string,
  usage: { input: number; output: number; cachedInput?: number },
  costUsd: number
): Extract<HarnessEvent, { type: 'usage' }> {
  return {
    type: 'usage',
    sessionId: 'ses_1',
    usage,
    total: usage,
    providerId,
    providerLabel: providerId === 'p1' ? 'Provedor 1' : 'Provedor 2',
    model: `${providerId}-model`,
    costUsd
  }
}

describe('provider usage store', () => {
  it('accumulates tokens and cost per provider and survives a restart', async () => {
    const dir = await makeTempDir('openclod-usage-')
    dirs.push(dir)
    const store = new ProviderUsageStore(dir)
    await store.init()

    store.record(usageEvent('p1', { input: 1_000, output: 200, cachedInput: 500 }, 0.5))
    store.record(usageEvent('p1', { input: 2_000, output: 300 }, 1))
    store.record(usageEvent('p2', { input: 50, output: 10 }, 0))

    const [first, second] = store.list()
    expect(first).toMatchObject({
      providerId: 'p1',
      label: 'Provedor 1',
      input: 3_000,
      output: 500,
      cachedInput: 500,
      costUsd: 1.5,
      calls: 2,
      lastModel: 'p1-model'
    })
    expect(second).toMatchObject({ providerId: 'p2', input: 50, output: 10, calls: 1 })

    await store.flush()
    const reopened = new ProviderUsageStore(dir)
    await reopened.init()
    expect(reopened.list()).toEqual(store.list())
  })

  it('seeds historical totals without overwriting live data', async () => {
    const dir = await makeTempDir('openclod-usage-')
    dirs.push(dir)
    const store = new ProviderUsageStore(dir)
    await store.init()
    store.seed([
      {
        providerId: 'p1',
        label: 'Provedor 1',
        input: 9_000,
        output: 1_000,
        cachedInput: 0,
        costUsd: 0,
        calls: 3,
        updatedAt: 1
      }
    ])
    store.record(usageEvent('p1', { input: 500, output: 100 }, 0.1))
    store.seed([
      {
        providerId: 'p1',
        label: 'Outro',
        input: 999_999,
        output: 0,
        cachedInput: 0,
        costUsd: 0,
        calls: 0,
        updatedAt: 2
      }
    ])
    expect(store.list()[0]).toMatchObject({ input: 9_500, output: 1_100, calls: 4 })
  })

  it('ignores events without a provider or tokens', async () => {
    const dir = await makeTempDir('openclod-usage-')
    dirs.push(dir)
    const store = new ProviderUsageStore(dir)
    await store.init()
    store.record({ type: 'usage', sessionId: 's', usage: { input: 10, output: 1 }, total: { input: 10, output: 1 } })
    store.record(usageEvent('p1', { input: 0, output: 0 }, 0))
    expect(store.list()).toEqual([])
  })
})
