import fs from 'node:fs'
import path from 'node:path'
import { applyPatch } from 'diff'
import { z } from 'zod'
import type { FileChange, ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import { truncateMiddle } from '../util/ids.js'
import { withFileLock } from '../util/file-lock.js'

const MAX_READ_BYTES = 512 * 1024

/**
 * What each tracker saw when it last read a file. A write that finds a different
 * stamp means the file changed after the model looked at it (the user saved, a
 * formatter ran, another agent edited), and overwriting would silently drop that change.
 */
const readStamps = new WeakMap<object, Map<string, string>>()

function stampOf(target: string): string | null {
  try {
    const stat = fs.statSync(target)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

export function rememberRead(ctx: ToolContext, target: string): void {
  ctx.tracker.markRead(target)
  const stamp = stampOf(target)
  if (!stamp) return
  const known = readStamps.get(ctx.tracker) ?? new Map<string, string>()
  known.set(target, stamp)
  readStamps.set(ctx.tracker, known)
}

export function changedSinceRead(ctx: ToolContext, target: string): boolean {
  const known = readStamps.get(ctx.tracker)?.get(target)
  return Boolean(known && stampOf(target) !== known)
}

/** Reads an existing file as UTF-8, refusing files that a text round-trip would corrupt. */
export async function readUtf8Strict(target: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const buffer = await fs.promises.readFile(target)
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    return {
      ok: false,
      error: 'o arquivo não é UTF-8 válido (por exemplo Windows-1252); editar como texto corromperia os acentos. Altere-o por um comando que preserve a codificação.'
    }
  }
  return { ok: true, text }
}

export const STALE_MESSAGE = (name: string): string =>
  `${name} mudou no disco depois da última leitura (outra edição, formatador ou agente). Leia o arquivo de novo antes de alterá-lo.`

function numberLines(content: string, startLine: number): string {
  return content
    .split(/\r?\n/)
    .map((line, i) => `${String(startLine + i).padStart(5, ' ')}| ${line}`)
    .join('\n')
}

export const readFileTool: ToolDef = {
  name: 'read_file',
  description:
    'Lê um arquivo de texto do projeto. Use offset/limit para arquivos grandes. Retorna linhas numeradas.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    path: z.string().describe('Caminho absoluto ou relativo à raiz do projeto'),
    offset: z.number().int().min(1).optional().describe('Linha inicial (1-based)'),
    limit: z.number().int().min(1).max(2000).optional().describe('Quantidade de linhas')
  }),
  describe(a) {
    const args = a as { path: string }
    return { title: 'Ler arquivo', detail: args.path, preview: args.path }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string; offset?: number; limit?: number }
    const target = ctx.workspace.resolve(args.path, ctx.cwd)
    const stat = await fs.promises.stat(target).catch(() => null)
    if (!stat) return { ok: false, text: `arquivo não encontrado: ${args.path}` }
    if (stat.isDirectory()) return { ok: false, text: `é um diretório: ${args.path}` }
    if (stat.size > MAX_READ_BYTES) {
      return {
        ok: false,
        text: `arquivo muito grande (${Math.round(stat.size / 1024)} KB). Use read_file com offset/limit ou grep.`
      }
    }
    const buffer = await fs.promises.readFile(target)
    if (buffer.subarray(0, 4096).includes(0)) {
      return { ok: false, text: `arquivo binário (${stat.size} bytes): ${args.path}` }
    }
    const content = buffer.toString('utf8')
    const lines = content.split(/\r?\n/)
    const offset = args.offset ?? 1
    const limit = args.limit ?? 400
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    rememberRead(ctx, target)
    const header = `${args.path} (${lines.length} linhas, mostrando ${offset}-${Math.min(lines.length, offset + slice.length - 1)})`
    const body = numberLines(slice.join('\n'), offset)
    const suffix =
      offset - 1 + slice.length < lines.length
        ? `\n… use offset=${offset + slice.length} para continuar`
        : ''
    return {
      ok: true,
      text: `<file path="${args.path}">\n${header}\n${body}${suffix}\n</file>`,
      files: [target],
      summary: `${args.path} · ${slice.length} linhas`
    }
  }
}

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description:
    'Cria ou sobrescreve um arquivo. Para arquivos existentes é obrigatório tê-los lido antes. Prefira edit_file em alterações pontuais.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    path: z.string().describe('Caminho do arquivo'),
    content: z.string().max(2_000_000).describe('Conteúdo completo do arquivo')
  }),
  describe(a) {
    const args = a as { path: string; content?: string }
    return {
      title: 'Escrever arquivo',
      detail: `${args.path} (${(args.content ?? '').length} caracteres)`,
      preview: args.path
    }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string; content: string }
    const target = ctx.workspace.resolve(args.path, ctx.cwd)
    return withFileLock(target, async () => {
      const existed = fs.existsSync(target)
      if (existed && !ctx.tracker.hasRead(target)) {
        return {
          ok: false,
          text: `o arquivo ${args.path} já existe e não foi lido nesta sessão. Leia antes de sobrescrever (ou use edit_file).`
        }
      }
      if (existed && changedSinceRead(ctx, target)) return { ok: false, text: STALE_MESSAGE(args.path) }
      let before: string | null = null
      if (existed) {
        const current = await readUtf8Strict(target)
        // A non-UTF-8 original cannot be shown as a diff, but replacing it wholesale is still the caller's explicit intent.
        before = current.ok ? current.text : '(conteúdo binário ou em outra codificação)'
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(target, args.content, 'utf8')
      rememberRead(ctx, target)
      ctx.tracker.recordChange(target, before, args.content)
      return {
        ok: true,
        text: `${existed ? 'arquivo atualizado' : 'arquivo criado'}: ${args.path} (${args.content.length} caracteres)`,
        files: [target],
        summary: `${existed ? 'atualizado' : 'criado'} ${path.basename(target)}`,
        data: { path: target, bytes: Buffer.byteLength(args.content) }
      }
    })
  }
}

