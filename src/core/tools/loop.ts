import { z } from 'zod'
import type { LoopState, ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import { runCommandTool } from './shell.js'
import { evaluateTool } from '../security/permissions.js'
import { applyChecks, defineCriteria, isCodePath, LOOP_JUDGE_AGENT, LOOP_TESTER_AGENT, openCriteria, recordVerdict, type CheckResult } from '../loop/engine.js'

/** One check command may run this long (a whole test suite or a build fits; a server that never exits does not). */
export const LOOP_CHECK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Runs the command of every criterion that has one, through the same policy as run_command: the rules, the credential
 * block and the approval of the permission mode decide each command, and run_command's own guard refuses destructive ones.
 */
export async function runLoopChecks(state: LoopState, ctx: ToolContext): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const criterion of state.criteria) {
    if (!criterion.check || ctx.signal.aborted) continue
    const command = criterion.check
    const evaluation = evaluateTool(runCommandTool, command, ctx.policy, ctx.cwd, { command })
    if (evaluation.decision === 'deny') {
      results.push({ id: criterion.id, ok: false, evidence: `negado pela política: ${evaluation.reason}` })
      continue
    }
    if (evaluation.decision === 'ask') {
      const approved = await ctx.approve({
        tool: 'run_command',
        title: `Checagem do loop (${criterion.id})`,
        detail: command,
        risk: evaluation.risk ?? 'exec',
        preview: command,
        action: evaluation.action,
        resource: evaluation.resource,
        effect: evaluation.effect
      })
      if (!approved) {
        results.push({ id: criterion.id, ok: false, evidence: 'o usuário não aprovou rodar este comando' })
        continue
      }
    }
    ctx.progress?.(`${criterion.id}: ${command}`)
    const result = await runCommandTool.execute({ command, timeout_ms: LOOP_CHECK_TIMEOUT_MS }, ctx)
    results.push({ id: criterion.id, ok: result.ok, evidence: result.text })
  }
  return results
}

function statusText(state: LoopState): string {
  const lines = [
    `Loop: volta ${state.round} de ${state.maxRounds} · fase ${state.phase} · ${state.status}`,
    ...state.criteria.map((criterion) => {
      const mark = criterion.status === 'met' ? 'OK' : criterion.status === 'failed' ? 'FALHOU' : 'pendente'
      return `- ${criterion.id} [${mark}] ${criterion.text}${criterion.check ? ` (check: ${criterion.check})` : ' (sem comando: precisa de prova do juiz)'}`
    })
  ]
  if (!state.criteria.length) lines.push('(nenhum critério definido: use action=define)')
  return lines.join('\n')
}

function checkReport(state: LoopState, results: CheckResult[]): string {
  const lines = results.map((result) => {
    const criterion = state.criteria.find((item) => item.id === result.id)
    const tail = result.evidence.trim().split(/\r?\n/).slice(-25).join('\n')
    return `## ${result.id} ${result.ok ? 'PASSOU' : 'FALHOU'}: ${criterion?.text ?? ''}\n${tail}`
  })
  const manual = state.criteria.filter((criterion) => !criterion.check)
  if (manual.length) {
    lines.push(`Sem comando (o juiz precisa provar): ${manual.map((criterion) => `${criterion.id} ${criterion.text}`).join('; ')}`)
  }
  if (!results.length && !manual.length) lines.push('Nenhum critério definido.')
  return lines.join('\n\n')
}

