import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConnectorState, ConnectorTool, DirectoryConnector } from '../src/shared/mcp-connectors'
import type { McpServerSettings } from '../src/shared/types'
import {
  argLines,
  authBadges,
  authExplanation,
  buildRows,
  categoryCounts,
  categoryLabel,
  cleanNotes,
  credentialValues,
  customInput,
  detailPlan,
  draftFromServer,
  endpointDisplay,
  filterRows,
  filterTools,
  fold,
  formatDay,
  groupTools,
  hasErrors,
  isOpenableLink,
  isSecretVariable,
  matchesQuery,
  matchesStatus,
  missingCredentials,
  monogram,
  monogramHue,
  needsEndpoint,
  needsOAuthApp,
  overallPolicy,
  parseArgLines,
  popularRank,
  primaryActionLabel,
  probeSummary,
  redirectUriOf,
  relevance,
  sentence,
  serverNameOf,
  sortRows,
  stabilizeRows,
  statusChip,
  toolBadge,
  toolKind,
  validateCustom,
  validateUrl,
  type CustomDraft
} from '../src/renderer/src/lib/connectors'

function entry(patch: Partial<DirectoryConnector> & { id: string; name: string }): DirectoryConnector {
  return {
    description: 'Descrição de teste',
    category: 'produtividade',
    kind: 'remote',
    transport: 'http',
    url: `https://mcp.${patch.id}.example/mcp`,
    auth: 'oauth',
    tools: [],
    source: 'claude-directory',
    ...patch
  }
}

const DIRECTORY: DirectoryConnector[] = [
  entry({ id: 'zeta', name: 'Zeta Docs', category: 'documentos', description: 'Escreva documentos', tools: ['create_doc'] }),
  entry({ id: 'atlassian', name: 'Atlassian (Jira + Confluence, oficial)', description: 'Issues e páginas', tools: ['searchJira', 'executeWrite'], toolCount: 21 }),
  entry({ id: 'alpha', name: 'Alpha Calendário', category: 'produtividade', description: 'Agenda e reuniões', auth: 'none' }),
  entry({ id: 'github', name: 'GitHub', category: 'desenvolvimento', description: 'Repositórios e pull requests', auth: 'api-key', tools: ['list_issues'] }),
  entry({ id: 'beta', name: 'Beta Pay', category: 'financas', description: 'Pagamentos', auth: 'oauth-static' }),
  entry({ id: 'local-fs', name: 'Arquivos locais', kind: 'local', transport: 'stdio', url: undefined, command: 'npx', args: ['-y', 'pkg'], auth: 'none', category: 'desenvolvimento' })
]

const state = (id: string, patch: Partial<ConnectorState> = {}): ConnectorState => ({ id, status: 'not-installed', ...patch })

describe('text and categories', () => {
  it('folds accents and case so a search without accents finds the word', () => {
    expect(fold('Calendário')).toBe('calendario')
    expect(categoryLabel('nuvem-infra')).toBe('Nuvem e infraestrutura')
    expect(categoryLabel('vendas-crm')).toBe('Vendas e CRM')
    expect(categoryLabel('personalizado')).toBe('Personalizados')
    // A category the directory invents later still gets a readable name.
    expect(categoryLabel('energia-solar')).toBe('Energia solar')
  })
})

