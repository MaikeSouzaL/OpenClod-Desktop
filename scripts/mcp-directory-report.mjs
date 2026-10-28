#!/usr/bin/env node
// Gera docs/mcp/DIRETORIO-CONECTORES.md e docs/mcp/SONDAGEM-<data>.md a partir de resources/mcp-directory.json
// (campo `probe` de cada entrada) e de docs/mcp/sondagem-evidencias.json. Numeros e exemplos vem SEMPRE dos dados:
// rode de novo depois de `node scripts/mcp-probe.mjs` para atualizar os relatorios.
//
// Uso: node scripts/mcp-directory-report.mjs [--date AAAA-MM-DD]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORIES } from './lib/mcp-directory-core.mjs'
import { probeLevel } from './lib/mcp-probe-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRECTORY = path.join(ROOT, 'resources', 'mcp-directory.json')
const EVIDENCE = path.join(ROOT, 'docs', 'mcp', 'sondagem-evidencias.json')

const argDate = process.argv.indexOf('--date') >= 0 ? process.argv[process.argv.indexOf('--date') + 1] : undefined

const CATEGORY_LABEL = {
  produtividade: 'Produtividade',
  desenvolvimento: 'Desenvolvimento',
  comunicacao: 'Comunicação',
  design: 'Design',
  dados: 'Dados e analytics',
  financas: 'Finanças',
  'vendas-crm': 'Vendas e CRM',
  marketing: 'Marketing',
  suporte: 'Suporte ao cliente',
  documentos: 'Documentos',
  'nuvem-infra': 'Nuvem e infraestrutura',
  'seguranca-compliance': 'Segurança e compliance',
  pesquisa: 'Pesquisa',
  viagens: 'Viagens e locais',
  'saude-ciencia': 'Saúde e ciência',
  midia: 'Mídia',
  rh: 'RH',
  juridico: 'Jurídico',
  outros: 'Outros'
}
const AUTH_LABEL = {
  oauth: 'OAuth (login + registro dinâmico)',
  'oauth-static': 'OAuth (client id pré-registrado)',
  'api-key': 'Chave de API / token',
  'local-env': 'Variáveis de ambiente (local)',
  none: 'Nenhuma',
  unknown: 'Não determinada'
}
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`'

function levelOf(e) {
  if (e.kind === 'local') return 'local'
  if (!e.url) return 'sem endpoint'
  return e.probe ? `N${probeLevel(e.probe)}` : 'não sondado'
}
function endpointOf(e) {
  if (e.kind === 'remote') return e.url ? code(e.url) : '—'
  if (e.command) return code([e.command, ...(e.args ?? [])].join(' ').slice(0, 90))
  return e.url ? code(e.url) : '—'
}
function toolsOf(e) {
  return e.toolCount ?? (e.tools?.length ? `${e.tools.length}+` : '—')
}

const directory = JSON.parse(fs.readFileSync(DIRECTORY, 'utf8'))
const evidence = fs.existsSync(EVIDENCE) ? JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) : { results: {} }
const entries = directory.entries
const results = evidence.results ?? {}

const probed = entries.filter((e) => e.kind === 'remote' && e.url && e.probe)
const maxChecked = Math.max(0, ...probed.map((e) => e.probe.checkedAt))
const date = argDate ?? new Date(maxChecked || directory.generatedAt).toISOString().slice(0, 10)

// ---------------------------------------------------------------------------------------------
// DIRETORIO-CONECTORES.md

const bySource = { 'claude-directory': 0, 'openclod-catalog': 0 }
for (const e of entries) bySource[e.source]++
const remote = entries.filter((e) => e.kind === 'remote')
const local = entries.filter((e) => e.kind === 'local')
const noUrl = remote.filter((e) => !e.url)

let md = `# Diretório de conectores do Openclod

