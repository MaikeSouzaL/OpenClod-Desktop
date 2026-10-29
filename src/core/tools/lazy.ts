import { z } from 'zod'
import type { ToolDef } from './types.js'

/**
 * Tools that stay in every request. Everything else is discovered with
 * `tool_search` and enabled with `tool_load`, so a session with browser,
 * computer, git, media and hundreds of MCP tools does not pay for all their
 * schemas on every model call.
 *
 * Every tool here costs its schema on EVERY request of EVERY session (about 4 500 tokens for the set; it was 6 000 with
 * 31 tools), so a tool earns its place by being used in most sessions. Left out on purpose, with what replaces them (all
 * nine are DEFERRED_ESSENTIAL_TOOL_NAMES: calling one by name loads it):
 *   memory_brief, memory_search   the harness puts the map and the pages that match the request in the turn context
 *   memory_handoff                the app writes the continuity capsule after every turn
 *   list_skills                   the system prompt has the skill index and the harness suggests the ones that fit
 *   mcp_servers, mcp_catalog, mcp_call   MCP tools are first-class (`mcp__server__tool`); these are the diagnostic and fallback paths
 *   list_agents, task             team mode only (TEAM_CORE_TOOL_NAMES); otherwise `agent` is enough
 * `report_limitation` and `ask_user` stay: they must work when discovery itself is what failed.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'patch_file',
  'list_dir',
  'grep',
  'glob',
  'run_command',
  'fetch_url',
  'web_search',
  'update_plan',
  'report_limitation',
  'ask_user',
  'use_skill',
  'memory_page',
  'memory_recall',
  'memory_write',
  'computer_open_path',
  'agent',
  'tool_search',
  'tool_list',
  'tool_load'
])

/** Core only in team mode (max effort or the "separate into agents" toggle), where delegating is the point of the session. */
export const TEAM_CORE_TOOL_NAMES: ReadonlySet<string> = new Set(['list_agents', 'task'])

/**
 * Tools that used to be sent in every request and now wait for `tool_load`. A child agent is built from what its caller can
 * use, so these stay in that pool (the child loads them itself); without them a specialist whose definition names
 * `memory_search` or `list_skills` would lose them just because its caller had not loaded them.
 * They are also loaded by a direct call: the model that names one of them gets it run (and kept for the session) instead
 * of a refusal, which cost a model call and sent some models off to improvise.
 */
export const DEFERRED_ESSENTIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'memory_brief',
  'memory_search',
  'memory_handoff',
  'list_skills',
  'mcp_servers',
  'mcp_catalog',
  'mcp_call',
  'list_agents',
  'task',
  // Codex/GPT models write this one on their own: calling it by name loads it.
  'apply_patch'
])

export const toolSearchTool: ToolDef = {
  name: 'tool_search',
  description:
    'Procura ferramentas que não estão no contexto atual (navegador, Computer Use, Git, documentos, imagens, MCPs instalados, agentes externos etc.). ' +
    'Retorna nome, risco e descrição; use tool_load para habilitar as escolhidas antes de chamá-las.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    query: z.string().max(200).optional().describe('Texto para filtrar por nome ou descrição'),
    limit: z.number().int().min(1).max(50).optional().describe('Máximo de resultados (padrão 30)')
  }),
  describe(raw) {
    const args = raw as { query?: string }
    return { title: 'Buscar ferramentas', detail: args.query ?? 'catálogo', preview: args.query }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { query?: string; limit?: number }
    const hits = ctx.searchTools?.(args.query ?? '', args.limit ?? 30) ?? []
    if (!hits.length) {
      return {
        ok: true,
        text: args.query
          ? `nenhuma ferramenta fora do contexto corresponde a "${args.query}"`
          : 'todas as ferramentas disponíveis já estão no contexto',
        summary: '0 ferramentas'
      }
    }
    return {
      ok: true,
      text: [
        ...hits.map(
          (hit) =>
            `- ${hit.name} [${hit.risk}${hit.requires ? `/${hit.requires}` : ''}]: ${hit.description.replace(/\s+/g, ' ').slice(0, 240)}`
        ),
        '',
        'Use tool_load({ tools: ["nome", ...] }) para habilitar antes de chamar.'
      ].join('\n'),
      summary: `${hits.length} ferramenta(s)`
    }
  }
}

export const toolListTool: ToolDef = {
  name: 'tool_list',
  description:
    'Lista o catálogo completo de ferramentas permitidas neste modo, com nome, risco e se já está carregada. Use quando tool_search não encontrar um nome que você sabe que existe.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    limit: z.number().int().min(1).max(300).optional().describe('Máximo de nomes (padrão 200)')
  }),
  describe() {
    return { title: 'Listar ferramentas', detail: 'catálogo completo' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { limit?: number }
    const hits = ctx.listTools?.() ?? []
    const limited = hits.slice(0, args.limit ?? 200)
    if (!limited.length) return { ok: true, text: 'nenhuma ferramenta permitida neste modo', summary: '0 ferramentas' }
    return {
      ok: true,
      text: limited
        .map(
          (hit) =>
            `- ${hit.name}${hit.loaded ? ' (carregada)' : ''} [${hit.risk}${hit.requires ? `/${hit.requires}` : ''}]: ${hit.description.replace(/\s+/g, ' ').slice(0, 180)}`
        )
        .join('\n'),
      summary: `${limited.length} ferramentas`,
      data: { tools: limited.map((hit) => hit.name) }
    }
  }
}

export const toolLoadTool: ToolDef = {
  name: 'tool_load',
  description:
    'Habilita ferramentas para os próximos passos deste turno. Use tool_search primeiro para descobrir os nomes exatos. ' +
    'Para um servidor MCP inteiro use o curinga (ex.: "mcp__jira__*"). Ferramentas já essenciais não precisam ser carregadas.',
  risk: 'read',
  parallelSafe: false,
  schema: z.object({
    tools: z.array(z.string().min(1).max(120)).min(1).max(20).describe('Nomes exatos retornados por tool_search')
  }),
  describe(raw) {
    const args = raw as { tools?: string[] }
    return { title: 'Carregar ferramentas', detail: (args.tools ?? []).join(', ').slice(0, 200) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { tools: string[] }
    const result = ctx.loadTools?.(args.tools) ?? {
      loaded: [],
      rejected: args.tools.map((name) => ({ name, reason: 'carregamento sob demanda indisponível' }))
    }
    const lines: string[] = []
    if (result.loaded.length) lines.push(`habilitadas: ${result.loaded.join(', ')}`)
    if (result.rejected.length) {
      lines.push(
        `recusadas: ${result.rejected.map((item) => `${item.name} (${item.reason})`).join(', ')}`
      )
    }
    return {
      ok: result.loaded.length > 0,
      text: lines.join('\n') || 'nenhuma ferramenta foi habilitada',
      summary: `${result.loaded.length} carregada(s)`,
      data: result
    }
  }
}

export const lazyTools: ToolDef[] = [toolSearchTool, toolListTool, toolLoadTool]
