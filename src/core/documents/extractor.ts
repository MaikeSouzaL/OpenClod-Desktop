import fs from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { strFromU8, unzipSync } from 'fflate'

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_TEXT_CHARS = 3_000_000
/** A zip entry may declare at most this much once inflated; a 300 KB file that expands to 300 MB is a zip bomb, not a document. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_UNZIPPED_BYTES = 128 * 1024 * 1024

/** Inflates only the entries the format needs, refusing absurd expansion before any memory is allocated. */
function unzipLimited(buffer: Buffer, wanted: RegExp): Record<string, Uint8Array> {
  let total = 0
  return unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (!wanted.test(file.name)) return false
      if (file.originalSize > MAX_ENTRY_BYTES) throw new Error(`entrada ${file.name} expande para ${Math.round(file.originalSize / 1024 / 1024)} MB; documento recusado`)
      total += file.originalSize
      if (total > MAX_UNZIPPED_BYTES) throw new Error('o documento expande para mais de 128 MB; recusado')
      return true
    }
  })
}

export type DocumentFormat = 'text' | 'markdown' | 'html' | 'csv' | 'json' | 'pdf' | 'docx' | 'xlsx' | 'pptx'

export interface DocumentPage {
  number: number
  label: string
  text: string
}

export interface DocumentChunk {
  id: string
  source: string
  page?: number
  section?: string
  start: number
  end: number
  text: string
}

export interface ExtractedDocument {
  source: string
  name: string
  format: DocumentFormat
  bytes: number
  pages: DocumentPage[]
  chunks: DocumentChunk[]
  text: string
  truncated: boolean
  warnings: string[]
  metadata: Record<string, string | number | boolean>
}

function formatOf(file: string): DocumentFormat {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx') return 'xlsx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.md' || ext === '.mdx') return 'markdown'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.csv' || ext === '.tsv') return 'csv'
  if (ext === '.json') return 'json'
  return 'text'
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&amp;/g, '&')
}

export function chunkDocument(
  source: string,
  text: string,
  opts: { chunkSize?: number; overlap?: number; page?: number; section?: string } = {}
): DocumentChunk[] {
  const chunkSize = Math.max(80, Math.min(20_000, Math.round(opts.chunkSize ?? 2_500)))
  const overlap = Math.max(0, Math.min(Math.floor(chunkSize / 2), Math.round(opts.overlap ?? 250)))
  const chunks: DocumentChunk[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + chunkSize)
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n\n', end), text.lastIndexOf('. ', end), text.lastIndexOf('\n', end))
      if (boundary > start + Math.floor(chunkSize * 0.55)) end = boundary + 1
    }
    const body = text.slice(start, end).trim()
    if (body) chunks.push({ id: `${source}:${opts.page ?? 1}:${chunks.length + 1}`, source, page: opts.page, section: opts.section, start, end, text: body })
    if (end >= text.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return chunks
}