Gerado por \`node scripts/mcp-directory-report.mjs\` a partir de \`resources/mcp-directory.json\` (não edite à mão).
Fonte dos conectores remotos: diretório oficial de conectores do Claude, colhido com a ferramenta \`search_mcp_registry\`
(${bySource['claude-directory']} entradas, deduplicadas por \`directoryUuid\`); fonte dos locais: o catálogo próprio do Openclod
(\`src/core/mcp/catalog.ts\`, ${bySource['openclod-catalog']} entradas, 7 delas com o mesmo endpoint de uma entrada do diretório e portanto unificadas).

- **Total:** ${entries.length} conectores (${remote.length} remotos, ${local.length} locais).
- **Remotos sem endpoint público no diretório:** ${noUrl.length} (não dá para sondar nem conectar sem a URL do usuário).
- **Sondagem:** ${date} (ver [SONDAGEM-${date}.md](SONDAGEM-${date}.md)). Nível de teste: N0 inalcançável · N1 alcançável · N2 chega ao login (401 + metadata OAuth) · N3 login possível (registro dinâmico + PKCE) · N4 conecta sem login · N5 conectado com a conta do usuário (não medido: exige login manual).
- **Ferramentas:** número informado pelo diretório (prévia + "+N more") ou contado em \`tools/list\` quando o servidor é aberto; "—" quando desconhecido; "N+" quando só há a prévia.

## Cobertura da coleta

A ferramenta \`search_mcp_registry\` não lista o diretório inteiro: devolve no máximo 10 resultados por consulta, com busca difusa (nome, descrição, prefixos). Por isso a coleta foi por varredura:

- **1ª onda:** 8 coletores temáticos (dev/nuvem, produtividade/comunicação, vendas/marketing/suporte, finanças/RH/jurídico/Brasil, ciência/saúde/viagens, mídia/IA/dados, segurança/TI/telecom, varredura geral e por prefixos): 641 consultas, 2.292 linhas, 817 conectores válidos únicos.
- **2ª onda:** 7 coletores por prefixos de 2–3 letras (todas as letras iniciais), com checagem de novidade contra o que já estava gravado: 444 consultas, +58 conectores. Cada coletor parou depois de 15–20 consultas seguidas sem nenhuma entrada nova.
- **Estimativa de tamanho** (captura–recaptura entre os coletores da 1ª onda, antes da 2ª): 845–891 conectores; o resultado final (${bySource['claude-directory'] + 7} do diretório do Claude, contando os 7 unificados ao catálogo próprio) é consistente com isso.
- **Limitação:** cerca de 1.085 consultas não provam que o diretório está 100% enumerado; entradas que nenhuma consulta alcançou (nomes muito incomuns) podem faltar. Para atualizar: \`node scripts/mcp-directory-build.mjs --merge-shards <pasta com novos .jsonl>\`.
- **Conferência de UUIDs:** os \`directoryUuid\` foram copiados da saída da ferramenta por agentes coletores; entradas repetidas entre coletores foram comparadas (2 UUIDs com erro de cópia foram detectados e corrigidos: OpenSEO e Cloudinary). Um erro de cópia não detectado afetaria só o campo \`directoryUuid\` (metadado), nunca a URL do endpoint, que foi validada pela própria sondagem.

`

for (const cat of CATEGORIES) {
  const list = entries.filter((e) => e.category === cat)
  if (!list.length) continue
  md += `## ${CATEGORY_LABEL[cat] ?? cat} (${list.length})\n\n| Nome | Endpoint | Autenticação | Nível | Ferramentas |\n|---|---|---|---|---|\n`
  for (const e of list) {
    const tag = e.source === 'openclod-catalog' ? ' ·catálogo' : ''
    md += `| ${esc(e.name)}${tag} | ${endpointOf(e)} | ${AUTH_LABEL[e.auth] ?? e.auth} | ${levelOf(e)} | ${toolsOf(e)} |\n`
  }
  md += '\n'
}
fs.writeFileSync(path.join(ROOT, 'docs', 'mcp', 'DIRETORIO-CONECTORES.md'), md)

