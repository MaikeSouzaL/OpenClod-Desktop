# Teste dos conectores MCP — 2026-10-27

Gerado por `node scripts/mcp-connectors-test.cjs` (fonte: `scripts/mcp-connectors-test.ts`) a partir de `docs/mcp/teste-conectores.json`. Contagens e tabelas vêm dos registros da execução real; só as seções "Correções" e "Investigados à mão" são texto escrito à mão (`scripts/data/mcp-connectors-test-fixes.json`). Última rodada gravada: 2026-10-27T07:43:27.507Z.

Rodadas gravadas: 10 (a primeira testou todos os remotos e as demais só os que falharam por um motivo possivelmente nosso, depois de cada correção); requisições HTTP no total: 4585, com 9 reenvio(s) por 429.

## Como foi feito

- Cada conector rodou pelo **código real do Openclod**: o `McpClient` (initialize + tools/list, transporte HTTP/SSE/stdio), o `ConnectorService` (montagem do servidor a partir da entrada do diretório e o ensaio `connect(id, { dryRun })`) e o `McpOAuthManager.prepareAuthorization` (descoberta RFC 9728/8414/OIDC, escolha do cliente e URL de autorização com PKCE).
- **Etiqueta com terceiros:** User-Agent `Openclod-Desktop-ConnectorTest/1.0`, UMA tentativa por conector, no máximo 1 requisição por segundo por host (fila única entre todos os chamadores), espera e UM reenvio em 429, concorrência 10 nos remotos e 2 nos locais. Nenhum dado pessoal e nenhuma ferramenta que escreve, envia ou apaga.
- **Registro dinâmico descartável:** para os conectores `oauth` o ensaio faz UM registro dinâmico de cliente (RFC 7591) em nome de "Openclod Desktop teste", que é exatamente o que o app faz na primeira conexão; o client id retornado é descartado, nada é guardado. Isso deixou um cliente registrado sem uso em cada um desses servidores de autorização.
- **Chamada de prova:** só nos conectores abertos que têm uma ferramenta anotada `readOnlyHint: true`, sem argumentos obrigatórios e sem cara de dado pessoal (no máximo UMA por conector).
- **Sem conta do usuário:** nunca houve login, senha, token, conta criada ou navegador aberto. O settings.json e o perfil reais não foram lidos; tudo rodou em pastas temporárias, com variáveis de ambiente mínimas.
- **N5 (conectado com a conta do usuário) não foi nem pode ser medido aqui.**

## Resultado

Conectores no diretório: **900**; com registro nesta execução: **900**. Remotos com URL: **795**, locais: **22**, sem endpoint público: **83**.

### Por nível (remotos com URL)

| Nível | Significado | Conectores |
|---|---|---|
| N0 | Inalcançável (DNS, timeout, TLS, conexão recusada, HTTP 5xx) | 5 |
| N1 | Alcançável (responde HTTP; sem login OAuth identificável nem acesso aberto) | 45 |
| N2 | Chega ao login (401 com desafio Bearer ou metadados OAuth descobertos) | 140 |
| N3 | Login pronto (o ensaio do ConnectorService montou a URL de autorização com PKCE S256) | 492 |
| N4 | Conectou sem login com o McpClient do Openclod e listou as ferramentas | 113 |

N5 — conectado com a conta do usuário: **não medido** (exige login manual).

Em paralelo ao nível: **127** conectaram sem login (N4, remotos e locais); **517** têm o login de 1 clique pronto (o ensaio montou a URL de autorização; inclui os que também conectaram sem login); **102** só logam com um client id próprio (sem registro dinâmico; inclui os que também conectaram sem login). Chamadas de prova (uma ferramenta somente-leitura): 37 ok de 55 tentadas.

### Por categoria de resultado (todos os conectores)

| Resultado | Conectores |
|---|---|
| Pronto para o login de 1 clique | 492 |
| Conectou sem login (aberto) | 113 |
| Bloqueado pelo serviço | 90 |
| Precisa de client id próprio | 89 |
| Precisa da URL do usuário (sem endpoint público) | 83 |
| Local: subiu e listou ferramentas | 14 |
| Inalcançável | 6 |
| Local: exige credenciais (recusa sem elas) | 5 |
| Precisa de chave de API | 3 |
| Local: falta o programa no PC | 2 |
| Falhou (a investigar) | 2 |
| Local: depende de um aplicativo aberto | 1 |

### Resultado por tipo de autenticação do diretório

| Resultado | api-key | local-env | none | oauth | oauth-static | unknown | Total |
|---|---|---|---|---|---|---|---|
| Pronto para o login de 1 clique |  |  |  | 488 |  | 4 | 492 |
| Conectou sem login (aberto) | 1 |  | 70 | 29 | 13 |  | 113 |
| Bloqueado pelo serviço |  |  |  | 45 |  | 45 | 90 |
| Precisa de client id próprio |  |  |  |  | 88 | 1 | 89 |
| Precisa da URL do usuário (sem endpoint público) |  |  |  |  |  | 83 | 83 |
| Local: subiu e listou ferramentas |  | 4 | 10 |  |  |  | 14 |
| Inalcançável |  |  |  |  |  | 6 | 6 |
| Local: exige credenciais (recusa sem elas) |  | 5 |  |  |  |  | 5 |
| Precisa de chave de API | 3 |  |  |  |  |  | 3 |
| Local: falta o programa no PC |  |  | 2 |  |  |  | 2 |
| Falhou (a investigar) |  |  |  | 2 |  |  | 2 |
| Local: depende de um aplicativo aberto |  |  | 1 |  |  |  | 1 |

### Por categoria do diretório

| Categoria | Total | Conectou sem login | Pronto para o login de 1 clique | Precisa de client id próprio | Precisa de chave de API | Precisa da URL do usuário | Bloqueado pelo serviço | Inalcançável | Falhou | Locais |
|---|---|---|---|---|---|---|---|---|---|---|
| comunicacao | 33 | 2 | 25 | 4 |  | 1 | 1 |  |  |  |
| dados | 55 | 2 | 30 | 1 |  | 17 | 1 | 1 |  | 3 |
| desenvolvimento | 49 | 11 | 24 | 2 | 1 | 4 | 2 |  |  | 5 |
| design | 20 | 4 | 13 |  |  | 1 | 1 |  |  | 1 |
| documentos | 52 | 10 | 29 | 7 |  | 2 | 2 |  |  | 2 |
| financas | 144 | 9 | 82 | 23 |  | 5 | 20 | 3 | 1 | 1 |
| juridico | 50 | 6 | 20 | 7 |  | 9 | 7 | 1 |  |  |
| marketing | 60 | 2 | 45 | 2 |  | 7 | 3 | 1 |  |  |
| midia | 27 | 3 | 16 | 3 |  |  | 5 |  |  |  |
| nuvem-infra | 34 | 3 | 17 | 3 |  | 7 | 2 |  |  | 2 |
| outros | 34 | 8 | 14 | 2 |  | 2 | 8 |  |  |  |
| pesquisa | 35 | 7 | 22 | 3 |  | 1 |  |  |  | 2 |
| produtividade | 60 | 2 | 39 | 6 | 1 | 6 |  |  |  | 6 |
| rh | 29 | 3 | 15 | 4 |  | 4 | 3 |  |  |  |
| saude-ciencia | 57 | 14 | 25 | 4 | 1 | 4 | 8 |  | 1 |  |
| seguranca-compliance | 22 | 2 | 13 | 1 |  | 4 | 2 |  |  |  |
| suporte | 17 | 1 | 11 |  |  | 4 | 1 |  |  |  |
| vendas-crm | 76 | 4 | 44 | 13 |  | 5 | 10 |  |  |  |
| viagens | 46 | 20 | 8 | 4 |  |  | 14 |  |  |  |

## Causas das falhas e bloqueios (agrupadas)

| Causa observada | Conectores | Quais |
|---|---|---|
| Bloqueado pelo serviço — provável bloqueio de WAF/CDN (HTTP 403) | 29 | Audible, Benevity, BlackRock Advisor Center, Booking.com, Checkatrade, DirectBooker, Franklin Templeton Funds and Insights, GetYourGuide, GoVola, Helix GenoSphere, ICE Data Services, idealista, Instrumentl, Intuit QuickBooks, Intuit TurboTax, lastminute.com, Maryland Community Compass, McAfee, Norton, Rome2Rio, SciSpace, Stack Overflow, StubHub, The Economist - Graphs, Ticketmaster, Turo, Turquoise, Wyndham Hotels and Resorts, Yelp |
| Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | 14 | Carrefour, Cashfree, Cloverleaf, CorralData, Grasshopper Bank, Intuit Developer, Jus AI by Jus Mundi (Light Mode), Leadfeeder, Phoenix by HG Insights, Similarweb, Synthesize Bio, Trellis, Trussi AI, 中央社新聞 CNA TAIWAN NEWS |
| Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | 11 | CAISey, Eedi, etoro, FreshBooks, iManage Work, Juro contracts, LetsBot, Moody's Credit MCP, PitchBook Premium, Salesloft, Tango |
| Bloqueado pelo serviço — HTTP 403 sem metadados OAuth descobríveis | 7 | athenahealth (beta), Cottages, Expedia, Glovo, Novasol, Shipt, Vital Care Finder |
| Inalcançável — tempo esgotado | 4 | FINNY, InfoTrack, Invesco for Advisors, J.P. Morgan Asset Management (55ip) |
| Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) | 4 | Meridian Connector for QuickBooks, Meridian Connector for Xero, Omnisend MCP, ZoomInfo |
| Bloqueado pelo serviço — registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) | 3 | AppFolio Realm-X, Harness, Manatal |
| Bloqueado pelo serviço — registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) | 3 | D&B Digital Audiences, Orion, Verisk XactRestore |
| Bloqueado pelo serviço — registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) | 3 | Datasite, LSEG, LSEG AI |
| Bloqueado pelo serviço — registro dinâmico recusado (403): o servidor recusa o registro (403) sem dar o motivo | 2 | Bloomberg Law, Figma |
| Bloqueado pelo serviço — registro dinâmico recusado (403): limite de clientes registrados no serviço | 2 | EDEN by Basecamp Research, Light |
| Falhou (a investigar) — registro dinâmico recusado (400) sem motivo claro | 2 | Oxford Economics, Strava |
| Bloqueado pelo serviço — a URL não fala MCP (nenhum transporte funcionou) | 2 | Risotto, Vanguard Advisor Tools |
| Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | 1 | AccuWeather® |
| Inalcançável — HTTP 503 do servidor | 1 | Aiwyn Tax (formerly Column Tax) |
| Inalcançável — falha de TLS/certificado | 1 | Aura |
| Bloqueado pelo serviço — HTTP 406: a URL não responde como MCP | 1 | CarGurus |
| Bloqueado pelo serviço — registro dinâmico recusado (404): o endpoint de registro anunciado responde 404/5xx | 1 | CloudBees Unify MCP Server |
| Bloqueado pelo serviço — registro dinâmico recusado: só aceita clientes aprovados (lista de permitidos) | 1 | Cloze MCP |
| Bloqueado pelo serviço — registro dinâmico recusado (400): registro dinâmico desativado pelo serviço | 1 | CoCounsel Legal |
| Bloqueado pelo serviço — provável bloqueio de WAF/CDN (HTTP 406) | 1 | eDreams |
| Local: depende de um aplicativo aberto — o aplicativo que serve este endereço não está aberto | 1 | Figma (app local) |
| Bloqueado pelo serviço — registro dinâmico recusado (403): registro dinâmico desativado pelo serviço | 1 | Highspot |
| Bloqueado pelo serviço — provável bloqueio de WAF/CDN (HTTP 200) | 1 | Intuit Credit Karma |
| Local: falta o programa no PC — falta o programa no PC (php) | 1 | Laravel Boost |
| Bloqueado pelo serviço — registro dinâmico recusado (403): o registro é restrito por IP/região | 1 | PlayMCP |
| Local: falta o programa no PC — falta o programa no PC (docker) | 1 | Terraform |
| Bloqueado pelo serviço — HTTP 429: a URL não responde como MCP | 1 | ZipRecruiter |

## Correções feitas por causa do teste (bugs nossos)

### Descoberta OAuth: seguir o resource_metadata do 401 na primeira conexão

- **Causa-raiz:** A primeira conexão de um conector OAuth chama `begin()` direto, sem nenhum 401 antes, e a descoberta só olhava os caminhos `.well-known` derivados da URL do MCP. Servidores atrás de um gateway ou com o documento em outro caminho (Bill, Guidepoint, Haloo, iSolved, Morning Consult, American Express/Resy, Metaview) só dizem onde ele está no `WWW-Authenticate` de um pedido sem credenciais, e alguns escrevem a URL sem aspas, que a regex antiga não lia.
- **Arquivos:** `src/main/mcp-oauth.ts`
- **Teste de regressão:** `tests/mcp-oauth.test.ts`
- Sem metadados nos caminhos do RFC, `discover()` pergunta o 401 (POST initialize e, se o POST for 400/404/405, o GET do SSE antigo) e segue o `resource_metadata` (com ou sem aspas) e o `scope` anunciados. Não custa nenhuma requisição quando o documento do RFC responde.

### Registro dinâmico: repetir como localhost quando o servidor recusa 127.0.0.1

- **Causa-raiz:** Muitos servidores aceitam `http://localhost:<porta>` mas recusam o literal `http://127.0.0.1:<porta>` no registro dinâmico (CoinDesk: "http allowed only for localhost"; DevRev: "redirect_uri is not valid: 127.0.0.1"; Grain, Caisey, Eedi, eToro, Pitchbook, Tango...). O registro dinâmico registra a URL que receber, então a URL fixa só importa para o aplicativo OAuth do próprio usuário.
- **Arquivos:** `src/main/mcp-oauth.ts`
- **Teste de regressão:** `tests/mcp-oauth.test.ts`
- Uma recusa 400/422 que culpa a URL de retorno é repetida UMA vez com localhost; o login real e o ensaio usam a URL que foi registrada na URL de autorização e na troca do código. O listener de retorno passou a atender também o loopback IPv6 (::1), para `localhost` chegar qualquer que seja o endereço que o navegador resolver. O aplicativo OAuth do usuário (oauth-static) continua com a URL fixa.

### Nome do cliente do ensaio: curto e sem pontuação

- **Causa-raiz:** O ensaio registrava "Openclod Desktop (teste de conectividade)" (41 caracteres, com parênteses). A Shippo recusa client_name acima de 39 ("client_name must be at most 39 characters") e o Calendly só aceita letras, números, hífen e espaço ("may only contain alphanumeric characters, hyphens, and spaces"): a falha era do nome de teste, não do login real (que usa "Openclod Desktop").
- **Arquivos:** `src/main/mcp-oauth.ts`, `docs/MCP_OAUTH.md`
- **Teste de regressão:** `tests/mcp-oauth.test.ts`

### Aceitar a revisão 2025-11-25 do protocolo quando o servidor responde com ela

- **Causa-raiz:** Os conectores da Square respondem 2025-11-25 ao `initialize` mesmo quando o cliente oferece 2025-06-18, e o cliente recusava a versão ("versão de protocolo MCP não suportada"). O que o cliente usa (initialize, tools, resources, prompts, progresso, cancelamento, elicitation) não muda nessa revisão.
- **Arquivos:** `src/core/mcp/client.ts`, `src/core/mcp/hints.ts`
- **Teste de regressão:** `tests/mcp-client-http.test.ts`
- O cliente continua oferecendo 2025-06-18; 2025-11-25 só é aceita na resposta. Uma versão desconhecida continua recusada.

### Mensagens que dizem o que o servidor devolveu (resposta HTML e recusa de registro)

- **Causa-raiz:** Um WAF que redireciona o POST para uma página de erro (Akamai na frente do Credit Karma) terminava em "resposta MCP inválida", e uma recusa do registro dinâmico só mostrava o status, sem a descrição do servidor ("client_name must be at most 39 characters", "Trusted Hosts", "dynamic client registration is disabled"...). Sem isso não dava para separar defeito nosso de bloqueio do serviço.
- **Arquivos:** `src/core/mcp/client.ts`, `src/main/mcp-oauth.ts`
- **Teste de regressão:** `tests/mcp-client-http.test.ts`, `tests/mcp-oauth.test.ts`

### Dica para o uv que não consegue instalar um pacote por arquivo em uso

- **Causa-raiz:** Nesta máquina todo `uvx mcp-server-*` falhava com "Failed to install: pywin32 ... failed to remove directory ... (os error 32)" (cache do uv com arquivos em uso: antivírus, processo preso ou cache danificado; reproduzido fora do Openclod com o uv 0.11.17 e o 0.11.21). Com um cache novo (UV_CACHE_DIR) os mesmos servidores sobem. O erro chegava ao usuário sem explicação.
- **Arquivos:** `src/core/mcp/hints.ts`
- **Teste de regressão:** `tests/mcp-policy.test.ts`

### Learning Commons: o formulário de chave de API não tinha campo

- **Causa-raiz:** A entrada `learning-commons` está como `api-key` no diretório, mas sem `credentials`: o card não teria onde digitar a chave. A documentação do serviço diz que a chave vai no cabeçalho `x-api-key` (ou `Authorization: Bearer`).
- **Arquivos:** `resources/mcp-directory.json`, `scripts/lib/mcp-directory-core.mjs`
- As credenciais acrescentadas à mão numa entrada do diretório do Claude agora sobrevivem a uma nova coleta (`mcp-directory-build.mjs`).

### SQLite local: fixar o mcp na linha 1.x

- **Causa-raiz:** `uvx mcp-server-sqlite` (pede `mcp>=1.6.0`, sem teto) passou a resolver o mcp 2.3.0, que removeu `Server.list_resources`: o servidor morria na partida com "AttributeError: 'Server' object has no attribute 'list_resources'". O pacote está arquivado e não será atualizado.
- **Arquivos:** `src/core/mcp/catalog.ts`, `resources/mcp-directory.json`
- **Teste de regressão:** `tests/mcp-catalog.test.ts`
- `--with mcp~=1.6` no uvx (sem `<`, porque no Windows o uvx roda por `cmd.exe /c` e `<` seria um redirecionamento). O teste do catálogo agora recusa `< > | & ^` nos argumentos.

### Dica para um servidor local que não está ouvindo (Figma Desktop)

- **Causa-raiz:** O conector "figma" aponta para http://127.0.0.1:3845/mcp, que só existe com o Figma Desktop aberto e o servidor MCP do modo Dev ligado. Sem isso a dica era a genérica "confira a internet, VPN/proxy".
- **Arquivos:** `src/core/mcp/hints.ts`
- **Teste de regressão:** `tests/mcp-policy.test.ts`

