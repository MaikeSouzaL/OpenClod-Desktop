import type { ImprovementFinding, ImprovementSeverity } from '../../shared/api.js'
import { budgetKindLabel } from '../../shared/budget.js'
import { redactDiagnosticText } from '../observability/service.js'
import type {
  AgentFailureGroup,
  Evidence,
  LimitationGroup,
  PermissionGroup,
  ReviewInput,
  ToolGroup
} from './types.js'

const DAY = 86_400_000
const STALE_DAYS = 90
const MAX_GROUPS = 12

/** Tools that are slow or wait for the user by nature; their duration says nothing about quality. */
const LONG_BY_NATURE = /^(agent|task|ask_user|start_process|read_process_output|web_research|(computer|browser)_wait.*)$/

/** Pages written automatically per turn/session; everything else is curated memory. */
const LOG_TAGS = ['turno', 'sessao']

function text(value: unknown, max: number): string {
  return redactDiagnosticText(value, max)
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item'
}

function top<T>(items: T[], key: (item: T) => number): T[] {
  return [...items].sort((a, b) => key(b) - key(a)).slice(0, MAX_GROUPS)
}

/**
 * Turns raw logs into counted, redacted evidence about one project. Pure: no
 * clock, no disk, no model. Every string that could carry a secret or a user
 * path goes through `redactDiagnosticText` here, before it can reach a prompt,
 * a memory page or the Activity list.
 */
