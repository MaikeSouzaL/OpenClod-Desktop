/**
 * Wait for a UI to stop reacting to an action.
 *
 * Algorithm adapted from munim-computer-use (Apache-2.0), `settle.rs`:
 * instead of a fixed pause, observe the app until it reacts and then goes
 * quiet, with an early exit when nothing changes at all. This version probes a
 * snapshot signature instead of Windows accessibility events, so it works with
 * the existing open-computer-use backend and needs no native code.
 */

export interface SettleTiming {
  /** Give up this soon when nothing changes at all. */
  reactionMs: number
  /** After a change, done once nothing more changed for this long. */
  quietMs: number
  /** Never wait longer than this. */
  timeoutMs: number
  /** How often to take a sample. */
  pollMs: number
}

export const DEFAULT_SETTLE: SettleTiming = {
  reactionMs: 600,
  quietMs: 200,
  timeoutMs: 1_600,
  pollMs: 200
}

export interface SettleClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface SettleResult {
  /** The UI changed after the action. */
  reacted: boolean
  /** The timeout ended the wait while the UI was still changing. */
  timedOut: boolean
  elapsedMs: number
  samples: number
}

const realClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `probe` until the observed value reacts to the action and then holds
 * still, or until it is clear that nothing will change.
 *
 * `baseline` is the value observed before the action. When it is `null`, the
 * first sample becomes the reference and the function only waits for quiet.
 */
export async function waitForQuiet(
  probe: () => Promise<string>,
  baseline: string | null,
  timing: Partial<SettleTiming> = {},
  clock: SettleClock = realClock
): Promise<SettleResult> {
  const config: SettleTiming = { ...DEFAULT_SETTLE, ...timing }
  const start = clock.now()
  let previous: string | null = null
  let changed = false
  let quietSince = start
  let samples = 0
  let waitingForFirstQuiet = false

  for (;;) {
    await clock.sleep(config.pollMs)
    const current = await probe()
    samples += 1
    const now = clock.now()

    if (previous === null) {
      previous = current
      if (baseline !== null && current !== baseline) {
        changed = true
        quietSince = now
      } else if (baseline === null) {
        // No "before" reading: the first sample is the reference, so the only
        // useful signal left is that the UI holds still.
        waitingForFirstQuiet = true
        quietSince = now
      }
    } else if (current !== previous) {
      changed = true
      quietSince = now
      previous = current
    }

    const elapsed = now - start
    if (changed && now - quietSince >= config.quietMs) {
      return { reacted: true, timedOut: false, elapsedMs: elapsed, samples }
    }
    if (waitingForFirstQuiet && now - quietSince >= config.quietMs) {
      return { reacted: false, timedOut: false, elapsedMs: elapsed, samples }
    }
    if (!changed && elapsed >= config.reactionMs) {
      return { reacted: false, timedOut: false, elapsedMs: elapsed, samples }
    }
    if (elapsed >= config.timeoutMs) {
      return { reacted: changed, timedOut: true, elapsedMs: elapsed, samples }
    }
  }
}
