import { describe, expect, it } from 'vitest'
import { waitForQuiet, type SettleClock, type SettleResult, type SettleTiming } from '../src/core/computer/settle'

const TIMING: SettleTiming = { reactionMs: 600, quietMs: 200, timeoutMs: 1_600, pollMs: 200 }

class FakeClock implements SettleClock {
  ms = 0

  now(): number {
    return this.ms
  }

  async sleep(step: number): Promise<void> {
    this.ms += step
  }
}

function run(values: (ms: number) => string, baseline: string | null = 'a'): Promise<SettleResult> {
  const clock = new FakeClock()
  const probe = async (): Promise<string> => values(clock.ms)
  return waitForQuiet(probe, baseline, TIMING, clock)
}

describe('computer settle', () => {
  it('ends after the reaction window when nothing happens', async () => {
    const settled = await run(() => 'a')
    expect(settled.reacted).toBe(false)
    expect(settled.timedOut).toBe(false)
    expect(settled.elapsedMs).toBe(600)
    expect(settled.samples).toBe(3)
  })

  it('ends once a burst of changes is quiet for the quiet window', async () => {
    const settled = await run((ms) => {
      if (ms < 200) return 'a'
      if (ms < 400) return 'b'
      if (ms < 600) return 'c'
      return 'd'
    })
    expect(settled.reacted).toBe(true)
    expect(settled.timedOut).toBe(false)
    expect(settled.elapsedMs).toBe(800)
  })

  it('counts a late reaction inside the reaction window', async () => {
    const settled = await run((ms) => (ms >= 600 ? 'b' : 'a'))
    expect(settled.reacted).toBe(true)
    expect(settled.elapsedMs).toBe(800)
  })

  it('cuts off an app that never goes quiet', async () => {
    const settled = await run((ms) => `v${ms}`)
    expect(settled.reacted).toBe(true)
    expect(settled.timedOut).toBe(true)
    expect(settled.elapsedMs).toBe(1_600)
  })

  it('uses the first sample as reference when there is no baseline', async () => {
    const settled = await run(() => 'b', null)
    expect(settled.reacted).toBe(false)
    expect(settled.timedOut).toBe(false)
    expect(settled.elapsedMs).toBe(400)
    expect(settled.samples).toBe(2)
  })

  it('reacts when the first sample already differs from the baseline', async () => {
    const settled = await run(() => 'b', 'a')
    expect(settled.reacted).toBe(true)
    expect(settled.elapsedMs).toBe(400)
  })
})
