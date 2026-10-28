import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerActivityTracker, isComputerTool, isOverlayTool } from '../src/core/computer/activity'
import type { HarnessEvent } from '../src/shared/types'

const start = (toolCallId: string, name = 'computer_click', sessionId = 'ses_1', agentId?: string): HarnessEvent => ({
  type: 'tool_start',
  sessionId,
  toolCallId,
  name,
  args: {},
  ...(agentId ? { agentId } : {})
})

const end = (toolCallId: string, name = 'computer_click', sessionId = 'ses_1', agentId?: string): HarnessEvent => ({
  type: 'tool_end',
  sessionId,
  toolCallId,
  name,
  ok: true,
  summary: 'ok',
  ...(agentId ? { agentId } : {})
})

const turnEnd = (sessionId = 'ses_1'): HarnessEvent => ({
  type: 'turn_end',
  sessionId,
  messageId: 'msg_1',
  stopReason: 'stop'
})

describe('ComputerActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recognises every desktop and browser tool and ignores the rest', () => {
    expect(isComputerTool('computer_click')).toBe(true)
    expect(isComputerTool('computer_screenshot')).toBe(true)
    expect(isComputerTool('browser_open')).toBe(false)
    expect(isComputerTool('read_file')).toBe(false)
    expect(isOverlayTool('computer_click')).toBe(true)
    expect(isOverlayTool('browser_open')).toBe(true)
    expect(isOverlayTool('browser_click')).toBe(true)
    expect(isOverlayTool('read_file')).toBe(false)

    const onChange = vi.fn()
    const tracker = new ComputerActivityTracker(onChange)
    tracker.handle({ type: 'tool_start', sessionId: 's', toolCallId: 'c', name: 'read_file', args: { path: 'a' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(tracker.active).toBe(false)
  })

  it('keeps the overlay during the whole computer turn, then hides after the linger', () => {
    const onChange = vi.fn()
    const tracker = new ComputerActivityTracker(onChange, 2500)

    tracker.handle(start('c1'))
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(tracker.active).toBe(true)

    tracker.handle(end('c1'))
    vi.advanceTimersByTime(30_000)
    expect(tracker.active).toBe(true)

    tracker.handle(turnEnd())
    vi.advanceTimersByTime(2499)
    expect(tracker.active).toBe(true)
    vi.advanceTimersByTime(1)
    expect(tracker.active).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps the overlay up across the thinking gap between browser tools', () => {
    const onChange = vi.fn()
    const tracker = new ComputerActivityTracker(onChange, 1000)

    tracker.handle(start('b1', 'browser_click'))
    tracker.handle(end('b1', 'browser_click'))
    vi.advanceTimersByTime(10_000)
    expect(tracker.active).toBe(true)

    tracker.handle(start('b2', 'browser_snapshot'))
    tracker.handle(end('b2', 'browser_snapshot'))
    expect(tracker.active).toBe(true)

    tracker.handle(turnEnd())
    vi.advanceTimersByTime(1000)
    expect(tracker.active).toBe(false)
  })

  it('does not flicker between consecutive computer calls', () => {
    const onChange = vi.fn()
    const tracker = new ComputerActivityTracker(onChange, 1000)

    tracker.handle(start('c1'))
    tracker.handle(end('c1'))
    vi.advanceTimersByTime(500)
    tracker.handle(start('c2'))
    vi.advanceTimersByTime(2000)
    expect(tracker.active).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)

    tracker.handle(end('c2'))
    tracker.handle(turnEnd())
    vi.advanceTimersByTime(1000)
    expect(tracker.active).toBe(false)
  })

  it('stays visible while a parallel subagent still runs a computer call', () => {
    const onChange = vi.fn()
    const tracker = new ComputerActivityTracker(onChange, 500)

    tracker.handle(start('root', 'computer_click', 'ses_1'))
    tracker.handle(start('child', 'computer_screenshot', 'ses_1', 'agent_7'))
    tracker.handle(end('root', 'computer_click', 'ses_1'))
    vi.advanceTimersByTime(1000)
    expect(tracker.active).toBe(true)

    tracker.handle(end('child', 'computer_screenshot', 'ses_1', 'agent_7'))
    tracker.handle(turnEnd())
    vi.advanceTimersByTime(500)
    expect(tracker.active).toBe(false)
  })

  it('clears stale calls when the turn ends without a tool_end', () => {
    const tracker = new ComputerActivityTracker(() => undefined, 800)
    tracker.handle(start('c1', 'computer_click', 'ses_a'))
    tracker.handle(start('c2', 'computer_click', 'ses_b'))

    tracker.handle(turnEnd('ses_a'))
    vi.advanceTimersByTime(800)
    expect(tracker.active).toBe(true)
    expect(tracker.running).toBe(1)

    tracker.handle(turnEnd('ses_b'))
    vi.advanceTimersByTime(800)
    expect(tracker.active).toBe(false)
    expect(tracker.running).toBe(0)
  })

  it('hides immediately on dispose', () => {
    const onChange = vi.fn()
    const tracker = new ComputerActivityTracker(onChange, 5000)
    tracker.handle(start('c1'))
    tracker.dispose()
    expect(tracker.active).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
