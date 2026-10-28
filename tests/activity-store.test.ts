import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityStore } from '../src/main/activity-store'
import type { HarnessEvent } from '../src/shared/types'
import { makeTempDir, removeTempDir } from './helpers'

describe('ActivityStore', () => {
  let dir: string
  let store: ActivityStore
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'))
    dir = await makeTempDir('openclod-activity-')
    store = new ActivityStore(dir)
    await store.init()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await removeTempDir(dir)
  })

  it('records meaningful events, deduplicates repeats and filters them', () => {
    const notice: HarnessEvent = { type: 'notice', sessionId: 'ses_1', level: 'warn', text: 'rede instável' }
    store.record(notice)
    store.record(notice)
    store.record({ type: 'tool_end', sessionId: 'ses_1', toolCallId: 't1', name: 'quality_run', ok: false, summary: '2 testes falharam' })
    store.record({ type: 'usage', sessionId: 'ses_1', usage: { input: 1, output: 1 }, total: { input: 1, output: 1 } })
    expect(store.list()).toHaveLength(2)
    expect(store.list().find((item) => item.type === 'notice')).toMatchObject({ count: 2, severity: 'warning', sessionId: 'ses_1' })
    expect(store.list({ query: 'testes', severity: 'error' })).toEqual([expect.objectContaining({ title: 'quality_run: falhou' })])
  })

  it('turns a reported harness limitation into a flagged activity', () => {
    store.record({
      type: 'tool_end',
      sessionId: 'ses_3',
      toolCallId: 't3',
      name: 'report_limitation',
      ok: true,
      summary: 'Falta visão nas capturas',
      text: 'Objetivo: ler o texto do editor',
      data: { limitation: { title: 'Falta visão nas capturas', difficulty: 'O modelo não recebe imagens', severity: 'blocked' } }
    })
    store.record({
      type: 'tool_end',
      sessionId: 'ses_3',
      toolCallId: 't4',
      name: 'report_limitation',
      ok: true,
      summary: 'Contorno por script',
      text: 'Objetivo: enumerar ícones',
      data: { limitation: { title: 'Contorno por script', difficulty: 'Script externo', severity: 'degraded' } }
    })

    const blocked = store.list({ type: 'limitation' }).find((item) => item.title.includes('visão'))
    expect(blocked).toMatchObject({
      type: 'limitation',
      severity: 'warning',
      actionRequired: true,
      detail: 'O modelo não recebe imagens'
    })
    const degraded = store.list({ type: 'limitation' }).find((item) => item.title.includes('Contorno'))
    expect(degraded).toMatchObject({ actionRequired: false, detail: 'Script externo' })
  })

  it('persists read/archive state and survives a new instance', async () => {
    store.record({ type: 'turn_end', sessionId: 'ses_2', messageId: 'm1', stopReason: 'stop' })
    const [item] = store.list()
    expect(store.setRead(item.id, true)).toBe(true)
    expect(store.archive(item.id, true)).toBe(true)
    await store.flush()
    expect(fs.existsSync(path.join(dir, 'activity.json'))).toBe(true)
    const next = new ActivityStore(dir)
    await next.init()
    expect(next.list({ archived: true })).toEqual([expect.objectContaining({ id: item.id, read: true, archived: true })])
    expect(next.clear(true)).toBe(1)
  })
})
