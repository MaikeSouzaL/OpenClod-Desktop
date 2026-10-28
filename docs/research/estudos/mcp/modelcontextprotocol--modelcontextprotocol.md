# Model Context Protocol — especificação e schema

| Campo | Valor |
|---|---|
| Repositório | https://github.com/modelcontextprotocol/modelcontextprotocol |
| Clone local | `repositorios/_research/mcp/modelcontextprotocol--modelcontextprotocol` |
| Commit | `dae694f61a31f7a3ec2af3aff709e11f70f61e48` |
| Licença | transição MIT → Apache-2.0; docs em CC-BY-4.0 (`LICENSE:1-3`; `package.json:6`) |
| Categoria | mcp (especificação, schema, SEPs, registry) |
| Stack | MDX/Mintlify, TypeScript 6 para o schema, Typedoc, tsx, AJV; Node >= 24 (`package.json:10-12`) |
| Tamanho | 967 arquivos; ~36.920 linhas de `.mdx` em `docs/specification`, ~12.964 linhas de schema `.ts`, 264 JSON de exemplo, 43 SEPs numeradas |

## 1. O que é (verificado no código)

Não é um SDK nem um servidor. É o repositório canônico da **especificação MCP**:
o schema TypeScript de cada revisão, a documentação normativa em MDX, as
propostas (SEPs), a documentação do Registry oficial e os scripts que geram e
verificam tudo (`package.json:24-45`). A revisão mais recente é `2026-07-28`
(`schema/2026-07-28/schema.ts:30`), com as quatro revisões anteriores
preservadas (`schema/2024-11-05` a `schema/2025-11-25`).

O `2026-07-28` é uma quebra deliberada: remove o handshake `initialize`, o
conceito de sessão e o GET/SSE resumível, e move requests servidor→cliente
para MRTR (`docs/specification/2026-07-28/changelog.mdx:11-19`). Para o
Openclod, isso significa que **não** se deve adotar 2026 por inteiro agora;
o valor imediato está no schema das revisões 2025 e nas regras que já valem
para 2024-11-05/2025-03-26/2025-06-18/2025-11-25.

