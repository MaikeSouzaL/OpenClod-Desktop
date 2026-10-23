import workletUrl from './pcm-worklet.js?url'

/**
 * Microphone capture for dictation: getUserMedia -> AudioContext at 16 kHz ->
 * AudioWorklet -> 100 ms int16 chunks. Chromium resamples the device stream to
 * the context's rate, so the chunks are exactly what the recognizer expects.
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

/**
 * Keeps the dictated text apart from what the user typed, so partial results
 * can be replaced as they improve without touching anything else.
 */
export class Dictation {
  private base = ''
  private finals = ''
  private partial = ''

  /** `current` is the composer text when dictation begins. */
  constructor(current: string) {
    this.base = current
  }

  private join(left: string, right: string): string {
    if (!left) return right
    if (!right) return left
    return /\s$/.test(left) ? `${left}${right}` : `${left} ${right}`
  }

  /** The text the composer should show right now. */
  get text(): string {
    return this.join(this.join(this.base, this.finals), this.partial)
  }

  setPartial(text: string): string {
    this.partial = text.trim()
    return this.text
  }

  addFinal(text: string): string {
    const clean = text.trim()
    this.partial = ''
    if (clean) this.finals = this.join(this.finals, clean)
    return this.text
  }

  /** The user edited the box by hand: what is there now becomes the new base. */
  rebase(current: string): void {
    this.base = current
    this.finals = ''
    this.partial = ''
  }

  /** True when `current` is not what dictation last wrote (the user typed or deleted). */
  diverged(current: string): boolean {
    return current !== this.text
  }
}
