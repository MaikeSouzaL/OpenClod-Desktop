import type { ReactElement } from 'react'
import type { ApprovalRequest } from '../../../shared/types'
import { Icon } from './Icons'
import { RISK_LABELS, toolLabel } from '../lib/format'

interface ApprovalDockProps {
  approvals: ApprovalRequest[]
  onResolve(id: string, approved: boolean, always: boolean): void
}

export function ApprovalDock({ approvals, onResolve }: ApprovalDockProps): ReactElement | null {
  if (!approvals.length) return null

  return (
    <div className="approval-dock">
      {approvals.map((approval) => (
        <div key={approval.id} className={`approval risk-${approval.risk}`}>
          <div className="approval-head">
            <span className="approval-icon">
              <Icon name={approval.risk === 'destructive' ? 'alert' : 'shield'} size={15} />
            </span>
            <div className="approval-title">
              <strong>{approval.title}</strong>
              <span>
                {toolLabel(approval.tool)} · risco {RISK_LABELS[approval.risk] ?? approval.risk}
              </span>
            </div>
          </div>
          <pre className="approval-detail">{approval.preview || approval.detail}</pre>
          <div className="approval-actions">
            <button type="button" className="btn ghost" onClick={() => onResolve(approval.id, false, false)}>
              Negar
            </button>
            <button type="button" className="btn subtle" onClick={() => onResolve(approval.id, true, true)}>
              Permitir sempre
            </button>
            <button
              type="button"
              className={`btn ${approval.risk === 'destructive' ? 'danger' : 'primary'}`}
              onClick={() => onResolve(approval.id, true, false)}
            >
              Aprovar
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