// ---------------------------------------------------------------------------------------------
// SONDAGEM-<data>.md

const levelCount = { N0: 0, N1: 0, N2: 0, N3: 0, N4: 0 }
for (const e of probed) levelCount[`N${probeLevel(e.probe)}`]++
const authCount = {}
for (const e of probed) authCount[e.auth] = (authCount[e.auth] ?? 0) + 1
const unprobed = entries.filter((e) => e.kind === 'remote' && e.url && !e.probe)

const names = (list, max = 1000) => {
  const shown = list.slice(0, max).map((e) => esc(e.name))
  return shown.join(', ') + (list.length > max ? `, … (+${list.length - max})` : '')
}
const table = (rows, header) => {
  if (!rows.length) return '_nenhum_\n\n'
  return `| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|\n${rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n')}\n\n`
}

const open = probed.filter((e) => e.probe.openAccess)
const openListed = open.filter((e) => results[e.id]?.tools?.ok)
const openPlain = open.filter((e) => e.auth === 'none' || e.auth === 'api-key') // sem metadata OAuth: aparentemente totalmente abertos
const openOauth = open.filter((e) => e.auth === 'oauth' || e.auth === 'oauth-static') // listagem aberta, mas publicam metadata OAuth
const oauthDcr = probed.filter((e) => e.auth === 'oauth')
const oauthDcrPkce = oauthDcr.filter((e) => e.probe.pkceS256)
const oauthStatic = probed.filter((e) => e.auth === 'oauth-static')
const apiKey = probed.filter((e) => e.auth === 'api-key')
const unknownReach = probed.filter((e) => e.auth === 'unknown' && e.probe.reachable)
const unreachable = probed.filter((e) => !e.probe.reachable)
const catalogRemote = probed.filter((e) => e.source === 'openclod-catalog')

const kindOfFailure = (e) => {
  const note = e.probe.note ?? ''
  if (/DNS/.test(note)) return 'DNS não resolve'
  if (/tempo esgotado/.test(note)) return 'tempo esgotado (12 s)'
  if (/TLS|certificado/.test(note)) return 'falha de TLS/certificado'
  if (/recusada/.test(note)) return 'conexão recusada'
  if (/reiniciada/.test(note)) return 'conexão reiniciada'
  if (/anti-bot/.test(note)) return 'anti-bot (HTTP 5xx)'
  if (/HTTP 5\d\d/.test(note)) return `HTTP ${e.probe.httpStatus} do servidor`
  return 'outro'
}
const failGroups = new Map()
for (const e of unreachable) {
  const k = kindOfFailure(e)
  if (!failGroups.has(k)) failGroups.set(k, [])
  failGroups.get(k).push(e)
}

const unkKind = (e) => {
  const note = e.probe.note ?? ''
  if (/WAF|anti-bot/.test(note)) return `provável bloqueio de WAF/CDN/anti-bot (HTTP ${e.probe.httpStatus}, página HTML ou desafio)`
  if (/429/.test(note)) return 'limitado por taxa (429)'
  if (/redireciona para/.test(note)) return 'redireciona para fora de https (endpoint não responde como MCP)'
  if (/bloqueio de borda/.test(note)) return `HTTP ${e.probe.httpStatus} sem WWW-Authenticate: credencial exigida ou bloqueio de borda`
  if (/não é um endpoint MCP/.test(note)) return `HTTP ${e.probe.httpStatus}: URL responde, mas não é endpoint MCP`
  if (/exige credencial, mas não indica/.test(note)) return '401 sem indicar o esquema de autenticação'
  if (/ao POST initialize/.test(note)) return `HTTP ${e.probe.httpStatus} ao POST initialize (não é o endpoint de MCP ou exige outro cabeçalho)`
  if (/não parece servidor MCP/.test(note)) return `HTTP ${e.probe.httpStatus} sem JSON-RPC`
  if (/só aceita MCP/.test(note)) return 'exige MCP 2026-07-28 e o server/discover não concluiu sem credenciais'
  if (/SSE legado/.test(note)) return 'SSE legado: endpoint anunciado, initialize não concluiu'
  if (/JSON-RPC/.test(note)) return 'initialize devolveu erro JSON-RPC'
  return 'outro'
}
const unkGroups = new Map()
for (const e of unknownReach) {
  const k = unkKind(e)
  if (!unkGroups.has(k)) unkGroups.set(k, [])
  unkGroups.get(k).push(e)
}

