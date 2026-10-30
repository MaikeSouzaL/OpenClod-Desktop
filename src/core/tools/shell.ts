import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import type { EnvironmentProfile, ToolResult } from '../../shared/types.js'
import type { ToolDef } from './types.js'
import { commandDeletesFiles } from '../security/deletion.js'
import { checkCommand, sanitizedEnv } from '../security/policy.js'
import { truncateMiddle } from '../util/ids.js'
import { OutputCapture } from '../util/output-capture.js'
import { StreamDecoder } from '../util/oem-decode.js'
import { missingOfficeModuleHint, officeEnvPatch, officeInstallRefusal, warmOfficeEnv } from '../util/office-runtime.js'

/** After a timeout or abort, wait this long for the pipes to close before answering anyway (detached grandchildren keep them open). */
const KILL_GRACE_MS = 1_500
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
/** run_command without a timeout of its own: this long with no output moves the command to the background. */
export const SILENT_HANDOFF_MS = 90_000

function track(sessionId: string, child: ChildProcess): void {
  const set = registry.get(sessionId) ?? new Set()
  set.add(child)
  registry.set(sessionId, set)
  child.on('exit', () => set.delete(child))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A command that deletes files is as destructive as delete_path: the automatic mode must ask for it too (deletion protection). */
function shellCallRisk(raw: unknown): { risk: 'destructive' } | undefined {
  const command = (raw as { command?: unknown } | null)?.command
  return typeof command === 'string' && commandDeletesFiles(command) ? { risk: 'destructive' } : undefined
}

const isLocal = (environment?: EnvironmentProfile): boolean => !environment || environment.kind === 'local'

/** Before a local command starts: learns what `python` means on this machine, so the command's PATH can be built right. */
async function prepareLocalEnv(environment?: EnvironmentProfile): Promise<void> {
  if (isLocal(environment)) await warmOfficeEnv(sanitizedEnv())
}

/** In Cowork the document libraries are embedded; installing them on the user's computer is refused with the way to use the embedded ones. */
function officeInstallBlock(command: string, surface: string | undefined): ToolResult | null {
  const refusal = surface === 'cowork' ? officeInstallRefusal(command) : null
  return refusal ? { ok: false, text: `BLOQUEADO: ${refusal}` } : null
}

export interface EnvironmentSpawn {
  file: string
  args: string[]
  shell: boolean
}

/** Pure command-line construction, exported so routing can be tested without a host. */
export function environmentSpawn(command: string, cwd: string, environment?: EnvironmentProfile): EnvironmentSpawn {
  if (!environment || environment.kind === 'local') return { file: command, args: [], shell: true }
  if (environment.kind === 'wsl') {
    return {
      file: 'wsl.exe',
      args: [...(environment.distro ? ['-d', environment.distro] : []), '--cd', cwd, 'bash', '-lc', command],
      shell: false
    }
  }
  if (!environment.command) {
    throw new Error(`ambiente ${environment.label}: configure o comando (ex.: ssh usuario@host)`)
  }
  const remote = `cd ${shellQuote(environment.remoteCwd || '.')} && ${command}`
  return { file: `${environment.command} ${shellQuote(remote)}`, args: [], shell: true }
}

/**
 * Routes one command to the session's execution environment. Local and WSL
 * run on this machine; SSH/cloud use the profile's command prefix, so the
 * operator can point it at a host, a jump box or a container.
 */
function spawnCommand(command: string, cwd: string, environment?: EnvironmentProfile): ChildProcess {
  const base = { ...sanitizedEnv(), FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' }
  // Local commands also get the embedded document runtime on PATH (openclod-python, openclod-office); WSL/SSH run elsewhere.
  const env = isLocal(environment) ? officeEnvPatch(base) : base
  const spec = environmentSpawn(command, cwd, environment)
  // stdin is closed: the tools have no way to type into a process, and a program that waits for input
  // (an interactive prompt, a REPL) would otherwise hang until the timeout.
  return spawn(spec.file, spec.args, { cwd, shell: spec.shell, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
}

function startBackground(command: string, cwd: string, sessionId: string, environment?: EnvironmentProfile): BackgroundProcess {
  const child = spawnCommand(command, cwd, environment)
  track(sessionId, child)
  return adoptBackground(child, command, cwd, sessionId)
}

/**
 * Puts a running process in the session's background list: its output from now on is kept for read_process_output.
 * `seen` is what the caller already showed (counted as read, so the next read returns only what is new).
 */
function adoptBackground(child: ChildProcess, command: string, cwd: string, sessionId: string, seen = '', startedAt = Date.now()): BackgroundProcess {
  const record: BackgroundProcess = {
    pid: child.pid ?? -1,
    command,
    cwd,
    startedAt,
    output: seen,
    dropped: 0,
    readOffset: seen.length,
    exitCode: child.exitCode,
    child
  }
  const decoder = new StreamDecoder()
  const append = (d: Buffer): void => {
    record.output += decoder.write(d)
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

export interface ShellRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  pid?: number
  /** Silent for `idleMs`: left running and moved to the session's background list (read_process_output, stop_process). */
  handedOff?: boolean
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  sessionId: string,
  signal: AbortSignal,
  environment?: EnvironmentProfile,
  onOutput?: (stream: 'out' | 'err', text: string) => void,
  options: { idleMs?: number; command?: string; cwd?: string } = {}
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnCommand(command, cwd, environment)
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false })
      return
    }
    track(sessionId, child)
    const stdout = new OutputCapture()
    const stderr = new OutputCapture(30_000, 120_000)
    let timedOut = false
    let settled = false

    const finish = (code: number | null, extraErr = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
      if (graceTimer) clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
      const err = stderr.toString()
      resolve({ code, stdout: stdout.toString(), stderr: extraErr ? `${err}
${extraErr}` : err, timedOut, pid: child.pid ?? undefined })
    }

    const startedAt = Date.now()
    let idleTimer: NodeJS.Timeout | undefined
    // A command silent for that long is almost always waiting on something (another program, a socket, a dialog): the
    // turn gets its control back and the process keeps running in the background, where the agent can read or stop it.
    const armIdle = (): void => {
      if (!options.idleMs || settled) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const seen = `${stdout.toString()}${stderr.toString()}`
        adoptBackground(child, options.command ?? command, options.cwd ?? cwd, sessionId, seen, startedAt)
        resolve({ code: null, stdout: stdout.toString(), stderr: stderr.toString(), timedOut: false, pid: child.pid ?? undefined, handedOff: true })
      }, options.idleMs)
    }

    const append = (target: 'out' | 'err', data: Buffer): void => {
      const text = (target === 'out' ? stdout : stderr).push(data)
      onOutput?.(target, text)
      armIdle()
    }

    child.stdout?.on('data', (d: Buffer) => append('out', d))
    child.stderr?.on('data', (d: Buffer) => append('err', d))

    let graceTimer: NodeJS.Timeout | undefined
    // Kills the process tree, then answers even if a detached grandchild keeps the pipes open.
    const terminate = (): void => {
      if (child.pid) killTree(child.pid)
      graceTimer ??= setTimeout(() => finish(child.exitCode ?? -1), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const onAbort = (): void => terminate()
    signal.addEventListener('abort', onAbort, { once: true })
    armIdle()

    child.on('error', (err) => finish(-1, err.message))
    child.on('close', (code) => finish(code))
  })
}

