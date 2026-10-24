import fs from 'node:fs'
import path from 'node:path'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import { killTree } from '../core/tools/shell.js'
import { id } from '../core/util/ids.js'
import type { TerminalEvent, TerminalInfo, TerminalShell } from '../shared/api.js'

/** Output kept per terminal so a reloaded renderer can repaint the screen. */
const SCROLLBACK_CHARS = 200_000
/** Output is coalesced before crossing IPC; xterm handles bursts fine. */
const FLUSH_MS = 12
const MAX_TERMINALS = 12

interface Terminal {
  info: TerminalInfo
  pty: IPty
  buffer: string
  pending: string
  timer: NodeJS.Timeout | null
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
    return info
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
