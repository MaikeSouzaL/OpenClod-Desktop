import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'
import './saved-approvals.css'

type Saved = Array<{ projectId: string; projectName: string; allow: string[]; deny: string[] }>

/**
 * Configurações → Permissões → Escolhas salvas: what "Permitir sempre" and "Negar sempre" left per project, each one
 * removable. A command is saved by its operation (`Bash(git commit:*)`), so this is where a too-broad choice is undone.
 */
export function SavedApprovals(): ReactElement {
  const [saved, setSaved] = useState<Saved | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setSaved(await unwrap(window.openclod.approvals.saved()))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const revoke = async (projectId: string, rule: string, effect: 'allow' | 'deny'): Promise<void> => {
    setError('')
    try {
      await unwrap(window.openclod.approvals.revoke(projectId, rule, effect))
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="saved-approvals" aria-label="Escolhas salvas">
      <h3>Escolhas salvas</h3>
      <p className="field-help">
        O que "Permitir sempre" e "Negar sempre" guardaram em cada projeto. Comandos ficam salvos pela operação
        (<code>Bash(git commit:*)</code> vale para qualquer <code>git commit</code>); cada comando de uma cadeia
        (<code>&amp;&amp;</code>, <code>|</code>, <code>;</code>) precisa estar permitido. Remover vale na hora.
      </p>
      {error ? (
        <div className="inline-error">
          <Icon name="alert" size={14} /> {error}
        </div>
      ) : null}
      {!saved ? (
        <p className="field-help">Lendo…</p>
      ) : !saved.length ? (
        <p className="field-help">Nenhuma escolha salva ainda.</p>
      ) : (
        saved.map((project) => (
          <div key={project.projectId} className="saved-approvals-project">
            <strong title={project.projectId}>{project.projectName}</strong>
            <ul>
              {(['deny', 'allow'] as const).flatMap((effect) =>
                project[effect].map((rule) => (
                  <li key={`${effect}:${rule}`} className={effect}>
                    <span className="saved-approvals-effect">{effect === 'allow' ? 'permitido' : 'negado'}</span>
                    <code title={rule}>{rule}</code>
                    <button type="button" className="btn small ghost" onClick={() => void revoke(project.projectId, rule, effect)} aria-label={`Remover ${rule}`}>
                      <Icon name="trash" size={12} /> Remover
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}
