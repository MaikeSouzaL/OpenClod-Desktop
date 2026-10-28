# Vercel AI SDK

| Campo | Valor |
|---|---|
| Repositório | https://github.com/vercel/ai (`git remote get-url origin`) |
| Clone local | `repositorios/_research/models/vercel--ai` |
| Commit | `682e2dd71456f14f9da33a1b983d1998c3a1184c` |
| Licença | Apache-2.0 (`LICENSE:1-4`; `packages/ai/package.json:6`) |
| Categoria | models / SDK TypeScript multi-provedor + gateway |
| Stack | TypeScript 6, pnpm + turbo, Vitest 4, Zod, React/Next para bindings |
| Tamanho | 9.547 arquivos rastreados (7.355 `.ts/.tsx`); 127,7 MiB; ≈800 mil linhas TS (estimativa) |

## 1. O que é (verificado no código)

O AI SDK é uma **interface única** para modelos: `LanguageModelV4` define
`doGenerate`/`doStream` (`packages/provider/src/language-model/v4/language-model-v4.ts:46-58`),
e cada pacote de provedor (`packages/openai`, `packages/anthropic`,
`packages/google`, `packages/openai-compatible`, …) implementa essa interface.
A camada de cima (`packages/ai/src/generate-text/`) é um loop de agente completo:
monta mensagens, chama o modelo, executa ferramentas, acumula steps e para por
`stopWhen` (`generate-text.ts:1544-1553`). O produto inclui também um gateway
hospedado com catálogo e fallback (`packages/gateway/src/gateway-provider-options.ts:49-129`).
A descrição do pacote (`packages/ai/package.json:5`) promete uma interface única;
o código confirma, mas o valor está menos no SDK e mais nas **decisões de tipo**:
usage com cache read/write, reasoning como canal, tool approval e retry com
`Retry-After`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pnpm build` | `package.json:5` | turbo build de todos os pacotes |
| `pnpm test` | `package.json:17` | Vitest por pacote |
| `pnpm type-check` | `package.json:14` | `tsc --build` |
| `generateText({...})` | `packages/ai/src/generate-text/generate-text.ts:235` | chamada não-streaming com loop |
| `streamText({...})` | `packages/ai/src/generate-text/stream-text.ts:376` | chamada streaming com loop |
| `stopWhen: stepCountIs(n)` | `stop-condition.ts:27-29` | condição de parada |
| `maxRetries` | `stream-text.ts:344`; `generate-text.ts:205` | retries (default 2) |
| `streamRetries` | `stream-text.ts:690` | retry depois do stream iniciado |
| `smoothStream()` | `smooth-stream.ts:39-45` | re-chunking de texto para UI |
| `pruneMessages()` | `prune-messages.ts:17-51` | remove reasoning/tool antigo do contexto |
| `gateway('openai/gpt-...')` | `packages/gateway/src/gateway-provider.ts:365,768` | modelo via gateway |
| `createOpenAICompatible({ baseURL })` | `packages/openai-compatible/src/openai-compatible-provider.ts:132-145` | provedor OpenAI-like arbitrário |
| `POST /v1/responses` | `packages/openai/src/responses/` | OpenAI Responses nativo |

A superfície é de biblioteca, não CLI: não há comando de usuário final. O "UX" é
o conjunto de opções tipadas (`GenerateTextOptions`, `StreamTextOptions`).

## 3. Arquitetura e fluxo

```
generateText/streamText
  → resolve model (registry/gateway/provider)
  → prepareStep (system, messages, tools, providerOptions)
  → LanguageModelV4.doStream/doGenerate
  → parse stream parts (text/reasoning/tool-input/finish)
  → execute tools → append messages → stopWhen?
  → usage + steps + response
