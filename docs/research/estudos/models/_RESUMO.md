# Resumo — repositórios de modelos e roteamento

Estudo estático dos cinco clones de `repositorios/_research/models/`, com foco no
que o Openclod precisa para normalizar provedores, streaming, tool calling,
reasoning, cache, fallback, retry e custo. Toda afirmação detalhada está nos
estudos individuais; aqui ficam a comparação e a fila de reúso.

## Os cinco clones

| Repositório | Commit | Licença | O que é de fato | O que aproveitar | O que ignorar |
|---|---|---|---|---|---|
| `BerriAI--litellm` | `dddbaa803d6e9fcc862ea7a5412f771cb1ae040e` | MIT fora de `enterprise/` | gateway Python com 152 famílias de provedores, catálogo de preços e `Router` | catálogo, custo com cache, retry policy, generalizações de modelo | proxy multi-tenant, 152 providers, `enterprise/` |
| `ollama--ollama` | `d44c2581904a98430e348d89cc2af1529b1808a0` | MIT | runtime local + servidor OpenAI/Responses/Anthropic | `/api/show`, capabilities, descriptor de thinking, parser por família | runtime, scheduler de VRAM, registry |
| `ggml-org--llama.cpp` | `b3fa69955ea81c3b60e77e3c1e2224c4a826ffb9` | MIT | runtime C++ + servidor OpenAI/Responses/Anthropic/MCP | auto-parser de tool call, reasoning budget, prompt cache, `/props` | núcleo ggml, router de GGUF, C++ |
| `vercel--ai` | `682e2dd71456f14f9da33a1b983d1998c3a1184c` | Apache-2.0 | SDK TS com `LanguageModelV4`, loop de agente e gateway | interface de modelo, usage, retry, stop conditions, capability table | 30+ providers, gateway hospedado, bindings React |
| `OpenRouterTeam--typescript-sdk` | `f8f0d83627c78dbce6b95a78cace5473ba9ac17b` | Apache-2.0 | SDK TS gerado + `callModel` com loop e roteamento | catálogo rico, preços, provider preferences, reasoning allowlist | 829 modelos gerados, namespaces de conta, BYOK |

## 10 candidatos (score 0–25)

Critério do score: utilidade para o harness × aderência ao nosso stack ×
esforço de porte × qualidade de teste. 25 = porta quase direto; 15 = adapta a
ideia; abaixo de 10 = só referência.

| # | Candidato | Origem (arquivo:linha) | Destino proposto | Tipo | Score |
|---|---|---|---|---|---|
| 1 | Contrato `LanguageModelV4` (`doGenerate`/`doStream` + stream parts) | `vercel--ai`: `packages/provider/src/language-model/v4/language-model-v4.ts:46-58`; `language-model-v4-stream-part.ts:18-117` | `src/core/providers/types.ts` | adaptar | 25 |
| 2 | Auto-parser de tool call por template/família | `ggml-org--llama.cpp`: `common/chat-auto-parser.h:48-60`; `common/chat.cpp:211-229` | `src/core/providers/tool-parse.ts` | adaptar | 24 |
| 3 | Descoberta por capabilities no `/api/show` | `ollama--ollama`: `server/routes.go:1745-1960`; `api/types.go:806-828` | `src/core/providers/discovery.ts` | portar ideia | 24 |
| 4 | Catálogo com `supportedParameters`, contexto e preço | `OpenRouterTeam--typescript-sdk`: `src/models/model.ts:46-127`; `publicpricing.ts:19-84` | `src/core/providers/catalog.ts` | portar schema | 23 |
| 5 | Usage com cache read/write, reasoning e custo | `vercel--ai`: `packages/ai/src/types/usage.ts:10-59`; `OpenRouterTeam--typescript-sdk`: `src/models/chatusage.ts:64-100` | `src/shared/types.ts` + `src/core/providers/cost.ts` | adaptar | 23 |
| 6 | Retry com `Retry-After`/`retry-after-ms` + backoff | `vercel--ai`: `packages/ai/src/util/retry-with-exponential-backoff.ts:10-95`; `OpenRouterTeam--typescript-sdk`: `src/lib/retries.ts:153-223` | `src/core/providers/http.ts` | portar ideia | 22 |
| 7 | Descriptor de thinking do modelo (values/default) | `ollama--ollama`: `types/model/thinking.go:11-95`; `server/model_thinking.go:63-95` | `src/shared/reasoning.ts` | portar schema | 22 |
| 8 | Custo normalizado OpenAI vs Anthropic (cache) | `BerriAI--litellm`: `litellm/cost_calculator.py:411-490` | `src/core/providers/cost.ts` | portar lógica | 22 |
| 9 | Capability table de família OpenAI | `vercel--ai`: `packages/openai/src/openai-language-model-capabilities.ts:16-72` | `src/core/providers/compat.ts` | portar tabela | 21 |
| 10 | Preferências de provider + fallback | `OpenRouterTeam--typescript-sdk`: `src/models/providerpreferences.ts:96-162`; `chatrequest.ts:337-340` | `src/core/providers/routing.ts` | adaptar | 21 |

