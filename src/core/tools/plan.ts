import { z } from 'zod'
import type { PlanItem, ToolResult } from '../../shared/types.js'
import type { ToolDef } from './types.js'
import type { AgentDefinition } from '../../shared/types.js'
import { agentLine, formatAgentListing } from '../agents/registry.js'

export const updatePlanTool: ToolDef = {
  name: 'update_plan',
  description:
    'Registra/atualiza o plano de execução visível ao usuário. Use no início de tarefas com mais de 2 passos e sempre que o plano mudar. No máximo um item "active".',
  risk: 'read',
  parallelSafe: false,
  schema: z.object({
    items: z
      .array(
        z.object({
          text: z.string().min(1),
          status: z.enum(['pending', 'active', 'done', 'blocked'])
        })
      )
      .min(1)
      .max(20)
  }),
  describe(a) {
    const args = a as { items?: Array<{ text: string; status: string }> }
    const active = args.items?.find((i) => i.status === 'active')
    return { title: 'Atualizar plano', detail: active?.text ?? `${args.items?.length ?? 0} itens` }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { items: Array<{ text: string; status: PlanItem['status'] }> }
    const items: PlanItem[] = args.items.map((item, index) => ({
      id: `plan_${index}`,
      text: item.text,
      status: item.status
    }))
    ctx.setPlan(items)
    const done = items.filter((i) => i.status === 'done').length
    return {
      ok: true,
      text: `plano atualizado (${done}/${items.length} concluídos)`,
      summary: `${done}/${items.length} concluídos`
    }
  }
}

export const useSkillTool: ToolDef = {
  name: 'use_skill',
  description:
    'Carrega as instruções completas de uma skill disponível. Use somente quando a skill for relevante para a tarefa atual.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({ name: z.string().min(1) }),
  describe(a) {
    const args = a as { name: string }
    return { title: 'Carregar skill', detail: args.name, preview: args.name }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { name: string }
    const content = ctx.services.skills.content(args.name)
    if (!content) {
      const available = ctx.services.skills.list().map((s) => s.name)
      return {
        ok: false,
        text: `skill "${args.name}" não encontrada. Disponíveis: ${available.join(', ') || '(nenhuma)'}`
      }
    }
    const meta = ctx.services.skills.get(args.name)
    return {
      ok: true,
      text: `<skill name="${args.name}" dir="${meta?.dir ?? ''}">\n${content}\n</skill>`,
      summary: `skill ${args.name} carregada`
    }
  }
}

