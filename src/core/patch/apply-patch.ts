/**
 * The `apply_patch` format (Codex / OpenAI): several files changed in one call, each by context instead of line numbers.
 *
 *   *** Begin Patch
 *   *** Add File: src/new.ts
 *   +export const x = 1
 *   *** Update File: src/app.ts
 *   *** Move to: src/main.ts            (optional)
 *   @@ function start() {                (optional: a line to find first)
 *    const a = 1
 *   -const b = 2
 *   +const b = 3
 *   *** End of File                      (optional: the chunk ends the file)
 *   *** Delete File: src/old.ts
 *   *** End Patch
 *
 * Pure: parsing and computing the new text. The tool (src/core/tools/apply-patch.ts) checks, locks and writes.
 */

export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] }

export interface PatchChunk {
  /** Text after "@@": a line found before the chunk's own lines (a function or class header). */
  context?: string
  /** The lines the file has now (context and removed). */
  oldLines: string[]
  /** The lines it gets (context and added). */
  newLines: string[]
  /** "*** End of File": the chunk matches the end of the file. */
  endOfFile: boolean
}

export class PatchError extends Error {}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '
const MOVE = '*** Move to: '
const EOF_MARK = '*** End of File'

/**
 * Reads a patch. Lenient where models usually slip: text around the Begin/End markers (a heredoc, a code fence), a
 * missing "*** End Patch", a first chunk without "@@", and an empty line inside a chunk read as an empty context line.
 */
export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const begin = lines.findIndex((line) => line.trim() === BEGIN)
  if (begin < 0) throw new PatchError('o patch precisa começar com "*** Begin Patch".')
  let end = lines.findIndex((line, index) => index > begin && line.trim() === END)
  if (end < 0) end = lines.length
  const body = lines.slice(begin + 1, end)
  const ops: PatchOp[] = []
  let index = 0
  const isHeader = (line: string): boolean => line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE)

  while (index < body.length) {
    const line = body[index]
    if (!line.trim()) {
      index++
      continue
    }
    if (line.startsWith(ADD)) {
      const file = cleanPath(line.slice(ADD.length), line)
      const content: string[] = []
      index++
      while (index < body.length && !isHeader(body[index])) {
        const row = body[index]
        if (row.startsWith('+')) content.push(row.slice(1))
        else if (row.trim()) throw new PatchError(`em "*** Add File: ${file}" toda linha começa com "+" (linha: "${row.slice(0, 80)}").`)
        index++
      }
      ops.push({ kind: 'add', path: file, content: content.length ? `${content.join('\n')}\n` : '' })
      continue
    }
    if (line.startsWith(DELETE)) {
      ops.push({ kind: 'delete', path: cleanPath(line.slice(DELETE.length), line) })
      index++
      continue
    }
    if (line.startsWith(UPDATE)) {
      const file = cleanPath(line.slice(UPDATE.length), line)
      index++
      let moveTo: string | undefined
      if (index < body.length && body[index].startsWith(MOVE)) {
        moveTo = cleanPath(body[index].slice(MOVE.length), body[index])
        index++
      }
      const chunks: PatchChunk[] = []
      let chunk: PatchChunk | null = null
      while (index < body.length && !isHeader(body[index])) {
        const row = body[index]
        if (row.startsWith('@@')) {
          if (chunk) chunks.push(chunk)
          const context = row.slice(2).trim()
          chunk = { ...(context ? { context } : {}), oldLines: [], newLines: [], endOfFile: false }
        } else if (row.trim() === EOF_MARK) {
          if (!chunk) throw new PatchError(`"${EOF_MARK}" sem trecho antes, em ${file}.`)
          chunk.endOfFile = true
        } else {
          chunk ??= { oldLines: [], newLines: [], endOfFile: false }
          const sign = row[0]
          const rest = row.slice(1)
          if (sign === ' ') {
            chunk.oldLines.push(rest)
            chunk.newLines.push(rest)
          } else if (sign === '-') chunk.oldLines.push(rest)
          else if (sign === '+') chunk.newLines.push(rest)
          else if (row === '') {
            chunk.oldLines.push('')
            chunk.newLines.push('')
          } else {
            throw new PatchError(`linha inválida em "*** Update File: ${file}": "${row.slice(0, 80)}" (cada linha começa com " ", "-", "+" ou "@@").`)
          }
        }
        index++
      }
      if (chunk) chunks.push(chunk)
      // Trailing empty context lines are just the blank lines between files.
      for (const item of chunks) trimTrailingBlank(item)
      const real = chunks.filter((item) => item.oldLines.length || item.newLines.length)
      if (!real.length && !moveTo) throw new PatchError(`"*** Update File: ${file}" não tem nenhuma alteração.`)
      ops.push({ kind: 'update', path: file, ...(moveTo ? { moveTo } : {}), chunks: real })
      continue
    }
    throw new PatchError(`linha inesperada: "${line.slice(0, 80)}". Use "*** Add File:", "*** Update File:" ou "*** Delete File:".`)
  }
  if (!ops.length) throw new PatchError('o patch não tem nenhuma operação.')
  return ops
}

