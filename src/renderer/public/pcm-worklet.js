// AudioWorklet that turns microphone audio (already resampled to 16 kHz by the
// AudioContext) into little-endian int16 chunks of 100 ms, plus their RMS level.
//
// This file lives in the renderer's public/ folder on purpose: the app's CSP
// allows scripts from 'self' only, and Chromium refuses a data: URL passed to
// AudioWorklet.addModule(). Vite copies this file to out/renderer as-is.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = 1600
    this.buffer = new Int16Array(this.size)
    this.filled = 0
    this.sum = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let index = 0; index < channel.length; index++) {
      const value = Math.max(-1, Math.min(1, channel[index]))
      this.sum += value * value
      this.buffer[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff
      if (this.filled === this.size) {
        const rms = Math.sqrt(this.sum / this.size)
        const pcm = this.buffer.buffer.slice(0)
        this.port.postMessage({ pcm, rms }, [pcm])
        this.filled = 0
        this.sum = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