let s = `# Sondagem dos conectores MCP — ${date}

Gerado por \`node scripts/mcp-directory-report.mjs\` a partir dos resultados gravados em \`resources/mcp-directory.json\` (campo \`probe\`)
e \`docs/mcp/sondagem-evidencias.json\`. Todos os números abaixo vêm da execução real de \`node scripts/mcp-probe.mjs\`.

## Como foi feita

Para cada endpoint remoto com URL (${probed.length + unprobed.length} de ${remote.length} remotos; ${noUrl.length} não têm endpoint público no diretório), **sem credenciais**:

1. \`POST\` JSON-RPC \`initialize\` (protocolVersion \`2025-06-18\`, \`Accept: application/json, text/event-stream\`). Resposta 200 com resultado = acesso aberto; então \`notifications/initialized\` + \`tools/list\` (única ferramenta chamada).
2. 401/403: lê \`WWW-Authenticate\` (\`resource_metadata\`), busca o *protected-resource metadata* (RFC 9728, forma com caminho e da raiz) e o metadata do authorization server (RFC 8414 e OIDC; issuer com caminho nas duas formas) para ver \`registration_endpoint\` e \`code_challenge_methods_supported\` (S256).
3. 404/405/400 no POST: tenta o transporte SSE legado (\`GET\` com \`Accept: text/event-stream\` → \`event: endpoint\` → handshake completo).

Cortesia: concorrência 8, timeout de 12 s, no máximo 3 requisições por segundo por host, \`429\`/\`Retry-After\` respeitados, User-Agent \`Openclod-MCP-Probe/1.0\`, só https, sem IP literal. **Nunca** faz registro dinâmico de cliente, login nem envia credenciais.

## Resultado por nível de teste

| Nível | Significado | Conectores |
|---|---|---|
| N0 | Inalcançável (DNS, timeout, TLS, conexão recusada, HTTP 5xx) | ${levelCount.N0} |
| N1 | Alcançável (responde HTTP; sem login OAuth identificável nem acesso aberto) | ${levelCount.N1} |
| N2 | Chega ao login (401/403 + metadata OAuth) | ${levelCount.N2} |
| N3 | Login possível (registro dinâmico RFC 7591 + PKCE S256 anunciados) | ${levelCount.N3} |
| N4 | Conecta **sem login** (\`initialize\` ok; ${openListed.length} de ${open.length} também listaram ferramentas com \`tools/list\`). Destes, ${openPlain.length} não publicam metadata OAuth (aparentemente totalmente abertos) e ${openOauth.length} publicam (a listagem é aberta, mas as chamadas de ferramenta provavelmente exigem login) | ${levelCount.N4} |
| N5 | Conectado com a conta do usuário | **não medido** (exige login manual) |

Total sondado: **${probed.length}** endpoints remotos${unprobed.length ? ` (${unprobed.length} ainda sem sondagem)` : ''}. Sem endpoint público (não sondáveis): ${noUrl.length}. Locais (stdio / app local): ${local.length}.

## Resultado por tipo de autenticação (apenas sondados)

| Autenticação | Conectores |
|---|---|
${Object.entries(authCount)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| ${AUTH_LABEL[k] ?? k} (\`${k}\`) | ${v} |`)
  .join('\n')}