Reservas úteis (não entram no top 10): validador de 4 breakpoints Anthropic
(`vercel--ai`: `packages/anthropic/src/get-cache-control.ts:7-69`, score 19),
planejador de cache do LiteLLM
(`litellm/llms/anthropic/prompt_cache_prediction.py:258-341`, 16),
`pruneMessages` (`vercel--ai`: `prune-messages.ts:11-51`, 17),
stop conditions com `maxCost` (`OpenRouterTeam--typescript-sdk`:
`src/lib/stop-conditions.ts:82-128`, 17).

## Leitura transversal

### Normalização de provedores

- LiteLLM resolve por prefixo do modelo, depois catálogo JSON, depois `api_base`
  conhecido, com comparação de host por URL parseada
  (`get_llm_provider_logic.py:173-335`). É a referência mais completa, mas o custo
  é manter 152 dialetos.
- OpenRouter e AI SDK resolvem por **catálogo remoto**: o modelo já traz
  `supported_parameters`/capabilities
  (`src/models/model.ts:103-126`;
  `packages/openai/src/openai-language-model-capabilities.ts:16-72`). É o modelo
  que o nosso `resolveCompat` deve seguir, trocando regex por tabela.
- Ollama e llama.cpp resolvem por **metadados do arquivo local** (`/api/show`,
  GGUF, `/props`). Para modelo local, o nome nunca é suficiente.

### Streaming

- Há dois padrões: SSE com `data:` (OpenAI/Anthropic/llama.cpp) e NDJSON
  (Ollama nativo, `server/routes.go:2605-2607`). O nosso `readSse`
  (`src/core/providers/http.ts:78-143`) cobre SSE, não NDJSON; o provider Ollama
  usa `/v1`, então hoje está coberto.
- A divisão de canais é o ponto delicado: Ollama separa reasoning e
  content/tool no mesmo chunk (`openai/openai.go:399-420`); llama.cpp converte
  reasoning em `thinking`/`signature_delta` no Anthropic
  (`server-task.cpp:750-756,921`); AI SDK usa partes tipadas
  (`language-model-v4-stream-part.ts:18-117`). O nosso `ProviderEvent` já tem
  `reasoning_delta`, mas não tem `tool_input_delta` nem `finish` com usage.

### Tool calling

- Quatro abordagens: (a) parser de texto por família (Ollama
  `model/parsers/parsers.go:49-80`), (b) auto-parser a partir do template
  (llama.cpp `common/chat-auto-parser.h:48-60`), (c) tools nativos no provedor
  (AI SDK/OpenRouter), (d) helper de loop sem streaming (LiteLLM
  `tool_loop.py:35-39`).
- Para o nosso caso, o ganho está em (a)+(b): modelos locais e OpenAI-compatible
  baratos frequentemente emitem tool call fora do JSON canônico. O
  `parseArgs` atual (`src/core/providers/openai.ts:268-289`) só conserta JSON,
  não reconhece tags.

