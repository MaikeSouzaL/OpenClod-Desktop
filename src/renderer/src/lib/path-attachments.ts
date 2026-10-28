/**
 * Path attachments for the composer.
 *
 * Folders and files that should not be inlined (executables, archives, large
 * binaries) are attached by absolute path. Nothing is read into the prompt:
 * the agent explores the path on demand with its file/shell tools.
 */

export type PathKind = 'folder' | 'file'

export interface PathAttachment {
  id: string
  kind: PathKind
  /** Last path segment, shown on the chip. */
  name: string
  /** Absolute path exactly as Windows reported it. */
  path: string
}

export interface IncomingPath {
  path: string
  kind: PathKind
}

/** Extensions the composer can safely inline as text without guessing. */
const TEXT_EXTENSIONS = new Set([
  'bat',
  'c',
  'cfg',
  'cmd',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'env',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'markdown',
  'php',
  'ps1',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml'
])

let pathSeq = 0

function nextId(kind: PathKind): string {
  pathSeq += 1
  return `${kind === 'folder' ? 'dir' : 'file'}_${Date.now().toString(36)}_${pathSeq}`
}

/** Normalizes separators for display and de-duplication. */
function normalize(value: string): string {
  return value.trim().replace(/[\\/]+$/, '')
}

/** Windows paths compare case-insensitively; this app is Windows-first. */
function samePath(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}

/** Builds a path attachment from an absolute path, or null when it is empty. */
export function pathAttachment(input: string, kind: PathKind): PathAttachment | null {
  const value = normalize(input)
  if (!value) return null
  const name = value.split(/[\\/]/).filter(Boolean).pop() ?? value
  return { id: nextId(kind), kind, name, path: value }
}

/**
 * Appends the given paths to the current list, dropping duplicates and
 * respecting `max` total attachments. Returns the same array when nothing
 * changed, so React can skip a re-render.
 */
export function addPathAttachments(
  current: PathAttachment[],
  incoming: IncomingPath[],
  max: number
): PathAttachment[] {
  let next = current
  for (const entry of incoming) {
    if (next.length >= max) break
    const attachment = pathAttachment(entry.path, entry.kind)
    if (!attachment) continue
    if (next.some((item) => samePath(item.path, attachment.path))) continue
    if (next === current) next = [...current]
    next.push(attachment)
  }
  return next
}

/**
 * Whether a dropped/picked file can be embedded as text. Unknown binaries are
 * attached by path instead, never decoded as UTF-8.
 */
export function isInlineText(name: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true
  if (/(json|xml|yaml|x-sh|x-javascript|x-typescript|sql)/.test(mime)) return true
  // Dotfiles such as .gitignore/.env have no extension after split('.').
  if (name.startsWith('.') && !name.slice(1).includes('.')) return true
  const extension = name.toLowerCase().split('.').pop() ?? ''
  return TEXT_EXTENSIONS.has(extension)
}

/**
 * Prompt block sent with the message. Human-readable on purpose: it also
 * documents the attachments when the session is reopened in the transcript.
 */
export function pathPromptBlock(items: PathAttachment[]): string {
  if (!items.length) return ''
  const rows = items
    .map((item) => `- ${item.kind === 'folder' ? 'pasta' : 'arquivo'} "${item.name}": \`${item.path}\``)
    .join('\n')
  return `\n\nPastas e arquivos anexados pelo usuário (estude o conteúdo sob demanda, com list_files, read_file e as ferramentas de shell; eles podem estar fora do projeto):\n${rows}`
}
