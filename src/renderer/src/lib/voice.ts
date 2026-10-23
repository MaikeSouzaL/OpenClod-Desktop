/**
 * Microphone capture for dictation: getUserMedia -> AudioContext at 16 kHz ->
 * AudioWorklet -> 100 ms int16 chunks. Chromium resamples the device stream to
 * the context's rate, so the chunks are exactly what the recognizer expects.
 *
 * The worklet is a static file (public/pcm-worklet.js), not a Vite `?url`
 * import: small assets would be inlined as a data: URL, which the app's CSP
 * blocks for scripts and Chromium refuses for AudioWorklet.addModule().
 */

export interface MicChunk {
  pcm: ArrayBuffer
  /** 0..1 loudness of the chunk, for the level meter. */
  rms: number
}

export interface MicCapture {
  stop(): void
}

export function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'O Windows bloqueou o microfone. Em Configurações → Privacidade → Microfone, permita que aplicativos da área de trabalho usem o microfone.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Nenhum microfone foi encontrado.'
  if (name === 'NotReadableError') return 'O microfone está em uso por outro aplicativo ou não pôde ser aberto.'
  return error instanceof Error ? error.message : String(error)
}

export async function startMic(onChunk: (chunk: MicChunk) => void, deviceId?: string): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  const context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
  const workletUrl = new URL('pcm-worklet.js', window.location.href).toString()
  try {
    await context.audioWorklet.addModule(workletUrl)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    await context.close().catch(() => undefined)
    throw error
  }
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
  node.port.onmessage = (event: MessageEvent<MicChunk>) => onChunk(event.data)
  source.connect(node)
  await context.resume()

  let stopped = false
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      node.port.onmessage = null
      try {
        source.disconnect()
        node.disconnect()
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((track) => track.stop())
      void context.close().catch(() => undefined)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Text assembly                                                       */
/* ------------------------------------------------------------------ */

// The text assembler is pure and lives in core; this re-export keeps the
// renderer's imports stable.
export { Dictation } from '../../../core/util/dictation.js'