describe('buildRows', () => {
  it('joins the directory with the states and turns a state without entry into a custom row', () => {
    const rows = buildRows(
      DIRECTORY,
      [
        state('atlassian', { status: 'connected', serverName: 'atlassian', toolCount: 21 }),
        state('meu-mcp', { status: 'connected', serverName: 'meu-mcp', toolCount: 3 }),
        state('stdio-falso', { status: 'connecting', serverName: 'stdio-falso' })
      ],
      [
        { name: 'meu-mcp', type: 'http', url: 'https://meu.example.com/mcp?token=segredo', command: '', args: [], enabled: true },
        { name: 'stdio-falso', command: 'C:\\Programs\\node\\node.exe', args: ['server.js', '--key', 'segredo-no-arg'], enabled: true }
      ]
    )
    expect(rows).toHaveLength(DIRECTORY.length + 2)
    expect(rows.find((row) => row.id === 'atlassian')?.state.status).toBe('connected')
    expect(rows.find((row) => row.id === 'zeta')?.state.status).toBe('not-installed')
    const remote = rows.find((row) => row.id === 'meu-mcp')!
    expect(remote.custom).toBe(true)
    expect(remote.category).toBe('personalizado')
    expect(remote.endpoint).toBe('https://meu.example.com/mcp')
    expect(JSON.stringify(remote)).not.toContain('segredo')
    const local = rows.find((row) => row.id === 'stdio-falso')!
    expect(local.kind).toBe('local')
    expect(local.description).toContain('node')
    // Arguments of a local server can hold a secret: never shown.
    expect(JSON.stringify(local)).not.toContain('segredo-no-arg')
  })

  it('tolerates entries with missing optional fields and ignores duplicates', () => {
    const odd = [{ id: 'x', name: 'X', transport: 'http' }, { id: 'x', name: 'Repetido', transport: 'http' }, { id: 'y', name: 'Y', transport: 'stdio' }] as unknown as DirectoryConnector[]
    const rows = buildRows(odd, [])
    expect(rows.map((row) => row.id)).toEqual(['x', 'y'])
    expect(rows[0]).toMatchObject({ category: 'outros', auth: 'unknown', description: '', toolCount: 0 })
    expect(rows[1].kind).toBe('local')
  })
})

describe('search, status and category filters', () => {
  const rows = buildRows(DIRECTORY, [state('atlassian', { status: 'connected', toolCount: 21 }), state('github', { status: 'needs-auth' }), state('beta', { status: 'error' })])

  it('searches name, description, id, category and tool names, without accents, all words required', () => {
    const ids = (query: string): string[] => filterRows(rows, { query, category: 'all', status: 'all' }).map((row) => row.id)
    expect(ids('atlassian')).toEqual(['atlassian'])
    expect(ids('calendario')).toEqual(['alpha'])
    expect(ids('pull requests')).toEqual(['github'])
    expect(ids('searchjira')).toEqual(['atlassian'])
    expect(ids('finanças')).toEqual(['beta'])
    expect(ids('documentos create_doc')).toEqual(['zeta'])
    expect(ids('atlassian github')).toEqual([])
    expect(ids('')).toHaveLength(rows.length)
    expect(matchesQuery(rows[0], '   ')).toBe(true)
  })

  it('filters by status: connected, available and needs login', () => {
    const ids = (status: 'connected' | 'available' | 'needs-login'): string[] => filterRows(rows, { query: '', category: 'all', status }).map((row) => row.id)
    expect(ids('connected')).toEqual(['atlassian'])
    expect(ids('needs-login')).toEqual(['github'])
    expect(ids('available').sort()).toEqual(['alpha', 'local-fs', 'zeta'])
    expect(matchesStatus(rows[0], 'all')).toBe(true)
  })

  it('counts categories with the current search and status but not the chosen category', () => {
    const all = categoryCounts(rows, { query: '', status: 'all' })
    expect(all.find((item) => item.category === 'desenvolvimento')).toMatchObject({ count: 2, label: 'Desenvolvimento' })
    expect(all.reduce((sum, item) => sum + item.count, 0)).toBe(rows.length)
    expect(categoryCounts(rows, { query: 'pagamentos', status: 'all' })).toEqual([{ category: 'financas', label: 'Finanças', count: 1 }])
    expect(categoryCounts(rows, { query: '', status: 'connected' })).toEqual([{ category: 'produtividade', label: 'Produtividade', count: 1 }])
    // Sorted by size, then by name.
    expect(all[0].count).toBeGreaterThanOrEqual(all[all.length - 1].count)
    expect(filterRows(rows, { query: '', category: 'financas', status: 'all' }).map((row) => row.id)).toEqual(['beta'])
  })
})

