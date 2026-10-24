import type { McpServerSettings } from '../../shared/types.js'

/**
 * Curated MCP catalog. Every entry is installable without guessing: the
 * command/URL, the environment variables and the transport are known here.
 * Unknown servers are resolved through the official MCP Registry at runtime.
 */
export interface McpCredential {
  key: string
  label: string
  /** Missing required credentials block the install and are reported to the agent. */
  required?: boolean
  secret?: boolean
  example?: string
}

export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  category: 'atlassian' | 'productivity' | 'development' | 'database' | 'browser' | 'desktop' | 'documents' | 'observability' | 'design' | 'cloud' | 'communication'
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  /** Environment variables the server reads. `${KEY}` in args/url is replaced. */
  env?: McpCredential[]
  /** Headers the remote server reads. */
  headers?: McpCredential[]
  /** Compose Basic auth from these two env vars (Atlassian personal token). */
  basicAuth?: { user: string; password: string }
  /** The server needs an interactive OAuth login, which Openclod does not automate. */
  oauth?: boolean
  docs?: string
  notes?: string
  /** Always-approval tool patterns (writes/deletes) for this server. */
  approvalTools?: string[]
}

const homePath = '${HOME}'

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'atlassian',
    name: 'Atlassian (Jira + Confluence, oficial)',
    description:
      'Servidor oficial Rovo MCP v2 por HTTP. Busca e cria issues no Jira, lê e edita páginas do Confluence, sprints, boards e Bitbucket. Use um API token pessoal (Basic) ou um token de service account.',
    category: 'atlassian',
    transport: 'http',
    url: 'https://mcp.atlassian.com/v2/mcp',
    basicAuth: { user: 'ATLASSIAN_EMAIL', password: 'ATLASSIAN_API_TOKEN' },
    env: [
      { key: 'ATLASSIAN_EMAIL', label: 'E-mail da conta Atlassian', required: true, example: 'voce@empresa.com' },
      { key: 'ATLASSIAN_API_TOKEN', label: 'API token Atlassian', required: true, secret: true }
    ],
    docs: 'https://support.atlassian.com/atlassian-ai-gateway/docs/configure-authentication-via-api-token/',
    notes:
      'Se a organização não habilitou autenticação por API token no Rovo MCP, use a variante local "Jira/Confluence (mcp-atlassian)".',
    approvalTools: ['*delete*', '*transition*', '*create*', '*update*', '*edit*', '*comment*']
  },
  {
    id: 'jira',
    name: 'Jira + Confluence (local, mcp-atlassian)',
    description:
      'Servidor comunitário mcp-atlassian via uvx, usando a API REST do Jira/Confluence com e-mail + API token. Não depende do Rovo MCP nem de OAuth; funciona em Jira Cloud e Server.',
    category: 'atlassian',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian'],
    env: [
      { key: 'JIRA_URL', label: 'URL do Jira', required: true, example: 'https://empresa.atlassian.net' },
      { key: 'JIRA_USERNAME', label: 'E-mail do Jira', required: true, example: 'voce@empresa.com' },
      { key: 'JIRA_API_TOKEN', label: 'API token do Jira', required: true, secret: true },
      { key: 'CONFLUENCE_URL', label: 'URL do Confluence (opcional)', example: 'https://empresa.atlassian.net/wiki' },
      { key: 'CONFLUENCE_USERNAME', label: 'E-mail do Confluence (opcional)' },
      { key: 'CONFLUENCE_API_TOKEN', label: 'API token do Confluence (opcional)', secret: true }
    ],
    docs: 'https://github.com/sooperset/mcp-atlassian',
    notes: 'Primeira execução baixa o pacote Python; pode levar alguns minutos.',
    approvalTools: ['jira_create_issue', 'jira_update_issue', 'jira_transition_issue', 'jira_add_comment', 'confluence_create_page', 'confluence_update_page']
  },
  {
    id: 'github',
    name: 'GitHub (oficial)',
    description: 'Repositórios, issues, pull requests, revisão de código e API do GitHub pelo servidor remoto oficial.',
    category: 'development',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [{ key: 'Authorization', label: 'Authorization: Bearer <token>', required: true, secret: true, example: 'Bearer github_pat_...' }],
    docs: 'https://github.com/github/github-mcp-server'
  },
  {
    id: 'context7',
    name: 'Context7 (documentação atualizada)',
    description: 'Documentação versionada e exemplos de código direto dos repositórios, sem depender do conhecimento do modelo.',
    category: 'development',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    headers: [
      { key: 'CONTEXT7_API_KEY', label: 'API key Context7 (opcional; aumenta o limite)', secret: true }
    ],
    docs: 'https://github.com/upstash/context7'
  },
  {
    id: 'playwright',
    name: 'Playwright (navegador)',
    description: 'Automação de navegador real: abrir páginas, clicar, preencher formulários, tirar screenshots e testar fluxos E2E.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    docs: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: 'Controla o Chrome via DevTools: navegação, performance, rede, console e screenshots.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    docs: 'https://github.com/ChromeDevTools/chrome-devtools-mcp'
  },
  {
    id: 'desktop-commander',
    name: 'Desktop Commander',
    description: 'Terminal e arquivos do computador inteiro: executar comandos, ler/editar arquivos e gerenciar processos.',
    category: 'desktop',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@wonderwhy-er/desktop-commander@latest'],
    approvalTools: ['*']
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Leitura, escrita e busca de arquivos em pastas autorizadas. Informe a pasta em ALLOWED_PATH.',
    category: 'desktop',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${ALLOWED_PATH}'],
    env: [{ key: 'ALLOWED_PATH', label: 'Pasta permitida', required: true, example: homePath }],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'memory',
    name: 'Memory (grafo de conhecimento)',
    description: 'Memória persistente em grafo, com entidades, relações e busca. Independente da wiki de projeto do Openclod.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Raciocínio passo a passo com revisões e ramificações para problemas complexos.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Baixa páginas e converte HTML em Markdown para leitura eficiente pelo modelo.',
    category: 'development',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch'
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Lê, busca e manipula repositórios Git locais (status, diff, log, branches). Informe o repositório.',
    category: 'development',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '${REPO_PATH}'],
    env: [{ key: 'REPO_PATH', label: 'Caminho do repositório', required: true, example: homePath }],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git'
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Conversão de horários e fusos, útil para tarefas agendadas e reuniões.',
    category: 'productivity',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time'
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Consulta e inspeção de bancos SQLite. Informe o caminho do arquivo .db.',
    category: 'database',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '${DB_PATH}'],
    env: [{ key: 'DB_PATH', label: 'Arquivo SQLite', required: true, example: 'C:\\dados\\app.db' }],
    docs: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite'
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Consultas somente-leitura e inspeção de esquema em PostgreSQL. Informe a connection string.',
    category: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '${DATABASE_URL}'],
    env: [{ key: 'DATABASE_URL', label: 'Connection string', required: true, secret: true, example: 'postgresql://user:pass@host/db' }],
    docs: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres'
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Projetos, tabelas, SQL, logs e edge functions do Supabase.',
    category: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase@latest', '--access-token', '${SUPABASE_ACCESS_TOKEN}'],
    env: [{ key: 'SUPABASE_ACCESS_TOKEN', label: 'Personal access token Supabase', required: true, secret: true }],
    docs: 'https://github.com/supabase-community/supabase-mcp'
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Busca web e local via API da Brave, com resultados estruturados.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio', '--brave-api-key', '${BRAVE_API_KEY}'],
    env: [{ key: 'BRAVE_API_KEY', label: 'API key Brave Search', required: true, secret: true }],
    docs: 'https://github.com/brave/brave-search-mcp-server'
  },
  {
    id: 'firebase',
    name: 'Firebase',
    description: 'Firestore, autenticação, functions, hosting e storage pelo Firebase CLI.',
    category: 'cloud',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'firebase-tools@latest', 'mcp'],
    docs: 'https://firebase.google.com/docs/cli/mcp-server'
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Clientes, produtos, preços, pagamentos e faturas do Stripe.',
    category: 'cloud',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@stripe/mcp', '--api-key=${STRIPE_SECRET_KEY}'],
    env: [{ key: 'STRIPE_SECRET_KEY', label: 'Secret key Stripe', required: true, secret: true }],
    approvalTools: ['*create*', '*update*', '*delete*', '*refund*'],
    docs: 'https://github.com/stripe/agent-toolkit'
  },
  {
    id: 'terraform',
    name: 'Terraform',
    description: 'Registro de provedores, módulos e documentação do Terraform (HashiCorp).',
    category: 'cloud',
    transport: 'stdio',
    command: 'docker',
    args: ['run', '-i', '--rm', 'hashicorp/terraform-mcp-server'],
    docs: 'https://github.com/hashicorp/terraform-mcp-server'
  },
  {
    id: 'serena',
    name: 'Serena (análise semântica)',
    description: 'Navegação e refatoração semântica de código via LSP, com símbolos e referências.',
    category: 'development',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server', '--context', 'ide-assistant'],
    docs: 'https://github.com/oraios/serena'
  },
  {
    id: 'markitdown',
    name: 'MarkItDown (documentos)',
    description: 'Converte PDF, Word, Excel, PowerPoint e imagens em Markdown para análise.',
    category: 'documents',
    transport: 'stdio',
    command: 'uvx',
    args: ['markitdown-mcp'],
    docs: 'https://github.com/microsoft/markitdown'
  },
  {
    id: 'excel',
    name: 'Excel',
    description: 'Lê e escreve planilhas .xlsx com fórmulas e múltiplas abas — útil no Cowork.',
    category: 'documents',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@negokaz/excel-mcp-server'],
    env: [{ key: 'EXCEL_FILES_PATH', label: 'Pasta das planilhas', example: homePath }],
    docs: 'https://github.com/negokaz/excel-mcp-server'
  },
  {
    id: 'notion',
    name: 'Notion (oficial)',
    description: 'Busca, lê e cria páginas e databases no Notion.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    oauth: true,
    docs: 'https://developers.notion.com/docs/mcp'
  },
  {
    id: 'linear',
    name: 'Linear (oficial)',
    description: 'Issues, projetos, ciclos e times do Linear.',
    category: 'productivity',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    oauth: true,
    docs: 'https://linear.app/docs/mcp'
  },
  {
    id: 'slack',
    name: 'Slack (oficial)',
    description: 'Busca mensagens, canais e conversas do Slack.',
    category: 'communication',
    transport: 'http',
    url: 'https://mcp.slack.com/mcp',
    oauth: true,
    docs: 'https://docs.slack.dev/mcp'
  },
  {
    id: 'asana',
    name: 'Asana (oficial)',
    description: 'Tarefas, projetos e times do Asana via servidor remoto oficial.',
    category: 'productivity',
    transport: 'sse',
    url: 'https://mcp.asana.com/sse',
    oauth: true,
    docs: 'https://developers.asana.com/docs/mcp'
  },
  {
    id: 'sentry',
    name: 'Sentry (oficial)',
    description: 'Issues, eventos, traces e releases do Sentry.',
    category: 'observability',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    oauth: true,
    docs: 'https://docs.sentry.io/product/sentry-mcp/'
  },
  {
    id: 'figma',
    name: 'Figma (app local)',
    description: 'Lê designs abertos no Figma Desktop pelo servidor MCP local na porta 3845.',
    category: 'design',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    docs: 'https://developers.figma.com/docs/figma-mcp-server/'
  },
  {
    id: 'vercel',
    name: 'Vercel (oficial)',
    description: 'Projetos, deploys, logs e domínios da Vercel.',
    category: 'cloud',
    transport: 'http',
    url: 'https://mcp.vercel.com',
    oauth: true,
    docs: 'https://vercel.com/docs/mcp'
  },
  {
    id: 'laravel-boost',
    name: 'Laravel Boost',
    description: 'Ferramentas do Laravel: Artisan, Eloquent, rotas, migrations e geração de código.',
    category: 'development',
    transport: 'stdio',
    command: 'php',
    args: ['artisan', 'boost:mcp'],
    docs: 'https://laravel.com/docs/boost'
  }
]

