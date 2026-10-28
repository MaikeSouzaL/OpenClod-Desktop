import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ObservabilityService, redactDiagnosticText } from '../src/core/observability/service'
import { makeTempDir, removeTempDir } from './helpers'

describe('ObservabilityService', () => {
  let root: string
  let service: ObservabilityService

  beforeEach(async () => {
    root = await makeTempDir('openclod-observability-')
    service = new ObservabilityService(path.join(root, 'observability'))
    await service.init()
  })

  afterEach(async () => removeTempDir(root))

  it('correlates turns and tools and aggregates durable metrics', async () => {
    service.record({ type: 'turn_start', sessionId: 's1', messageId: 'turn-1' }, 1_000)
    service.record({ type: 'tool_start', sessionId: 's1', toolCallId: 'c1', name: 'run_command', args: { command: 'npm test' } }, 1_050)
    service.record({ type: 'tool_end', sessionId: 's1', toolCallId: 'c1', name: 'run_command', ok: false, summary: 'test failed' }, 1_300)
    service.record({ type: 'usage', sessionId: 's1', usage: { input: 100, output: 20, cachedInput: 40, costUsd: 0.01 }, total: { input: 100, output: 20 } }, 1_400)
    service.record({ type: 'turn_end', sessionId: 's1', messageId: 'turn-1', stopReason: 'error', error: 'failure' }, 1_700)

    const snapshot = service.snapshot()
    expect(snapshot).toMatchObject({
      sessionCount: 1,
      turnCount: 1,
      failedTurns: 1,
      toolCalls: 1,
      failedToolCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40
    })
    expect(snapshot.tools[0]).toMatchObject({ name: 'run_command', total: 1, failures: 1, averageMs: 250 })
    expect(service.list({ sessionId: 's1' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_end', toolCallId: 'c1', durationMs: 250 }),
      expect.objectContaining({ type: 'turn_end', turnId: 'turn-1', durationMs: 700 })
    ]))

    await service.flush()
    const restarted = new ObservabilityService(path.join(root, 'observability'))
    await restarted.init()
    expect(restarted.snapshot()).toMatchObject({ turnCount: 1, failedTurns: 1, toolCalls: 1, inputTokens: 100 })
    expect(restarted.list({ limit: 10 })).toHaveLength(5)
  })

  it('redacts credentials and user paths while preserving diagnostic context', () => {
    expect(redactDiagnosticText('apiKey=super-secret C:\\Users\\Alice\\project\\app.ts Authorization: Bearer abc.def sk-1234567890')).toBe(
      'apiKey=[REDACTED] <USER_HOME>\\project\\app.ts Authorization: [REDACTED] [REDACTED_API_KEY]'
    )
    service.recordLog('provider', 'token=abc123 C:\\Users\\Alice\\secret.txt', 'error')
    const entry = service.list({ type: 'log' })[0]
    expect(entry.detail).toContain('token=[REDACTED] <USER_HOME>\\secret.txt')
  })

  it('exports a sanitized compressed diagnostic bundle with a checksum', async () => {
    service.recordLog('provider', 'Bearer abc.def')
    const target = path.join(root, 'diagnostics.json.gz')
    const info = await service.exportDiagnostic(target, { home: 'C:\\Users\\Alice', token: 'secret-value' })
    expect(info.bytes).toBeGreaterThan(0)
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/)
    const text = gunzipSync(fs.readFileSync(target)).toString('utf8')
    expect(text).toContain('openclod-diagnostics')
    expect(text).toContain('<USER_HOME>')
    expect(text).not.toContain('abc.def')
    expect(text).not.toContain('secret-value')
  })

  it('keeps only recent events and limits archive retention', async () => {
    const bounded = new ObservabilityService(path.join(root, 'bounded'), { maxEvents: 100, maxFileBytes: 4_096, maxArchives: 1 })
    await bounded.init()
    for (let index = 0; index < 180; index++) bounded.recordLog('test', `${index} ${'x'.repeat(80)}`)
    await bounded.flush()
    expect(bounded.list({ limit: 1_000 })).toHaveLength(100)
    const files = fs.readdirSync(path.join(root, 'bounded'))
    expect(files.filter((name) => name.startsWith('events-')).length).toBeLessThanOrEqual(1)
  })
})
