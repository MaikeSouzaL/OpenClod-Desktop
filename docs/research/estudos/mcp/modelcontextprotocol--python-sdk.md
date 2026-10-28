# MCP Python SDK (v2)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/modelcontextprotocol/python-sdk |
| Clone local | `repositorios/_research/mcp/modelcontextprotocol--python-sdk` |
| Commit | `a525a3d9bece967d91534b746a6c842931b7b4ec` |
| Licença | MIT (`LICENSE:1-3`; `pyproject.toml:15`) |
| Categoria | mcp (SDK cliente/servidor) |
| Stack | Python >= 3.11 (`pyproject.toml:6`), anyio, Pydantic 2, httpx2, uv/hatchling, pytest |
| Tamanho | 1.726 arquivos; ~28.729 linhas em `src/mcp` e ~91.409 linhas de teste (238 arquivos `test_*.py`) |

## 1. O que é (verificado no código)

É o SDK oficial de MCP para Python na linha **v2**, que fala a revisão
`2026-07-28` e mantém interoperabilidade com a era `initialize`
(`docs/whats-new.md:3`). A v2 foi uma reescrita: `FastMCP` virou `MCPServer`
(`docs/whats-new.md:14-21`), o cliente ganhou uma classe `Client` de alto nível
(`src/mcp/client/client.py:268`) e o servidor ganhou um runner que decide a era
por conexão (`src/mcp/server/runner.py:602-650`).

O ponto de arquitetura mais interessante é que o SDK tem **duas camadas de
servidor**: `Server` baixo nível, com handlers por método
(`src/mcp/server/lowlevel/server.py:129`), e `MCPServer` alto nível, com
decorators `tool/resource/prompt` (`src/mcp/server/mcpserver/server.py:669-968`).
No cliente, `Client` resolve transporte/era e `ClientSession` expõe o protocolo
(`src/mcp/client/session.py:388`).

Os tipos do protocolo foram extraídos para a distribuição `mcp-types`
(`src/mcp/types/version.py:1-10`). Isso é relevante para nós: as constantes de
versão não vivem no repositório do SDK, e sim no pacote de tipos.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `uv add "mcp[cli]"` | `README.md:37` | instala SDK + CLI |
| `mcp dev server.py` | `src/mcp/cli/cli.py:221` | sobe o servidor com o MCP Inspector |
| `mcp run server.py` | `src/mcp/cli/cli.py:304` | executa o servidor |
| `mcp install server.py` | `src/mcp/cli/cli.py:361` | instala no Claude Desktop |
| `mcp version` | `src/mcp/cli/cli.py:210` | mostra a versão |
| `uv run pytest` | `CONTRIBUTING.md` (ver seção 13) | suíte completa |
| `mcp run --transport streamable-http` | `docs/protocol-versions.md:12` | sobe o servidor HTTP de exemplo |

A superfície de UX é a CLI (`mcp`) e a API Python. Não há arquivo de
configuração do SDK: transporte, modo de era, timeouts e callbacks são
argumentos de construtor (`client.py:304-345`).

## 3. Arquitetura e fluxo

```
Client(mode="auto")
  → connector (stdio | SSE | Streamable HTTP | in-memory)
  → probe server/discover  ──falha──▶ initialize (legacy)
  → ClientSession (dispatcher JSON-RPC)
  → ServerRunner (legacy) | modern_on_request (2026)
  → handlers (MCPServer | Server)
```

- Entry point do cliente: `src/mcp/client/client.py:268`; `__aenter__` em
  `:455-470`.
- Negociação automática: `src/mcp/client/_probe.py:61-100`; manual em
  `session.py:651` (`initialize`) e `:757` (`discover`).
- Dispatcher: `src/mcp/shared/jsonrpc_dispatcher.py:92-230`; roteamento por
  método/versão em `shared/inbound.py:316-340`.
- Servidor dual-era: `server/runner.py:602-650` (`serve_dual_era_loop`), com
  `serve_legacy_stream` em `:717` e `serve_modern_stream` em `:755`.
- Transporte stdio: `src/mcp/server/stdio.py:162-217` e
  `src/mcp/client/stdio.py:116-215`.
- Streamable HTTP: cliente `src/mcp/client/streamable_http.py:111-790`;
  servidor `src/mcp/server/streamable_http.py:1-969` e manager
  `streamable_http_manager.py:45-398`.
