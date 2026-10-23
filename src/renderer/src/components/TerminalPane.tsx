import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalEvent, TerminalInfo, TerminalShell } from '../../../shared/api'
import { Icon } from './Icons'
import { MenuPopover, type MenuItem } from './Chrome'
import { errorMessage, unwrap } from '../lib/api'

const SHELL_LABELS: Record<TerminalShell, string> = {
  powershell: 'PowerShell',
  cmd: 'Prompt de Comando',
  bash: 'Git Bash'
}

function readVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function xtermTheme(): Record<string, string> {
  const light = document.documentElement.dataset.theme === 'light'
  return {
    background: readVar('--bg', light ? '#faf9f5' : '#151515'),
    foreground: readVar('--text', light ? '#201f1d' : '#f1efe8'),
    cursor: readVar('--accent', '#d97757'),
    cursorAccent: readVar('--bg', '#151515'),
    selectionBackground: light ? 'rgba(194, 96, 63, 0.25)' : 'rgba(217, 119, 87, 0.3)'
  }
}

/**
 * One xterm instance bound to one pty in the main process. Output produced
 * while the view was unmounted is restored from the main-process scrollback.
 */
function TerminalView({ info, active }: { info: TerminalInfo; active: boolean }): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: xtermTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    termRef.current = term
    fitRef.current = fit

    let ready = false
    const early: string[] = []
    const off = window.forja.terminal.onEvent((event: TerminalEvent) => {
      if (event.id !== info.id) return
      if (event.type === 'data') {
        if (ready) term.write(event.data)
        else early.push(event.data)
      } else {
        term.write(`\r\n\x1b[2m[processo encerrado com código ${event.exitCode}]\x1b[0m\r\n`)
      }
    })
    void window.forja.terminal.snapshot(info.id).then((result) => {
      // Events that arrived before the reply are already part of the snapshot.
      early.length = 0
      if (result.ok && result.value) term.write(result.value)
      ready = true
    })

    const input = term.onData((data) => window.forja.terminal.write(info.id, data))
    const resize = term.onResize(({ cols, rows }) => window.forja.terminal.resize(info.id, cols, rows))
    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) {
        try {
          fit.fit()
        } catch {
          /* not laid out yet */
        }
      }
    })
    observer.observe(host.current)

    return () => {
      observer.disconnect()
      input.dispose()
      resize.dispose()
      off()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [info.id])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* hidden */
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return <div ref={host} className={`xterm-host ${active ? 'active' : ''}`} />
}

interface TerminalPaneProps {
  sessionId: string
  cwd: string
}

export function TerminalPane({ sessionId, cwd }: TerminalPaneProps): ReactElement {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [shells, setShells] = useState<TerminalShell[]>([])
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const creating = useRef(false)

  const create = useCallback(
    async (shell?: TerminalShell): Promise<void> => {
      if (creating.current) return
      creating.current = true
      setError('')
      try {
        const info = await unwrap(window.forja.terminal.create({ cwd, cols: 100, rows: 30, shell, sessionId }))
        setTerminals((list) => [...list, info])
        setActiveId(info.id)
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        creating.current = false
      }
    },
    [cwd, sessionId]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [list, available] = await Promise.all([window.forja.terminal.list(), window.forja.terminal.shells()])
      if (cancelled) return
      if (available.ok) setShells(available.value)
      const mine = list.ok ? list.value.filter((item) => item.sessionId === sessionId) : []
      setTerminals(mine)
      if (mine.length) setActiveId(mine[mine.length - 1].id)
      else void create()
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, create])

  useEffect(
    () =>
      window.forja.terminal.onEvent((event) => {
        if (event.type !== 'exit') return
        setTerminals((list) => list.map((item) => (item.id === event.id ? { ...item, exited: true, exitCode: event.exitCode } : item)))
      }),
    []
  )

  const close = async (terminalId: string): Promise<void> => {
    await window.forja.terminal.kill(terminalId)
    setTerminals((list) => {
      const next = list.filter((item) => item.id !== terminalId)
      if (activeId === terminalId) setActiveId(next.length ? next[next.length - 1].id : null)
      return next
    })
  }

  const menuItems: MenuItem[] = [
    ...shells.map((shell) => ({
      id: `new-${shell}`,
      label: `Novo terminal: ${SHELL_LABELS[shell]}`,
      icon: 'terminal' as const,
      onSelect: () => void create(shell)
    })),
    { id: 'sep', separator: true },
    {
      id: 'kill',
      label: 'Encerrar terminal atual',
      icon: 'trash' as const,
      danger: true,
      disabled: !activeId,
      onSelect: () => activeId && void close(activeId)
    }
  ]

  return (
    <div className="terminal-pane">
      <div className="terminal-bar">
      <div className="terminal-tabs" role="tablist">
        {terminals.map((item, index) => (
          <div key={item.id} className={`terminal-tab ${item.id === activeId ? 'active' : ''} ${item.exited ? 'exited' : ''}`}>
            <button type="button" role="tab" aria-selected={item.id === activeId} onClick={() => setActiveId(item.id)} title={`${item.title} · ${item.cwd}`}>
              <Icon name="terminal" size={12} />
              <span>{terminals.length > 1 ? `${item.title} ${index + 1}` : item.title}</span>
            </button>
            <button type="button" className="terminal-tab-close" title="Encerrar terminal" onClick={() => void close(item.id)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button type="button" className="icon-btn small" title="Novo terminal" onClick={() => void create()}>
          <Icon name="plus" size={13} />
        </button>
      </div>
        <div className="inline-anchor">
          <button type="button" className={`icon-btn small ${menu ? 'is-active' : ''}`} title="Opções do terminal" onClick={() => setMenu((open) => !open)}>
            <Icon name="more" size={13} />
          </button>
          {menu ? <MenuPopover items={menuItems} align="right" onClose={() => setMenu(false)} /> : null}
        </div>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="terminal-stack">
        {terminals.map((item) => (
          <TerminalView key={item.id} info={item} active={item.id === activeId} />
        ))}
        {!terminals.length && !error ? <div className="muted pad">Abrindo terminal…</div> : null}
      </div>
    </div>
  )
}
