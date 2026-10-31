import type { LoopCriterion, LoopPhase, LoopState, LoopVerdict } from '../../shared/types.js'

/**
 * Loop Engineering: the state machine behind the "Código Loop Engineering" mode. Pure: the runner owns one LoopState per
 * session, asks `gate()` what to do each time the conductor tries to end its answer, and the `loop` tool feeds it criteria,
 * check results and verdicts. Nothing here talks to a model, runs a command or touches the disk.
 *
 * The loop ends only for a reason the harness can state: the judge said PRONTO and every command criterion passed (done),
 * the user has to answer (blocked), the rounds or the minutes ran out (exhausted) or the same failure kept coming back after
 * two changes of strategy (stalled).
 */

/** Ceilings for what a request or the settings may ask for. */
export const LOOP_CEILINGS = { rounds: 30, minutes: 8 * 60, criteria: 12 }
/** The same failure in this many rounds in a row forces a change of strategy. */
export const STAGNATION_ROUNDS = 3
/** Changes of strategy without progress before the loop stops and asks the user. */
export const MAX_STRATEGY_CHANGES = 2
/** The agent whose opinion PRONTO needs in the same round. */
export const LOOP_JUDGE_AGENT = 'loop-judge'
/** The agent that writes and runs the tests: PRONTO needs it somewhere in the loop when code changed. */
export const LOOP_TESTER_AGENT = 'tester'
/** Output kept as the proof of one criterion. */
const EVIDENCE_CHARS = 1_500

export interface LoopBudget {
  rounds: number
  minutes: number
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kts?|cs|cpp|cc|cxx|c|h|hpp|rb|php|swift|vue|svelte|dart|scala|lua|sh|ps1)$/i

/** A source file whose behavior tests can prove (not docs, data or configuration). */
export function isCodePath(file: string): boolean {
  return CODE_FILE.test(file)
}

export function clampBudget(budget: Partial<LoopBudget>, fallback: LoopBudget): LoopBudget {
  const rounds = Number.isFinite(budget.rounds) ? Math.round(budget.rounds as number) : fallback.rounds
  const minutes = Number.isFinite(budget.minutes) ? Math.round(budget.minutes as number) : fallback.minutes
  return {
    rounds: Math.max(1, Math.min(LOOP_CEILINGS.rounds, rounds)),
    minutes: Math.max(5, Math.min(LOOP_CEILINGS.minutes, minutes))
  }
}

/**
 * The loop of a new user turn. A loop that did not finish (stopped by the budget, by the user, by a question) goes on with
 * the same criteria and a fresh budget: the new message is usually the answer or a "continue". One that finished starts over.
 */
export function startLoop(goal: string, budget: LoopBudget, now: number, previous?: LoopState | null): LoopState {
  if (previous && previous.status !== 'done') {
    return {
      ...previous,
      status: 'running',
      round: previous.round + 1,
      maxRounds: previous.round + budget.rounds,
      startedAt: now,
      maxMinutes: budget.minutes,
      deadlineAt: now + budget.minutes * 60_000,
      phase: previous.criteria.length ? 'fazer' : 'definir',
      roundAgents: [],
      stagnantRounds: 0,
      strategyChanges: 0,
      endedAt: undefined,
      reason: undefined
    }
  }
  return {
    goal: goal.trim().slice(0, 2_000),
    status: 'running',
    round: 1,
    maxRounds: budget.rounds,
    startedAt: now,
    maxMinutes: budget.minutes,
    deadlineAt: now + budget.minutes * 60_000,
    phase: 'definir',
    criteria: [],
    verdicts: [],
    roundAgents: [],
    agents: [],
    stagnantRounds: 0,
    strategyChanges: 0
  }
}

export interface CriterionInput {
  text: string
  check?: string
}