export const runCommandTool: ToolDef = {
  name: 'run_command',
  // Its own watch: silent for SILENT_HANDOFF_MS it goes to the background; with timeout_ms, the timeout kills it.
  idleLimitMs: null,
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
  resolveCall: shellCallRisk,
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
    const blocked = officeInstallBlock(args.command, ctx.surface)
    if (blocked) {
      ctx.log('warn', `instalação de bibliotecas de documentos recusada: ${args.command}`)
      return blocked
    }
    const cwd = args.cwd ? ctx.workspace.resolve(args.cwd, ctx.cwd) : ctx.cwd
    await prepareLocalEnv(ctx.environment)
    if (args.run_in_background) {
      const record = startBackground(args.command, cwd, ctx.sessionId, ctx.environment)
      return {
        ok: record.pid > 0,
        text: `processo em segundo plano iniciado · pid=${record.pid}. Use read_process_output com este pid para ler a saída.`,
        summary: `pid ${record.pid} (segundo plano)`,
        data: { pid: record.pid, command: args.command, background: true }
      }
    }
    const timeoutMs = args.timeout_ms ?? ctx.policy.shellTimeoutSec * 1000
    // With no timeout of its own, a command that prints nothing for a while goes to the background instead of holding the
    // whole turn (a script waiting on another program kept a session "stuck" for minutes until the user cancelled).
    const idleMs = args.timeout_ms === undefined && timeoutMs > SILENT_HANDOFF_MS ? SILENT_HANDOFF_MS : undefined
    const started = Date.now()
    let liveOutput = ''
    let lastProgressAt = 0
    const onOutput = (_stream: 'out' | 'err', text: string): void => {
      liveOutput = (liveOutput + text).slice(-4000)
      const now = Date.now()
      if (now - lastProgressAt < 600) return
      lastProgressAt = now
      ctx.progress?.(liveOutput.slice(-1200), { outputAt: now })
    }
    const result = await runShellCommand(
      args.command,
      cwd,
      timeoutMs,
      ctx.sessionId,
      ctx.signal,
      ctx.environment,
      onOutput,
      { idleMs, command: args.command, cwd }
    )
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (result.handedOff) {
      const seen = `${result.stdout}${result.stderr}`.trim()
      return {
        ok: true,
        text: [
          `$ ${args.command}`,
          `sem nenhuma saída nova há ${Math.round(SILENT_HANDOFF_MS / 1000)}s: o comando CONTINUA rodando em segundo plano · pid=${result.pid}`,
          seen ? `--- saída até agora ---\n${truncateMiddle(seen, 12_000)}` : '(nenhuma saída até agora)',
          `Acompanhe com read_process_output (pid ${result.pid}, wait_ms para esperar saída nova) ou encerre com stop_process se ele estiver esperando algo que não vai acontecer (outro programa, uma janela, entrada do teclado).`
        ].join('\n'),
        summary: `pid ${result.pid} · segundo plano após ${elapsed}s sem saída`,
        data: { pid: result.pid, command: args.command, background: true, handedOff: true }
      }
    }
    const parts = [`$ ${args.command}`, `exit=${result.code ?? 'null'} · ${elapsed}s${result.timedOut ? ' · TIMEOUT' : ''}`]
    if (result.stdout.trim()) parts.push(`--- stdout ---\n${truncateMiddle(result.stdout.trim(), 28_000)}`)
    if (result.stderr.trim()) parts.push(`--- stderr ---\n${truncateMiddle(result.stderr.trim(), 12_000)}`)
    if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(sem saída)')
    // A script that imports a document library under another Python: point at the embedded one instead of letting the model pip-install.
    const missingModule = result.code === 0 ? null : missingOfficeModuleHint(`${result.stderr}\n${result.stdout}`)
    if (missingModule) parts.push(missingModule)
    if (result.timedOut) {
      // A silent timeout is almost always a process waiting for input, or holding the pipe open (browsers and GUI
      // programs hand the pipe to children that outlive them). Retrying the same call just burns another timeout.
      parts.push(
        `Dica: o limite de ${Math.round(timeoutMs / 1000)}s estourou${result.stdout.trim() || result.stderr.trim() ? '' : ' sem nenhuma saída'}. ` +
          'Não repita o mesmo comando. Redirecione a saída para um arquivo (`> saida.txt 2>&1`) em vez de usar pipe, ' +
          'ou use run_in_background=true e leia o resultado depois com read_process_output, e use um timeout menor para falhar cedo.'
      )
    }

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
  resolveCall: shellCallRisk,
  describe(a) {
    const args = a as { command: string }
    return { title: 'Iniciar serviço', detail: args.command, preview: args.command }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { command: string; cwd?: string; wait_ms?: number }
    const guard = checkCommand(args.command, ctx.policy)
    if (guard.blocked) return { ok: false, text: `BLOQUEADO pela política: ${guard.reason}` }
    const blocked = officeInstallBlock(args.command, ctx.surface)
    if (blocked) return blocked
    const cwd = args.cwd ? ctx.workspace.resolve(args.cwd, ctx.cwd) : ctx.cwd

    await prepareLocalEnv(ctx.environment)
    const record = startBackground(args.command, cwd, ctx.sessionId, ctx.environment)
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
    const result = await runShellCommand('netstat -ano -p tcp', ctx.cwd, 15_000, ctx.sessionId, ctx.signal, ctx.environment)
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
