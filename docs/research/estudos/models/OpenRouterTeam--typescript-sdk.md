# OpenRouter TypeScript SDK

| Campo | Valor |
|---|---|
| Repositório | https://github.com/OpenRouterTeam/typescript-sdk (`git remote get-url origin`) |
| Clone local | `repositorios/_research/models/OpenRouterTeam--typescript-sdk` |
| Commit | `f8f0d83627c78dbce6b95a78cace5473ba9ac17b` |
| Licença | Apache-2.0 (`LICENSE.md:1-2`; `package.json:21`) |
| Categoria | models / SDK de gateway multi-modelo |
| Stack | TypeScript ESM, Zod v4, Speakeasy (geração), Vitest, pnpm |
| Tamanho | 3.612 arquivos rastreados (1.283 `.ts`); 21,8 MiB; ≈150 mil linhas TS (estimativa) |

## 1. O que é (verificado no código)

O SDK é a camada TypeScript do OpenRouter: um cliente HTTP gerado pelo Speakeasy
para a API REST (`src/sdk/`, `src/funcs/`, `src/models/`) mais uma camada
**escrita à mão** em `src/lib/` que implementa um loop de agente (`callModel`),
execução de ferramentas, aprovação, stop conditions e normalização de stream. O
entrypoint é `OpenRouter` (`src/sdk/sdk.ts:57`), que agrupa `chat`, `responses`,
`models`, `providers`, `credits`, `generations`, etc. O valor real não é o
cliente gerado (3.612 arquivos, quase todos `DO NOT EDIT`), e sim o contrato de
`callModel`: uma chamada devolve `ModelResult`, que pode ser consumido como texto,
reasoning, tool calls ou stream completo (`src/funcs/call-model.ts:13-30`). O
catálogo é remoto (`GET /models`) e não há detecção de modelo local.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pnpm test` | `package.json:78` | Vitest do SDK |
| `new OpenRouter({ apiKey })` | `src/sdk/sdk.ts:57` | cliente principal |
| `client.callModel({ model, input, tools })` | `src/funcs/call-model.ts:69-116` | loop de agente |
| `client.chat.send(...)` | `src/sdk/chat.ts`; `src/funcs/chatSend.ts:219` | `POST /chat/completions` |
| `client.responses.send(...)` | `src/sdk/responses.ts:13-45` | `POST /responses` |
| `client.models.list(...)` | `src/sdk/models.ts`; `src/funcs/modelsList.ts:107` | `GET /models` com filtros |
| `client.models.get(...)` | `src/funcs/modelsGet.ts:108` | `GET /model/{author}/{slug}` |
| `client.providers.list()` | `src/funcs/providersList.ts:91` | provedores disponíveis |
| `client.generations.get(...)` | `src/funcs/generationsGetGeneration.ts:109` | custo/uso de uma geração |
| `client.credits.getCredits()` | `src/funcs/creditsGetCredits.ts:98` | saldo |
| `fromClaudeMessages([...])` | `src/lib/anthropic-compat.ts:86` | converte Anthropic → input |
| `stopWhen: [stepCountIs(5), maxCost(0.5)]` | `src/lib/stop-conditions.ts:13-111` | parada do loop |

O SDK não tem CLI nem UI. A "superfície" é o conjunto de namespaces
(`src/sdk/`: chat, responses, models, providers, presets, batch, guardrails,
observability, vault, workspaces, etc.).

Gemini não tem dialeto próprio: o acesso é pelo catálogo (`src/models/model.ts:46-127`)
e pelas rotas `/chat/completions`/`/responses`, com o modelo `google/...` roteado
como qualquer outro.

## 3. Arquitetura e fluxo

```
OpenRouter (sdk.ts)
  → chatSend/responsesSend (HTTP + EventStream)
  → ModelResult (callModel)
      → executeToolsIfNeeded → tool-orchestrator → tool-executor
      → nextTurnParams → novo turno
      → stop-conditions (stepCount, maxCost, hasToolCall...)
  → stream-transformers (text/reasoning/tool/usage)