- SSE legado: `src/mcp/server/sse.py:66` e `src/mcp/client/sse.py:1-148`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `Client` (alto nível) | `src/mcp/client/client.py:268` | escolhe transporte e era, expõe `session` | médio |
| `ClientSession.initialize` | `src/mcp/client/session.py:651` | handshake legado, valida versão | baixo |
| `ClientSession.discover` | `session.py:757` | `server/discover`, adota resultado | baixo |
| `ClientSession.call_tool` | `session.py:993-1110` | valida output schema, input required | alto |
| `ClientSession.list_*` | `session.py:890-1290` | listas paginadas (uma página por chamada) | baixo |
| `MCPServer.tool/resource/prompt` | `server/mcpserver/server.py:669-968` | decorators de alto nível | alto |
| `Server` (baixo nível) | `server/lowlevel/server.py:129` | handlers por método, controle total | alto |
| `ServerRunner` | `server/runner.py:157` | despacho, validação por versão, erros | alto |
| `StreamableHTTPSessionManager` | `server/streamable_http_manager.py:45` | sessões, idle timeout, limite, ownership | alto |
| `stdio_server`/`stdio_client` | `server/stdio.py:162`, `client/stdio.py:116` | NDJSON, diversão de fd, kill de árvore | médio |
| `OAuthClientProvider` | `client/auth/oauth2.py:292` | PKCE, PRM/ASM, refresh, resource | alto |
| `BearerAuthBackend`/`RequireAuthMiddleware` | `server/auth/middleware/bearer_auth.py:44-155` | 401/403, escopo, audience | médio |
| Cache de respostas | `client/caching.py:92-200` | TTL, escopo, geração | médio |
| Extensões | `client/extension.py:1`, `server/extension.py:1` | capacidades fora do core | médio |

## 5. Loop do agente, contexto e streaming

Também **não há loop de agente**. O que existe é o dispatcher de JSON-RPC com
controle de cancelamento, progresso e timeout. O dispatcher mantém uma
`CancelScope` por request, trata `notifications/cancelled` e converte exceções
em `ErrorData` (`shared/jsonrpc_dispatcher.py:92-180`). O modo de cancelamento
é `interrupt` por padrão ou `signal` (`:85-90`).

No cliente, `call_tool` valida o resultado contra o `outputSchema` do tool e
só então o devolve (`session.py:1096-1160`). A validação usa o último
`tools/list`; se o schema mudou, o validador é recompilado (`:1127-1160`).

No servidor moderno, **não existe request servidor→cliente**. O runner envolve
o contexto em `_NoServerRequestsDispatchContext`, cujo `send_raw_request`
levanta `NoBackChannelError` (`runner.py:552-600`). O substituto é MRTR:
o handler devolve `InputRequiredResult` com `inputRequests`, e o cliente repete
a chamada com `inputResponses` (`docs/deprecated.md:19-20`).

Streaming HTTP: o cliente abre um stream SSE sobre o corpo da resposta,
guarda `last_event_id` e reconecta com `Last-Event-ID`; o limite de tentativas
é 2 (`client/streamable_http.py:58-61`, `:467-607`). O servidor implementa
priming event, event store e replay (`server/streamable_http.py:1-969`).

Progresso: `ctx.progress` e `notifications/progress`; o dispatcher protege o
callback para uma exceção do usuário não derrubar o task group
(`jsonrpc_dispatcher.py:204-215`).

## 6. Sessões, estado e persistência

- Cliente: `ClientSession` guarda `initialize_result` ou `discover_result`,
  a versão negociada, capabilities e schemas de tools
  (`session.py:445-460`, `:675-712`). `adopt()` instala um resultado já obtido,
  sem tráfego (`:675-712`).
- Reconexão: `prior_discover` reusa o `DiscoverResult` e evita novo probe
  (`docs/protocol-versions.md:75-100`).
- Servidor HTTP stateful: `StreamableHTTPSessionManager` mantém um transport
  por `mcp-session-id`, com idle timeout de 30 min
  (`streamable_http_manager.py:38`), máximo de 10.000 sessões (`:41`), 404 para
  ID desconhecido (`:302-306`) e 503 no limite (`:298`).
- Ownership: a sessão só pode ser usada pela mesma credencial que a criou; se
  não, responde 404 (`manager.py:270-279`). Isso fecha sequestro de sessão.
- Persistência: o SDK **não persiste** conversa nem tokens. `TokenStorage` é
  uma interface do usuário (`client/auth/oauth2.py:130-148`).

## 7. Configuração e extensibilidade

- `Client(mode=...)`: `"auto"` (default), `"legacy"` ou uma versão modern
  (`client.py:336-345`). No TS o default é `legacy`; aqui é `auto`.
