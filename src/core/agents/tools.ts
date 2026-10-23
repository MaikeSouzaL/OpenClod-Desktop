import { z } from 'zod'
import type { ToolDef } from '../tools/types.js'
import type { ToolResult } from '../../shared/types.js'

/**
 * The Agent Smith tool: writes a new specialist to the user's agents folder,
 * then registers it in the live registry so the current session can call it on
 * the very next step. It is the only way an agent can grow the roster.
 */
export const createAgentTool: ToolDef = {
  name: 'create_agent',
  description:
    'Cria um agente especialista permanente (arquivo markdown em <userData>/agents) e o registra agora. Use somente quando nenhum agente existente cobrir o assunto. Depois chame o agente criado com `agent`. Escreva um system prompt específico, com método, ferramentas e critério de pronto.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    name: z
      .string()
      .min(2)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
      .describe('Nome kebab-case, ex.: kubernetes-specialist'),
    description: z.string().min(10).max(600).describe('Quando usar este agente (o modelo lê isto para escolher)'),
    system_prompt: z.string().min(20).max(20_000).describe('Prompt completo do especialista'),
    tools: z.array(z.string()).max(40).optional().describe('Ferramentas permitidas (globs como browser_* são aceitos)'),
    can_call: z
      .union([z.literal('*'), z.array(z.string()).max(40)])
      .optional()
      .describe('Agentes que este especialista pode chamar; omita para nenhum'),
    mode: z.enum(['ask', 'plan', 'code', 'debug', 'review', 'computer', 'web', 'autonomous']).optional(),
    model: z.string().max(200).optional().describe('inherit (padrão) ou providerId/modelo'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    max_turns: z.number().int().min(1).max(200).optional(),
    scope: z.enum(['user', 'project']).optional().describe('user (padrão) grava em <userData>/agents; project em .forja/agents')
  }),
  describe(a) {
    const args = a as { name?: string }
    return { title: 'Criar agente', detail: args.name ?? '', preview: args.name }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      name: string
      description: string
      system_prompt: string
      tools?: string[]
      can_call?: string[] | '*'
      mode?: 'ask' | 'plan' | 'code' | 'debug' | 'review' | 'computer' | 'web' | 'autonomous'
      model?: string
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      max_turns?: number
      scope?: 'user' | 'project'
    }
    const result = await ctx.createAgent({
      name: args.name,
      description: args.description,
      systemPrompt: args.system_prompt,
      tools: args.tools,
      canCall: args.can_call,
      mode: args.mode,
      model: args.model,
      effort: args.effort,
      maxTurns: args.max_turns,
      scope: args.scope
    })
    ctx.log('info', `agente ${result.agent.name} criado em ${result.path}`)
    return {
      ok: true,
      text: `agente "${result.agent.name}" criado em ${result.path} e registrado. Agora chame-o com agent(agent="${result.agent.name}", prompt="...").`,
      summary: `agente ${result.agent.name}`,
      data: { path: result.path, name: result.agent.name }
    }
  }
}

export const agentForgeTools: ToolDef[] = [createAgentTool]