export type EditOutcome =
  | { ok: true; after: string; occurrences: number; note?: string }
  | { ok: false; error: 'not_found' | 'ambiguous' | 'identical'; occurrences: number }

/** Straight-quote/dash folding that keeps string length, so indices map 1:1. */
function foldTypography(text: string): string {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—]/g, '-')
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Exact-substring edit. Uses index/slice instead of String.replace so `$&`,
 * `$$` and friends in the new text are written literally. Falls back to the
 * file's CRLF line endings and to typographic quote folding when the exact
 * text is not present.
 */
export function applyEdit(before: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
  if (oldString === newString) return { ok: false, error: 'identical', occurrences: 0 }

  const attempt = (search: string, replacement: string, note?: string): EditOutcome | null => {
    const occurrences = countOccurrences(before, search)
    if (occurrences === 0) return null
    if (occurrences > 1 && !replaceAll) return { ok: false, error: 'ambiguous', occurrences }
    if (replaceAll) return { ok: true, after: before.split(search).join(replacement), occurrences, note }
    const index = before.indexOf(search)
    return { ok: true, after: before.slice(0, index) + replacement + before.slice(index + search.length), occurrences, note }
  }

  const exact = attempt(oldString, newString)
  if (exact) return exact

  if (before.includes('\r\n') && !oldString.includes('\r\n') && oldString.includes('\n')) {
    const crlf = attempt(oldString.replace(/\n/g, '\r\n'), newString.replace(/\r?\n/g, '\r\n'), 'quebras de linha CRLF do arquivo preservadas')
    if (crlf) return crlf
  }

  const foldedBefore = foldTypography(before)
  const foldedOld = foldTypography(oldString)
  const occurrences = countOccurrences(foldedBefore, foldedOld)
  if (occurrences === 1 || (occurrences > 1 && replaceAll)) {
    let after = ''
    let cursor = 0
    let index = foldedBefore.indexOf(foldedOld)
    while (index >= 0) {
      after += before.slice(cursor, index) + newString
      cursor = index + oldString.length
      if (!replaceAll) break
      index = foldedBefore.indexOf(foldedOld, cursor)
    }
    return { ok: true, after: after + before.slice(cursor), occurrences, note: 'aspas/travessões tipográficos normalizados na busca' }
  }
  if (occurrences > 1) return { ok: false, error: 'ambiguous', occurrences }
  return { ok: false, error: 'not_found', occurrences: 0 }
}

