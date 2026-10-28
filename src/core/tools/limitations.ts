import { z } from 'zod'
import type { ToolDef } from './types.js'

const limitationSchema = z.object({
  title: z
    .string()
    .min(3)
    .max(120)
    .describe('Resumo curto e específico'),
  goal: z.string().min(3).max(600).describe('O que você tentava fazer'),
  error: z.string().min(3).max(1500).describe('Erro exato ou o que você viu'),
  difficulty: z.string().min(3).max(800).describe('Por que isso impediu a tarefa; o que faltou no harness'),
  suggestion: z.string().min(3).max(800).describe('O que o harness deveria fazer para resolver'),
  workaround: z.string().max(600).optional().describe('O que você fez no lugar, se conseguiu seguir'),
  attempts: z
    .array(z.string().max(400))
    .max(12)
    .optional()
    .describe('O que você tentou antes de travar, com o resultado de cada ação'),
  severity: z
    .enum(['blocked', 'degraded'])
    .optional()
    .describe('blocked = não concluiu; degraded = concluiu com contorno'),
})

export type LimitationReport = z.infer<typeof limitationSchema>

/**
 * The agent's channel to report a real harness limitation. The user sees a
 * card with what was attempted, the exact error, the difficulty and a
 * suggested fix, so the harness can be improved from real failures instead of
 * guesses. Core tool: it must work even when discovery is unavailable.
 */
export const reportLimitationTool: ToolDef = {
  name: 'report_limitation',
  description:
    'Registra uma limitação real do harness que impediu ou atrapalhou a tarefa: ferramenta que falha sem contorno, capacidade ausente ' +
    '(visão, acessibilidade, permissão, API) ou necessidade de um script externo para o que o harness deveria fazer. ' +
    'O usuário vê um card com o erro e a solução sugerida. Não use para erros comuns que você já resolveu nem para pedir confirmação.',
  risk: 'read',
  parallelSafe: true,
  schema: limitationSchema,
  describe(raw) {
    const args = raw as { title?: string; severity?: string }
    return {
      title: 'Limitação do harness',
      detail: args.title ?? 'registrar bloqueio',
      preview: args.severity === 'degraded' ? 'com contorno' : 'bloqueado'
    }
  },
  async execute(raw) {
    const args = this.schema.parse(raw) as LimitationReport
    const severity = args.severity ?? 'blocked'
    const lines = [
      `Limitação registrada: ${args.title}`,
      `Objetivo: ${args.goal}`,
      `Erro observado: ${args.error}`,
      `Dificuldade: ${args.difficulty}`,
      ...(args.attempts?.length ? ['Tentativas:', ...args.attempts.map((attempt) => `- ${attempt}`)] : []),
      ...(args.workaround ? [`Contorno: ${args.workaround}`] : []),
      `Solução sugerida: ${args.suggestion}`,
      `Severidade: ${severity}`
    ]
    return {
      ok: true,
      summary: args.title,
      text: lines.join('\n'),
      data: { limitation: { ...args, severity } }
    }
  }
}

export const limitationTools: ToolDef[] = [reportLimitationTool]
