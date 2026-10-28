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

/** Files that `git_commit add_all` leaves out: they hold secrets far more often than source. */
const SECRET_PATHSPECS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/*.keystore', '**/.npmrc']
const SECRET_FILE = /(^|\/)(\.env(\..+)?|.*\.(pem|key|pfx|p12|keystore)|id_rsa.*|id_ed25519.*|\.npmrc)$/i

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
    // --untracked-files=all lists new files one per line (the default collapses a new folder into 'src/').
    const result = await git(ctx.cwd, ['status', '--short', '--branch', '--untracked-files=all'])
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
    add_all: z.boolean().optional().describe('Executar git add -A antes (deixa de fora .env, chaves e certificados; para versioná-los de propósito use git add manualmente)')
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
    let leftOut: string[] = []
    if (args.add_all) {
      // Credentials never ride along with "add everything": .env files, private keys and certificates stay out
      // (a file that is already tracked is untouched). They are listed below so the model can tell the user.
      const add = await git(ctx.cwd, ['add', '-A', '--', '.', ...SECRET_PATHSPECS.map((spec) => `:(exclude,glob)${spec}`)])
      if (add.code !== 0) return format(add)
      const untracked = await git(ctx.cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
      leftOut = untracked.stdout.split('\0').filter((file) => file && SECRET_FILE.test(file)).slice(0, 20)
    }
    const result = await git(ctx.cwd, ['commit', '-m', args.message])
    ctx.emit({ type: 'diff', sessionId: ctx.sessionId, files: ctx.tracker.changes() })
    const base = format(result)
    return {
      ...base,
      ...(leftOut.length ? { text: `${base.text}
Não incluí (parecem credenciais): ${leftOut.join(', ')}. Adicione com git add se for mesmo para versionar.` } : {}),
      summary: result.code === 0 ? 'commit criado' : 'falha ao commitar'
    }
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
    // A branch name must never be read as an option (`-f`) or a path (`a.txt`): both used to
    // reach `git checkout` and could throw away uncommitted work.
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/@+-]{1,200}$/.test(args.branch) || args.branch.endsWith('/') || args.branch.endsWith('.lock')) {
      return { ok: false, text: `nome de branch inválido: "${args.branch}". Use letras, números e . _ - / @ +, sem começar por "-" e sem "..".` }
    }
    const approved = await ctx.approve({
      tool: 'git_checkout',
      title: args.create ? 'Criar branch' : 'Trocar de branch',
      detail: args.branch,
      risk: 'exec',
      preview: args.branch
    })
    if (!approved) return { ok: false, text: 'operação cancelada' }
    // `switch` only handles branches and refuses to overwrite local changes (no path restore, no force).
    const result = await git(ctx.cwd, args.create ? ['switch', '-c', args.branch] : ['switch', args.branch])
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