export async function extractDocument(
  file: string,
  options: { maxChars?: number; chunkSize?: number; overlap?: number } = {}
): Promise<ExtractedDocument> {
  const resolved = path.resolve(file)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('documento não é um arquivo')
  if (stat.size > MAX_FILE_BYTES) throw new Error('documento maior que 100 MB')
  const format = formatOf(resolved)
  const maxChars = Math.max(1_000, Math.min(MAX_TEXT_CHARS, options.maxChars ?? MAX_TEXT_CHARS))
  const buffer = await fs.promises.readFile(resolved)
  const warnings: string[] = []
  let pages: DocumentPage[] = []
  let metadata: Record<string, string | number | boolean> = {}

  if (format === 'docx') {
    const zip = unzipLimited(buffer, /^word\/document\.xml$/)
    const xml = officeFile(zip, 'word/document.xml')
    if (!xml) throw new Error('DOCX sem word/document.xml')
    const text = xmlToText(xml, 'word')
    pages = [{ number: 1, label: 'documento', text }]
    metadata = { paragraphs: (xml.match(/<w:p\b/g) ?? []).length }
  } else if (format === 'pptx') {
    const zip = unzipLimited(buffer, /^ppt\/slides\/slide\d+\.xml$/)
    const slides = Object.keys(zip)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0))
    if (!slides.length) throw new Error('PPTX sem slides')
    pages = slides.map((name, index) => ({
      number: index + 1,
      label: `slide ${index + 1}`,
      text: xmlToText(strFromU8(zip[name]), 'pptx')
    }))
    metadata = { slides: pages.length }
  } else if (format === 'xlsx') {
    const zip = unzipLimited(buffer, /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/)
    const sharedXml = officeFile(zip, 'xl/sharedStrings.xml')
    const shared = sharedXml ? [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlToText(match[1], 'shared')) : []
    const sheets = Object.keys(zip)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/)?.[1] ?? 0))
    if (!sheets.length) throw new Error('XLSX sem planilhas')
    pages = sheets.map((name, index) => ({
      number: index + 1,
      label: `planilha ${index + 1}`,
      text: extractWorksheet(strFromU8(zip[name]), shared)
    }))
    metadata = { sheets: pages.length }
  } else if (format === 'pdf') {
    const extracted = extractPdf(buffer)
    pages = extracted.pages
    metadata = extracted.metadata
    warnings.push(...extracted.warnings)
  } else {
    const raw = buffer.toString('utf8').replace(/\u0000/g, '')
    const text = format === 'html' ? htmlToText(raw) : raw
    pages = [{ number: 1, label: 'conteúdo', text }]
  }

  pages = pages.map((page) => ({ ...page, text: page.text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim() }))
  if (!pages.some((page) => page.text.trim())) {
    warnings.push('nenhum texto extraído; o arquivo pode estar digitalizado, vazio, protegido ou usar um formato não suportado')
  }
  let text = pages.map((page) => `## ${page.label}\n\n${page.text}`).join('\n\n')
  const truncated = text.length > maxChars
  if (truncated) {
    text = text.slice(0, maxChars)
    warnings.push(`texto truncado em ${maxChars} caracteres`)
  }
  const chunks = pages.flatMap((page) => chunkDocument(resolved, page.text.slice(0, maxChars), {
    chunkSize: options.chunkSize,
    overlap: options.overlap,
    page: page.number,
    section: page.label
  }))
  return { source: resolved, name: path.basename(resolved), format, bytes: stat.size, pages, chunks, text, truncated, warnings, metadata }
}

export function searchDocumentChunks(chunks: DocumentChunk[], query: string, limit = 10): Array<DocumentChunk & { score: number }> {
  const terms = [...new Set(query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9_]+/).filter((term) => term.length >= 3))]
  return chunks.map((chunk) => {
    const haystack = chunk.text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const score = terms.reduce((sum, term) => sum + (haystack.split(term).length - 1), 0)
    return { ...chunk, score }
  }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, limit)))
}

function officeFile(zip: Record<string, Uint8Array>, name: string): string | null {
  return zip[name] ? strFromU8(zip[name]) : null
}

function xmlToText(xml: string, kind: 'word' | 'pptx' | 'shared'): string {
  if (kind === 'pptx') {
    return xml
      .replace(/<a:br\b[^>]*\/?\s*>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<a:tab\b[^>]*\/?\s*>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .split('\n').map((line) => decodeXmlEntities(line).trim()).filter(Boolean).join('\n')
  }
  if (kind === 'shared') return decodeXmlEntities(xml.replace(/<[^>]+>/g, ''))
  return xml
    .replace(/<w:tab\b[^>]*\/?\s*>/g, '\t')
    .replace(/<w:br\b[^>]*\/?\s*>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .split('\n').map((line) => decodeXmlEntities(line).replace(/[ \t]+$/g, '').trim()).filter(Boolean).join('\n')
}

function extractWorksheet(xml: string, shared: string[]): string {
  const lines: string[] = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const match of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = match[1]
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? ''
      const type = /t="([^"]+)"/.exec(attrs)?.[1]
      const raw = /<v>([\s\S]*?)<\/v>/.exec(match[2])?.[1]
        ?? (/<is>([\s\S]*?)<\/is>/.exec(match[2])?.[1] ? xmlToText(/<is>([\s\S]*?)<\/is>/.exec(match[2])![1], 'shared') : '')
      let value = decodeXmlEntities(raw)
      if (type === 's' && /^\d+$/.test(value)) value = shared[Number(value)] ?? ''
      if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE'
      if (ref || value) cells.push(`${ref ? `${ref}: ` : ''}${value}`)
    }
    if (cells.length) lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

