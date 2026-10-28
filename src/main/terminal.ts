import fs from 'node:fs'
import path from 'node:path'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import { killTree } from '../core/tools/shell.js'
import { id } from '../core/util/ids.js'
import { makeMarker, parseTerminalRun, stripAnsi, wrapForShell, type TerminalRunResult } from '../core/terminal/runner.js'
import type { TerminalEvent, TerminalInfo, TerminalShell } from '../shared/api.js'

/** Output kept per terminal so a reloaded renderer can repaint the screen. */
const SCROLLBACK_CHARS = 200_000
/** Output is coalesced before crossing IPC; xterm handles bursts fine. */
const FLUSH_MS = 12
const MAX_TERMINALS = 12

/** A run does not report "parou de responder" before this, so a command that is just starting up is not called slow. */
const RUN_MIN_ACTIVE_MS = 8_000
/** No new output for this long (past RUN_MIN_ACTIVE_MS) → return so the agent can check what is happening. */
const RUN_SILENCE_MS = 10_000
/** A single run_in_terminal call hands control back after this even while output keeps flowing (chatty/long command). */
const RUN_PER_CALL_MS = 60_000

/** A command currently executing in a terminal via run_in_terminal: lets polls resume it and stops two from interleaving. */
interface ActiveRun {
  marker: string
  /** Everything the pty has emitted since the command started. */
  raw: string
  /** Length of the already-returned parsed output, so each call returns only the new text. */
  shownLen: number
  startedAt: number
  lastDataAt: number
  done: boolean
  dispose: () => void
  /** Wakes a pending watcher when new data arrives or the command finishes. */
  notify: (() => void) | null
}

interface Terminal {
  info: TerminalInfo
  pty: IPty
  buffer: string
  pending: string
  timer: NodeJS.Timeout | null
  /** The run_in_terminal command executing here, if any, so two do not interleave and a slow one can be watched again. */
  active?: ActiveRun | null
}

interface ShellCommand {
  file: string
  args: string[]
  label: string
}

function gitBashPath(): string | null {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, 'Git', 'bin', 'bash.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function availableShells(): TerminalShell[] {
  if (process.platform !== 'win32') return ['bash']
  const shells: TerminalShell[] = ['powershell', 'cmd']
  if (gitBashPath()) shells.push('bash')
  return shells
}

function shellCommand(shell: TerminalShell): ShellCommand {
  if (process.platform !== 'win32') {
    return { file: process.env.SHELL || '/bin/bash', args: ['-l'], label: 'bash' }
  }
  if (shell === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: [], label: 'Prompt de Comando' }
  if (shell === 'bash') {
    const bash = gitBashPath()
    if (bash) return { file: bash, args: ['--login', '-i'], label: 'Git Bash' }
  }
  return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
}

/**
 * The integrated terminal is the user's own shell, like the one in an IDE:
 * it keeps the user's environment (minus Electron internals) and never runs
 * on behalf of the agent, so it bypasses the agent's approval flow.
 */
function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ELECTRON_')) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Openclod'
  return env
}

export class TerminalManager {
  private terminals = new Map<string, Terminal>()

  constructor(private readonly emit: (event: TerminalEvent) => void) {}

  list(): TerminalInfo[] {
    // ConPTY reports the shell pid only after the pseudo console connects.
    return [...this.terminals.values()].map((terminal) => ({ ...terminal.info, pid: terminal.pty.pid || terminal.info.pid }))
  }

  create(input: { cwd: string; cols: number; rows: number; shell?: TerminalShell; sessionId?: string }): TerminalInfo {
    if (this.terminals.size >= MAX_TERMINALS) throw new Error(`limite de ${MAX_TERMINALS} terminais abertos`)
    const shell = input.shell && availableShells().includes(input.shell) ? input.shell : availableShells()[0]
    const command = shellCommand(shell)
    const cols = clamp(input.cols, 20, 500, 100)
    const rows = clamp(input.rows, 5, 200, 30)
    const pty = spawnPty(command.file, command.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: input.cwd,
      env: terminalEnv()
    })
    const info: TerminalInfo = {
      id: id('term'),
      title: command.label,
      shell,
      cwd: input.cwd,
      pid: pty.pid,
      sessionId: input.sessionId,
      createdAt: Date.now(),
      exited: false
    }
    const terminal: Terminal = { info, pty, buffer: '', pending: '', timer: null }
    this.terminals.set(info.id, terminal)

