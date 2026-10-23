import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolDef } from './types.js'
import { checkCommand, sanitizedEnv } from '../security/policy.js'
import { truncateMiddle } from '../util/ids.js'

const MAX_BUFFER = 600_000
/** Output kept per background process (the tail wins). */
const BACKGROUND_BUFFER = 200_000
const registry = new Map<string, Set<ChildProcess>>()

interface BackgroundProcess {
  pid: number
  command: string
  cwd: string
  startedAt: number
  output: string
  /** Characters dropped from the head of `output` so far. */
  dropped: number
  /** Absolute offset already returned by read_process_output. */
  readOffset: number
  exitCode: number | null
  child: ChildProcess
}

const background = new Map<string, Map<number, BackgroundProcess>>()

function track(sessionId: string, child: ChildProcess): void {
  const set = registry.get(sessionId) ?? new Set()
  set.add(child)
  registry.set(sessionId, set)
  child.on('exit', () => set.delete(child))
}

function startBackground(command: string, cwd: string, sessionId: string): BackgroundProcess {
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    env: { ...sanitizedEnv(), FORCE_COLOR: '0', NO_COLOR: '1' }
  })
  track(sessionId, child)
  const record: BackgroundProcess = {
    pid: child.pid ?? -1,
    command,
    cwd,
    startedAt: Date.now(),
    output: '',
    dropped: 0,
    readOffset: 0,
    exitCode: null,
    child
  }
  const append = (d: Buffer): void => {
    record.output += d.toString('utf8')
    if (record.output.length > BACKGROUND_BUFFER) {
      const cut = record.output.length - BACKGROUND_BUFFER
      record.output = record.output.slice(cut)
      record.dropped += cut
    }
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('exit', (code) => {
    record.exitCode = code ?? -1
  })
  child.on('error', (err) => {
    record.output += `\n[erro ao iniciar: ${err.message}]`
    record.exitCode = -1
  })
  const map = background.get(sessionId) ?? new Map<number, BackgroundProcess>()
  map.set(record.pid, record)
  background.set(sessionId, map)
  return record
}

/** Output produced since the last read (or the retained tail if it was dropped). */
function takeNewOutput(record: BackgroundProcess): { text: string; skipped: number } {
  const start = Math.max(record.readOffset, record.dropped)
  const skipped = start - record.readOffset
  const text = record.output.slice(start - record.dropped)
  record.readOffset = record.dropped + record.output.length
  return { text, skipped }
}

export interface BackgroundProcessInfo {
  sessionId: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  exitCode: number | null
}

/** Snapshot for the UI ("Tarefas em segundo plano"); does not move read offsets. */
export function listBackgroundProcesses(sessionId?: string): BackgroundProcessInfo[] {
  const out: BackgroundProcessInfo[] = []
  for (const [owner, map] of background) {
    if (sessionId && owner !== sessionId) continue
    for (const record of map.values()) {
      out.push({
        sessionId: owner,
        pid: record.pid,
        command: record.command,
        cwd: record.cwd,
        startedAt: record.startedAt,
        exitCode: record.exitCode
      })
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** Retained output tail for the UI; the agent's own read offset is untouched. */
export function backgroundProcessOutput(sessionId: string, pid: number): string | null {
  const record = background.get(sessionId)?.get(pid)
  return record ? record.output : null
}

export function stopBackgroundProcess(sessionId: string, pid: number): boolean {
  const record = background.get(sessionId)?.get(pid)
  if (!record) return false
  if (record.exitCode === null) killTree(pid)
  return true
}

function describeProcess(record: BackgroundProcess): string {
  const state = record.exitCode === null ? 'ativo' : `encerrou (exit ${record.exitCode})`
  const age = Math.round((Date.now() - record.startedAt) / 1000)
  return `pid=${record.pid} · ${state} · ${age}s · ${record.command}`
}

export function killSessionProcesses(sessionId: string): number {
  const set = registry.get(sessionId)
  if (!set) return 0
  let killed = 0
  for (const child of set) {
    if (child.pid && child.exitCode === null) {
      killTree(child.pid)
      killed++
    }
  }
  registry.delete(sessionId)
  background.delete(sessionId)
  return killed
}

export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).unref()
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* best effort */
  }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  pid?: number
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  sessionId: string,
  signal: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...sanitizedEnv(), FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' }
    })
    track(sessionId, child)
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const append = (target: 'out' | 'err', data: Buffer): void => {
      const text = data.toString('utf8')
      if (target === 'out') {
        if (stdout.length < MAX_BUFFER) stdout += text
      } else if (stderr.length < MAX_BUFFER) stderr += text
    }

    child.stdout?.on('data', (d: Buffer) => append('out', d))
    child.stderr?.on('data', (d: Buffer) => append('err', d))

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutMs)

    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut, pid: child.pid ?? undefined })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut, pid: child.pid ?? undefined })
    })
  })
}