function htmlToText(html: string): string {
  return decodeXmlEntities(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
}

/** Heuristic: real prose is mostly letters/digits/spaces and its words contain vowels; glyph-id noise is neither. */
export function looksLikeText(text: string): boolean {
  const sample = text.slice(0, 20_000)
  if (!sample.trim()) return false
  const readable = sample.match(/[A-Za-zÀ-ÿ0-9\s.,;:!?()'"%/\-–—_@#&+=*\[\]{}]/g)?.length ?? 0
  if (readable / sample.length < 0.85) return false
  const words = sample.split(/\s+/).filter((word) => word.length >= 2)
  if (words.length < 5) return true
  const wordLike = words.filter((word) => /[aeiouáéíóúâêôãõàAEIOUÁÉÍÓÚÂÊÔÃÕÀ]/.test(word) && word.length <= 24).length
  return wordLike / words.length >= 0.5
}

function extractPdf(buffer: Buffer): { pages: DocumentPage[]; metadata: Record<string, string | number | boolean>; warnings: string[] } {
  const raw = buffer.toString('latin1')
  if (/\/Encrypt\b/.test(raw)) throw new Error('PDF protegido por senha')
  const pageMatches = raw.match(/\/Type\s*\/Page\b/g) ?? []
  const pageCount = Math.max(1, pageMatches.length)
  const byPage: string[][] = Array.from({ length: pageCount }, () => [])
  let pageIndex = 0
  const streamPattern = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamPattern.exec(raw))) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    const before = raw.slice(Math.max(0, match.index - 600), match.index)
    if (/\bBT\b/.test(before)) pageIndex = Math.min(pageCount - 1, pageIndex + 1)
    const bytes = buffer.subarray(start, end)
    let content: Buffer
    try {
      content = /FlateDecode/.test(before) ? inflateSync(bytes) : bytes
    } catch {
      streamPattern.lastIndex = end + 9
      continue
    }
    const text = pdfContentText(content.toString('latin1'))
    if (text) byPage[pageIndex].push(text)
    streamPattern.lastIndex = end + 9
  }
  const pages = byPage.map((blocks, index) => ({ number: index + 1, label: `página ${index + 1}`, text: blocks.join('\n') }))
  // Browsers and office suites embed subset fonts whose text is stored as glyph ids. Reading those as characters
  // yields noise; handing that back as a success made the model "read" a document that it never saw.
  const extracted = pages.map((page) => page.text).join('\n')
  if (extracted.trim().length >= 40 && !looksLikeText(extracted)) {
    throw new Error(
      'o texto deste PDF está em fontes embutidas e não pode ser lido por este leitor (sairia ilegível). ' +
        'Abra o PDF no navegador (browser_open) e leia a página, ou renderize as páginas como imagem e use image_ocr.'
    )
  }
  return {
    pages,
    metadata: { pages: pageCount, textStreams: pages.filter((page) => page.text).length },
    warnings: pages.some((page) => !page.text) ? ['uma ou mais páginas não têm texto extraível; OCR é necessário'] : []
  }
}

function pdfContentText(content: string): string {
  const out: string[] = []
  const token = /\((?:\\[\s\S]|[^\\)])*\)\s*Tj|\[(?:[\s\S]*?)\]\s*TJ|<\s*([a-f0-9\s]+)\s*>\s*Tj|\bT\*|\b(?:Td|TD)\b/gi
  let match: RegExpExecArray | null
  while ((match = token.exec(content))) {
    const value = match[0]
    if (/^\(/.test(value)) out.push(pdfDecodeLiteral(value.slice(0, value.lastIndexOf(')') + 1)))
    else if (/^\[/.test(value)) {
      for (const literal of value.matchAll(/\((?:\\[\s\S]|[^\\)])*\)/g)) out.push(pdfDecodeLiteral(literal[0]))
    } else if (/^</.test(value) && match[1]) {
      const hex = match[1].replace(/\s+/g, '')
      out.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('utf8'))
    } else out.push('\n')
  }
  return out.join(' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function pdfDecodeLiteral(value: string): string {
  return value.slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, escape: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[escape] ?? escape)
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}
