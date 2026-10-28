import { useEffect, useState, type ReactElement } from 'react'
import type { WorktreeInfo } from '../../../shared/api'
import type { Project } from '../../../shared/types'
import { errorMessage, unwrap } from '../lib/api'
import { Icon } from './Icons'

interface WorktreeDialogProps {
  project: Project
  onClose(): void
  onOpenSession(worktree: WorktreeInfo): Promise<boolean>
}

function defaultBranch(): string {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('')
  return `openclod/session-${stamp}`
}

export function WorktreeDialog({ project, onClose, onOpenSession }: WorktreeDialogProps): ReactElement {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [branch, setBranch] = useState(defaultBranch)
  const [baseRef, setBaseRef] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'create' | string | null>(null)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      setWorktrees(await unwrap(window.forja.git.listWorktrees(project.path)))
      setError('')
    } catch (err) {
      setWorktrees([])
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // The dialog is scoped to one project; changing the branch fields must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path])

  const create = async (): Promise<void> => {
    if (!branch.trim()) return
    setBusy('create')
    setError('')
    try {
      const worktree = await unwrap(
        window.forja.git.createWorktree(project.path, branch.trim(), baseRef.trim() || undefined)
      )
      if (await onOpenSession(worktree)) onClose()
      else await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const open = async (worktree: WorktreeInfo): Promise<void> => {
    setBusy(worktree.path)
    setError('')
    try {
      if (await onOpenSession(worktree)) onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (worktree: WorktreeInfo): Promise<void> => {
    if (!window.confirm(`Remover o worktree da branch "${worktree.branch ?? 'destacada'}"? A branch não será apagada.`)) return
    setBusy(worktree.path)
    setError('')
    try {
      await unwrap(window.forja.git.removeWorktree(project.path, worktree.path))
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal worktree-modal" role="dialog" aria-modal="true" aria-label="Sessões isoladas em worktrees">
        <header className="modal-head">
          <div>
            <h2>Worktrees e sessões isoladas</h2>
            <p>Uma branch e uma pasta próprias para trabalhar sem alterar a cópia principal.</p>
          </div>
          <button type="button" className="icon-btn small" onClick={onClose} title="Fechar">
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="modal-body worktree-body">
          <div className="worktree-project">
            <Icon name="gitBranch" size={15} />
            <span><strong>{project.name}</strong><small>{project.path}</small></span>
          </div>
          <div className="worktree-create">
            <label>
              Nova branch
              <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="openclod/minha-sessao" spellCheck={false} />
            </label>
            <label>
              Base
              <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" spellCheck={false} />
            </label>
            <button type="button" className="btn primary" disabled={!branch.trim() || busy !== null} onClick={() => void create()}>
              {busy === 'create' ? <span className="spinner tiny" /> : <Icon name="plus" size={13} />}
              Criar e abrir sessão
            </button>
          </div>
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="worktree-list-head">
            <strong>Checkouts deste repositório</strong>
            <button type="button" className="btn ghost small" onClick={() => void refresh()} disabled={loading || busy !== null}>
              <Icon name="refresh" size={12} /> Atualizar
            </button>
          </div>
          {loading ? <div className="page-empty compact">Lendo worktrees do Git…</div> : null}
          {!loading && !worktrees.length ? <div className="page-empty compact">Nenhum worktree encontrado.</div> : null}
          <div className="worktree-list">
            {worktrees.map((worktree) => (
              <div key={worktree.path} className="worktree-row">
                <span className="worktree-icon"><Icon name="gitBranch" size={14} /></span>
                <span className="worktree-info">
                  <strong>{worktree.branch ?? (worktree.detached ? 'HEAD destacado' : 'Worktree')}</strong>
                  <small>{worktree.isMain ? 'Cópia principal' : worktree.path}</small>
                </span>
                {worktree.locked ? <span className="badge">bloqueado</span> : null}
                {worktree.prunable ? <span className="badge on">diretório ausente</span> : null}
                <button type="button" className="btn ghost small" disabled={busy !== null || worktree.prunable} onClick={() => void open(worktree)}>
                  {busy === worktree.path ? <span className="spinner tiny" /> : 'Abrir sessão'}
                </button>
                {!worktree.isMain ? (
                  <button type="button" className="icon-btn small danger" title="Remover worktree" disabled={busy !== null} onClick={() => void remove(worktree)}>
                    <Icon name="trash" size={13} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
