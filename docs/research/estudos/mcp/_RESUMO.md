# Estudos MCP — resumo e prioridades

> Cinco clones analisados estaticamente em `repositorios/_research/mcp/`.
> Método: leitura de código/schema, sem instalar dependências e sem rodar os
> testes dos clones. Cada estudo individual tem 13 seções e cita caminho+linha.
> Data da análise: 2026-10-26.

## Veredito por repositório

| Repositório | O que é | Valor para o Openclod | Risco |
|---|---|---|---|
| `modelcontextprotocol--typescript-sdk` | SDK v2 TS, eras legacy/modern | melhor fonte para transporte HTTP/SSE, negociação e paginação | protocolo 2026 em ruptura |
| `modelcontextprotocol--servers` | 7 servidores de referência | melhor fonte para segurança de filesystem/fetch/git e estado de memory | são produtos, não bibliotecas |
| `modelcontextprotocol--python-sdk` | SDK v2 Python | melhor fonte para OAuth 2.1, stdio e política de sessão | stack Python incompatível |
| `modelcontextprotocol--modelcontextprotocol` | especificação + schema + SEPs | autoridade para tipos, erros, cache e compatibilidade | 2026-07-28 é breaking |
| `BrethofAI--awesome-mcp-servers` | catálogo curado (103 entradas) | taxonomia de tags e pipeline de verificação | é lista, não runtime; 62/103 hosted |

## 10 candidatos priorizados

Score 0–25 = encaixe no nosso harness (0–10) + qualidade/testes (0–5) +
robustez de segurança/bordas (0–5) + portabilidade/licença (0–5).

| # | Candidato | Origem (arquivo:linha) | Score | Tipo | Destino proposto |
|---|---|---|---:|---|---|
| 1 | Cliente Streamable HTTP com SSE incremental, `202`, sessão, `Last-Event-ID`, backoff e `DELETE` | `modelcontextprotocol--typescript-sdk/packages/client/src/client/streamableHttp.ts:343-900` | 25 | porta | `src/core/mcp/transport/http.ts` |
| 2 | OAuth 2.1 de cliente: PRM/ASM, PKCE S256, RFC 8707, RFC 9207, refresh e step-up | `modelcontextprotocol--python-sdk/src/mcp/client/auth/oauth2.py:292-791` | 24 | porta | `src/core/mcp/auth.ts` |
| 3 | Guard de caminho com `realpath`, allow-list, abertura ancorada e `O_NOFOLLOW` (anti-TOCTOU) | `modelcontextprotocol--servers/src/filesystem/path-validation.ts:12-93` e `modelcontextprotocol--servers/src/filesystem/pinned-directory.ts:173-250` | 23 | porta | `src/core/security/path-guard.ts` |
| 4 | Lifecycle stdio: env allowlist, stderr separado, SIGTERM→SIGKILL e kill de árvore | `modelcontextprotocol--python-sdk/src/mcp/client/stdio.py:116-302` | 23 | porta | `src/core/mcp/transport/stdio.ts` |
| 5 | Negociação de era (`legacy`/`auto`/`pin`), `server/discover`, fallback e `prior_discover` | `modelcontextprotocol--typescript-sdk/packages/client/src/client/versionNegotiation.ts:90-200` + `modelcontextprotocol--python-sdk/src/mcp/client/_probe.py:61-130` | 22 | reimplementação | `src/core/mcp/negotiation.ts` |
| 6 | Fetch guard: bloqueio de IP privado em cada redirect, robots.txt, proxy e truncamento | `modelcontextprotocol--servers/src/fetch/src/mcp_server_fetch/server.py:139-166, 260-336, 458-514` | 22 | porta | `src/core/browser/fetch-guard.ts` |
| 7 | Registro de versões e schema por revisão (`2024-11-05` … `2026-07-28`) | `modelcontextprotocol--modelcontextprotocol/schema/2026-07-28/schema.ts:30` e `docs/specification/2026-07-28/basic/versioning.mdx:41-78` | 21 | dependência | `src/core/mcp/protocol/schema/` |
| 8 | Paginação com teto `listMaxPages`, guarda de página repetida e geração de cache | `modelcontextprotocol--typescript-sdk/packages/client/src/client/client.ts:1734-1798` | 21 | porta | `src/core/mcp/pagination.ts` |
| 9 | Harness de conformidade (everything client/server + baseline de falhas) | `modelcontextprotocol--typescript-sdk/test/conformance/src/everythingServer.ts:1` e `modelcontextprotocol--typescript-sdk/test/conformance/README.md:1-80` | 20 | dependência | `test/mcp/conformance/` |
| 10 | Superfície git fechada: 12 tools, repo confinado e rejeição de refs com `-` | `modelcontextprotocol--servers/src/git/src/mcp_server_git/server.py:60-73, 351-368` | 20 | porta | `src/core/git/tools.ts` |