### Registro dinâmico que responde 200 com corpo de erro

- **Causa-raiz:** O Cloze responde HTTP 200 com {"error":"unapproved_software_statement"} e o app dizia só "registro OAuth sem client_id", escondendo que o servidor só aceita clientes aprovados.
- **Arquivos:** `src/main/mcp-oauth.ts`
- **Teste de regressão:** `tests/mcp-oauth.test.ts`

### Conectores testados de novo depois de uma correção (antes → depois)

64 conectores mudaram de resultado ao serem testados de novo:

- **Passaram a ter o login de 1 clique pronto (10):** Calendly, CoinDesk, DevRev, Grain, Haloo Trademark Clearance, Jasper, Metaview, Morning Consult, Paytm Payment Gateway, Shippo
- **Passaram a conectar (2):** Order by Cash App, SQLite
- **Descobertos como "precisa de client id próprio" (antes: sem metadados OAuth) (4):** BILL, Guidepoint, isolved People Cloud, Resy
- **Continuam sem conectar, agora com a causa exata do serviço no lugar de "a investigar" (48):** ver a tabela abaixo e as seções de bloqueados.

| Conector | Antes | Depois |
|---|---|---|
| AppFolio Realm-X (appfolio-realm-x) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) |
| BILL (bill) | N2 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N2 · Precisa de client id próprio — servidor de autorização sem registro dinâmico |
| Bloomberg Law (bloomberg-law) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o servidor recusa o registro (403) sem dar o motivo |
| CAISey (caisey) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Calendly (calendly) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N3 · Pronto para o login de 1 clique |
| Carrefour (carrefour) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Cashfree (cashfree) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| CloudBees Unify MCP Server (cloudbees-unify-mcp-server) | N2 · Falhou (a investigar) — registro dinâmico recusado (404) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (404): o endpoint de registro anunciado responde 404/5xx |
| Cloverleaf (cloverleaf) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Cloze MCP (cloze-mcp) | N2 · Falhou (a investigar) — ensaio OAuth falhou | N2 · Bloqueado pelo serviço — registro dinâmico recusado: só aceita clientes aprovados (lista de permitidos) |
| CoCounsel Legal (cocounsel-legal) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): registro dinâmico desativado pelo serviço |
| CoinDesk (coindesk) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N3 · Pronto para o login de 1 clique |
| CorralData (corraldata) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| D&B Digital Audiences (d-and-b-digital-audiences) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) |
| Datasite (datasite) | N2 · Falhou (a investigar) — registro dinâmico recusado (404) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) |
| DevRev (devrev) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N3 · Pronto para o login de 1 clique |
| EDEN by Basecamp Research (eden-by-basecamp-research) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): limite de clientes registrados no serviço |
| Eedi (eedi) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| etoro (etoro) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Figma (figma-remote) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o servidor recusa o registro (403) sem dar o motivo |
| Figma (app local) (figma) | — · Falhou (a investigar) — URL não testada pelo guarda do teste (só https) | — · Local: depende de um aplicativo aberto — o aplicativo que serve este endereço não está aberto |
| FreshBooks (freshbooks) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Grain (grain) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N3 · Pronto para o login de 1 clique |
| Grasshopper Bank (grasshopper-bank) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Guidepoint (guidepoint) | N2 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N2 · Precisa de client id próprio — servidor de autorização sem registro dinâmico |
| Haloo Trademark Clearance (haloo-trademark-clearance) | N2 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N3 · Pronto para o login de 1 clique |
| Harness (harness) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) |
| Highspot (highspot) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): registro dinâmico desativado pelo serviço |
| iManage Work (imanage-work) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Intuit Credit Karma (intuit-credit-karma) | N0 · Falhou (a investigar) — erro não classificado | N1 · Bloqueado pelo serviço — provável bloqueio de WAF/CDN (HTTP 200) |
| Intuit Developer (intuit-developer) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| isolved People Cloud (isolved-people-cloud) | N2 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N2 · Precisa de client id próprio — servidor de autorização sem registro dinâmico |
| Jasper (jasper) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N3 · Pronto para o login de 1 clique |
| Juro contracts (juro-contracts) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Jus AI by Jus Mundi (Light Mode) (jus-ai-by-jus-mundi-light-mode) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Leadfeeder (leadfeeder) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| LetsBot (letsbot) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Light (light) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): limite de clientes registrados no serviço |
| LSEG (lseg) | N2 · Falhou (a investigar) — registro dinâmico recusado (404) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) |
| LSEG AI (lseg-ai) | N2 · Falhou (a investigar) — registro dinâmico recusado (404) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) |
| Manatal (manatal) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) |
| Meridian Connector for QuickBooks (meridian-connector-for-quickbooks) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) |
| Meridian Connector for Xero (meridian-connector-for-xero) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) |
| Metaview (metaview) | N1 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N3 · Pronto para o login de 1 clique |
| Moody's Credit MCP (moody-s-credit-mcp) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Morning Consult (morning-consult) | N2 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N3 · Pronto para o login de 1 clique |
| Omnisend MCP (omnisend-mcp) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) |
| Order by Cash App (order-by-cash-app) | N0 · Falhou (a investigar) — versão de protocolo MCP não suportada | N4 · Conectou sem login (aberto) |
| Orion (orion) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) |
| Paytm Payment Gateway (paytm-payment-gateway) | N2 · Falhou (a investigar) — registro dinâmico recusado (500) | N3 · Pronto para o login de 1 clique |
| Phoenix by HG Insights (phoenix-by-hg-insights) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| PitchBook Premium (pitchbook-premium) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| PlayMCP (playmcp) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o registro é restrito por IP/região |
| Resy (resy) | N2 · Bloqueado pelo serviço — HTTP 401 sem metadados OAuth descobríveis | N2 · Precisa de client id próprio — servidor de autorização sem registro dinâmico |
| Salesloft (salesloft) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Shippo (shippo) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N3 · Pronto para o login de 1 clique |
| Similarweb (similarweb) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| SQLite (sqlite) | — · Local: falhou — o servidor encerrou ou recusou o handshake | — · Local: subiu e listou ferramentas |
| Synthesize Bio (synthesize-bio) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Tango (tango) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) |
| Trellis (trellis) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Trussi AI (trussi-ai) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) |
| Verisk XactRestore (verisk-xactrestore) | N2 · Falhou (a investigar) — registro dinâmico recusado (403) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) |
| ZoomInfo (zoominfo) | N2 · Falhou (a investigar) — registro dinâmico recusado (400) | N2 · Bloqueado pelo serviço — registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) |

## Investigados à mão (causa confirmada fora do app)

Para separar defeito nosso de política do serviço, estes foram examinados com UMA ou DUAS requisições extras (curl/script, o mesmo User-Agent, 1 requisição por segundo). O que era nosso virou correção acima; o resto é do lado do serviço.

| Conector | Resultado final | O que foi visto |
|---|---|---|
| Calendly (calendly) | N3 · Pronto para o login de 1 clique | O registro foi recusado por causa do NOSSO nome de teste: {"errors":{"name":["may only contain alphanumeric characters, hyphens, and spaces."]}}. Com o nome sem pontuação o registro passa (corrigido). |
| Jasper (jasper) | N3 · Pronto para o login de 1 clique | Recusava "Invalid client registration data" para http://127.0.0.1:...; com http://localhost:... o registro passa (HTTP 201, testado à mão). Corrigido pelo fallback para localhost, inclusive para 400 sem motivo. |
| Shippo (shippo) | N3 · Pronto para o login de 1 clique | client_name acima de 39 caracteres recusado pelo servidor ("client_name must be at most 39 characters"): era o nome do ensaio (corrigido). |
| Strava (strava) | N2 · Falhou (a investigar) | 400 invalid_client_metadata "Unable to register client" também com localhost, scope e os grant types anunciados (uma variante extra testada à mão). O serviço não diz o motivo e nenhuma variante do corpo passou. |
| Oxford Economics (oxford-economics) | N2 · Falhou (a investigar) | 400 com corpo vazio em todas as variantes testadas à mão (localhost, client_secret_post que é o único método anunciado, com e sem refresh_token). Política do serviço sem mensagem. |
| Cloze MCP (cloze-mcp) | N2 · Bloqueado pelo serviço | O registro responde HTTP 200 com {"error":"unapproved_software_statement","error_description":"This client is not approved. Contact support@cloze.com for help."}: só clientes aprovados. |
| Bloomberg Law (bloomberg-law) | N2 · Bloqueado pelo serviço | 403 {"message":"Forbidden"} no endpoint de registro: recusa sem dar o motivo (o corpo é só "Forbidden"). |
| Figma (figma-remote) | N2 · Bloqueado pelo serviço | 403 Forbidden no endpoint de registro, sem motivo. Alternativa que funciona sem registro: o servidor local do Figma Desktop (conector "figma", precisa do app aberto). |
| Intuit Credit Karma (intuit-credit-karma) | N1 · Bloqueado pelo serviço | O Akamai responde 302 para /Error_Credit_Karma.htm ao POST do initialize (curl, 1 requisição); o cliente seguia o redirecionamento e terminava num HTML 200. É bloqueio de WAF; a mensagem agora diz isso. |
| CarGurus (cargurus) | N1 · Bloqueado pelo serviço | HTTP 406 com corpo vazio tanto com Accept "application/json, text/event-stream" quanto só com "text/event-stream" (curl, 1 requisição de cada). O endpoint /chat-mcp/v1/stream não aceita um cliente MCP genérico. |
| Risotto (risotto) | N1 · Bloqueado pelo serviço | A URL do diretório (dashboard.tryrisotto.com/settings/integrations/mcp) é uma página do painel: POST responde 405 e o GET devolve HTML. Provavelmente não é o endpoint do servidor MCP; a conferir com o serviço. |
| Order by Cash App (order-by-cash-app) | N4 · Conectou sem login (aberto) | Respondia protocolo 2025-11-25 ao nosso 2025-06-18 e o cliente recusava; agora é aceito (corrigido) e o conector abre sem login. |
| Learning Commons (learning-commons) | N1 · Precisa de chave de API | 401 "No API key found in request" com WWW-Authenticate: Key. A documentação do serviço diz para mandar a chave em x-api-key (ou Authorization: Bearer); o diretório não tinha o campo da chave (corrigido). |
| Fetch (fetch) | N— · Local: subiu e listou ferramentas | Todos os servidores `uvx` falharam nesta máquina com "Failed to install: pywin32 ... (os error 32)" no cache padrão do uv, também fora do Openclod (uv 0.11.17 e 0.11.21). Com UV_CACHE_DIR numa pasta nova o mesmo servidor sobe. A dica pt-BR do app agora explica. |

## Abertos que conectaram sem login (113)

Nosso `McpClient` fez initialize + tools/list sem credenciais. "Chamada de prova" = a única ferramenta somente-leitura chamada. Os marcados com ✱ têm autenticação `oauth` no diretório: a listagem é aberta, mas chamar ferramentas pode exigir login.