describe('sortRows', () => {
  const states = [state('github', { status: 'connected', toolCount: 5 }), state('zeta', { status: 'needs-auth' }), state('alpha', { status: 'error' })]
  const rows = buildRows(DIRECTORY, states)

  it('puts what is connected first, then what needs attention, then the rest with popular ones before alphabetical ones', () => {
    const order = sortRows(rows, 'popular').map((row) => row.id)
    expect(order.slice(0, 3)).toEqual(['github', 'zeta', 'alpha'])
    // atlassian is in the popular list: before the alphabetical rest (Arquivos locais, Beta Pay).
    expect(order[3]).toBe('atlassian')
    expect(order.slice(4)).toEqual(['local-fs', 'beta'])
    expect(popularRank('atlassian')).toBeGreaterThanOrEqual(0)
    expect(popularRank('nao-existe')).toBe(-1)
  })

  it('sorts by name or by number of tools on request', () => {
    const available = rows.filter((row) => row.state.status === 'not-installed')
    expect(sortRows(available, 'name').map((row) => row.id)).toEqual(['local-fs', 'atlassian', 'beta'])
    expect(sortRows(available, 'tools')[0].id).toBe('atlassian')
  })

  it('ranks the best name match first when searching', () => {
    const more = buildRows([...DIRECTORY, entry({ id: 'x', name: 'Outro com atlassian no meio', description: 'atlassian' }), entry({ id: 'at', name: 'Atl' })], [])
    const hits = sortRows(filterRows(more, { query: 'atl', category: 'all', status: 'all' }), 'name', 'atl').map((row) => row.id)
    expect(hits[0]).toBe('at')
    expect(hits[1]).toBe('atlassian')
    expect(relevance(more.find((row) => row.id === 'at')!, 'atl')).toBe(0)
    expect(relevance(more.find((row) => row.id === 'zeta')!, 'atl')).toBe(4)
  })

  it('does not change the order of the list it receives', () => {
    const before = rows.map((row) => row.id)
    sortRows(rows, 'name')
    expect(rows.map((row) => row.id)).toEqual(before)
  })
})

describe('stabilizeRows', () => {
  it('keeps the same object for a row that did not change and replaces the one that did', () => {
    const first = buildRows(DIRECTORY, [state('github', { status: 'connecting' })])
    const second = stabilizeRows(first, buildRows(DIRECTORY, [state('github', { status: 'connected', toolCount: 3 })]))
    expect(second.find((row) => row.id === 'zeta')).toBe(first.find((row) => row.id === 'zeta'))
    expect(second.find((row) => row.id === 'github')).not.toBe(first.find((row) => row.id === 'github'))
    expect(second.find((row) => row.id === 'github')?.state.status).toBe('connected')
  })
})

describe('monogram', () => {
  it('uses the initials of the first two words and ignores text in parentheses', () => {
    expect(monogram('Google Drive')).toBe('GD')
    expect(monogram('Atlassian (Jira + Confluence, oficial)')).toBe('A')
    expect(monogram('1Password')).toBe('1')
    expect(monogram('émile zola')).toBe('ÉZ')
    expect(monogram('')).toBe('?')
  })

  it('gives the same colour to the same seed and one of twelve hues', () => {
    expect(monogramHue('github.com')).toBe(monogramHue('github.com'))
    expect(monogramHue('GitHub.com ')).toBe(monogramHue('github.com'))
    const hues = new Set(Array.from({ length: 300 }, (_, index) => monogramHue(`dominio-${index}.com`)))
    expect(hues.size).toBeGreaterThan(6)
    expect(hues.size).toBeLessThanOrEqual(12)
    for (const hue of hues) expect(hue % 30).toBe(8)
  })
})