O repositório também documenta o Registry oficial, cuja API é
`https://registry.modelcontextprotocol.io` com `GET /v0.1/servers`
(`docs/registry/registry-aggregators.mdx:16-20`). Isso é insumo direto para o
nosso catálogo de MCPs.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run generate` | `package.json:24` | gera schema JSON/MDX e renderiza SEPs |
| `npm run check` | `package.json:32` | schema + docs + SEPs |
| `npm run check:schema` | `package.json:33` | TS, JSON, exemplos e MDX do schema |
| `npm run check:docs` | `package.json:38` | formato, comentários JS e links quebrados |
| `npm run check:seps` | `package.json:42` | valida o render das SEPs |
| `npm run serve:docs` | `package.json:43` | Mintlify local |
| `npm run prep` | `package.json:45` | sequência completa antes de publicar |

Não há CLI de runtime. A “superfície” é o schema (`schema/<versão>/schema.ts`),
os documentos normativos (`docs/specification/<versão>/`) e os exemplos JSON
(`schema/<versão>/examples/`). O site é gerado a partir disso; não é fonte
independente.

## 3. Arquitetura e fluxo

```
schema/<versão>/schema.ts
  → generate-schemas.ts → schema.json + schema.mdx
  → docs/specification/<versão>/schema.mdx
  → Mintlify (docs.json) → site
  → validate-examples.ts (AJV) valida schema/examples/*.json
  → render-seps.ts → seps/<numero>-*.md renderizado
```

- Fonte da verdade: `schema/<versão>/schema.ts`
  (`schema/2026-07-28/schema.ts:1-60`).
- Geração: `scripts/generate-schemas.ts:1-121` e a chamada Typedoc em
  `package.json:25-30`.
- Exemplos: `scripts/validate-examples.ts:1-98`.
- Documentos por revisão: `docs/specification/2024-11-05` …
  `docs/specification/2026-07-28` e `draft` (`docs/specification/draft/index.mdx:1`).
- SEPs: `seps/` (43 numeradas), com `TEMPLATE.md` e workflow em
  `docs/community/sep-guidelines.mdx:1`.
- Registry: `docs/registry/*.mdx`, API em `registry-aggregators.mdx:16-20`.

O `draft` é uma cópia da revisão corrente com changelog curto
(`docs/specification/draft/changelog.mdx:1-4`); é onde a próxima revisão é
preparada, não um protocolo separado.

## 4. Catálogo de ferramentas / capacidades

| Área | Documento | O que define | Risco |
|---|---|---|---|
| JSON-RPC e erros | `docs/specification/2026-07-28/basic/index.mdx:25-150` | requests, responses, `resultType`, códigos `-32020`…`-32022` | médio |
| `_meta` por request | `basic/index.mdx:320-416` | `protocolVersion`, `clientInfo`, `clientCapabilities`, `serverInfo` | médio |
| Statelessness | `basic/index.mdx:182-207` | servidor não pode depender de requests anteriores | alto |
| Versionamento | `basic/versioning.mdx:41-78` | `2026-07-28` negocia por erro `-32022`, não por handshake | alto |
| `server/discover` | `server/discover.mdx:7-106` | versões, capabilities e identidade em uma chamada | baixo |
| stdio | `basic/transports/stdio.mdx:11-121` | NDJSON, stdout limpo, shutdown, compatibilidade | médio |
| Streamable HTTP | `basic/transports/streamable-http.mdx:54-739` | POST por request, `202`, headers, sem resume em 2026 | alto |
| Tools | `server/tools.mdx:45-803` | `inputSchema`/`outputSchema`, annotations, `x-mcp-header`, erros | alto |
| Resources | `server/resources.mdx:39-344` | templates, subscriptions, annotations | médio |
| Prompts | `server/prompts.mdx:39-259` | list/get, argumentos, completion | baixo |
| Paginação | `server/utilities/pagination.mdx:24-111` | cursor opaco, `nextCursor`, página definida pelo servidor | baixo |
| Cache | `server/utilities/caching.mdx:11-179` | `ttlMs`, `cacheScope`, interação com paginação | médio |
| Subscriptions | `basic/patterns/subscriptions.mdx:7-123` | `subscriptions/listen`, ack, `subscriptionId` | médio |
| MRTR | `basic/patterns/mrtr.mdx:1-228` | `InputRequiredResult`, retry com `inputResponses` | alto |
| Autorização | `basic/authorization/index.mdx:62-405` | OAuth 2.1, PRM, RFC 8707, issuer, step-up | alto |
| Registry | `docs/registry/quickstart.mdx:1-138` | publicação e `server.json` | baixo |

## 5. Loop do agente, contexto e streaming

Não há loop de agente; há um **modelo de mensagens**. Em 2026-07-28, cada
request é independente e carrega versão/capabilities em `_meta`
(`basic/index.mdx:182-207`, `:367-392`). O servidor não pode inferir
capacidades de requests anteriores (`:387-392`).

O fluxo HTTP é: um POST por mensagem; request recebe `application/json` ou
`text/event-stream`; notificação recebe `202 Accepted`
(`basic/transports/streamable-http.mdx:72-84`). Cada request tem seu próprio
stream; não existe GET de stream nem resume por `Last-Event-ID` em 2026
(`:157`, `:650-687`). O stream de `subscriptions/listen` é um POST de longa
duração, com ack obrigatório (`basic/patterns/subscriptions.mdx:52-91`).

Em 2025, o fluxo é o clássico: `initialize` → `notifications/initialized` →
requests; SSE standalone por GET e resume por `Last-Event-ID`
(`docs/specification/2025-11-25/basic/transports.mdx:1-260`). O nosso cliente
hoje fala `2024-11-05` (`src/core/mcp/client.ts:281`), então está mais perto
desse modelo do que do 2026.

Streaming de resultado de tool: `CallToolResult` pode voltar em JSON ou SSE;
conteúdo estruturado é `structuredContent` + `outputSchema`
(`server/tools.mdx:496-630`). Erro de execução é `isError: true`; erro de
protocolo é JSON-RPC (`:738-785`).

## 6. Sessões, estado e persistência

- **2026-07-28**: não há sessão. O changelog é explícito: remove
  `Mcp-Session-Id` e o estado por conexão
  (`changelog.mdx:11`); servidores que precisam de estado usam handles
  explícitos em argumentos de tool (`:11`).
- **2025-11-25 e anteriores**: `Mcp-Session-Id` é retornado no initialize e
  reenviado em todas as requests; GET abre stream standalone; DELETE encerra
  (`docs/specification/2025-11-25/basic/transports.mdx:1-260`).
- **Resume**: em 2025, `Last-Event-ID` + event store; em 2026, removido
  (`changelog.mdx:19`).
- **Persistência**: o protocolo não define armazenamento de conversa. O estado
  é do host; o servidor só guarda o que o seu domínio exigir.
- **Paginação**: cursor é opaco e pode ser string vazia válida; cliente não
  pode inferir página (`pagination.mdx:92-111`).
- **Cache**: `ttlMs`/`cacheScope` são hints; ausência de `ttlMs` = 0
  (immediately stale); `private` não pode ser compartilhado entre contextos de
  autorização (`caching.mdx:43-110`).

## 7. Configuração e extensibilidade

- **Extensões**: `ClientCapabilities.extensions` e `ServerCapabilities.extensions`
  permitem recursos fora do core (`changelog.mdx:21`); a negociação está em
  `basic/versioning.mdx:80-125`.
- **SEPs**: 43 propostas numeradas em `seps/`, com processo descrito em
  `docs/community/sep-guidelines.mdx:1`; o changelog referencia os PRs
  (ex.: SEP-2575, SEP-2322, SEP-2549) (`changelog.mdx:11-33`).
- **Registry**: `server.json` declara nome, versão, pacotes e remotos; a versão
  é imutável por publicação (`docs/registry/versioning.mdx:10-64`).
- **Deprecação**: Roots, Sampling e Logging estão deprecados em 2026
  (`changelog.mdx:78-90`); HTTP+SSE também (`:92-95`).
- Não há plugins de runtime; a extensibilidade é do protocolo, não do site.

## 8. Permissões, sandbox e erros

- **Autorização**: OAuth 2.1, Protected Resource Metadata (RFC 9728),
  Authorization Server Metadata (RFC 8414/OIDC), Dynamic Client Registration
  (RFC 7591, agora deprecado em favor de CIMD), Resource Indicators (RFC 8707)
  e `iss` (RFC 9207) (`basic/authorization/index.mdx:26-80`).
- **Escopo**: o `scope` do `WWW-Authenticate` é autoritativo para a operação;
  o cliente deve fazer união com escopos já concedidos e limitar retries
  (`:97-134`, `:379-402`).
- **Token**: Bearer em todo request; proibido na query string; servidor deve
  validar audience (`:254-297`).
- **Erros**: `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability,
  `-32022` UnsupportedProtocolVersion; `-32000..-32019` é
  implementation-defined (`basic/index.mdx:109-143`).
- **Segurança de transporte**: validar `Origin`; em 2026 não há GET/DELETE
  (`streamable-http.mdx:58-60`, `:683-687`).
- **Sandbox**: não existe no protocolo. A especificação diz que o host deve
  mostrar inputs e validar resultados (`server/tools.mdx:787-803`); não impõe
  isolamento de processo.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Schema TS | `npm run check:schema:ts` (`package.json:34`) | `tsc`, ESLint, Prettier |
| Schema JSON | `npm run check:schema:json` (`:35`) | regeneração determinística |
| Exemplos | `scripts/validate-examples.ts:1-98` | AJV contra cada exemplo |
| Schema MDX | `npm run check:schema:md` (`:37`) | Typedoc reproduz a página |
| Docs | `npm run check:docs` (`:38`) | formato, comentários, links |
| SEPs | `npm run check:seps` (`:42`) | render determinístico |
| SEP automation | `tools/sep-automation/` | regras, transições e comentários no GitHub |

Não há testes de runtime de cliente/servidor aqui — isso é papel dos SDKs. O
que existe é **validação de consistência** entre schema, exemplos e docs. Para
nós, o valor é usar o schema como oráculo de tipos e os exemplos como fixtures
de conformidade.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Schema e tipos de protocolo por revisão | `schema/2025-11-25/schema.ts:1`, `schema/2026-07-28/schema.ts:30` | fonte da verdade, sem tipos inventados | Apache-2.0/CC-BY-4.0 | `src/core/mcp/protocol/schema/` | 22 |
| Matriz de compatibilidade e negociação | `basic/versioning.mdx:41-78`, `:126-168` | define fallback correto entre eras | CC-BY-4.0 | `src/core/mcp/protocol/versions.ts` | 21 |
| Política de erros `-320xx` | `basic/index.mdx:109-150`, `schema/2026-07-28/schema.ts:434-513` | códigos estáveis e sem colisão | Apache-2.0 | `src/core/mcp/protocol/errors.ts` | 18 |
| Cache `ttlMs`/`cacheScope` | `server/utilities/caching.mdx:11-179` | evita `tools/list` repetido com segurança | CC-BY-4.0 | `src/core/mcp/cache.ts` | 17 |
| MRTR / `InputRequiredResult` | `basic/patterns/mrtr.mdx:1-228` | substituto correto de sampling/elicitation em 2026 | CC-BY-4.0 | `src/core/mcp/mrtr.ts` | 16 |
| `subscriptions/listen` e ack | `basic/patterns/subscriptions.mdx:7-123` | notificações multiplexadas com ID | CC-BY-4.0 | `src/core/mcp/subscriptions.ts` | 15 |
| Regras de OAuth/escopo | `basic/authorization/index.mdx:97-405` | issuer, resource e step-up sem ambiguidade | CC-BY-4.0 | `src/core/mcp/auth-policy.ts` | 20 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Adotar 2026-07-28 por inteiro agora | remove handshake, sessão, GET/SSE e requests servidor→cliente; nosso cliente é 2024-11-05 |
| O site Mintlify e `docs.json` | é publicação, não runtime |
| `tools/sep-automation` | automação de GitHub do projeto, não do produto |
| A documentação do Registry como código | usar a API REST, não copiar MDX |
| Os 264 exemplos JSON como testes | úteis como fixture, pesados como suíte |
| O `draft` como versão separada | é cópia de trabalho da próxima revisão |

## 12. Modelo de exemplo para o nosso harness

1. **Registro de versões explícito**: uma tabela `{ versão → era → métodos → schema }`
   com `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` e `2026-07-28`.
   O default do cliente deve ser a maior versão **legacy** suportada pelo
   servidor, e só subir para 2026 com opt-in. Base: `versioning.mdx:41-78`.
2. **Negociação observável**: ao receber `-32022`, ler `data.supported`,
   escolher a interseção mais nova e repetir **uma** vez; se não houver
   interseção, falhar com erro tipado. Base: `versioning.mdx:51-78` e
   `discover.mdx:88-106`.
3. **Capabilities por request** só na era 2026; na era 2025, capabilities vêm
   do `initialize`. Não misturar as duas. Base: `basic/index.mdx:367-392`.
4. **Erros**: mapear `-32601` para “método não suportado”, `-32602` para
   “params inválidos”, `-32020` para header mismatch, `-32021` para capability
   faltante e `-32022` para versão. Base: `basic/index.mdx:109-143`.
5. **Cache**: respeitar `ttlMs` (0 = stale), `cacheScope` (`private` por
   default) e invalidar em `list_changed`; nunca cachear página parcial como
   se fosse lista completa. Base: `caching.mdx:43-110`, `:147-169`.
6. **Teste**: usar os exemplos JSON de `schema/2025-11-25/examples/` como
   fixtures de request/response e validar com AJV; repetir para 2026 só no
   módulo que optar pela era moderna.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/mcp/modelcontextprotocol--modelcontextprotocol rev-parse HEAD
dae694f61a31f7a3ec2af3aff709e11f70f61e48
$ grep -n "LATEST_PROTOCOL_VERSION" schema/2026-07-28/schema.ts
30:export const LATEST_PROTOCOL_VERSION = "2026-07-28";
$ sed -n '11,19p' docs/specification/2026-07-28/changelog.mdx
1. Remove protocol-level sessions and the Mcp-Session-Id header...
2. Make MCP stateless: remove the initialize/notifications/initialized handshake...
3. Add server/discover...
4. Replace the HTTP GET endpoint and resources/subscribe with subscriptions/listen...
5. Remove ping, logging/setLevel, and notifications/roots/list_changed...
9. Remove SSE stream resumability...
$ grep -n "MCP-Protocol-Version\|Last-Event-ID\|405 Method Not Allowed" \
    docs/specification/2026-07-28/basic/transports/streamable-http.mdx
157:Resumable SSE streams via Last-Event-ID are not supported.
252:Every POST request to the MCP endpoint MUST include an MCP-Protocol-Version header.
683:- HTTP GET or DELETE to the MCP endpoint: respond with 405 Method Not Allowed.
$ grep -n "ttlMs\|cacheScope" docs/specification/2026-07-28/server/utilities/caching.mdx | head
43:- The Time-to-live (TTL) Field, ttlMs...
44:- The Cache Scope Field, cacheScope...
$ find docs/specification -name '*.mdx' | xargs wc -l | tail -1
36920 total
$ find schema -name '*.ts' | xargs wc -l | tail -1
12964 total
```