| Conector | Endpoint | Ferramentas | Protocolo | Transporte | Tempo | Chamada de prova |
|---|---|---|---|---|---|---|
| Airfield Directory | `https://airfield.directory/mcp` | 8 | 2025-06-18 | http | 7.3 s | airfield_search: erro — either query or region filters are required |
| ALL Accor | `https://mcp.dams.aws.accor.com/green/v1/mcp/apps` | 1 | 2025-06-18 | http | 4.3 s | — |
| AllTrails | `https://www.alltrails.com/mcp` | 5 | 2025-06-18 | http | 5.6 s | — |
| Anthropic Economic Index | `https://econ-index.mcp.claude.com/mcp` | 9 | 2025-06-18 | http | 4.4 s | econ_index_list_top_work_tasks: ok (8119 car.) |
| AthenaHQ ✱ | `https://api.athenahq.ai/api/mcp` | 110 | 2025-06-18 | http | 9.3 s | list_websites: erro — HTTP 401 em tools/call: event: message data: {"result":{"_me |
| Autodesk Product Help ✱ | `https://developer.api.autodesk.com/knowledge/public/v1/mcp` | 2 | 2025-06-18 | http | 9.2 s | get_available_products: ok (26800 car.) |
| AUTONOMAD ✱ | `https://mcp.autonomad.ai/mcp` | 14 | 2025-06-18 | http | 9.2 s | get_capabilities: ok (638 car.) |
| Autosheet ✱ | `https://mcp.autosheet.com/mcp` | 5 | 2025-06-18 | http | 6.2 s | — |
| AWS Marketplace | `https://marketplace-mcp.us-east-1.api.aws/mcp` | 6 | 2025-06-18 | http | 4.0 s | — |
| bioRxiv | `https://hcls.mcp.claude.com/biorxiv/mcp` | 7 | 2025-06-18 | http | 5.2 s | get_categories: ok (2103 car.) |
| Blockscout | `https://mcp.blockscout.com/mcp` | 16 | 2025-06-18 | http | 6.3 s | get_chains_list: erro — Error executing tool get_chains_list: A valid `session_id` i |
| BoardWise | `https://uakozrqrztgrgwoywxkx.supabase.co/functions/v1/mcp-server` | 14 | 2025-06-18 | http | 6.2 s | get_boardwise_capabilities: ok (6225 car.) |
| Brek - Hotel Wholesale Booking | `https://mcp.brek.com/mcp` | 3 | 2025-06-18 | http | 6.2 s | get_accommodation_details: ok (156 car.) |
| ChEMBL | `https://hcls.mcp.claude.com/chembl/mcp` | 6 | 2025-06-18 | http | 6.0 s | get_bioactivity: ok (27010 car.) |
| Civitatis | `https://civitatis-claude-app.civitatis.com/mcp` | 7 | 2025-06-18 | http | 4.2 s | — |
| Clarity AI | `https://clarity-sfdr20-mcp.pro.clarity.ai/mcp` | 6 | 2025-06-18 | http | 4.2 s | — |
| Claude Academy | `https://academy.claude.com/mcp` | 3 | 2025-06-18 | http | 4.1 s | list_content: ok (42607 car.) |
| Clinical Trials | `https://hcls.mcp.claude.com/clinical_trials/mcp` | 6 | 2025-06-18 | http | 4.2 s | search_trials: erro — Invalid params: Error calling tool 'search_trials': At least |
| Clutch.co ✱ | `https://bot.clutch.co/mcp` | 5 | 2025-06-18 | http | 8.3 s | — |
| CMS Coverage | `https://hcls.mcp.claude.com/cms_coverage/mcp` | 7 | 2025-06-18 | http | 13.6 s | sad_exclusion_list: ok (12271 car.) |
| CoinGecko | `https://mcp.coingecko.com/mcp` | 13 | 2025-06-18 | http | 7.4 s | get-categories: ok (5247 car.) |
| CometChat | `https://mcp.cometchat.com/mcp` | 4 | 2025-06-18 | http | 6.2 s | list_cometchat_bundles: ok (1254 car.) |
| Community Funding NZ | `https://funding.alltoohuman.nz/mcp` | 8 | 2025-06-18 | http | 6.4 s | list_filters: ok (1210 car.) |
| Constant Contact ✱ | `https://mcp.apps.constantcontact.com/public_api/mcp` | 18 | 2025-06-18 | http | 16.0 s | public_render_subject_line_score: ok (414 car.) |
| Context7 (documentação atualizada) | `https://mcp.context7.com/mcp` | 2 | 2025-06-18 | http | 5.2 s | — |
| Contract-Factory — Sociétés & SIREN | `https://www.contract-factory.com/mcp.php` | 5 | 2025-06-18 | http | 5.2 s | — |
| Countersignatory | `https://countersignatory.com/mcp` | 5 | 2025-06-18 | http | 4.3 s | countersignatory_spot_index: ok (11088 car.) |
| Coursera ✱ | `https://api.coursera.com/mcp` | 6 | 2025-06-18 | http | 7.2 s | — |
| Courtroom5 | `https://mcp.courtroom5.com/v1` | 3 | 2025-06-18 | http | 2.2 s | — |
| Crypto.com | `https://mcp.crypto.com/market-data/mcp` | 9 | 2025-03-26 | http | 5.5 s | get_tickers: ok (100189 car.) |
| DataCamp ✱ | `https://mcp.datacamp.com/v1/mcp` | 101 | 2025-06-18 | http | 8.4 s | list_technologies: ok (1443 car.) |
| Deel ✱ | `https://api.letsdeel.com/mcp` | 8 | 2025-06-18 | http | 11.3 s | hiring_insights_employment_comparison_list: ok (47 car.) |
| Descrybe Legal Engine ✱ | `https://mcp.descrybe.com/mcp` | 13 | 2025-06-18 | http | 4.6 s | — |
| Dice | `https://mcp.dice.com/mcp` | 3 | 2025-06-18 | http | 5.2 s | — |
| Docfarm ✱ | `https://mcp.doc.farm/` | 22 | 2025-06-18 | http | 12.1 s | list_docs: erro — HTTP 401 em tools/call: {"jsonrpc":"2.0","id":5,"error":{"co |
| Domino's India | `https://genai-prod-ext.dominos.co.in/order-mcp/mcp` | 18 | 2025-06-18 | http | 12.7 s | — |
| Duvo ✱ | `https://api.duvo.ai/v2/mcp` | 399 | 2025-06-18 | http | 13.1 s | listPluginCatalog: erro — HTTP 401 em tools/call: {"jsonrpc":"2.0","error":{"code":-32 |
| Etherscan | `https://mcp-keyless.etherscan.io/mcp` | 17 | 2025-06-18 | http | 7.4 s | get_supported_chains: ok (15483 car.) |
| Exa ✱ | `https://mcp.exa.ai/mcp` | 2 | 2025-06-18 | http | 9.7 s | — |
| Excalidraw | `https://mcp.excalidraw.com/mcp` | 5 | 2025-06-18 | http | 4.2 s | — |
| Fourthwall ✱ | `https://mcp.fourthwall.com/app` | 143 | 2025-06-18 | http | 12.8 s | ecommerce_get-payout-info: erro — Sign in to Fourthwall to use this tool. |
| Gemini ✱ | `https://api.gemini.com/mcp` | 19 | 2025-06-18 | http | 7.5 s | gemini_auth_status: ok (1336 car.) |
| Gmail ✱ | `https://gmailmcp.googleapis.com/mcp/v1` | 23 | 2025-06-18 | http | 5.5 s | — |
| GoDaddy | `https://api.godaddy.com/v1/domains/mcp` | 2 | 2025-06-18 | http | 5.3 s | — |
| Goodnotes | `https://claude-mcp-api.ml.goodnotes.com/mcp` | 3 | 2025-06-18 | http | 5.2 s | — |
| Google Calendar ✱ | `https://calendarmcp.googleapis.com/mcp/v1` | 9 | 2025-06-18 | http | 5.6 s | list_events: erro — HTTP 401 em tools/call: {"id":3,"jsonrpc":"2.0","result":{"c |
| Google Cloud BigQuery ✱ | `https://bigquery.googleapis.com/mcp` | 9 | 2025-06-18 | http | 3.3 s | — |
| Google Compute Engine ✱ | `https://compute.googleapis.com/mcp` | 29 | 2025-06-18 | http | 6.1 s | — |
| Google Docs ✱ | `https://docsmcp.googleapis.com/mcp/v1` | 2 | 2025-06-18 | http | 4.0 s | — |
| Google Drive ✱ | `https://drivemcp.googleapis.com/mcp/v1` | 8 | 2025-06-18 | http | 9.3 s | — |
| Google Sheets ✱ | `https://sheetsmcp.googleapis.com/mcp/v1` | 6 | 2025-06-18 | http | 5.2 s | — |
| Google Slides ✱ | `https://slidesmcp.googleapis.com/mcp/v1` | 4 | 2025-06-18 | http | 6.1 s | — |
| Granted | `https://grantedai.com/api/mcp/mcp` | 5 | 2025-06-18 | http | 6.3 s | search_funders: erro — Please provide at least one search criterion (query, state, |
| GraphOS MCP Tools ✱ | `https://mcp.apollographql.com/` | 48 | 2025-06-18 | http | 6.7 s | ApolloConnectorsSpec: ok (43173 car.) |
| Have I Been Pwned ✱ | `https://haveibeenpwned.com/mcp` | 17 | 2025-06-18 | http | 10.2 s | hibp_list_breaches: ok (948 car.) |
| Hugging Face ✱ | `https://huggingface.co/mcp` | 4 | 2025-06-18 | http | 8.2 s | — |
| ICD-10 Codes | `https://hcls.mcp.claude.com/icd10_codes/mcp` | 6 | 2025-06-18 | http | 4.2 s | get_by_category: erro — Invalid params: Error calling tool 'get_by_category': Must p |
| InfiniteWatch MCP ✱ | `https://mcp.infinitewatch.ai/mcp` | 8 | 2025-06-18 | http | 7.3 s | get_insights: erro — HTTP 401 em tools/call: {"jsonrpc":"2.0","error":{"code":-32 |
| Infobip Documentation | `https://mcp.infobip.com/search` | 1 | 2025-06-18 | http | 13.5 s | — |
| Insight Timer | `https://claude-connector-api.insighttimer-api.net/mcp` | 2 | 2025-06-18 | http | 4.2 s | — |
| Jentic ✱ | `https://api.jentic.com/mcp` | 4 | 2025-06-18 | http | 12.2 s | — |
| Kindora Funder Discovery | `https://mcp.kindora.co/mcp` | 17 | 2025-06-18 | http | 7.3 s | health_check: ok (221 car.) |
| Kiwi.com | `https://mcp.kiwi.com/` | 2 | 2025-06-18 | http | 5.7 s | — |
| komoot ✱ | `https://claude.main.komoot.net/mcp` | 13 | 2025-06-18 | http | 9.5 s | connect_komoot: ok (205 car.) |
| Lawstronaut ✱ | `https://mcp.lawstronaut.com/` | 16 | 2025-06-18 | http | 7.0 s | list_jurisdictions: erro — HTTP 401 em tools/call: {"jsonrpc":"2.0","error":{"code":-32 |
| Lightbringer ✱ | `https://mcp.lightbringer.com/mcp` | 37 | 2025-06-18 | http | 10.5 s | list_innovations: erro — HTTP 401 em tools/call: {"error":"invalid_token","error_desc |
| Malwarebytes | `https://scamguard.malwarebytes.com/claude/mcp` | 6 | 2025-06-18 | http | 5.2 s | — |
| Mastercard Developers | `https://developer.mcp.mastercard.com/` | 9 | 2025-06-18 | http | 5.5 s | get-services-list: ok (100189 car.) |
| Melon | `https://mcp.melon.com/mcp/` | 18 | 2025-06-18 | http | 6.3 s | get_genres: ok (548 car.) |
| Mermaid Chart | `https://chatgpt.mermaid.ai/anthropic/mcp` | 1 | 2025-06-18 | http | 4.2 s | — |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | 3 | 2025-06-18 | http | 7.0 s | — |
| Military and Veteran Family Assistant | `https://milfam.mcp.claude.com/mcp` | 3 | 2025-06-18 | http | 3.2 s | search_programs: ok (83 car.) |
| MoSPI | `https://mcp.mospi.gov.in/` | 4 | 2025-06-18 | http | 7.3 s | list_datasets: ok (25664 car.) |
| NPI Registry | `https://hcls.mcp.claude.com/npi_registry/mcp` | 3 | 2025-06-18 | http | 5.2 s | npi_search: ok (49 car.) |
| Open Targets | `https://mcp.platform.opentargets.org/mcp` | 5 | 2025-06-18 | http | 5.4 s | — |
| Order by Cash App | `https://connect.squareup.com/v2/mcp/cash-app` | 5 | 2025-11-25 | http | 6.0 s | — |
| Parallel Search | `https://search.parallel.ai/mcp` | 2 | 2025-06-18 | http | 6.0 s | — |
| Paybooc | `https://open.paybooc.co.kr/pybc/api/mcp/shopping/claude` | 1 | 2025-06-18 | http | 5.1 s | — |
| PDF Viewer ✱ | `https://example-server.modelcontextprotocol.io/pdf/mcp` | 4 | 2025-06-18 | http | 9.2 s | — |
| pg-aiguide | `https://mcp.tigerdata.com/docs` | 2 | 2025-06-18 | http | 3.2 s | — |
| PGA – Play Golf ✱ | `https://mcp.pga.com/mcp` | 4 | 2025-06-18 | http | 7.1 s | — |
| Play Sheet Music ✱ | `https://example-server.modelcontextprotocol.io/sheet-music/mcp` | 1 | 2025-06-18 | http | 10.4 s | — |
| PopHIVE | `https://mcp.pophive.org/mcp` | 7 | 2025-06-18 | http | 13.6 s | get_overview: ok (6925 car.) |
| PubMed | `https://pubmed.mcp.claude.com/mcp` | 7 | 2025-06-18 | http | 2.2 s | — |
| Ramp Data ✱ | `https://mcp.ramp.com/ramp-data/anthropic/mcp` | 9 | 2025-06-18 | http | 7.2 s | — |
| Ratehub Mortgage | `https://api.ratehub.ca/claude-app/mortgages/mcp` | 4 | 2025-06-18 | http | 4.2 s | — |
| Shopify ✱ | `https://setup.shopify.com/mcp` | 37 | 2025-06-18 | http | 5.2 s | get-digital-products-install-status: erro — HTTP 401 em tools/call: {"result":{"content":[{"type":"text" |
| Shutterstock | `https://www.shutterstock.com/cciq/mcp` | 1 | 2025-06-18 | http | 4.5 s | — |
| SlickTrip ✱ | `https://mcp.slicktrip.com/mcp` | 38 | 2025-06-18 | http | 9.3 s | list_tracked_flights: erro — HTTP 401 em tools/call: {"error": "invalid_token", "error_de |
| SlidesGPT | `https://claude.slidesgpt.com/mcp` | 2 | 2025-06-18 | http | 4.2 s | — |
| Snagajob | `https://platform.jobget.com/jobs-mcp/mcp` | 2 | 2025-06-18 | http | 4.2 s | — |
| SNOMED CT Terminology | `https://snowstorm-mcp.snomedtools.org/mcp` | 15 | 2025-06-18 | http | 6.2 s | list_terminologies: ok (4773 car.) |
| Sprouts Data Intelligence ✱ | `https://sprouts-mcp-server.kartikay-dhar.workers.dev/` | 22 | 2025-06-18 | http | 8.3 s | — |
| Super.com | `https://www.super.com/travel/mcp` | 4 | 2025-06-18 | http | 7.2 s | get_experiences_for_city: erro — Error calling tool 'get_experiences_for_city': Error buildin |
| Taskrabbit Booking Assistance | `https://mcp.taskrabbit.com/mcp` | 3 | 2025-06-18 | http | 3.2 s | list_supported_services: erro — Please provide either city + state or a postal code. |
| TaxAct | `https://mcp.taxact.com/mcp` | 8 | 2025-06-18 | http | 4.2 s | connect_with_expert: ok (665 car.) |
| Three.js 3D Viewer ✱ | `https://example-server.modelcontextprotocol.io/threejs/mcp` | 2 | 2025-06-18 | http | 9.2 s | — |
| Tineo ✱ | `https://api.tineo.ai/mcp/claude` | 109 | 2025-06-18 | http | 8.3 s | tineo_ping: erro — HTTP 401 em tools/call: {"jsonrpc":"2.0","id":5,"error":{"co |
| Tixel | `https://mcp-v1.tixel.com/mcp` | 7 | 2025-06-18 | http | 10.6 s | list_supported_cities: ok (100190 car.) |
| tldraw | `https://tldraw-mcp-app.tldraw.workers.dev/mcp` | 6 | 2025-06-18 | http | 6.5 s | — |
| Tomorrow.io Weather MCP App | `https://api.tomorrow.io/v4/weather-intelligence/mcp` | 9 | 2025-06-18 | http | 6.2 s | tio_mcp_apps_list_widgets: ok (2228 car.) |
| TravExp | `https://travexpserver-1-5480123242.us-central1.run.app/mcp-standard` | 2 | 2025-06-18 | http | 4.2 s | — |
| Tripadvisor | `https://production.ai-mcp-extensibility-prd.tamg.cloud/ogMvjY4De1G7CiHanMOAgddl/mcp` | 3 | 2025-06-18 | http | 5.2 s | — |
| Trivago | `https://mcp.trivago.com/mcp` | 3 | 2025-06-18 | http | 5.1 s | — |
| Tseha.io ✱ | `https://tseha.io/mcp` | 9 | 2024-11-05 | http | 7.5 s | — |
| Twilio | `https://mcp.twilio.com/docs` | 2 | 2025-06-18 | http | 2.2 s | — |
| USAFacts Government Data Connector | `https://data.mcp.usafacts.org/mcp` | 4 | 2025-06-18 | http | 7.3 s | list_sources: ok (18324 car.) |
| Veltra Activities ✱ | `https://ai.veltra.com/veltra/mcp` | 1 | 2025-06-18 | http | 8.2 s | — |
| Viator | `https://exp-app-mcp.prod.ep.viator.com/mcp` | 2 | 2025-06-18 | http | 4.2 s | — |
| Vuetify MCP | `https://mcp.vuetifyjs.com/mcp` | 28 | 2025-06-18 | http | 7.4 s | get_vuetify_api_by_version: ok (36 car.) |
| Website Generator by B12 | `https://mcp.b12.io/mcp` | 1 | 2025-06-18 | http | 5.2 s | — |
| Wolfram | `https://agenttools.wolfram.com/mcp` | 3 | 2025-03-26 | http | 4.0 s | — |
| Zillow | `https://mcp.zillow.com/api/v2` | 9 | 2025-06-18 | http | 5.3 s | — |

## Prontos para o login de 1 clique (517)

O ensaio (`connect(id, { dryRun })`) descobriu o servidor de autorização, fez um registro dinâmico descartável e montou a URL de autorização com PKCE S256 e o `redirectUri` fixo `http://127.0.0.1:38565/callback`. Falta só o usuário entrar com a conta (N5).

| Conector | Endpoint | Servidor de autorização | Também abre sem login | Tempo |
|---|---|---|---|---|
| Abency | `https://app.abency.com/mcp` | app.abency.com |  | 4.7 s |
| Actively | `https://api.actively.ai/mcp` | auth.actively.ai |  | 2.8 s |
| Addepar MCP | `https://mcp.addepar.com/` | mcp.addepar.com |  | 4.2 s |
| Addgene | `https://mcp-server.addgene.org/mcp` | mcp-server.addgene.org |  | 3.2 s |
| AdisInsight | `https://adisinsight-mcp.springer.com/mcp` | adisinsight-mcp.springer.com |  | 3.4 s |
| ADITUS Evo | `https://mcp.aditus.com/mcp` | mcp.aditus.com |  | 4.4 s |
| Adobe | `https://adobe-creativity.adobe.io/mcp` | ims-na1.adobelogin.com |  | 3.6 s |
| Adobe Customer Journey Analytics | `https://cja-mcp.adobe.io/mcp` | ims-na1.adobelogin.com |  | 3.8 s |
| Adobe CX Enterprise Coworker | `https://mcp.coworker.experience.adobe.io/` | mcp.coworker.experience.adobe.io |  | 3.2 s |
| Adobe Experience Manager | `https://mcp.adobeaemcloud.com/adobe/mcp/aem` | oauth.adobeaemcloud.com |  | 3.2 s |
| Adobe Journey Optimizer | `https://ajo-mcp.adobe.io/mcp` | ims-na1.adobelogin.com |  | 4.0 s |
| Adobe Workfront | `https://mcp.workfront.adobe.com/mcp/v1/workfront` | mcp.workfront.adobe.com |  | 3.2 s |
| Adspirer Ads & Performance Marketing Agent | `https://mcp.adspirer.com/mcp` | mcp.adspirer.com |  | 8.2 s |
| Adspirer Search Ads | `https://mcp.adspirer.com/search-ads` | mcp.adspirer.com |  | 10.1 s |
| Adspirer Social Ads | `https://mcp.adspirer.com/social-ads` | mcp.adspirer.com |  | 10.6 s |
| AdWhispr Ads | `https://adwhispr.com/api/claude/mcp` | adwhispr.com |  | 3.2 s |
| AfterShip Channels for TikTok Shop | `https://mcp.aftership.com/channels` | accounts.aftership.com |  | 3.4 s |
| AfterShip Post-Purchase | `https://mcp.aftership.com/post-purchase` | accounts.aftership.com |  | 5.8 s |
| AgentMail | `https://mcp.agentmail.to/mcp` | clerk.console.agentmail.to |  | 2.5 s |
| Agility CMS | `https://mcp.agilitycms.com/api/mcp` | mcp.agilitycms.com |  | 4.2 s |
| agri-mcp.tcit.cl | `https://agri-mcp.tcit.cl/mcp` | accounts.tcit.cl |  | 3.3 s |
| Ahrefs | `https://api.ahrefs.com/mcp/mcp` | app.ahrefs.com |  | 3.6 s |
| AI Producer by OpusClip | `https://producer.opus.pro/api/mcp` | producer.opus.pro |  | 3.2 s |
| Aiera | `https://mcp-pub.aiera.com/` | mcp-pub.aiera.com |  | 3.6 s |
| AirOps | `https://app.airops.com/mcp` | app.airops.com |  | 3.3 s |
| Airtable | `https://mcp.airtable.com/mcp` | airtable.com |  | 2.4 s |
| Airwallex Developer | `https://mcp-demo.airwallex.com/developer` | mcp-demo.airwallex.com |  | 3.6 s |
| Aleph | `https://mcp.getaleph.com/mcp` | getaleph.us.auth0.com |  | 2.9 s |
| Alma | `https://mcp.alma.food/` | mcp.alma.food |  | 3.2 s |
| Alpha Vantage MCP Server | `https://mcp.alphavantage.co/mcp` | mcp.alphavantage.co |  | 3.2 s |
| alphaXiv | `https://api.alphaxiv.org/mcp/v1` | api.alphaxiv.org |  | 3.3 s |
| Alpic | `https://mcp.alpic.ai/mcp` | mcp.alpic.ai |  | 4.4 s |
| Amass Connector | `https://mcp.amass.tech/mcp` | app.amass.tech |  | 4.4 s |
| AngelList | `https://mcp.angellist.com/mcp` | auth.angellist.com |  | 2.5 s |
| AnythingMCP | `https://cloud.anythingmcp.com/mcp` | cloud.anythingmcp.com |  | 3.3 s |
| Apollo.io | `https://mcp.apollo.io/mcp` | mcp.apollo.io |  | 3.5 s |
| Asana (oficial) | `https://mcp.asana.com/sse` | mcp.asana.com |  | 6.0 s |
| Ashby | `https://mcp.ashbyhq.com/mcp/v1` | mcp-auth.ashbyhq.com |  | 2.3 s |
| Astravue App | `https://api.astravue.com/mcp` | api.astravue.com |  | 3.4 s |
| AthenaHQ | `https://api.athenahq.ai/api/mcp` | api.athenahq.ai | sim | 9.3 s |
| atlasFindings | `https://api.esentire.com/mcp/rpc` | esentire.okta.com |  | 4.3 s |
| Atlassian (Jira + Confluence, oficial) | `https://mcp.atlassian.com/v2/mcp` | auth.atlassian.com |  | 4.9 s |
| Attention | `https://api.attention.tech/mcp` | api.attention.tech |  | 3.3 s |
| Attio | `https://mcp.attio.com/mcp` | app.attio.com |  | 2.6 s |
| august | `https://mcp.getaugust.ai/mcp` | login.getaugust.ai |  | 2.8 s |
| Aurora | `https://mcp.ai.consilio.com/` | auth.ai.consilio.com |  | 2.4 s |
| AUTONOMAD | `https://mcp.autonomad.ai/mcp` | mcp.autonomad.ai | sim | 9.2 s |
| Autosheet | `https://mcp.autosheet.com/mcp` | mcp.autosheet.com | sim | 6.2 s |
| Badger Maps (Standard) | `https://mcp.badgermapping.com/mcp` | mcp.badgermapping.com |  | 4.4 s |
| Base44 | `https://app.base44.com/mcp` | app.base44.com |  | 3.2 s |
| beehiiv | `https://mcp.beehiiv.com/mcp` | mcp.beehiiv.com |  | 3.2 s |
| Belvo MCP | `https://panorama-mcp.belvo.com/mcp` | auth.panorama.belvo.com |  | 2.5 s |
| BiggerPockets | `https://www.biggerpockets.com/mcp` | www.biggerpockets.com |  | 4.2 s |
| BillingMart | `https://api.billingmart.com/mcp` | api.billingmart.com |  | 3.5 s |
| BioRender | `https://mcp.services.biorender.com/mcp` | mcp.services.biorender.com |  | 4.2 s |
| Bird | `https://mcp.bird.com/` | platform.bird.com |  | 2.5 s |
| Bitly | `https://api-ssl.bitly.com/v4/mcp` | bitly.com |  | 4.2 s |
| Bitmovin | `https://mcp.bitmovin.com/` | mcp.bitmovin.com |  | 3.4 s |
| Blackthorn Forge MCP for Native Salesforce Event Management | `https://forge.blackthorn.io/api/mcp` | forge.blackthorn.io |  | 3.2 s |
| Blaze SQL | `https://claude.blazesql.com/` | claude.blazesql.com |  | 3.3 s |
| Bling MCP | `https://mcp.bling.com.br/mcp` | mcp.bling.com.br |  | 4.2 s |
| bolna | `https://mcp.bolna.ai/api/connector/mcp` | hbcyinehbjcanmnqywtg.supabase.co |  | 2.7 s |
| Bonsai | `https://mcp.hellobonsai.com/mcp` | app.hellobonsai.com |  | 2.5 s |
| Botify MCP | `https://mcp.botify.com/` | app.botify.com |  | 3.0 s |
| Brand24 | `https://mcp.brand24.com/v1/mcp` | oauth.brand24.com |  | 3.0 s |
| Brandfetch | `https://mcp.brandfetch.io/mcp` | developers.brandfetch.com |  | 3.2 s |
| Breezing | `https://mcp.breezing.io/mcp` | mcp.breezing.io |  | 3.4 s |
| Breezy HR MCP | `https://mcp.breezy.hr/mcp` | oauth.breezy.hr |  | 3.3 s |
| Brevo | `https://mcp.brevo.com/v1/anthropic/mcp` | mcp.brevo.com |  | 6.4 s |
| Brex | `https://api.brex.com/mcp` | accounts-api.brex.com |  | 5.2 s |
| Brightcove | `https://mcp.brightcove.com/mcp` | oauth.brightcove.com |  | 2.4 s |
| Brightdeck | `https://api.brightdeck.ai/mcp` | api.brightdeck.ai |  | 3.3 s |
| BrightHire | `https://app.brighthire.ai/mcp/v1` | app.brighthire.ai |  | 3.2 s |
| Brisk Teaching | `https://mcp.briskteaching.com/mcp` | connect.briskteaching.com |  | 2.5 s |
| Calendly | `https://mcp.calendly.com/` | calendly.com |  | 4.4 s |
| Candid | `https://mcp.candid.org/mcp` | mcp.candid.org |  | 3.2 s |
| Canva | `https://mcp.canva.com/mcp` | mcp.canva.com |  | 3.4 s |
| CargoAi | `https://api.cargoai.co/mcp` | api.cargoai.co |  | 3.6 s |
| Carta | `https://mcp.app.carta.com/mcp` | mcp.app.carta.com |  | 3.2 s |
| CB Insights | `https://mcp.cbinsights.com/` | mcp.cbinsights.com |  | 3.2 s |
| CData Connect AI | `https://mcp.cloud.cdata.com/mcp` | mcp.cloud.cdata.com |  | 3.2 s |
| ChartMogul | `https://mcp.chartmogul.com/` | mcp.chartmogul.com |  | 3.3 s |
| Chaser | `https://api.trychaser.com/mcp` | api.trychaser.com |  | 4.2 s |
| Chatbase | `https://mcp.chatbase.co/api/mcp` | www.chatbase.co |  | 3.4 s |
| Checkout.com | `https://mcp.checkout.com/` | access.mcp.checkout.com |  | 3.4 s |
| Chronograph | `https://ai.chronograph.pe/mcp` | ai.chronograph.pe |  | 3.2 s |
| Circleback | `https://circleback.ai/api/mcp` | circleback.ai |  | 3.3 s |
| CircleCI | `https://mcp.circleci.com/v1/mcp` | app.circleci.com |  | 2.5 s |
| Clarify | `https://api.clarify.ai/mcp` | auth1.clarify.ai |  | 2.6 s |
| Claude Motion to Mirage | `https://mcp.mirage.app/claude-motion` | auth-mcp.mirage.app |  | 2.4 s |
| Clay | `https://api.clay.com/v3/mcp` | app.clay.com |  | 3.5 s |
| Clerk | `https://mcp.clerk.com/mcp` | clerk.clerk.com |  | 2.4 s |
| Clerq MCP | `https://mcp.us.clerq-ip.com/mcp` | api.clerq-ip.com |  | 2.5 s |
| ClickHouse | `https://mcp.clickhouse.cloud/mcp` | mcp.clickhouse.cloud |  | 3.2 s |
| ClickUp | `https://mcp.clickup.com/mcp` | mcp.clickup.com |  | 3.2 s |
| Close | `https://mcp.close.com/mcp` | app.close.com |  | 2.5 s |
| Cloudflare Developer Platform | `https://bindings.mcp.cloudflare.com/mcp` | bindings.mcp.cloudflare.com |  | 3.5 s |
| Cloudinary | `https://asset-management.mcp.cloudinary.com/sse` | asset-management.mcp.cloudinary.com |  | 3.2 s |
| CodeWords | `https://runtime.codewords.ai/run/devx_mcp/mcp` | codewords.agemo.ai |  | 2.5 s |
| CoinDesk | `https://mcp.coindesk.com/mcp` | mcp.coindesk.com |  | 5.2 s |
| CoinMarketCap | `https://mcp.coinmarketcap.com/mcp` | coinmarketcap.com |  | 3.4 s |
| Coinversa Pulse | `https://mcp.coinversa.ai/mcp` | mcp.coinversa.ai |  | 3.5 s |
| ComfyUi | `https://cloud.comfy.org` | cloud.comfy.org |  | 5.3 s |
| Common Room | `https://mcp.commonroom.io/mcp` | login.commonroom.io |  | 2.5 s |
| Consensus | `https://mcp.consensus.app/mcp` | consensus.app |  | 2.4 s |
| Contentful MCP | `https://mcp.contentful.com/mcp` | mcp.contentful.com |  | 3.5 s |
| Contentsquare | `https://api.contentsquare.com/mcp` | app.contentsquare.com |  | 3.3 s |
| Control Plane | `https://mcp.cpln.io/mcp` | auth.cpln.io |  | 2.4 s |
| Cortellis CMC Intelligence | `https://api.clarivate.com/lifesciences/mcp-cmc/mcp` | api.clarivate.com |  | 3.3 s |
| Coteach | `https://coteach.ai/api/mcp` | coteach.ai |  | 3.2 s |
| Coupler.io | `https://mcp.coupler.io/mcp/` | auth.coupler.io |  | 2.7 s |
| CourtListener | `https://mcp.courtlistener.com/` | mcp.courtlistener.com |  | 3.6 s |
| Craft | `https://mcp.craft.do/my/mcp` | mcp.craft.do |  | 3.2 s |
| Crossbeam | `https://mcp.crossbeam.com/` | mcp.crossbeam.com |  | 3.7 s |
| Crustdata | `https://mcp.crustdata.com/mcp` | mcp.crustdata.com |  | 3.3 s |
| Cube Software | `https://mcp.cubesoftware.com/` | mcp.cubesoftware.com |  | 3.2 s |
| D&B Hoovers | `https://mcp.hoovers.dnb.com/mcp` | mcp.hoovers.dnb.com |  | 3.2 s |
| Daloopa | `https://mcp.daloopa.com/server/mcp` | mcp.daloopa.com |  | 4.4 s |
| DataCamp | `https://mcp.datacamp.com/v1/mcp` | auth.datacamp.com | sim | 8.4 s |
| DataHub | `https://mcp.datahub.com/mcp` | mcp.datahub.com |  | 3.4 s |
| Datarails FinanceOS | `https://mcp.datarails.com/mcp` | mcp.datarails.com |  | 3.2 s |
| Day AI | `https://day.ai/api/mcp` | day.ai |  | 3.2 s |
| DeepL | `https://mcp.deepl.com/v1/mcp` | mcp.deepl.com |  | 4.5 s |
| Definely | `https://mcp.app.definely.com/` | mcp.app.definely.com |  | 4.2 s |
| Demographic and Health Surveys | `https://api.dhsprogram.com/mcp` | api.dhsprogram.com |  | 3.2 s |
| Descript | `https://api.descript.com/v2/mcp/claude` | web.descript.com |  | 2.8 s |
| Descrybe Legal Engine | `https://mcp.descrybe.com/mcp` | api.descrybe.com | sim | 4.6 s |
| DevRev | `https://api.devrev.ai/mcp/v1` | auth.devrev.ai |  | 3.2 s |
| Dext | `https://app.dext.com/mcp` | app.dext.com |  | 3.3 s |
| Digits | `https://api.digits.com/mcp` | api.digits.com |  | 4.2 s |
| Docfarm | `https://mcp.doc.farm/` | mcp.doc.farm | sim | 12.1 s |
| docsend.com | `https://docsend.com/mcp` | docsend.com |  | 3.2 s |
| dot. | `https://mcp.leaveadot.com/mcp` | mcp.leaveadot.com |  | 3.2 s |
| Drata | `https://mcp.drata.com/mcp` | mcp.drata.com |  | 9.7 s |
| Dropbox | `https://mcp.dropbox.com/claude_app_mcp` | www.dropbox.com |  | 2.4 s |
| DualEntry | `https://api.dualentry.com/mcp` | api.dualentry.com |  | 8.0 s |
| Duvo | `https://api.duvo.ai/v2/mcp` | login.duvo.ai | sim | 13.1 s |
| Egnyte | `https://mcp-server.egnyte.com/mcp` | mcp-oauth.egnyte.com |  | 8.0 s |
| Elfcare | `https://patient.elf.care/api/mcp` | patient.elf.care |  | 9.7 s |
| Elicit | `https://elicit.com/api/mcp` | elicit.com |  | 3.2 s |
| Embat | `https://tellme.embat.io/mcp` | complete-book-76.authkit.app |  | 2.7 s |
| Energy Aspects | `https://mcp.energyaspects.com/mcp` | mcp.energyaspects.com |  | 3.4 s |
| Entendre | `https://mcp.entendre.finance/api/mcp` | api.entendre.finance |  | 4.0 s |
| Enterpret | `https://wisdom-api.enterpret.com/server/mcp` | oauth.enterpret.com |  | 3.4 s |
| Era Context | `https://context.era.app/` | context.era.app |  | 3.2 s |
| Eraser | `https://app.eraser.io/api/mcp` | app.eraser.io |  | 3.2 s |
| EULER | `https://mcp.eulerapp.com/mcp` | mcp.eulerapp.com |  | 5.1 s |
| Evernote | `https://mcp.evernote.com/mcp` | accounts.evernote.com |  | 2.4 s |
| Exa | `https://mcp.exa.ai/mcp` | auth.exa.ai | sim | 9.7 s |
| Expensify | `https://www.expensify.com/mcp` | www.expensify.com |  | 3.3 s |
| Expo | `https://mcp.expo.dev/mcp` | mcp.expo.dev |  | 3.4 s |
| Extend | `https://mcp.extend.ai/mcp` | id.extend.ai |  | 2.5 s |
| FactSet AI-Ready Data | `https://mcp.factset.com/content/v1` | auth.factset.com |  | 2.4 s |
| Fastmail | `https://api.fastmail.com/mcp` | api.fastmail.com |  | 3.7 s |
| Fathom – Your Meeting Intelligence Layer | `https://api.fathom.ai/mcp` | fathom.video |  | 3.2 s |
| Fellow.ai | `https://fellow.app/mcp` | fellow.app |  | 4.2 s |
| Felt Maps | `https://felt.com/mcp` | felt.com |  | 3.3 s |
| Fever Event Discovery | `https://data-search.apigw.feverup.com/mcp` | data-search.apigw.feverup.com |  | 3.3 s |
| Fibery | `https://mcp.fibery.io/mcp` | mcp.fibery.io |  | 3.2 s |
| Financial Datasets | `https://mcp.financialdatasets.ai/` | mcp.financialdatasets.ai |  | 3.5 s |
| Find Your Great | `https://findyourgreat.com/mcp/v1` | findyourgreat.com |  | 4.2 s |
| Firecrawl | `https://mcp.firecrawl.dev/v2/mcp-search` | www.firecrawl.dev |  | 2.4 s |
| Fireflies | `https://api.fireflies.ai/mcp` | api.fireflies.ai |  | 3.2 s |
| Fiscal.ai | `https://api.fiscal.ai/mcp/sse` | api.fiscal.ai |  | 3.5 s |
| Flexport | `https://mcp.flexport.com/mcp` | mcp.flexport.com |  | 3.5 s |
| Floot | `https://mcp.floot.com/mcp` | floot.com |  | 3.4 s |
| Flourish | `https://app.flourish.studio/mcp` | app.flourish.studio |  | 4.3 s |
| Fourthwall | `https://mcp.fourthwall.com/app` | mcp.fourthwall.com | sim | 12.8 s |
| freee | `https://mcp.freee.co.jp/mcp` | mcp.freee.co.jp |  | 4.6 s |
| Frontify | `https://mcp.frontify-integrations.com/mcp` | mcp.frontify-integrations.com |  | 3.2 s |
| Fullstory | `https://api.fullstory.com/mcp/fullstory` | auth.fullstory.com |  | 2.4 s |
| Fyxer | `https://app.fyxer.com/mcp` | app.fyxer.com |  | 4.3 s |
| Gainsight (Customer Communities) | `https://mcp.insided.com/mcp` | mcp.insided.com |  | 3.5 s |
| Gainsight (Staircase AI) | `https://mcp.staircase.ai/mcp` | mcp.staircase.ai |  | 3.2 s |
| Gamma | `https://mcp.gamma.app/mcp` | auth.gamma.app |  | 3.3 s |
| Gem | `https://mcp.gem.com/mcp` | www.gem.com |  | 4.3 s |
| General Legal | `https://mcp.general.legal/mcp` | clerk.general.legal |  | 2.5 s |
| GIS Cloud | `https://mcp.giscloud.com/mcp` | mcp.giscloud.com |  | 3.2 s |
| Givebutter | `https://mcp.givebutter.com/mcp` | auth.givebutter.com |  | 3.6 s |
| GLG | `https://mcp.glgresearch.com/myglg/mcp` | mcp.glgresearch.com |  | 4.8 s |
| GoCardless | `https://mcp.gocardless.com/` | mcp.gocardless.com |  | 3.3 s |
| GovTribe | `https://govtribe.com/mcp` | govtribe.com |  | 3.3 s |
| Grafana Cloud | `https://mcp.grafana.com/mcp` | mcp.grafana.com |  | 3.1 s |
| Grain | `https://api.grain.com/_/mcp` | grain.com |  | 4.2 s |
| Granola | `https://mcp.granola.ai/mcp` | mcp-auth.granola.ai |  | 2.5 s |
| GraphOS MCP Tools | `https://mcp.apollographql.com/` | auth.apollographql.com | sim | 6.7 s |
| Grasp | `https://app.grasp-ai.com/mcp` | auth.grasp-ai.com |  | 3.4 s |
| Greenhouse | `https://mcp.greenhouse.io/mcp` | auth.greenhouse.io |  | 4.1 s |
| GrowSurf | `https://mcp.growsurf.com/` | mcp.growsurf.com |  | 3.3 s |
| grtwo-docs | `https://www.grtwo.app/api/mcp` | www.grtwo.app |  | 4.0 s |
| Guru | `https://mcp.api.getguru.com/mcp` | mcp.api.getguru.com |  | 3.3 s |
| Gusto | `https://mcp.api.gusto.com/anthropic` | mcp.api.gusto.com |  | 3.3 s |
| Haloo Trademark Clearance | `https://connect.haloo.ai/trademark-search/mcp` | my.haloo.ai |  | 5.4 s |
| Hanover Park | `https://app.hanoverpark.com/api/mcp` | db.hanoverpark.com |  | 3.0 s |
| Harmonic | `https://mcp.api.harmonic.ai/` | login.harmonic.ai |  | 2.7 s |
| Have I Been Pwned | `https://haveibeenpwned.com/mcp` | haveibeenpwned.com | sim | 10.2 s |
| Health Data Avatar (HDA) | `https://hda-mcp.healthdataavatar.com/mcp` | hda-mcp.healthdataavatar.com |  | 3.3 s |
| Helena by Enrich Labs | `https://agent.enrichlabs.ai/api/mcp` | agent.enrichlabs.ai |  | 4.4 s |
| Helium 10 | `https://mcp.helium10.com/mcp` | members.helium10.com |  | 2.4 s |
| Honeycomb | `https://mcp.honeycomb.io/mcp` | ui.honeycomb.io |  | 2.4 s |
| Hugging Face | `https://huggingface.co/mcp` | huggingface.co | sim | 8.2 s |
| HyperFrames by HeyGen | `https://mcp.heygen.com/mcp/hyperframes` | api2.heygen.com |  | 2.5 s |
| IBISWorld | `https://mcp.ibisworld.com/` | mcp.ibisworld.com |  | 3.4 s |
| Idiolect | `https://idiolect.app/api/mcp` | idiolect.scalekit.com |  | 3.2 s |
| IFTTT | `https://ifttt.com/mcp` | ifttt.com |  | 4.2 s |
| IHME GBD | `https://gbdmcp.healthdata.org/mcp` | gbdmcp.healthdata.org |  | 4.7 s |
| incident.io | `https://mcp.incident.io/mcp` | app.incident.io |  | 3.3 s |
| Indeed | `https://mcp.indeed.com/claude/mcp` | secure.indeed.com |  | 2.4 s |
| Inductive Bio | `https://api.inductive.bio/mcp` | beloved-emotion-53.authkit.app |  | 2.4 s |
| InfiniteWatch MCP | `https://mcp.infinitewatch.ai/mcp` | mcp.infinitewatch.ai | sim | 7.3 s |
| Infobip Message | `https://mcp.infobip.com/message` | mcp.infobip.com |  | 13.2 s |
| Inkbox | `https://inkbox.ai/mcp/anthropic` | inkbox.ai |  | 3.3 s |
| Interactive Brokers (IBKR) | `https://api.ibkr.com/v1/api/mcp` | api.ibkr.com |  | 4.6 s |
| Intercom | `https://mcp.intercom.com/mcp` | mcp.intercom.com |  | 3.5 s |
| Intuit Mailchimp | `https://ai-inc.mailchimp.com/claude/mcp/v2` | ai-inc.mailchimp.com |  | 3.3 s |
| item | `https://mcp.item.app/mcp` | prhdwzavzsbpybmhvbip.supabase.co |  | 3.1 s |
| iubenda: Privacy policy & cookie banner | `https://mcp-server.iubenda.com/mcp` | www.iubenda.com |  | 3.6 s |
| Jam | `https://mcp.jam.dev/mcp` | api.jam.dev |  | 3.6 s |
| Jasper | `https://mcp.jasper.ai/` | api.jasper.ai |  | 3.5 s |
| Jedify | `https://be.jedify.com/mcp` | auth.app.jedify.com |  | 2.4 s |
| Jentic | `https://api.jentic.com/mcp` | api.jentic.com | sim | 12.2 s |
| Jotform | `https://mcp.jotform.com/mcp-app` | oauth2.jotform.com |  | 4.4 s |
| Jotform App Builder | `https://mcp.jotform.com/mcp-jotform-apps-v1` | oauth2.jotform.com |  | 7.4 s |
| Jotform Sign | `https://mcp.jotform.com/mcp-sign-v1` | oauth2.jotform.com |  | 8.4 s |
| Jump | `https://my.jumpapp.com/mcp` | my.jumpapp.com |  | 3.2 s |
| Kahoot! | `https://mcp.kahoot.it/mcp` | mcp.kahoot.it |  | 3.2 s |
| Kajabi | `https://mcp.kajabi.com/mcp` | mcp.kajabi.com |  | 4.3 s |
| Ketryx | `https://app.ketryx.com/api/mcp` | app.ketryx.com |  | 2.7 s |
| Kick | `https://use.kick.co/mcp` | use.kick.co |  | 4.3 s |
| Kit | `https://app.kit.com/mcp` | app.kit.com |  | 2.3 s |
| Klaviyo | `https://mcp.klaviyo.com/mcp` | mcp.klaviyo.com |  | 3.5 s |
| Klue | `https://mcp.app.klue.com/mcp` | app.klue.com |  | 2.4 s |
| komoot | `https://claude.main.komoot.net/mcp` | mcp.main.komoot.net | sim | 9.5 s |
| Kpler | `https://claude.mcp.kpler.com/v1/mcp/` | auth.kpler.com |  | 2.5 s |
| Kuliko AI | `https://mcp.kuliko.ai/mcp` | alxbseaujimnnulajwux.supabase.co |  | 3.7 s |
| LatchBio | `https://mcp.latch.bio/mcp` | auth.latch.bio |  | 2.5 s |
| Lawve AI | `https://mcp.lawve.ai/mcp` | auth.lawve.ai |  | 3.6 s |
| LawVu | `https://mcp.lawvu.com/mcp` | mcp.lawvu.com |  | 3.5 s |
| Legal Data Hunter | `https://legaldatahunter.com/mcp` | legaldatahunter.com |  | 3.7 s |
| LegalZoom | `https://www.legalzoom.com/mcp/claude/v1` | authorization-service.apps.prd.aws-01.legalzoom.com |  | 2.3 s |
| LetsFG \| Book the best flights or hotels | `https://letsfg.co/mcp` | letsfg.co |  | 3.7 s |
| Lightbringer | `https://mcp.lightbringer.com/mcp` | app.lightbringer.com | sim | 10.5 s |
| Lightfield | `https://mcp.lightfield.app/mcp` | crm.lightfield.app |  | 3.3 s |
| LILT | `https://mcp.lilt.com/mcp` | blissful-celebration-62.authkit.app |  | 2.4 s |
| Linear (oficial) | `https://mcp.linear.app/mcp` | mcp.linear.app |  | 3.5 s |
| LinkSquares | `https://ai-chat-service.linksquares.com/v1/mcp/external` | mcp.linksquares.ai |  | 2.3 s |
| Listen Labs | `https://listenlabs.ai/mcp` | mcp.listenlabs.ai |  | 2.6 s |
| Livestorm | `https://mcp.livestorm.co/mcp` | mcp.livestorm.co |  | 4.3 s |
| LlamaParse | `https://mcp.llamaindex.ai/mcp` | login.llamaindex.ai |  | 3.5 s |
| Local Falcon | `https://mcp.localfalcon.com/` | mcp.localfalcon.com |  | 3.6 s |
| Lorikeet | `https://mcp.lorikeetcx.ai/` | mcp.lorikeetcx.ai |  | 3.3 s |
| Lovable | `https://mcp.lovable.dev/` | lovable.dev |  | 2.5 s |
| Lucid | `https://mcp.lucid.app/mcp` | mcp.lucid.app |  | 3.2 s |
| Lukka Prediction Markets Data MCP | `https://predmar.mcp.lukka.tech/` | auth0.lukka.tech |  | 2.4 s |
| Lumin | `https://mcp.luminpdf.com/mcp` | mcp.luminpdf.com |  | 4.0 s |
| Lumonic | `https://mcp.lumonic.com/mcp` | mcp.lumonic.com |  | 3.5 s |
| LunarCrush | `https://lunarcrush.ai/mcp` | lunarcrush.ai |  | 3.0 s |
| Lusha | `https://mcp.lusha.com/mcp/claude` | auth.lusha.com |  | 2.5 s |
| LZ Virtual Mail | `https://api.earthclassmail.com/v2/mcp/claude` | authorization-service.apps.prd.aws-01.legalzoom.com |  | 3.1 s |
| Macaly Cloud | `https://www.macaly.com/api/cloud/claude/mcp` | clerk.macaly.com |  | 2.6 s |
| Magic Patterns | `https://mcp.magicpatterns.com/mcp` | oauth.magicpatterns.com |  | 3.7 s |
| MAIA | `https://api.maia-analytics.com/mcp` | api.maia-analytics.com |  | 6.3 s |
| MailerLite | `https://mcp.mailerlite.com/mcp` | mcp.mailerlite.com |  | 3.4 s |
| Make | `https://mcp.make.com/` | www.make.com |  | 2.5 s |
| Mantic | `https://api.mantic.com/mcp` | app.mantic.com |  | 2.8 s |
| Manufact | `https://mcp.manufact.com/mcp` | cloud.manufact.com |  | 2.5 s |
| Maven Bio | `https://mcp.mavenbio.com/` | mcp.mavenbio.com |  | 3.4 s |
| mcp.betterstack.com | `https://mcp.betterstack.com/` | betterstack.com |  | 2.3 s |
| mcp.browserstack.com | `https://mcp.browserstack.com/mcp` | mcp.browserstack.com |  | 4.2 s |
| Medidata | `https://mcp.imedidata.com/mcp` | oauth-authorization.platform.imedidata.com |  | 3.4 s |
| Meko | `https://mcp.mekodata.ai/mcp` | mcp.mekodata.ai |  | 3.2 s |
| Meltwater | `https://api.meltwater.com/v2/mcp` | app.meltwater.com |  | 3.1 s |
| Mem | `https://mcp.mem.ai/mcp` | mem.ai |  | 2.4 s |
| Mem0 | `https://mcp.mem0.ai/mcp` | mcp.mem0.ai |  | 4.2 s |
| Merchkit | `https://www.merchkit.com/api/mcp` | wjydinoidomkxymhmlpr.supabase.co |  | 3.2 s |
| Mercury | `https://mcp.mercury.com/mcp` | mcp.mercury.com |  | 4.3 s |
| Meridian AI | `https://mcp.meridian-ai.com/mcp` | mcp.meridian-ai.com |  | 3.3 s |
| Metal | `https://mcp.metal.ai/mcp` | auth.metal.ai |  | 2.4 s |
| Metaview | `https://mcp.metaview.ai/mcp` | auth.metaview.ai |  | 2.7 s |
| Metricool Social Media Management | `https://ai.metricool.com/mcp` | app.metricool.com |  | 3.6 s |
| Microsoft 365 | `https://microsoft365.mcp.claude.com/mcp` | login.microsoftonline.com |  | 4.2 s |
| Midpage Legal Research | `https://app.midpage.ai/mcp` | app.midpage.ai |  | 3.4 s |
| Mintlify | `https://mcp.mintlify.com/` | mcp.mintlify.com |  | 22.4 s |
| Miro | `https://mcp.miro.com/` | mcp.miro.com |  | 3.3 s |
| mittwald | `https://mcp.mittwald.de/mcp` | auth.mcp.mittwald.de |  | 20.7 s |
| Mixpanel | `https://mcp.mixpanel.com/mcp` | mixpanel.com |  | 3.1 s |
| Mobbin | `https://api.mobbin.com/mcp` | ujasntkfphywizsdaapi.supabase.co |  | 2.6 s |
| Moda - Slides and Designs | `https://agents.moda.app/mcp` | agents.moda.app |  | 3.2 s |
| Mojo — Pocket Capture | `https://mcp.mojosystems.io/mcp` | app.mojosystems.io |  | 3.4 s |
| Mollie | `https://mcp.mollie.com/mcp` | my.mollie.com |  | 2.7 s |
| monday.com | `https://mcp.monday.com/mcp` | auth.monday.com |  | 2.4 s |
| Monte Carlo | `https://mcp.getmontecarlo.com/mcp` | auth.getmontecarlo.com |  | 2.5 s |
| Morning Consult | `https://api.morningconsult.com/mcp` | api.morningconsult.com |  | 7.2 s |
| Morningstar | `https://mcp.morningstar.com/mcp` | mcp.morningstar.com |  | 3.2 s |
| MotherDuck | `https://api.motherduck.com/mcp` | mcp-auth.motherduck.com |  | 2.3 s |
| Motion Creative Analytics | `https://projects.motionapp.com/mcp` | projects.motionapp.com |  | 3.5 s |
| MSCI Connector | `https://mcp.msci.com/mcp/v1.0/mcp` | mcp.msci.com |  | 3.8 s |
| MT Newswires | `https://mcp.mtnewswires.com/mcp` | mcp.mtnewswires.com |  | 3.4 s |
| MuuMuu Domain byGMO Pepabo | `https://mcp.muumuu-domain.com/mcp` | mcp.muumuu-domain.com |  | 5.1 s |
| MyChatBot | `https://connector.mychatbot.app/mcp` | connector.mychatbot.app |  | 3.2 s |
| MyGeotab MCP | `https://mcp.geotab.com/mygeotab` | mcp.geotab.com |  | 3.2 s |
| Navan | `https://mcp.navan.com/mcp` | login.navan.com |  | 2.4 s |
| neimo. | `https://mcp.neimo.ai/api/mcp` | clerk.portal.k-id.com |  | 2.5 s |
| Neon | `https://mcp.neon.tech/mcp` | mcp.neon.tech |  | 3.2 s |
| Netlify | `https://netlify-mcp.netlify.app/mcp` | netlify-mcp.netlify.app |  | 3.2 s |
| Nimble | `https://mcp.nimbleway.com/mcp` | api.nimbleway.com |  | 3.4 s |
| Ninout | `https://mcp.svy.ooo/mcp` | mcp.svy.ooo |  | 3.4 s |
| Notion (oficial) | `https://mcp.notion.com/mcp` | mcp.notion.com |  | 3.4 s |
| Notra | `https://mcp.usenotra.com/mcp` | oauth.usenotra.com |  | 2.7 s |
| NSDAP Archiv - DER SPIEGEL | `https://nsdap-mcp.prod.ki.spiegel.de/mcp` | nsdap-mcp.prod.ki.spiegel.de |  | 3.2 s |
| NumbersGame MCP | `https://mcp.numbersgame.xyz/mcp` | app.numbersgame.xyz |  | 2.5 s |
| Nutshell CRM | `https://app.nutshell.com/mcp` | app.nutshell.com |  | 3.2 s |
| O’Reilly | `https://api.oreilly.com/api/content-discovery/v1/mcp/` | api.oreilly.com |  | 3.2 s |
| Oak National Academy | `https://mcp.thenational.academy/mcp` | clerk.thenational.academy |  | 2.5 s |
| Omega Point | `https://mcp.ompnt.com/mcp` | mcp.ompnt.com |  | 3.2 s |
| Omni Analytics | `https://callbacks.omniapp.co/callback/mcp` | callbacks.omniapp.co |  | 3.2 s |
| OneSignal | `https://api.onesignal.com/mcp/oauth` | dashboard.onesignal.com |  | 3.3 s |
| OpenRush | `https://api.openrush.com/mcp` | sylyiitxiqhmhlxsgjnt.supabase.co |  | 2.5 s |
| OpenSEO | `https://app.openseo.so/mcp` | app.openseo.so |  | 3.4 s |
| Optilogic | `https://mcp.optilogic.app/mcp` | mcp.optilogic.app |  | 3.2 s |
| OpusClip | `https://api.opus.pro/api/mcp` | focused-horizon-38.authkit.app |  | 3.5 s |
| Origin | `https://mcp.prod.originhq.com/mcp` | auth-web.dashboard.originhq.com |  | 2.7 s |
| Orion by Gravity | `https://g.runorion.com/mcp` | g.runorion.com |  | 3.3 s |
| Orshot | `https://mcp.orshot.com/mcp` | orshot.com |  | 2.5 s |
| Otter.ai | `https://mcp.otter.ai/mcp` | otter.ai |  | 3.5 s |
| Otto Travel | `https://api.ottotheagent.com/mcp` | api.ottotheagent.com |  | 3.2 s |
| Outreach | `https://api.outreach.io/mcp/` | api.outreach.io |  | 3.6 s |
| Padlet | `https://mcp.padlet.com/` | mcp.padlet.com |  | 3.2 s |
| PandaDoc | `https://mcp.pandadoc.com/v1/mcp` | mcp.pandadoc.com |  | 3.3 s |
| Papermark | `https://mcp.papermark.com/mcp` | app.papermark.com |  | 4.6 s |
| PaperOffice | `https://mcp.paperoffice.ai/claude` | mcp.paperoffice.ai |  | 4.0 s |
| Patlytics | `https://mcp.patlytics.ai/mcp` | mcp.patlytics.ai |  | 3.2 s |
| Paxton Legal Research | `https://paxton-mcp-connector-xmfvvq3waa-uc.a.run.app/mcp` | paxton-mcp-connector-xmfvvq3waa-uc.a.run.app |  | 3.3 s |
| Payhawk | `https://mcp.payhawk.com/mcp` | mcp.payhawk.com |  | 4.0 s |
| PayPal | `https://mcp.paypal.com/mcp` | mcp.paypal.com |  | 3.4 s |
| Paytm Payment Gateway | `https://mcp.paytmpayments.com/mcp` | accounts.paytmpayments.com |  | 4.2 s |
| PDF Viewer | `https://example-server.modelcontextprotocol.io/pdf/mcp` | example-server.modelcontextprotocol.io | sim | 9.2 s |
| PDF.net | `https://mcp.pdf.net/mcp` | mcp.pdf.net |  | 4.2 s |
| Peec AI | `https://api.peec.ai/mcp` | api.peec.ai |  | 3.9 s |
| Perspective AI | `https://getperspective.ai/mcp` | getperspective.ai |  | 3.2 s |
| Phished | `https://mcp.phished.io/mcp` | app.phished.io |  | 2.7 s |
| Pi Security | `https://mcp.pi.security/mcp` | auth.pi.security |  | 2.4 s |
| PicPay | `https://mcp.svc.picpay.com/v2/mcp` | mcp.svc.picpay.com |  | 3.2 s |
| Pine Labs Payments Assistant | `https://mcp.pinelabs.com/mcp` | mcp.pinelabs.com |  | 5.1 s |
| Pinegap | `https://mcp.pinegap.ai/` | signin.pinegap.ai |  | 2.8 s |
| Pipedrive | `https://mcp.pipedrive.ai/mcp` | oauth.pipedrive.com |  | 3.8 s |
| Plaid Developer Tools | `https://api.dashboard.plaid.com/mcp/sse` | dashboard.plaid.com |  | 4.2 s |
| PlanetScale | `https://mcp.pscale.dev/mcp/planetscale` | app.planetscale.com |  | 3.3 s |
| Planning Center | `https://mcp.planningcenteronline.com/mcp` | mcp.planningcenteronline.com |  | 4.4 s |
| Plaud | `https://mcp.plaud.ai/mcp` | mcp.plaud.ai |  | 3.2 s |
| Play Sheet Music | `https://example-server.modelcontextprotocol.io/sheet-music/mcp` | example-server.modelcontextprotocol.io | sim | 10.4 s |
| Plotly Cloud | `https://cloud.plotly.com/_mcp` | signin.cloud.plotly.com |  | 3.2 s |
| PocketSmith Complete Access | `https://mcp.pocketsmith.com/mcp` | mcp.pocketsmith.com |  | 3.2 s |
| PointOne | `https://mcp.pointone.com/mcp` | auth.pointone.com |  | 2.4 s |
| Polar Analytics | `https://api.polaranalytics.com/mcp` | ai-service.polaranalytics.com |  | 3.8 s |
| PostHog | `https://mcp.posthog.com/mcp` | oauth.posthog.com |  | 3.3 s |
| Postman | `https://mcp.postman.com/minimal` | mcp.postman.com |  | 4.2 s |
| Prefect | `https://prefect.fastmcp.app/mcp` | api.prefect.cloud |  | 2.5 s |
| Privacy.com | `https://mcp.privacy.com/` | app.privacy.com |  | 2.4 s |
| Process Street | `https://mcp.process.st/` | auth.process.st |  | 2.5 s |
| Productised | `https://mcp.productised.ai/mcp` | app.productised.ai |  | 3.2 s |
| Productive | `https://mcp.productive.io/mcp` | app.productive.io |  | 3.2 s |
| Profound | `https://mcp.tryprofound.com/mcp` | auth.tryprofound.com |  | 2.4 s |
| Promptless | `https://api.gopromptless.ai/mcp/with-direct-edits` | api.gopromptless.ai |  | 3.2 s |
| Pylon | `https://mcp.usepylon.com/` | o.auth.usepylon.com |  | 2.5 s |
| Qonto | `https://mcp.qonto.com/mcp` | mcp.qonto.com |  | 3.2 s |
| Quartr | `https://mcp.quartr.com/mcp` | mcp.quartr.com |  | 3.3 s |
| QuickNode | `https://mcp.quicknode.com/mcp` | mcp.quicknode.com |  | 4.2 s |
| QuickStart | `https://my.quickstartapi.netsuite.com/mcp` | my.quickstartapi.netsuite.com |  | 3.6 s |
| Quo | `https://mcp.quo.com/mcp` | mcp.quo.com |  | 3.5 s |
| Railway | `https://mcp.railway.com/` | backboard.railway.com |  | 2.5 s |
| Rally MCP | `https://mcp.rallyuxr.com/mcp` | mcp.rallyuxr.com |  | 3.2 s |
| Ramp | `https://ramp-mcp-remote.ramp.com/mcp` | ramp-mcp-remote.ramp.com |  | 3.2 s |
| Ramp Data | `https://mcp.ramp.com/ramp-data/anthropic/mcp` | mcp.ramp.com | sim | 7.2 s |
| Razorpay | `https://mcp.razorpay.com/mcp` | mcp.razorpay.com |  | 4.9 s |
| Readwise | `https://mcp2.readwise.io/mcp` | readwise.io |  | 2.7 s |
| Reclaim.ai | `https://mcp.reclaim.ai/` | api.app.reclaim.ai |  | 2.8 s |
| Remesh | `https://live.remesh.chat/mcp` | live.remesh.chat |  | 3.5 s |
| Remote | `https://mcp.remote.com/mcp` | api.employ.remote.com |  | 2.8 s |
| Replit | `https://replit-mcp.com/anthropic/mcp` | replit.com |  | 2.4 s |
| Resend | `https://mcp.resend.com/` | api.resend.com |  | 2.3 s |
| Restream | `https://mcp.restream.io/mcp` | oauth.restream.io |  | 2.5 s |
| Revealed | `https://mcp.revealed.ai/mcp` | mcp.revealed.ai |  | 4.2 s |
| Richpanel AI | `https://mcp.richpanel.com/mcp` | mcp.richpanel.com |  | 4.3 s |
| Rillet | `https://api.rillet.com/mcp` | api.rillet.com |  | 3.4 s |
| RingCentral Chat | `https://mcp.labs.ringcentral.com/ringex/v1.1.0/team-chat` | mcp.labs.ringcentral.com |  | 3.3 s |
| Rippit | `https://mcp.rippit.com/mcp` | app.rippit.com |  | 2.3 s |
| Riverside | `https://mcp.riverside.com/mcp` | riverside.com |  | 2.6 s |
| Roam Research | `https://mcp.roamresearch.com/mcp/claude` | connect.roamresearch.com |  | 3.5 s |
| Robin (Workplace) | `https://mcp.robinpowered.com/mcp` | auth.robinpowered.com |  | 2.4 s |
| Roboflow | `https://mcp.roboflow.com/mcp` | app.roboflow.com |  | 2.5 s |
| Rocket Lawyer | `https://api.rocketlawyer.com/mcp-du/mcp` | www.rocketlawyer.com |  | 4.6 s |
| RocketReach | `https://mcp.rocketreach.co/mcp` | rocketreach.co |  | 3.9 s |
| Rockhopper | `https://mcp.rockhopper.co/mcp` | mcp.rockhopper.co |  | 4.3 s |
| Rootly | `https://mcp.rootly.com/mcp` | rootly.com |  | 2.4 s |
| RSVPify | `https://mcp.rsvpify.com/` | api.rsvpify.com |  | 2.2 s |
| Runway (runway.team) | `https://mcp.runway.team/` | obtainable-solitude-72.authkit.app |  | 2.4 s |
| S&P - Deterministic Retrieval | `https://kfinance.kensho.com/integrations/mcp` | kfinance.kensho.com |  | 7.0 s |
| S&P Global - Adaptive Retrieval | `https://grounding.kensho.com/integrations/v2/mcp` | grounding.kensho.com |  | 3.2 s |
| Salesflare | `https://mcp.salesflare.com/mcp` | api.salesflare.com |  | 3.1 s |
| Sanity | `https://mcp.sanity.io/` | mcp.sanity.io |  | 3.2 s |
| Savri | `https://savri.io/api/mcp` | savri.io |  | 3.3 s |
| Scite | `https://api.scite.ai/mcp` | api.scite.ai |  | 4.2 s |
| Seamless | `https://mcp.seamless.ai/mcp` | mcp.seamless.ai |  | 3.2 s |
| Semrush | `https://mcp.semrush.com/claude/v1/mcp` | api.semrush.com |  | 1.9 s |
| Send | `https://www.send.co/mcp` | www.send.co |  | 3.3 s |
| Sent | `https://mcp.sent.dm/mcp` | mcp.sent.dm |  | 3.2 s |
| Sentry (oficial) | `https://mcp.sentry.dev/mcp` | mcp.sentry.dev |  | 3.4 s |
| Sequence | `https://eu.sequencehq.com/mcp` | dashboard.sequencehq.com |  | 3.8 s |
| Shapes | `https://mcp.shapes.co/mcp` | mcp.shapes.co |  | 3.2 s |
| ShipBob | `https://api.shipbob.com/developer-api/mcp` | api.shipbob.com |  | 3.2 s |
| Shippo | `https://mcp.shippo.com/` | goshippo.com |  | 2.8 s |
| Signeasy | `https://mcp.signeasy.com/mcp/sse` | mcp.signeasy.com |  | 3.1 s |
| SignNow | `https://mcp-server.signnow.com/mcp` | mcp-server.signnow.com |  | 3.2 s |
| SlickTrip | `https://mcp.slicktrip.com/mcp` | mcp.slicktrip.com | sim | 9.3 s |
| Smartling | `https://mcp.smartling.com/mcp` | mcp.smartling.com |  | 3.2 s |
| Sonos | `https://mcp.ws.sonos.com/mcp` | mcp.ws.sonos.com |  | 3.2 s |
| Spara | `https://app.spara.co/mcp/customer/stream` | clerk.spara.co |  | 2.5 s |
| spArxx.io \| Zero-Knowledge Blockchain Timestamping | `https://gateway.sparxx.io/mcp` | gateway.sparxx.io |  | 3.3 s |
| Speko | `https://mcp.speko.ai/mcp` | platform.speko.ai |  | 2.6 s |
| Splice | `https://mcp.splice.com/mcp` | mcp.splice.com |  | 4.2 s |
| Sprites | `https://sprites.dev/mcp` | sprites.dev |  | 3.2 s |
| Sprouts Data Intelligence | `https://sprouts-mcp-server.kartikay-dhar.workers.dev/` | mcp.sprouts.ai | sim | 8.3 s |
| Square | `https://mcp.squareup.com/mcp` | mcp.squareup.com |  | 3.4 s |
| Stripe | `https://mcp.stripe.com/` | access.stripe.com |  | 2.4 s |
| stub | `https://api.stub.africa/mcp` | api.stub.africa |  | 4.3 s |
| Stytch | `https://mcp.stytch.dev/mcp` | stytch.com |  | 2.4 s |
| Subtext | `https://api.fullstory.com/mcp/subtext` | auth.fullstory.com |  | 2.5 s |
| Sumble | `https://mcp.sumble.com/` | mcp.sumble.com |  | 3.2 s |
| Sumsub | `https://api.sumsub.com/mcp/` | cockpit.sumsub.com |  | 2.3 s |
| Supabase | `https://mcp.supabase.com/mcp` | api.supabase.com |  | 4.0 s |
| SuperBooks | `https://app.superbooks.io/mcp` | app.superbooks.io |  | 4.2 s |
| Superhuman Docs | `https://docs.superhuman.com/apis/mcp` | id.superhuman.com |  | 2.5 s |
| Superhuman Mail | `https://mcp.mail.superhuman.com/mcp` | mcp.auth.mail.superhuman.com |  | 2.4 s |
| Supermetrics Marketing Analytics | `https://mcp.supermetrics.com/mcp` | api.supermetrics.com |  | 3.5 s |
| Supersei CRM | `https://api.supersei.com/mcp` | api.supersei.com |  | 4.1 s |
| SurveyMonkey | `https://mcp.surveymonkey.com/mcp` | mcp.surveymonkey.com |  | 4.6 s |
| Swagger | `https://swagger.mcp.smartbear.com/mcp` | auth.swaggerhub.com |  | 2.3 s |
| Sybill | `https://mcp.sybill.ai/mcp` | mcp.sybill.ai |  | 3.2 s |
| Synapse.org | `https://mcp.synapse.org/mcp` | mcp.synapse.org |  | 3.2 s |
| Tabs | `https://integrators.prod.api.tabsplatform.com/mcp` | login.tabs.com |  | 3.5 s |
| Tactiq | `https://mcp.tactiq.io/` | mcp.tactiq.io |  | 3.3 s |
| Tally | `https://api.tally.so/mcp` | api.tally.so |  | 3.3 s |
| Tana | `https://home.tana.inc/mcp` | login.tana.inc |  | 3.3 s |
| Taplio | `https://mcp.taplio.com/` | mcp.taplio.com |  | 3.4 s |
| Tavily | `https://mcp.tavily.com/mcp` | mcp.tavily.com |  | 4.2 s |
| Teamtailor | `https://mcp.teamtailor.com/mcp` | mcp.teamtailor.com |  | 5.2 s |
| Tella | `https://api.tella.com/mcp` | authkit.tella.tv |  | 3.5 s |
| Terminal49 | `https://mcp.terminal49.com/` | auth.terminal49.com |  | 2.4 s |
| TEXT TO QUANT | `https://www.texttoquant.com/api/mcp` | dokopcgoubccfbqrzltg.supabase.co |  | 4.0 s |
| Theysaid | `https://ai.theysaid.io/api/mcp` | authkit.theysaid.io |  | 2.5 s |
| Third Bridge | `https://ai.thirdbridge.com/mcp/sse` | sso-mcp-auth.thirdbridge.com |  | 7.1 s |
| ThoughtSpot Spotter | `https://agent.thoughtspot.app/mcp` | agent.thoughtspot.app |  | 4.5 s |
| Three.js 3D Viewer | `https://example-server.modelcontextprotocol.io/threejs/mcp` | example-server.modelcontextprotocol.io | sim | 9.2 s |
| Ticket Tailor | `https://mcp.tickettailor.ai/mcp` | mcp.tickettailor.ai |  | 4.5 s |
| TickTick | `https://mcp.ticktick.com/` | ticktick.com |  | 3.0 s |
| TikTok for Business | `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer-anthropic` | business-api.tiktok.com |  | 4.4 s |
| Tiller | `https://ai-tools.tillermoney.com/mcp` | ai-tools.tillermoney.com |  | 3.2 s |
| Tineo | `https://api.tineo.ai/mcp/claude` | api.tineo.ai | sim | 8.3 s |
| TinyFish | `https://agent.tinyfish.ai/mcp/claude` | clerk.tinyfish.ai |  | 2.5 s |
| tl;dv - AI Note Taker & Meeting Recorder: Transcripts, Summaries & Meeting Minutes | `https://mcp.tldv.io/mcp` | keycloak.tldv.io |  | 3.5 s |
| Todoist | `https://ai.todoist.net/mcp` | todoist.com |  | 2.3 s |
| TopCounsel by The L Suite | `https://api.techgc.co/api/mcp/topcounsel` | api.techgc.co |  | 4.5 s |
| Trainual | `https://mcp.trainual.com/` | app.trainual.com |  | 2.4 s |
| Trello | `https://mcp.trello.com/v1` | auth.atlassian.com |  | 3.7 s |
| Trimble SketchUp | `https://api.sketchup.com/mcp/v1/sketchup/mcp` | api.sketchup.com |  | 3.6 s |
| Tseha.io | `https://tseha.io/mcp` | tseha.io | sim | 7.5 s |
| Turkish Airlines | `https://mcp-app.turkishtechlab.com/mcp` | mcp-app.turkishtechlab.com |  | 4.1 s |
| Twelve Data | `https://mcp.twelvedata.com/mcp` | auth.twelvedata.com |  | 2.7 s |
| TwinMind | `https://api.twinmind.com/mcp` | api.twinmind.com |  | 3.2 s |
| Typefully - Social Media Scheduler | `https://mcp.typefully.com/mcp` | api.typefully.com |  | 2.5 s |
| Ubersuggest | `https://ubersuggest-mcp.neilpatelapi.com/mcp` | ubersuggest-mcp.neilpatelapi.com |  | 3.2 s |
| Udemy Business | `https://api.udemy.com/mcp` | api.udemy.com |  | 3.2 s |
| Unblocked | `https://getunblocked.com/api/mcpsse` | getunblocked.com |  | 4.7 s |
| Unstructured Transform | `https://mcp.transform.unstructured.io/` | mcp.transform.unstructured.io |  | 3.2 s |
| Unthread | `https://app.unthread.io/api/mcp` | app.unthread.io |  | 3.3 s |
| Unwrap | `https://nlp.api.production.unwrap.ai/mcp` | nlp.api.production.unwrap.ai |  | 3.2 s |
| Upwork | `https://mcp.upwork.com/mcp` | www.upwork.com |  | 2.6 s |
| v0 | `https://v0.app/api/mcp` | v0.app |  | 8.0 s |
| Vaisala Xweather | `https://mcp.api.xweather.com/mcp` | oauth.api.xweather.com |  | 2.5 s |
| Valuecase App | `https://mcp.valuecase.com/mcp` | mcp.valuecase.com |  | 3.3 s |
| Vanta | `https://mcp.vanta.com/mcp` | api.vanta.com |  | 4.0 s |
| Vasara | `https://mcp.vasara.ai/` | app.vasara.ai |  | 2.9 s |
| Veltra Activities | `https://ai.veltra.com/veltra/mcp` | ai.veltra.com | sim | 8.2 s |
| Vercel (oficial) | `https://mcp.vercel.com` | vercel.com |  | 1.9 s |
| Vertiso Memory | `https://memory.vertiso.ai/mcp` | memory.vertiso.ai |  | 3.2 s |
| viaNexus vAST | `https://vast.blueskyapi.com/vianexus/mcp` | auth.vast.blueskyapi.com |  | 2.4 s |
| Vibe AI | `https://mcp.vibe.us/mcp` | api.vibe.us |  | 3.7 s |
| Vibe Prospecting | `https://vibeprospecting.explorium.ai/mcp` | vibeprospecting.explorium.ai |  | 4.5 s |
| Viberate music data | `https://mcp.viberate.com/v1/sse` | oauth-api.viberate.com |  | 3.5 s |
| vidIQ | `https://mcp.vidiq.com/mcp` | mcp.vidiq.com |  | 3.2 s |
| Voluum | `https://mcp.voluum.com/mcp` | api.voluum.com |  | 2.5 s |
| Vylo | `https://mcp.vylo.one/mcp` | mcp.vylo.one |  | 5.8 s |
| Webflow | `https://mcp.webflow.com/mcp` | mcp.webflow.com |  | 3.5 s |
| WebMCP Evaluator | `https://mcp.webmcp-eval.com/mcp` | mcp.webmcp-eval.com |  | 3.2 s |
| Webull | `https://api.webull.com/mcp` | passport.webull.com |  | 2.6 s |
| WeTransfer | `https://mcp-server.wetransfer.com/mcp` | mcp-server.wetransfer.com |  | 4.3 s |
| WeWeb | `https://ai-api.weweb.io/v1/mcp` | api.weweb.io |  | 3.3 s |
| Whimsical | `https://mcp.whimsical.com/mcp` | api.whimsical.com |  | 3.3 s |
| Wiley Scholar Gateway | `https://connector.scholargateway.ai/v2/mcp` | connector.scholargateway.ai |  | 3.5 s |
| Windmill HR | `https://mcp.gowindmill.com/mcp` | api.gowindmill.com |  | 3.7 s |
| Windsor.ai | `https://mcp.windsor.ai/` | mcp.windsor.ai |  | 3.2 s |
| WisdomAI | `https://mcp.wisdom.ai/mcp` | mcp.wisdom.ai |  | 3.2 s |
| Wispr Flow | `https://api.wisprflow.ai/connect/mcp` | mcp-auth.wisprflow.com |  | 2.5 s |
| Within | `https://api.within.ai/mcp` | api.within.ai |  | 3.7 s |
| Wix | `https://mcp.wix.com/mcp` | mcp.wix.com |  | 3.5 s |
| WordPress.com | `https://public-api.wordpress.com/wpcom/v2/mcp/v1` | public-api.wordpress.com |  | 3.4 s |
| Workable | `https://mcp.workable.com/mcp` | workable.com |  | 3.2 s |
| WorkOS | `https://mcp.workos.com/mcp` | signin.workos.com |  | 2.3 s |
| xTiles | `https://mcp.xtiles.app/mcp` | mcp.xtiles.app |  | 3.2 s |
| Yardi Matrix | `https://matrixmcp.virtuoso.ai/mcp` | matrixmcp.virtuoso.ai |  | 5.3 s |
| Yardi Virtuoso | `https://mcp.virtuoso.ai/mcp` | mcp.virtuoso.ai |  | 5.1 s |
| Zacks Data | `https://mcp.zacksdata.com/` | auth.zacksdata.com |  | 2.6 s |
| Zapier | `https://mcp.zapier.com/api/v1/connect` | mcp.zapier.com |  | 3.2 s |
| Zite | `https://mcp.zite.com/mcp` | server.zite.com |  | 2.5 s |
| Zocks | `https://mcp.zocks.io/v1/mcp` | mcp.zocks.io |  | 3.2 s |
| Zomato | `https://mcp-server.zomato.com/mcp` | mcp-server.zomato.com |  | 4.4 s |

## Precisam de client id próprio (102)

O servidor de autorização não oferece registro dinâmico: é preciso criar um aplicativo OAuth no serviço, cadastrar `http://127.0.0.1:38565/callback` e informar o client id ao conectar. Conferido em cada um: o ensaio falha no passo de registro com a mensagem e a dica corretas, e o botão "Conectar" sem client id devolve o `redirectUri` certo (passos `app:*`). Os marcados com ✱ também listam ferramentas sem login (estão na tabela dos abertos), mas o login deles exige o client id.

| Conector | Servidor de autorização | Mensagem e URL de retorno conferidos | Causa observada |
|---|---|---|---|
| 8am MyCase | auth.mycase.com | sim | servidor de autorização sem registro dinâmico |
| Affinity | login.affinity.co | sim | servidor de autorização sem registro dinâmico |
| Amazon Selling Partner | sellercentral.amazon.com | sim | servidor de autorização sem registro dinâmico |
| Aptus.AI - NextOS | legalmcp.next.aptus.ai | sim | servidor de autorização sem registro dinâmico |
| Asana | app.asana.com | sim | servidor de autorização sem registro dinâmico |
| Atlar | api.atlar.com | sim | servidor de autorização sem registro dinâmico |
| Autodesk Product Help ✱ | developer.api.autodesk.com | sim | servidor de autorização sem registro dinâmico |
| Bigdata.com | clerk.bigdata.com | sim | servidor de autorização sem registro dinâmico |
| BILL | auth.bill.com | sim | servidor de autorização sem registro dinâmico |
| Bitrise MCP | oauth.bitrise.io | sim | servidor de autorização sem registro dinâmico |
| Black Diamond | login.bdreporting.com | sim | servidor de autorização sem registro dinâmico |
| Boltz API | api.boltz.com | sim | servidor de autorização sem registro dinâmico |
| Box | account.box.com | sim | servidor de autorização sem registro dinâmico |
| Canary Data | api.canary-data.com | sim | servidor de autorização sem registro dinâmico |
| Chariot | dashboard.givechariot.com | sim | servidor de autorização sem registro dinâmico |
| Clarivate IPOne CompuMark Trademarks | ipone.clarivate.com | sim | servidor de autorização sem registro dinâmico |
| Clear Street | api.clearstreet.com | sim | servidor de autorização sem registro dinâmico |
| Cognito Forms | www.cognitoforms.com | sim | servidor de autorização sem registro dinâmico |
| Conductor | auth.conductor.com | sim | servidor de autorização sem registro dinâmico |
| Cotality | api.cotality.com | sim | servidor de autorização sem registro dinâmico |
| Coursera ✱ | api.coursera.com | sim | servidor de autorização sem registro dinâmico |
| Crunchbase | www.crunchbase.com | sim | servidor de autorização sem registro dinâmico |
| D&B Finance Analytics | mcp.financeanalytics.dnb.com | sim | servidor de autorização sem registro dinâmico |
| D&B Risk Analytics | agents.riskanalytics.dnb.com | sim | servidor de autorização sem registro dinâmico |
| Daffy MCP | auth.daffy.org | sim | servidor de autorização sem registro dinâmico |
| Diffit | api.diffit.me | sim | servidor de autorização sem registro dinâmico |
| DocuSeal | docuseal.com | sim | servidor de autorização sem registro dinâmico |
| Docusign | account.docusign.com | sim | servidor de autorização sem registro dinâmico |
| Dovetail | auth.dovetail.com | sim | servidor de autorização sem registro dinâmico |
| ElevenLabs | elevenlabs.io | sim | servidor de autorização sem registro dinâmico |
| Everlaw | app.everlaw.com | sim | servidor de autorização sem registro dinâmico |
| Files.com | app.files.com | sim | servidor de autorização sem registro dinâmico |
| Filevine | identity.filevine.com | sim | servidor de autorização sem registro dinâmico |
| Fitch Solutions | login.fitch.group | sim | servidor de autorização sem registro dinâmico |
| Flourish Financial | www.flourish.com | sim | servidor de autorização sem registro dinâmico |
| FMP | financialmodelingprep.com | sim | servidor de autorização sem registro dinâmico |
| G2 | www.g2.com | sim | servidor de autorização sem registro dinâmico |
| Gemini ✱ | exchange.gemini.com | sim | servidor de autorização sem registro dinâmico |
| Gmail ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Calendar ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Cloud BigQuery ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Compute Engine ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Docs ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Drive ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Sheets ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Google Slides ✱ | accounts.google.com | sim | servidor de autorização sem registro dinâmico |
| Guidepoint | auth0.guidepoint.com | sim | servidor de autorização sem registro dinâmico |
| HubSpot | mcp.hubspot.com | sim | servidor de autorização sem registro dinâmico |
| Hubstaff | account.hubstaff.com | sim | servidor de autorização sem registro dinâmico |
| Ideals | auth.idealsvdr.com | sim | servidor de autorização sem registro dinâmico |
| Insider One | gw.useinsider.com | sim | servidor de autorização sem registro dinâmico |
| Instacart | www.instacart.com | sim | servidor de autorização sem registro dinâmico |
| isolved People Cloud | identity.myisolved.com | sim | servidor de autorização sem registro dinâmico |
| Isometric | api.isometric.com | sim | servidor de autorização sem registro dinâmico |
| Jobber | secure.getjobber.com | sim | servidor de autorização sem registro dinâmico |
| Keel | app.usekeel.io | sim | servidor de autorização sem registro dinâmico |
| Kepler | signin.kepler.ai | sim | servidor de autorização sem registro dinâmico |
| Lattice | api-auth.latticehq.com | sim | servidor de autorização sem registro dinâmico |
| Legal Brain Agent | account.legalbrain.com | sim | servidor de autorização sem registro dinâmico |
| LinkedIn Hiring Pro | www.linkedin.com | sim | servidor de autorização sem registro dinâmico |
| MagicSchool AI | tnupzxfjruksulvfyanl.supabase.co | sim | servidor de autorização sem registro dinâmico |
| MeisterTask | accounts.meister.co | sim | servidor de autorização sem registro dinâmico |
| Menti | www.mentimeter.com | sim | servidor de autorização sem registro dinâmico |
| MindMeister | accounts.meister.co | sim | servidor de autorização sem registro dinâmico |
| MongoDB Atlas | cloud.mongodb.com | sim | servidor de autorização sem registro dinâmico |
| Morningstar Credit Analytics | auth.platform.dealx.com | sim | servidor de autorização sem registro dinâmico |
| MuleSoft | anypoint.mulesoft.com | sim | servidor de autorização sem registro dinâmico |
| MYOB | id.myob.com | sim | servidor de autorização sem registro dinâmico |
| Nevis | auth0.neviswealth.com | sim | servidor de autorização sem registro dinâmico |
| Nooks | oauth.nooks.in | sim | servidor de autorização sem registro dinâmico |
| Owkin | k.auth.eu-west-1.amazoncognito.com | sim | servidor de autorização sem registro dinâmico |
| PagerDuty | app.pagerduty.com | sim | servidor de autorização sem registro dinâmico |
| PGA – Play Golf ✱ | auth0.pga.com | sim | servidor de autorização sem registro dinâmico |
| Pitch | auth.pitch.com | sim | servidor de autorização sem registro dinâmico |
| Planday | id.prod-global.planday.cloud | sim | servidor de autorização sem registro dinâmico |
| Print.com | auth.print.com | sim | servidor de autorização sem registro dinâmico |
| Render | api.render.com | sim | servidor de autorização sem registro dinâmico |
| Resy | resygateway.americanexpress.com | sim | servidor de autorização sem registro dinâmico |
| Revolut X | auth.revolut.com | sim | servidor de autorização sem registro dinâmico |
| Seismic | auth.seismic.com | sim | servidor de autorização sem registro dinâmico |
| Sendcloud | account.sendcloud.com | sim | servidor de autorização sem registro dinâmico |
| Shop | accounts.shop.app | sim | servidor de autorização sem registro dinâmico |
| Shopify ✱ | setup.shopify.com | sim | servidor de autorização sem registro dinâmico |
| Slack (oficial) | slack.com | sim | servidor de autorização sem registro dinâmico |
| Softr | studio.softr.io | sim | servidor de autorização sem registro dinâmico |
| Solve Intelligence | api.solveintelligence.com | sim | servidor de autorização sem registro dinâmico |
| Spotify | accounts.spotify.com | sim | servidor de autorização sem registro dinâmico |
| Thumbtack | auth.thumbtack.com | sim | servidor de autorização sem registro dinâmico |
| TomTom Maps | oauth.my.tomtom.com | sim | servidor de autorização sem registro dinâmico |
| Trustfull | dashboard.trustfull.com | sim | servidor de autorização sem registro dinâmico |
| Uber | auth.uber.com | sim | servidor de autorização sem registro dinâmico |
| Uber Eats | auth.uber.com | sim | servidor de autorização sem registro dinâmico |
| Unify | auth.unifygtm.com | sim | servidor de autorização sem registro dinâmico |
| Unsplash | unsplash.com | sim | servidor de autorização sem registro dinâmico |
| Verisk Underwriting Intelligence | underwritingintelligencelogin.verisk.com | sim | servidor de autorização sem registro dinâmico |
| Wealth.com | identity.wealth.com | sim | servidor de autorização sem registro dinâmico |
| Wealthbox | app.crmworkspace.com | sim | servidor de autorização sem registro dinâmico |
| Webex for Claude | webexapis.com | sim | servidor de autorização sem registro dinâmico |
| Webex Meetings | webexapis.com | sim | servidor de autorização sem registro dinâmico |
| Wrike | login.wrike.com | sim | servidor de autorização sem registro dinâmico |
| Xero | login.xero.com | sim | servidor de autorização sem registro dinâmico |
| Zoom for Claude | zoom.us | sim | servidor de autorização sem registro dinâmico |

## Precisam de chave de API (3)

O servidor responde 401/403 sem a chave. "Chave recusada" é a dica que o app mostra quando o usuário digitou a chave e o servidor a rejeitou (o caso real: o app nem conecta sem as credenciais obrigatórias, e o formulário vem das `credentials` do diretório).

| Conector | Endpoint | HTTP | Chave recusada: dica exibida | Formulário gerado |
|---|---|---|---|---|
| Atlassian (API token) | `https://mcp.atlassian.com/v2/mcp` | 401 | O Rovo MCP da Atlassian (mcp.atlassian.com) não aceitou o token de API: a organização não liberou token de API para o Rovo MCP. Remova o cabeçalho Authorization do conector "atlassian-token" e use "Entrar com OAuth" em P | 2 campo(s): ATLASSIAN_EMAIL (env, obrigatório); ATLASSIAN_API_TOKEN (env, secreto, obrigatório) |
| GitHub (oficial) | `https://api.githubcopilot.com/mcp/` | 401 | O servidor "github" recusou a credencial do cabeçalho (Authorization): o token pode estar inválido, expirado, sem permissão ou ser de outro ambiente. Gere um novo token, atualize o conector e use mcp_reload. | 1 campo(s): Authorization (header, prefixo "Bearer", secreto, obrigatório) |
| Learning Commons | `https://kg.mcp.learningcommons.org/mcp` | 401 | O servidor "learning-commons" recusou a credencial do cabeçalho (x-api-key): o token pode estar inválido, expirado, sem permissão ou ser de outro ambiente. Gere um novo token, atualize o conector e use mcp_reload. | 1 campo(s): x-api-key (header, secreto, obrigatório) |

## Locais (22)

| Conector | Comando | Resultado | Ferramentas | Tempo | Observação |
|---|---|---|---|---|---|
| Brave Search | `npx -y @brave/brave-search-mcp-server --transport stdio --brave-api-key ${BRAVE_API_KEY}` | Local: exige credenciais (recusa sem elas) |  | 0.0 s | exige BRAVE_API_KEY — Preencha os campos obrigatórios; os valores vão para o cofre do sistema, nunca para o arquivo de configuração. |
| Chrome DevTools | `npx -y chrome-devtools-mcp@latest` | Local: subiu e listou ferramentas | 32 | 9.0 s | chrome_devtools 1.12.0 |
| Desktop Commander | `npx -y @wonderwhy-er/desktop-commander@latest` | Local: subiu e listou ferramentas | 25 | 14.1 s | desktop-commander 0.3.1 |
| Excel | `npx -y @negokaz/excel-mcp-server` | Local: subiu e listou ferramentas | 7 | 10.2 s | excel-mcp-server 0.12.0-SNAPSHOT-1ff4340 |
| Fetch | `uvx mcp-server-fetch` | Local: subiu e listou ferramentas | 1 | 10.6 s | mcp-fetch 2026.10.24 |
| Figma (app local) | `http://127.0.0.1:3845/mcp` | Local: depende de um aplicativo aberto |  | 2.0 s | o aplicativo que serve este endereço não está aberto — Nada está ouvindo no endereço local de "figma" (http://127.0.0.1:3845/mcp). Abra o aplicativo que oferece este servidor (por exemplo o Figma Desktop com o servidor MCP do modo Dev ligado) e use mcp_reload. |
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem ${ALLOWED_PATH}` | Local: subiu e listou ferramentas | 14 | 8.5 s | secure-filesystem-server 1.0.0; chamada de prova list_allowed_directories: ok |
| Firebase | `npx -y firebase-tools@latest mcp` | Local: subiu e listou ferramentas | 19 | 27.3 s | firebase 0.3.0 |
| Git | `uvx mcp-server-git --repository ${REPO_PATH}` | Local: subiu e listou ferramentas | 12 | 6.3 s | mcp-git 2026.10.19 |
| Jira + Confluence (local, mcp-atlassian) | `uvx mcp-atlassian` | Local: exige credenciais (recusa sem elas) |  | 0.0 s | exige JIRA_API_TOKEN — Preencha os campos obrigatórios; os valores vão para o cofre do sistema, nunca para o arquivo de configuração. |
| Laravel Boost | `php artisan boost:mcp` | Local: falta o programa no PC |  | 0.0 s | falta o programa no PC (php) — O comando "php" não foi encontrado. Instale "php" ou informe o caminho completo do executável no campo comando do conector; depois use mcp_reload. |
| MarkItDown (documentos) | `uvx markitdown-mcp` | Local: subiu e listou ferramentas | 1 | 30.1 s | markitdown |
| Memory (grafo de conhecimento) | `npx -y @modelcontextprotocol/server-memory` | Local: subiu e listou ferramentas | 9 | 9.7 s | memory-server 1.0.0; chamada de prova read_graph: ok |
| Playwright (navegador) | `npx -y @playwright/mcp@latest` | Local: subiu e listou ferramentas | 25 | 8.0 s | Playwright 1.64.0-alpha-1790635538000 |
| PostgreSQL | `npx -y @modelcontextprotocol/server-postgres ${DATABASE_URL}` | Local: exige credenciais (recusa sem elas) |  | 0.0 s | exige DATABASE_URL — Preencha os campos obrigatórios; os valores vão para o cofre do sistema, nunca para o arquivo de configuração. |
| Sequential Thinking | `npx -y @modelcontextprotocol/server-sequential-thinking` | Local: subiu e listou ferramentas | 1 | 8.0 s | sequential-thinking-server 1.0.0 |
| Serena (análise semântica) | `uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context ide-assistant` | Local: subiu e listou ferramentas | 3 | 30.2 s | Serena 2.1.1.dev0 |
| SQLite | `uvx --with mcp~=1.6 mcp-server-sqlite --db-path ${DB_PATH}` | Local: subiu e listou ferramentas | 6 | 9.3 s | sqlite 0.1.0 |
| Stripe (local) | `npx -y @stripe/mcp --api-key=${STRIPE_SECRET_KEY}` | Local: exige credenciais (recusa sem elas) |  | 0.0 s | exige STRIPE_SECRET_KEY — Preencha os campos obrigatórios; os valores vão para o cofre do sistema, nunca para o arquivo de configuração. |
| Supabase (local) | `npx -y @supabase/mcp-server-supabase@latest --access-token ${SUPABASE_ACCESS_TOKEN}` | Local: exige credenciais (recusa sem elas) |  | 0.0 s | exige SUPABASE_ACCESS_TOKEN — Preencha os campos obrigatórios; os valores vão para o cofre do sistema, nunca para o arquivo de configuração. |
| Terraform | `docker run -i --rm hashicorp/terraform-mcp-server` | Local: falta o programa no PC |  | 0.0 s | falta o programa no PC (docker) — O comando "docker" não foi encontrado. Instale e inicie o Docker Desktop; depois use mcp_reload. |
| Time | `uvx mcp-server-time` | Local: subiu e listou ferramentas | 2 | 7.2 s | mcp-time 2026.10.19 |

## Bloqueados, inalcançáveis e a investigar (98)

| Conector | Endpoint | Nível | Resultado | Causa observada | Erro (trecho) |
|---|---|---|---|---|---|
| AccuWeather® | `https://mcp.accuweather.com/v0/mcp/claude` | N1 | Bloqueado pelo serviço | HTTP 401 sem metadados OAuth descobríveis | HTTP 401 em initialize: { "type": "https://httpproblems.com/http-status/401", "title": "Unauthorized", "status": 401, "detail": "No Authoriz |
| Aiwyn Tax (formerly Column Tax) | `https://mcp.columnapi.com/mcp` | N1 | Inalcançável | HTTP 503 do servidor | HTTP 503 em initialize: unconditional drop overload |
| AppFolio Realm-X | `https://mcp.appfolio.com/` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: {"error": "invalid_token", "error_description": "Authentication failed. The provided bearer token is invalid, expire |
| athenahealth (beta) | `https://api.platform.athenahealth.com/mcp/patients` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: { "message":"Forbidden: IP not allowed [168.228.245.79]", "request_id":"aebf60583d455034d25ab1309ab68666" } |
| Audible | `https://mcp.audible.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <html> <head><title>403 Forbidden</title></head> <body> <center><h1>403 Forbidden</h1></center> </body> </html> |
| Aura | `https://mcp.auraintelligence.com/mcp` | N0 | Inalcançável | falha de TLS/certificado | falha de rede em initialize: fetch failed (ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR) |
| Benevity | `https://mcp.benevity.org/general/v1/nonprofit` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width, initial-scale=1"><title>403</t |
| BlackRock Advisor Center | `https://ac360-mcp.blackrock.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <HTML><HEAD> <TITLE>Access Denied</TITLE> </HEAD><BODY> <H1>Access Denied</H1> You don't have permission to access " |
| Bloomberg Law | `https://gw.mcp.bindg.ai/blaw/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o servidor recusa o registro (403) sem dar o motivo | HTTP 401 em initialize: {"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Authentication required","data":{"type":"authentication |
| Booking.com | `https://demandapi-mcp.booking.com/v1/mcp/8132308` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"> <HTML><HEAD>< |
| CAISey | `https://mcp.caisgroup.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: [desafio: Bearer scope="openid", resource_metadata="https://mcp.caisgroup.com/.well-known/oauth-protected-resource/m |
| CarGurus | `https://mcp-apps.api.cargurus.com/chat-mcp/v1/stream` | N1 | Bloqueado pelo serviço | HTTP 406: a URL não responde como MCP | HTTP 406 em initialize: |
| Carrefour | `https://claude.mcp.carrefour.fr/v1.2/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 403 em initialize: <!DOCTYPE html> <html lang="fr"> <head> <title>Carrefour</title> <meta charset="UTF-8"> <meta name="viewport" conten |
| Cashfree | `https://mcp.cashfree.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: { "message": "authentication Failed", "code": "request_failed", "type": "authentication_error" } |
| Checkatrade | `https://api.checkatrade.com/consumer-claude-mcp/v1/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html clas |
| CloudBees Unify MCP Server | `https://mcp.cloudbees.io/v1/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (404): o endpoint de registro anunciado responde 404/5xx | HTTP 401 em initialize: no bearer token [desafio: Bearer resource_metadata="https://mcp.cloudbees.io/.well-known/oauth-protected-resource", |
| Cloverleaf | `https://app.cloverleaf.me/api/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"success":false,"error":"Bearer resource_metadata=\"https://app.cloverleaf.me/api/mcp/.well-known/oauth-protected-r |
| Cloze MCP | `https://api.cloze.com/v1/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado: só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: {"errorcode":1,"message":"The API key was not found"} |
| CoCounsel Legal | `https://cocoagent-service.cocounsel.thomsonreuters.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): registro dinâmico desativado pelo serviço | HTTP 401 em initialize: [desafio: Bearer resource_metadata="https://cocoagent-service.cocounsel.thomsonreuters.com/.well-known/oauth-protect |
| CorralData | `https://mcp.corraldata.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: [desafio: Bearer resource_metadata="https://mcp.corraldata.com/.well-known/oauth-protected-resource/mcp"] |
| Cottages | `https://mcp.cottages.com/mcp` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: {"message":"Forbidden","statusCode":403} |
| D&B Digital Audiences | `https://mcp.atportal.dnb.com/v1/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) | HTTP 401 em initialize: {"message":"Missing or invalid authorization header"} [desafio: Bearer resource_metadata="https://mcp.atportal.dnb.c |
| Datasite | `https://mcp.global.datasite.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"errors":[{"status":401,"details":"No API key found in request","code":"Unauthorized"}],"meta":{"timestamp":1793086 |
| DirectBooker | `https://www.directbooker.ai/claude` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width, initial-scale=1"><title>403</t |
| EDEN by Basecamp Research | `https://mcp-public.basecamp-research.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): limite de clientes registrados no serviço | HTTP 401 em initialize: {"error": "invalid_token", "error_description": "Authentication failed. The provided bearer token is invalid, expire |
| eDreams | `https://www.edreams.com/ai-travel-assistant/claude/v1/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 406) | HTTP 406 em initialize: Request blocked |
| Eedi | `https://teacher-tools.eedi.ai/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: {"error":null,"error_description":"no bearer token (discovery probe \u2014 expected on first connect)"} [desafio: Be |
| etoro | `https://mcp-readonly.public-api.etoro.com/` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: {"error":"unauthorized","error_description":"This server accepts OAuth bearer tokens only (Authorization: Bearer); x |
| Expedia | `https://www.expedia.com/mcp` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: |
| Figma | `https://mcp.figma.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o servidor recusa o registro (403) sem dar o motivo | HTTP 401 em initialize: Unauthorized [desafio: Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope=" |
| FINNY | `https://mcp.finny.com/mcp` | N0 | Inalcançável | tempo esgotado | timeout de MCP finny.initialize (8897ms) |
| Franklin Templeton Funds and Insights | `https://api.frk.com/mcp/v1/ft-funds-insights/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: { "statusCode": "403", "message": "Access Denied." } |
| FreshBooks | `https://mcp.freshbooks.com/v1` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: [desafio: Bearer error="invalid_token", error_description="The access token is missing or invalid", resource_metadat |
| GetYourGuide | `https://widget.getyourguide.com/apis/mcp-apps` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html> <html> <head> <meta charset="utf-8"> <meta name="viewport" content="width=device-width,initial-scale |
| Glovo | `https://api.glovoapp.com/discovery-mcp/mcp` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: Forbidden |
| GoVola | `https://mcp.govola.com/mcp-anthropic` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, in |
| Grasshopper Bank | `https://grasshopper-mcp.prd.narmitech.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"jsonrpc": "2.0", "error": {"code": -32000, "message": "Missing Bearer token"}} [desafio: Bearer realm="MCP Server" |
| Harness | `https://mcp.harness.io/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: {"body":{"responseMessages":[{"code":"UNAUTHORIZED","level":"ERROR","message":"Invalid authorization header format"} |
| Helix GenoSphere | `https://mcp.hrn-production.helix.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <html> <head><title>403 Forbidden</title></head> <body> <center><h1>403 Forbidden</h1></center> </body> </html> |
| Highspot | `https://mcp.highspot.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): registro dinâmico desativado pelo serviço | HTTP 401 em initialize: {"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid authorization header. Expected format: Bearer <token>"}," |
| ICE Data Services | `https://fids-mcp.ice.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: Access Denied |
| idealista | `https://mcp-app.idealista.com/claude/v1/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: Access denied. |
| iManage Work | `https://cloudimanage.com/mcp/work` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: {"error":{"code":"IM_E_UNAUTHORIZED","code_message":"Un-authorized"}} [desafio: Bearer resource_metadata="https://cl |
| InfoTrack | `https://mcp.infotrack.ai/servers/infotrack-all/mcp` | N0 | Inalcançável | tempo esgotado | timeout de MCP infotrack.initialize (8899ms) |
| Instrumentl | `https://mcp.instrumentl.com/` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text |
| Intuit Credit Karma | `https://anthropic.mcp.creditkarma.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 200) | resposta MCP inválida para initialize (HTTP 200, text/html, redirecionado para anthropic.mcp.creditkarma.com/Error_Credit_Karma.htm): o ende |
| Intuit Developer | `https://ai-inc-developer.intuit.com/v1/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"code":"AuthenticationFailed","type":"INPUT","message":null,"detail":null,"moreInfo":null} [desafio: Bearer realm=" |
| Intuit QuickBooks | `https://ai-inc.quickbooks.intuit.com/v1/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <HTML><HEAD> <TITLE>Access Denied</TITLE> </HEAD><BODY> <H1>Access Denied</H1> You don't have permission to access " |
| Intuit TurboTax | `https://ai-inc.turbotax.intuit.com/358A1C1B-F73B-46A7-B130-4B14916E6843/v1/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <HTML><HEAD> <TITLE>Access Denied</TITLE> </HEAD><BODY> <H1>Access Denied</H1> You don't have permission to access " |
| Invesco for Advisors | `https://financial-professional-mcp.invesco.com/mcp` | N0 | Inalcançável | tempo esgotado | timeout de MCP invesco-for-advisors.initialize (8896ms) |
| J.P. Morgan Asset Management (55ip) | `https://mcp.55-ip.com/proposal-generation-mcp/mcp` | N0 | Inalcançável | tempo esgotado | timeout de MCP j-p-morgan-asset-management-55ip.initialize (8900ms) |
| Juro contracts | `https://integrations.app.juro.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: Unauthorized [desafio: Bearer resource_metadata="https://integrations.app.juro.com/mcp/.well-known/oauth-protected-r |
| Jus AI by Jus Mundi (Light Mode) | `https://mcp.jusmundi.com/` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: no bearer token [desafio: Bearer resource_metadata="https://mcp.jusmundi.com/.well-known/oauth-protected-resource", |
| lastminute.com | `https://mcp.lastminute.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text |
| Leadfeeder | `https://mcp.leadfeeder.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"errors":[{"code":"unauthorized","title":"Unauthorized"}]} [desafio: Bearer resource_metadata="https://mcp.leadfeed |
| LetsBot | `https://letsbot.net/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Authentication required. Provide API key via Authorization: Beare |
| Light | `https://api.light.inc/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): limite de clientes registrados no serviço | HTTP 401 em initialize: {"type":"UNAUTHORIZED","message":"Credentials are required to access this resource"} [desafio: Bearer resource_metad |
| LSEG | `https://api.analytics.lseg.com/lfa/mcp/server-cl` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing Bearer token"}} [desafio: Bearer realm="MCP Server", reso |
| LSEG AI | `https://mcp.lseg.com/` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (404): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing Bearer token"}} [desafio: Bearer realm="MCP Server", reso |
| Manatal | `https://mcp.manatal.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: [desafio: Bearer resource_metadata="https://mcp.manatal.com/.well-known/oauth-protected-resource"] |
| Maryland Community Compass | `https://compass.maryland.gov/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <html> <head><title>403 Forbidden</title></head> <body> <center><h1>403 Forbidden</h1></center> </body> </html> |
| McAfee | `https://claudecompanion.gateway.api.mcafee.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <html> <head><title>403 Forbidden</title></head> <body> <center><h1>403 Forbidden</h1></center> </body> </html> |
| Meridian Connector for QuickBooks | `https://qbo-connector.meridian.pilot.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: {"error":"authentication_required","error_description":"Authenticate with QuickBooks Connector by Meridian to contin |
| Meridian Connector for Xero | `https://xero-connector.meridian.pilot.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: {"error":"authentication_required","error_description":"Authenticate with Xero Connector by Meridian to continue."} |
| Moody's Credit MCP | `https://mcp.moodys.com/genai-ready-data/Credit/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Expected Authorization: Bearer <token>"},"id":1} |
| Norton | `https://ai-connect.norton.com/claude/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <html> <head><title>403 Forbidden</title></head> <body> <center><h1>403 Forbidden</h1></center> </body> </html> |
| Novasol | `https://mcp.novasol.com/mcp` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: {"message":"Forbidden","statusCode":403} |
| Omnisend MCP | `https://mcp.omnisend.com/v2/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: Unauthorized [desafio: Bearer resource_metadata="https://mcp.omnisend.com/.well-known/oauth-protected-resource", err |
| Orion | `https://gateway.oriondenali.ai/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) | HTTP 401 em initialize: {"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Authentication is required."}} [desafio: Bearer resourc |
| Oxford Economics | `https://services.oxfordeconomics.com/mcp` | N2 | Falhou (a investigar) | registro dinâmico recusado (400) sem motivo claro | HTTP 401 em initialize: [desafio: Bearer resource_metadata="https://services.oxfordeconomics.com/.well-known/oauth-protected-resource/mcp"] |
| Phoenix by HG Insights | `https://phoenix.hginsights.com/api/ai/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"jsonrpc":"2.0","error":{"code":-32603,"message":"Unauthorized: No Bearer token provided","requestId":"mvqddkt1-bz9 |
| PitchBook Premium | `https://premium.mcp.pitchbook.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: [desafio: Bearer resource_metadata="https://premium.mcp.pitchbook.com/.well-known/oauth-protected-resource/mcp"] |
| PlayMCP | `https://playmcp.kakao.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o registro é restrito por IP/região | HTTP 401 em initialize: [desafio: Bearer resource_metadata="https://playmcp.kakao.com/.well-known/oauth-protected-resource/mcp"] |
| Risotto | `https://dashboard.tryrisotto.com/settings/integrations/mcp` | N1 | Bloqueado pelo serviço | a URL não fala MCP (nenhum transporte funcionou) | nenhum transporte MCP funcionou neste endereço: HTTP 405 em initialize: ; o endereço não é um fluxo SSE (HTTP 200) |
| Rome2Rio | `https://chatgpt-app.rome2rio.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html clas |
| Salesloft | `https://mcp.salesloft.com/sse` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em sse: {"error":{"code":-32000,"message":"User not authenticated"},"id":"null","jsonrpc":"2.0"} [desafio: Bearer resource_metadata |
| SciSpace | `https://scispace.com/mcp-kls34hjb` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"> <HTML><HEAD>< |
| Shipt | `https://member-api.shipt.com/marketplace-mcp/v2.0/mcp` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: |
| Similarweb | `https://mcp.similarweb.com/` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"error":"invalid_request","error_description":"Authentication required. Provide either 'api-key' header or 'Authori |
| Stack Overflow | `https://mcp.stackoverflow.com/` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text |
| Strava | `https://mcp.strava.com/mcp` | N2 | Falhou (a investigar) | registro dinâmico recusado (400) sem motivo claro | HTTP 401 em initialize: unauthorized [desafio: Bearer resource_metadata="https://www.strava.com/.well-known/oauth-protected-resource"] |
| StubHub | `https://open-ai-app.stubhub.net/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"> <HTML><HEAD>< |
| Synthesize Bio | `https://app.synthesize.bio/api/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: Unauthorized [desafio: Bearer realm="https://app.synthesize.bio", error="invalid_request", resource_metadata="https: |
| Tango | `https://govcon.dev/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita URLs de retorno aprovadas (recusou 127.0.0.1 e localhost) | HTTP 401 em initialize: {"error":"Authentication required"} [desafio: Bearer resource_metadata="https://govcon.dev/.well-known/oauth-protect |
| The Economist - Graphs | `https://mcp-app.economist.com/mcp/claude` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html clas |
| Ticketmaster | `https://partner-mcp.ticketmaster.com/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <?xml version="1.0" encoding="utf-8"?> <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/T |
| Trellis | `https://mcp.trellis.law/anthropic` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 403 em initialize: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html clas |
| Trussi AI | `https://my.trussi.ai/api/mcp/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"error":"invalid_token","error_description":"No authorization provided"} [desafio: Bearer error="invalid_token", er |
| Turo | `https://mcp.turo.com/v1/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <html lang="en"> <head> <meta charset="utf-8" /> <meta content="width=device-width, initial-scale=1" name="viewport" |
| Turquoise | `https://mcp.turquoise.health/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text |
| Vanguard Advisor Tools | `https://mcp.vanguard.com/advisors` | N1 | Bloqueado pelo serviço | a URL não fala MCP (nenhum transporte funcionou) | nenhum transporte MCP funcionou neste endereço: HTTP 404 em initialize: <!DOCTYPE HTML> <html lang="en"> <head> <meta charset="UTF-8"/> <met |
| Verisk XactRestore | `https://xactrestore-xactremodelserver-usw2-prod.propsol.io/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o registro exige sessão ou token inicial (não é aberto) | HTTP 401 em initialize: [desafio: Bearer error="invalid_token", error_description="The access token is expired or invalid", resource_metadat |
| Vital Care Finder | `https://mcp.vital.io/` | N1 | Bloqueado pelo serviço | HTTP 403 sem metadados OAuth descobríveis | HTTP 403 em initialize: {"message":"Forbidden"} |
| Wyndham Hotels and Resorts | `https://mcp.wyndhamhotels.com/claude/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <HTML><HEAD> <TITLE>Access Denied</TITLE> </HEAD><BODY> <H1>Access Denied</H1> You don't have permission to access " |
| Yelp | `https://mcp-anthropic.yelp.com/claude/mcp` | N1 | Bloqueado pelo serviço | provável bloqueio de WAF/CDN (HTTP 403) | HTTP 403 em initialize: <?xml version="1.0" encoding="utf-8"?> <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/T |
| ZipRecruiter | `https://api.ziprecruiter.com/mcp` | N1 | Bloqueado pelo serviço | HTTP 429: a URL não responde como MCP | HTTP 429 em initialize: Too Many Requests |
| ZoomInfo | `https://mcp.zoominfo.com/mcp` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (400): só aceita clientes aprovados (lista de permitidos) | HTTP 401 em initialize: {"detail":"The Authorization token is required and cannot be left blank. Please provide a valid token and try again. |
| 中央社新聞 CNA TAIWAN NEWS | `https://ask.cna.com.tw/mcp/connect` | N2 | Bloqueado pelo serviço | registro dinâmico recusado (403): o WAF/CDN bloqueou o registro (página HTML) | HTTP 401 em initialize: {"error":"Unauthorized"} [desafio: Bearer resource_metadata="https://ask.cna.com.tw/mcp/.well-known/oauth-protected- |

## Sem endpoint público (83)

O diretório do Claude lista estes conectores sem URL (o endpoint é por conta/tenant). O app pede a URL ao usuário (confirmado: `connect` sem URL devolve "Informe a URL do servidor MCP"):

ActiveCampaign, Amplitude, Articulate, AutoRFP.ai, AWS MCP, BambooHR, Benchling, Bigin by Zoho CRM, Braze, Brightflag, Bronto, Catalyst by Zoho, Celigo, Chargebee, Collibra, Conquest MCP Server, Coralogix, Craft.io, Customer.io, Dagster+ MCP, Databricks Genie, Datadog, DataGrail, dbt, Dremio Cloud, Elastic Cloud Serverless, Eulerian Marketing Platform, Freshservice, Funnel, Gainsight (CS), Glean, Harvey, Hebbia, Honeybadger, Informatica Catalog Discovery, Informatica Data Exploration, Intapp Celeste, Ironclad Contracts, Ivo, JupiterOne, Lloyd by The L Suite, Mary, Metabase, Microsoft Dataverse, Motherboard, n8n, Natoma, NetDocuments, NetSuite, Pendo, Pigment, Port IO, Pushwoosh ManyMoney, Qlik, Reco, Relativity, Retool, Revvity Signals AI, Salesforce, Sana from Workday, SandboxAQ, ServiceNow, Sigma, Smarter Drafter, Smartsheet, Snowflake, Sourcegraph, SpotDraft, Sprinto MCP, Starburst, Steadybit, Synthflow, UKG Bryte, Vani by Zoho, Visier, Wingify, Workato, YouTrack, Zoho Books, Zoho CRM, Zoho Desk, Zoho Projects, Zoho Show

## Limitações

- Instantâneo de 2026-10-27: serviços mudam, e falhas de rede intermitentes podem aparecer como N0; repita só os afetados com `--only <id>` ou `--retest unreachable,blocked`.
- N3 prova que o login *pode* começar (descoberta + cliente + URL com PKCE); a página de consentimento e a troca do código só existem com a conta do usuário (N5).
- Conectores abertos marcados com ✱ listam ferramentas sem login, mas o teste só chamou uma ferramenta somente-leitura quando havia uma sem argumentos obrigatórios.
- O teste não tenta contornar WAF/CAPTCHA nem repete tentativas: 403 de WAF fica como bloqueio do lado do serviço.
- Os resultados de sucesso (login pronto, abertos) vêm da primeira rodada completa; as rodadas seguintes repetiram só os que falharam, depois de cada correção. Uma rodada completa nova repetiria o registro dinâmico descartável em ~500 servidores de terceiros: evite sem necessidade.
- Os conectores `oauth` cujo registro dinâmico é recusado por política do serviço não têm hoje onde receber um client id na tela: o formulário de Client ID só aparece para `oauth-static`, embora `connect` aceite `oauthClient` também para `oauth`. Fica como pendência da interface (nada foi alterado em `src/renderer`).
- Servidores `uvx` desta máquina só sobem com um cache novo do uv (`UV_CACHE_DIR`): o cache padrão tem arquivos presos (pywin32, "os error 32"). O teste isolou o cache numa pasta temporária; o cache real do usuário não foi tocado.

## Como repetir

```powershell
npm run test:connectors                          # todos (~10 min; npx/uvx baixam pacotes na primeira vez)
npm run test:connectors -- --only notion,slack   # só alguns ids
npm run test:connectors -- --retest failed,blocked --note "o que foi corrigido"
npm run test:connectors -- --skip-local          # só os remotos
npm run test:connectors -- --report-only         # regenera este relatório a partir do JSON
npx vitest run tests/mcp-connectors-test.test.ts tests/mcp*.test.ts tests/connector*.test.ts
```
