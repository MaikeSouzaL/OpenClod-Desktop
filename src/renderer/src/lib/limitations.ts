/**
 * Parses the `report_limitation` tool arguments into the card shown in the
 * transcript. Mirrors the tool schema, but tolerates partial/legacy args.
 */

import type { LimitationReport } from '../../../shared/types'

export type { LimitationReport }

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function parseLimitation(args: unknown): LimitationReport | null {
  if (!args || typeof args !== 'object') return null
  const value = args as Record<string, unknown>
  const title = text(value.title, 120)
  const goal = text(value.goal, 600)
  const error = text(value.error, 1500)
  const difficulty = text(value.difficulty, 800)
  const suggestion = text(value.suggestion, 800)
  if (!title || !goal || !error || !difficulty || !suggestion) return null
  const workaround = text(value.workaround, 600)
  const attempts = Array.isArray(value.attempts)
    ? value.attempts
        .map((entry) => text(entry, 400))
        .filter(Boolean)
        .slice(0, 12)
    : []
  return {
    title,
    goal,
    error,
    difficulty,
    suggestion,
    ...(attempts.length ? { attempts } : {}),
    ...(workaround ? { workaround } : {}),
    severity: value.severity === 'degraded' ? 'degraded' : 'blocked'
  }
}

/** Markdown the user can copy and paste into the harness backlog. */
export function limitationMarkdown(report: LimitationReport): string {
  return [
    `## Limitação: ${report.title}`,
    `- **Severidade:** ${report.severity === 'degraded' ? 'com contorno' : 'bloqueado'}`,
    `- **Objetivo:** ${report.goal}`,
    `- **Erro observado:** ${report.error}`,
    `- **Dificuldade:** ${report.difficulty}`,
    ...(report.attempts?.length ? ['- **Tentativas:**', ...report.attempts.map((attempt) => `  - ${attempt}`)] : []),
    ...(report.workaround ? [`- **Contorno:** ${report.workaround}`] : []),
    `- **Solução sugerida:** ${report.suggestion}`
  ].join('\n')
}
