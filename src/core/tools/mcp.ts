import { z } from 'zod'
import type { ToolContext, ToolDef, McpSearchHit } from './types.js'

function service(ctx: ToolContext): NonNullable<ToolContext['services']['mcp']> | null {
  return ctx.services.mcp ?? null
}

function describeHit(hit: McpSearchHit): string {
  const tags = [hit.transport, hit.installed ? 'já instalado' : '', hit.needs.length ? `precisa: ${hit.needs.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ')
  return `- ${hit.id} — ${hit.name} (${tags})\n  ${hit.description.slice(0, 240)}`
}

export const mcpSearchTool: ToolDef = {
  name: 'mcp_search',
  description:
    'Procura MCPs para uma integração (Jira, GitHub, banco, navegador, documentos...). Consulta o catálogo curado e o registro oficial MCP; retorna ids instaláveis, transporte e credenciais necessárias. Use antes de mcp_install.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({
    query: z.string().min(2).describe('O que você precisa, ex.: "jira", "postgres", "planilha excel"'),
    limit: z.number().int().min(1).max(20).optional()
  }),
  describe(a) {
    const args = a as { query?: string }
    return { title: 'Procurar MCP', detail: args.query ?? '', preview: args.query }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { query: string; limit?: number }
    const mcp = service(ctx)
    if (!mcp) return { ok: false, text: 'auto-instalação de MCP indisponível nesta sessão' }
    const result = await mcp.search(args.query, args.limit ?? 8)
    const lines: string[] = []
    if (result.catalog.length) {
      lines.push('<catalog>', ...result.catalog.map(describeHit), '</catalog>')
    }
    if (result.registry.length) {
      lines.push('<registry>', ...result.registry.map(describeHit), '</registry>')
    }
    if (!result.catalog.length && !result.registry.length) {
      lines.push(`nenhum MCP encontrado para "${args.query}". Tente outro termo ou instale um servidor customizado com mcp_install({command,args}).`)
    }
    if (result.installed.length) lines.push(`já instalados: ${result.installed.join(', ')}`)
    if (result.warning) lines.push(`aviso: ${result.warning}`)
    lines.push('Para instalar: mcp_install({ id: "<id>", env: { ... } }). Nunca invente credenciais; peça ao usuário as que faltarem.')
    return {
      ok: true,
      text: lines.join('\n'),
      summary: `${result.catalog.length + result.registry.length} MCPs`,
      data: { catalog: result.catalog.map((hit) => hit.id), registry: result.registry.map((hit) => hit.id) }
    }
  }
}

export const mcpInstallTool: ToolDef = {
  name: 'mcp_install',
  description:
    'Instala um MCP na configuração do Openclod, reinicia os servidores e devolve as ferramentas que ficaram disponíveis. Aceita um id do catálogo/registro (ex.: "jira", "atlassian", "com.atlassian/atlassian-mcp-server") ou um servidor customizado com command/args ou url. Se faltar credencial, retorna exatamente o que pedir ao usuário.',
  // Installing code and granting an external integration is always approved.
  risk: 'destructive',
  parallelSafe: false,
  requires: 'network',
  schema: z
    .object({
      id: z.string().min(2).optional().describe('Id do catálogo ou nome do registro MCP'),
      name: z.string().min(1).max(60).optional().describe('Nome local do servidor (opcional)'),
      env: z.record(z.string()).optional().describe('Variáveis de ambiente exigidas pelo servidor'),
      headers: z.record(z.string()).optional().describe('Headers do servidor remoto (Authorization etc.)'),
      url: z.string().url().optional().describe('Para um servidor remoto fora do catálogo'),
      command: z.string().min(1).optional().describe('Para um servidor stdio fora do catálogo'),
      args: z.array(z.string()).max(30).optional()
    })
    .refine((value) => Boolean(value.id || value.url || value.command), {
      message: 'informe id, url ou command'
    }),
  describe(a) {
    const args = a as { id?: string; url?: string; command?: string }
    return {
      title: 'Instalar MCP',
      detail: args.id ?? args.url ?? args.command ?? '',
      preview: args.id ?? args.url ?? args.command
    }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      id?: string
      name?: string
      env?: Record<string, string>
      headers?: Record<string, string>
      url?: string
      command?: string
      args?: string[]
    }
    const mcp = service(ctx)
    if (!mcp) return { ok: false, text: 'auto-instalação de MCP indisponível nesta sessão' }

    const custom = !args.id && (args.url || args.command)
    const id = args.id ?? args.url ?? args.command ?? ''
    const result = custom
      ? await mcp.install({
          id: '__custom__',
          name: args.name,
          env: args.env,
          headers: args.headers,
          url: args.url,
          command: args.command,
          args: args.args
        })
      : await mcp.install({ id, env: args.env, headers: args.headers, name: args.name })
    if (result.needsOAuth) {
      return {
        ok: true,
        text: [
          `MCP "${result.name ?? id}" configurado. O servidor usa OAuth; o primeiro uso abre o login no navegador padrão e retoma automaticamente após o callback em 127.0.0.1.`,
          result.state === 'ready'
            ? `${result.tools?.length ?? 0} ferramenta(s) disponíveis.`
            : 'A conexão será concluída depois que o usuário autorizar o provedor.'
        ].join('\n'),
        summary: 'OAuth configurado',
        data: { name: result.name, state: result.state, oauth: true }
      }
    }
    if (result.missing?.length) {
      return {
        ok: false,
        text: `faltam credenciais para "${id}": ${result.missing.join(', ')}. Peça esses valores ao usuário e chame mcp_install de novo com env/headers. Nada foi salvo.`,
        summary: `faltam ${result.missing.length} credenciais`
      }
    }
    if (!result.ok) {
      return { ok: false, text: result.error ?? `não foi possível instalar "${id}"`, summary: 'falhou' }
    }
    const tools = result.tools ?? []
    // OAuth may be completed asynchronously by the provider after the server has been saved.
    const connected = result.state === 'ready' || Boolean(result.needsOAuth)
    return {
      ok: connected,
      text: [
        `MCP "${result.name ?? id}" salvo e ${connected ? 'conectado' : 'configurado (conexão falhou)'}.`,
        connected
          ? `${tools.length} ferramentas disponíveis agora: ${tools.slice(0, 20).join(', ')}${tools.length > 20 ? '…' : ''}`
          : `Erro de conexão: ${result.error ?? 'desconhecido'}. Verifique credenciais/rede e use mcp_servers para ver o estado.`,
        connected ? 'As ferramentas mcp__* já entram no próximo passo deste turno.' : ''
      ]
        .filter(Boolean)
        .join('\n'),
      summary: connected ? `${result.name} · ${tools.length} ferramentas` : `${result.name} · falhou`,
      data: { name: result.name, tools, state: result.state }
    }
  }
}

export const mcpServersTool: ToolDef = {
  name: 'mcp_servers',
  description: 'Lista os servidores MCP configurados, o estado da conexão e as ferramentas de cada um.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({}),
  describe() {
    return { title: 'Servidores MCP', detail: 'configurados' }
  },
  async execute(_raw, ctx) {
    const mcp = service(ctx)
    if (!mcp) return { ok: false, text: 'serviço de MCP indisponível nesta sessão' }
    const servers = mcp.list()
    if (!servers.length) return { ok: true, text: 'nenhum MCP configurado; use mcp_search e mcp_install', summary: '0 MCPs' }
    return {
      ok: true,
      text: servers
        .map(
          (server) =>
            `${server.state === 'ready' ? '●' : '○'} ${server.name} (${server.transport}) · ${server.state}${
              server.tools.length ? ` · ${server.tools.length} ferramentas` : ''
            }${server.error ? ` · ${server.error.slice(0, 160)}` : ''}`
        )
        .join('\n'),
      summary: `${servers.length} MCPs`
    }
  }
}

export const mcpTools: ToolDef[] = [mcpSearchTool, mcpInstallTool, mcpServersTool]
