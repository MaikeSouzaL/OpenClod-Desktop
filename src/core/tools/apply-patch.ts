import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import { PatchError, applyChunks, parsePatch, patchDeletes, patchPaths, type PatchOp } from '../patch/apply-patch.js'
import { withFileLock } from '../util/file-lock.js'
import { STALE_MESSAGE, changedSinceRead, readUtf8Strict, rememberRead } from './fs.js'

/** One file of the patch, checked and computed: what gets written, and what to put back if a later write fails. */
interface Planned {
  op: PatchOp
  label: string
  target: string
  /** Where the content goes (the move destination of an update with "*** Move to"). */
  dest: string
  before: string | null
  after: string | null
}

async function withLocks<T>(files: string[], work: () => Promise<T>): Promise<T> {
  // A fixed order, so two patches over the same files never wait on each other.
  const sorted = [...new Set(files.map((file) => (process.platform === 'win32' ? file.toLowerCase() : file)))].sort()
  const run = (index: number): Promise<T> => (index >= sorted.length ? work() : withFileLock(sorted[index], () => run(index + 1)))
  return run(0)
}

/** Lines of a text, without the empty "line" after a final newline. */
const linesOf = (text: string | null): string[] => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [])

const countLines = (before: string | null, after: string | null): { added: number; removed: number } => {
  const a = linesOf(before)
  const b = linesOf(after)
  const seen = new Map<string, number>()
  for (const line of a) seen.set(line, (seen.get(line) ?? 0) + 1)
  let kept = 0
  for (const line of b) {
    const left = seen.get(line) ?? 0
    if (left > 0) {
      kept++
      seen.set(line, left - 1)
    }
  }
  return { added: b.length - kept, removed: a.length - kept }
}