    pty.onData((data) => {
      terminal.buffer = (terminal.buffer + data).slice(-SCROLLBACK_CHARS)
      terminal.pending += data
      if (!terminal.timer) {
        terminal.timer = setTimeout(() => this.flush(terminal), FLUSH_MS)
      }
    })
    pty.onExit(({ exitCode }) => {
      this.flush(terminal)
      terminal.info.exited = true
      terminal.info.exitCode = exitCode
      this.emit({ type: 'exit', id: info.id, exitCode })
    })
    // Lets the pane open a tab for a terminal the AGENT created (the renderer dedupes the ones it created itself).
    this.emit({ type: 'created', info: { ...info } })
    return info
  }

  /** The session's open terminal, or a new one — what run_in_terminal runs in, visible in the pane. */
  ensureSessionTerminal(input: { sessionId: string; cwd: string; shell?: TerminalShell }): TerminalInfo {
    for (const terminal of this.terminals.values()) {
      if (terminal.info.sessionId === input.sessionId && !terminal.info.exited) {
        return { ...terminal.info, pid: terminal.pty.pid || terminal.info.pid }
      }
    }
    return this.create({ cwd: input.cwd, cols: 100, rows: 30, shell: input.shell, sessionId: input.sessionId })
  }

  /**
   * Runs a command in a visible terminal and captures its output. It writes the command wrapped with a unique end
   * marker, then collects the pty output (which the user also sees live) until the marker prints — OR returns early
   * when the command has been slow/quiet, so the agent can see what is happening instead of waiting blind. While a
   * command is still running the terminal stays busy: call again (an empty command just keeps watching) to read more,
   * or pass `interrupt` to send Ctrl+C. The agent cannot type into a prompt, so interactive programs hang (use Ctrl+C).
   */
  async run(terminalId: string, command: string, options: { timeoutMs?: number; interrupt?: boolean } = {}): Promise<TerminalRunResult> {
    const terminal = this.need(terminalId)
    if (terminal.info.exited) throw new Error('o terminal foi encerrado; abra outro')
    const timeoutMs = clamp(options.timeoutMs, 1000, 900_000, 120_000)
    const idle = { terminalId, output: '', exitCode: null, timedOut: false, running: false, idleMs: 0 } as const

    const busy = terminal.active && !terminal.active.done
    if (options.interrupt && busy) terminal.pty.write('\x03') // Ctrl+C para o comando em andamento

    let ignoredCommand = false
    if (busy) {
      // Já há um comando rodando aqui: esta chamada só continua acompanhando (um comando novo é ignorado).
      if (command.trim() && !options.interrupt) ignoredCommand = true
    } else if (command.trim()) {
      this.startRun(terminal, command)
    } else {
      return idle // nada rodando e nenhum comando a iniciar
    }

    const active = terminal.active
    if (!active) return idle
    await this.watchActive(active, timeoutMs)

    const parsed = parseTerminalRun(active.raw, active.marker)
    const output = parsed.output.slice(active.shownLen)
    active.shownLen = parsed.output.length
    const idleMs = Date.now() - active.lastDataAt
    const running = !active.done
    const timedOut = running && Date.now() - active.startedAt >= timeoutMs
    if (active.done) {
      active.dispose()
      terminal.active = null
    }
    return { terminalId, output, exitCode: parsed.exitCode, timedOut, running, idleMs, ignoredCommand }
  }

  /** Writes the wrapped command and starts capturing; the listener stays attached until the end marker prints. */
  private startRun(terminal: Terminal, command: string): void {
    const marker = makeMarker()
    const wrapped = wrapForShell(terminal.info.shell, command, marker)
    const seen = new RegExp(`${marker}:`)
    const active: ActiveRun = {
      marker,
      raw: '',
      shownLen: 0,
      startedAt: Date.now(),
      lastDataAt: Date.now(),
      done: false,
      dispose: () => {},
      notify: null
    }
    const disposable = terminal.pty.onData((data) => {
      active.raw += data
      active.lastDataAt = Date.now()
      if (!active.done && seen.test(stripAnsi(active.raw))) active.done = true
      active.notify?.()
    })
    active.dispose = (): void => {
      try {
        disposable.dispose()
      } catch {
        /* já liberado */
      }
    }
    terminal.active = active
    terminal.pty.write(`${wrapped}\r`)
  }

  /** Resolves when the command finishes, when it stops responding for a while, or when the call has waited long enough. */
  private watchActive(active: ActiveRun, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (active.done) return resolve()
      const watchStart = Date.now()
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearInterval(ticker)
        active.notify = null
        resolve()
      }
      active.notify = (): void => {
        if (active.done) settle()
      }
      const ticker = setInterval(() => {
        if (active.done) return settle()
        const now = Date.now()
        if (now - active.startedAt >= timeoutMs) return settle() // orçamento total esgotado
        if (now - watchStart >= RUN_PER_CALL_MS) return settle() // devolve o controle ao agente
        if (now - active.startedAt >= RUN_MIN_ACTIVE_MS && now - active.lastDataAt >= RUN_SILENCE_MS) return settle() // parou de responder
      }, 500)
    })
  }

  private flush(terminal: Terminal): void {
    if (terminal.timer) clearTimeout(terminal.timer)
    terminal.timer = null
    if (!terminal.pending) return
    const data = terminal.pending
    terminal.pending = ''
    this.emit({ type: 'data', id: terminal.info.id, data })
  }

  write(terminalId: string, data: string): void {
    const terminal = this.need(terminalId)
    if (!terminal.info.exited) terminal.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.need(terminalId)
    if (terminal.info.exited) return
    try {
      terminal.pty.resize(clamp(cols, 20, 500, 100), clamp(rows, 5, 200, 30))
    } catch {
      /* resizing a pty that is exiting throws on Windows */
    }
  }

  /**
   * Flushes pending output first: the renderer drops events that arrive
   * before the snapshot reply, so everything sent earlier must be in it.
   */
  snapshot(terminalId: string): string {
    const terminal = this.need(terminalId)
    this.flush(terminal)
    return terminal.buffer
  }

  kill(terminalId: string): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    this.terminals.delete(terminalId)
    if (terminal.timer) clearTimeout(terminal.timer)
    terminal.active?.dispose()
    if (!terminal.info.exited) {
      // ConPTY keeps children alive after pty.kill(); kill the whole tree.
      if (terminal.pty.pid > 0) killTree(terminal.pty.pid)
      try {
        terminal.pty.kill()
      } catch {
        /* already gone */
      }
    }
  }

  killAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.kill(terminalId)
  }

  private need(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new Error('terminal não encontrado')
    return terminal
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}