export const runCommandTool: ToolDef = {
  name: 'run_command',
  description:
    'Executa um comando no terminal do projeto (cmd.exe no Windows). Use para testes, builds, instaladores e git. Saída limitada; comandos destrutivos são bloqueados. Com run_in_background=true, devolve o PID na hora e a saída fica disponível em read_process_output (servidores, watchers, builds longos).',
  risk: 'exec',
  parallelSafe: false,
  schema: z.object({
    command: z.string().min(1).describe('Linha de comando completa'),
    description: z.string().max(120).optional().describe('Resumo de 5 a 10 palavras do que o comando faz; aparece no painel de tarefas'),
    cwd: z.string().optional().describe('Diretório de trabalho (dentro do projeto)'),
    timeout_ms: z.number().int().min(1000).max(900_000).optional(),
    run_in_background: z.boolean().optional().describe('Não esperar o fim; ler a saída depois com read_process_output')
  }),
  describe(a) {
    const args = a as { command: string }
    return { title: 'Executar comando', detail: args.command, preview: args.command, }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { command: string; cwd?: string; timeout_ms?: number; run_in_background?: boolean }
    const guard = checkCommand(args.command, ctx.policy)
    if (guard.blocked) {
      ctx.log('warn', `comando bloqueado: ${args.command} (${guard.reason})`)
      ctx.emit({
        type: 'audit',
        sessionId: ctx.sessionId,
        level: 'blocked',
        message: `Comando bloqueado pela política: ${guard.reason}`
      })
      return { ok: false, text: `BLOQUEADO pela política de segurança: ${guard.reason}. Reformule o comando de forma segura.` }
    }
    const cwd = args.cwd ? ctx.workspace.resolve(args.cwd, ctx.cwd) : ctx.cwd
    if (args.run_in_background) {
      const record = startBackground(args.command, cwd, ctx.sessionId)
      return {
        ok: record.pid > 0,
        text: `processo em segundo plano iniciado · pid=${record.pid}. Use read_process_output com este pid para ler a saída.`,
        summary: `pid ${record.pid} (segundo plano)`,
        data: { pid: record.pid, command: args.command, background: true }
      }
    }
    const timeoutMs = args.timeout_ms ?? ctx.policy.shellTimeoutSec * 1000
    const started = Date.now()
    const result = await runShell(args.command, cwd, timeoutMs, ctx.sessionId, ctx.signal)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    const parts = [`$ ${args.command}`, `exit=${result.code ?? 'null'} · ${elapsed}s${result.timedOut ? ' · TIMEOUT' : ''}`]
    if (result.stdout.trim()) parts.push(`--- stdout ---\n${truncateMiddle(result.stdout.trim(), 28_000)}`)
    if (result.stderr.trim()) parts.push(`--- stderr ---\n${truncateMiddle(result.stderr.trim(), 12_000)}`)
    if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(sem saída)')

    return {
      ok: result.code === 0 && !result.timedOut,
      text: parts.join('\n'),
      summary: `exit ${result.code ?? '?'} · ${elapsed}s`,
      data: { exitCode: result.code, timedOut: result.timedOut, command: args.command, pid: result.pid },
      files: []
    }
  }
}

export const startProcessTool: ToolDef = {
  name: 'start_process',
  description:
    'Inicia um processo de longa duração (servidor de desenvolvimento, watcher) em segundo plano e retorna o PID e a saída inicial. A saída continua sendo coletada: leia com read_process_output.',
  risk: 'exec',
  parallelSafe: false,
  schema: z.object({
    command: z.string().min(1),
    description: z.string().max(120).optional().describe('Resumo de 5 a 10 palavras do serviço; aparece no painel de tarefas'),
    cwd: z.string().optional(),
    wait_ms: z.number().int().min(200).max(20_000).optional().describe('Tempo para capturar a saída inicial')
  }),
  describe(a) {
    const args = a as { command: string }
    return { title: 'Iniciar serviço', detail: args.command, preview: args.command }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { command: string; cwd?: string; wait_ms?: number }
    const guard = checkCommand(args.command, ctx.policy)
    if (guard.blocked) return { ok: false, text: `BLOQUEADO pela política: ${guard.reason}` }
    const cwd = args.cwd ? ctx.workspace.resolve(args.cwd, ctx.cwd) : ctx.cwd

    const record = startBackground(args.command, cwd, ctx.sessionId)
    await new Promise((r) => setTimeout(r, args.wait_ms ?? 1800))
    const { text } = takeNewOutput(record)
    const exited = record.exitCode !== null
    return {
      ok: !exited || record.exitCode === 0,
      text: `processo ${exited ? 'encerrou' : 'iniciado'} · pid=${record.pid} · exit=${record.exitCode ?? 'ativo'}\n${truncateMiddle(text, 6000)}`,
      summary: `pid ${record.pid} ${exited ? '(encerrou)' : '(ativo)'}`,
      data: { pid: record.pid, exitCode: record.exitCode, command: args.command }
    }
  }
}

