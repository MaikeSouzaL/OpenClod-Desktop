import { useState, type ReactElement } from 'react'
import type { ApprovalRequest } from '../../../shared/types'
import { Icon } from './Icons'
import { RISK_LABELS, toolLabel } from '../lib/format'

interface ApprovalDockProps {
  approvals: ApprovalRequest[]
  onResolve(id: string, approved: boolean, always: boolean, reason?: string): void
}

const EFFECT_LABELS: Record<string, string> = {
  read: 'leitura',
  write: 'escrita',
  execute: 'execução',
  network: 'rede',
  control: 'controle de interface',
  destructive: 'destrutivo'
}

export function ApprovalDock({ approvals, onResolve }: ApprovalDockProps): ReactElement | null {
  const [reasons, setReasons] = useState<Record<string, string>>({})
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
                {approval.effect ? ` · efeito: ${EFFECT_LABELS[approval.effect] ?? approval.effect}` : ''}
              </span>
            </div>
          </div>
          <pre className="approval-detail">{approval.resource || approval.preview || approval.detail}</pre>
          <input
            className="approval-reason"
            value={reasons[approval.id] ?? ''}
            onChange={(event) =>
              setReasons((current) => ({ ...current, [approval.id]: event.target.value }))
            }
            placeholder="Motivo ou instrução para o agente (opcional, enviado no feedback)"
            spellCheck={false}
          />
          <div className="approval-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => onResolve(approval.id, false, false, reasons[approval.id] ?? '')}
            >
              Negar
            </button>
            <button
              type="button"
              className="btn ghost"
              title="Recusa este pedido e os iguais neste projeto, sem perguntar de novo (desfaça em Configurações → Permissões)"
              onClick={() => onResolve(approval.id, false, true, reasons[approval.id] ?? '')}
            >
              Negar sempre
            </button>
            <button
              type="button"
              className="btn subtle"
              title="Comandos ficam permitidos pela operação (ex.: git commit), não pelos argumentos; cada comando de uma cadeia (&&, |) vira uma regra"
              onClick={() => onResolve(approval.id, true, true)}
            >
              Permitir sempre
            </button>
            <button
              type="button"
              className={`btn ${approval.risk === 'destructive' ? 'danger' : 'primary'}`}
              onClick={() => onResolve(approval.id, true, false, reasons[approval.id] ?? '')}
            >
              Aprovar
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