### Reasoning/thinking

- Ollama é o único que modela **níveis como dados do modelo**
  (`values`/`default`, `types/model/thinking.go:11-50`); llama.cpp tem
  `reasoning_format` + `reasoning_budget` (`common/common.h:427-432`;
  `common/reasoning-budget.cpp:52-90`); LiteLLM mapeia esforço para
  `thinking.budget_tokens`/`adaptive` (`llms/anthropic/chat/transformation.py:1561-1601`);
  AI SDK expõe `reasoning: provider-default..max`
  (`language-model-v4-call-options.ts:119-131`); OpenRouter publica
  `mandatory`/`supportedEfforts`/`supportsMaxTokens`
  (`modelreasoning.ts:21-55`).
- O nosso `anthropicFamily` (`src/shared/reasoning.ts:49-79`) já é bom; falta a
  parte de modelo local e a allowlist de esforço por modelo.

### Cache de prompt

- Anthropic: até 4 breakpoints, `cache_control` proibido em thinking
  (LiteLLM `prompt_cache_prediction.py:329-334`; AI SDK
  `get-cache-control.ts:7-69`; o nosso `anthropic.ts:134-143` usa 3).
- OpenAI/OpenRouter: `prompt_cache_breakpoint`, TTL 30m/12h
  (`promptcachebreakpoint.ts:19-25`); OpenRouter converte o marcador para
  `cache_control` quando o upstream é Anthropic
  (`chatcontentcachecontrol.ts:24-30`).
- Local: llama.cpp reusa prefixo (`server-context.cpp:3993-3995`) e reporta
  `cached_tokens` (`server-task.cpp:357-364`); Ollama faz o mesmo via
  `cache_prompt` (`llm/llama_server.go:1691,1863`).

### Fallback, retry e erros

- LiteLLM tem retry por classe de exceção
  (`router_utils/get_retry_from_policy.py:19-66`), cooldown e fallback
  (`router.py:1206-1216,9234-9277`); o nosso runner já tem fila de fallback e
  retry de stream (`src/core/agent/runner.ts:953-981`), mas sem `Retry-After`.
- AI SDK e OpenRouter respeitam `retry-after-ms` e `retry-after` (segundos ou
  data) com limite de 60 s (`retry-with-exponential-backoff.ts:27-55`;
  `src/lib/retries.ts:197-223`). É o ajuste mais barato e de maior impacto no
  nosso `postStream`.
- Fallback de modelo: AI SDK/Gateway tem lista `models` + ordem de provider
  (`gateway-provider-options.ts:93-129`); OpenRouter tem `allowFallbacks` e lista
  `models` (`providerpreferences.ts:98-104`; `chatrequest.ts:337-340`).

### Custo e tokens

- LiteLLM é a referência: catálogo por modelo, `input/output_cost_per_token`,
  `cache_read/creation`, `output_cost_per_reasoning_token`
  (`model_prices_and_context_window_backup.json:2-41`) e normalização
  OpenAI/Anthropic (`cost_calculator.py:483-490`).
- OpenRouter devolve custo **por request** (`usage.cost`, `costDetails`,
  `generationresponse.ts:208-222`), o que é mais simples do que recalcular.
- AI SDK só tipa usage; não calcula custo (não encontrado `calculateCost` em
  `packages/ai/src`). O nosso `runner.ts:264-275` calcula por MTok, sem cache.

### Catálogo e detecção local

- LiteLLM: catálogo bundled + fetch remoto com fallback
  (`get_model_cost_map.py:1-5`).
- OpenRouter: `GET /models` com filtros de preço/contexto/modalidade
  (`modelsList.ts:107-135`).
- AI SDK: gateway `/config` (`gateway-fetch-metadata.ts:35-57`) e registry
  `provider:model` (`provider-registry.ts:89`); **não há descoberta local**
  (nenhum `ollama`/`127.0.0.1` em `packages/ai`/`provider-utils`).
