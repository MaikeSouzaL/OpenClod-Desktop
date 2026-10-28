import { describe, expect, it } from 'vitest'
import { makeMarker, parseTerminalRun, stripAnsi, wrapForShell } from '../src/core/terminal/runner'

/**
 * `run_in_terminal` runs a command in the session's real pty and has to find where the command ended in a stream that
 * also contains the echoed command line and ANSI noise. These tests pin the marker contract: the echo must not match the
 * sentinel, and the parser must recover both the output and the exit code from a realistic capture.
 */
describe('terminal runner marker', () => {
  it('splits the marker so the echoed command line does not contain the contiguous sentinel', () => {
    const marker = makeMarker()
    const wrapped = wrapForShell('powershell', 'Get-Location', marker)
    // The pty echoes the wrapped command back verbatim; that echo must not satisfy the end-of-run regex.
    expect(wrapped).not.toContain(marker)
    expect(wrapped).toContain(marker.slice(0, 4))
    expect(wrapped).toContain(marker.slice(4))
  })

  it('makeMarker is unique per call and regex-safe', () => {
    const a = makeMarker()
    const b = makeMarker()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^OCEND[a-z0-9]+$/)
  })

  it('parses output and a zero exit code from a PowerShell capture', () => {
    const marker = makeMarker()
    // What the pty streams back: the echoed command, then the real output, then the printed marker line.
    const raw = [
      `try { Get-Location } finally { Write-Output ('${marker.slice(0, 4)}' + '${marker.slice(4)}' + ':' + "$LASTEXITCODE") }`,
      'Path',
      '----',
      'C:\\Users\\Administrator\\Desktop',
      `${marker}:0`,
      ''
    ].join('\r\n')
    const result = parseTerminalRun(raw, marker)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('C:\\Users\\Administrator\\Desktop')
    expect(result.output).not.toContain(marker)
  })

  it('recovers a non-zero exit code', () => {
    const marker = makeMarker()
    const raw = ['exit 3 & echo ...', 'boom', `${marker}:3`].join('\n')
    expect(parseTerminalRun(raw, marker).exitCode).toBe(3)
  })

  it('reports null when the marker never arrives (e.g. timed out)', () => {
    const marker = makeMarker()
    const result = parseTerminalRun('still running...\nno sentinel here', marker)
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('no sentinel here')
  })

  it('strips ANSI colors, OSC titles and carriage returns', () => {
    const dirty = '\u001b]0;title\u0007\u001b[32mgreen\u001b[0m\r\ndone\r'
    const clean = stripAnsi(dirty)
    expect(clean).toBe('green\ndone\n')
  })

  it('cmd and bash wrappers also keep the echo clear of the sentinel', () => {
    const marker = makeMarker()
    for (const shell of ['cmd', 'bash'] as const) {
      const wrapped = wrapForShell(shell, 'echo hi', marker)
      expect(wrapped).not.toContain(marker)
      expect(wrapped).toContain(marker.slice(0, 4))
    }
  })
})