export function collectEvidence(input: ReviewInput): Evidence {
  const since = input.now - input.days * DAY
  const own = new Set(input.sessions.map((session) => session.id))
  const scoped = (sessionId?: string): boolean => Boolean(sessionId && own.has(sessionId))

  const events = input.events.filter((event) => event.ts >= since && scoped(event.sessionId))
  const items = input.activity.filter((item) => item.updatedAt >= since && scoped(item.sessionId))
  const oldestEvent = input.events.reduce<number | undefined>((oldest, event) => (oldest === undefined || event.ts < oldest ? event.ts : oldest), undefined)

  /* ------------------------------ limitations ------------------------------ */
  const limitationMap = new Map<string, LimitationGroup & { sessionSet: Set<string> }>()
  for (const item of items.filter((candidate) => candidate.type === 'limitation')) {
    const title = text(item.title.replace(/^Limitação:\s*/i, ''), 140) || 'sem título'
    const key = title.toLowerCase()
    const group = limitationMap.get(key) ?? { title, count: 0, sessions: [], sessionSet: new Set<string>(), lastAt: 0, blocking: false, detail: '' }
    group.count += Math.max(1, item.count)
    if (item.sessionId) group.sessionSet.add(item.sessionId)
    if (item.actionRequired) group.blocking = true
    if (item.updatedAt >= group.lastAt) {
      group.lastAt = item.updatedAt
      group.detail = text(item.detail, 300)
    }
    limitationMap.set(key, group)
  }
  const limitations = top(
    [...limitationMap.values()].map(({ sessionSet, ...group }) => ({ ...group, sessions: [...sessionSet] })),
    (group) => group.count
  )

  /* --------------------------------- tools --------------------------------- */
  const toolMap = new Map<string, { calls: number; failures: number; withDuration: number; totalMs: number; maxMs: number; sessions: Set<string>; errors: string[] }>()
  for (const event of events.filter((candidate) => candidate.type === 'tool_end' && candidate.name && candidate.name !== 'report_limitation')) {
    const name = event.name as string
    const group = toolMap.get(name) ?? { calls: 0, failures: 0, withDuration: 0, totalMs: 0, maxMs: 0, sessions: new Set<string>(), errors: [] }
    group.calls += 1
    if (event.sessionId) group.sessions.add(event.sessionId)
    if (typeof event.durationMs === 'number') {
      group.withDuration += 1
      group.totalMs += event.durationMs
      group.maxMs = Math.max(group.maxMs, event.durationMs)
    }
    if (event.ok === false) {
      group.failures += 1
      const message = text(event.detail ?? '', 180)
      if (message && !group.errors.some((known) => known.toLowerCase() === message.toLowerCase())) group.errors.push(message)
    }
    toolMap.set(name, group)
  }
  const tools: ToolGroup[] = top(
    [...toolMap.entries()].map(([name, group]) => ({
      name,
      calls: group.calls,
      failures: group.failures,
      failureRate: group.calls ? group.failures / group.calls : 0,
      averageMs: group.withDuration ? Math.round(group.totalMs / group.withDuration) : 0,
      maxMs: group.maxMs,
      sessions: [...group.sessions],
      errors: group.errors.slice(-3).reverse()
    })),
    (group) => group.failures * 1000 + group.calls
  )

  /* ------------------------------- permissions ------------------------------ */
  const requests = items.filter((item) => item.type === 'approval' && item.title === 'Aprovação necessária')
  const resolutions = items.filter((item) => item.type === 'approval' && /^Aprovação (concedida|recusada)$/.test(item.title))
  const permissionMap = new Map<string, PermissionGroup>()
  const byApproval = new Map<string, string>()
  const permissionGroup = (title: string, example: string): PermissionGroup => {
    const key = title.toLowerCase()
    const found = permissionMap.get(key)
    if (found) return found
    const created: PermissionGroup = { title, requested: 0, granted: 0, denied: 0, example }
    permissionMap.set(key, created)
    return created
  }
  for (const request of requests) {
    const raw = text(request.detail, 300)
    const split = raw.indexOf(': ')
    const title = (split > 0 ? raw.slice(0, split) : raw).replace(/^\[[^\]]+\]\s*/, '').slice(0, 100) || 'pedido de aprovação'
    const example = split > 0 ? raw.slice(split + 2) : raw
    const group = permissionGroup(title, example)
    group.requested += Math.max(1, request.count)
    const approvalId = request.metadata?.approvalId
    if (typeof approvalId === 'string') byApproval.set(approvalId, title)
  }
  for (const resolution of resolutions) {
    const title = byApproval.get(resolution.detail) ?? '(pedido fora do período)'
    const group = permissionGroup(title, '')
    if (resolution.title === 'Aprovação concedida') group.granted += 1
    else group.denied += 1
  }
  const permissions = top(
    [...permissionMap.values()].map((group) => ({ ...group, requested: Math.max(group.requested, group.granted + group.denied) })),
    (group) => group.denied * 1000 + group.requested
  )

  /* ------------------------------- turns/budget ----------------------------- */
  const turnStarts = events.filter((event) => event.type === 'turn_start').length
  const turnEnds = events.filter((event) => event.type === 'turn_end')
  const failedEnds = turnEnds.filter((event) => event.ok === false)
  const failedReasons = new Map<string, number>()
  for (const event of failedEnds) {
    const reason = text(event.detail ?? '', 120) || '(sem detalhe)'
    failedReasons.set(reason, (failedReasons.get(reason) ?? 0) + 1)
  }
  const failedTurns = top([...failedReasons.entries()].map(([reason, count]) => ({ reason, count })), (entry) => entry.count)

  const budgetMap = new Map<string, { kind: string; count: number; example: string }>()
  for (const item of items.filter((candidate) => candidate.type === 'budget')) {
    const kind = budgetKindLabel(item.metadata?.kind as string | undefined)
    const group = budgetMap.get(kind) ?? { kind, count: 0, example: '' }
    group.count += Math.max(1, item.count)
    group.example = text(item.detail, 200)
    budgetMap.set(kind, group)
  }
  const budget = [...budgetMap.values()]

  /* --------------------------------- agents -------------------------------- */
  const agentMap = new Map<string, AgentFailureGroup>()
  for (const item of items.filter((candidate) => candidate.type === 'agent' && candidate.severity === 'error')) {
    const label = text(item.title.replace(/:\s*(error|cancelled)$/i, ''), 80) || 'subagente'
    const group = agentMap.get(label.toLowerCase()) ?? { label, count: 0, example: '' }
    group.count += Math.max(1, item.count)
    group.example = text(item.detail, 200)
    agentMap.set(label.toLowerCase(), group)
  }
  const agentFailures = top([...agentMap.values()], (group) => group.count)

  /* ---------------------------------- usage -------------------------------- */
  const usage = input.usage.map((row) => ({ ...row, label: text(row.label, 60), cacheRate: row.input > 0 ? Math.min(1, row.cachedInput / row.input) : 0 }))

  /* --------------------------------- memory -------------------------------- */
  const isLog = (tags: string[]): boolean => LOG_TAGS.some((tag) => tags.includes(tag))
  const staleBefore = input.now - STALE_DAYS * DAY
  const topics = input.memoryPages.filter((page) => !isLog(page.tags) && !page.tags.includes('revisao-melhorias'))
  const stale = topics.filter((page) => {
    const updated = Date.parse(page.updated)
    return Number.isFinite(updated) && updated < staleBefore && page.status !== 'invalidated' && page.status !== 'superseded'
  })
  const byRecent = [...input.memoryPages].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
  const memory: Evidence['memory'] = {
    pages: input.memoryStats?.pages ?? input.memoryPages.length,
    pinned: input.memoryStats?.pinned ?? input.memoryPages.filter((page) => page.pinned).length,
    topics: topics.length,
    turnLogs: input.memoryPages.filter((page) => isLog(page.tags)).length,
    openHandoffs: input.memoryStats?.openHandoffs ?? 0,
    conflicts: input.memoryStats?.conflicts ?? input.memoryPages.filter((page) => page.possibleConflicts?.length).length,
    stale: stale.length,
    recent: byRecent.filter((page) => !isLog(page.tags) && !page.tags.includes('revisao-melhorias')).slice(0, 6).map((page) => ({ slug: page.slug, title: text(page.title, 100), updated: page.updated })),
    reviews: byRecent.filter((page) => page.tags.includes('revisao-melhorias')).slice(0, 5).map((page) => ({ slug: page.slug, title: text(page.title, 100), updated: page.updated }))
  }

  const sum = (rows: Array<{ count: number }>): number => rows.reduce((total, row) => total + row.count, 0)
  return {
    generatedAt: input.now,
    periodDays: input.days,
    since,
    project: { id: input.project.id, name: text(input.project.name, 120) },
    eventsSince: oldestEvent,
    totals: {
      sessions: input.sessions.length,
      activeSessions: input.sessions.filter((session) => session.updatedAt >= since).length,
      turns: Math.max(turnStarts, turnEnds.length),
      failedTurns: failedEnds.length,
      toolCalls: tools.reduce((total, tool) => total + tool.calls, 0),
      failedToolCalls: tools.reduce((total, tool) => total + tool.failures, 0),
      approvalsRequested: requests.reduce((total, request) => total + Math.max(1, request.count), 0),
      approvalsGranted: resolutions.filter((resolution) => resolution.title === 'Aprovação concedida').length,
      approvalsDenied: resolutions.filter((resolution) => resolution.title === 'Aprovação recusada').length,
      limitations: sum(limitations),
      budgetStops: sum(budget),
      agentFailures: sum(agentFailures)
    },
    limitations,
    tools,
    permissions,
    failedTurns,
    budget,
    agentFailures,
    usage,
    memory
  }
}