/** Replaces the criteria (the request changed, or the first definition). A new budget may come with them, within the ceilings. */
export function defineCriteria(
  state: LoopState,
  items: CriterionInput[],
  options: { goal?: string; budget?: Partial<LoopBudget>; now: number }
): LoopState {
  const criteria: LoopCriterion[] = items.slice(0, LOOP_CEILINGS.criteria).map((item, index) => ({
    id: `c${index + 1}`,
    text: item.text.trim().slice(0, 400),
    ...(item.check?.trim() ? { check: item.check.trim().slice(0, 1_000) } : {}),
    status: 'pending'
  }))
  let next: LoopState = { ...state, criteria, phase: 'definir', lastFailure: undefined, stagnantRounds: 0 }
  if (options.goal?.trim()) next.goal = options.goal.trim().slice(0, 2_000)
  if (options.budget && (options.budget.rounds !== undefined || options.budget.minutes !== undefined)) {
    const current = { rounds: state.maxRounds - state.round + 1, minutes: state.maxMinutes }
    const budget = clampBudget(options.budget, current)
    next = { ...next, maxRounds: state.round - 1 + budget.rounds, maxMinutes: budget.minutes, deadlineAt: state.startedAt + budget.minutes * 60_000 }
  }
  return next
}

export interface CheckResult {
  id: string
  ok: boolean
  evidence: string
}

export function applyChecks(state: LoopState, results: CheckResult[], now: number): LoopState {
  const byId = new Map(results.map((result) => [result.id, result]))
  return {
    ...state,
    phase: 'verificar',
    criteria: state.criteria.map((criterion) => {
      const result = byId.get(criterion.id)
      if (!result) return criterion
      return { ...criterion, status: result.ok ? 'met' : 'failed', evidence: tail(result.evidence), checkedAt: now }
    })
  }
}

