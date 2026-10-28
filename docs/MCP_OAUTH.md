# MCP remoto com OAuth 2.1

O Openclod agora segue o mesmo modelo do Claude Desktop para servidores MCP
remotos: o conector é salvo só com a URL, o servidor responde `401`, e o login
OAuth é iniciado quando você conecta o conector. O cliente descobre os metadados
OAuth, registra-se dinamicamente, abre o navegador e troca o código por um
access token de curta duração. Nenhum API token fixo é necessário.

O startup do app nunca bloqueia esperando um consentimento: ele tenta um token
já salvo e, se não houver, marca o conector como `401` e mostra o botão
**Entrar com OAuth**. O catálogo dispara o login logo após adicionar o conector.

## Fluxo

```
POST initialize (sem token)
  → 401 + WWW-Authenticate: Bearer resource_metadata="..."
  → conector fica marcado como "precisa de login"
  → usuário clica em Entrar com OAuth
  → GET resource_metadata
      scopes_supported + authorization_servers
  → GET <issuer>/.well-known/oauth-authorization-server
      authorization_endpoint + token_endpoint + registration_endpoint
  → POST registration_endpoint (DCR, RFC 7591)
      client_id (+ client_secret quando o servidor exigir)
  → abrir authorization_endpoint
      response_type=code, PKCE S256, state, resource, scope
  → callback em http://127.0.0.1:<porta>/callback
  → POST token_endpoint
      code + code_verifier + client_id + resource
  → retry do initialize com Authorization: Bearer <access_token>
```

O access token fica em `data/oauth/mcp-oauth.json`, cifrado com o cofre do
sistema (DPAPI no Windows via `safeStorage`). O backup exclui `data/oauth/`.
Quando o token expira, o `refresh_token` é usado antes de abrir o navegador de
novo.

## Jira / Atlassian

O conector oficial virou **OAuth-first** no catálogo, igual ao Claude Desktop.
A configuração oficial do Claude é só:

```json
{ "mcpServers": { "atlassian": { "url": "https://mcp.atlassian.com/v2/mcp" } } }
```

A documentação da Atlassian confirma: “Atlassian MCP is powered by secure
OAuth 2.1 authorization”, e a autenticação acontece quando o cliente inicia o
fluxo — sem header nem API token no arquivo.

| Entrada | Transporte | Autenticação |
|---|---|---|
| `Atlassian (Jira + Confluence, oficial)` | HTTP `https://mcp.atlassian.com/v2/mcp` | OAuth 2.1 (recomendado) |
| `Atlassian (API token)` | HTTP, mesmo endpoint | Basic e-mail + API token |
| `Jira + Confluence (local, mcp-atlassian)` | stdio `uvx mcp-atlassian` | REST API com e-mail + token |

O endpoint `/v2/mcp` responde `401` para Basic e anuncia:

```
WWW-Authenticate: Bearer resource_metadata="https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp"
```

O PRM do Atlassian lista 40 escopos `*:agent-interface` e `offline_access`; o
authorization server é `https://auth.atlassian.com/<tenant>`, com DCR em
`/dcr/register`. O fluxo foi verificado contra os metadados reais: o registro
dinâmico responde `201`, e a URL de autorização (com `resource` e todos os
escopos) redireciona para o login do Atlassian.

### Se você já tem o conector antigo com Basic

Não é preciso reinstalar. O cliente passou a dar precedência ao token OAuth
sobre qualquer header `Authorization` fixo. Ao conectar:

1. O conector aparece com erro `HTTP 401` (o Basic não vale para `/v2/mcp`).
2. Clique em **Entrar com OAuth** em Personalização → Conectores.
3. O login OAuth abre no navegador.
4. O retry usa `Bearer`, não o Basic.
5. Nas próximas aberturas, o token cacheado é reutilizado.

## URL de retorno fixa

O login volta para `http://127.0.0.1:38565/callback` (`MCP_OAUTH_REDIRECT_URI`, em
`src/shared/mcp-connectors.ts`). A porta é **fixa de propósito**: Slack, Google, GitHub e a
maioria dos provedores só aceitam a URL de retorno **exata** cadastrada no aplicativo OAuth,
então uma porta aleatória por login (que o registro dinâmico tolera) inutilizaria um
aplicativo cadastrado. Só se a porta estiver ocupada o login usa outra, e então o estado do
conector avisa (`hint`) e mostra a URL realmente usada (`redirectUri`).

O estado de todo conector `oauth`/`oauth-static` traz `redirectUri`: a interface mostra
"cadastre esta URL de retorno no seu aplicativo". O servidor de callback responde com
`Connection: close`, para que um navegador não reaproveite a conexão de um login anterior
(a porta é a mesma de um login para o outro).

## Conectores oauth-static: o seu aplicativo OAuth