```

- Entry point: `src/sdk/sdk.ts:57`; `src/funcs/call-model.ts:69`.
- Loop do agente: `src/lib/model-result.ts:520-524,1248`.
- Execução de ferramenta: `src/lib/tool-orchestrator.ts:44-138`.
- Streaming: `src/lib/event-streams.ts:26-188`; `src/lib/stream-transformers.ts:46-90`.
- Persistência: não há; `ConversationState` é opcional e vive no processo
  (`src/lib/conversation-state.ts:49-82`).

A API usa o formato **OpenResponses** como espinha dorsal: `callModel` envia para
`/responses` (`src/funcs/responsesSend.ts:218`), e o `ModelResult` acumula
`response.output` em mensagens, reasoning e tool calls. O chat completion
tradicional é um namespace separado (`chatSend.ts`), mas não passa pelo loop de
`callModel`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Catálogo remoto | `src/funcs/modelsList.ts:107-135` | filtros por preço, contexto, modalidade, benchmarks | baixo |
| Modelo detalhado | `src/models/model.ts:46-127` | contexto, preço, `supportedParameters`, reasoning | baixo |
| Preço por token | `src/models/publicpricing.ts:19-84` | prompt, completion, cache read/write, overrides | baixo |
| Provider preferences | `src/models/providerpreferences.ts:96-162` | ordem, allow/deny, preço máximo, ZDR | médio |
| Fallback de provider | `providerpreferences.ts:98-104`; `chatrequest.ts:337-340` | `allowFallbacks` e lista `models` | médio |
| Prompt cache | `src/models/promptcachebreakpoint.ts:19-25` | marcador OpenAI-style + TTL | baixo |
| Cache Anthropic | `src/models/chatcontentcachecontrol.ts:24-30` | `cache_control` convertido pelo roteador | baixo |
| Cache request-level | `src/models/promptcacheoptions.ts:17-23` | modo explícito + TTL 30m/12h | baixo |
| Reasoning | `src/models/modelreasoning.ts:21-55` | efforts aceitos, mandatory, `max_tokens` | baixo |
| Usage | `src/models/chatusage.ts:64-100` | cached, cache write, reasoning, custo | baixo |
| Responses | `src/sdk/responses.ts:13-45` | streaming/não-streaming | médio |
| Anthropic presets | `src/funcs/presetsCreatePresetsMessages.ts:113` | `/presets/{slug}/messages` | médio |
| Gerações/custo | `src/models/generationresponse.ts:208-222` | `totalCost`, upstream, cache discount | baixo |
| Guardrails | `src/sdk/guardrails.ts:25` | políticas e assignments | alto |
| BYOK | `src/sdk/byok.ts:17` | chaves do usuário por provider | alto |

## 5. Loop do agente, contexto e streaming

`callModel` monta a requisição, converte tools (`call-model.ts:93-105`) e devolve
um `ModelResult` **lazy**: nada é enviado até o primeiro consumo
(`model-result.ts:162-212`). O método `executeToolsIfNeeded` roda o loop:
requisição → tool calls → executar em paralelo → anexar resultados → novo turno
(`tool-orchestrator.ts:91-138`). O default é `stepCountIs(5)`
(`model-result.ts:86,524`); o chamador pode combinar `stepCountIs`, `hasToolCall`,
`maxTokensUsed`, `maxCost` e `finishReasonIs` com OR
(`stop-conditions.ts:49-67`).

Streaming: o `EventStream` parseia SSE com buffer crescente e estado de `id`
(`event-streams.ts:26-188`); `stream-transformers.ts` converte eventos
OpenResponses em texto (`extractTextDeltas`), reasoning (`extractReasoningDeltas`)
e argumentos de tool (`extractToolDeltas`) (`:46-90`). Um chunk pode conter
reasoning + tool call; o transformer mantém `ItemInProgress` por tipo
(`:207-282`). Não há compactação automática de contexto: o chamador envia o
histórico; `nextTurnParams` permite ajustar parâmetros entre turnos
(`src/lib/next-turn-params.ts:42-78`).

## 6. Sessões, estado e persistência

O SDK é stateless por padrão. `ConversationState` é um objeto opcional com
`id`, `createdAt`, `updatedAt`, mensagens e decisões de aprovação
(`conversation-state.ts:49-82`); ele existe para permitir retomar um loop após
aprovação, não para persistir em disco. `ModelResult` mantém um stream
"reusable" para múltiplos consumidores (`model-result.ts:147-150`), mas isso é
memória do processo. Não há fork, checkpoint ou banco.

## 7. Configuração e extensibilidade

- Base URL: `https://openrouter.ai/api/v1` por default, sobrescrita por
  `OPENROUTER_BASE_URL` ou `serverURL` (`src/lib/config.ts:19-21,46-50,68-72`).