const AGENT_PHASES: Record<string, LoopPhase> = {
  'done-criteria': 'definir',
  planner: 'planejar',
  strategist: 'planejar',
  explorer: 'planejar',
  researcher: 'planejar',
  verifier: 'verificar',
  'app-prover': 'verificar',
  'web-qa': 'verificar',
  'mobile-qa': 'verificar',
  'qa-lead': 'verificar',
  tester: 'verificar',
  'svg-verifier': 'verificar',
  'loop-critic': 'criticar',
  reviewer: 'criticar',
  'security-auditor': 'criticar',
  [LOOP_JUDGE_AGENT]: 'julgar',
  'loop-memory': 'memoria'
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch_file', 'apply_patch', 'delete_path'])

/** The phase a tool call puts the loop in, or null when it says nothing about the phase. */
export function phaseOfCall(name: string, args: unknown): LoopPhase | null {
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (name === 'agent') return AGENT_PHASES[String(record.agent ?? '')] ?? 'fazer'
  if (name === 'loop') {
    const action = String(record.action ?? '')
    return action === 'define' ? 'definir' : action === 'check' ? 'verificar' : action === 'verdict' ? 'julgar' : null
  }
  if (WRITE_TOOLS.has(name)) return 'fazer'
  if (name === 'update_plan') return 'planejar'
  return null
}

/** Records the calls of one model step: the phase they put the loop in and the agents called in this round. */
export function noteCalls(state: LoopState, calls: Array<{ name: string; args: unknown }>): LoopState {
  // A loop that stopped keeps the phase it stopped in (closing the plan after PRONTO is not a new "planejar").
  if (state.status !== 'running') return state
  let phase = state.phase
  const agents = [...state.roundAgents]
  const everyone = new Set(state.agents ?? [])
  for (const call of calls) {
    const next = phaseOfCall(call.name, call.args)
    if (next) phase = next
    if (call.name === 'agent') {
      const agent = String((call.args as Record<string, unknown> | undefined)?.agent ?? '')
      if (agent) {
        agents.push(agent)
        everyone.add(agent)
      }
    }
  }
  if (phase === state.phase && agents.length === state.roundAgents.length) return state
  return { ...state, phase, roundAgents: agents, agents: [...everyone] }
}

export interface VerdictInput {
  decision: 'done' | 'continue' | 'blocked'
  summary: string
  missing?: string[]
  /** The judge's call on the criteria without a command: met or not, with the proof it saw. */
  evidence?: Array<{ id: string; met: boolean; proof?: string }>
  /** Source files changed in this turn (see isCodePath): then the tester must have taken part in the loop. */
  codeChanged?: boolean
}

export interface VerdictOutcome {
  state: LoopState
  /** False when PRONTO was refused and recorded as CONTINUAR. */
  accepted: boolean
  message: string
}

/**
 * Records the verdict of the round. PRONTO is accepted only when the judge took part in this round, the tester took part in
 * the loop if code changed, every command criterion passed in the checks the tool has just run, and every other criterion has
 * a proof; otherwise it becomes CONTINUAR with what is missing, so the loop cannot end on the conductor's word alone.
 */
export function recordVerdict(state: LoopState, input: VerdictInput, now: number): VerdictOutcome {
  const proofs = new Map((input.evidence ?? []).map((item) => [item.id, item]))
  const criteria: LoopCriterion[] = state.criteria.map((criterion) => {
    if (criterion.check) return criterion
    const proof = proofs.get(criterion.id)
    if (!proof) return criterion
    return {
      ...criterion,
      status: proof.met && proof.proof?.trim() ? 'met' : proof.met ? criterion.status : 'failed',
      ...(proof.proof?.trim() ? { evidence: tail(proof.proof) } : {}),
      checkedAt: now
    }
  })
  const base: LoopState = { ...state, criteria, phase: 'julgar' }
  const verdict = (decision: LoopVerdict['decision'], summary: string, missing?: string[]): LoopVerdict => ({
    round: state.round,
    decision,
    summary: summary.trim().slice(0, 1_000),
    ...(missing?.length ? { missing: missing.map((item) => item.slice(0, 300)).slice(0, 12) } : {}),
    at: now
  })

  if (input.decision === 'blocked') {
    const reason = [input.summary.trim(), ...(input.missing ?? [])].filter(Boolean).join(' · ').slice(0, 600)
    return {
      state: { ...base, status: 'blocked', verdicts: [...state.verdicts, verdict('blocked', input.summary, input.missing)], endedAt: now, reason },
      accepted: true,
      message: 'Loop parado: aguardando o usuário. Escreva a pergunta ou o pedido de decisão na sua resposta.'
    }
  }

  if (input.decision === 'continue') {
    const missing = input.missing?.length ? input.missing : openCriteria(base).map(describeOpen)
    return {
      state: { ...base, verdicts: [...state.verdicts, verdict('continue', input.summary, missing)] },
      accepted: true,
      message: 'Veredito CONTINUAR registrado. Termine esta volta com um resumo curto; o harness começa a próxima com o que falta.'
    }
  }

  const problems: string[] = []
  if (!state.criteria.length) problems.push('nenhum critério de pronto foi definido (loop action=define)')
  if (!state.roundAgents.includes(LOOP_JUDGE_AGENT)) problems.push(`o juiz (${LOOP_JUDGE_AGENT}) não foi chamado nesta volta`)
  if (input.codeChanged && !(state.agents ?? []).includes(LOOP_TESTER_AGENT)) {
    problems.push(`o código mudou e o ${LOOP_TESTER_AGENT} não foi chamado neste loop: ele escreve os testes que faltam e roda a suíte (quem fez o código não escreve os testes que vão prová-lo)`)
  }
  for (const criterion of openCriteria(base)) problems.push(describeOpen(criterion))
  if (problems.length) {
    return {
      state: { ...base, verdicts: [...state.verdicts, verdict('continue', `PRONTO recusado pelo harness: ${input.summary}`, problems)] },
      accepted: false,
      message: ['PRONTO recusado pelo harness, registrado como CONTINUAR. Falta:', ...problems.map((problem) => `- ${problem}`)].join('\n')
    }
  }
  return {
    state: {
      ...base,
      status: 'done',
      verdicts: [...state.verdicts, verdict('done', input.summary)],
      endedAt: now,
      reason: 'o juiz deu PRONTO e todos os critérios estão provados'
    },
    accepted: true,
    message: 'PRONTO aceito: todos os critérios estão provados. Escreva o relatório final para o usuário (o que foi feito, as provas e o que ficou de fora).'
  }
}

/** Criteria that are not proven yet. */
export function openCriteria(state: LoopState): LoopCriterion[] {
  return state.criteria.filter((criterion) => criterion.status !== 'met')
}

function describeOpen(criterion: LoopCriterion): string {
  const how = criterion.check ? `\`${criterion.check}\`` : 'sem comando: precisa de prova do juiz'
  const why = criterion.status === 'failed' && criterion.evidence ? ` — última prova: ${firstLines(criterion.evidence, 2)}` : ''
  return `${criterion.id} ${criterion.status === 'failed' ? 'falhou' : 'não provado'}: ${criterion.text} (${how})${why}`
}

/* ------------------------------------------------------------------ */
/* The gate: what happens when the conductor tries to end its answer   */
/* ------------------------------------------------------------------ */

export type LoopGate =
  /** Let the turn end: the loop finished, needs the user, or is not running. */
  | { kind: 'end' }
  /** Same round: something is missing before the round may end (criteria, verdict). */
  | { kind: 'nudge'; reason: 'define' | 'verdict'; prompt: string }
  /** The next round starts with this prompt. */
  | { kind: 'round'; prompt: string }
  /** The loop stopped (budget, stagnation): one last answer without tools, then the turn ends. */
  | { kind: 'final'; prompt: string }

export interface GateMemory {
  /** Nudges already sent in this round. */
  defineNudges: number
  verdictNudges: number
}

export function gate(state: LoopState, now: number, memory: GateMemory): { state: LoopState; gate: LoopGate } {
  if (state.status !== 'running') return { state, gate: { kind: 'end' } }

  if (!state.criteria.length) {
    if (memory.defineNudges < 1) {
      return { state, gate: { kind: 'nudge', reason: 'define', prompt: DEFINE_NUDGE } }
    }
    // Not a task (a greeting, a question) or a model that will not define them: the answer stands and the loop waits.
    return {
      state: { ...state, status: 'blocked', endedAt: now, reason: 'sem critérios de pronto: nada para verificar nesta mensagem' },
      gate: { kind: 'end' }
    }
  }

  const judged = state.verdicts.some((verdict) => verdict.round === state.round)
  if (!judged && memory.verdictNudges < 1) {
    return { state, gate: { kind: 'nudge', reason: 'verdict', prompt: verdictNudge(state) } }
  }

  // The round ends as CONTINUAR (said by the judge, or implied by ending without a verdict).
  const failure = failureSignature(state)
  const metNow = state.criteria.filter((criterion) => criterion.status === 'met').length
  const metBefore = state.lastFailure === undefined ? -1 : Number(state.lastFailure.split('|', 1)[0])
  const same = failure === state.lastFailure
  const stagnantRounds = same ? state.stagnantRounds + 1 : 1
  const progressed = metNow > metBefore && !same
  const strategyChanges = stagnantRounds >= STAGNATION_ROUNDS ? stagnantRounds - STAGNATION_ROUNDS + 1 : progressed ? 0 : state.strategyChanges
  let next: LoopState = { ...state, lastFailure: failure, stagnantRounds, strategyChanges }

  if (strategyChanges > MAX_STRATEGY_CHANGES) {
    next = {
      ...next,
      status: 'stalled',
      endedAt: now,
      reason: `a mesma falha voltou em ${stagnantRounds} voltas seguidas, mesmo depois de ${MAX_STRATEGY_CHANGES} mudanças de estratégia`
    }
    return { state: next, gate: { kind: 'final', prompt: stalledPrompt(next) } }
  }
  if (state.round >= state.maxRounds) {
    next = { ...next, status: 'exhausted', endedAt: now, reason: `as ${state.maxRounds} voltas do orçamento acabaram` }
    return { state: next, gate: { kind: 'final', prompt: exhaustedPrompt(next) } }
  }
  if (now >= state.deadlineAt) {
    next = { ...next, status: 'exhausted', endedAt: now, reason: `os ${state.maxMinutes} minutos do orçamento acabaram` }
    return { state: next, gate: { kind: 'final', prompt: exhaustedPrompt(next) } }
  }

  next = { ...next, round: state.round + 1, roundAgents: [], phase: 'fazer' }
  return { state: next, gate: { kind: 'round', prompt: roundPrompt(next, now, !judged) } }
}

/** The loop's time ran out in the middle of a round: it stops after one last answer. */
export function timeUp(state: LoopState, now: number): LoopState | null {
  if (state.status !== 'running' || now < state.deadlineAt) return null
  return { ...state, status: 'exhausted', endedAt: now, reason: `os ${state.maxMinutes} minutos do orçamento acabaram` }
}

/** The turn ended without the gate closing the loop (error, cancellation, iteration cap): say why on the state. */
export function interrupted(state: LoopState, how: 'cancelled' | 'length' | 'error', detail: string | undefined, now: number): LoopState {
  if (state.status !== 'running') return state
  if (how === 'cancelled') return { ...state, status: 'cancelled', endedAt: now, reason: 'parado pelo usuário' }
  if (how === 'length') return { ...state, status: 'exhausted', endedAt: now, reason: detail ?? `a volta ${state.round} passou do limite de iterações` }
  return { ...state, status: 'blocked', endedAt: now, reason: `o turno parou com erro: ${(detail ?? 'erro desconhecido').slice(0, 300)}` }
}

/**
 * What failed, in a form that does not change between two runs of the same failure: the open criteria and the first lines
 * of their proof with numbers taken out (durations, counts and line numbers vary from run to run). Prefixed with how many
 * criteria were met, so progress can be told from it.
 */
export function failureSignature(state: LoopState): string {
  const met = state.criteria.filter((criterion) => criterion.status === 'met').length
  const open = openCriteria(state)
    .map((criterion) => `${criterion.id}:${firstLines(criterion.evidence ?? '', 2).replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 160)}`)
    .sort()
  const missing = state.verdicts.filter((verdict) => verdict.round === state.round).flatMap((verdict) => verdict.missing ?? [])
  return `${met}|${open.join(';')}|${missing.join(';').replace(/\d+/g, '#').slice(0, 300)}`
}

/* ------------------------------------------------------------------ */
/* Prompts the harness injects (hidden messages)                        */
/* ------------------------------------------------------------------ */

const DEFINE_NUDGE = [
  '<loop-definir>',
  'Este é o modo Loop Engineering: antes de encerrar, registre os critérios de pronto com loop action=define',
  '(de preferência com `check`: o comando que prova cada um, como os testes, o typecheck ou o build do projeto).',
  'Depois trabalhe na primeira volta. Se a mensagem não for uma tarefa (um cumprimento, uma pergunta), apenas responda.',
  '</loop-definir>'
].join('\n')

function verdictNudge(state: LoopState): string {
  return [
    '<loop-veredito>',
    `A volta ${state.round} de ${state.maxRounds} não tem veredito. Antes de encerrar: rode loop action=check, chame o agente ${LOOP_JUDGE_AGENT}`,
    'com o pedido, os critérios e as provas, e registre o parecer com loop action=verdict (done, continue ou blocked).',
    '</loop-veredito>'
  ].join('\n')
}

function criteriaLines(state: LoopState): string[] {
  return state.criteria.map((criterion) => {
    const box = criterion.status === 'met' ? '[x]' : criterion.status === 'failed' ? '[!]' : '[ ]'
    const how = criterion.check ? ` — check: \`${criterion.check}\`` : ''
    const proof = criterion.status === 'failed' && criterion.evidence ? `\n    última prova: ${firstLines(criterion.evidence, 3).replace(/\n/g, '\n    ')}` : ''
    return `${box} ${criterion.id} ${criterion.text}${how}${proof}`
  })
}

function roundPrompt(state: LoopState, now: number, withoutVerdict: boolean): string {
  const last = state.verdicts.at(-1)
  const elapsed = Math.max(0, Math.round((now - state.startedAt) / 60_000))
  const lines = [
    `<loop-volta n="${state.round}" de="${state.maxRounds}">`,
    withoutVerdict
      ? `A volta ${state.round - 1} terminou sem veredito: conta como CONTINUAR.`
      : `O juiz deu CONTINUAR na volta ${state.round - 1}${last?.summary ? `: ${last.summary}` : ''}.`,
    `Comece a volta ${state.round} agora e trabalhe só no que falta.`
  ]
  const missing = last?.round === state.round - 1 ? last.missing ?? [] : []
  if (missing.length) lines.push('Falta:', ...missing.map((item) => `- ${item}`))
  lines.push('Critérios:', ...criteriaLines(state))
  lines.push(`Tempo: ${elapsed} min de ${state.maxMinutes}.`)
  if (state.stagnantRounds >= STAGNATION_ROUNDS) {
    lines.push(
      '<mude-de-estrategia>',
      `A mesma falha voltou em ${state.stagnantRounds} voltas seguidas (mudança de estratégia ${state.strategyChanges} de ${MAX_STRATEGY_CHANGES}).`,
      'Não repita a abordagem: leia a memória do loop, chame o debugger ou outro especialista, reduza o problema a um caso mínimo ou troque a solução.',
      `Se depois de ${MAX_STRATEGY_CHANGES} mudanças a falha continuar igual, o loop para e pergunta ao usuário.`,
      '</mude-de-estrategia>'
    )
  }
  lines.push(`Ao fim da volta: loop action=check, ${LOOP_JUDGE_AGENT}, loop action=verdict. Não peça licença para continuar.`, '</loop-volta>')
  return lines.join('\n')
}

function exhaustedPrompt(state: LoopState): string {
  return [
    '<loop-fim motivo="orçamento">',
    `O loop parou: ${state.reason}. Não chame mais ferramentas.`,
    'Escreva o relatório final para o usuário: o que ficou pronto (com as provas), o que falta (critério por critério), o que você tentaria na próxima volta',
    'e que ele pode mandar "continue" para mais voltas.',
    ...criteriaLines(state),
    '</loop-fim>'
  ].join('\n')
}

function stalledPrompt(state: LoopState): string {
  return [
    '<loop-fim motivo="estagnado">',
    `O loop parou: ${state.reason}. Não chame mais ferramentas.`,
    'Explique ao usuário, em poucas linhas, o que continua falhando (com a prova), o que já foi tentado e por que não resolveu,',
    'e faça UMA pergunta objetiva com a decisão que destravaria o trabalho.',
    ...criteriaLines(state),
    '</loop-fim>'
  ].join('\n')
}

export function timeUpPrompt(state: LoopState): string {
  return exhaustedPrompt(state)
}

function tail(text: string): string {
  const clean = text.trim()
  return clean.length > EVIDENCE_CHARS ? `…${clean.slice(-EVIDENCE_CHARS)}` : clean
}

function firstLines(text: string, count: number): string {
  // The interesting part of a failed run is usually at the end (the summary of a test runner), not the command echo.
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('$ ') && !/^exit=/.test(line))
  const meaningful = lines.filter((line) => /fail|error|erro|✗|×|expected|assert|não|not /i.test(line))
  return (meaningful.length ? meaningful : lines.slice(-count)).slice(0, count).join('\n').slice(0, 400)
}
