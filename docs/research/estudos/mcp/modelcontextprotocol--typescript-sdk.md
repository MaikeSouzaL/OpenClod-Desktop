# MCP TypeScript SDK (v2)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/modelcontextprotocol/typescript-sdk |
| Clone local | `repositorios/_research/mcp/modelcontextprotocol--typescript-sdk` |
| Commit | `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5` |
| Licença | Apache-2.0 em transição (`LICENSE:1`; `package.json:6`) |
| Categoria | mcp (SDK cliente/servidor) |
| Stack | TypeScript, Node.js >= 20, pnpm 10.26, workspaces, tsdown, Vitest (`package.json:15-18`) |
| Tamanho | 1.231 arquivos; ~134.859 linhas `.ts` em `packages/` (sem testes de outros diretórios) |

## 1. O que é (verificado no código)

É o SDK oficial de MCP para TypeScript na linha **v2**, que implementa a revisão
`2026-07-28` do protocolo (`README.md:5`). O monorepo publica dois pacotes
principais — `@modelcontextprotocol/server` e `@modelcontextprotocol/client`
(`README.md:44-47`) —, mais adaptadores finos para Express, Fastify, Hono e
HTTP do Node (`README.md:51-55`). O núcleo de tipos e codecs fica em
`packages/core-internal`, separado do pacote público `packages/core`
(`packages/core/src/index.ts:1-20`).

O ponto que mais importa para o Openclod: o SDK tem **duas eras de protocolo**
convivendo no mesmo código. A era *legacy* negocia por `initialize`; a era
*modern* (2026-07-28+) não tem handshake e negocia por `server/discover`
(`packages/core-internal/src/shared/protocolEras.ts:1-42`). O `Client` começa
em `legacy` por padrão e só entra em `auto`/`pin` se configurado
(`packages/client/src/client/client.ts:202-219`).

Divergência README × código: o README chama a linha de "stable release line"
(`README.md:5`), mas o `package.json` **raiz** (privado) declara
`2.0.0-alpha.0` (`package.json:4`), enquanto os pacotes publicados
`client`/`server` estão em `2.4.0` (`packages/client/package.json:3`). Ou seja:
a versão do root não é sinal de maturidade; olhe a versão dos pacotes.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pnpm build:all` | `package.json:38` | build de todos os pacotes do workspace |
| `pnpm test:all` | `package.json:44` | testes de todos os pacotes |
| `pnpm lint:all` | `package.json:41` | sincroniza snippets, valida skills e roda lint |
| `pnpm docs:build` | `package.json:34` | Typedoc + VitePress |
| `pnpm test:conformance:server` | `package.json:49` | conformidade do servidor contra o pacote oficial |
| `pnpm test:conformance:client:all` | `package.json:47` | conformidade do cliente, suíte completa |
| `mcp-codemod` | `packages/codemod/package.json:24` | CLI de migração v1 → v2 |
| `pnpm --filter @modelcontextprotocol/test-conformance run test:conformance:server:run` | `test/conformance/package.json:40` | sobe o servidor de conformidade |

A superfície de UX é de biblioteca, não de CLI: exports por subpath
(`packages/client/src/index.ts:1-10`), transports (`client/stdio`,
`client/streamableHttp`, `client/sse`) e middlewares. O único executável
relevante é o codemod, com transforms de imports, handlers e schemas
(`packages/codemod/src/migrations/v1-to-v2/transforms/index.ts:1-47`).

## 3. Arquitetura e fluxo

```
Client.connect(transport)
  → resolveVersionNegotiation (legacy | auto | pin)
  → probe server/discover (auto/pin)  ou  initialize (legacy)
  → Protocol.request(method, params, schema)
  → Transport.send(JSON-RPC)
  → StreamableHTTP/SSE/stdio
  → response | SSE event | erro tipado