export const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    'Substitui um trecho exato de um arquivo. old_string deve ser único, a menos que replace_all seja true. Inclua contexto suficiente para a substituição ser inequívoca.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1).describe('Trecho exato a substituir'),
    new_string: z.string().describe('Novo trecho'),
    replace_all: z.boolean().optional().describe('Substituir todas as ocorrências')
  }),
  describe(a) {
    const args = a as { path: string; old_string?: string }
    const first = (args.old_string ?? '').split('\n')[0]?.slice(0, 80) ?? ''
    return { title: 'Editar arquivo', detail: `${args.path} · "${first}"`, preview: args.path }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      path: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }
    const target = ctx.workspace.resolve(args.path, ctx.cwd)
    return withFileLock(target, async () => {
      if (!fs.existsSync(target)) return { ok: false, text: `arquivo não encontrado: ${args.path}` }
      if (!ctx.tracker.hasRead(target)) {
        return { ok: false, text: `leia ${args.path} antes de editá-lo` }
      }
      if (changedSinceRead(ctx, target)) return { ok: false, text: STALE_MESSAGE(args.path) }
      const current = await readUtf8Strict(target)
      if (!current.ok) return { ok: false, text: current.error }
      const before = current.text
      const outcome = applyEdit(before, args.old_string, args.new_string, args.replace_all)
      if (!outcome.ok) {
        if (outcome.error === 'identical') return { ok: false, text: 'old_string e new_string são iguais; nada a alterar.' }
        if (outcome.error === 'ambiguous') {
          return {
            ok: false,
            text: `o trecho aparece ${outcome.occurrences} vezes em ${args.path}. Inclua mais contexto ou use replace_all.`
          }
        }
        return { ok: false, text: `trecho não encontrado em ${args.path}. Confirme o conteúdo exato (indentação inclusa).` }
      }
      const { after, occurrences } = outcome
      await fs.promises.writeFile(target, after, 'utf8')
      rememberRead(ctx, target)
      ctx.tracker.recordChange(target, before, after)
      return {
        ok: true,
        text: `editado ${args.path} (${occurrences} ocorrência${occurrences > 1 ? 's' : ''})${outcome.note ? ` — ${outcome.note}` : ''}`,
        files: [target],
        summary: `${occurrences} substituição(ões) em ${path.basename(target)}`,
        data: { path: target, occurrences }
      }
    })
  }
}

/**
 * Applies a unified diff to one existing file. This is the surgical path for
 * fixes: the model quotes only the hunks that change, instead of rewriting the
 * whole file. The patch is applied atomically and only when it applies cleanly.
 */
export const patchFileTool: ToolDef = {
  name: 'patch_file',
  description:
    'Aplica um diff unificado (---/+++/@@) a um arquivo existente, alterando apenas os trechos do patch. Use para corrigir erros sem reescrever o arquivo inteiro. Leia o arquivo antes. dry_run valida sem gravar.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    path: z.string().describe('Arquivo existente'),
    patch: z.string().min(10).max(500_000).describe('Diff unificado com cabeçalhos ---/+++ e hunks @@'),
    dry_run: z.boolean().optional().describe('Só valida o patch, sem gravar')
  }),
  describe(a) {
    const args = a as { path?: string; patch?: string }
    const firstHunk = (args.patch ?? '').split('\n').find((line) => line.startsWith('@@')) ?? ''
    return { title: 'Aplicar patch', detail: `${args.path ?? ''} ${firstHunk}`.trim(), preview: args.path }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string; patch: string; dry_run?: boolean }
    const target = ctx.workspace.resolve(args.path, ctx.cwd)
    return withFileLock(target, async () => {
      if (!fs.existsSync(target)) return { ok: false, text: `arquivo não encontrado: ${args.path}` }
      if (!ctx.tracker.hasRead(target)) return { ok: false, text: `leia ${args.path} antes de aplicar o patch` }
      if (changedSinceRead(ctx, target)) return { ok: false, text: STALE_MESSAGE(args.path) }
      const current = await readUtf8Strict(target)
      if (!current.ok) return { ok: false, text: current.error }
      const before = current.text
      const crlf = before.includes('\r\n')
      let after: string | false
      try {
        // The model writes LF; apply on LF text and restore the file's own line endings afterwards.
        const applied = applyPatch(crlf ? before.replace(/\r\n/g, '\n') : before, args.patch)
        after = applied === false ? false : crlf ? applied.replace(/\r?\n/g, '\r\n') : applied
      } catch (err) {
        return { ok: false, text: `patch inválido: ${(err as Error).message}` }
      }
      if (after === false) {
        return {
          ok: false,
          text: `o patch não se aplica a ${args.path}. Confira os cabeçalhos e o contexto (o arquivo pode ter mudado); leia o trecho e gere um patch novo.`
        }
      }
      if (after === before) return { ok: false, text: 'o patch não altera o arquivo (mesmo conteúdo).' }
      if (args.dry_run) {
        return {
          ok: true,
          text: `patch válido para ${args.path}; prévia:\n${after.slice(0, 4000)}`,
          summary: 'patch validado (dry-run)',
          data: { path: target, dryRun: true }
        }
      }
      await fs.promises.writeFile(target, after, 'utf8')
      rememberRead(ctx, target)
      ctx.tracker.recordChange(target, before, after)
      const beforeLines = before.split('\n')
      const changed = after.split('\n').filter((line, index) => line !== beforeLines[index]).length
      return {
        ok: true,
        text: `patch aplicado em ${args.path} (${changed} linha(s) alterada(s))`,
        files: [target],
        summary: `patch em ${path.basename(target)}`,
        data: { path: target, changed }
      }
    })
  }
}