describe('labels', () => {
  it('shows the authentication seals of a card', () => {
    const rows = buildRows(DIRECTORY, [])
    const labels = (id: string): string[] => authBadges(rows.find((row) => row.id === id)!).map((badge) => badge.label)
    expect(labels('atlassian')).toEqual(['Login com sua conta'])
    expect(labels('github')).toEqual(['Chave de API'])
    expect(labels('alpha')).toEqual(['Sem login'])
    expect(labels('local-fs')).toEqual(['Local'])
    expect(labels('beta')).toEqual(['Login com sua conta', 'Requer app OAuth seu'])
    expect(authBadges({ auth: 'unknown', kind: 'remote', custom: true })).toEqual([{ label: 'Personalizado', tone: 'muted' }])
    expect(authBadges({ auth: 'unknown', kind: 'remote', custom: false })[0].label).toBe('Login a confirmar')
  })

  it('does not ask for an OAuth app when the directory has the public client id of Openclod', () => {
    const withId = buildRows([entry({ id: 'p', name: 'P', auth: 'oauth-static', oauthClientId: 'openclod-123' })], [])[0]
    expect(needsOAuthApp(withId)).toBe(false)
    expect(authBadges(withId).map((badge) => badge.label)).toEqual(['Login com sua conta'])
    expect(authExplanation(withId)).toContain('já tem um aplicativo cadastrado')
    const without = buildRows([entry({ id: 'q', name: 'Q', auth: 'oauth-static' })], [])[0]
    expect(needsOAuthApp(without)).toBe(true)
    expect(authExplanation(without)).toContain('Client ID')
  })

  it('writes the status chip and the main button of a card', () => {
    expect(statusChip(state('a', { status: 'connected', toolCount: 12 }))).toEqual({ label: 'Conectado · 12 ferramentas', tone: 'ok' })
    expect(statusChip(state('a', { status: 'connected', toolCount: 1 }))?.label).toBe('Conectado · 1 ferramenta')
    expect(statusChip(state('a', { status: 'connected' }))?.label).toBe('Conectado')
    expect(statusChip(state('a', { status: 'needs-auth' }))?.label).toBe('Precisa entrar')
    expect(statusChip(state('a', { status: 'error' }))?.label).toBe('Erro')
    expect(statusChip(state('a', { status: 'connecting' }))?.label).toBe('Conectando…')
    expect(statusChip(state('a'))).toBeNull()
    const rows = buildRows(DIRECTORY, [state('github', { status: 'connected' })])
    expect(primaryActionLabel(rows.find((row) => row.id === 'github')!)).toBe('Gerenciar')
    expect(primaryActionLabel(rows.find((row) => row.id === 'zeta')!)).toBe('Conectar')
  })

  it('formats the verification day as dd/mm', () => {
    expect(formatDay(new Date(2026, 9, 27, 12).getTime())).toBe('27/10')
    expect(formatDay(new Date(2026, 0, 5, 12).getTime())).toBe('05/01')
  })
})

describe('probeSummary', () => {
  const at = new Date(2026, 9, 27, 12).getTime()
  it('has no summary without a probe', () => {
    expect(probeSummary(undefined)).toBeNull()
  })

  it('says clearly what the probe found', () => {
    expect(probeSummary({ checkedAt: at, reachable: false, httpStatus: 503 })).toEqual({ tone: 'bad', text: 'Verificado em 27/10: servidor não alcançável (HTTP 503).' })
    expect(probeSummary({ checkedAt: at, reachable: true, httpStatus: 401, resourceMetadata: true, dynamicRegistration: true, pkceS256: true })?.text).toBe('Verificado em 27/10: chega ao login e o Openclod consegue se cadastrar sozinho.')
    expect(probeSummary({ checkedAt: at, reachable: true, httpStatus: 401, resourceMetadata: true, dynamicRegistration: false })).toMatchObject({ tone: 'warn', text: expect.stringContaining('aplicativo OAuth cadastrado por você') })
    expect(probeSummary({ checkedAt: at, reachable: true, httpStatus: 401 })?.text).toContain('não informa como entrar')
    expect(probeSummary({ checkedAt: at, reachable: true, httpStatus: 403 })?.text).toContain('bloqueio')
    expect(probeSummary({ checkedAt: at, reachable: true, httpStatus: 200, openAccess: true, transportOk: 'http' }, 'none')?.text).toBe('Verificado em 27/10: acesso aberto, responde sem precisar de login.')
    expect(probeSummary({ checkedAt: at, reachable: true, httpStatus: 200 })?.text).toContain('ainda não sabemos como ele autentica')
  })

  it('never calls an OAuth server "no login" just because it lists its tools openly', () => {
    const open = { checkedAt: at, reachable: true, httpStatus: 200, openAccess: true } as const
    for (const auth of ['oauth', 'oauth-static'] as const) {
      const summary = probeSummary(open, auth)!
      expect(summary.text).toContain('lista as ferramentas sem login')
      expect(summary.text).toContain('exige entrar com a sua conta')
      expect(summary.text).not.toContain('acesso aberto')
    }
  })
})