- `prior_discover=` evita o probe em reconexões (`docs/protocol-versions.md:75-100`).
- `read_timeout_seconds` por cliente/sessão (`client.py:304`, `session.py:408`).
- Extensões de servidor/cliente: `src/mcp/server/extension.py:1`,
  `client/extension.py:1`, com exemplos de `apps`, `skills`, `tasks`.
- Auth providers plugáveis: `OAuthAuthorizationServerProvider` e
  `TokenVerifier` (`server/auth/provider.py:124-350`).
- Lifespan e dependencies: `MCPServer` aceita `lifespan=` e resolve
  dependências por tipo (`server/mcpserver/resolve.py:1-703`).
- Não há arquivo de config; tudo é código.

## 8. Permissões, sandbox e erros

- **Auth de cliente**: OAuth 2.1 com PKCE, `state`, RFC 8707 `resource`,
  descoberta RFC 9728/8414, validação de `iss` (RFC 9207), refresh e step-up
  (`client/auth/oauth2.py:379-791`). Credenciais são presas ao issuer; um token
  de outro AS é descartado (`:681-696`).
- **Auth de servidor**: `BearerAuthBackend` valida token e audience
  (`middleware/bearer_auth.py:44-89`); `RequireAuthMiddleware` devolve 401 com
  `WWW-Authenticate` e 403 `insufficient_scope` (`:91-155`).
- **Transporte**: DNS rebinding protection com allow-list de `Host` e `Origin`
  (`server/transport_security.py:20-121`), corpo máximo de 4 MiB (`:15`,
  `RequestBodyLimitMiddleware` em `:126-180`).
- **Path security**: `src/mcp/shared/path_security.py:1-138` (validação de
  caminho para resources).
- **Erros**: `MCPError` carrega `code`/`message`/`data` (`shared/exceptions.py:15-48`);
  `handler_exception_to_error_data` faz a fronteira (`jsonrpc_dispatcher.py:92-108`);
  `INVALID_REQUEST`/`METHOD_NOT_FOUND` etc. vêm de `mcp_types`.
- **Sandbox**: não encontrado. O SDK não isola processo, rede ou filesystem.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Cliente | `tests/client/` (31 arquivos) | auth, cache, sessão, stdio, HTTP, sampling, extensões |
| Servidor | `tests/server/` | runner, auth, streamable HTTP, lowlevel, MCPServer |
| Transportes | `tests/transports/` | memória, framing, erros |
| Protocolo/tipos | `tests/types/`, `tests/shared/` | schemas, headers, cancelamento |
| Docs executáveis | `tests/docs_src/` (47 arquivos) | snippets das páginas de documentação |
| Interação | `tests/interaction/` | fluxos multi-etapa |
| Issues de regressão | `tests/issues/` | bugs históricos |