### Não priorizados (mas estudados)

| Item | Score | Por que ficou fora do top 10 |
|---|---:|---|
| Store de grafo com lock e rename atômico (`servers/src/memory/index.ts:232-515`) | 19 | já temos memória própria; portar só o padrão de lock |
| Taxonomia de tags do catálogo (`awesome/README.md:39-55`) | 18 | barato de adotar, mas não é código de runtime |
| Cache de respostas com `ttlMs`/`cacheScope` (`typescript-sdk/responseCache.ts:268`) | 18 | depende do transporte HTTP novo |
| Política de sessão HTTP com idle/limite/owner (`python-sdk/streamable_http_manager.py:38-398`) | 16 | só relevante se expusermos servidor MCP |
| MRTR/`requestState` assinado (`servers/src/everything/server/index.ts:72-86`) | 14 | 2026-only; nosso cliente é 2024-11-05 |

## Lacunas do nosso cliente MCP

O cliente atual (`src/core/mcp/client.ts`) é funcional para stdio e HTTP
básico, mas está preso ao protocolo antigo e perde recursos que os SDKs já
resolvem:

1. **Versão fixa em `2024-11-05`** (`client.ts:281-283` e `:313-315`), sem
   `MCP-Protocol-Version` no header (`remoteHeaders` em `:348-356`). Qualquer
   servidor 2025-06-18+ pode recusar ou negociar para baixo.
2. **SSE sem streaming real**: o corpo é lido inteiro com `response.text()`
   (`:400-411`) e parseado depois (`parseRpcResponse` em `:740`). Não há
   eventos incrementais, GET standalone, reconexão, `Last-Event-ID` nem
   `202 Accepted`.
3. **Requests servidor→cliente ignorados**: `onData` reconhece notificações de
   `list_changed`, mas “acknowledges implicitly” requests como `ping`,
   `roots/list`, `sampling/createMessage` e `elicitation/create`
   (`:630-637`). O servidor fica esperando resposta.
4. **Cancelamento remoto ausente**: o abort só envia `notifications/cancelled`
   no caminho stdio (`:648-652`); no HTTP, o `AbortController` fecha a request
   sem avisar o servidor (`:386-397`).
5. **Paginação inconsistente**: HTTP pagina até 20 páginas (`:322-331`), mas
   stdio lê só a primeira (`:292-299`); `resources/templates/list` não é
   consultado (`loadOptionalCollections` em `:460-500`).
6. **OAuth só reativo**: não há descoberta de PRM/ASM, PKCE ou registro; há um
   callback em 401 (`:367-372`). O catálogo só marca `oauth: true` e deixa o
   usuário resolver (`src/core/mcp/catalog.ts:32-33`).
7. **Sem kill escalonado**: `stop()` faz `stdin.end()` + `child.kill()`
   (`:712-718`), sem SIGTERM→SIGKILL nem árvore de processos.
8. **Sem conformidade**: não há suíte equivalente a
   `test/conformance`; os testes atuais cobrem parsing e fluxo feliz.

## Ordem de implementação sugerida

1. **Versão e header** (`negotiation.ts` mínimo): subir o default para
   `2025-06-18`/`2025-11-25`, enviar `MCP-Protocol-Version` e tratar `-32022`.
   Impacto alto, custo baixo.
2. **HTTP transport** (`transport/http.ts`): parser SSE incremental, `202`,
   `Last-Event-ID`, backoff 1s→30s, `DELETE`, cancelamento por request.
3. **Paridade stdio**: paginação, env allowlist, SIGTERM→SIGKILL, stderr.
4. **OAuth**: PRM → ASM → PKCE → token → refresh → step-up; persistir tokens
   por issuer.
5. **Segurança**: path guard, fetch guard e git toolset; são bibliotecas
   pequenas e independentes do MCP.
6. **Conformidade**: subir o `everything` server e rodar a matriz
   legacy/modern; só então considerar 2026-07-28.

## Licenças e reuso

Todos os cinco são permissivos: Apache-2.0/MIT (com transição MIT→Apache nos
três repositórios oficiais) e MIT no catálogo. Não há bloqueio de licença para
portar ideias ou trechos, desde que se preserve o aviso de copyright e se
registre a origem. O risco real é de **acoplamento de protocolo**, não legal.

## Arquivos produzidos

- `docs/research/estudos/mcp/modelcontextprotocol--typescript-sdk.md`
- `docs/research/estudos/mcp/modelcontextprotocol--servers.md`
- `docs/research/estudos/mcp/modelcontextprotocol--python-sdk.md`
- `docs/research/estudos/mcp/modelcontextprotocol--modelcontextprotocol.md`
- `docs/research/estudos/mcp/BrethofAI--awesome-mcp-servers.md`
- `docs/research/estudos/mcp/_RESUMO.md`
