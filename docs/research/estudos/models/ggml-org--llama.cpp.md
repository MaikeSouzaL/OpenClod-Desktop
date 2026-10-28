# llama.cpp

| Campo | Valor |
|---|---|
| Repositório | https://github.com/ggml-org/llama.cpp (`git remote get-url origin`) |
| Clone local | `repositorios/_research/models/ggml-org--llama.cpp` |
| Commit | `b3fa69955ea81c3b60e77e3c1e2224c4a826ffb9` |
| Licença | MIT (`LICENSE:1-2`) |
| Categoria | models / runtime local C++ + servidor compatível |
| Stack | C/C++17, ggml, CMake; servidor em `tools/server` (cpp-httplib); Jinja para chat template |
| Tamanho | 3.906 arquivos rastreados (1.155 `.cpp/.h`); 209,6 MiB; ≈350 mil linhas C/C++ (estimativa) |

## 1. O que é (verificado no código)

llama.cpp é o runtime de inferência (ggml) **e** um servidor HTTP completo em
`tools/server`. O binário `llama-server` carrega um GGUF, aplica o chat template
do modelo via Jinja, amostra tokens e expõe OpenAI Chat/Responses, Anthropic
Messages, embeddings, rerank, tokenize e um cliente MCP. O entrypoint do servidor
é `tools/server/server.cpp:170-217` (registro de rotas) e `:448-455` (router de
múltiplos modelos). O que ele resolve, além da inferência, é a **compatibilidade
de protocolo**: o mesmo processo atende `/v1/chat/completions`, `/v1/responses`,
`/v1/messages` e `/completion` (legado). Não há catálogo remoto nem custo: o
"catálogo" é o modelo carregado e seus aliases (`server-models.cpp:2310-2327`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `llama-server -m model.gguf` | `common/arg.cpp:3057` | sobe a API e o modelo |
| `--jinja` | `common/arg.cpp:3720` | habilita chat template Jinja e tools |
| `--reasoning-format FORMAT` | `common/arg.cpp:3728` | `none/auto/deepseek/deepseek-legacy` |
| `--reasoning-budget N` | `common/arg.cpp:3769` | limite de tokens de raciocínio |
| `-c/--ctx-size N` | `common/arg.cpp:1650-1658` | contexto (0 = do modelo) |
| `-n/--predict N` | `common/arg.cpp:1669-1677` | máximo de tokens gerados |
| `--cache-ram N` | `server-context.cpp:1577-1588` | cache de prompt em RAM (0 desliga) |
| `POST /v1/chat/completions` | `server.cpp:182` | OpenAI Chat |
| `POST /v1/responses` | `server.cpp:184-185` | OpenAI Responses |
| `POST /v1/messages` | `server.cpp:190` | Anthropic Messages |
| `GET /props` | `server.cpp:174`; `server-context.cpp:5756` | metadados do modelo/contexto |
| `GET /slots` | `server.cpp:213` | estado dos slots e cache |
| `POST /tokenize` / `/detokenize` | `server.cpp:200-201` | tokenização exata |
| `POST /apply-template` | `server.cpp:202` | renderiza o template sem inferir |
| `POST /v1/embeddings` | `server.cpp:194` | embeddings |
| `POST /models/load` / `unload` | `server.cpp:491-492` | router multi-modelo |
| `ctest` / `tests/` | `tests/`, `tools/server/tests/` | suíte C++ (não executada) |

## 3. Arquitetura e fluxo

```
llama-server → server_http_context (rotas + API key)
  → server_models (1..N modelos, aliases, presets)
  → server_context (slots, prompt cache, batch)
  → common_chat_templates (Jinja + parser PEG)
  → llama_context (ggml) → SSE (OpenAI/Responses/Anthropic)
```

- Entry point: `tools/server/server.cpp:170-217`.
- Loop de inferência: `tools/server/server-context.cpp` (slots, `update_slots`).
- Execução de ferramenta: não há; o modelo emite `tool_calls`, o cliente executa.
- Streaming: `server-context.cpp:5356,5398` (`text/event-stream`, `data: [DONE]`).
- Persistência: slots em memória e save/load opcional (`server.cpp:212-214`).

O servidor tem dois modos: single-model (carrega um GGUF) e router
(`server-model` + `models_routes`, `server.cpp:448-494`), que baixa/carrega
múltiplos modelos e faz proxy das mesmas rotas para o filho escolhido. O
`/props` continua disponível durante o sleep porque usa um cache de propriedades
(`server-context.cpp:5756-5765`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Chat template Jinja | `common/chat.cpp:306-330`; `common/common.h:653` | renderiza mensagens/tools por modelo | médio |
| Auto-parser de tools | `common/chat-auto-parser.h:54-60` | gera gramática PEG a partir do template | alto |
| Tool calls no JSON | `common/chat.cpp:211-229` | serializa `tool_calls` no formato OpenAI | baixo |
| Reasoning format | `common/common.h:427-432,664` | separa `reasoning_content` por tags | baixo |
| Reasoning budget | `common/reasoning-budget.cpp:52-90` | força o fechamento do bloco | médio |
| Prompt cache | `server-context.cpp:1577-1588,3993-3995` | reusa prefixo entre requisições | baixo |
| Usage/cached tokens | `server-task.cpp:357-364` | `prompt_tokens_details.cached_tokens` | baixo |
| Anthropic Messages | `server-task.cpp:734-800` | blocos `thinking`/`text`/`tool_use` | médio |
| Anthropic thinking | `server-task.cpp:750-756,921` | bloco + `signature_delta` | médio |
| OpenAI Responses | `server-task.cpp:520-591` | output items e stream | médio |
| MCP client | `server-mcp.cpp:255-330` | initialize, `tools/list`, `tools/call` | alto |
| Router multi-modelo | `server-models.cpp:585-630`; `server.cpp:491-494` | aliases, load/unload | médio |
| Tokenize exato | `server.cpp:200-201` | conta tokens sem inferir | baixo |
| GCP AIP predict | `server-http.cpp:865-918` | compat Vertex `instances` | médio |

## 5. Loop do agente, contexto e streaming

Não existe loop de agente. O ciclo é: o cliente manda mensagens; o servidor
renderiza o template, tokeniza, avalia o prefixo, amostra e devolve deltas. O
"agente" é externo. O que o llama.cpp faz muito bem é **adaptar o modelo ao
protocolo**: o `common_chat_templates` escolhe o template embutido ou o `--jinja`
(`common/common.h:651-653`), e o auto-parser constrói uma gramática PEG a partir
do template para extrair tool calls (`common/chat-auto-parser.h:48-60`). O
`reasoning_format` decide se o thinking vai para `reasoning_content` ou fica no
content (`common/common.h:427-432`), e o `reasoning_budget` conta tokens dentro do
bloco e força o fechamento quando estoura (`common/reasoning-budget.cpp:52-90`).

Contexto: `-c` aceita 0 para usar o `n_ctx_train` do GGUF
(`common/arg.cpp:1650-1658`); o servidor reporta `n_ctx_train` em
`/props`/`/v1/models` (`server-context.cpp:5505`; `server-models.cpp:2325-2326`).
Se o pedido passa do contexto, o slot divide em batches ou devolve
`ERROR_TYPE_EXCEED_CONTEXT_SIZE` (`server-context.cpp:3960-3976`). O stream é SSE
com `[DONE]` (`server-context.cpp:5356,5398`), e o usage final inclui
`cached_tokens` (`server-task.cpp:357-364`). Não há retry nem fallback: uma falha
fecha a requisição; o cliente decide repetir.

## 6. Sessões, estado e persistência

Estado de conversa é do cliente. O servidor mantém slots (uma conversa em voo por
slot) e o cache de prompt; `GET /slots` expõe `n_ctx`, tokens, `n_prompt_tokens_cache`
e parâmetros (`server-context.cpp:797-820`). Slots podem ser salvos/carregados
(`server.cpp:212-214`), o que permite reutilizar KV cache entre processos. O cache
de prompt em RAM é configurável por `--cache-ram` (`server-context.cpp:1577-1588`)
e a reutilização compara o prefixo comum (`:3993-3995`). Não há banco, sessão
nomeada, fork ou checkpoint de mensagens.

## 7. Configuração e extensibilidade

- CLI/flags: `common/arg.cpp` (centenas de opções), com variáveis `LLAMA_ARG_*`.
- Presets: `common/preset.cpp` e `server-models.cpp:2299-2303` (INI por modelo).
- Template: embutido no GGUF ou `--chat-template` (`common/arg.cpp:3799`);
  `--jinja` habilita template
  arbitrário. Sem `--jinja`, tools e `tool_choice` falham
  (`server-common.cpp:1359-1364`).
- Gramática/JSON schema: `common/json-schema-to-grammar.cpp` e
  `server-schema.cpp:47,89-116`.
- MCP: `server-mcp.cpp` inicia processo filho, faz `initialize` e `tools/list`
  (`:255-330`); é a única extensão de ferramenta do servidor.
- Roteamento: `POST /models/load`/`unload` e aliases (`server-models.cpp:585-630`).
- Não há plugins JS/Python; a extensão é binária (novo parser/gramática) ou MCP.

> Gemini: não encontrado endpoint `generateContent`/`v1beta`; o único compat
> Google é o AIP `predict` (`server-http.cpp:865-918`).

## 8. Permissões, sandbox e erros

A API key é opcional: middleware valida `Authorization: Bearer` ou `X-Api-Key`
apenas se `--api-key` foi configurado (`server-http.cpp:261-285`;
`common/arg.cpp:3541`). `/health` e
`/v1/health` são públicos (`:252-258`). CORS é configurável (`common/common.h:656-659`).
Não há sandbox de ferramenta: o modelo só devolve JSON; MCP executa um processo
filho com ambiente controlado (`server-mcp.cpp:405-452`). Erros de contexto têm
tipo próprio e status 400/413 (`server-context.cpp:3960-3976`); erros de parsing
de tool call são reportados como erro de requisição. **Não encontrado**: retry,
`Retry-After`, fallback de modelo ou rate limit no servidor.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Server unit | `tools/server/tests/unit/` (41 arquivos) | rotas, schema, streaming, tools |
| Server fixtures | `tools/server/tests/fixtures/` | payloads OpenAI/Anthropic/Responses |
| Chat parser | `tests/peg-parser/` | PEG, JSON, python-dict, unicode |
| Contexto/KV | `tests/llama-context/` | cache, RS, log |
| Núcleo ggml | `tests/test-*.cpp` (67 arquivos) | backend, batch, sampler, gramática |
| CI | `.github/workflows/` | builds por backend |

A suíte é forte em parsing e incompatibilidades de template; é fraca em contrato
HTTP de alto nível (poucos testes de integração completos).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Auto-parser de tool call | `common/chat-auto-parser.h:48-60`; `common/chat.cpp:211-229` | infere o formato a partir do template, não de regex fixa | MIT | `src/core/providers/tool-parse.ts` | 24 |
| Reasoning format/budget | `common/common.h:427-432`; `common/reasoning-budget.cpp:52-90` | trata thinking como canal com orçamento | MIT | `src/core/providers/reasoning.ts` | 20 |
| Prompt cache + cached_tokens | `server-context.cpp:3993-3995`; `server-task.cpp:357-364` | reuso real de prefixo com métrica | MIT | `src/core/providers/cache.ts` | 20 |
| `/props` e contexto do modelo | `server-context.cpp:5505,5756`; `server-models.cpp:2325-2326` | contexto treinado vs. efetivo | MIT | `src/core/providers/discovery.ts` | 18 |
| Anthropic Messages + thinking | `server-task.cpp:734-800,921` | bloco `thinking` com assinatura no stream | MIT | `src/core/providers/anthropic.ts` | 17 |
| OpenAI Responses | `server-task.cpp:520-591`; `server-chat.cpp:6` | output items completos | MIT | `src/core/providers/responses.ts` | 16 |
| MCP client embutido | `server-mcp.cpp:255-330` | ciclo initialize/list/call testado | MIT | `src/core/mcp/` | 15 |
| Tokenize/apply-template | `server.cpp:200-202` | conta tokens e valida template sem inferir | MIT | `src/core/providers/discovery.ts` | 14 |
| Router load/unload | `server-models.cpp:585-630`; `server.cpp:491-494` | múltiplos GGUF no mesmo processo | MIT | `src/core/providers/local.ts` | 11 |
| GCP AIP predict | `server-http.cpp:865-918` | compat Vertex `instances` | MIT | `src/core/providers/compat.ts` | 8 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Núcleo ggml/C++ | stack incompatível com Electron/TS |
| Auto-parser PEG completo | 48 KB de C++; portar só a ideia e uma tabela de famílias |
| Router que baixa modelos | escopo de runtime, não de app |
| Servidor de UI embutido | já temos renderer |
| `--jinja`/gramática nativa | dependência de llama.cpp; usar template textual |
| MCP com processo filho | nosso MCP já é cliente remoto |
| GCP AIP | nicho Vertex, pouco uso |
| 67 testes de backend | não portáveis |

## 12. Modelo de exemplo para o nosso harness

1. **Perfil do modelo local** — `LocalModelProfile` com `contextTrain`,
   `contextEffective`, `templateFamily`, `toolParser`, `reasoningFormat`,
   `supportsThinking`. Fonte: `/props`, `/v1/models`, GGUF metadata
   (`server-context.cpp:5505`; `server-models.cpp:2325-2326`).
2. **Parser de tools** — manter o `parseArgs` tolerante
   (`src/core/providers/openai.ts:268-289`) e adicionar um mapa
   `family -> parser` inspirado em `model/parsers/` do Ollama e no auto-parser do
   llama.cpp; para o nosso caso, `qwen`, `deepseek`, `glm`, `harmony`.
3. **Reasoning** — modelar `reasoningFormat`
   (`none/auto/deepseek/deepseek-legacy`) e `reasoningBudget` no `ModelCompat`
   (`src/shared/types.ts:425-436`); o `reasoning.ts` atual só cobre
   OpenAI/Anthropic.
4. **Cache** — reportar `cachedInput` quando o servidor devolver
   `prompt_tokens_details.cached_tokens`; já existe campo em `Usage`
   (`src/shared/types.ts:101-106`).
5. **Contexto** — nunca confiar no `contextWindow` do preset para modelo local;
   perguntar ao servidor e limitar o `maxOutputTokens` por
   `contextEffective - promptTokens`.
6. **Teste** — fixtures de `/props`, `/v1/models`, stream com `reasoning_content`
   e stream Anthropic com `signature_delta`.

## 13. Evidências da análise

```text
git -C repositorios/_research/models/ggml-org--llama.cpp rev-parse HEAD
  b3fa69955ea81c3b60e77e3c1e2224c4a826ffb9
git ls-files: 3906 arquivos; 1155 .cpp/.h
LICENSE:1-2              MIT
tools/server/server.cpp:170-217    rotas
tools/server/server.cpp:448-494    router multi-modelo
tools/server/server.cpp:182-190    OpenAI/Responses/Anthropic
tools/server/server-context.cpp:1577-1588,3993-3995,5356,5398,5505,5756
tools/server/server-models.cpp:2310-2327,2325-2326
tools/server/server-task.cpp:357-364,520-591,734-800,921
tools/server/server-chat.cpp:6,348
tools/server/server-common.cpp:1359-1364,1435-1501
tools/server/server-http.cpp:261-285,865-918
tools/server/server-mcp.cpp:255-330
common/chat.cpp:211-229,306-330
common/chat-auto-parser.h:48-60
common/common.h:427-432,651-664
common/reasoning-budget.cpp:52-90
common/arg.cpp:1650-1658,3720,3728,3769
tests/ (67 .cpp), tools/server/tests/ (41 arquivos)
```