- Ollama: `/api/tags` + `/api/show`; llama.cpp: `/v1/models` + `/props`. São os
  dois que o nosso `discovery.ts` deve continuar usando.

### OpenAI Responses, Anthropic e Gemini

- Responses: LiteLLM (`litellm/responses/dispatch.py:130-146`), Ollama
  (`openai/responses.go:589-640`), llama.cpp (`server-task.cpp:520-591`), AI SDK
  (`packages/openai/src/responses/`) e OpenRouter (`src/sdk/responses.ts:13-45`).
  O formato já é o "novo default" de vários provedores; o nosso harness ainda
  fala só Chat Completions.
- Anthropic: LiteLLM é o mais fiel (thinking assinado, cache, tool_result);
  Ollama (`anthropic/anthropic.go:323-425`) e llama.cpp
  (`server-task.cpp:734-800`) implementam o suficiente para clientes Claude;
  OpenRouter tem presets `/presets/{slug}/messages`.
- Gemini: AI SDK é o único com `thinkingConfig` (budget/level/includeThoughts) e
  `cachedContent` (`packages/google/src/google-language-model-options.ts:68-84`);
  LiteLLM mapeia `reasoning_effort` para Vertex
  (`llms/vertex_ai/gemini/vertex_and_google_ai_studio_gemini.py:1705`). Ollama e
  llama.cpp não têm endpoint Gemini `generateContent` (não encontrado); o
  llama.cpp expõe apenas um compat GCP AIP `predict` em `server-http.cpp:865-918`.
  Nosso `src/core/providers` não tem provider Gemini nativo.

## Lacunas do nosso núcleo (mapeadas)

| Lacuna | Onde no Openclod | Candidato |
|---|---|---|
| `Usage` só tem input/output/cachedInput, sem cache write nem reasoning | `src/shared/types.ts:101-106` | #5 |
| `retryAfterMs` existe, mas o runner usa backoff fixo | `src/core/providers/http.ts:36-46`; `src/core/agent/runner.ts:953-965` | #6 |
| Compatibilidade por regex (`o\d+`, `gpt-5`, thinking) | `src/core/providers/compat.ts:11-19` | #9 |
| Tool call só conserta JSON; não reconhece tags por família | `src/core/providers/openai.ts:268-289` | #2 |
| Thinking Anthropic codificado por família; sem descriptor local | `src/shared/reasoning.ts:49-79` | #7 |
| Descoberta local não lê GGUF/`/props`; só `/api/tags`, `/models` | `src/core/providers/discovery.ts:244-360` | #3 |
| Fallback é fila cega, sem ordem/preço/capability | `src/core/agent/runner.ts:968-981` | #10 |

## Fila sugerida

1. **Onda 1 (barata, alto ganho)** — `Usage` com cache/reasoning, `Retry-After`
   no `postStream`, capability table OpenAI e catálogo com
   `supportedParameters`. Toca `src/shared/types.ts`,
   `src/core/providers/{http,compat,catalog,cost}.ts` e os testes de provider.
2. **Onda 2 (média)** — descriptor de thinking, parser de tool call por família
   e 4º breakpoint Anthropic. Toca `src/shared/reasoning.ts`,
   `src/core/providers/{tool-parse,anthropic}.ts`.
3. **Onda 3 (estrutural)** — contrato de stream com `tool-input-*`/`finish` e
   provider Responses. Toca `src/core/providers/types.ts` e o runner; exige
   migração dos providers existentes.

## Licenças e limites

- LiteLLM: MIT, mas `enterprise/` tem licença separada; nada de `enterprise/`.
- Ollama, llama.cpp: MIT; o código é Go/C++ e não é portável, só as ideias e
  schemas.
- Vercel AI SDK e OpenRouter SDK: Apache-2.0; portar lógica com atribuição e sem
  copiar arquivos gerados (OpenRouter: quase tudo `DO NOT EDIT`).
- Este resumo e os cinco estudos são análise estática: nenhum clone foi
  instalado, buildado ou testado.