export const listDirTool: ToolDef = {
  name: 'list_dir',
  description: 'Lista arquivos e diretórios. Ignora node_modules, .git e diretórios de build.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    path: z.string().optional().describe('Diretório (padrão: raiz do projeto)'),
    depth: z.number().int().min(1).max(3).optional().describe('Profundidade (padrão 1)')
  }),
  describe(a) {
    const args = a as { path?: string }
    return { title: 'Listar diretório', detail: args.path ?? '.', preview: args.path }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path?: string; depth?: number }
    const root = ctx.workspace.resolve(args.path ?? '.', ctx.cwd)
    const depth = args.depth ?? 1
    const maxEntries = 300
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'target', 'release'])
    const lines: string[] = []

    const walk = async (dir: string, level: number, prefix: string): Promise<void> => {
      if (level > depth || lines.length >= maxEntries) return
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (lines.length >= maxEntries) return
        if (skip.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`)
          await walk(full, level + 1, prefix + '  ')
        } else {
          const stat = await fs.promises.stat(full).catch(() => null)
          const size = stat ? ` (${Math.max(1, Math.round(stat.size / 1024))}k)` : ''
          lines.push(`${prefix}${entry.name}${size}`)
        }
      }
    }

    await walk(root, 1, '')
    const relative = path.relative(ctx.cwd, root) || '.'
    const truncated =
      lines.length >= maxEntries ? `\n... (lista truncada em ${maxEntries} entradas; use path ou depth para focar)` : ''
    return {
      ok: true,
      text: `<directory path="${relative}">\n${lines.join('\n')}${truncated}\n</directory>`,
      files: [root],
      summary: `${lines.length} entradas em ${relative}${truncated ? ' (truncada)' : ''}`
    }
  }
}

export const deletePathTool: ToolDef = {
  name: 'delete_path',
  description:
    'Remove um arquivo ou diretório. Operação destrutiva: exige aprovação explícita do usuário.',
  risk: 'destructive',
  parallelSafe: false,
  schema: z.object({
    path: z.string(),
    recursive: z.boolean().optional()
  }),
  describe(a) {
    const args = a as { path: string }
    return { title: 'Remover', detail: args.path, preview: args.path }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { path: string; recursive?: boolean }
    const target = ctx.workspace.resolve(args.path, ctx.cwd)
    if (target === ctx.workspace.rootList[0]) return { ok: false, text: 'recusado: não é permitido remover a raiz do projeto' }
    const stat = await fs.promises.stat(target).catch(() => null)
    if (!stat) return { ok: false, text: `não encontrado: ${args.path}` }

    // Approval for this destructive tool is handled once by the permission
    // policy before execute(); asking again here would double-prompt.
    if (stat.isDirectory()) {
      if (!args.recursive) return { ok: false, text: 'diretório requer recursive=true' }
      await fs.promises.rm(target, { recursive: true, force: false })
    } else {
      await fs.promises.unlink(target)
    }
    ctx.tracker.recordChange(target, stat.isFile() ? '(arquivo existente)' : '(diretório)', null)
    return { ok: true, text: `removido: ${args.path}`, files: [target], summary: `removido ${path.basename(target)}` }
  }
}

export const fsTools: ToolDef[] = [readFileTool, writeFileTool, editFileTool, patchFileTool, listDirTool, deletePathTool]

/** Utility shared with tests. */
export function diffStat(changes: FileChange[]): string {
  const additions = changes.reduce((sum, c) => sum + c.additions, 0)
  const deletions = changes.reduce((sum, c) => sum + c.deletions, 0)
  return truncateMiddle(`+${additions} -${deletions} em ${changes.length} arquivo(s)`, 200)
}
