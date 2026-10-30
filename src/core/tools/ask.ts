import { z } from 'zod'
import type { QuestionAnswer, QuestionSpec } from '../../shared/types.js'
import type { ToolDef } from './types.js'

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe('Texto curto da opção'),
  description: z.string().max(300).optional().describe('Uma frase explicando o efeito da opção'),
})

const questionSchema = z.object({
  header: z.string().min(1).max(40).describe('Rótulo curto, ex.: "Backend" ou "Prazo"'),
  question: z.string().min(3).max(600).describe('A pergunta em si, objetiva'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(8)
    .optional()
    .describe('Opções concretas para escolher; sem opções o usuário responde em texto'),
  multi: z.boolean().optional().describe('true = pode marcar mais de uma opção'),
  allow_other: z.boolean().optional().describe('Permite resposta livre além das opções (padrão true)'),
})

const askSchema = z.object({
  questions: z.array(questionSchema).min(1).max(6).describe('Uma a seis perguntas; prefira 1 a 4'),
})

/** Normalizes what the model sent before it reaches the UI. */
function normalize(questions: z.infer<typeof questionSchema>[]): QuestionSpec[] {
  return questions.map((question) => ({
    header: question.header.replace(/\s+/g, ' ').trim(),
    question: question.question.trim(),
    ...(question.options
      ? {
          options: question.options.map((option) => ({
            label: option.label.trim(),
            ...(option.description ? { description: option.description.trim() } : {}),
          })),
        }
      : {}),
    ...(question.multi ? { multi: true } : {}),
    ...(question.allow_other === false ? { allowOther: false } : {}),
  }))
}

/**
 * Structured questions with selectable options. This is the "grill me" step:
 * the turn pauses until the user answers, so the agent does not guess when the
 * missing detail changes the solution.
 */
export const askUserTool: ToolDef = {
  name: 'ask_user',
  // Waits for the user's answer, however long it takes: not a stuck call.
  idleLimitMs: null,
  description:
    'Faz de 1 a 6 perguntas ao usuário e pausa até ele responder. Use quando faltar contexto que muda a solução ' +
    '(preferência, escopo, escolha de caminho, credencial, formato de entrega) em vez de adivinhar. Cada pergunta ' +
    'pode ter de 2 a 8 opções; o usuário também pode escrever uma resposta livre. Não use para confirmar ação ' +
    'sensível (isso é a aprovação normal) nem para algo que você consegue descobrir lendo o projeto.',
  risk: 'read',
  parallelSafe: false,
  schema: askSchema,
  describe(raw) {
    const args = raw as { questions?: unknown[] }
    const count = Array.isArray(args.questions) ? args.questions.length : 0
    return {
      title: 'Perguntas ao usuário',
      detail: count ? `${count} pergunta${count > 1 ? 's' : ''}` : 'aguardando resposta',
      preview: 'precisa de contexto',
    }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as z.infer<typeof askSchema>
    const questions = normalize(args.questions)
    if (!ctx.ask) {
      return {
        ok: false,
        text: 'perguntas ao usuário não estão disponíveis nesta sessão (subagente ou execução isolada)',
        summary: 'sem canal de perguntas',
      }
    }
    const answers = await ctx.ask({ questions })
    if (answers === null) {
      return {
        ok: false,
        text: 'o usuário não respondeu: tempo esgotado ou turno cancelado. Não invente a resposta; diga que ficou pendente.',
        summary: 'sem resposta',
      }
    }
    if (!answers.length) {
      return {
        ok: true,
        text: 'O usuário optou por não responder. Siga com a suposição mais segura e explique qual foi.',
        summary: 'perguntas puladas',
        data: { answers: [] as QuestionAnswer[] },
      }
    }
    const lines = ['O usuário respondeu:']
    answers.forEach((answer, index) => {
      lines.push(`${index + 1}. ${answer.header}`)
      lines.push(`   Resposta: ${answer.answers.length ? answer.answers.join('; ') : '(sem resposta)'}`)
      if (answer.attachments?.length) {
        lines.push('   Anexos:')
        for (const attachment of answer.attachments) {
          lines.push(
            `   - ${attachment.kind === 'folder' ? 'pasta' : 'arquivo'} "${attachment.name}": \`${attachment.path}\``
          )
        }
        lines.push('   (estude os anexos sob demanda com read_file, OCR/PDF e as ferramentas de shell; eles podem estar fora do projeto)')
      }
    })
    const filled = answers.filter((answer) => answer.answers.length || answer.attachments?.length).length
    return {
      ok: true,
      summary: `respostas: ${filled}/${answers.length}`,
      text: lines.join('\n'),
      data: { answers },
    }
  },
}

export const askTools: ToolDef[] = [askUserTool]
