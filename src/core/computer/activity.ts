import type { HarnessEvent } from '../../shared/types.js'

/**
 * Decides when the desktop is being observed or controlled by an agent.
 *
 * It is deliberately free of Electron: the app turns `onChange(true|false)`
 * into the orange border/mascot overlay, while tests drive it with fake events
 * and timers. A short linger keeps the indicator steady between two computer
 * calls of the same turn instead of blinking on every tool.
 */
export class ComputerActivityTracker {
  private readonly calls = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private visible = false

  constructor(
    private readonly onChange: (active: boolean) => void,
    private readonly lingerMs = 2500
  ) {}

  get active(): boolean {
    return this.visible
  }

  /** Number of computer calls currently running (parallel subagents can overlap). */
  get running(): number {
    return this.calls.size
  }

  handle(event: HarnessEvent): void {
    switch (event.type) {
      case 'tool_start':
        if (!isComputerTool(event.name)) return
        this.calls.add(callKey(event))
        this.cancelTimer()
        this.setVisible(true)
        return
      case 'tool_end':
        if (!isComputerTool(event.name)) return
        this.calls.delete(callKey(event))
        this.scheduleHide()
        return
      case 'turn_end':
        // A turn can end without a tool_end when it is cancelled; drop its
        // pending calls so a stale entry never keeps the overlay forever.
        for (const key of [...this.calls]) {
          if (key.startsWith(`${event.sessionId}::`)) this.calls.delete(key)
        }
        this.scheduleHide()
        return
      default:
        return
    }
  }

  dispose(): void {
    this.cancelTimer()
    this.calls.clear()
    this.setVisible(false)
  }

  private scheduleHide(): void {
    if (this.calls.size > 0) return
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.calls.size === 0) this.setVisible(false)
    }, this.lingerMs)
    this.timer.unref?.()
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setVisible(next: boolean): void {
    if (this.visible === next) return
    this.visible = next
    this.onChange(next)
  }
}

export function isComputerTool(name: string): boolean {
  return name.startsWith('computer_')
}

function callKey(event: Extract<HarnessEvent, { type: 'tool_start' | 'tool_end' }>): string {
  return `${event.sessionId}::${event.agentId ?? 'root'}::${event.toolCallId}`
}