Em `oauth-static` o servidor de autorização não aceita registro dinâmico (Slack, GitHub, Box,
HubSpot, Docusign, Google...). O Claude tem client ids próprios; o Openclod não tem, então o
usuário cria um aplicativo OAuth no serviço:

1. Cadastrar **exatamente** a URL de retorno mostrada na interface.
2. Informar o client ID (e o segredo, se for um cliente confidencial) ao conectar:
   `connectConnector(id, { oauthClient: { clientId, clientSecret? } })`.
3. O segredo vai para o cofre do sistema (`mcp:<servidor>.oauth_client_secret`), nunca para
   `settings.json`; o client id fica ao lado dele. A reconexão reutiliza o que está guardado.
   Desconectar apaga os dois.
4. O segredo é enviado como o servidor anuncia (`client_secret_post`, senão
   `client_secret_basic`); um servidor que só conhece clientes públicos (`none`) não recebe o
   segredo. O refresh usa a mesma autenticação.

Se o provedor recusar o client ou a URL, o erro diz: "client id inválido ou URL de retorno não
cadastrada: cadastre exatamente <URL>", com a dica e `redirectUri`. Quando o provedor só mostra
uma página de erro e ninguém volta, o fim do tempo (5 min) traz a mesma orientação.

`oauthClient` também substitui o registro dinâmico em conectores `oauth` (opcional).
Client ID Metadata Documents ficaram para o futuro: `docs/mcp/CLIENT-ID-METADATA-DOCUMENTS.md`.

## Ensaio (dry run)

`connectConnector(id, { dryRun: true })` (ou `McpOAuthManager.prepareAuthorization`) ensaia o
login **sem abrir o navegador, sem subir o servidor de callback, sem instalar nem guardar
nada**: descoberta (RFC 9728/8414/OIDC), escolha do client (o seu > o do diretório > registro
dinâmico: UMA tentativa, prazo de 8 s, nome "Openclod Desktop teste" (curto e sem pontuação: a Shippo
limita `client_name` a 39 caracteres e o Calendly só aceita letras, números, hífen e espaço), client descartado) e a URL de autorização com PKCE. Se o
servidor recusar `http://127.0.0.1:<porta>/callback` no registro (400/422), o registro é repetido
UMA vez com `http://localhost:<porta>/callback` (o mesmo listener atende os dois endereços,
IPv4 e IPv6); vale para o login real também, e só para registro dinâmico: o aplicativo OAuth do
próprio usuário continua com a URL fixa. Sem metadados nos caminhos `.well-known`, a descoberta
pergunta ao servidor o `WWW-Authenticate` de um `initialize` sem credenciais e segue o
`resource_metadata` que ele anuncia (aspas ou não). Devolve `{ ok, authUrl, steps: [{ step, ok, ms,
detail }], error, hint }`. `minIntervalMs` espaça as requisições ao mesmo host. O módulo
`src/main/mcp-oauth.ts` não importa o Electron (o abridor é injetado: opção `openUrl`), então um
script Node usa o mesmo código.

## Descoberta com mais de um documento (Mercado Pago)

Um servidor pode publicar um documento de recurso por caminho. O Mercado Pago publica um em
`/.well-known/oauth-protected-resource/mcp` (issuer `…/mcp`, registro em `/oauth/register/mcp`) e
outro genérico na raiz, cujo registro (`/oauth/register`) responde 400. Por isso os documentos
são tentados do mais específico para o mais geral, e o primeiro cujo servidor de autorização
responde vale. Foi isso que corrigiu o "o servidor OAuth não aceitou registro dinâmico".

## Limitações

- O cliente conecta **da sua máquina** ao servidor remoto. O Claude Desktop usa
  a infraestrutura da Anthropic para conectores remotos; nós não temos essa
  nuvem. A rede local precisa alcançar o endpoint.
- O consentimento OAuth ainda pode exigir aprovação do administrador da
  organização. Isso é do provedor, não do Openclod.
- CIMD (Client ID Metadata Document) ainda não é usado. O Atlassian oferece DCR
  no authorization server do MCP, então o fluxo atual funciona; para provedores
  que só aceitam CIMD, será necessário publicar um documento HTTPS do cliente
  (veja `docs/mcp/CLIENT-ID-METADATA-DOCUMENTS.md`).
- Tokens OAuth não são compartilhados entre máquinas nem entram no backup.

## Verificação

```powershell
npm run typecheck
npx vitest run tests/mcp-oauth.test.ts tests/mcp-http.test.ts tests/mcp-catalog.test.ts
npm run build
```

Os testes cobrem descoberta de PRM, escopos, DCR com `client_secret`, PKCE,
troca de token, precedência do Bearer sobre Basic e armazenamento cifrado.