export const listSkillsTool: ToolDef = {
  name: 'list_skills',
  description: 'Lista as skills instaladas (nome, descrição e origem).',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({}),
  describe() {
    return { title: 'Listar skills', detail: 'skills disponíveis' }
  },
  async execute(_raw, ctx) {
    const skills = ctx.services.skills.list()
    if (!skills.length) return { ok: true, text: 'nenhuma skill instalada', summary: '0 skills' }
    return {
      ok: true,
      text: skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`).join('\n'),
      summary: `${skills.length} skills`
    }
  }
}

export const memoryWriteTool: ToolDef = {
  name: 'memory_write',
  description:
    'Salva um fato durável sobre o projeto (decisão, convenção, comando de teste) na memória do projeto. Não salve segredos.',
  risk: 'write',
  parallelSafe: false,
  schema: z.object({
    text: z.string().min(3).max(2000),
    tags: z.array(z.string()).max(6).optional()
  }),
  describe(a) {
    const args = a as { text: string }
    return { title: 'Salvar memória', detail: args.text.slice(0, 100) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { text: string; tags?: string[] }
    const fact = await ctx.services.memory.add(args.text, args.tags ?? [])
    return { ok: true, text: `memória salva (${fact.id})`, summary: 'memória salva' }
  }
}

export const memorySearchTool: ToolDef = {
  name: 'memory_search',
  description: 'Busca fatos e páginas da memória de longo prazo do projeto.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({ query: z.string().min(1) }),
  describe(a) {
    const args = a as { query: string }
    return { title: 'Buscar memória', detail: args.query }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { query: string }
    const [facts, pages] = await Promise.all([
      ctx.services.memory.search(args.query),
      ctx.services.projectMemory.search(args.query)
    ])
    const lines = [
      ...pages.map((page) => `- [${page.slug}] ${page.title}: ${page.snippet}`),
      ...facts.map((fact) => `- ${fact.text}`)
    ]
    return {
      ok: true,
      text: lines.length ? lines.join('\n') : 'nenhum fato ou página encontrado',
      summary: `${pages.length} páginas · ${facts.length} fatos`
    }
  }
}

export const taskTool: ToolDef = {
  name: 'task',
  description:
    'Delega uma subtarefa independente a um subagente genérico com contexto próprio e ferramentas restritas. Use para pesquisa paralela, revisão ou implementação isolada. O retorno é um resumo — inclua no prompt tudo o que o subagente precisa saber. Para agentes especialistas (explorer, coder, tester...) use a ferramenta agent.',
  risk: 'exec',
  parallelSafe: true,
  schema: z.object({
    label: z.string().min(1).max(60).describe('Rótulo curto da subtarefa'),
    prompt: z.string().min(10).describe('Instrução completa e autocontida'),
    tools: z.array(z.string()).optional().describe('Ferramentas permitidas (padrão: leitura + busca + testes)')
  }),
  describe(a) {
    const args = a as { label?: string }
    return { title: 'Subagente', detail: args.label ?? 'delegar', preview: args.label }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { label: string; prompt: string; tools?: string[] }
    // No `agent`: the runtime runs the generic worker with the old semantics.
    const outcome = await ctx.runSubagent({ label: args.label, prompt: args.prompt, tools: args.tools })
    return {
      ok: outcome.ok,
      text: `<subagent label="${args.label}">\n${outcome.text}\n</subagent>`,
      summary: `${args.label}: ${outcome.ok ? 'concluído' : 'falhou'}`,
      data: { childSessionId: outcome.sessionId, usage: outcome.usage }
    }
  }
}

const AGENT_INTRO =
  'Delega uma tarefa a um agente especialista, que roda com contexto, modelo e ferramentas próprios e devolve um relatório curto. O agente NÃO vê esta conversa: no prompt, informe o objetivo, os caminhos relevantes, as restrições e o que ele deve devolver. Para tarefas independentes, chame vários agentes no mesmo turno — eles rodam em paralelo. O parâmetro tools só pode restringir as ferramentas do agente, nunca ampliá-las.'

export const agentTool: ToolDef = {
  name: 'agent',
  description: `${AGENT_INTRO} Chame list_agents para ver quais agentes você pode chamar.`,
  // Delegating adds no privilege: the child inherits the caller's policy (and asks when the caller is not in auto mode).
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    agent: z.string().min(1).describe('Nome do agente a chamar'),
    label: z.string().min(1).max(60).optional().describe('Rótulo curto da tarefa (padrão: o nome do agente)'),
    prompt: z.string().min(10).describe('Instrução completa e autocontida'),
    tools: z.array(z.string()).optional().describe('Restringe as ferramentas do agente (só pode reduzir a lista dele)')
  }),
  dynamicDescription(ctx) {
    const { agents } = ctx
    const callable = agents.callable()
    const where =
      agents.depth >= agents.maxDepth
        ? `Você está no nível máximo de delegação (${agents.depth} de ${agents.maxDepth}): novas chamadas serão recusadas, faça o trabalho você mesmo.`
        : `Você está no nível ${agents.depth} de ${agents.maxDepth} de delegação.`
    return `${AGENT_INTRO}\n\nAgentes que você pode chamar:\n${formatAgentListing(callable)}\n\n${where}`
  },
  describe(a) {
    const args = a as { agent?: string; label?: string }
    const name = args.agent ?? ''
    const label = args.label ?? name
    return { title: `Agente ${name}`.trim(), detail: label || 'delegar', preview: `${name} ${label}`.trim() }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { agent: string; label?: string; prompt: string; tools?: string[] }
    const label = args.label ?? args.agent
    const outcome = await ctx.runSubagent({ agent: args.agent, label, prompt: args.prompt, tools: args.tools })
    // Nothing ran (unknown agent, limit reached...): hand the reason back as a plain tool error.
    if (!outcome.sessionId) return { ok: false, text: outcome.text, summary: `${label}: recusado` }
    return {
      ok: outcome.ok,
      text: `<agent name="${args.agent}" label="${label}">\n${outcome.text}\n</agent>`,
      summary: `${label}: ${outcome.ok ? 'concluído' : 'falhou'}`,
      data: { childSessionId: outcome.sessionId, agent: args.agent, usage: outcome.usage }
    }
  }
}

function canCallText(agent: AgentDefinition): string {
  if (agent.canCall === '*') return 'qualquer agente'
  return agent.canCall?.length ? agent.canCall.join(', ') : 'nenhum'
}

export const listAgentsTool: ToolDef = {
  name: 'list_agents',
  description: 'Lista os agentes que você pode chamar com a ferramenta agent (nome, descrição e quais agentes cada um pode chamar).',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({}),
  describe() {
    return { title: 'Listar agentes', detail: 'agentes disponíveis' }
  },
  async execute(_raw, ctx): Promise<ToolResult> {
    const agents = ctx.agents.callable()
    if (!agents.length) return { ok: true, text: 'nenhum agente disponível para você chamar', summary: '0 agentes' }
    const header = `Você está no nível ${ctx.agents.depth} de ${ctx.agents.maxDepth} de delegação.`
    return {
      ok: true,
      text: [header, ...agents.map((a) => `${agentLine(a, 400)} (pode chamar: ${canCallText(a)})`)].join('\n'),
      summary: `${agents.length} agentes`,
      data: { agents: agents.map((a) => ({ name: a.name, description: a.description, canCall: a.canCall ?? [], mode: a.mode ?? 'code' })) }
    }
  }
}

export const planTools: ToolDef[] = [
  updatePlanTool,
  useSkillTool,
  listSkillsTool,
  memoryWriteTool,
  memorySearchTool,
  taskTool,
  agentTool,
  listAgentsTool
]
