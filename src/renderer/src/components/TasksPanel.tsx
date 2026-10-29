import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Icon } from './Icons'
import {
  childrenOf,
  clearFinished,
  elapsed,
  reconcileProcesses,
  formatDuration,
  topLevel,
  type ActivityEntry,
  type ActivityState
} from '../lib/activity'

/** Re-renders every second while something is running, so durations tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function tail(text: string | undefined, lines = 12): string {
  if (!text) return ''
  const all = text.replace(/\r\n/g, '\n').trimEnd().split('\n')
  return all.slice(-lines).join('\n')
}

function StatusMark({ entry }: { entry: ActivityEntry }): ReactElement {
  if (entry.status === 'running') return <span className="spinner tiny" aria-label="em execução" />
  if (entry.status === 'failed') return <Icon name="alert" size={12} className="task-bad" />
  return <Icon name="check" size={12} className="task-good" />
}

function CommandBody({ entry, liveOutput }: { entry: ActivityEntry; liveOutput?: string }): ReactElement {
  const output = tail(liveOutput ?? entry.output)
  return (
    <div className="task-body">
      {entry.detail ? (
        <pre className="task-cmd">
          <span className="task-prompt">$</span> {entry.detail}
        </pre>
      ) : null}
      {output ? (
        <pre className="task-out">{output}</pre>
      ) : (
        <div className="task-quiet">{entry.status === 'running' ? 'Sem saída ainda' : 'Sem saída'}</div>
      )}
      {typeof entry.exitCode === 'number' && entry.exitCode !== 0 ? <div className="task-exit">código de saída {entry.exitCode}</div> : null}
    </div>
  )
}

interface RowProps {
  entry: ActivityEntry
  state: ActivityState
  now: number
  outputs: Record<number, string>
  depth: number
  onStop(entry: ActivityEntry): void
}

function TaskRow({ entry, state, now, outputs, depth, onStop }: RowProps): ReactElement {
  const children = useMemo(() => (entry.kind === 'agent' ? childrenOf(state, entry.id) : []), [state, entry])
  const [open, setOpen] = useState(entry.status === 'running')
  const [finishedOpen, setFinishedOpen] = useState(false)
  const running = children.filter((child) => child.status === 'running')
  const finished = children.filter((child) => child.status !== 'running')
  const failedCount = children.filter((child) => child.status === 'failed').length

  return (
    <div className={`task-row-card status-${entry.status} kind-${entry.kind}`} style={depth ? { marginLeft: depth * 10 } : undefined}>
      <div className="task-head">
        <button type="button" className="task-title" onClick={() => setOpen((value) => !value)} aria-expanded={open} title={entry.detail ?? entry.title}>
          <StatusMark entry={entry} />
          <span className="task-title-text">{entry.title}</span>
        </button>
        <span className="task-time">{formatDuration(elapsed(entry, now))}</span>
        {entry.status === 'running' ? (
          <button type="button" className="task-stop" onClick={() => onStop(entry)} title={entry.pid ? 'Encerrar processo' : 'Interromper o turno'}>
            <Icon name="square" size={9} />
          </button>
        ) : entry.status === 'failed' ? (
          <span className="task-failed">Falhou</span>
        ) : null}
      </div>

      {entry.kind === 'agent' ? (
        <div className="task-sub">
          <span className="task-agent-chip">{entry.name}</span>
          {entry.model ? <span className="task-model">{entry.model}</span> : null}
        </div>
      ) : null}

      {open && entry.kind === 'command' ? <CommandBody entry={entry} liveOutput={entry.pid ? outputs[entry.pid] : undefined} /> : null}

      {open && entry.kind === 'agent' ? (
        <div className="task-agent-body">
          {entry.detail ? <div className="task-prompt-text">{entry.detail.length > 280 ? `${entry.detail.slice(0, 279)}…` : entry.detail}</div> : null}
          <div className="task-counts">
            {children.length ? `${children.length} ${children.length === 1 ? 'tarefa' : 'tarefas'}` : 'Sem tarefas ainda'}
            {failedCount ? <em> · {failedCount} com falha</em> : null}
          </div>
          {running.map((child) => (
            <ChildRow key={child.id} entry={child} state={state} now={now} outputs={outputs} depth={depth + 1} onStop={onStop} />
          ))}
          {finished.length ? (
            <>
              <button type="button" className="task-toggle" onClick={() => setFinishedOpen((value) => !value)} aria-expanded={finishedOpen}>
                {finished.length} {finished.length === 1 ? 'concluída' : 'concluídas'}
                <Icon name={finishedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              </button>
              {finishedOpen
                ? finished.map((child) => (
                    <ChildRow key={child.id} entry={child} state={state} now={now} outputs={outputs} depth={depth + 1} onStop={onStop} />
                  ))
                : null}
            </>
          ) : null}
          {entry.status !== 'running' && entry.output ? <div className="task-summary">{entry.output}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function ChildRow(props: RowProps): ReactElement {
  const { entry } = props
  if (entry.kind === 'agent') return <TaskRow {...props} />
  // A plain tool run inside an agent: one compact line that expands to its output.
  return <ToolLine {...props} />
}

function ToolLine({ entry, now, outputs }: RowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const output = tail(entry.pid ? (outputs[entry.pid] ?? entry.output) : entry.output, 10)
  const expandable = Boolean(output || entry.detail)
  return (
    <div className={`task-line status-${entry.status}`}>
      <button type="button" className="task-line-head" onClick={() => expandable && setOpen((value) => !value)} aria-expanded={open} title={entry.detail ?? entry.title}>
        <StatusMark entry={entry} />
        <span className="task-line-title">{entry.title}</span>
        <span className="task-time">{formatDuration(elapsed(entry, now))}</span>
        {entry.status === 'failed' ? <span className="task-failed">Falhou</span> : null}
        {expandable ? <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> : null}
      </button>
      {open ? <CommandBody entry={entry} liveOutput={entry.pid ? outputs[entry.pid] : undefined} /> : null}
    </div>
  )
}

interface TasksPanelProps {
  sessionId: string
  activity: ActivityState
  onClear(next: ActivityState): void
  onStopTurn(): void
}

export function TasksPanel({ sessionId, activity, onClear, onStopTurn }: TasksPanelProps): ReactElement {
  const items = useMemo(() => topLevel(activity), [activity])
  const anyRunning = activity.some((entry) => entry.status === 'running')
  const now = useNow(anyRunning)
  const [outputs, setOutputs] = useState<Record<number, string>>({})
  const [doneOpen, setDoneOpen] = useState(false)

  const runningItems = items.filter((entry) => entry.status === 'running')
  const doneItems = items.filter((entry) => entry.status !== 'running').reverse()

  // Background processes keep producing output after their tool call returned; poll the live buffer.
  const pids = useMemo(
    () => activity.filter((entry) => entry.pid && entry.background && entry.status === 'running').map((entry) => entry.pid as number),
    [activity]
  )
  useEffect(() => {
    if (!pids.length) return
    let cancelled = false
    const read = async (): Promise<void> => {
      const next: Record<number, string> = {}
      for (const pid of pids) {
        const result = await window.openclod.tasks.output(sessionId, pid)
        if (result.ok) next[pid] = result.value
      }
      if (!cancelled) setOutputs((current) => ({ ...current, ...next }))
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pids, sessionId])

  // Reconcile services started in the background with the real process list.
  useEffect(() => {
    if (!pids.length) return
    let cancelled = false
    const check = async (): Promise<void> => {
      const result = await window.openclod.tasks.list(sessionId)
      if (cancelled || !result.ok) return
      const next = reconcileProcesses(activity, result.value, Date.now())
      if (next !== activity) onClear(next)
    }
    void check()
    const timer = setInterval(() => void check(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activity, onClear, pids, sessionId])

  const stop = (entry: ActivityEntry): void => {
    if (entry.pid) void window.openclod.tasks.stop(sessionId, entry.pid)
    else onStopTurn()
  }

  if (!items.length) {
    return (
      <div className="panel-empty">
        <Icon name="logs" size={22} />
        <p>
          Comandos longos e agentes que o agente chamar aparecem aqui, com o tempo de cada um, a saída e o que cada agente está
          fazendo.
        </p>
      </div>
    )
  }

  return (
    <div className="tasks-panel">
      <div className="tasks-toolbar">
        <span>
          {runningItems.length ? `${runningItems.length} em execução` : 'Nada em execução'}
          {doneItems.length ? ` · ${doneItems.length} concluída${doneItems.length > 1 ? 's' : ''}` : ''}
        </span>
        <button type="button" className="icon-btn small" title="Limpar concluídas" disabled={!doneItems.length} onClick={() => onClear(clearFinished(activity))}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {runningItems.map((entry) => (
        <TaskRow key={entry.id} entry={entry} state={activity} now={now} outputs={outputs} depth={0} onStop={stop} />
      ))}
      {doneItems.length ? (
        <>
          <button type="button" className="task-toggle big" onClick={() => setDoneOpen((value) => !value)} aria-expanded={doneOpen}>
            Concluído {doneItems.length}
            <Icon name={doneOpen ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
          {doneOpen
            ? doneItems.map((entry) => <TaskRow key={entry.id} entry={entry} state={activity} now={now} outputs={outputs} depth={0} onStop={stop} />)
            : null}
        </>
      ) : null}
    </div>
  )
}
