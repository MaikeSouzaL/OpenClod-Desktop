import type { LoopPhase, LoopState, LoopStatus } from '../../../shared/types'

/** The cycle of every round, in order, as the dock shows it. */
export const LOOP_PHASES: Array<{ id: LoopPhase; label: string }> = [
  { id: 'definir', label: 'Definir' },
  { id: 'planejar', label: 'Planejar' },
  { id: 'fazer', label: 'Fazer' },
  { id: 'verificar', label: 'Verificar' },
  { id: 'criticar', label: 'Criticar' },
  { id: 'julgar', label: 'Julgar' },
  { id: 'memoria', label: 'Memória' }
]

const STATUS: Record<LoopStatus, { label: string; tone: 'running' | 'good' | 'warn' | 'bad' | 'muted' }> = {
  running: { label: 'Rodando', tone: 'running' },
  done: { label: 'Concluído', tone: 'good' },
  blocked: { label: 'Aguardando você', tone: 'warn' },
  exhausted: { label: 'Orçamento esgotado', tone: 'warn' },
  stalled: { label: 'Estagnado', tone: 'bad' },
  cancelled: { label: 'Parado', tone: 'muted' }
}

const DECISIONS = { done: 'PRONTO', continue: 'CONTINUAR', blocked: 'BLOQUEADO' } as const

export interface LoopView {
  status: string
  tone: 'running' | 'good' | 'warn' | 'bad' | 'muted'
  round: string
  time: string
  phase: LoopPhase
  met: number
  total: number
  criteria: Array<{ id: string; text: string; check?: string; mark: 'met' | 'failed' | 'pending'; proof?: string }>
  verdict?: string
  agents: string[]
  reason?: string
}

function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000))
}

/** Everything the Loop Engineering dock prints, from the session's loop state. */
export function describeLoop(loop: LoopState, now: number): LoopView {
  const status = STATUS[loop.status]
  const end = loop.endedAt ?? (loop.status === 'running' ? now : loop.startedAt)
  const verdict = loop.verdicts.at(-1)
  return {
    status: status.label,
    tone: status.tone,
    round: `Volta ${loop.round} de ${loop.maxRounds}`,
    time: `${minutes(end - loop.startedAt)} min de ${loop.maxMinutes}`,
    phase: loop.phase,
    met: loop.criteria.filter((criterion) => criterion.status === 'met').length,
    total: loop.criteria.length,
    criteria: loop.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      ...(criterion.check ? { check: criterion.check } : {}),
      mark: criterion.status,
      ...(criterion.status === 'failed' && criterion.evidence ? { proof: lastLine(criterion.evidence) } : {})
    })),
    ...(verdict ? { verdict: `Juiz, volta ${verdict.round}: ${DECISIONS[verdict.decision]}${verdict.summary ? ` — ${verdict.summary}` : ''}` } : {}),
    agents: [...new Set(loop.roundAgents)],
    ...(loop.status !== 'running' && loop.reason ? { reason: loop.reason } : {})
  }
}

/** The line of a failed run that says what failed (test runners summarise at the end). */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const telling = lines.filter((line) => /fail|error|erro|expected|assert|negado|não aprovou/i.test(line))
  return ((telling.length ? telling.at(-1) : lines.at(-1)) ?? '').slice(0, 220)
}
