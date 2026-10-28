import type { PlanItem } from '../../shared/types.js'

/**
 * The continuity capsule: ONE page per session that always says where the work stands, written by the harness after
 * every turn (the model does not have to remember to). It is what lets another model, in another session, "continue de
 * onde paramos": the objective, the last request and result, the plan with its statuses, the next step and the files.
 *
 * The turn notes already record WHAT was said; this page records WHERE THINGS STAND, which is what a newcomer needs
 * first. A session whose plan is finished and whose last turn ended normally is marked as concluded and stops being
 * offered as open work.
 */
export type WorkStatus = 'em-aberto' | 'interrompido' | 'concluido'

export interface StateInput {
  sessionTitle: string
  sessionId: string
  /** Slug of the session's index page (the capsule links to it). */
  sessionSlug: string
  provider: string
  model: string
  /** Run state of the session after the turn: done, error, cancelled... */
  runState: string
  firstRequest: string
  lastRequest: string
  result: string
  plan: PlanItem[]
  files: string[]
  /** Text of a compaction summary, when the history was summarised: its Objective and Next Move fill what the plan lacks. */
  summary?: string
  now?: Date
}

export interface StatePage {
  slug: string
  title: string
  body: string
  tags: string[]
  memoryType: 'pending' | 'fact'
  status: WorkStatus
  next: string
}

// The objective is what a newcomer needs most (the decisions the user gave): it gets the biggest share.
const MAX_BODY = 6_000

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The text under `## <name>` of a compaction summary (the markers are English on purpose, see compaction.ts). */
export function summarySection(summary: string | undefined, name: string): string {
  if (!summary) return ''
  const match = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im').exec(summary)
  return match ? match[1].trim() : ''
}

function firstItem(section: string): string {
  const line = section
    .split('\n')
    .map((item) => item.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .find((item) => item && !/^\(?(nenhum|nada)/i.test(item))
  return line ?? ''
}

export function stateSlug(sessionSlug: string): string {
  return `estado-${sessionSlug.replace(/^sessao-/, '')}`.slice(0, 80).replace(/-+$/, '')
}

export function buildStatePage(input: StateInput): StatePage {
  const open = input.plan.filter((item) => item.status === 'pending' || item.status === 'active' || item.status === 'blocked')
  const ended = input.runState === 'done' || input.runState === 'idle'
  const status: WorkStatus = !ended ? 'interrompido' : open.length ? 'em-aberto' : 'concluido'

  const active = input.plan.find((item) => item.status === 'active') ?? input.plan.find((item) => item.status === 'pending')
  const blocked = input.plan.find((item) => item.status === 'blocked')
  const summarised = firstItem(summarySection(input.summary, 'Next Move'))
  let next = ''
  if (status !== 'concluido') {
    next = active?.text ?? (blocked ? `destravar: ${blocked.text}` : '')
    if (!next) next = summarised
    if (!next && status === 'interrompido') next = `retomar o último pedido: ${oneLine(input.lastRequest, 200)}`
  }

  const objective = oneLine(firstItem(summarySection(input.summary, 'Objective')) || input.firstRequest, 1_800)
  const label = status === 'concluido' ? 'concluído' : status === 'interrompido' ? 'interrompido (o último turno não terminou bem)' : 'em aberto'
  const stamp = (input.now ?? new Date()).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  const lines = [
    `**Situação:** ${label}`,
    `**Atualizado:** ${stamp} · **Modelo:** ${input.provider}/${input.model}`,
    `**Sessão:** [[${input.sessionSlug}]]`,
    '',
    '## Objetivo',
    objective || '(sem pedido registrado)',
    '',
    '## Último pedido',
    oneLine(input.lastRequest, 400) || '(nenhum)',
    '',
    '## Resultado do último turno',
    oneLine(input.result, 600) || '(sem resposta textual)'
  ]
  if (input.plan.length) {
    lines.push('', '## Plano', ...input.plan.slice(0, 12).map((item) => `- [${item.status}] ${oneLine(item.text, 160)}`))
  }
  lines.push('', '## Próximo passo', next ? oneLine(next, 400) : '(nenhum: nada em aberto)')
  if (input.files.length) lines.push('', '## Arquivos mexidos', ...input.files.slice(0, 12).map((file) => `- ${file}`))

  let body = lines.join('\n')
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - 1)}…`
  return {
    slug: stateSlug(input.sessionSlug),
    title: `Estado: ${oneLine(input.sessionTitle, 80) || input.sessionId}`,
    body,
    tags: ['estado', status],
    memoryType: status === 'concluido' ? 'fact' : 'pending',
    status,
    next
  }
}

/** The text under `## <name>` of a capsule body (Portuguese headings). */
function capsuleSection(body: string, name: string): string {
  const match = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im').exec(body)
  return match ? match[1].trim() : ''
}

/**
 * The part of a capsule worth putting in front of a model that was handed the work: what it is for, the plan, what is
 * next and the files. A couple of thousand characters, so a plain "continue" has the decisions it needs without a tool call.
 */
export function digestCapsule(body: string, max = 2_600): string {
  const lines: string[] = []
  const objective = oneLine(capsuleSection(body, 'Objetivo'), 1_500)
  if (objective) lines.push(`Objetivo: ${objective}`)
  const last = oneLine(capsuleSection(body, 'Último pedido'), 220)
  if (last) lines.push(`Último pedido: ${last}`)
  const result = oneLine(capsuleSection(body, 'Resultado do último turno'), 260)
  if (result) lines.push(`Resultado: ${result}`)
  const plan = capsuleSection(body, 'Plano')
  if (plan) lines.push('Plano:', ...plan.split('\n').filter(Boolean).slice(0, 8))
  const next = parseNext(body)
  lines.push(`Próximo passo: ${next || '(nenhum)'}`)
  const files = capsuleSection(body, 'Arquivos mexidos')
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 6)
  if (files.length) lines.push(`Arquivos: ${files.join(', ')}`)
  const text = lines.join('\n')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** First line under "## Próximo passo" of a capsule body. */
export function parseNext(body: string): string {
  const match = /^##\s+Próximo passo\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(body)
  const line = match?.[1].split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  return /^\(nenhum/i.test(line) ? '' : line
}