Números: 238 arquivos `test_*.py`, ~91.409 linhas. Não foi encontrado um
pacote de **conformidade oficial** como o do TS SDK (`test/conformance`); a
cobertura é por testes de protocolo e docs executáveis. O `docs_src` é uma
boa ideia para nós: boa parte dos exemplos da doc é testada.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| OAuth 2.1 de cliente (PKCE, PRM/ASM, RFC 8707/9207, refresh, step-up) | `src/mcp/client/auth/oauth2.py:292-791` | cobre descoberta, issuer binding e scope union | MIT | `src/core/mcp/auth.ts` | 24 |
| Lifecycle stdio com kill de árvore e timeout | `src/mcp/client/stdio.py:116-302` | fecha pipes e mata descendentes no Windows | MIT | `src/core/mcp/transport/stdio.ts` | 23 |
| Negociação `auto` com fallback e `prior_discover` | `src/mcp/client/_probe.py:61-130`, `src/mcp/client/client.py:336-345` | default seguro e zero round-trip na reconexão | MIT | `src/core/mcp/negotiation.ts` | 20 |
| Cancelamento/progresso por request no dispatcher | `src/mcp/shared/jsonrpc_dispatcher.py:85-230` | cancelamento real e exceções contidas | MIT | `src/core/mcp/dispatcher.ts` | 18 |
| Política de sessão HTTP (idle, limite, owner, 404/503) | `src/mcp/server/streamable_http_manager.py:38-398` | evita vazamento e sequestro de sessão | MIT | `src/core/mcp/server/sessions.ts` | 16 |
| Cache de respostas com TTL/escopo/geração | `src/mcp/client/caching.py:40-220` | mesma semântica do spec 2026 | MIT | `src/core/mcp/cache.ts` | 15 |
| Client credentials e identity assertion | `src/mcp/client/auth/extensions/client_credentials.py:1-342`, `src/mcp/client/auth/extensions/identity_assertion.py:1-190` | auth máquina-a-máquina e SEP-990 | MIT | `src/core/mcp/auth-machine.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Runtime Python/anyio/Pydantic | nosso harness é TypeScript/Electron |
| `MCPServer` com decorators e resolução por type hints | já temos um sistema de tools próprio |
| Renomeação `FastMCP` → `MCPServer` | é migração interna do SDK, não conceito |
| `stdio_server` com diversão de fd | truque para biblioteca Python; em Node não se aplica |
| Servidor SSE legado | o próprio spec o marca como deprecated |
| Testes `docs_src` como estão | excelente ideia, mas reescrever para a nossa doc |
| `mcp install` (Claude Desktop) | integração específica de outro produto |

## 12. Modelo de exemplo para o nosso harness

1. **Negociação com default `auto` + fallback**: tentar `server/discover`;
   qualquer erro JSON-RPC que não seja `-32022` com lista modern-only cai para
   `initialize`; erro de rede **não** cai (é outage). Base:
   `_probe.py:61-100`.
2. **Cache do veredito**: guardar `DiscoverResult` (versão, capabilities,
   serverInfo) no registro do servidor e reusar na reconexão, como
   `prior_discover` (`docs/protocol-versions.md:75-100`). Isso evita um probe
   por reconexão.
3. **OAuth de verdade**: implementar PRM (`/.well-known/oauth-protected-resource`),
   ASM (RFC 8414 + OIDC), PKCE S256, `resource` em authorize e token,
   validação de `iss`, refresh com preservação de `refresh_token` e step-up
   por `403 insufficient_scope`. Base: `oauth2.py:379-791`.
4. **Sessão HTTP com dono**: se um dia expusermos um servidor MCP, atar
   `mcp-session-id` ao token/usuário, com idle timeout e limite; responder 404,
   não 403, para não revelar existência (`manager.py:270-306`).
5. **Dispatcher cancelável**: `AbortSignal` por request, `notifications/cancelled`
   no abort, `progress` opcional resetando timeout, e uma barreira para não
   deixar handler órfão. Base: `jsonrpc_dispatcher.py:124-230`.
6. **Teste**: rodar o mesmo cenário contra `mode=legacy` e `mode=auto`, com um
   servidor fake que responde `-32601` ao discover e outro que responde
   `DiscoverResult`; conferir `protocol_version`, `server_info` e número de
   round-trips.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/mcp/modelcontextprotocol--python-sdk rev-parse HEAD
a525a3d9bece967d91534b746a6c842931b7b4ec
$ sed -n '1,8p' docs/whats-new.md
# What's new in v2
Two things happened at once in v2. The SDK was rebuilt... and the protocol moved:
v2 speaks the 2026-07-28 revision...
$ grep -n "mode: ConnectMode\|mode=\"auto\"\|prior_discover" src/mcp/client/client.py
336:    mode: ConnectMode = "auto"
345:    prior_discover: types.DiscoverResult | None = None
$ grep -n "DEFAULT_SESSION_IDLE_TIMEOUT\|DEFAULT_MAX_SESSIONS\|_session_owners" \
    src/mcp/server/streamable_http_manager.py
38:DEFAULT_SESSION_IDLE_TIMEOUT: Final = 30 * 60
41:DEFAULT_MAX_SESSIONS: Final = 10_000
121:    self._session_owners: dict[str, AuthorizationContext] = {}
272:    if requestor != self._session_owners.get(request_mcp_session_id):
$ grep -n "def initialize\|def discover\|def list_tools\|def call_tool" src/mcp/client/session.py
651:    async def initialize(self) -> types.InitializeResult:
757:    async def discover(self) -> types.DiscoverResult:
1278:    async def list_tools(...)
993:    async def call_tool(...)
$ grep -n "PKCEParameters.generate\|code_challenge\|resource.*RFC 8707\|State parameter mismatch" \
    src/mcp/client/auth/oauth2.py
403:        # Generate PKCE parameters
404:        pkce_params = PKCEParameters.generate()
433:        if result.state is None or not secrets.compare_digest(result.state, state):
471:                token_data["resource"] = self.context.get_resource_url()  # RFC 8707
$ find tests -name 'test_*.py' | wc -l
238
$ find src/mcp -name '*.py' | xargs wc -l | tail -1
28729 total
```
