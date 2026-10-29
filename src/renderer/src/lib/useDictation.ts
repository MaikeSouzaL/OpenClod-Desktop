import { useCallback, useEffect, useRef, useState } from 'react'
import type { SttEvent } from '../../../shared/api'
import { Dictation, micErrorMessage, startMic, type MicCapture } from './voice'

export type DictationState = 'idle' | 'loading' | 'listening' | 'stopping'

interface UseDictationOptions {
  /** Current composer text (read when dictation starts). */
  text: string
  setText(value: string): void
  config?: { model?: string; language?: string }
  onError(message: string): void
}

export interface DictationControls {
  state: DictationState
  /** 0..1 loudness for the meter while listening. */
  level: number
  toggle(): void
  stop(): void
  /** Call when the user edits the box by hand while dictating. */
  noteEdit(value: string): void
}

/**
 * Live dictation: microphone -> embedded Whisper -> composer text.
 * Partial results replace themselves as the recognizer improves; a final result
 * is appended and stays. Anything the user types meanwhile is preserved.
 */
export function useDictation({ text, setText, config, onError }: UseDictationOptions): DictationControls {
  const [state, setState] = useState<DictationState>('idle')
  const [level, setLevel] = useState(0)
  const dictation = useRef<Dictation | null>(null)
  const mic = useRef<MicCapture | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const stateRef = useRef<DictationState>('idle')
  const textRef = useRef(text)
  textRef.current = text
  const setTextRef = useRef(setText)
  setTextRef.current = setText
  const errorRef = useRef(onError)
  errorRef.current = onError

  /** Reads the phase through a function so TypeScript does not narrow it across awaits. */
  const phase = useCallback((): DictationState => stateRef.current, [])

  const setPhase = useCallback((next: DictationState): void => {
    stateRef.current = next
    setState(next)
  }, [])

  const teardown = useCallback((): void => {
    mic.current?.stop()
    mic.current = null
    unsubscribe.current?.()
    unsubscribe.current = null
    dictation.current = null
    setLevel(0)
  }, [])

  const stop = useCallback((): void => {
    if (stateRef.current === 'idle' || stateRef.current === 'stopping') return
    setPhase('stopping')
    mic.current?.stop()
    mic.current = null
    // Stopping flushes the recognizer, so a last "final" may still arrive; keep listening for it briefly.
    void window.openclod.stt.stop().finally(() => {
      setTimeout(() => {
        teardown()
        setPhase('idle')
      }, 250)
    })
  }, [setPhase, teardown])

  const start = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'idle') return
    setPhase('loading')
    try {
      const status = await window.openclod.stt.status()
      if (!status.ok) throw new Error(status.error)
      if (!status.value.available) throw new Error(status.value.reason ?? 'O reconhecimento de voz não está disponível.')

      dictation.current = new Dictation(textRef.current)
      unsubscribe.current = window.openclod.stt.onEvent((event: SttEvent) => {
        const current = dictation.current
        if (event.type === 'level') return
        if (event.type === 'partial' && current) setTextRef.current(current.setPartial(event.text))
        else if (event.type === 'final' && current) setTextRef.current(current.addFinal(event.text))
        else if (event.type === 'error') {
          errorRef.current(event.message)
          if (event.fatal) {
            teardown()
            setPhase('idle')
          }
        } else if (event.type === 'exit' && stateRef.current === 'listening') {
          teardown()
          setPhase('idle')
          errorRef.current('O reconhecimento de voz foi encerrado inesperadamente.')
        }
      })

      const ready = await window.openclod.stt.start({ model: config?.model, language: config?.language })
      if (!ready.ok) throw new Error(ready.error)
      // The user may have pressed stop while the model was loading.
      if (phase() !== 'loading') return

      const capture = await startMic((chunk) => {
        window.openclod.stt.audio(chunk.pcm)
        // Smooth a little so the meter does not flicker.
        setLevel((previous) => previous * 0.5 + Math.min(1, chunk.rms * 6) * 0.5)
      })
      if (phase() !== 'loading') {
        capture.stop()
        return
      }
      mic.current = capture
      setPhase('listening')
    } catch (err) {
      teardown()
      void window.openclod.stt.stop()
      setPhase('idle')
      errorRef.current(micErrorMessage(err))
    }
  }, [config?.language, config?.model, phase, setPhase, teardown])

  const toggle = useCallback((): void => {
    if (stateRef.current === 'idle') void start()
    else if (stateRef.current === 'listening' || stateRef.current === 'loading') stop()
  }, [start, stop])

  const noteEdit = useCallback((value: string): void => {
    const current = dictation.current
    if (current && current.diverged(value)) current.rebase(value)
  }, [])

  // Escape stops dictation; leaving the screen releases the microphone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && stateRef.current === 'listening') stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stop])

  useEffect(
    () => () => {
      if (stateRef.current !== 'idle') {
        mic.current?.stop()
        unsubscribe.current?.()
        void window.openclod.stt.stop()
      }
    },
    []
  )

  return { state, level, toggle, stop, noteEdit }
}
