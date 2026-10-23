import { useSyncExternalStore } from 'react'

/**
 * One dictation engine for the whole window. The global shortcut and the
 * microphone button both go through `toggleDictation()`, so the floating pill,
 * the button state and the insertion target are always the same.
 */

export type DictationPhase = 'idle' | 'loading' | 'listening' | 'stopping'

export interface DictationSnapshot {
  phase: DictationPhase
  /** 0..1, for the button halo. */
  level: number
  /** Best partial text of the current utterance. */
  text: string
  /** Last error, shown under the composer. */
  error: string
}

let snapshot: DictationSnapshot = { phase: 'idle', level: 0, text: '', error: '' }
const listeners = new Set<() => void>()
let toggleHandler: (() => void) | null = null
let stopHandler: (() => void) | null = null

export function dictationSnapshot(): DictationSnapshot {
  return snapshot
}

export function subscribeDictation(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function updateDictation(patch: Partial<DictationSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

/** Called by DictationHost once; the button and the shortcut share these handlers. */
export function registerDictationHandlers(handlers: { toggle(): void; stop(): void }): () => void {
  toggleHandler = handlers.toggle
  stopHandler = handlers.stop
  return () => {
    if (toggleHandler === handlers.toggle) toggleHandler = null
    if (stopHandler === handlers.stop) stopHandler = null
  }
}

export function toggleDictation(): void {
  toggleHandler?.()
}

export function stopDictation(): void {
  stopHandler?.()
}

export function useDictationSnapshot(): DictationSnapshot {
  return useSyncExternalStore(subscribeDictation, dictationSnapshot, dictationSnapshot)
}
