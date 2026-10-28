import { marked } from 'marked'
import { splitDrawings } from './drawings'

/**
 * What the "Ler em voz alta" button speaks: the answer as the screen shows it, in sentences. The model's text is
 * markdown; the screen turns `**forte**` into bold, `- item` into a bullet, `[site](url)` into a link, and draws an
 * SVG as a picture. A voice that gets the raw source reads "asterisco asterisco", the backticks, the dashes and the
 * whole address of every link. This walks the same tokens the screen renders (marked, same options) and keeps only
 * the text that ends up visible. Pure (no DOM), so it can be tested.
 */

/** The part of a marked token this file looks at (marked's own union types every case as `any`). */
interface Tok {
  type: string
  text?: string
  lang?: string
  ordered?: boolean
  start?: number | ''
  tokens?: Tok[]
  items?: Tok[]
  header?: Tok[]
  rows?: Tok[][]
}

/** Spoken when an answer is only code and drawings: nothing would be read, and a silent button looks broken. */
export const SPEECH_FALLBACK = 'Esta resposta só tem código ou desenho, que não são lidos em voz alta.'

/** The main process refuses more than 20 000 characters; stay clear of it and cut at the end of a sentence. */
const MAX_SPOKEN = 18_000

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»'
}

/** The screen shows `&amp;` as `&`: so does the voice. */
function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,8});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** A block of text as a spoken sentence: one line, and a full stop when it has none (a pause between items). */
function sentence(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  return /[.!?…:;]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function inlineText(tokens: Tok[] | undefined): string {
  let out = ''
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'br':
        out += '\n'
        break
      case 'image':
        // A picture: nothing to read.
        break
      case 'html':
        // `<br>` is a line break on screen; any other tag shows nothing (its text arrives as its own `text` token).
        if (/^<br\s*\/?>$/i.test((token.text ?? '').trim())) out += '\n'
        break
      case 'codespan':
      case 'escape':
        out += decodeEntities(token.text ?? '')
        break
      default:
        out += token.tokens?.length ? inlineText(token.tokens) : decodeEntities(token.text ?? '')
    }
  }
  return out
}

/** Fence languages whose content is meant to be read (a reply drafted for a client), as opposed to code. */
const PROSE_FENCES = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'md', 'markdown', 'pt', 'pt-br'])

function looksLikeProse(body: string): boolean {
  const compact = body.replace(/\s+/g, '')
  if (compact.length < 12) return false
  const letters = compact.match(/\p{L}/gu)?.length ?? 0
  return letters / compact.length >= 0.8 && /\p{L}{2,}\s+\p{L}{2,}/u.test(body)
}

/** A fenced block is shown as code, and code is not read. A block with no language that is plain sentences is. */
function fenceLines(token: Tok): string[] {
  const language = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase()
  const body = token.text ?? ''
  if (!PROSE_FENCES.has(language) || !looksLikeProse(body)) return []
  return body
    .split(/\r?\n/)
    .map((line) => sentence(line.replace(/\*\*|__|~~|`/g, '')))
    .filter(Boolean)
}

function htmlText(html: string): string {
  const withoutCode = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
  return decodeEntities(withoutCode.replace(/<[^>]*>/g, ' '))
}

function listLines(list: Tok): string[] {
  const out: string[] = []
  const first = typeof list.start === 'number' ? list.start : 1
  ;(list.items ?? []).forEach((item, index) => {
    const body = blockLines(item.tokens)
    if (!body.length) return
    const [head, ...rest] = body
    // The bullet is a symbol and is not read; the number of an ordered list is.
    out.push(sentence(`${list.ordered ? `${first + index}, ` : ''}${head}`), ...rest)
  })
  return out
}

function tableLines(table: Tok): string[] {
  const row = (cells: Tok[]): string =>
    sentence(
      cells
        .map((cell) => inlineText(cell.tokens).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(', ')
    )
  return [row(table.header ?? []), ...(table.rows ?? []).map(row)].filter(Boolean)
}

function blockLines(tokens: Tok[] | undefined): string[] {
  const out: string[] = []
  const add = (value: string): void => {
    for (const line of value.split('\n')) {
      const spoken = sentence(line)
      if (spoken) out.push(spoken)
    }
  }
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'heading':
      case 'paragraph':
        add(inlineText(token.tokens))
        break
      case 'text':
        add(token.tokens?.length ? inlineText(token.tokens) : decodeEntities(token.text ?? ''))
        break
      case 'blockquote':
        out.push(...blockLines(token.tokens))
        break
      case 'list':
        out.push(...listLines(token))
        break
      case 'table':
        out.push(...tableLines(token))
        break
      case 'code':
        out.push(...fenceLines(token))
        break
      case 'html':
        add(htmlText(token.text ?? ''))
        break
      default:
      // space, hr, def: nothing is shown that could be read.
    }
  }
  return out
}

/** Last clean-up of the whole text: addresses, emoji, symbols the voices spell out, spacing, size. */
function tidy(text: string): string {
  const out = text
    // A web address read letter by letter is noise; the site is what matters. The sentence's own full stop is not part of it.
    .replace(/\bhttps?:\/\/[^\s)>\]"]*[^\s)>\]".,;:!?]/gi, (url) => hostOf(url) || 'link')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    // Separators drawn as dots and arrows are a pause, not a spoken "ponto" or "seta".
    .replace(/[·•▪◦‣]/g, ',')
    .replace(/\s*[→⇒➜➔]\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[,\s]+/gm, '')
    .trim()
  if (out.length <= MAX_SPOKEN) return out
  const cut = out.slice(0, MAX_SPOKEN)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'))
  return (end > MAX_SPOKEN / 2 ? cut.slice(0, end + 1) : cut).trim()
}

/** The text to hand to the voice for an answer written in markdown; empty when nothing in it can be read. */
export function speechText(markdown: string): string {
  const prose = splitDrawings(markdown)
    .flatMap((segment) => (segment.type === 'md' ? [segment.text] : []))
    .join('\n\n')
  const tokens = marked.lexer(prose, { gfm: true, breaks: true }) as unknown as Tok[]
  return tidy(blockLines(tokens).join('\n'))
}
