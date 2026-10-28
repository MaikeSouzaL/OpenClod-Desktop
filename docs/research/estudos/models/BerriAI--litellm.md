# LiteLLM

| Campo | Valor |
|---|---|
| Repositório | https://github.com/BerriAI/litellm (`git remote get-url origin`) |
| Clone local | `repositorios/_research/models/BerriAI--litellm` |
| Commit | `dddbaa803d6e9fcc862ea7a5412f771cb1ae040e` |
| Licença | MIT fora de `enterprise/` (`LICENSE:1-4`); `enterprise/` tem licença própria |
| Categoria | models / gateway e normalização de provedores |
| Stack | Python ≥3.10 <3.15 (`pyproject.toml:6`), FastAPI, httpx, pydantic, Rust auxiliar em `litellm-rust/` |
| Tamanho | 14.687 arquivos rastreados (8.430 `.py`); 299,9 MiB; núcleo em `litellm/` (≈1,3 mi linhas, estimativa) |

## 1. O que é (verificado no código)

LiteLLM é uma camada de tradução: recebe a forma OpenAI Chat Completions e a
converte para 152 diretórios de provedor em `litellm/llms/` (contagem de
diretórios),
devolvendo sempre `ModelResponse`/`ModelResponseStream`. O entrypoint de biblioteca é
`litellm.completion` (`litellm/main.py:5348`) e `litellm.acompletion`
(`litellm/main.py:454`); o entrypoint de servidor é o FastAPI de
`litellm/proxy/proxy_server.py:1980`. O produto real são três coisas: resolução de
provedor por prefixo/modelo (`get_llm_provider`), catálogo de preços/contexto
(`model_prices_and_context_window_backup.json`) e o `Router` com retry, cooldown e
fallback (`litellm/router.py:1165`). Não é um harness de agente: `tool_loop.py` é
apenas um helper opcional que exige resposta inteira, sem streaming
(`litellm/tool_loop.py:1,35-39`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `litellm` | `pyproject.toml:195` | sobe o proxy (`litellm:run_server`) |
| `lite` | `pyproject.toml:196` | CLI (`litellm_cli.main:cli`) |
| `litellm-proxy` | `pyproject.toml:197` | CLI do proxy |
| `completion(model=..., messages=...)` | `litellm/main.py:5348` | chamada síncrona normalizada |
| `acompletion(...)` | `litellm/main.py:454` | chamada assíncrona/streaming |
| `Router(model_list=..., fallbacks=[...])` | `litellm/router.py:1165,1214` | roteamento entre deployments |
| `POST /v1/chat/completions` | `litellm/proxy/proxy_server.py:1980` | superfície OpenAI do proxy |
| `POST /v1/responses` | `litellm/responses/dispatch.py:130-146` | superfície OpenAI Responses |
| `GET /health`, `/models` | `litellm/proxy/health_endpoints/_health_endpoints.py:1229`; `litellm/proxy/proxy_server.py:12261-12264` | saúde e catálogo do proxy |
| `CONFIG_FILE_PATH=config.yaml` | `litellm/proxy/proxy_server.py:1493-1502` | configuração do proxy |

A superfície é enorme: 152 provedores, endpoints OpenAI (`/chat/completions`,
`/responses`, `/embeddings`, `/images`, `/audio`, `/batches`, `/vector_stores`),
Anthropic pass-through (`litellm/llms/anthropic/pass_through/`) e um servidor de
administração. Para o nosso caso, interessam as peças de normalização, não o proxy.

## 3. Arquitetura e fluxo

```
completion() → get_llm_provider() → ProviderConfig.transform_request()
            → HTTP (httpx) → StreamingHandler/ModelResponse
            → cost_calculator → callbacks/logging
Router.completion() → retry/cooldown → fallback → completion()
```

- Entry point: `litellm/main.py:5348` (sync) e `litellm/main.py:454` (async).
- Resolução de provedor: `litellm/litellm_core_utils/get_llm_provider_logic.py:173`.
- Loop de ferramentas: não existe no core; helper em `litellm/tool_loop.py:35-39`.
- Streaming: `litellm/litellm_core_utils/streaming_handler.py:305,2219`.
- Persistência: o core é stateless; o proxy usa DB/Redis opcionais
  (`litellm/proxy/proxy_server.py:1493-1502`).

`get_llm_provider` tem uma ordem explícita: prefixo declarado no modelo
(`provider/model`) vence (`get_llm_provider_logic.py:251-273`); depois tenta
provedores JSON registrados (`:238-247`) e, por fim, casa o `api_base` contra uma
lista de endpoints conhecidos (`:275-335`). O casamento de host é feito por URL
parseada, não por substring, justamente para não vazar chave de ambiente para um
host atacante (`get_llm_provider_logic.py:24-57`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Resolução de provedor | `get_llm_provider_logic.py:173-335` | modelo/api_base → provider, key, base | baixo |
| Lista de parâmetros suportados | `get_supported_openai_params.py:10-63` | consulta o `ProviderConfig` do provedor | baixo |
| Catálogo de modelos e preços | `litellm/model_prices_and_context_window_backup.json:2-41` | contexto, custo, flags de capacidade | baixo |
| Cálculo de custo | `cost_calculator.py:411-490` | tokens → USD, com cache | baixo |
| Token counter | `token_counter.py:417` | tiktoken + heurísticas por família | médio |
| Router com fallback | `router.py:1165-1216` | tenta deployment seguinte | médio |
| Retry policy | `router_utils/get_retry_from_policy.py:19-66` | retries por tipo de exceção | baixo |
| Cache de resposta | `caching/caching_handler.py:1-15` | Redis/S3/Disco/semântico | médio |
| Prompt cache Anthropic | `llms/anthropic/prompt_cache_prediction.py:258-341` | planeja breakpoints e mede prefixo | médio |
| Responses API | `litellm/responses/dispatch.py:130-146` | traduz Responses ↔ Chat | médio |
| Gemini (AI Studio/Vertex) | `litellm/llms/gemini/chat/transformation.py:84-112` | params, thinking e `reasoning_effort` | médio |
| Anthropic Messages | `litellm/llms/anthropic/chat/transformation.py:731-765,1094-1107,1561-1601` | tools, thinking, cache_control | médio |
| Proxy multi-tenant | `litellm/proxy/proxy_server.py:12261-12264` | lista de modelos com auth; admin/budgets no proxy | alto |

## 5. Loop do agente, contexto e streaming

LiteLLM não monta prompt de agente. O que ele oferece é o **streaming
normalizado**: `StreamingHandler.__init__` guarda `thinking_content`, primeiro e
último chunks (`streaming_handler.py:305-340`); `__anext__` consome o SSE do
provedor (`:2219`) e `_build_complete_streaming_response` remonta a resposta final
(`:1985`). Quando o provedor devolve reasoning em campo separado, o handler pode
fundir em `<think>...</think>` no content se
`merge_reasoning_content_in_choices=True` (`:1286-1309`).

O helper de tool loop recusa `stream=True` (`tool_loop.py:35-39`), então não há
loop agêntico com tools streamadas. Contexto é responsabilidade do chamador: o
LiteLLM só informa `max_input_tokens`/`max_output_tokens` via `get_model_info`
(`utils.py:7081`) e conta tokens (`token_counter.py:417`). No proxy, retry e
fallback ficam no `Router`, não no `completion`; a biblioteca também expõe
`completion_with_retries` (`litellm/main.py:6414`). O sleep usa
`calculate_retry_after` (`utils.py:7901-7924`), que honra `Retry-After` só até
60 s e aplica jitter;
`_time_to_sleep_before_retry` zera a espera quando há deployment saudável na
mesma família (`router.py:9234-9277`).

## 6. Sessões, estado e persistência

O núcleo é stateless. O estado do `Router` é em memória: lista de deployments,
`retry_policy` (`router.py:1630`), cooldowns (`router.py:1226-1229`) e contadores
de falha. O cache de resposta é plugável (`litellm/caching/caching_handler.py:12`:
Redis, S3, GCS, disco, Qdrant, semântico). O proxy pode carregar config YAML
(`proxy_server.py:1493-1502`) e usar banco, mas isso é opcional e não faz parte do
contrato da biblioteca. Não há sessão de conversa, fork ou checkpoint — quem
guarda mensagens é o chamador.

## 7. Configuração e extensibilidade

- Precedência: `litellm_params` explícitos > prefixo do modelo > `api_base`
  conhecido (`get_llm_provider_logic.py:201-335`).
- Config do provedor: classes `BaseConfig` em
  `litellm/llms/base_llm/chat/transformation.py:91`, implementadas por
  `litellm/llms/*/chat/transformation.py`.
- Preços: catálogo remoto com fallback local
  (`litellm_core_utils/get_model_cost_map.py:1-5,81-90`); `LITELLM_LOCAL_MODEL_COST_MAP=True`
  força o bundle.
- Extensões: `CustomLogger` (`litellm/integrations/custom_logger.py:66`), hooks de
  prompt/cache (`integrations/anthropic_cache_control_hook.py:1-10`), guardrails,
  callbacks.
- Modelos novos: regras declarativas `fallback_generalizations` no JSON
  (`litellm_core_utils/fallback_generalizations.py:1-4,236-269`).
- O proxy adiciona `config.yaml`, virtual keys, budgets e admin — fora do escopo
  de um cliente desktop.

## 8. Permissões, sandbox e erros

Não há sandbox: LiteLLM só fala HTTP. A segurança relevante é (a) resolução de
credencial por host confiável (`get_llm_provider_logic.py:24-57`) e (b) não
repassar `api_key` para base URL arbitrária. Erros são classificados em exceções
(`litellm/exceptions.py:132`) e o retry é escolhido por classe:
`AuthenticationError`, `Timeout`, `RateLimitError`, `ContentPolicyViolationError`,
`BadRequestError`, `ServiceUnavailableError`, `InternalServerError`
(`router_utils/get_retry_from_policy.py:19-29`). O 404 tem tratamento próprio
(`:32-34`). `calculate_retry_after` respeita o header do provedor quando está entre
0 e 60 s e, fora disso, usa backoff exponencial com jitter (`utils.py:7901-7924`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Unit | `tests/unit/` | normalização, custos, router, caching |
| Integração | `tests/integration/` | chamadas reais/gravadas por provedor |
| E2E | `tests/e2e/`, `tests/e2e_harness/` | proxy e harness |
| Tipagem | `tests/typing/` | contratos pydantic |
| Rust | `tests/test_litellm_rust/` | bridge Rust |
| Volume | 3.916 arquivos `test_*.py` | maior suíte dos cinco clones |

A qualidade é desigual: o catálogo de modelos é gerado/validado por script, mas há
muitos caminhos específicos de provedor com pouca cobertura. Para portar, os testes
de `cost_calculator`, `token_counter` e `retry_policy` são os mais valiosos.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Schema de catálogo + capacidades | `model_prices_and_context_window_backup.json:2-41` | um registro por modelo com contexto, custo, cache e flags | MIT | `src/core/providers/catalog.ts` | 21 |
| Custo com cache read/write | `cost_calculator.py:411-490` | normaliza OpenAI (`cached_tokens`) e Anthropic (`cache_read/creation`) | MIT | `src/core/providers/cost.ts` | 22 |
| Retry policy por exceção | `router_utils/get_retry_from_policy.py:19-66` | distingue auth, 429, 5xx, timeout e 404 | MIT | `src/core/providers/retry.ts` | 20 |
| Retry-After + jitter | `utils.py:7901-7924` | header só até 60 s, senão backoff | MIT | `src/core/providers/http.ts` | 18 |
| Matriz de params por provedor | `get_supported_openai_params.py:10-63` | evita mandar `temperature`/`max_tokens` inválidos | MIT | `src/core/providers/compat.ts` | 19 |
| Reasoning Anthropic ↔ esforço | `llms/anthropic/chat/transformation.py:1561-1601` | mapeia low..max para budget/adaptive | MIT | `src/shared/reasoning.ts` | 18 |
| Regras de generalização | `fallback_generalizations.py:236-269` | cobre modelo recém-lançado sem editar código | MIT | `src/core/providers/catalog.ts` | 17 |
| Planejador de prompt cache | `llms/anthropic/prompt_cache_prediction.py:258-341` | 4 breakpoints, não marca thinking | MIT | `src/core/providers/cache.ts` | 16 |
| Responses API bridge | `litellm/responses/main.py:255`; `responses/dispatch.py:130-146` | mapeia input/output items | MIT | `src/core/providers/responses.ts` | 15 |
| Streaming handler | `litellm_core_utils/streaming_handler.py:305,1985` | remonta resposta e funde reasoning | MIT | `src/core/providers/stream.ts` | 12 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `enterprise/` | licença separada, não é MIT |
| Proxy multi-tenant (virtual keys, budgets, admin UI) | escopo de servidor, não de app desktop |
| 152 providers | custo de manutenção; temos `openai` + `anthropic` + descoberta local |
| `litellm-rust/` | stack nova sem ganho para o nosso gargalo |
| Roteamento por menor custo/latência | depende de telemetria central que não temos |
| `tool_loop.py` | exige resposta inteira, sem streaming; nosso runner já faz o loop |
| Catálogo remoto em runtime | baixa confiabilidade offline; melhor bundle versionado |
| Logging/callbacks (Datadog, Langfuse etc.) | integrações externas, não necessárias |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem inventar API:

1. **`ModelCapabilities`** — derivar de um JSON bundled com os campos que já
   usamos (`contextWindow`, `supportsVision`, `supportsTools`, `supportsReasoning`,
   `maxOutputTokens`, `inputCostPerMTok`, `outputCostPerMTok`,
   `cacheReadCostPerMTok`, `cacheWriteCostPerMTok`) mais `omitTemperature` e
   `maxTokensField`. Fonte: `model_prices_and_context_window_backup.json:2-41`.
2. **`resolveCompat`** — manter o nosso `ModelCompat` (`src/shared/types.ts:425-436`)
   e acrescentar `supportsReasoning`/`maxOutputTokens` ao preset. A inferência atual
   por regex (`src/core/providers/compat.ts:11-19`) continua como fallback.
3. **Custo** — `addUsage` (`src/core/agent/runner.ts:264-275`) passa a cobrar
   `cachedInput` pela tarifa de leitura e a gravar `cacheWrite` quando o provedor
   reportar. O tipo `Usage` (`src/shared/types.ts:101-106`) ganha
   `cacheWriteInput` e `reasoningOutput`.
4. **Retry** — unificar `postStream` (`src/core/providers/http.ts:171-228`) com a
   tabela de erros do LiteLLM, mantendo o nosso `classifyProviderError`
   (`http.ts:12-23`) e o `retryAfterMs` (`http.ts:36-46`).
5. **Cache Anthropic** — já temos 3 breakpoints (tools, system, tail) em
   `src/core/providers/anthropic.ts:134-143`; adicionar o quarto (mensagem do
   usuário) e a regra de não marcar thinking (`anthropic.ts:140-142`).
6. **Teste** — casos de tabela para custo (OpenAI vs Anthropic), retry (429 com e
   sem header) e compat (`o4-mini` sem temperature, `gpt-4o` com).

## 13. Evidências da análise

```text
git -C repositorios/_research/models/BerriAI--litellm rev-parse HEAD
  dddbaa803d6e9fcc862ea7a5412f771cb1ae040e
git ls-files | wc: 14687 arquivos; 8430 .py
pyproject.toml:2-6      name/version/requires-python
pyproject.toml:194-197  scripts litellm, lite, litellm-proxy
LICENSE:1-4             MIT fora de enterprise/
litellm/main.py:454,5348
litellm/router.py:1165,1206-1216,1223,1630,9234-9277
litellm/litellm_core_utils/get_llm_provider_logic.py:24-57,173-335
litellm/litellm_core_utils/get_supported_openai_params.py:10-63
litellm/llms/anthropic/chat/transformation.py:731-765,1561-1601
litellm/llms/gemini/chat/transformation.py:84-112
litellm/cost_calculator.py:411-490,1508
litellm/litellm_core_utils/token_counter.py:310,417
litellm/model_prices_and_context_window_backup.json:2-41,3274-3315
litellm/litellm_core_utils/streaming_handler.py:305,1286-1309,1985,2219
litellm/router_utils/get_retry_from_policy.py:19-66
litellm/utils.py:7901-7924,7081
litellm/llms/anthropic/prompt_cache_prediction.py:258-341
litellm/tool_loop.py:1,35-39
tests: 3916 arquivos test_*.py
```
