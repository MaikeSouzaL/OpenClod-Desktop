/**
 * Relatorio em Markdown do teste de conectores (docs/mcp/TESTE-CONECTORES-2026-10-27.md). So formata o que esta nos
 * registros gravados: todo numero vem do JSON da execucao real, nada e digitado a mao.
 */
import type { DirectoryConnector } from '../../src/shared/mcp-connectors'
import { OUTCOME_LABEL, countBy, summarize, type ConnectorTestRecord, type Outcome } from './mcp-connectors-test-core'

export interface FixNote {
  id: string
  title: string
  cause: string
  files: string[]
  regression?: string[]
  /** Conectores cujo resultado mudou por causa da correcao (ids). */
  connectors?: string[]
  note?: string
}

/** Um conector investigado a mao (curl, uma ou duas requisicoes extras) para separar defeito nosso de politica do servico. */
export interface Investigation {
  id: string
  finding: string
}

export interface ReportOptions {
  userAgent: string
  fixes?: FixNote[]
  investigations?: Investigation[]
  extra?: Record<string, unknown>
}

const LEVEL_MEANING: Record<string, string> = {
  N0: 'Inalcançável (DNS, timeout, TLS, conexão recusada, HTTP 5xx)',
  N1: 'Alcançável (responde HTTP; sem login OAuth identificável nem acesso aberto)',
  N2: 'Chega ao login (401 com desafio Bearer ou metadados OAuth descobertos)',
  N3: 'Login pronto (o ensaio do ConnectorService montou a URL de autorização com PKCE S256)',
  N4: 'Conectou sem login com o McpClient do Openclod e listou as ferramentas'
}