export interface McpCatalogMatch extends McpCatalogEntry {
  installed?: boolean
}

/** Ranked search over name, description, category and id. */
export function searchMcpCatalog(query: string, limit = 12): McpCatalogEntry[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9áàâãéêíóôõúüç._-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)

  const scored = MCP_CATALOG.map((entry) => {
    const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase()
    let score = 0
    if (!terms.length) score = 1
    for (const term of terms) {
      if (entry.id.toLowerCase() === term || entry.name.toLowerCase() === term) score += 10
      else if (entry.name.toLowerCase().includes(term)) score += 5
      else if (entry.id.toLowerCase().includes(term)) score += 4
      else if (entry.category.toLowerCase().includes(term)) score += 3
      else if (haystack.includes(term)) score += 1
    }
    return { entry, score }
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map((item) => item.entry)
}

export function catalogEntry(id: string): McpCatalogEntry | null {
  return MCP_CATALOG.find((entry) => entry.id === id) ?? null
}

export interface CatalogInstall {
  server: McpServerSettings | null
  missing: string[]
  needsOAuth: boolean
}

function substitute(text: string, env: Record<string, string>): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key: string) => env[key] ?? match)
}

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

/**
 * Builds a ready-to-save server from a catalog entry. Required credentials that
 * are still absent are returned in `missing`; the caller must not save a
 * half-configured server.
 */
