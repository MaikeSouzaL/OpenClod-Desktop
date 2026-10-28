import { describe, expect, it } from 'vitest'
import { ComputerLayer } from '../src/core/computer/layer'

type Queue = { serializeInput<T>(work: () => Promise<T>): Promise<T> }

describe('Computer Use input queue', () => {
  it('runs mouse/keyboard work one job at a time, in call order, even when a job fails', async () => {
    const layer = new ComputerLayer(null) as unknown as Queue
    const events: string[] = []
    let active = 0
    let peak = 0
    const job = (name: string, ms: number, fail = false) =>
      layer.serializeInput(async () => {
        active++
        peak = Math.max(peak, active)
        events.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        events.push(`${name}:end`)
        active--
        if (fail) throw new Error('falhou')
        return name
      })
    // Two "agents" firing actions at the same moment must never overlap on the one real mouse.
    const results = await Promise.allSettled([job('A-click', 30), job('B-type', 5, true), job('A-key', 1), job('B-scroll', 1)])
    expect(peak).toBe(1)
    expect(events).toEqual(['A-click:start', 'A-click:end', 'B-type:start', 'B-type:end', 'A-key:start', 'A-key:end', 'B-scroll:start', 'B-scroll:end'])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
  })
})
