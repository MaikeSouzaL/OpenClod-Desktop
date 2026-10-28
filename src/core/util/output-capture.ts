import { StreamDecoder } from './oem-decode.js'

/**
 * Collects a process stream without unbounded memory and without losing the end.
 * Keeps the first `headMax` characters and a rolling window of the last `tailMax`:
 * for builds and test runs the summary and the error are at the end, so a buffer that
 * stops growing once full (and drops everything after) hides exactly what matters.
 * Bytes go through a StreamDecoder: a multi-byte character split across two chunks stays whole, and on
 * Windows each line is read as UTF-8 or, if it is not valid UTF-8, as the OEM code page (cmd's own output).
 */
export class OutputCapture {
  private head = ''
  private tail = ''
  private dropped = 0
  private readonly decoder = new StreamDecoder()

  constructor(
    private readonly headMax = 120_000,
    private readonly tailMax = 480_000
  ) {}

  /** Adds a chunk and returns its decoded text. */
  push(data: Buffer | string): string {
    const text = typeof data === 'string' ? data : this.decoder.write(data)
    this.append(text)
    return text
  }

  private append(input: string): void {
    let text = input
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length
      this.head += text.slice(0, room)
      text = text.slice(room)
    }
    if (!text) return
    this.tail += text
    if (this.tail.length > this.tailMax) {
      const cut = this.tail.length - this.tailMax
      this.dropped += cut
      this.tail = this.tail.slice(cut)
    }
  }

  /** Flushes a pending partial character and returns everything kept. */
  toString(): string {
    const rest = this.decoder.end()
    if (rest) this.append(rest)
    return this.dropped ? `${this.head}\n…[${this.dropped} caracteres omitidos do meio da saída]…\n${this.tail}` : this.head + this.tail
  }
}