- API key: `apiKey` estático ou função async (`config.ts:23-25`).
- Headers de atribuição: `httpReferer`, `appTitle`, `appCategories`
  (`config.ts:26-39`).
- Retry: `retryConfig` global ou por request (`config.ts:55-59`;
  `src/lib/sdks.ts:32-45`).
- HTTP hooks: `beforeRequest`, `requestError`, `response`
  (`src/lib/http.ts:40-79`).
- Tools: `Tool` com Zod, `execute`, `requireApproval`, `nextTurnParams`
  (`src/lib/tool-types.ts:156,263`; `src/lib/tool-executor.ts:62-84`).
- Extensão real: novas operações no OpenAPI/Speakeasy ou wrappers em `lib/`.

## 8. Permissões, sandbox e erros

O SDK não executa shell. A segurança é de **roteamento e aprovação**:
`ProviderPreferences` permite `only`, `ignore`, `order`, `dataCollection: deny`,
`zdr`, `maxPrice` e `requireParameters` (`providerpreferences.ts:96-162`); o
request de chat aceita uma lista ordenada de modelos de reserva
(`chatrequest.ts:337-340`). O
`callModel` tem aprovação por tool (`requireApproval`, `approveToolCalls`,
`rejectToolCalls`) e exige `state` para persistir a decisão
(`model-result.ts:126-134,215-231`). Erros HTTP são classes geradas
(`src/models/errors/openroutererror.ts:7`) com status e body; retry é por status
(`5XX` default) e `retry-after`/`retry-after-ms` (`src/lib/retries.ts:197-223`).
Não há sandbox de filesystem; tools rodam no processo do app.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Chat | `tests/chat.test.ts` | request/response, streaming |
| Responses | `tests/responses.test.ts` | input items, tools, eventos |
| Models | `tests/models.test.ts` | catálogo e filtros |
| Tool loop | `tests/build-tool-call-stream.test.ts`, `tests/create-tool.test.ts` | streaming de argumentos |
| Estado | `tests/conversation-state.test.ts` | aprovação e retomada |
| Schema | `tests/schema-sanitization.test.ts` | JSON Schema/Zod |
| Namespaces | `tests/sdk-namespaces.test.ts` | superfície pública |
| Tipos | `*.test-d.ts` | contratos |