Observação: as entradas do catálogo próprio com credenciais declaradas (\`github\`, \`context7\`, \`atlassian-token\`) mantêm \`api-key\` mesmo quando o endpoint também aceita OAuth ou acesso aberto; a divergência fica na nota da entrada.

## Conectores que exigem login manual (N5 impossível sem o usuário)

Todo conector com autenticação diferente de \`none\` exige uma ação do usuário (login no navegador ou colar uma chave) antes de poder ser usado de verdade; é isso que separa N4 de N5. Entre eles, ${oauthDcr.length} anunciam registro dinâmico (${oauthDcrPkce.length} também anunciam PKCE S256): login pelo navegador, sem client id prévio. ${oauthDcr.filter((e) => e.probe.openAccess).length} deles listam as ferramentas sem login e só protegem as chamadas. Nome:

${names(oauthDcr)}

## Conectores que NÃO aceitam registro dinâmico (precisam de client id pré-registrado)

${oauthStatic.length} conectores (OAuth, mas o servidor de autorização não publica \`registration_endpoint\` ou o metadata não pôde ser lido). Sem um client id registrado para o Openclod, o login não é possível.

${table(
  oauthStatic.map((e) => {
    const r = results[e.id]
    const issuer = r?.as?.issuer ?? r?.prm?.authorizationServers?.[0] ?? '—'
    const why = r?.as?.found ? 'AS sem registration_endpoint' : 'metadata do AS inacessível'
    return [e.name, code(issuer), why, r?.as?.cimd ? 'sim' : 'não']
  }),
  ['Conector', 'Authorization server', 'Causa observada', 'Anuncia CIMD']
)}
${oauthStatic.filter((e) => results[e.id]?.as?.cimd).length} deles anunciam \`client_id_metadata_document_supported\` (Client ID Metadata Documents, que a spec 2026-07-28 prefere ao registro dinâmico): para esses, um client id baseado em URL hospedada pelo Openclod seria uma saída, ainda não testada.

## Conectores que pedem chave de API / token

${apiKey.length} conectores. Só ${apiKey.filter((e) => e.source === 'claude-directory').length} ${apiKey.filter((e) => e.source === 'claude-directory').length === 1 ? 'foi inferido' : 'foram inferidos'} pela sondagem (401/403 com \`WWW-Authenticate\` Basic/Bearer/ApiKey/Key sem metadata OAuth, ou mensagem pedindo chave); os demais vêm do catálogo próprio, que declara a credencial e a mantém mesmo quando o endpoint também aceita OAuth ou acesso aberto (a nota da entrada registra a divergência).

${table(
  apiKey.map((e) => [
    e.name,
    e.source === 'openclod-catalog' ? 'catálogo (credencial declarada)' : 'sondagem',
    e.probe.httpStatus ?? '',
    e.source === 'openclod-catalog' ? (e.probe.note ?? '').slice(0, 110) : results[e.id]?.wwwAuthenticate ? code(results[e.id].wwwAuthenticate.slice(0, 80)) + ' ' + (results[e.id]?.body ?? '').slice(0, 80) : (results[e.id]?.body ?? '').slice(0, 100)
  ]),
  ['Conector', 'Origem do auth', 'HTTP', 'Evidência']
)}
## Conectores abertos (N4, sem login)

${open.length} responderam \`initialize\` sem credenciais (${openListed.length} também listaram ferramentas). **${openPlain.length}** não publicam metadata OAuth (aparentemente totalmente abertos, \`auth: none\`); **${openOauth.length}** listam sem login, mas publicam metadata OAuth e por isso ficam com \`auth: oauth\`/\`oauth-static\` (cliente tenta conectar e só pede login ao receber 401).

Totalmente abertos:

${table(
  openPlain.map((e) => [e.name, code(e.url), results[e.id]?.tools?.ok ? results[e.id].tools.count : 'tools/list falhou', e.probe.transportOk ?? '']),
  ['Conector', 'Endpoint', 'Ferramentas (tools/list)', 'Transporte']
)}Listagem aberta, chamadas provavelmente com login:

${table(
  openOauth.map((e) => [e.name, code(e.url), results[e.id]?.tools?.ok ? results[e.id].tools.count : 'tools/list falhou', e.auth]),
  ['Conector', 'Endpoint', 'Ferramentas (tools/list)', 'Autenticação inferida']
)}
## Inalcançáveis (N0) e falhas

${unreachable.length} endpoints não responderam de forma utilizável, agrupados pela causa observada:

${[...failGroups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([k, list]) => `**${k} (${list.length}):** ${names(list)}`)
  .join('\n\n') || '_nenhum_'}

## Alcançáveis, mas sem classificação (N1 com \`auth: unknown\`)

${unknownReach.length} endpoints respondem, mas a autenticação não pôde ser determinada sem credenciais:

${[...unkGroups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([k, list]) => `**${k} (${list.length}):** ${names(list)}`)
  .join('\n\n') || '_nenhum_'}

## Sem endpoint público no diretório (${noUrl.length})

O diretório do Claude lista estes conectores sem URL (normalmente porque o endpoint é por conta/tenant). Ficam com \`auth: unknown\`; o usuário precisa informar a URL ao conectar:

${names(noUrl)}

## Catálogo próprio do Openclod (remotos)

${table(
  catalogRemote.map((e) => [e.id, code(e.url), e.auth, levelOf(e), e.probe.note ?? '']),
  ['Id', 'Endpoint', 'Auth', 'Nível', 'Observação da sondagem']
)}
## Limitações

- **N5 não foi (e não pode ser) medido aqui:** conectar de verdade exige a conta do usuário; a sondagem só prova que o login é *possível*.
- Classificar \`oauth\` significa "o servidor de autorização anuncia registro dinâmico"; o registro em si **não** foi feito. Um servidor pode anunciar DCR e ainda recusar clientes desconhecidos.
- \`api-key\` é inferido de \`WWW-Authenticate\` (Basic/Bearer/ApiKey) ou da mensagem de erro; 401 sem pistas fica \`unknown\`.
- Respostas 403 de WAF/anti-bot não são classificadas (a sondagem não tenta contornar CAPTCHA).
- Resultado é uma foto de ${date}: serviços mudam, e falhas de rede intermitentes podem aparecer como N0; rode de novo para confirmar (\`--only <id>\`).
- A lista de conectores vem de varredura por consultas (ver "Cobertura da coleta" em \`DIRETORIO-CONECTORES.md\`): ${bySource['claude-directory'] + 7} conectores do diretório do Claude, sem garantia de ser 100% do diretório.
- O MCP mudou: a spec 2026-07-28 remove \`initialize\` (protocolo sem estado, \`server/discover\`) e deprecia o registro dinâmico (RFC 7591) em favor de Client ID Metadata Documents. A sondagem tenta \`server/discover\` quando o servidor recusa \`initialize\` 2025-06-18 e registra \`cimd\` na evidência dos servidores de autorização que o anunciam.

## Como repetir

\`\`\`powershell
node scripts/mcp-directory-build.mjs                 # remonta resources/mcp-directory.json (preserva sondagens)
node scripts/mcp-probe.mjs                           # sonda todos os remotos (~10 min) e grava probe/auth + evidências
node scripts/mcp-probe.mjs --only notion,slack       # só alguns ids
node scripts/mcp-directory-report.mjs                # regenera estes relatórios
npx vitest run tests/mcp-probe.test.ts               # testes da classificação, da sondagem local e do JSON
\`\`\`
`
fs.writeFileSync(path.join(ROOT, 'docs', 'mcp', `SONDAGEM-${date}.md`), s)
console.log(`relatórios gerados (${date}): ${entries.length} entradas, ${probed.length} sondadas`, levelCount)