export const loopTool: ToolDef = {
  name: 'loop',
  description:
    'Controle do modo Loop Engineering (só o maestro da sessão). action=define registra os critérios de pronto (com `check`: o comando que o harness roda para provar o critério, exit 0 = cumprido); ' +
    'action=check roda os comandos dos critérios agora; action=verdict registra o parecer da volta (done/continue/blocked) — done roda os checks de novo e só é aceito com o juiz ' +
    `(${LOOP_JUDGE_AGENT}) chamado nesta volta, o ${LOOP_TESTER_AGENT} chamado no loop quando o código mudou e tudo provado; action=status mostra o estado.`,
  risk: 'read',
  parallelSafe: false,
  // Checks run test suites and builds with their own timeout.
  idleLimitMs: null,
  schema: z.object({
    action: z.enum(['define', 'check', 'verdict', 'status']),
    goal: z.string().max(2_000).optional().describe('define: o objetivo em uma frase (padrão: o pedido do usuário)'),
    criteria: z
      .array(
        z.object({
          text: z.string().min(3).max(400).describe('O que precisa ser verdade quando estiver pronto'),
          check: z.string().max(1_000).optional().describe('Comando que prova o critério (testes, typecheck, build, script); exit 0 = cumprido')
        })
      )
      .max(12)
      .optional()
      .describe('define: os critérios de pronto'),
    max_rounds: z.number().int().min(1).max(30).optional().describe('define: voltas pedidas pelo usuário (padrão: o das configurações)'),
    max_minutes: z.number().int().min(5).max(480).optional().describe('define: minutos pedidos pelo usuário'),
    decision: z.enum(['done', 'continue', 'blocked']).optional().describe('verdict: o parecer do juiz'),
    summary: z.string().max(1_000).optional().describe('verdict: o parecer em uma ou duas frases'),
    missing: z.array(z.string().max(300)).max(12).optional().describe('verdict: o que falta (continue) ou a pergunta ao usuário (blocked)'),
    evidence: z
      .array(z.object({ id: z.string(), met: z.boolean(), proof: z.string().max(1_500).optional() }))
      .max(12)
      .optional()
      .describe('verdict: para critérios sem comando, se foram cumpridos e a prova que o juiz viu')
  }),
  describe(a) {
    const args = a as { action?: string; decision?: string; criteria?: unknown[] }
    const detail =
      args.action === 'define'
        ? `${args.criteria?.length ?? 0} critério(s) de pronto`
        : args.action === 'verdict'
          ? `veredito: ${args.decision ?? '?'}`
          : args.action === 'check'
            ? 'rodar as checagens'
            : 'estado'
    return { title: 'Loop', detail, preview: `loop ${args.action ?? ''}`.trim() }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      action: 'define' | 'check' | 'verdict' | 'status'
      goal?: string
      criteria?: Array<{ text: string; check?: string }>
      max_rounds?: number
      max_minutes?: number
      decision?: 'done' | 'continue' | 'blocked'
      summary?: string
      missing?: string[]
      evidence?: Array<{ id: string; met: boolean; proof?: string }>
    }
    const state = ctx.loop?.get()
    if (!ctx.loop || !state) {
      return { ok: false, text: 'a ferramenta loop só existe para o maestro de uma sessão no modo Código Loop Engineering' }
    }

    if (args.action === 'status') return { ok: true, text: statusText(state), summary: `volta ${state.round}/${state.maxRounds}` }

    if (args.action === 'define') {
      if (!args.criteria?.length) return { ok: false, text: 'informe ao menos um critério em `criteria` (de preferência com `check`)' }
      const next = defineCriteria(state, args.criteria, {
        goal: args.goal,
        budget: { rounds: args.max_rounds, minutes: args.max_minutes },
        now: Date.now()
      })
      ctx.loop.set(next)
      const commands = next.criteria.filter((criterion) => criterion.check).length
      return {
        ok: true,
        text: `${statusText(next)}\n\n${commands ? '' : 'Atenção: nenhum critério tem comando; cada um vai precisar de uma prova citada pelo juiz.\n'}Agora planeje e trabalhe na volta ${next.round}.`,
        summary: `${next.criteria.length} critério(s), ${commands} com comando`
      }
    }

    if (args.action === 'check') {
      const results = await runLoopChecks(state, ctx)
      const next = applyChecks(ctx.loop.get() ?? state, results, Date.now())
      ctx.loop.set(next)
      const passed = results.filter((result) => result.ok).length
      return {
        ok: true,
        text: checkReport(next, results),
        summary: results.length ? `${passed}/${results.length} checagens passaram` : 'nenhum critério com comando'
      }
    }

    // verdict
    if (!args.decision || !args.summary?.trim()) {
      return { ok: false, text: 'verdict precisa de `decision` (done, continue ou blocked) e `summary`' }
    }
    let current = state
    let report = ''
    if (args.decision === 'done') {
      // "Done" is proven by the harness, not by the conductor's word: every command runs again right now.
      const results = await runLoopChecks(current, ctx)
      current = applyChecks(ctx.loop.get() ?? current, results, Date.now())
      if (results.length) report = `\n\n${checkReport(current, results)}`
    }
    // Code written in this turn (by the conductor or a specialist) must have been tested by the tester, not only by its author.
    const codeChanged = (ctx.tracker.turnChanges?.() ?? []).some((change) => isCodePath(change.path))
    const outcome = recordVerdict(
      current,
      { decision: args.decision, summary: args.summary, missing: args.missing, evidence: args.evidence, codeChanged },
      Date.now()
    )
    ctx.loop.set(outcome.state)
    const open = openCriteria(outcome.state).length
    return {
      ok: outcome.accepted,
      text: `${outcome.message}${report}`,
      summary: outcome.accepted ? `veredito ${args.decision}` : `PRONTO recusado (${open} critério(s) em aberto)`
    }
  }
}

export const loopTools: ToolDef[] = [loopTool]