A maior parte do código é gerada (`src/sdk/sdk.ts:1-4` é o cabeçalho
`DO NOT EDIT`), então os testes escritos à mão (tool loop, conversation state,
stream) são os que realmente protegem a lógica.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Catálogo com `supportedParameters` | `src/models/model.ts:103-126` | diz o que o modelo aceita, não só contexto | Apache-2.0 | `src/core/providers/catalog.ts` | 23 |
| Preço com cache read/write | `src/models/publicpricing.ts:19-84` | cobre tarifa de leitura/escrita e overrides | Apache-2.0 | `src/core/providers/cost.ts` | 22 |
| Preferências de provider | `src/models/providerpreferences.ts:96-162` | ordem, deny, preço, ZDR, params | Apache-2.0 | `src/core/providers/routing.ts` | 21 |
| Reasoning allowlist | `src/models/modelreasoning.ts:21-55` | `mandatory`, `supportsMaxTokens`, default | Apache-2.0 | `src/shared/reasoning.ts` | 20 |
| Uso com custo por request | `src/models/chatusage.ts:64-100`; `generationresponse.ts:208-222` | custo real, cached e reasoning | Apache-2.0 | `src/core/providers/cost.ts` | 19 |
| Cache marker conversion | `src/models/promptcachebreakpoint.ts:19-25`; `chatcontentcachecontrol.ts:24-30` | um marcador, dois dialetos | Apache-2.0 | `src/core/providers/cache.ts` | 19 |
| Retry com `Retry-After` | `src/lib/retries.ts:153-223` | backoff 1,5× + header | Apache-2.0 | `src/core/providers/http.ts` | 18 |
| Stop conditions com custo | `src/lib/stop-conditions.ts:82-128` | orçamento em tokens e USD | Apache-2.0 | `src/core/agent/runner.ts` | 17 |
| EventStream/SSE | `src/lib/event-streams.ts:26-188` | parser incremental robusto | Apache-2.0 | `src/core/providers/http.ts` | 15 |
| Anthropic compat | `src/lib/anthropic-compat.ts:62-90` | converte mensagens Claude | Apache-2.0 | `src/core/providers/anthropic.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| 829 arquivos de modelos gerados | código Speakeasy, não escrito à mão |
| Namespaces enterprise (vault, scim, guardrails) | escopo de conta, não de cliente |
| Loop baseado em `/responses` | nosso provider fala Chat Completions |
| `nextTurnParams` | acoplado ao formato de tool do OpenRouter |
| BYOK/OAuth | fluxo de conta OpenRouter |
| Batch/video/audio | fora do escopo de chat do harness |
| `EventStream` completo | já temos `readSse`; só a ideia de buffer |
| `ConversationState` | já temos sessão própria em `src/core/session` |

## 12. Modelo de exemplo para o nosso harness

1. **Catálogo** — acrescentar `supportedParameters` ao nosso preset e usar isso
   para decidir envio de `temperature`, `top_p`, `max_tokens`,
   `reasoning_effort` e `tools`. Fonte: `model.ts:103-126`; hoje o nosso
   `resolveCompat` (`src/core/providers/compat.ts:25-34`) só olha modelo/host.
2. **Reasoning** — modelar `mandatory`, `supportedEfforts`, `defaultEffort`,
   `supportsMaxTokens` (`modelreasoning.ts:21-55`) no `ModelCompat`
   (`src/shared/types.ts:425-436`). O picker de effort
   (`src/shared/reasoning.ts:171-179`) passa a usar a allowlist.
3. **Custo** — mapear `usage.cost` e `costDetails` para `Usage.costUsd`
   (`src/shared/types.ts:101-106`); hoje o runner calcula por
   `inputCostPerMTok`/`outputCostPerMTok` (`runner.ts:264-275`), sem cache.
4. **Roteamento/fallback** — copiar a ideia de `allowFallbacks`, `order`,
   `only`/`ignore`, `maxPrice` (`providerpreferences.ts:96-162`) para a lista de
   fallback do runner (`runner.ts:968-981`), que hoje é uma fila cega.
5. **Prompt cache** — adotar o marcador único (`prompt_cache_breakpoint` ou
   `cache_control`) e converter por provedor (`chatcontentcachecontrol.ts:24-30`).
6. **Teste** — catálogo (modelo sem `temperature`), custo com cached, fallback
   por 429 e stop por `maxCost`.

## 13. Evidências da análise

```text
git -C repositorios/_research/models/OpenRouterTeam--typescript-sdk rev-parse HEAD
  f8f0d83627c78dbce6b95a78cace5473ba9ac17b
git ls-files: 3612 arquivos; 1283 .ts
LICENSE.md:1-2           Apache-2.0
package.json:2,3,21     name, version, license
src/sdk/sdk.ts:57        classe OpenRouter
src/lib/config.ts:19-21,23-59,68-72
src/lib/retries.ts:15-20,153-223
src/lib/event-streams.ts:26-188
src/lib/stop-conditions.ts:13-128
src/lib/tool-orchestrator.ts:44-138
src/lib/model-result.ts:86,126-134,147-150,520-524,1248,1396,1602
src/lib/conversation-state.ts:49-82
src/lib/next-turn-params.ts:42-78
src/lib/stream-transformers.ts:46-90,207-282
src/lib/anthropic-compat.ts:62-90
src/funcs/call-model.ts:69-116
src/funcs/chatSend.ts:219,264,274
src/funcs/responsesSend.ts:218
src/funcs/modelsList.ts:107-135
src/models/model.ts:46-127
src/models/publicpricing.ts:19-84
src/models/providerpreferences.ts:96-162
src/models/modelreasoning.ts:21-55
src/models/chatusage.ts:64-100
src/models/costdetails.ts:15-23
src/models/generationresponse.ts:208-222
src/models/promptcachebreakpoint.ts:19-25
src/models/chatcontentcachecontrol.ts:24-30
src/models/promptcacheoptions.ts:17-23
tests/: chat, responses, models, tool stream, state, schema
```
