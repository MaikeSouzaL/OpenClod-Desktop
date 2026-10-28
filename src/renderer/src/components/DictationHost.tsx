import { useEffect, useRef } from 'react'
import type { AppSettings } from '../../../shared/types'
import { Dictation, micErrorMessage, startMic, type MicCapture } from '../lib/voice'
import {
  dictationSnapshot,
  registerDictationHandlers,
  updateDictation,
  type DictationPhase
} from '../lib/dictation-store'

/**
 * One global dictation engine for the window. The main process owns the
 * optional global shortcut and the floating pill; this component owns the
 * microphone and the Whisper bridge. The microphone button in the composer
 * talks to this engine through the dictation store, so both entry points
 * behave exactly the same: live partial text in the pill, and insertion into
 * the focused field on stop.
 */
export function DictationHost({ voice }: { voice?: AppSettings['voice'] }): null {
  const voiceRef = useRef(voice)
  voiceRef.current = voice

  useEffect(() => {
    let phase: DictationPhase = 'idle'
    let mic: MicCapture | null = null
    let unsubscribe: (() => void) | null = null
    let engine: Dictation | null = null
    let latest = ''
    let removeToggle: (() => void) | null = null

    const send = (state: Parameters<typeof window.forja.dictation.state>[0]): void => {
      try {
        window.forja.dictation.state(state)
      } catch {
        /* the window may be closing */
      }
    }

    const reset = (): void => {
      updateDictation({ phase: 'idle', level: 0, text: '', error: '' })
      send({ phase: 'idle' })
    }

    const fail = (message: string): void => {
      updateDictation({ phase: 'idle', level: 0, text: '', error: message })
      send({ phase: 'error', error: message })
    }

    const teardown = (): void => {
      mic?.stop()
      mic = null
      unsubscribe?.()
      unsubscribe = null
      engine = null
      latest = ''
    }

    const stop = async (): Promise<void> => {
      if (phase !== 'listening' && phase !== 'loading') return
      phase = 'stopping'
      updateDictation({ phase: 'stopping' })
      send({ phase: 'processing', text: latest })
      mic?.stop()
      mic = null
      await window.forja.stt.stop().catch(() => undefined)
      // `flush` finalizes the last utterance; give the final event a moment to arrive.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const text = (engine?.text ?? latest).trim()
      teardown()
      phase = 'idle'
      // Clear the live preview before the final insertion, so the text is not
      // shown twice (preview + inserted text).
      updateDictation({ phase: 'idle', level: 0, text: '', error: '' })
      if (text) {
        try {
          await window.forja.dictation.insert(text)
        } catch {
          /* the error event already reached the pill */
        }
      }
      reset()
    }

    const start = async (): Promise<void> => {
      if (phase !== 'idle') return
      phase = 'loading'
      updateDictation({ phase: 'loading', level: 0, text: '', error: '' })
      send({ phase: 'loading' })
      try {
        const status = await window.forja.stt.status()
        if (!status.ok) throw new Error(status.error)
        if (!status.value.available) throw new Error(status.value.reason ?? 'O reconhecimento de voz não está disponível.')

        engine = new Dictation('')
        latest = ''
        unsubscribe = window.forja.stt.onEvent((event) => {
          if (event.type === 'level') {
            updateDictation({ level: Math.min(1, event.rms * 6) })
            send({ phase: 'listening', level: Math.min(1, event.rms * 6), text: latest })
            return
          }
          if (event.type === 'partial') {
            latest = engine?.setPartial(event.text) ?? latest
            updateDictation({ text: latest })
            send({ phase: 'listening', text: latest })
            return
          }
          if (event.type === 'final') {
            latest = engine?.addFinal(event.text) ?? latest
            updateDictation({ text: latest })
            send({ phase: 'listening', text: latest })
            return
          }
          if (event.type === 'error') {
            fail(event.message)
            if (event.fatal) void stop()
            return
          }
          if (event.type === 'exit' && phase === 'listening') {
            fail('O reconhecimento de voz foi encerrado inesperadamente.')
            void stop()
          }
        })

        const ready = await window.forja.stt.start({
          model: voiceRef.current?.model,
          language: voiceRef.current?.language
        })
        if (!ready.ok) throw new Error(ready.error)
        if (phase !== 'loading') return

        mic = await startMic((chunk) => {
          window.forja.stt.audio(chunk.pcm)
          const level = Math.min(1, chunk.rms * 6)
          updateDictation({ level })
          send({ phase: 'listening', level, text: latest })
        })
        if (phase !== 'loading') {
          mic.stop()
          mic = null
          return
        }
        phase = 'listening'
        updateDictation({ phase: 'listening', level: 0, text: latest, error: '' })
        send({ phase: 'listening', text: latest })
      } catch (err) {
        const cancelled = phase !== 'loading'
        teardown()
        phase = 'idle'
        await window.forja.stt.stop().catch(() => undefined)
        if (!cancelled) fail(micErrorMessage(err))
      }
    }

    const toggle = (): void => {
      if (phase === 'idle') void start()
      else if (phase === 'listening' || phase === 'loading') void stop()
    }

    /** Stops without inserting text: the user changed session/project. */
    const cancel = (): void => {
      if (phase === 'idle') return
      phase = 'idle'
      teardown()
      void window.forja.stt.stop().catch(() => undefined)
      reset()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && (phase === 'listening' || phase === 'loading')) {
        event.preventDefault()
        void stop()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    const unregister = registerDictationHandlers({ toggle, stop, cancel })
    removeToggle = window.forja.dictation.onToggle(toggle)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unregister()
      removeToggle?.()
      removeToggle = null
      if (phase !== 'idle') {
        mic?.stop()
        unsubscribe?.()
        void window.forja.stt.stop()
      }
      reset()
    }
  }, [])

  // Keep the Whisper model warm: the first mic click should not wait for the
  // 1 GB model to load. Runs in the background, never interrupts a dictation.
  useEffect(() => {
    if (!voice) return
    const timer = setTimeout(() => {
      if (dictationSnapshot().phase !== 'idle') return
      void window.forja.stt.preload({ model: voice.model, language: voice.language })
    }, 1200)
    return () => clearTimeout(timer)
  }, [voice?.model, voice?.language])

  return null
}