export const readProcessOutputTool: ToolDef = {
  name: 'read_process_output',
  description:
    'Lê a saída nova (desde a última leitura) de um processo iniciado com start_process ou run_command em segundo plano, e informa se ele ainda está ativo. wait_ms espera saída nova antes de responder.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    pid: z.number().int().positive(),
    wait_ms: z.number().int().min(0).max(60_000).optional(),
    filter: z.string().optional().describe('Só linhas que contêm este texto')
  }),
  describe(a) {
    const args = a as { pid: number }
    return { title: 'Saída do processo', detail: `pid ${args.pid}`, preview: String(args.pid) }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { pid: number; wait_ms?: number; filter?: string }
    const record = background.get(ctx.sessionId)?.get(args.pid)
    if (!record) return { ok: false, text: `pid ${args.pid} não foi iniciado em segundo plano nesta sessão. Use list_processes.` }
    const deadline = Date.now() + (args.wait_ms ?? 0)
    while (Date.now() < deadline && record.exitCode === null && record.dropped + record.output.length === record.readOffset) {
      if (ctx.signal.aborted) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const { text, skipped } = takeNewOutput(record)
    const lines = args.filter ? text.split(/\r?\n/).filter((l) => l.includes(args.filter!)).join('\n') : text
    return {
      ok: true,
      text: `${describeProcess(record)}${skipped ? `\n(${skipped} caracteres antigos descartados)` : ''}\n${truncateMiddle(lines, 20_000) || '(sem saída nova)'}`,
      summary: `pid ${record.pid} ${record.exitCode === null ? 'ativo' : `exit ${record.exitCode}`}`,
      data: { pid: record.pid, exitCode: record.exitCode }
    }
  }
}

export const listProcessesTool: ToolDef = {
  name: 'list_processes',
  description: 'Lista os processos em segundo plano iniciados pelo agente nesta sessão, com estado e comando.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({}),
  describe() {
    return { title: 'Processos em segundo plano', detail: 'desta sessão' }
  },
  async execute(_raw, ctx): Promise<ToolResult> {
    const records = [...(background.get(ctx.sessionId)?.values() ?? [])]
    return {
      ok: true,
      text: records.length ? records.map(describeProcess).join('\n') : 'nenhum processo em segundo plano nesta sessão',
      summary: `${records.length} processo(s)`
    }
  }
}

export const stopProcessTool: ToolDef = {
  name: 'stop_process',
  description: 'Encerra um processo iniciado pelo agente (por PID).',
  risk: 'exec',
  parallelSafe: false,
  schema: z.object({ pid: z.number().int().positive() }),
  describe(a) {
    const args = a as { pid: number }
    return { title: 'Encerrar processo', detail: `pid ${args.pid}`, preview: String(args.pid) }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { pid: number }
    const owned = [...(registry.get(ctx.sessionId) ?? [])].some((c) => c.pid === args.pid)
    if (!owned) {
      const approved = await ctx.approve({
        tool: 'stop_process',
        title: 'Encerrar processo não iniciado pelo agente',
        detail: `PID ${args.pid}`,
        risk: 'destructive',
        preview: String(args.pid)
      })
      if (!approved) return { ok: false, text: 'cancelado pelo usuário' }
    }
    killTree(args.pid)
    return { ok: true, text: `sinal de encerramento enviado ao PID ${args.pid}`, summary: `pid ${args.pid} encerrado` }
  }
}

export const listPortsTool: ToolDef = {
  name: 'list_ports',
  description: 'Lista portas TCP em escuta e os PIDs correspondentes (netstat).',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({ filter: z.string().optional().describe('Filtro textual, ex.: "3000"') }),
  describe(a) {
    const args = a as { filter?: string }
    return { title: 'Listar portas', detail: args.filter ?? 'todas' }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { filter?: string }
    const result = await runShell('netstat -ano -p tcp', ctx.cwd, 15_000, ctx.sessionId, ctx.signal)
    const lines = result.stdout
      .split(/\r?\n/)
      .filter((l) => /LISTENING/i.test(l))
      .filter((l) => (args.filter ? l.includes(args.filter) : true))
      .slice(0, 120)
    return {
      ok: true,
      text: lines.join('\n') || 'nenhuma porta em escuta encontrada',
      summary: `${lines.length} portas em escuta`
    }
  }
}

export const shellTools: ToolDef[] = [
  runCommandTool,
  startProcessTool,
  readProcessOutputTool,
  listProcessesTool,
  stopProcessTool,
  listPortsTool
]