describe('tools', () => {
  const tools: ConnectorTool[] = [
    { name: 'list_issues', description: 'Lista as issues do projeto', policy: 'allow', readOnly: true },
    { name: 'delete_issue', description: 'Apaga uma issue', policy: 'ask', readOnly: false, destructive: true },
    { name: 'create_issue', description: 'Cria uma issue', policy: 'ask', destructive: false, readOnly: false },
    { name: 'mystery', description: 'Sem anotação', policy: 'deny' }
  ]

  it('classifies a tool only from the annotations the server sent', () => {
    expect(tools.map(toolKind)).toEqual(['read', 'write', 'write', 'unknown'])
    expect(toolBadge(tools[0])).toEqual({ label: 'somente leitura', tone: 'ok' })
    expect(toolBadge(tools[1])?.label).toBe('pode alterar ou apagar dados')
    expect(toolBadge(tools[2])?.label).toBe('pode alterar dados')
    expect(toolBadge(tools[3])).toBeNull()
  })

  it('groups, filters and summarises the permission of the tools', () => {
    expect(groupTools(tools).map((group) => [group.kind, group.tools.map((tool) => tool.name)])).toEqual([
      ['read', ['list_issues']],
      ['write', ['create_issue', 'delete_issue']],
      ['unknown', ['mystery']]
    ])
    expect(groupTools([tools[0]]).map((group) => group.kind)).toEqual(['read'])
    expect(filterTools(tools, 'apaga').map((tool) => tool.name)).toEqual(['delete_issue'])
    expect(filterTools(tools, 'issue lista').map((tool) => tool.name)).toEqual(['list_issues'])
    expect(filterTools(tools, '')).toHaveLength(4)
    expect(overallPolicy(tools)).toBe('mixed')
    expect(overallPolicy(tools.map((tool) => ({ ...tool, policy: 'ask' as const })))).toBe('ask')
    expect(overallPolicy([])).toBe('ask')
  })
})