/** Whether there is anything worth analysing; an empty window must not spend model tokens. */
export function hasSignal(evidence: Evidence): boolean {
  const t = evidence.totals
  return t.turns + t.toolCalls + t.limitations + t.approvalsRequested + t.budgetStops + t.agentFailures > 0
}

const WEIGHT: Record<ImprovementSeverity, number> = { high: 0, medium: 1, low: 2 }

/**
 * Rule-based findings: each one states what was counted and the change that
 * would address it. No model involved, so the review is useful without one and
 * a model can only comment on these facts, not invent others.
 */
export function deriveFindings(evidence: Evidence): ImprovementFinding[] {
  const out: ImprovementFinding[] = []

  for (const group of evidence.limitations) {
    const recurrent = group.count >= 2 || group.sessions.length >= 2
    const severity: ImprovementSeverity = group.blocking && recurrent ? 'high' : group.blocking || recurrent ? 'medium' : 'low'
    out.push({
      id: `limitation:${slug(group.title)}`,
      category: 'limitation',
      severity,
      title: `${recurrent ? 'Limitação recorrente' : 'Limitação registrada'}: ${group.title}`,
      evidence: `${group.count} ocorrência(s) em ${group.sessions.length} sessão(ões), a última em ${day(group.lastAt)}${group.blocking ? '; chegou a bloquear o trabalho' : '; só degradou o resultado'}.${group.detail ? ` Relato: ${group.detail}` : ''}`,
      suggestion: 'Investigar a causa raiz e decidir entre corrigir a ferramenta, ajustar permissões ou instruções do projeto, ou documentar o limite na memória para o agente parar de tentar.'
    })
  }

  for (const tool of evidence.tools) {
    if (tool.calls >= 3 && tool.failures >= 2 && tool.failureRate >= 0.25) {
      out.push({
        id: `tool:${slug(tool.name)}`,
        category: 'tool',
        severity: tool.failureRate >= 0.5 && tool.failures >= 3 ? 'high' : 'medium',
        title: `Ferramenta com muitas falhas: ${tool.name}`,
        evidence: `${tool.failures} falhas em ${tool.calls} chamadas (${pct(tool.failureRate)}) em ${tool.sessions.length} sessão(ões).${tool.errors.length ? ` Erros: ${tool.errors.map((error) => `"${error}"`).join('; ')}` : ''}`,
        suggestion: 'Ler os erros repetidos, corrigir a causa (argumentos, permissão, ambiente) ou melhorar a descrição da ferramenta para o modelo usá-la corretamente.'
      })
    } else if (tool.calls >= 3 && tool.averageMs >= 60_000 && !LONG_BY_NATURE.test(tool.name)) {
      out.push({
        id: `tool-slow:${slug(tool.name)}`,
        category: 'tool',
        severity: 'low',
        title: `Ferramenta lenta: ${tool.name}`,
        evidence: `Média de ${Math.round(tool.averageMs / 1000)}s por chamada (máximo ${Math.round(tool.maxMs / 1000)}s) em ${tool.calls} chamadas.`,
        suggestion: 'Verificar se há timeout, espera por rede ou saída grande; se a lentidão for esperada, ignore este item.'
      })
    }
  }

  for (const group of evidence.permissions) {
    if (group.denied >= 2) {
      out.push({
        id: `permission-denied:${slug(group.title)}`,
        category: 'permission',
        severity: 'medium',
        title: `Aprovações recusadas repetidamente: ${group.title}`,
        evidence: `${group.denied} de ${group.requested} pedidos recusados${group.example ? `; exemplo do pedido: ${group.example}` : ''}.`,
        suggestion: 'O agente continua pedindo algo que você recusa. Registre a preferência na memória do projeto ou restrinja a política/instruções para ele parar de tentar.'
      })
    } else if (group.granted >= 5 && group.denied === 0) {
      out.push({
        id: `permission-granted:${slug(group.title)}`,
        category: 'permission',
        severity: 'low',
        title: `Aprovações sempre concedidas: ${group.title}`,
        evidence: `${group.granted} pedidos concedidos e nenhum recusado${group.example ? `; exemplo: ${group.example}` : ''}.`,
        suggestion: 'Se a ação for de baixo risco, avalie uma regra "sempre permitir" para reduzir interrupções. A decisão é sua; nada foi alterado.'
      })
    }
  }

  const stops = evidence.totals.budgetStops
  if (stops >= 1) {
    out.push({
      id: 'budget:stops',
      category: 'budget',
      severity: stops >= 3 ? 'high' : 'medium',
      title: 'Orçamento do turno esgotado',
      evidence: `${stops} parada(s) por limite${evidence.budget.length ? ` (${evidence.budget.map((entry) => `${entry.kind}: ${entry.count}`).join(', ')})` : ''}.${evidence.budget[0]?.example ? ` Último caso: ${evidence.budget[0].example}` : ''}`,
      suggestion: 'Dividir tarefas grandes em plano + agentes especialistas, ou ajustar os limites em Configurações se o custo for aceitável; verificar se houve laço de ferramentas.'
    })
  }

  if (evidence.totals.failedTurns >= 2 && evidence.totals.turns > 0 && evidence.totals.failedTurns / evidence.totals.turns >= 0.1) {
    out.push({
      id: 'workflow:failed-turns',
      category: 'workflow',
      severity: 'medium',
      title: 'Turnos terminando em erro',
      evidence: `${evidence.totals.failedTurns} de ${evidence.totals.turns} turnos falharam. Causas: ${evidence.failedTurns.map((entry) => `${entry.count}× ${entry.reason}`).join('; ')}`,
      suggestion: 'Tratar a causa mais frequente; se for do provedor (limite, credencial, instabilidade), configurar um modelo reserva.'
    })
  }

  for (const group of evidence.agentFailures) {
    if (group.count < 2) continue
    out.push({
      id: `workflow:agent:${slug(group.label)}`,
      category: 'workflow',
      severity: 'medium',
      title: `Subagente com falhas: ${group.label}`,
      evidence: `${group.count} falhas${group.example ? `; última: ${group.example}` : ''}.`,
      suggestion: 'Rever o prompt e as ferramentas desse agente, ou deixar o agente principal fazer essa parte.'
    })
  }

  for (const row of evidence.usage) {
    if (row.input >= 200_000 && row.calls >= 10 && row.cacheRate < 0.1) {
      out.push({
        id: `cost:cache:${slug(row.providerId)}`,
        category: 'cost',
        severity: 'low',
        title: `Pouco cache de prompt: ${row.label}`,
        evidence: `${Math.round(row.input / 1000)}k tokens de entrada em ${row.calls} chamadas, só ${pct(row.cacheRate)} vindos do cache (custo acumulado US$ ${row.costUsd.toFixed(2)}; uso global do provedor, não só deste projeto).`,
        suggestion: 'Conferir se o provedor/modelo oferece cache de prompt e manter o prefixo do contexto estável; se o provedor não oferece cache, ignore.'
      })
    }
  }

  const memory = evidence.memory
  if (memory.topics === 0 && memory.turnLogs >= 5) {
    out.push({
      id: 'memory:no-topics',
      category: 'memory',
      severity: 'medium',
      title: 'Memória só tem registro de turnos',
      evidence: `${memory.turnLogs} páginas automáticas de turno e nenhuma página de decisão, convenção ou solução.`,
      suggestion: 'Pedir ao agente que registre decisões e convenções com memory_page ao concluir tarefas, para a próxima sessão não redescobrir tudo.'
    })
  }
  if (memory.conflicts >= 1) {
    out.push({
      id: 'memory:conflicts',
      category: 'memory',
      severity: 'medium',
      title: 'Memória com possíveis conflitos',
      evidence: `${memory.conflicts} página(s) apontam conflito com outra.`,
      suggestion: 'Abrir a página, decidir qual vale e marcar a outra como substituída ou inválida.'
    })
  }
  if (memory.openHandoffs >= 3) {
    out.push({
      id: 'memory:handoffs',
      category: 'memory',
      severity: 'low',
      title: 'Handoffs abertos acumulados',
      evidence: `${memory.openHandoffs} handoffs ainda abertos.`,
      suggestion: 'Retomar ou cancelar os handoffs que não valem mais, para o resumo inicial das sessões ficar enxuto.'
    })
  }
  if (memory.stale >= 5) {
    out.push({
      id: 'memory:stale',
      category: 'memory',
      severity: 'low',
      title: 'Páginas de memória antigas',
      evidence: `${memory.stale} páginas de conhecimento sem atualização há mais de ${STALE_DAYS} dias.`,
      suggestion: 'Revisar se ainda são verdade; invalidar o que ficou obsoleto para o agente não seguir informação velha.'
    })
  }

  const seen = new Set<string>()
  return out
    .filter((finding) => (seen.has(finding.id) ? false : (seen.add(finding.id), true)))
    .sort((a, b) => WEIGHT[a.severity] - WEIGHT[b.severity])
    .slice(0, 25)
}