const esc = (text: unknown): string => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
const code = (text: unknown): string => (text ? `\`${esc(text)}\`` : '—')
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return '_nenhum_\n'
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`)].join('\n') + '\n'
}

const sortByName = (a: ConnectorTestRecord, b: ConnectorTestRecord): number => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })

function stepOf(record: ConnectorTestRecord, name: string): string {
  return record.steps.find((step) => step.step === name)?.detail ?? ''
}

export function buildReport(records: readonly ConnectorTestRecord[], directory: readonly DirectoryConnector[], options: ReportOptions): string {
  const summary = summarize(records)
  const remote = records.filter((record) => record.group === 'remote')
  const out: string[] = []
  const missing = directory.filter((entry) => !records.some((record) => record.id === entry.id))
  const last = records.reduce((max, record) => (record.testedAt > max ? record.testedAt : max), '')

  out.push('# Teste dos conectores MCP — 2026-10-27', '')
  out.push(
    'Gerado por `node scripts/mcp-connectors-test.cjs` (fonte: `scripts/mcp-connectors-test.ts`) a partir de `docs/mcp/teste-conectores.json`. ' +
      'Contagens e tabelas vêm dos registros da execução real; só as seções "Correções" e "Investigados à mão" são texto escrito à mão (`scripts/data/mcp-connectors-test-fixes.json`). ' +
      'Última rodada gravada: ' + (last || '—') + '.',
    ''
  )

  const runs = Array.isArray(options.extra?.runs) ? (options.extra!.runs as Array<{ requests?: number; retries429?: number }>) : []
  if (runs.length) {
    out.push(
      `Rodadas gravadas: ${runs.length} (a primeira testou todos os remotos e as demais só os que falharam por um motivo possivelmente nosso, depois de cada correção); ` +
        `requisições HTTP no total: ${runs.reduce((sum, run) => sum + (run.requests ?? 0), 0)}, com ${runs.reduce((sum, run) => sum + (run.retries429 ?? 0), 0)} reenvio(s) por 429.`,
      ''
    )
  }

  out.push('## Como foi feito', '')
  out.push(
    '- Cada conector rodou pelo **código real do Openclod**: o `McpClient` (initialize + tools/list, transporte HTTP/SSE/stdio), ' +
      'o `ConnectorService` (montagem do servidor a partir da entrada do diretório e o ensaio `connect(id, { dryRun })`) e o `McpOAuthManager.prepareAuthorization` (descoberta RFC 9728/8414/OIDC, escolha do cliente e URL de autorização com PKCE).',
    `- **Etiqueta com terceiros:** User-Agent \`${options.userAgent}\`, UMA tentativa por conector, no máximo 1 requisição por segundo por host (fila única entre todos os chamadores), espera e UM reenvio em 429, concorrência 10 nos remotos e 2 nos locais. Nenhum dado pessoal e nenhuma ferramenta que escreve, envia ou apaga.`,
    '- **Registro dinâmico descartável:** para os conectores `oauth` o ensaio faz UM registro dinâmico de cliente (RFC 7591) em nome de "Openclod Desktop teste", que é exatamente o que o app faz na primeira conexão; o client id retornado é descartado, nada é guardado. Isso deixou um cliente registrado sem uso em cada um desses servidores de autorização.',
    '- **Chamada de prova:** só nos conectores abertos que têm uma ferramenta anotada `readOnlyHint: true`, sem argumentos obrigatórios e sem cara de dado pessoal (no máximo UMA por conector).',
    '- **Sem conta do usuário:** nunca houve login, senha, token, conta criada ou navegador aberto. O settings.json e o perfil reais não foram lidos; tudo rodou em pastas temporárias, com variáveis de ambiente mínimas.',
    '- **N5 (conectado com a conta do usuário) não foi nem pode ser medido aqui.**',
    ''
  )

  /* ------------------------------- contagens ------------------------------- */
  out.push('## Resultado', '')
  out.push(`Conectores no diretório: **${directory.length}**; com registro nesta execução: **${records.length}**${missing.length ? ` (faltam ${missing.length})` : ''}. Remotos com URL: **${summary.remote}**, locais: **${summary.local}**, sem endpoint público: **${summary.noEndpoint}**.`, '')

  out.push('### Por nível (remotos com URL)', '')
  out.push(
    table(
      ['Nível', 'Significado', 'Conectores'],
      ['N0', 'N1', 'N2', 'N3', 'N4'].map((level) => [level, LEVEL_MEANING[level] ?? '', String(summary.byLevel[level] ?? 0)])
    )
  )
  out.push(`N5 — conectado com a conta do usuário: **não medido** (exige login manual).`, '')
  out.push(
    `Em paralelo ao nível: **${summary.connected}** conectaram sem login (N4, remotos e locais); **${summary.loginReady}** têm o login de 1 clique pronto (o ensaio montou a URL de autorização; inclui os que também conectaram sem login); ` +
      `**${summary.needsOwnClient}** só logam com um client id próprio (sem registro dinâmico; inclui os que também conectaram sem login).` +
      (summary.toolCalls.tried ? ` Chamadas de prova (uma ferramenta somente-leitura): ${summary.toolCalls.ok} ok de ${summary.toolCalls.tried} tentadas.` : ''),
    ''
  )

  out.push('### Por categoria de resultado (todos os conectores)', '')
  const outcomes = Object.entries(summary.byOutcome).sort((a, b) => b[1] - a[1])
  out.push(table(['Resultado', 'Conectores'], outcomes.map(([key, count]) => [OUTCOME_LABEL[key as Outcome] ?? key, String(count)])))

  out.push('### Resultado por tipo de autenticação do diretório', '')
  const auths = Object.keys(summary.byAuth).sort()
  out.push(
    table(
      ['Resultado', ...auths, 'Total'],
      outcomes.map(([key, count]) => [
        OUTCOME_LABEL[key as Outcome] ?? key,
        ...auths.map((auth) => String(records.filter((record) => record.outcome === key && record.auth === auth).length || '')),
        String(count)
      ])
    )
  )

  out.push('### Por categoria do diretório', '')
  const categories = [...new Set(records.map((record) => record.category))].sort()
  const shown: Outcome[] = ['open-connected', 'login-ready', 'needs-own-client', 'needs-api-key', 'needs-endpoint', 'blocked', 'unreachable', 'failed']
  out.push(
    table(
      ['Categoria', 'Total', ...shown.map((key) => OUTCOME_LABEL[key].replace(/ \(.*\)$/, '')), 'Locais'],
      categories.map((category) => {
        const own = records.filter((record) => record.category === category)
        return [
          category,
          String(own.length),
          ...shown.map((key) => String(own.filter((record) => record.outcome === key).length || '')),
          String(own.filter((record) => record.group === 'local').length || '')
        ]
      })
    )
  )

  /* -------------------------------- causas ---------------------------------- */
  const notOk = records.filter((record) => record.cause && !['needs-own-client', 'needs-api-key', 'needs-endpoint', 'local-needs-credentials'].includes(record.outcome))
  out.push('## Causas das falhas e bloqueios (agrupadas)', '')
  const groups = new Map<string, ConnectorTestRecord[]>()
  for (const record of notOk) {
    const key = `${OUTCOME_LABEL[record.outcome]} — ${record.cause}`
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  out.push(
    table(
      ['Causa observada', 'Conectores', 'Quais'],
      [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, list]) => [key, String(list.length), list.sort(sortByName).map((record) => record.name).join(', ')])
    )
  )

  /* ------------------------------- correcoes -------------------------------- */
  out.push('## Correções feitas por causa do teste (bugs nossos)', '')
  const fixes = options.fixes ?? []
  if (!fixes.length) out.push('_Nenhuma correção registrada nesta rodada._', '')
  for (const fix of fixes) {
    out.push(`### ${fix.title}`, '', `- **Causa-raiz:** ${fix.cause}`, `- **Arquivos:** ${fix.files.map((file) => `\`${file}\``).join(', ')}`)
    if (fix.regression?.length) out.push(`- **Teste de regressão:** ${fix.regression.map((file) => `\`${file}\``).join(', ')}`)
    if (fix.connectors?.length) out.push(`- **Conectores que mudaram de resultado:** ${fix.connectors.join(', ')}`)
    if (fix.note) out.push(`- ${fix.note}`)
    out.push('')
  }
  const changed = records.filter((record) => record.previous && (record.previous.outcome !== record.outcome || record.previous.level !== record.level))
  if (changed.length) {
    const names = (list: ConnectorTestRecord[]): string => list.sort(sortByName).map((record) => record.name).join(', ')
    const gained = changed.filter((record) => record.outcome === 'login-ready')
    const opened = changed.filter((record) => record.outcome === 'open-connected' || record.outcome === 'local-connected')
    const own = changed.filter((record) => record.outcome === 'needs-own-client')
    const rest = changed.filter((record) => !gained.includes(record) && !opened.includes(record) && !own.includes(record))
    out.push('### Conectores testados de novo depois de uma correção (antes → depois)', '')
    out.push(
      `${changed.length} conectores mudaram de resultado ao serem testados de novo:`,
      '',
      `- **Passaram a ter o login de 1 clique pronto (${gained.length}):** ${names(gained) || '—'}`,
      `- **Passaram a conectar (${opened.length}):** ${names(opened) || '—'}`,
      `- **Descobertos como "precisa de client id próprio" (antes: sem metadados OAuth) (${own.length}):** ${names(own) || '—'}`,
      `- **Continuam sem conectar, agora com a causa exata do serviço no lugar de "a investigar" (${rest.length}):** ver a tabela abaixo e as seções de bloqueados.`,
      ''
    )
    out.push(
      table(
        ['Conector', 'Antes', 'Depois'],
        changed.sort(sortByName).map((record) => [
          `${record.name} (${record.id})`,
          `${record.previous?.level == null ? '—' : `N${record.previous.level}`} · ${OUTCOME_LABEL[record.previous!.outcome]}${record.previous?.cause ? ` — ${record.previous.cause}` : ''}`,
          `${record.level == null ? '—' : `N${record.level}`} · ${OUTCOME_LABEL[record.outcome]}${record.cause ? ` — ${record.cause}` : ''}`
        ])
      )
    )
  }

  const investigations = options.investigations ?? []
  if (investigations.length) {
    out.push('## Investigados à mão (causa confirmada fora do app)', '')
    out.push(
      'Para separar defeito nosso de política do serviço, estes foram examinados com UMA ou DUAS requisições extras (curl/script, o mesmo User-Agent, 1 requisição por segundo). ' +
        'O que era nosso virou correção acima; o resto é do lado do serviço.',
      ''
    )
    out.push(
      table(
        ['Conector', 'Resultado final', 'O que foi visto'],
        investigations.map((item) => {
          const found = records.find((record) => record.id === item.id)
          return [found ? `${found.name} (${item.id})` : item.id, found ? `N${found.level ?? '—'} · ${OUTCOME_LABEL[found.outcome]}` : '—', item.finding]
        })
      )
    )
  }

  /* -------------------------------- tabelas --------------------------------- */
  const open =remote.filter((record) => record.outcome === 'open-connected').sort(sortByName)
  out.push(`## Abertos que conectaram sem login (${open.length})`, '')
  out.push(
    'Nosso `McpClient` fez initialize + tools/list sem credenciais. "Chamada de prova" = a única ferramenta somente-leitura chamada. ' +
      'Os marcados com ✱ têm autenticação `oauth` no diretório: a listagem é aberta, mas chamar ferramentas pode exigir login.',
    ''
  )
  out.push(
    table(
      ['Conector', 'Endpoint', 'Ferramentas', 'Protocolo', 'Transporte', 'Tempo', 'Chamada de prova'],
      open.map((record) => [
        `${record.name}${record.note ? ' ✱' : ''}`,
        code(record.url),
        String(record.toolCount ?? ''),
        record.protocolVersion ?? '',
        record.transportUsed ?? '',
        secs(record.ms),
        record.toolCall ? `${record.toolCall.tool}: ${record.toolCall.ok ? 'ok' : 'erro'}${record.toolCall.ok ? ` (${record.toolCall.chars} car.)` : ` — ${record.toolCall.note.slice(0, 60)}`}` : '—'
      ])
    )
  )

  const ready = remote.filter((record) => record.loginReady).sort(sortByName)
  out.push(`## Prontos para o login de 1 clique (${ready.length})`, '')
  out.push(
    'O ensaio (`connect(id, { dryRun })`) descobriu o servidor de autorização, fez um registro dinâmico descartável e montou a URL de autorização com PKCE S256 e o `redirectUri` fixo ' +
      `\`http://127.0.0.1:38565/callback\`. Falta só o usuário entrar com a conta (N5).`,
    ''
  )
  out.push(
    table(
      ['Conector', 'Endpoint', 'Servidor de autorização', 'Também abre sem login', 'Tempo'],
      ready.map((record) => [record.name, code(record.url), record.authHost ?? '', record.connected ? 'sim' : '', secs(record.ms)])
    )
  )

  const own = records.filter((record) => record.needsOwnClient).sort(sortByName)
  out.push(`## Precisam de client id próprio (${own.length})`, '')
  out.push(
    'O servidor de autorização não oferece registro dinâmico: é preciso criar um aplicativo OAuth no serviço, cadastrar `http://127.0.0.1:38565/callback` e informar o client id ao conectar. ' +
      'Conferido em cada um: o ensaio falha no passo de registro com a mensagem e a dica corretas, e o botão "Conectar" sem client id devolve o `redirectUri` certo (passos `app:*`). ' +
      'Os marcados com ✱ também listam ferramentas sem login (estão na tabela dos abertos), mas o login deles exige o client id.',
    ''
  )
  out.push(
    table(
      ['Conector', 'Servidor de autorização', 'Mensagem e URL de retorno conferidos', 'Causa observada'],
      own.map((record) => {
        const checks = record.steps.filter((step) => step.step.startsWith('app:'))
        const okAll = checks.length > 0 && checks.every((step) => step.ok)
        return [`${record.name}${record.connected ? ' ✱' : ''}`, record.authHost ?? '', okAll ? 'sim' : checks.length ? 'NÃO' : 'n/a', record.cause ?? 'servidor de autorização sem registro dinâmico']
      })
    )
  )

  const keys = records.filter((record) => record.outcome === 'needs-api-key').sort(sortByName)
  out.push(`## Precisam de chave de API (${keys.length})`, '')
  out.push(
    'O servidor responde 401/403 sem a chave. "Chave recusada" é a dica que o app mostra quando o usuário digitou a chave e o servidor a rejeitou (o caso real: o app nem conecta sem as credenciais obrigatórias, e o formulário vem das `credentials` do diretório).',
    ''
  )
  out.push(
    table(
      ['Conector', 'Endpoint', 'HTTP', 'Chave recusada: dica exibida', 'Formulário gerado'],
      keys.map((record) => [
        record.name,
        code(record.url),
        String(record.httpStatus ?? ''),
        stepOf(record, 'app:dica-credencial-recusada').replace(/^com o cabeçalho [^:]*: /, '') || record.hint || '(sem dica)',
        stepOf(record, 'form:credenciais')
      ])
    )
  )

  const locals = records.filter((record) => record.group === 'local').sort(sortByName)
  out.push(`## Locais (${locals.length})`, '')
  out.push(
    table(
      ['Conector', 'Comando', 'Resultado', 'Ferramentas', 'Tempo', 'Observação'],
      locals.map((record) => [
        record.name,
        code(record.command ?? record.url),
        OUTCOME_LABEL[record.outcome],
        String(record.toolCount ?? ''),
        secs(record.ms),
        record.outcome === 'local-connected'
          ? `${record.serverInfo ?? ''}${record.toolCall ? `; chamada de prova ${record.toolCall.tool}: ${record.toolCall.ok ? 'ok' : 'erro'}` : ''}`
          : `${record.cause ?? ''}${record.hint ? ` — ${record.hint}` : ''}`
      ])
    )
  )

  const blocked = remote.filter((record) => ['blocked', 'unreachable', 'failed'].includes(record.outcome)).sort(sortByName)
  out.push(`## Bloqueados, inalcançáveis e a investigar (${blocked.length})`, '')
  out.push(
    table(
      ['Conector', 'Endpoint', 'Nível', 'Resultado', 'Causa observada', 'Erro (trecho)'],
      blocked.map((record) => [record.name, code(record.url), `N${record.level}`, OUTCOME_LABEL[record.outcome], record.cause ?? '', (record.error ?? '').slice(0, 140)])
    )
  )

  const noEndpoint = records.filter((record) => record.group === 'no-endpoint').sort(sortByName)
  out.push(`## Sem endpoint público (${noEndpoint.length})`, '')
  out.push(
    'O diretório do Claude lista estes conectores sem URL (o endpoint é por conta/tenant). O app pede a URL ao usuário (confirmado: `connect` sem URL devolve "Informe a URL do servidor MCP"):',
    '',
    noEndpoint.map((record) => record.name).join(', ') || '_nenhum_',
    ''
  )

  out.push('## Limitações', '')
  out.push(
    '- Instantâneo de 2026-10-27: serviços mudam, e falhas de rede intermitentes podem aparecer como N0; repita só os afetados com `--only <id>` ou `--retest unreachable,blocked`.',
    '- N3 prova que o login *pode* começar (descoberta + cliente + URL com PKCE); a página de consentimento e a troca do código só existem com a conta do usuário (N5).',
    '- Conectores abertos marcados com ✱ listam ferramentas sem login, mas o teste só chamou uma ferramenta somente-leitura quando havia uma sem argumentos obrigatórios.',
    '- O teste não tenta contornar WAF/CAPTCHA nem repete tentativas: 403 de WAF fica como bloqueio do lado do serviço.',
    '- Os resultados de sucesso (login pronto, abertos) vêm da primeira rodada completa; as rodadas seguintes repetiram só os que falharam, depois de cada correção. Uma rodada completa nova repetiria o registro dinâmico descartável em ~500 servidores de terceiros: evite sem necessidade.',
    '- Os conectores `oauth` cujo registro dinâmico é recusado por política do serviço não têm hoje onde receber um client id na tela: o formulário de Client ID só aparece para `oauth-static`, embora `connect` aceite `oauthClient` também para `oauth`. Fica como pendência da interface (nada foi alterado em `src/renderer`).',
    '- Servidores `uvx` desta máquina só sobem com um cache novo do uv (`UV_CACHE_DIR`): o cache padrão tem arquivos presos (pywin32, "os error 32"). O teste isolou o cache numa pasta temporária; o cache real do usuário não foi tocado.',
    ''
  )
  out.push('## Como repetir', '', '```powershell', 'npm run test:connectors                          # todos (~10 min; npx/uvx baixam pacotes na primeira vez)', 'npm run test:connectors -- --only notion,slack   # só alguns ids', 'npm run test:connectors -- --retest failed,blocked --note "o que foi corrigido"', 'npm run test:connectors -- --skip-local          # só os remotos', 'npm run test:connectors -- --report-only         # regenera este relatório a partir do JSON', 'npx vitest run tests/mcp-connectors-test.test.ts tests/mcp*.test.ts tests/connector*.test.ts', '```', '')
  void countBy
  return out.join('\n')
}