describe('forms', () => {
  it('only accepts https, or http for an address on this computer', () => {
    expect(validateUrl('https://mcp.exemplo.com/mcp')).toBeNull()
    expect(validateUrl('http://127.0.0.1:8123/mcp')).toBeNull()
    expect(validateUrl('http://localhost:3000/mcp')).toBeNull()
    expect(validateUrl('http://exemplo.com/mcp')).toContain('https://')
    expect(validateUrl('ftp://exemplo.com')).toContain('https://')
    expect(validateUrl('')).toContain('Informe')
    expect(validateUrl('isto não é url')).toContain('não é válida')
  })

  it('validates a custom connector and builds what the main process receives', () => {
    const draft = { name: ' meu servidor ', url: ' https://mcp.exemplo.com/mcp ', transport: 'sse' as const, headers: [{ name: 'Authorization', value: ' Bearer abc ' }, { name: '', value: '' }] }
    expect(hasErrors(validateCustom(draft))).toBe(false)
    expect(customInput(draft)).toEqual({ name: 'meu servidor', url: 'https://mcp.exemplo.com/mcp', transport: 'sse', headers: { Authorization: 'Bearer abc' } })
    expect(customInput({ ...draft, headers: [] })).not.toHaveProperty('headers')
    expect(serverNameOf('meu servidor!')).toBe('meu-servidor-')
    expect(validateCustom({ ...draft, name: '' }).name).toContain('nome')
    expect(validateCustom({ ...draft, name: '***' }).name).toContain('letras')
    expect(validateCustom(draft, ['Meu-Servidor']).name).toContain('Já existe')
    expect(validateCustom({ ...draft, headers: [{ name: 'X-Key', value: '' }] }).headers).toContain('valor')
    expect(validateCustom({ ...draft, headers: [{ name: '', value: 'x' }] }).headers).toContain('sem nome')
    expect(validateCustom({ ...draft, headers: [{ name: 'Nome inválido', value: 'x' }] }).headers).toContain('inválidos')
    expect(validateCustom({ ...draft, url: 'http://exemplo.com' }).url).toBeTruthy()
  })

  it('builds the form of a program on this computer and sends only what belongs to it', () => {
    const draft: CustomDraft = {
      name: ' meu-local ',
      mode: 'local',
      url: '',
      transport: 'http',
      headers: [],
      command: ' npx ',
      args: ' -y \n\n@modelcontextprotocol/server-filesystem\r\nC:\\Users\\voce\\Documentos ',
      env: [{ name: 'API_KEY', value: ' abc ' }, { name: '', value: '' }],
      cwd: ' C:\\projetos ',
      startTimeout: ' 45 '
    }
    expect(hasErrors(validateCustom(draft))).toBe(false)
    expect(customInput(draft)).toEqual({
      name: 'meu-local',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\voce\\Documentos'],
      env: { API_KEY: 'abc' },
      cwd: 'C:\\projetos',
      startTimeoutMs: 45_000
    })
    expect(customInput(draft)).not.toHaveProperty('url')
    expect(customInput({ ...draft, args: '', env: [], cwd: '', startTimeout: '' })).toEqual({ name: 'meu-local', command: 'npx' })
    // The start time is also available for a remote server.
    expect(customInput({ name: 'r', url: 'https://x.example/mcp', transport: 'http', headers: [], startTimeout: '90' })).toEqual({ name: 'r', url: 'https://x.example/mcp', transport: 'http', startTimeoutMs: 90_000 })
  })

  it('says what is wrong with a program on this computer', () => {
    const base: CustomDraft = { name: 'x', mode: 'local', url: '', transport: 'http', headers: [], command: 'node', args: '', env: [], cwd: '', startTimeout: '' }
    expect(hasErrors(validateCustom(base))).toBe(false)
    expect(validateCustom({ ...base, command: '  ' }).command).toContain('Informe')
    expect(validateCustom({ ...base, command: 'node\nrm' }).command).toContain('uma linha')
    expect(validateCustom({ ...base, args: Array.from({ length: 101 }, () => 'a').join('\n') }).args).toContain('demais')
    expect(validateCustom({ ...base, env: [{ name: 'COM ESPACO', value: 'x' }] }).env).toContain('letras')
    expect(validateCustom({ ...base, env: [{ name: 'A', value: '' }] }).env).toContain('Falta o valor da variável')
    expect(validateCustom({ ...base, env: [{ name: '', value: 'x' }] }).env).toContain('sem nome')
    expect(validateCustom({ ...base, cwd: 'pasta' }).cwd).toContain('caminho completo')
    expect(validateCustom({ ...base, cwd: 'C:\\ok' }).cwd).toBeUndefined()
    expect(validateCustom({ ...base, startTimeout: '3' }).startTimeout).toContain('de 5 a 600')
    expect(validateCustom({ ...base, startTimeout: '4.5' }).startTimeout).toBeTruthy()
    expect(validateCustom({ ...base, startTimeout: 'abc' }).startTimeout).toBeTruthy()
    expect(validateCustom({ ...base, startTimeout: '601' }).startTimeout).toBeTruthy()
    expect(validateCustom({ ...base, startTimeout: '600' }).startTimeout).toBeUndefined()
    // A local program is not checked as if it had an address, and a remote one does not need a command.
    expect(validateCustom(base).url).toBeUndefined()
    expect(validateCustom({ ...base, mode: 'remote', url: 'https://x.example/mcp', command: '' }).command).toBeUndefined()
  })

  it('starts the edit form from the server as the masked settings show it and sends it back unchanged', () => {
    const jira: McpServerSettings = {
      name: 'jira',
      command: 'uvx',
      args: ['mcp-atlassian', '--read-only'],
      env: { JIRA_URL: 'https://x.atlassian.net', JIRA_API_TOKEN: '••••••ab' },
      cwd: 'C:\\x',
      startTimeoutMs: 90_000,
      enabled: true
    }
    const draft = draftFromServer(jira)
    expect(draft).toMatchObject({ name: 'jira', mode: 'local', command: 'uvx', args: 'mcp-atlassian\n--read-only', cwd: 'C:\\x', startTimeout: '90' })
    expect(draft.env).toEqual([{ name: 'JIRA_URL', value: 'https://x.atlassian.net' }, { name: 'JIRA_API_TOKEN', value: '••••••ab' }])
    // Nothing typed: the same configuration goes back, the credential still masked (the main process keeps the stored one).
    expect(customInput(draft)).toEqual({
      name: 'jira',
      command: 'uvx',
      args: ['mcp-atlassian', '--read-only'],
      env: { JIRA_URL: 'https://x.atlassian.net', JIRA_API_TOKEN: '••••••ab' },
      cwd: 'C:\\x',
      startTimeoutMs: 90_000
    })
    const painel: McpServerSettings = { name: 'painel', type: 'sse', url: 'https://painel.example/mcp', headers: { Authorization: 'Bearer ••••••12' }, command: '', args: [], enabled: true }
    const remote = draftFromServer(painel)
    expect(remote).toMatchObject({ mode: 'remote', transport: 'sse', url: 'https://painel.example/mcp', startTimeout: '' })
    expect(customInput(remote)).toEqual({ name: 'painel', url: 'https://painel.example/mcp', transport: 'sse', headers: { Authorization: 'Bearer ••••••12' } })
  })

  it('hides the value of a variable that looks like a credential, and no other', () => {
    for (const name of ['API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET', 'Authorization']) expect(isSecretVariable(name)).toBe(true)
    for (const name of ['REGIAO', 'JIRA_URL', 'MAX_TOKENS', 'TOKEN_LIMIT', 'PATH']) expect(isSecretVariable(name)).toBe(false)
  })

  it('reads arguments one per line and writes them back the same way', () => {
    expect(parseArgLines(' a \n\n b\r\nc ')).toEqual(['a', 'b', 'c'])
    expect(parseArgLines(undefined)).toEqual([])
    expect(argLines(['a', 'b'])).toBe('a\nb')
    expect(argLines(undefined)).toBe('')
  })

  it('works out the credential form of a directory entry', () => {
    const github = entry({
      id: 'gh',
      name: 'GH',
      auth: 'api-key',
      credentials: [
        { key: 'GITHUB_TOKEN', label: 'Token', where: 'header', required: true, secret: true },
        { key: 'ORG', label: 'Organização', where: 'env' }
      ]
    })
    expect(missingCredentials(github, {}).map((field) => field.key)).toEqual(['GITHUB_TOKEN'])
    expect(missingCredentials(github, { GITHUB_TOKEN: '  ' }).map((field) => field.key)).toEqual(['GITHUB_TOKEN'])
    expect(missingCredentials(github, { GITHUB_TOKEN: 'x' })).toEqual([])
    expect(credentialValues(github, { GITHUB_TOKEN: ' abc ', ORG: '', OUTRO: 'ignorado' })).toEqual({ GITHUB_TOKEN: 'abc' })
    expect(needsEndpoint(entry({ id: 'sem-url', name: 'S', url: undefined }))).toBe(true)
    expect(needsEndpoint(github)).toBe(false)
    expect(needsEndpoint(entry({ id: 'l', name: 'L', transport: 'stdio', url: undefined, command: 'x' }))).toBe(false)
  })

  it('never shows a query string (it may carry a token) and cleans internal wording from the notes', () => {
    expect(endpointDisplay('https://mcp.exemplo.com/mcp?token=segredo#x')).toBe('https://mcp.exemplo.com/mcp')
    expect(endpointDisplay('https://mcp.exemplo.com/')).toBe('https://mcp.exemplo.com')
    expect(endpointDisplay('não é url')).toBeUndefined()
    expect(cleanNotes('Use OAuth. Sondagem: o endpoint também aceita login (oauth).')).toBe('Use OAuth.')
    expect(cleanNotes('Sondagem: só isto.')).toBeUndefined()
    expect(cleanNotes(undefined)).toBeUndefined()
  })

  it('turns a message of the main process into a sentence', () => {
    expect(sentence('servidor MCP não publicou metadados OAuth')).toBe('Servidor MCP não publicou metadados OAuth.')
    expect(sentence('  falhou.  ')).toBe('Falhou.')
    expect(sentence('erro\n  em duas linhas...')).toBe('Erro em duas linhas.')
    expect(sentence(undefined)).toBe('')
  })

  it('accepts only http(s) links for the login window and reads the return URL defensively', () => {
    expect(isOpenableLink('https://login.exemplo.com/auth?x=1')).toBe(true)
    expect(isOpenableLink('javascript:alert(1)')).toBe(false)
    expect(isOpenableLink('file:///c:/x')).toBe(false)
    expect(isOpenableLink(undefined)).toBe(false)
    expect(redirectUriOf({ redirectUri: 'http://127.0.0.1:53682/callback' })).toBe('http://127.0.0.1:53682/callback')
    expect(redirectUriOf({ redirectUri: 'javascript:1' })).toBeUndefined()
    expect(redirectUriOf({})).toBeUndefined()
    expect(redirectUriOf(null)).toBeUndefined()
  })
})

