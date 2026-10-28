import type { TerminalShell } from '../../shared/api.js'

/** What `run_in_terminal` gets back: the command ran in the session's visible terminal, with its output and exit code. */
export interface TerminalRunResult {
  terminalId: string
  /** New output since the previous return for this command (incremental while it keeps running). */
  output: string
  exitCode: number | null
  /** The whole time budget ran out while the command was still going. */
  timedOut: boolean
  /** The command is still executing in the terminal; calling run again (even with an empty command) keeps watching it. */
  running: boolean
  /** How long the command had been silent (no new output) when this returned, in ms. */
  idleMs: number
  /** A command was passed but ignored because the terminal was already busy running one. */
  ignoredCommand?: boolean
}

/**
 * Runs a command in the session's VISIBLE integrated terminal (a real pty, so state like `cd` and env persists),
 * creating one if the session has none. Implemented in the main process over the TerminalManager; the agent sees
 * the captured output and the user watches it live. The same policy gate as run_command still applies in the tool.
 *
 * The call returns as soon as the command finishes OR when it has been slow/quiet for a while, so the agent can see
 * what is happening instead of waiting blind. While a command is still running the terminal stays busy: call again
 * (an empty command just keeps watching) to read more, or pass `interrupt` to send Ctrl+C.
 */
export interface TerminalRunner {
  run(input: {
    sessionId: string
    command: string
    cwd: string
    shell?: TerminalShell
    timeoutMs?: number
    /** Send Ctrl+C to the command currently running in the session's terminal before watching again. */
    interrupt?: boolean
  }): Promise<TerminalRunResult>
}

/** Removes ANSI escape sequences and control noise so the captured terminal output is readable text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '') // OSC (window title, etc.)
    .replace(/\u001b[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colors, cursor moves)
    .replace(/\u001b[=>]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Wraps a command so that, when it finishes, a unique one-line marker with the exit code is printed. The marker is
 * written SPLIT (string concatenation / an escaped char) so the line the terminal echoes back does NOT contain the
 * contiguous marker — only the command's real result does — which lets us find the end without matching the echo.
 */
export function wrapForShell(shell: TerminalShell, command: string, marker: string): string {
  const head = marker.slice(0, 4)
  const tail = marker.slice(4)
  if (shell === 'cmd') {
    // `& echo` runs regardless of the command's result; `^` makes the typed echo differ from the printed output.
    return `${command} & echo ${head}^${tail}:%ERRORLEVEL%`
  }
  if (shell === 'bash') {
    return `{ ${command} ; }; printf '%s%s:%s\\n' '${head}' '${tail}' "$?"`
  }
  // PowerShell: try/finally guarantees the marker even if the command throws; the concatenation splits the echo.
  return `try { ${command} } finally { Write-Output ('${head}' + '${tail}' + ':' + "$LASTEXITCODE") }`
}

/** A unique marker per run, so a command's own output can never collide with the sentinel. */
export function makeMarker(): string {
  return `OCEND${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

/** From the raw terminal capture: the text before the marker is the output; the number after it is the exit code. */
export function parseTerminalRun(raw: string, marker: string): { output: string; exitCode: number | null } {
  const text = stripAnsi(raw)
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}:(-?\\d+)?`).exec(text)
  if (!match) return { output: trimOutput(text), exitCode: null }
  const exitCode = match[1] !== undefined && match[1] !== '' ? Number(match[1]) : null
  return { output: trimOutput(text.slice(0, match.index)), exitCode }
}

/** Drops the echoed command (the first non-empty line, which the pty echoes back) and tidies blank lines. */
function trimOutput(text: string): string {
  const lines = text.split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  if (start < lines.length) start++ // the echoed command line
  return lines.slice(start).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