function trimTrailingBlank(chunk: PatchChunk): void {
  while (chunk.oldLines.length && chunk.newLines.length && chunk.oldLines.at(-1) === '' && chunk.newLines.at(-1) === '') {
    chunk.oldLines.pop()
    chunk.newLines.pop()
  }
}

function cleanPath(raw: string, line: string): string {
  const file = raw.trim().replace(/^["'`]|["'`]$/g, '')
  if (!file) throw new PatchError(`caminho vazio em "${line}".`)
  return file
}

/** Every path a patch touches (the moved-to paths included): what the permission and credential checks look at. */
export function patchPaths(text: string): string[] {
  let ops: PatchOp[]
  try {
    ops = parsePatch(text)
  } catch {
    return []
  }
  const out: string[] = []
  for (const op of ops) {
    out.push(op.path)
    if (op.kind === 'update' && op.moveTo) out.push(op.moveTo)
  }
  return [...new Set(out)]
}

/** Whether a patch removes a file: that makes the call destructive, like delete_path. */
export function patchDeletes(text: string): boolean {
  try {
    return parsePatch(text).some((op) => op.kind === 'delete')
  } catch {
    return false
  }
}

/** Dashes, quotes and spaces that look alike: the last fallback when a line does not match. */
function normalize(line: string): string {
  return line
    .trim()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[  -   　]/g, ' ')
}

/**
 * Where `pattern` occurs in `lines` at or after `start`: exactly, then ignoring trailing spaces, then ignoring
 * surrounding spaces, then with look-alike punctuation folded. `endOfFile` tries the end of the file first.
 */
export function seekSequence(lines: string[], pattern: string[], start: number, endOfFile = false): number {
  if (!pattern.length) return start
  if (pattern.length > lines.length) return -1
  const last = lines.length - pattern.length
  const compares: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normalize(a) === normalize(b)
  ]
  for (const same of compares) {
    const at = (index: number): boolean => pattern.every((line, offset) => same(lines[index + offset], line))
    if (endOfFile && last >= start && at(last)) return last
    for (let index = start; index <= last; index++) if (at(index)) return index
  }
  return -1
}

/** The new text of a file after an update's chunks, or a PatchError saying which chunk did not match. */
export function applyChunks(before: string, chunks: PatchChunk[], file: string): string {
  const crlf = before.includes('\r\n')
  const lf = crlf ? before.replace(/\r\n/g, '\n') : before
  const lines = lf ? lf.split('\n') : []
  // "a\nb\n" is two lines and a final newline, not three lines. An empty file gets one when lines are added.
  const finalNewline = !lf || lines.at(-1) === ''
  if (lf && finalNewline) lines.pop()
  const replacements: Array<[at: number, remove: number, insert: string[]]> = []
  let cursor = 0
  for (const [number, chunk] of chunks.entries()) {
    if (chunk.context) {
      const found = seekSequence(lines, [chunk.context], cursor)
      if (found < 0) throw new PatchError(`${file}: não achei a linha "${chunk.context}" do @@ (trecho ${number + 1}).`)
      cursor = found + 1
    }
    if (!chunk.oldLines.length) {
      // Only additions: they go at the end of the file (after the @@ line when there is one).
      const at = chunk.context ? cursor : lines.length
      replacements.push([at, 0, chunk.newLines])
      continue
    }
    let pattern = chunk.oldLines
    let insert = chunk.newLines
    let found = seekSequence(lines, pattern, cursor, chunk.endOfFile)
    if (found < 0 && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1)
      insert = insert.at(-1) === '' ? insert.slice(0, -1) : insert
      found = seekSequence(lines, pattern, cursor, chunk.endOfFile)
    }
    if (found < 0) {
      const preview = chunk.oldLines.slice(0, 3).join('\n')
      throw new PatchError(`${file}: o trecho ${number + 1} não confere com o arquivo (procurei:\n${preview}${chunk.oldLines.length > 3 ? '\n…' : ''}). Leia o arquivo de novo e refaça o trecho.`)
    }
    replacements.push([found, pattern.length, insert])
    cursor = found + pattern.length
  }
  for (const [at, remove, insert] of [...replacements].sort((a, b) => b[0] - a[0])) lines.splice(at, remove, ...insert)
  // The file keeps its own ending: a final newline only when it had one.
  const text = `${lines.join('\n')}${finalNewline && lines.length ? '\n' : ''}`
  return crlf ? text.replace(/\n/g, '\r\n') : text
}