describe('detailPlan', () => {
  const rowOf = (patch: Partial<DirectoryConnector>, st?: Partial<ConnectorState>) => buildRows([entry({ id: 'c', name: 'C', ...patch })], [state('c', st)])[0]

  it('offers one click for OAuth and for connectors without login, and a form when something must be typed', () => {
    expect(detailPlan(rowOf({ auth: 'oauth' }))).toMatchObject({ oneClick: true, form: false, tools: false, removable: false })
    expect(detailPlan(rowOf({ auth: 'none' }))).toMatchObject({ oneClick: true, form: false })
    expect(detailPlan(rowOf({ auth: 'api-key', credentials: [{ key: 'K', label: 'K', where: 'header', required: true }] }))).toMatchObject({ oneClick: false, form: true })
    expect(detailPlan(rowOf({ auth: 'oauth', url: undefined }))).toMatchObject({ oneClick: false, form: true })
    // An OAuth service that takes only registered apps: the user brings a Client ID, unless the directory has Openclod's.
    expect(detailPlan(rowOf({ auth: 'oauth-static' }))).toMatchObject({ oneClick: false, form: true })
    expect(detailPlan(rowOf({ auth: 'oauth-static', oauthClientId: 'abc' }))).toMatchObject({ oneClick: true, form: false })
  })

  it('shows the tools of a connected connector and the login wait of one that is waiting for the user', () => {
    expect(detailPlan(rowOf({ auth: 'oauth' }, { status: 'connected', serverName: 'c' }))).toMatchObject({ tools: true, removable: true, oneClick: false, waiting: false })
    expect(detailPlan(rowOf({ auth: 'oauth' }, { status: 'connecting', detail: 'Aguardando você concluir o login no navegador' }))).toMatchObject({ waiting: true, removable: true })
    // "Conectando…" of a server that is just starting is not a login wait.
    expect(detailPlan(rowOf({ auth: 'none' }, { status: 'connecting', detail: 'Conectando…' }))).toMatchObject({ waiting: false })
    expect(detailPlan(rowOf({ auth: 'oauth' }, { status: 'connecting', detail: 'Conectando…' }), true)).toMatchObject({ waiting: true })
  })

  it('asks for the credential again after the server refused it, and offers the login again for OAuth', () => {
    const key = { auth: 'api-key' as const, credentials: [{ key: 'K', label: 'K', where: 'header' as const, required: true }] }
    expect(detailPlan(rowOf(key, { status: 'needs-auth', serverName: 'c' }))).toMatchObject({ form: true, removable: true })
    expect(detailPlan(rowOf(key, { status: 'connected', serverName: 'c' }))).toMatchObject({ form: false })
    expect(detailPlan(rowOf({ auth: 'oauth' }, { status: 'needs-auth', serverName: 'c' }))).toMatchObject({ oneClick: true, form: false })
  })

  it('does not rebuild a connector added by hand from a directory entry', () => {
    const custom = buildRows([], [state('meu', { status: 'needs-auth', serverName: 'meu' })])[0]
    expect(detailPlan(custom)).toMatchObject({ oneClick: false, form: false, removable: true })
  })
})

describe('the real directory file', () => {
  const file = path.join(__dirname, '..', 'resources', 'mcp-directory.json')
  const available = fs.existsSync(file)

  it.runIf(available)('builds a row for every entry, finds Atlassian and filters fast', () => {
    const directory = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: DirectoryConnector[] }
    const started = performance.now()
    const rows = buildRows(directory.entries, [])
    expect(rows.length).toBeGreaterThan(100)
    const hits = sortRows(filterRows(rows, { query: 'atlassian', category: 'all', status: 'all' }), 'popular', 'atlassian')
    expect(hits[0].id).toBe('atlassian')
    expect(categoryCounts(rows, { query: '', status: 'all' }).length).toBeGreaterThan(5)
    for (const row of rows) {
      // Nothing crashes on any entry and every one has something to draw.
      expect(row.name.length).toBeGreaterThan(0)
      expect(monogram(row.name).length).toBeGreaterThan(0)
      authBadges(row)
      authExplanation(row)
      probeSummary(row.entry?.probe, row.auth)
      detailPlan(row)
      cleanNotes(row.entry?.notes)
    }
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
