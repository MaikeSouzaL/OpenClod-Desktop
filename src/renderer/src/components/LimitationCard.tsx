import { useState, type ReactElement } from 'react'
import type { LimitationReport, ToolResultPart } from '../../../shared/types'
import { Icon } from './Icons'
import { limitationMarkdown, parseLimitation } from '../lib/limitations'

interface LimitationCardProps {
  args?: unknown
  result?: ToolResultPart
  /** Report produced by the harness itself; when set, `args` is ignored. */
  report?: LimitationReport
  /** Already persisted in Atividades → Limitação. */
  recorded?: boolean
}

/**
 * Visible card for `report_limitation` (or the harness's own self-analysis):
 * what the agent tried, what it saw, why it could not proceed and the fix it
 * suggests.
 */
export function LimitationCard({ args, result, report: direct, recorded }: LimitationCardProps): ReactElement | null {
  const report = direct ?? parseLimitation(args)
  const [copied, setCopied] = useState(false)
  if (!report) return null

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(limitationMarkdown(report))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  const degraded = report.severity === 'degraded'
  return (
    <article className={`limitation-card ${report.severity}`}>
      <header className="limitation-head">
        <span className="limitation-icon">
          <Icon name="alert" size={16} />
        </span>
        <div className="limitation-heading">
          <span className="limitation-kicker">Limitação do harness</span>
          <h3>{report.title}</h3>
        </div>
        <span className="limitation-badge">{degraded ? 'com contorno' : 'bloqueado'}</span>
      </header>

      <div className="limitation-grid">
        <div>
          <span className="limitation-label">Objetivo</span>
          <p>{report.goal}</p>
        </div>
        {report.attempts?.length ? (
          <div className="limitation-attempts">
            <span className="limitation-label">O que eu tentei</span>
            <ul>
              {report.attempts.map((attempt, index) => (
                <li key={index}>{attempt}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <span className="limitation-label">O que eu vi</span>
          <pre>{report.error}</pre>
        </div>
        <div>
          <span className="limitation-label">Dificuldade</span>
          <p>{report.difficulty}</p>
        </div>
        {report.workaround ? (
          <div>
            <span className="limitation-label">Contorno</span>
            <p>{report.workaround}</p>
          </div>
        ) : null}
        <div className="limitation-fix">
          <span className="limitation-label">Solução sugerida</span>
          <p>{report.suggestion}</p>
        </div>
      </div>

      <footer className="limitation-foot">
        <span>
          {result || recorded ? 'Registrado também em Atividades → Limitação.' : 'Registrando limitação…'}
        </span>
        <button type="button" className="link-btn" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'copiado' : 'copiar relatório'}
        </button>
      </footer>
    </article>
  )
}