export function buildCatalogServer(
  entry: McpCatalogEntry,
  values: { env?: Record<string, string>; headers?: Record<string, string>; name?: string } = {}
): CatalogInstall {
  const env = { ...(values.env ?? {}) }
  const headers = { ...(values.headers ?? {}) }
  const missing: string[] = []

  for (const credential of entry.env ?? []) {
    const value = env[credential.key]?.trim()
    if (!value) {
      if (credential.required) missing.push(credential.key)
      else delete env[credential.key]
    }
  }
  for (const credential of entry.headers ?? []) {
    const value = headers[credential.key]?.trim()
    if (!value) {
      if (credential.required) missing.push(credential.key)
      else delete headers[credential.key]
    }
  }

  if (missing.length) return { server: null, missing, needsOAuth: false }
  if (entry.oauth && !Object.keys(headers).length) {
    // OAuth is interactive: the server is installed without a token and the
    // client starts the browser flow on the first 401.
    const server: McpServerSettings = {
      name: (values.name || entry.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60),
      type: entry.transport,
      command: entry.command ?? '',
      args: (entry.args ?? []).map((arg) => substitute(arg, env)),
      enabled: true
    }
    if (entry.url) server.url = entry.url
    if (Object.keys(env).length) server.env = env
    if (entry.approvalTools?.length) server.approvalTools = [...entry.approvalTools]
    return { server, missing: [], needsOAuth: true }
  }

  if (entry.basicAuth) {
    const user = env[entry.basicAuth.user]
    const password = env[entry.basicAuth.password]
    if (user && password) headers.Authorization = basicHeader(user, password)
  }

  const server: McpServerSettings = {
    name: (values.name || entry.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60),
    type: entry.transport,
    command: entry.command ?? '',
    args: (entry.args ?? []).map((arg) => substitute(arg, env)),
    enabled: true
  }
  if (entry.url) server.url = entry.url
  if (Object.keys(env).length) server.env = env
  if (Object.keys(headers).length) server.headers = headers
  if (entry.approvalTools?.length) server.approvalTools = [...entry.approvalTools]
  return { server, missing: [], needsOAuth: false }
}
