import { spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Windows consoles mix two encodings in one pipe: cmd.exe's own output (echo, dir, error messages) comes in
 * the OEM code page (850 in pt-BR, 437 in en-US) while node, python and most modern tools write UTF-8. Reading
 * everything as UTF-8 turned "não" into "n�o". Each line is therefore decoded as UTF-8 when it is valid
 * UTF-8 and as the OEM code page when it is not. (`chcp 65001` does not help: cmd's builtins ignore it when
 * stdout is a pipe, which was checked byte by byte.)
 */

// Upper half (0x80-0xFF) of the two Western OEM code pages.
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ '
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

const utf8 = new TextDecoder('utf-8', { fatal: true })
const latin = new TextDecoder('windows-1252')

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    utf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Decodes one line: UTF-8 when valid, otherwise the given OEM code page (850/437; anything else falls back to Windows-1252). */
export function decodeLine(bytes: Buffer, oemCodePage?: number): string {
  if (isValidUtf8(bytes)) return bytes.toString('utf8')
  const table = oemCodePage === 850 ? CP850 : oemCodePage === 437 ? CP437 : null
  if (!table) return latin.decode(bytes)
  let out = ''
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80]
  return out
}

let cachedOem: number | undefined
/** OEM code page of this Windows install (`chcp` as seen by a child console); undefined elsewhere. */
export function oemCodePage(): number | undefined {
  if (process.platform !== 'win32') return undefined
  if (cachedOem !== undefined) return cachedOem
  try {
    const result = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, timeout: 3000, encoding: 'latin1' })
    const match = /(\d{3,5})\s*$/.exec(String(result.stdout ?? '').trim())
    cachedOem = match ? Number(match[1]) : 850
  } catch {
    cachedOem = 850
  }
  return cachedOem
}

/**
 * Stateful decoder for a byte stream. On Windows it works line by line (see above); elsewhere it is a plain
 * UTF-8 decoder. A partial last line is held back until its newline arrives or `end()` is called.
 */
export class StreamDecoder {
  private pending: Buffer = Buffer.alloc(0)
  private readonly oem: number | undefined
  // Non-Windows: a plain UTF-8 decoder that keeps multi-byte characters intact across chunks.
  private readonly plain = new StringDecoder('utf8')

  constructor(oem: number | undefined = oemCodePage()) {
    this.oem = oem
  }

  write(chunk: Buffer): string {
    if (this.oem === undefined) return this.plain.write(chunk)
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const lastNewline = data.lastIndexOf(0x0a)
    if (lastNewline < 0) {
      this.pending = Buffer.from(data)
      return ''
    }
    this.pending = Buffer.from(data.subarray(lastNewline + 1))
    return this.lines(data.subarray(0, lastNewline + 1))
  }

  end(): string {
    if (this.oem === undefined) return this.plain.end()
    const rest = this.pending
    this.pending = Buffer.alloc(0)
    return rest.length ? decodeLine(rest, this.oem) : ''
  }

  private lines(block: Buffer): string {
    let out = ''
    let start = 0
    while (start < block.length) {
      const newline = block.indexOf(0x0a, start)
      const end = newline < 0 ? block.length : newline + 1
      out += decodeLine(block.subarray(start, end), this.oem)
      start = end
    }
    return out
  }
}