```

- Entry point: `packages/ai/package.json:8-10` e `generate-text.ts:235` /
  `stream-text.ts:376`.
- Loop do agente: `generate-text.ts:883,1544-1553`.
- Execução de ferramenta: `execute-tool-call.ts:43-79`.
- Streaming: `stream-language-model-call.ts:198` +
  `language-model-v4-stream-part.ts:18-117`.
- Persistência: não há; o SDK é stateless e devolve `steps`/`messages`.

A separação é limpa: o provider só traduz a requisição; o loop, as aprovações e o
stop são do pacote `ai`. Isso permite trocar OpenAI por Anthropic sem mudar o
runner — exatamente o que o nosso `Provider` faz, mas com tipos muito mais
granulares.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Interface de modelo | `language-model-v4.ts:46-58` | `doGenerate`/`doStream` + `supportedUrls` | baixo |
| Prompt normalizado | `language-model-v4-prompt.ts:18-20` | system/user/assistant/tool parts | baixo |
| Tool definition | `language-model-v4-function-tool.ts:11` | JSON Schema + provider tool | baixo |
| Tool choice | `language-model-v4-tool-choice.ts:1` | auto/required/none/ específico | baixo |
| Reasoning | `language-model-v4-call-options.ts:119-131` | `provider-default..max` | baixo |
| Usage detalhado | `types/usage.ts:10-59` | cache read/write + reasoning tokens | baixo |
| Retry | `util/retry-with-exponential-backoff.ts:10-95` | backoff + headers | baixo |
| Stop conditions | `stop-condition.ts:8-54` | step count, tool call, loop infinito | baixo |
| Tool approval | `collect-tool-approvals.ts:12-47` | aprovação/negação por call | médio |
| Gateway catálogo | `gateway-fetch-metadata.ts:35-57` | modelos + preços por token | baixo |
| Gateway fallback | `gateway-provider-options.ts:93-129` | ordem, modelos de fallback, filtros | médio |
| OpenAI Responses | `packages/openai/src/responses/openai-responses-language-model.ts:245,1554` | input/output items | médio |
| Anthropic cache | `packages/anthropic/src/get-cache-control.ts:7-69` | 4 breakpoints | médio |
| Gemini thinking | `packages/google/src/google-language-model-options.ts:68-84` | budget/level/cachedContent | baixo |

## 5. Loop do agente, contexto e streaming

O loop é explícito: `do { ... } while (finishReason !== 'interrupted' && ... &&
!isStopConditionMet(...))` (`generate-text.ts:1544-1553`). Antes de cada step,
`prepareStep` pode trocar modelo, system, tools e `providerOptions`
(`generate-text.ts:404`); depois, `executeToolCall` roda ferramentas e emite
eventos (`execute-tool-call.ts:43-79`). A parada natural inclui "modelo devolveu
finish reason diferente de tool-calls", "tool sem execute", "tool precisa de
aprovação" (`stop-condition.ts:8-19`). O default é `stepCountIs(1)` em
`generateText` (`generate-text.ts:252`) e `isStepCount(1)` em `streamText`
(`stream-text.ts:448`) — ou seja, o loop só continua se o chamador pedir.

Streaming: o provider emite partes tipadas — `text-start/delta/end`,
`reasoning-start/delta/end`, `tool-input-start/delta/end`, `finish`, `error`
(`language-model-v4-stream-part.ts:18-117`). O `streamText` remonta conteúdo,
grava `steps` e pode re-tentar o stream se o erro acontecer depois do primeiro
chunk (`stream-text.ts:690`; `canRetryStreamViaOnError` em `:939`). O
`smoothStream` re-chunka o texto para a UI (`smooth-stream.ts:39-45`), e
`pruneMessages` remove reasoning antigo (default `none`, opções `all` e
`before-last-message`) (`prune-messages.ts:11-51`).

## 6. Sessões, estado e persistência

Não há sessão. `generateText` devolve `steps` e `messages`; `streamText` devolve
um stream e `response.messages`; quem persiste é o app. O `prepareStep` recebe os
steps anteriores para decidir o próximo (`generate-text.ts:404`), o que permite
compactação manual. O gateway tem `caching: 'auto'` e `providerOptions` de
roteamento (`gateway-provider-options.ts:59-61`), mas isso é cache de resposta do
serviço, não sessão. Não há fork/checkpoint.

## 7. Configuração e extensibilidade

- Providers: instâncias explícitas (`createOpenAI`, `createAnthropic`, …) ou
  registry (`packages/ai/src/registry/provider-registry.ts:89`), que resolve
  `provider:model`.
- Variáveis de ambiente por provider: cada factory resolve a própria chave; por
  exemplo OpenAI usa `OPENAI_API_KEY` e Anthropic usa `ANTHROPIC_API_KEY`
  (`packages/openai/src/openai-provider.ts:235-237`;
  `packages/anthropic/src/anthropic-provider.ts:164-166`), sem precedência global.
- Gateway: `packages/gateway/src/gateway-config.ts:7-12`; base URL e headers.
- Middleware: `LanguageModelV4Middleware`
  (`packages/provider/src/language-model-middleware/v4/language-model-v4-middleware.ts:11`)
  permite envolver `doGenerate`/`doStream` (ex.: logging, cache, RAG).
- Telemetria: `packages/ai/src/telemetry/` (`telemetry.ts:84,136`) e
  `experimental_telemetry`.
- Ferramentas: `tool()` de `@ai-sdk/provider-utils`, com `inputSchema`,
  `execute`, `needsApproval`; MCP em `packages/mcp/`.
- Sem plugins de processo ou hot reload; extensão = novo provider/middleware.

## 8. Permissões, sandbox e erros

O SDK não executa comandos; ferramentas são funções do app. O ponto forte é
**tool approval**: `ToolApprovalRequest`/`Response`, `collectToolApprovals` e
`needsApproval` pausam o loop até uma decisão (`collect-tool-approvals.ts:12-47`).
Erros são `APICallError` (com `isRetryable` e `responseHeaders`) e `GatewayError`
(`retry-with-exponential-backoff.ts:83-88`). O retry respeita `retry-after-ms` e
`retry-after` (segundos ou data) apenas se o atraso estiver entre 0 e 60 s
(`:27-55`). Abort não é retentado (`:89-91`). Não há sandbox de filesystem/rede;
isso fica para `packages/sandbox-*` e `tool-bash`.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| `ai` | `packages/ai/src/generate-text/*.test.ts` | 1 MB em `stream-text.test.ts`; loop, tools, usage |
| Provider OpenAI | `packages/openai/src/*.test.ts` | Responses, capabilities, erros |
| Provider Anthropic | `packages/anthropic/src/*.test.ts` | cache, thinking, tools, usage |
| Provider Google | `packages/google/src/*.test.ts` | thinkingConfig, tools, usage |
| Gateway | `packages/gateway/src/*.test.ts` | metadata, fallback, erros |
| Tipos | `*.test-d.ts` | contratos de tipos |
| Edge | `vitest.edge.config.js` | runtime sem Node |

A cobertura é excelente em contrato de provider e fraca em integração real
(quase tudo mockado). Os testes são a melhor documentação do formato de cada
provedor.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Interface `LanguageModelV4` | `language-model-v4.ts:46-58` | contrato mínimo e estável | Apache-2.0 | `src/core/providers/types.ts` | 25 |
| Usage com cache/reasoning | `types/usage.ts:10-59` | quatro contadores explícitos | Apache-2.0 | `src/shared/types.ts` | 23 |
| Retry com `Retry-After` | `util/retry-with-exponential-backoff.ts:10-95` | header + backoff + abort | Apache-2.0 | `src/core/providers/http.ts` | 22 |
| Stop conditions | `stop-condition.ts:8-54` | loop previsível e testável | Apache-2.0 | `src/core/agent/runner.ts` | 20 |
| Capability table OpenAI | `openai-language-model-capabilities.ts:16-72` | família → parâmetros aceitos | Apache-2.0 | `src/core/providers/compat.ts` | 21 |
| Validador de cache Anthropic | `get-cache-control.ts:7-69` | 4 breakpoints + warning | Apache-2.0 | `src/core/providers/anthropic.ts` | 19 |
| Catálogo do gateway | `gateway-fetch-metadata.ts:35-57,112-130` | modelo + preço + cache | Apache-2.0 | `src/core/providers/catalog.ts` | 18 |
| Fallback do gateway | `gateway-provider-options.ts:93-129` | ordem e modelos de reserva | Apache-2.0 | `src/core/providers/fallback.ts` | 16 |
| `pruneMessages` | `prune-messages.ts:11-51` | política de descarte de reasoning | Apache-2.0 | `src/core/agent/compaction.ts` | 17 |
| `smoothStream` | `smooth-stream.ts:39-45` | UI sem jitter | Apache-2.0 | `src/renderer` | 9 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| 30+ pacotes de provider | manutenção; temos dois dialetos e descoberta |
| Gateway hospedado | dependência de serviço Vercel |
| React/RSC bindings (`packages/react`, `rsc`) | já temos renderer |
| `Workflow`/`harness-*` | outro produto, acoplado ao ecossistema |
| Zod como schema interno | já usamos JSON Schema nos tools |
| Telemetria OTel completa | podemos instrumentar sem o SDK inteiro |
| `smooth-stream` no core | pertence à UI, não ao provider |
| Tipos de mídia (image/video/speech) | escopo maior que o nosso chat |

## 12. Modelo de exemplo para o nosso harness

1. **Contrato de provider** — copiar a ideia de `doGenerate`/`doStream` com
   `LanguageModelV4StreamPart` (`language-model-v4-stream-part.ts:18-117`). O
   nosso `ProviderEvent` (`src/shared/types.ts:116-125`) já é parecido; falta
   `tool-input-start/delta/end` explícito e `finish` com usage.
2. **Usage** — evoluir `Usage` (`src/shared/types.ts:101-106`) para
   `{ input, output, cacheRead, cacheWrite, reasoning, costUsd }`, como
   `types/usage.ts:19-59`.
3. **Capability table** — trocar o regex de `compat.ts:11-19` por uma tabela
   família → flags, no molde de `openai-language-model-capabilities.ts:16-72`.
4. **Retry** — manter `postStream` (`src/core/providers/http.ts:171-228`) e
   acrescentar `streamRetries` para falha após primeiro chunk, como
   `stream-text.ts:690`; o nosso runner já faz retry de stream
   (`src/core/agent/runner.ts:953-965`), mas sem header.
5. **Stop conditions** — hoje o runner para por `finalStep` e tool calls
   (`runner.ts:1019`); adicionar `stopWhen` com `stepCount`, `hasToolCall` e
   `maxCost`, inspirado em `stop-condition.ts:27-54`.
6. **Teste** — contracts de stream (texto, reasoning, tool input, erro) e de
   usage; usar os testes do AI SDK como especificação, não copiar código.

## 13. Evidências da análise

```text
git -C repositorios/_research/models/vercel--ai rev-parse HEAD
  682e2dd71456f14f9da33a1b983d1998c3a1184c
git ls-files: 9547 arquivos; 7355 .ts/.tsx
LICENSE:1-4              Apache-2.0
packages/ai/package.json:3,6  name/version/license
package.json:5,14,17          build, type-check, test
packages/provider/src/language-model/v4/language-model-v4.ts:46-58
packages/provider/src/language-model/v4/language-model-v4-call-options.ts:22,96,119-138
packages/provider/src/language-model/v4/language-model-v4-stream-part.ts:18-117
packages/ai/src/types/usage.ts:10-59
packages/ai/src/generate-text/generate-text.ts:235,248,883,1544-1553
packages/ai/src/generate-text/stream-text.ts:344,376,443,448,690,939
packages/ai/src/generate-text/stop-condition.ts:8-54
packages/ai/src/generate-text/execute-tool-call.ts:43-79
packages/ai/src/util/retry-with-exponential-backoff.ts:10-95
packages/ai/src/util/prepare-retries.ts:10-53
packages/ai/src/generate-text/prune-messages.ts:11-51
packages/ai/src/generate-text/smooth-stream.ts:39-45
packages/openai/src/openai-language-model-capabilities.ts:16-72
packages/openai/src/responses/openai-responses-language-model.ts:344-361
packages/anthropic/src/get-cache-control.ts:7-69
packages/anthropic/src/anthropic-language-model-options.ts:163-211
packages/google/src/google-language-model-options.ts:68-84
packages/gateway/src/gateway-fetch-metadata.ts:35-57,112-130
packages/gateway/src/gateway-provider-options.ts:49-129
packages/openai-compatible/src/openai-compatible-provider.ts:132-145
```