```

- Entry point do cliente: `packages/client/src/client/client.ts:546`.
- Negociação: `Client.connect` em `client.ts:1004-1017`; handshake legado em
  `client.ts:1057-1121`; caminho moderno em `client.ts:1130-1205`.
- Contrato de transporte: `start/send/close`, `onmessage`, `sessionId`,
  `setProtocolVersion` em `packages/core-internal/src/shared/transport.ts:139-216`.
- Execução de método: `Protocol.request` com timeout padrão de 60 s
  (`packages/core-internal/src/shared/protocol.ts:101-136`).
- Streaming: `StreamableHTTPClientTransport._handleSseStream`
  (`packages/client/src/client/streamableHttp.ts:763-900`).
- Persistência: o protocolo é stateless; o cliente mantém cache de respostas
  (`packages/client/src/client/responseCache.ts:268`) e o provider OAuth
  persiste tokens fora do SDK (`packages/client/src/client/auth.ts:248-330`).

O servidor tem dois entrypoints: `McpServer` alto nível
(`packages/server/src/server/mcp.ts:112`) e `Server` baixo nível
(`packages/server/src/server/server.ts:1`), além de `serveStdio`
(`packages/server/src/server/serveStdio.ts:375`) e
`WebStandardStreamableHTTPServerTransport`
(`packages/server/src/server/streamableHttp.ts:259`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `StdioClientTransport` | `packages/client/src/client/stdio.ts:107` | spawn de processo, pipes NDJSON, stderr opcional | médio |
| `StreamableHTTPClientTransport` | `packages/client/src/client/streamableHttp.ts:343` | POST por request, SSE por resposta, sessão, OAuth | alto |
| `SSEClientTransport` | `packages/client/src/client/sse.ts:155` | transporte HTTP+SSE legado (2024-11-05) | alto |
| `StdioServerTransport` | `packages/server/src/server/stdio.ts:35` | serve por stdin/stdout, fecha no EOF | baixo |
| `serveStdio` | `packages/server/src/server/serveStdio.ts:375` | factory por era, detecta modern/legacy na 1ª mensagem | médio |
| `WebStandardStreamableHTTPServerTransport` | `packages/server/src/server/streamableHttp.ts:259` | sessão, resume por `Last-Event-ID`, keep-alive | alto |
| `McpServer.registerTool` | `packages/server/src/server/mcp.ts:1058` | registra tool com Standard Schema/Zod | baixo |
| `McpServer.registerResource` | `packages/server/src/server/mcp.ts:690` | recursos e templates | médio |
| `McpServer.registerPrompt` | `packages/server/src/server/mcp.ts:1148` | prompts com argumentos/completion | baixo |
| `Client.listTools` | `packages/client/src/client/client.ts:2556` | agrega todas as páginas automaticamente | baixo |
| `Client.callTool` | `packages/client/src/client/client.ts:2372` | valida output schema, espelha headers `Mcp-Param-*` | alto |
| `auth()` | `packages/client/src/client/auth.ts:1076` | OAuth 2.1: PRM, ASM, PKCE, DCR, refresh, issuer | alto |
| `ClientResponseCache` | `packages/client/src/client/responseCache.ts:268` | cache com `ttlMs`/`cacheScope` e geração | médio |

## 5. Loop do agente, contexto e streaming

Este repositório **não tem loop de agente**. O que existe é um ciclo de
request/response JSON-RPC; quem decide chamar ferramenta é o host. O cliente
expõe `callTool`, `readResource`, `getPrompt`, `complete`, `listen` e `ping`
(`client.ts:1567-1991`), e o servidor despacha por handlers registrados
(`mcp.ts:252-257`, `mcp.ts:526-530`, `mcp.ts:627-632`).

Chamada de ferramenta: `callTool` resolve o cabeçalho `x-mcp-header` do tool,
valida o resultado contra `outputSchema` e, em caso de `HEADER_MISMATCH`,
refaz o `tools/list` uma vez antes de repetir a chamada
(`client.ts:2372-2476`). O resultado é validado por schema JSON (AJV no Node)
(`client.ts:1865-1900`).

Streaming: cada POST pode voltar `text/event-stream`; o parser emite eventos,
guarda o último `event.id` e chama `onresumptiontoken`
(`streamableHttp.ts:763-840`). Reconexão usa backoff exponencial com
`initialReconnectionDelay: 1000`, `maxReconnectionDelay: 30_000`,
`reconnectionDelayGrowFactor: 1.5`, `maxRetries: 2`
(`streamableHttp.ts:49-55`, `streamableHttp.ts:696-760`). Streams de GET
legados e respostas POST com evento de priming são reconectáveis; um stream
que já recebeu a resposta não reconecta (`streamableHttp.ts:842-847`).

Cancelamento: o `Protocol` escuta `notifications/cancelled` e aborta o
handler correspondente (`packages/core-internal/src/shared/protocol.ts:621`,
`:742-743`); no cliente, `request(..., { signal })` aborta a espera
(`protocol.ts:1058-1085`). Em transportes com `hasPerRequestStream` (HTTP
moderno), o cliente fecha o stream em vez de POSTar `notifications/cancelled`
(`transport.ts:168-180`).

Paginação: `listTools/listPrompts/listResources` chamam `_listAllPages`
(`client.ts:1734-1768`), que caminha com `_walkPages` até `nextCursor` sumir,
com teto `listMaxPages` (default 64, `client.ts:677`) e parada quando a página
repete itens e cursor (`client.ts:1781-1796`). Um cursor inválido vira
`ProtocolError`/`-32602` (`test/e2e/scenarios/pagination.test.ts:39-40`).

## 6. Sessões, estado e persistência

- Era legacy: `Mcp-Session-Id` é lido da resposta e reenviado em toda request
  (`streamableHttp.ts:1017-1027`); `DELETE` encerra a sessão
  (`streamableHttp.ts:1249-1275`).
- Retomada: `Last-Event-ID` é enviado em GET/POST de reconexão
  (`streamableHttp.ts:592-595`, `streamableHttp.ts:1301-1305`).
- Era modern: não há sessão nem `initialize`; cada request carrega `_meta`
  (`packages/core/src/constants.ts:20-52`, `protocolEras.ts:1-12`).
- Cache: `ClientResponseCache` guarda por método+params, com TTL e escopo
  (`responseCache.ts:268-300`); `resetForReconnect` limpa ao reconectar
  (`responseCache.ts:593`), e `captureGeneration` evita gravar página velha
  depois de um `list_changed` (`responseCache.ts:479`, `client.ts:1745-1767`).
- Estado do servidor: a era modern é stateless; a era legacy guarda sessões no
  transporte (`streamableHttp.ts:90-160`, `streamableHttp.ts:424-430`).

O SDK **não** persiste conversa nem histórico. O provider OAuth é responsável
por salvar tokens e client registration (`auth.ts:248-330`).

## 7. Configuração e extensibilidade

- `ClientOptions` inclui `capabilities`, `jsonSchemaValidator`,
  `versionNegotiation`, `listMaxPages` e cache
  (`client.ts:186-300`).
- Versionamento é opt-in: default `legacy`; `auto` faz probe; `{ pin }` exige
  uma revisão modern (`client.ts:202-219`, `versionNegotiation.ts:90-112`).
- Middlewares são adaptadores sem lógica MCP (`README.md:51-55`), com validação
  de `Host` e `Origin` (`packages/middleware/node/src/middleware/hostHeaderValidation.ts:1`,
  `originValidation.ts:1`).
- Extensão de skills (`io.modelcontextprotocol/skills`, SEP-2640) tem cliente e
  servidor próprios (`packages/client/src/ext/skills/skillsClient.ts:1`,
  `packages/server/src/ext/skills/extension.ts:1`).
- Métodos customizados são suportados por `setRequestHandler`
  (`packages/server/src/server/server.ts:284`), com exemplos em
  `examples/custom-methods/`.
- Não há arquivo de configuração do SDK: tudo é passado por construtor/opções.

## 8. Permissões, sandbox e erros

O SDK **não implementa sandbox nem aprovação humana**. Ele fornece o canal e
deixa a política para o host; a documentação de tools diz que o cliente deve
mostrar a chamada ao usuário e validar entradas/saídas
(`docs` do spec, ver repositório 4). No código, o que existe é:

| Mecanismo | Onde | Efeito |
|---|---|---|
| Validação de `Origin`/`Host` | `packages/server/src/server/middleware/originValidation.ts:1`, `hostHeaderValidation.ts:1` | bloqueia DNS rebinding no servidor HTTP |
| Validação de tool name | `packages/core-internal/src/shared/toolNameValidation.ts:1-100` | rejeita nomes fora do padrão |
| Schema de entrada/saída | `mcp.ts:1058-1140`, `client.ts:1865-1900` | erro de contrato antes/depois da chamada |
| Erros tipados | `packages/core-internal/src/errors/sdkErrors.ts:11-90` | `SdkErrorCode` com timeout, auth, era, paginação |
| Códigos JSON-RPC | `packages/core/src/constants.ts:80-103` | `-32700`, `-32600`, `-32601`, `-32602`, `-32603` |
| OAuth/401/403 | `streamableHttp.ts:610-660`, `auth.ts:1076-1460` | refresh, step-up, DPoP, issuer binding |

O servidor responde `404` para sessão desconhecida
(`server/streamableHttp.ts:424`, `:684`), `400` para falta de `Mcp-Session-Id`
(`:1085`), `406` quando o cliente não aceita `text/event-stream` (`:511`) e
`405` para GET/DELETE na era modern (`:771`). A validação de
`MCP-Protocol-Version` fica em `:1098-1130`.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Unitários de pacote | `packages/*/test/**` | client, auth, transports, server, cache |
| E2E de cenários | `test/e2e/scenarios/*.test.ts` | lifecycle, erros, paginação, auth, hosting, MRTR, streaming |
| Conformidade | `test/conformance` | cliente e servidor contra `@modelcontextprotocol/conformance` |
| Codemod | `packages/codemod/test` | transforms v1 → v2 |
| Exemplos | `examples/**` | 36 diretórios e 144 arquivos `.ts`, incluindo CLI host |

O teste de conformidade é preso a uma versão exata do pacote
(`test/conformance/package.json:44`), com baseline de falhas esperadas
(`test/conformance/expected-failures.yaml:1-20`). O README explica que uma nova
release só entra com bump deliberado e reconciliação do baseline
(`test/conformance/README.md:5-8`). Há testes de transporte que sobem servidor
real e usam `wire-sniffer` (`test/e2e/helpers/wire-sniffer.ts:1`).

Qualidade: `pnpm check:all` encadeia snippets, skills, typecheck, lint e docs
(`package.json:43`); há `lefthook` e `changesets`.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Cliente Streamable HTTP com SSE incremental, reconexão e `Last-Event-ID` | `packages/client/src/client/streamableHttp.ts:343-900` | cobre 202/JSON/SSE, priming, backoff e sessão | Apache-2.0 | `src/core/mcp/transport/http.ts` | 25 |
| Negociação de era (`legacy`/`auto`/`pin`) e `server/discover` | `packages/client/src/client/versionNegotiation.ts:90-200`, `packages/client/src/client/client.ts:1004-1205` | resolve 2025 × 2026 sem quebrar clientes antigos | Apache-2.0 | `src/core/mcp/negotiation.ts` | 22 |
| Paginação com teto, guarda de repetição e invalidação por geração | `packages/client/src/client/client.ts:1734-1798` | evita loop infinito e cache envenenado | Apache-2.0 | `src/core/mcp/pagination.ts` | 21 |
| Lifecycle stdio: env allowlist, stderr, SIGTERM→SIGKILL | `packages/client/src/client/stdio.ts:54-99, 128-180, 280-320` | fecha processos e não vaza ambiente | Apache-2.0 | `src/core/mcp/transport/stdio.ts` | 21 |
| Cache de respostas com `ttlMs`/`cacheScope` e geração | `packages/client/src/client/responseCache.ts:268-600` | reduz `tools/list` repetido e respeita `list_changed` | Apache-2.0 | `src/core/mcp/cache.ts` | 18 |
| Harness de conformidade (everything client/server + baseline) | `test/conformance/src/everythingServer.ts:1`, `test/conformance/README.md:1-80` | prova interoperabilidade com cenários oficiais | Apache-2.0 | `test/mcp/conformance/` | 20 |
| OAuth 2.1 completo (PRM/ASM/PKCE/DPoP/issuer) | `packages/client/src/client/auth.ts:1076-1460` | cobre step-up e troca de AS com segurança | Apache-2.0 | `src/core/mcp/auth.ts` | 23 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Implementar a era 2026-07-28 agora | é uma quebra grande (sem `initialize`, sem sessão, sem GET/SSE resumível); nosso cliente ainda fala 2024-11-05 |
| Todo o `packages/core-internal/src/types/spec.types.*` | ~5.000 linhas de tipos gerados; usar só o subconjunto necessário |
| Monorepo pnpm + tsdown + changesets | custo de build sem ganho para um app Electron único |
| Codemod v1 → v2 | só serve para quem migra o SDK, não para nós |
| Extensão de skills (SEP-2640) | não é MCP core; nosso sistema de skills é próprio |
| `serveStdio` com factory por era | complexidade prematura; nosso servidor MCP (se existir) pode ser legacy |
| Testes de conformidade como dependência de runtime | pesado; usar em CI, não no app |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem código inventado:

1. **Uma interface `McpTransport`** com `start`, `send`, `close`, `onmessage`,
   `onclose`, `onerror`, `sessionId?`, `setProtocolVersion?` — o mesmo contrato
   de `packages/core-internal/src/shared/transport.ts:139-216`. Isso permite stdio, HTTP e in-memory sem mudar o
   `McpClient`.
2. **`McpEra` explícita** (`legacy` | `modern`) no estado da conexão, com
   versão negociada e capacidades. O default deve ser `legacy` até termos um
   servidor 2026 para testar; `auto` fica atrás de flag.
3. **HTTP transport** com três caminhos: resposta JSON, resposta SSE e
   `202 Accepted`; parser SSE incremental; `Last-Event-ID`; backoff com teto;
   `DELETE` no `stop`; `MCP-Protocol-Version` sempre que a versão for conhecida.
4. **Paginação** única para tools/resources/prompts, com `maxPages` (64),
   detecção de página repetida e `cacheGeneration` para descartar resultado
   velho após `list_changed`.
5. **Teste de contrato** com um servidor fake que responde página 3/1/2 e um
   cursor inválido, no molde de `pagination.test.ts:50-100`; e um teste de
   reconexão que derruba o SSE no meio e exige `Last-Event-ID`.
6. **Observabilidade**: logar `era`, `protocolVersion`, `sessionId`, tentativa
   de reconexão e motivo de fallback. Sem isso, um 404 de sessão vira “servidor
   fora do ar”.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/mcp/modelcontextprotocol--typescript-sdk rev-parse HEAD
951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5
$ grep -n "LATEST_PROTOCOL_VERSION\|SUPPORTED_PROTOCOL_VERSIONS" packages/core/src/constants.ts
1:export const LATEST_PROTOCOL_VERSION = '2025-11-25';
3:export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', ...];
$ grep -n "FIRST_MODERN_PROTOCOL_VERSION\|SUPPORTED_MODERN_PROTOCOL_VERSIONS" \
    packages/core-internal/src/shared/protocolEras.ts
26:export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';
32:export const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];
$ grep -n "async connect" packages/client/src/client/client.ts
1004:    override async connect(transport: Transport, options?: ConnectOptions): Promise<void> {
$ grep -n "_listAllPages\|_walkPages\|listMaxPages" packages/client/src/client/client.ts
1734:    private async _listAllPages...
1772:    private async _walkPages...
1782:            if (this._listMaxPages !== 0 && pages >= this._listMaxPages) {
$ grep -n "initialReconnectionDelay\|maxRetries" packages/client/src/client/streamableHttp.ts
50:const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
51:    initialReconnectionDelay: 1000,
54:    maxRetries: 2

$ grep -n "createJsonErrorResponse(404\|createJsonErrorResponse(405\|createJsonErrorResponse(406" \
    packages/server/src/server/streamableHttp.ts
424:            return this.createJsonErrorResponse(404, -32_001, 'Session not found');
511:            return this.createJsonErrorResponse(406, -32_000, 'Not Acceptable...');
771:                status: 405,
$ grep -rn "nextCursor" packages/server/src | wc -l
16 (todas em src/ext/skills; o núcleo de tools/resources/prompts não pagina no servidor)
$ find packages -name '*.ts' | xargs wc -l | tail -1
134859 total
```
