import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolDef } from './types.js'

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], timeout = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? String(err.message) : '') })
    })
  })
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], 10_000)
  return result.code === 0 && result.stdout.trim() === 'true'
}

function format(result: GitResult, okWhenEmpty = true): ToolResult {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  return {
    ok: result.code === 0 || (okWhenEmpty && !text),
    text: text || '(sem saída)'
  }
}

export const gitStatusTool: ToolDef = {
  name: 'git_status',
  description: 'Mostra o estado do repositório Git (branch, arquivos alterados, não rastreados).',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({}),
  describe() {
    return { title: 'git status', detail: 'estado do repositório' }
  },
  async execute(_raw, ctx) {
    const result = await git(ctx.cwd, ['status', '--short', '--branch'])
    return {
      ...format(result),
      summary: result.stdout.trim().split('\n')[0] ?? 'git status'
    }
  }
}

export const gitDiffTool: ToolDef = {
  name: 'git_diff',
  description: 'Mostra o diff das alterações não commitadas (ou de um arquivo específico).',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    path: z.string().optional(),
    staged: z.boolean().optional(),
    stat: z.boolean().optional().describe('Somente estatísticas')
  }),
  describe(a) {
    const args = a as { path?: string }
    return { title: 'git diff', detail: args.path ?? 'todas as alterações', preview: args.path }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { path?: string; staged?: boolean; stat?: boolean }
    const cmd = ['diff', '--no-color']
    if (args.staged) cmd.push('--cached')
    if (args.stat) cmd.push('--stat')
    if (args.path) cmd.push('--', ctx.workspace.resolve(args.path, ctx.cwd))
    const result = await git(ctx.cwd, cmd)
    const text = result.stdout.trim()
    return {
      ok: result.code === 0,
      text: text ? (text.length > 60_000 ? `${text.slice(0, 60_000)}\n…[diff truncado]` : text) : '(sem alterações)',
      summary: text ? `${text.split('\n').length} linhas de diff` : 'sem alterações'
    }
  }
}

export const gitLogTool: ToolDef = {
  name: 'git_log',
  description: 'Lista commits recentes.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  describe() {
    return { title: 'git log', detail: 'commits recentes' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { limit?: number }
    const result = await git(ctx.cwd, [
      'log',
      `-${args.limit ?? 10}`,
      '--pretty=format:%h %ad %an: %s',
      '--date=short'
    ])
    return { ...format(result), summary: `${(result.stdout.match(/\n/g) ?? []).length + 1} commits` }
  }
}

export const gitCommitTool: ToolDef = {
  name: 'git_commit',
  description:
    'Cria um commit com as alterações. Exige aprovação. Nunca use sem que o usuário tenha pedido um commit.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    message: z.string().min(3),
    add_all: z.boolean().optional().describe('Executar git add -A antes')
  }),
  describe(a) {
    const args = a as { message: string }
    return { title: 'Criar commit', detail: args.message.split('\n')[0], preview: args.message }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { message: string; add_all?: boolean }
    const approved = await ctx.approve({
      tool: 'git_commit',
      title: 'Criar commit',
      detail: args.message,
      risk: 'write',
      preview: args.message
    })
    if (!approved) return { ok: false, text: 'commit cancelado pelo usuário' }
    if (args.add_all) {
      const add = await git(ctx.cwd, ['add', '-A'])
      if (add.code !== 0) return format(add)
    }
    const result = await git(ctx.cwd, ['commit', '-m', args.message])
    ctx.emit({ type: 'diff', sessionId: ctx.sessionId, files: ctx.tracker.changes() })
    return { ...format(result), summary: result.code === 0 ? 'commit criado' : 'falha ao commitar' }
  }
}

export const gitCheckoutTool: ToolDef = {
  name: 'git_checkout',
  description: 'Cria ou troca de branch. Exige aprovação porque altera o estado do repositório.',
  risk: 'exec',
  parallelSafe: false,
  schema: z.object({
    branch: z.string().min(1),
    create: z.boolean().optional()
  }),
  describe(a) {
    const args = a as { branch: string }
    return { title: 'Trocar de branch', detail: args.branch, preview: args.branch }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { branch: string; create?: boolean }
    const approved = await ctx.approve({
      tool: 'git_checkout',
      title: args.create ? 'Criar branch' : 'Trocar de branch',
      detail: args.branch,
      risk: 'exec',
      preview: args.branch
    })
    if (!approved) return { ok: false, text: 'operação cancelada' }
    const result = await git(ctx.cwd, args.create ? ['checkout', '-b', args.branch] : ['checkout', args.branch])
    return { ...format(result), summary: `branch ${args.branch}` }
  }
}

export const gitTools: ToolDef[] = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool, gitCheckoutTool]

/** Used by the session layer to detect a repo without going through a tool. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel'], 10_000)
  if (result.code !== 0) return null
  const shown = result.stdout.trim()
  return shown && path.isAbsolute(shown) && fs.existsSync(shown) ? shown : null
}
