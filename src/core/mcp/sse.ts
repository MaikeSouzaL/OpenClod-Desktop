/**
 * Server-Sent Events parsing for the MCP HTTP transports. Incremental: a chunk
 * may end in the middle of a line or of an event, and an event may carry several
 * `data:` lines. Pure, so the transport tests can feed it byte by byte.
 */

export interface SseEvent {
  /** `message` when the server sent no `event:` field. */
  event: string
  data: string
  id?: string
}

export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  private id: string | undefined

  /** Feeds a decoded chunk and returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const out: SseEvent[] = []
    let index: number
    // Lines end with \n, \r or \r\n; a lone trailing \r may be half of a \r\n, so it waits for more input.
    while ((index = this.nextLineBreak()) >= 0) {
      const line = this.buffer.slice(0, index)
      const skip = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1
      this.buffer = this.buffer.slice(index + skip)
      const event = this.line(line)
      if (event) out.push(event)
    }
    return out
  }

  /** Flushes an event the stream ended in the middle of (servers that forget the final blank line). */
  end(): SseEvent[] {
    const out: SseEvent[] = []
    if (this.buffer) {
      const event = this.line(this.buffer)
      this.buffer = ''
      if (event) out.push(event)
    }
    const last = this.dispatch()
    if (last) out.push(last)
    return out
  }

  private nextLineBreak(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i]
      if (ch === '\n') return i
      if (ch === '\r') {
        if (i === this.buffer.length - 1) return -1
        return i
      }
    }
    return -1
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
    else if (field === 'id') this.id = value
    return null
  }

  private dispatch(): SseEvent | null {
    if (!this.data.length && !this.event) {
      this.id = undefined
      return null
    }
    const event: SseEvent = { event: this.event || 'message', data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}) }
    this.event = ''
    this.data = []
    this.id = undefined
    return event
  }
}
