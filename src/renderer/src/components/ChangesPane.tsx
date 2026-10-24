import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { FileChange } from '../../../shared/types'
import type { GitFileEntry, GitStatusInfo } from '../../../shared/api'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'

const STATUS_LETTER: Record<GitFileEntry['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
  typechange: 'T'
}

const STATUS_CLASS: Record<GitFileEntry['status'], string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'modified',
  untracked: 'added',
  conflicted: 'deleted',
  typechange: 'modified'
}

function DiffView({ diff }: { diff: string }): ReactElement {
  return (
    <pre>
      {diff.split('\n').map((line, index) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'del'
              : line.startsWith('@@')
                ? 'hunk'
                : ''
        return (
          <span key={index} className={cls}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

interface TreeEntry {
  dir: string
  files: GitFileEntry[]
}

function groupByDir(files: GitFileEntry[]): TreeEntry[] {
  const map = new Map<string, GitFileEntry[]>()
  for (const file of files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.'
    map.set(dir, [...(map.get(dir) ?? []), file])
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, list]) => ({ dir, files: list }))
}

/** Session changes recorded by the harness, used when the folder is not a Git repository. */
function TrackerChanges({ changes, onReveal }: { changes: FileChange[]; onReveal(path: string): void }): ReactElement {
  const [selected, setSelected] = useState<string | null>(null)
  const change = changes.find((item) => item.path === selected) ?? changes[0]
  return (
    <>
      <div className="change-list">
        {changes.map((item) => (
          <button key={item.path} type="button" className={`change-row ${change?.path === item.path ? 'active' : ''}`} onClick={() => setSelected(item.path)} title={item.path}>
            <span className={`change-status ${item.status}`}>{item.status === 'added' ? 'A' : item.status === 'deleted' ? 'D' : 'M'}</span>
            <span className="change-path">{item.path}</span>
            <span className="change-count">
              <em>+{item.additions}</em> <b>-{item.deletions}</b>
            </span>
          </button>
        ))}
      </div>
      {change ? (
        <div className="diff-view">
          <div className="diff-head">
            <span title={change.path}>{change.path}</span>
            <span className="diff-head-actions">
              +{change.additions} / -{change.deletions}
              <button type="button" className="icon-btn small" onClick={() => onReveal(change.path)} title="Abrir no Explorer">
                <Icon name="external" size={12} />
              </button>
            </span>
          </div>
          <DiffView diff={change.diff} />
        </div>
      ) : null}
    </>
  )
}

interface ChangesPaneProps {
  root: string
  changes: FileChange[]
  onReveal(path: string): void
}

export function ChangesPane({ root, changes, onReveal }: ChangesPaneProps): ReactElement {
  const [status, setStatus] = useState<GitStatusInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'list' | 'tree'>('list')
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null)
  const [diffError, setDiffError] = useState('')
  const [query, setQuery] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      setStatus(await unwrap(window.forja.git.status(root)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [root])

  // Refresh on open and whenever the agent reports new file changes.
  useEffect(() => {
    void refresh()
  }, [refresh, changes])

  const files = useMemo(() => {
    const list = status?.files ?? []
    const q = query.trim().toLowerCase()
    return q ? list.filter((file) => file.path.toLowerCase().includes(q)) : list
  }, [status, query])

  const current = selected ?? (files[0] ? { path: files[0].path, staged: files[0].staged && !files[0].unstaged } : null)

  useEffect(() => {
    if (!current) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffError('')
    void window.forja.git.diff(root, current.path, current.staged).then((result) => {
      if (cancelled) return
      if (result.ok) setDiff({ text: result.value.diff, truncated: result.value.truncated })
      else {
        setDiff(null)
        setDiffError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [root, current?.path, current?.staged, status])

  const totals = files.reduce(
    (acc, file) => ({ additions: acc.additions + (file.additions ?? 0), deletions: acc.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 }
  )

  const row = (file: GitFileEntry, staged: boolean): ReactElement => (
    <button
      key={`${staged ? 's' : 'u'}:${file.path}`}
      type="button"
      className={`change-row ${current?.path === file.path && current.staged === staged ? 'active' : ''}`}
      onClick={() => setSelected({ path: file.path, staged })}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <span className={`change-status ${STATUS_CLASS[file.status]}`}>{STATUS_LETTER[file.status]}</span>
      <span className="change-path">{view === 'tree' ? file.path.split('/').pop() : file.path}</span>
      <span className="change-count">
        {file.binary ? (
          <i>binário</i>
        ) : file.status === 'untracked' && file.additions === undefined ? (
          <i>novo</i>
        ) : (
          <>
            <em>+{file.additions ?? 0}</em> <b>-{file.deletions ?? 0}</b>
          </>
        )}
      </span>
    </button>
  )

  const section = (title: string, list: GitFileEntry[], staged: boolean): ReactElement | null => {
    if (!list.length) return null
    return (
      <div className="change-section">
        <div className="change-section-head">
          {title} <span>{list.length}</span>
        </div>
        {view === 'tree'
          ? groupByDir(list).map((group) => (
              <div key={group.dir} className="change-dir">
                <div className="change-dir-name">
                  <Icon name="folder" size={11} /> {group.dir}
                </div>
                {group.files.map((file) => row(file, staged))}
              </div>
            ))
          : list.map((file) => row(file, staged))}
      </div>
    )
  }

  const notRepo = status && !status.isRepo

  return (
    <div className="changes-pane">
      <div className="pane-toolbar">
        <span className="pane-path">
          {status?.isRepo ? (
            <>
              <Icon name="gitBranch" size={12} /> {status.branch ?? '(sem branch)'}
              {status.ahead ? ` ↑${status.ahead}` : ''}
              {status.behind ? ` ↓${status.behind}` : ''}
            </>
          ) : (
            'Alterações'
          )}
        </span>
        <button type="button" className={`icon-btn small ${view === 'list' ? 'is-active' : ''}`} title="Lista" onClick={() => setView('list')}>
          <Icon name="list" size={13} />
        </button>
        <button type="button" className={`icon-btn small ${view === 'tree' ? 'is-active' : ''}`} title="Árvore" onClick={() => setView('tree')}>
          <Icon name="folder" size={13} />
        </button>
        <button type="button" className="icon-btn small" title="Atualizar" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}

      {notRepo ? (
        changes.length ? (
          <>
            <div className="panel-note">Esta pasta não é um repositório Git. Mostrando as alterações feitas pelo agente nesta sessão.</div>
            <TrackerChanges changes={changes} onReveal={onReveal} />
          </>
        ) : (
          <div className="panel-empty">
            <Icon name="gitBranch" size={22} />
            <p>
              As alterações precisam de um repositório Git.
              <br />
              Sem Git, o Openclod ainda mostra aqui o que o agente alterar nesta sessão.
            </p>
          </div>
        )
      ) : status?.isRepo && !status.files.length ? (
        <div className="panel-empty">
          <Icon name="checkCircle" size={22} />
          <p>Nenhuma alteração pendente em {status.branch ?? 'HEAD'}.</p>
        </div>
      ) : status?.isRepo ? (
        <>
          <div className="change-summary">
            <span>{files.length} arquivo(s)</span>
            <span>
              <em>+{totals.additions}</em> <b>-{totals.deletions}</b>
            </span>
          </div>
          <div className="panel-search">
            <Icon name="search" size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar arquivos alterados" spellCheck={false} />
          </div>
          <div className="change-list">
            {section('Preparadas', files.filter((file) => file.staged), true)}
            {section('Alteradas', files.filter((file) => file.unstaged || file.status === 'untracked'), false)}
          </div>
          {current ? (
            <div className="diff-view">
              <div className="diff-head">
                <span title={current.path}>
                  {current.path}
                  {current.staged ? ' (preparado)' : ''}
                </span>
                <span className="diff-head-actions">
                  <button type="button" className="icon-btn small" onClick={() => onReveal(`${status.root ?? root}/${current.path}`)} title="Abrir no Explorer">
                    <Icon name="external" size={12} />
                  </button>
                </span>
              </div>
              {diffError ? <div className="inline-error">{diffError}</div> : null}
              {diff ? <DiffView diff={diff.text || '(sem diferenças de texto)'} /> : null}
              {diff?.truncated ? <div className="panel-note">Diff truncado por tamanho.</div> : null}
            </div>
          ) : null}
        </>
      ) : loading ? (
        <div className="muted pad">Lendo o estado do Git…</div>
      ) : null}
    </div>
  )
}
