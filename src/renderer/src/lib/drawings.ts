/**
 * Drawings in the model's answer. Like Claude, the app shows an SVG (or a small HTML/canvas page) that the
 * model writes in a fenced block as a picture on screen, with a Code tab, instead of leaving it as text.
 * This file is pure (no DOM) so the detection can be tested.
 */

export type DrawingKind = 'svg' | 'html'

export type Segment =
  | { type: 'md'; text: string }
  | { type: 'drawing'; kind: DrawingKind; source: string; ordinal: number }

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/

export function looksLikeSvg(code: string): boolean {
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(code) && /<\/svg>\s*$/i.test(code.trim())
}

/** A page worth rendering (a whole document, a canvas or an inline svg) as opposed to a snippet shown to explain markup. */
export function isDrawableHtml(code: string): boolean {
  return /<!doctype html|<html[\s>]|<canvas[\s>]|<svg[\s>]/i.test(code)
}

function classify(lang: string, body: string): DrawingKind | null {
  const language = lang.toLowerCase()
  if ((language === 'svg' || language === 'xml' || language === '') && looksLikeSvg(body)) return 'svg'
  if ((language === 'html' || language === 'htm') && isDrawableHtml(body)) return 'html'
  return null
}

/** Splits an answer into prose and drawings. An unclosed fence (still streaming) stays prose until it closes. */
export function splitDrawings(text: string): Segment[] {
  const lines = text.split('\n')
  const out: Segment[] = []
  let prose: string[] = []
  let ordinal = 0
  const flush = (): void => {
    if (!prose.length) return
    const joined = prose.join('\n')
    prose = []
    // A bare <svg>...</svg> in the text (not fenced) is a drawing too.
    let last = 0
    for (const match of joined.matchAll(/(^|\n)[ \t]*(<svg[\s>][\s\S]*?<\/svg>)/gi)) {
      const start = (match.index ?? 0) + match[1].length
      if (start > last) out.push({ type: 'md', text: joined.slice(last, start) })
      out.push({ type: 'drawing', kind: 'svg', source: match[2].trim(), ordinal: ordinal++ })
      last = start + match[0].length - match[1].length
    }
    if (last < joined.length) out.push({ type: 'md', text: joined.slice(last) })
  }

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i])
    if (!open) {
      prose.push(lines[i])
      continue
    }
    const fence = open[1]
    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim()
      if (trimmed.length >= fence.length && trimmed[0] === fence[0] && [...trimmed].every((char) => char === fence[0])) {
        close = j
        break
      }
    }
    if (close < 0) {
      // Not closed yet: the rest is still being written.
      prose.push(...lines.slice(i))
      break
    }
    const body = lines.slice(i + 1, close).join('\n')
    const kind = classify(open[2], body)
    if (kind) {
      flush()
      out.push({ type: 'drawing', kind, source: body.trim(), ordinal: ordinal++ })
    } else {
      prose.push(...lines.slice(i, close + 1))
    }
    i = close
  }
  flush()
  return out.filter((segment) => segment.type === 'drawing' || segment.text.trim())
}

/** `<img>` needs the namespace; models often forget it. */
export function ensureSvgNamespace(svg: string): string {
  const root = /<svg\b[^>]*>/i.exec(svg)
  if (!root || /\sxmlns\s*=/.test(root[0])) return svg
  return svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ensureSvgNamespace(svg))}`
}

/** Whether the root element fixes its own size (otherwise the picture is given a comfortable default width). */
export function svgHasIntrinsicSize(svg: string): boolean {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  return /\swidth\s*=\s*["']?\d/.test(root) && /\sheight\s*=\s*["']?\d/.test(root)
}

/** Name for a download, taken from the SVG's own title when it has one. */
export function drawingFileName(kind: DrawingKind, source: string): string {
  const title = /<title[^>]*>([^<]{1,60})<\/title>/i.exec(source)?.[1]?.trim()
  const base = (title || 'desenho')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'desenho'}.${kind === 'svg' ? 'svg' : 'html'}`
}