/** Checks every operation and computes every new text before anything is written. */
async function plan(ops: PatchOp[], ctx: ToolContext): Promise<{ ok: true; planned: Planned[] } | { ok: false; error: string }> {
  const planned: Planned[] = []
  const claimed = new Map<string, string>()
  const claim = (file: string, label: string): string | null => {
    const key = process.platform === 'win32' ? file.toLowerCase() : file
    const other = claimed.get(key)
    if (other) return `${label} aparece duas vezes no patch (${other}); junte as alterações num só bloco.`
    claimed.set(key, label)
    return null
  }
  for (const op of ops) {
    let target: string
    let dest: string
    try {
      target = ctx.workspace.resolve(op.path, ctx.cwd)
      dest = op.kind === 'update' && op.moveTo ? ctx.workspace.resolve(op.moveTo, ctx.cwd) : target
    } catch (err) {
      return { ok: false, error: `${op.path}: ${(err as Error).message}` }
    }
    const twice = claim(target, op.path) ?? (dest !== target ? claim(dest, (op as { moveTo?: string }).moveTo ?? op.path) : null)
    if (twice) return { ok: false, error: twice }
    const stat = await fs.promises.stat(target).catch(() => null)

    if (op.kind === 'add') {
      if (stat) return { ok: false, error: `${op.path} já existe: use "*** Update File: ${op.path}" (depois de lê-lo).` }
      planned.push({ op, label: op.path, target, dest, before: null, after: op.content })
      continue
    }
    if (!stat) return { ok: false, error: `arquivo não encontrado: ${op.path}` }
    if (!stat.isFile()) return { ok: false, error: `${op.path} não é um arquivo.` }
    // The same rules as edit_file and patch_file: read it first, and not changed on disk since.
    if (!ctx.tracker.hasRead(target)) return { ok: false, error: `leia ${op.path} antes de alterá-lo pelo patch.` }
    if (changedSinceRead(ctx, target)) return { ok: false, error: STALE_MESSAGE(op.path) }
    const current = await readUtf8Strict(target)
    if (!current.ok) return { ok: false, error: `${op.path}: ${current.error}` }

    if (op.kind === 'delete') {
      planned.push({ op, label: op.path, target, dest, before: current.text, after: null })
      continue
    }
    if (dest !== target && (await fs.promises.stat(dest).catch(() => null))) {
      return { ok: false, error: `${op.moveTo} já existe: o "*** Move to" não sobrescreve arquivos.` }
    }
    let after: string
    try {
      after = op.chunks.length ? applyChunks(current.text, op.chunks, op.path) : current.text
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    if (after === current.text && dest === target) return { ok: false, error: `o patch não altera ${op.path} (mesmo conteúdo).` }
    planned.push({ op, label: op.moveTo ? `${op.path} → ${op.moveTo}` : op.path, target, dest, before: current.text, after })
  }
  return { ok: true, planned }
}

/** Writes the plan; if one write fails, what was already written is put back. */
async function commit(planned: Planned[]): Promise<string | null> {
  const undo: Array<() => Promise<void>> = []
  try {
    for (const item of planned) {
      if (item.op.kind === 'add') {
        await fs.promises.mkdir(path.dirname(item.target), { recursive: true })
        await fs.promises.writeFile(item.target, item.after ?? '', { encoding: 'utf8', flag: 'wx' })
        undo.push(() => fs.promises.rm(item.target, { force: true }))
      } else if (item.op.kind === 'delete') {
        await fs.promises.unlink(item.target)
        undo.push(() => fs.promises.writeFile(item.target, item.before ?? '', 'utf8'))
      } else if (item.dest !== item.target) {
        await fs.promises.mkdir(path.dirname(item.dest), { recursive: true })
        await fs.promises.writeFile(item.dest, item.after ?? '', { encoding: 'utf8', flag: 'wx' })
        undo.push(() => fs.promises.rm(item.dest, { force: true }))
        await fs.promises.unlink(item.target)
        undo.push(() => fs.promises.writeFile(item.target, item.before ?? '', 'utf8'))
      } else {
        await fs.promises.writeFile(item.target, item.after ?? '', 'utf8')
        undo.push(() => fs.promises.writeFile(item.target, item.before ?? '', 'utf8'))
      }
    }
    return null
  } catch (err) {
    for (const step of undo.reverse()) await step().catch(() => undefined)
    return `não consegui gravar (${(err as Error).message}); nada foi alterado.`
  }
}

/**
 * Several files in one call, by context instead of line numbers (the format Codex and GPT models write). All or
 * nothing: every operation is checked and computed first, then written; a failed write puts back what was written.
 */
export const applyPatchTool: ToolDef = {
  name: 'apply_patch',
  description:
    'Cria, altera, move e remove vários arquivos numa só chamada, tudo ou nada. Formato:\n' +
    '*** Begin Patch\n*** Add File: caminho\n+linha nova\n*** Update File: caminho\n*** Move to: novo/caminho (opcional)\n' +
    '@@ linha de referência (opcional, ex.: cabeçalho da função)\n linha de contexto\n-linha removida\n+linha adicionada\n' +
    '*** Delete File: caminho\n*** End Patch\n' +
    'Use 3 linhas de contexto em volta de cada mudança. Arquivos alterados ou removidos precisam ter sido lidos antes. Remover arquivo pede aprovação.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    patch: z.string().min(20).max(1_000_000).describe('O patch inteiro, de "*** Begin Patch" a "*** End Patch"'),
    dry_run: z.boolean().optional().describe('Só valida e mostra o que mudaria, sem gravar')
  }),
  // Removing a file is as destructive as delete_path, whatever else the patch does.
  resolveCall(args) {
    const patch = (args as { patch?: unknown } | undefined)?.patch
    return typeof patch === 'string' && patchDeletes(patch) ? { risk: 'destructive' } : undefined
  },
  describe(a) {
    const args = a as { patch?: string }
    const paths = patchPaths(args.patch ?? '')
    let detail = paths.join(', ')
    try {
      const marks: Record<PatchOp['kind'], string> = { add: '+', update: '~', delete: '-' }
      detail = parsePatch(args.patch ?? '')
        .map((op) => `${marks[op.kind]}${op.path}${op.kind === 'update' && op.moveTo ? ` → ${op.moveTo}` : ''}`)
        .join(', ')
    } catch {
      /* the summary falls back to the paths */
    }
    return { title: 'Aplicar patch', detail: detail.slice(0, 400) || '(patch)', preview: paths.join('\n') }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { patch: string; dry_run?: boolean }
    let ops: PatchOp[]
    try {
      ops = parsePatch(args.patch)
    } catch (err) {
      return { ok: false, text: `patch inválido: ${err instanceof PatchError ? err.message : (err as Error).message}` }
    }
    let targets: string[]
    try {
      targets = ops.flatMap((op) => [ctx.workspace.resolve(op.path, ctx.cwd), ...(op.kind === 'update' && op.moveTo ? [ctx.workspace.resolve(op.moveTo, ctx.cwd)] : [])])
    } catch (err) {
      return { ok: false, text: `patch recusado: ${(err as Error).message}` }
    }
    return withLocks(targets, async () => {
      const checked = await plan(ops, ctx)
      if (!checked.ok) return { ok: false, text: `patch não aplicado (nada foi alterado): ${checked.error}` }
      const lines = checked.planned.map((item) => {
        const { added, removed } = countLines(item.before, item.after)
        const verb = item.op.kind === 'add' ? 'criar' : item.op.kind === 'delete' ? 'remover' : item.dest !== item.target ? 'mover' : 'alterar'
        return { item, text: `${verb} ${item.label} (+${added} -${removed})` }
      })
      if (args.dry_run) {
        return {
          ok: true,
          text: `patch válido; aplicaria:\n${lines.map((line) => `- ${line.text}`).join('\n')}`,
          summary: `patch validado (${lines.length} arquivo(s), dry-run)`,
          data: { dryRun: true, files: checked.planned.map((item) => item.dest) }
        }
      }
      const failed = await commit(checked.planned)
      if (failed) return { ok: false, text: `patch não aplicado: ${failed}` }
      for (const item of checked.planned) {
        if (item.dest !== item.target) {
          ctx.tracker.recordChange(item.target, item.before, null)
          ctx.tracker.recordChange(item.dest, null, item.after)
        } else {
          ctx.tracker.recordChange(item.target, item.before, item.after)
        }
        // What the model just wrote counts as read: a follow-up edit needs no new read.
        if (item.after !== null) rememberRead(ctx, item.dest)
      }
      const files = [...new Set(checked.planned.flatMap((item) => [item.target, item.dest]))]
      return {
        ok: true,
        text: `patch aplicado em ${lines.length} arquivo(s):\n${lines.map((line) => `- ${line.text.replace(/^(criar|remover|mover|alterar)/, (verb) => ({ criar: 'criado', remover: 'removido', mover: 'movido', alterar: 'alterado' })[verb] ?? verb)}`).join('\n')}`,
        files,
        summary: `patch em ${lines.length} arquivo(s)`,
        data: { files: checked.planned.map((item) => ({ path: item.dest, kind: item.op.kind })) }
      }
    })
  }
}
