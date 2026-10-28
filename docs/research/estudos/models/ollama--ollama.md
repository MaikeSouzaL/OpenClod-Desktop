# Ollama

| Campo | Valor |
|---|---|
| Repositório | https://github.com/ollama/ollama (`git remote get-url origin`) |
| Clone local | `repositorios/_research/models/ollama--ollama` |
| Commit | `d44c2581904a98430e348d89cc2af1529b1808a0` |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | models / runtime local + servidor compatível com OpenAI e Anthropic |
| Stack | Go 1.26 (`go.mod:3`), Gin, cobra, llama.cpp embutido, MLX no macOS |
| Tamanho | 1.513 arquivos rastreados (965 `.go`); 74 MiB; ≈190 mil linhas Go (estimativa) |

## 1. O que é (verificado no código)

Ollama é um runtime local de modelos com um servidor HTTP que fala quatro
dialetos: a API nativa (`/api/chat`, `/api/generate`, `/api/show`), OpenAI
(`/v1/chat/completions`, `/v1/responses`), Anthropic (`/v1/messages`) e endpoints
auxiliares (`/api/embed`, `/v1/audio/*`). O entrypoint é `main.go:11-13`, que
chama `cmd.NewCLI()`; o servidor nasce em `cmd/cmd.go:2648-2654` (`ollama serve`).
O que ele resolve é o ciclo completo — baixar manifesto/blob, montar o template do
modelo, carregar pesos no runner, agendar VRAM e transmitir tokens. Não há
"provider" remoto no sentido de gateway: cada modelo é um arquivo local com
template, parser e opções próprias. A compatibilidade OpenAI/Anthropic é feita por
middleware que converte o corpo para `api.ChatRequest` antes de chegar ao mesmo
`ChatHandler` (`server/routes.go:2417,2422,2429`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `ollama serve` | `cmd/cmd.go:2648-2654` | sobe o servidor (porta 11434 por padrão) |
| `ollama run MODEL [PROMPT]` | `cmd/cmd.go:2604` | chat interativo/one-shot |
| `ollama create MODEL` | `cmd/cmd.go:2574` | cria modelo a partir de Modelfile |
| `ollama show MODEL` | `cmd/cmd.go:2589` | metadados, template, capabilities |
| `ollama pull/push` | `cmd/cmd.go:2656,2668` | registry de blobs |
| `ollama list` | `cmd/cmd.go:2712` | modelos locais |
| `ollama stop MODEL` | `cmd/cmd.go:2640` | descarrega o runner |
| `POST /api/chat` | `server/routes.go:2409` | chat nativo |
| `POST /api/generate` | `server/routes.go:2408` | completion nativo |
| `POST /api/show` | `server/routes.go:2386` | capabilities, template, `model_info` |
| `GET /api/tags` | `server/routes.go:2384-2385` | catálogo local |
| `GET /api/ps` | `server/routes.go:2407` | runners carregados, VRAM, contexto |
| `POST /v1/chat/completions` | `server/routes.go:2417` | OpenAI Chat Completions |
| `POST /v1/responses` | `server/routes.go:2422` | OpenAI Responses |
| `POST /v1/messages` | `server/routes.go:2429` | Anthropic Messages |
| `go test ./...` | `go.mod` | suíte Go (não executada nesta análise) |

Não há endpoint Gemini (`generateContent`/`v1beta`): busca em `server/routes.go`,
`openai/*.go` e `anthropic/*.go` não encontrou nada. O foco de compatibilidade é
OpenAI + Anthropic.

## 3. Arquitetura e fluxo

```
main.go → cmd.NewCLI() → server.Serve()
  → middleware OpenAI/Anthropic → api.ChatRequest
  → Model (template + parser + options)
  → scheduler (VRAM, keep_alive) → llama-server/MLX
  → stream NDJSON (nativo) / SSE (OpenAI, Anthropic)
  → openai.ToStreamChunks / anthropic events
```

- Entry point: `main.go:11-13`.
- Loop de requisição: `server/routes.go:2999` (`ChatHandler`).
- Execução de ferramenta: `tools/tools.go:41-54,128-167` (parser do texto do modelo).
- Streaming: `openai/openai.go:356-420`; Anthropic em `anthropic/anthropic.go:272`.
- Persistência: manifestos/blobs em `manifest/` e downloads em
  `server/images.go:1634`; o estado do runner é em memória (`server/sched.go`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Catálogo de modelos | `server/routes.go:2134` (`ListHandler`), `api/types.go:891-893` | lista nome, tamanho, digest, details | baixo |
| Metadados/capabilities | `server/routes.go:1745,1935`; `api/types.go:806-828` | `completion`, `tools`, `vision`, `thinking`, `embedding`, `image`, `audio` | baixo |
| Opções de inferência | `api/types.go:574-602` | `temperature`, `top_p`, `num_ctx`, `num_predict`, `num_gpu` | baixo |
| Tool calling | `tools/tools.go:41-167`; `openai/openai.go:864-876` | parseia chamadas do texto e converte para OpenAI | médio |
| Thinking | `thinking/parser.go:8-57`; `server/model_thinking.go:63-95` | separa `thinking` de `content` por tags do template | baixo |
| Reasoning effort | `openai/openai.go:585-616` | `minimal/low/medium/high/xhigh/ultra/max/none` → nível do modelo | baixo |
| `/api/show` | `server/routes.go:1745-1960` | template, parser, `model_info`, thinking | baixo |
| `/api/ps` | `server/routes.go:2793-2842` | contexto real, VRAM, expiração | baixo |
| Embeddings | `server/routes.go:2410-2411` | `/api/embed`, `/api/embeddings` | baixo |
| Imagens no chat | `api/types.go:208`; `types/model/capability.go:9` | `images` + capability `vision` | médio |
| Áudio | `server/routes.go:2425-2426` | transcrição e fala | médio |

## 5. Loop do agente, contexto e streaming

Não há loop de agente: o servidor recebe **uma** requisição e transmite uma
resposta. O "loop" com ferramentas é do cliente; o que o Ollama faz é transformar
texto em `tool_calls` com um parser específico do modelo. O parser é uma máquina
de estados alimentada por chunks (`tools/tools.go:54-108`), que localiza a tag,
extrai nome e argumentos JSON e devolve `api.ToolCall` (`:128-167`). Em paralelo,
o parser de thinking separa o bloco de raciocínio do conteúdo
(`thinking/parser.go:8-57`), com estados para "procurando abertura", "comendo
espaço" e "dentro do thinking".

O contexto é decidido no carregamento: `opts.NumCtx` vem da requisição ou do
default do servidor (`server/routes.go:141-142`); se não houver `num_ctx` no
request nem no Modelfile, o default é calculado por VRAM
(`server/routes.go:202-211,2556-2566`) — 262.144 tokens acima de
47 GiB, 32.768 acima de 23 GiB, 4.096 no resto. O
contexto do runner limita o pedido (`server/routes.go:2898-2900`). O stream
OpenAI divide um chunk misto em dois: um só de `reasoning` e outro de
`content`/`tool_calls` (`openai/openai.go:399-420`); o `finish_reason` só vira
`tool_calls` se o modelo terminar em `stop` e houve tool call (`:424-431`).

## 6. Sessões, estado e persistência

O Ollama não tem sessão de conversa: cada `/api/chat` envia o histórico completo.
O estado durável é o modelo (manifesto + blobs + Modelfile) em `manifest/` e
`server/images.go:1634`; o estado quente é o runner no scheduler, com `keep_alive`
(`server/sched.go:555-557`) e descarga por timer (`:431-444`). `GET /api/ps`
expõe o que está carregado e com qual `context_length`
(`server/routes.go:2823-2838`). Não há fork, checkpoint ou retomada de conversa.

## 7. Configuração e extensibilidade

- Variáveis de ambiente: `envconfig` (`envconfig/`), por exemplo `OLLAMA_HOST`,
  `OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE`; o scheduler lê
  `envconfig.NumParallel()` e `envconfig.KeepAlive()` (`server/sched.go:540,555`).
- Modelfile: `FROM`, `PARAMETER`, `TEMPLATE`, `SYSTEM`, `MESSAGE`, `RENDERER`,
  `PARSER`; o parser/template escolhido fica em `m.Config.Parser` e
  `resolveRendererName` (`server/routes.go:1942-1944`); a leitura do Modelfile
  está em `parser/parser.go:58-178`.
- Parsers por família: registro em `model/parsers/parsers.go:49-80` (qwen3,
  qwen3-coder, deepseek3, glm46, gemma4, harmony, etc.).
- Renderers: `model/renderers/` e `thinking/template.go:1`.
- Não há plugins de terceiros; a extensão é criar um modelo com template/parser
  próprio ou usar a API compatível.

## 8. Permissões, sandbox e erros

Não há sandbox de ferramenta: o modelo só devolve JSON; quem executa é o cliente.
O servidor local **não tem API key**: a proteção é o bind padrão em
`127.0.0.1:11434` (`envconfig/config.go:20-22`) e o middleware de hosts
(`server/routes.go:2293,2368`). `server/auth.go:53-73` é o
challenge do registry, não autenticação de cliente. CORS é configurável em
`server/routes.go:2337-2367`. A validação de `think` é feita contra o descriptor
do modelo e, quando inválida, devolve os valores aceitos
(`server/model_thinking.go:14-48`). Erros de contexto
viram `context length` com status 400/413 (`server/routes.go:1259-1328`). O
proxy de nuvem preserva status e headers do upstream
(`server/cloud_proxy.go:227-228`); o `Retry-After` só aparece em testes desse
proxy, não no caminho de inferência local — ou seja, **não há retry nem
Retry-After no servidor de inferência**.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Rotas | `server/routes_test.go` (73 KB) | chat, generate, show, list, erros |
| Scheduler | `server/sched_test.go` (75 KB) | VRAM, keep-alive, paralelismo, descarga |
| OpenAI | `openai/openai_test.go` (37 KB) | conversão e streaming |
| Responses | `openai/responses_test.go` (115 KB) | input items, tools, reasoning |
| Anthropic | `anthropic/anthropic_test.go` (58 KB) | blocos, thinking, tool_use |
| Parser de tools | `tools/tools_test.go`, `parser/parser_test.go` | tags, argumentos, streaming |
| Thinking | `server/model_thinking_test.go` (17 KB) | descriptors e níveis |
| Volume | 430 arquivos `*_test.go` | boa cobertura de compatibilidade |

Os testes de contrato OpenAI/Anthropic são a melhor parte para estudar: mostram
exatamente quais campos o mercado espera.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Descoberta por capabilities | `server/routes.go:1745-1960`; `api/types.go:806-828` | diz o que o modelo faz, não só o nome | MIT | `src/core/providers/discovery.ts` | 24 |
| Descriptor de thinking | `types/model/thinking.go:11-95`; `server/model_thinking.go:63-95` | níveis são dados do modelo, não regex | MIT | `src/shared/reasoning.ts` | 22 |
| `reasoning_effort` → nível local | `openai/openai.go:585-616` | preserva nomes definidos pelo modelo | MIT | `src/core/providers/compat.ts` | 21 |
| Parser de tool call por família | `tools/tools.go:41-167`; `model/parsers/parsers.go:49-80` | cobre modelos que não emitem JSON puro | MIT | `src/core/providers/parse.ts` | 20 |
| Contexto por VRAM | `server/routes.go:2556-2566` | default defensável para modelo local | MIT | `src/core/providers/discovery.ts` | 18 |
| `/api/ps` e contexto real | `server/routes.go:2793-2842` | mostra o contexto efetivo, não o teórico | MIT | `src/core/providers/discovery.ts` | 17 |
| Usage com cached tokens | `openai/openai.go:264-274` | `prompt_tokens_details.cached_tokens` já pronto | MIT | `src/core/providers/openai.ts` | 16 |
| Split reasoning/content no stream | `openai/openai.go:399-420` | evita misturar canais no SSE | MIT | `src/core/providers/stream.ts` | 15 |
| Prompt cache do runner | `llm/llama_server.go:1691,1863` | reusa prefixo e reporta `cache_n` | MIT | `src/core/providers/cache.ts` | 14 |
| Compat Anthropic Messages | `anthropic/anthropic.go:323-425` | thinking + tool_use no mesmo handler | MIT | `src/core/providers/anthropic.ts` | 13 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Runtime/llama.cpp embutido | stack C++/Go, incompatível com Electron/TS |
| Scheduler de VRAM e download de blobs | escopo de runtime, não de cliente |
| Registry/autenticação ollama.com | serviço externo |
| Endpoint Gemini | não existe no clone (não encontrado) |
| 430 testes Go | não portáveis; usar como especificação |
| Parsers de todas as famílias | manutenção alta; começar por qwen/deepseek/glm |
| `SystemOne` e decisões | produto separado, não é chat |
| UI/TUI (`cmd/tui`) | já temos renderer React |

## 12. Modelo de exemplo para o nosso harness

1. **Descoberta** — manter `discoverOllama` (`src/core/providers/discovery.ts:244-280`)
   e acrescentar: ler `capabilities` como fonte primária, `thinking` (values/default)
   e `model_info.*.context_length`; usar `num_ctx` do Modelfile quando existir
   (já feito em `:238-242`).
2. **Compat** — criar `ModelTraits` com `supportsThinking`, `thinkingValues`,
   `thinkingDefault`, `supportsTools`, `supportsVision`, `contextWindow`. Fonte:
   `api/types.go:806-828` e `types/model/thinking.go:11-50`.
3. **Effort** — traduzir o nosso `ReasoningEffort` (`src/shared/types.ts:73`) para
   o valor que o modelo anuncia; se o modelo só aceita boolean, enviar `true`;
   `none` → `false`. Referência: `openai/openai.go:585-616`.
4. **Parser** — adicionar uma etapa `parseToolCalls(text, family)` no provider
   OpenAI-compatible, com fallback para o `parseArgs` atual
   (`src/core/providers/openai.ts:268-289`), para modelos que emitem
   `<tool_call>...</tool_call>`.
5. **Métricas** — mapear `prompt_eval_count`, `eval_count`,
   `prompt_eval_cached_count` para `Usage` (`src/shared/types.ts:101-106`).
6. **Teste** — fixtures de `/api/tags`, `/api/show` (com e sem capabilities) e
   streams com thinking + tool call no mesmo chunk.

## 13. Evidências da análise

```text
git -C repositorios/_research/models/ollama--ollama rev-parse HEAD
  d44c2581904a98430e348d89cc2af1529b1808a0
git ls-files: 1513 arquivos; 965 .go
go.mod:3                 go 1.26.10
LICENSE:1-3              MIT
main.go:11-13            main → cmd.NewCLI()
cmd/cmd.go:2546-2712     comandos cobra
server/routes.go:2372-2429  rotas nativas, OpenAI, Responses, Anthropic
server/routes.go:2999    ChatHandler
server/routes.go:1745,1935  ShowHandler e capabilities
server/routes.go:2556-2566  default de contexto por VRAM
server/routes.go:2823-2838  /api/ps com context_length
api/types.go:574-602     Options de inferência
api/types.go:806-828     ShowResponse
types/model/capability.go:3-16
types/model/thinking.go:11-95
openai/openai.go:264-274,356-431,585-616,620-814,864-876
openai/responses.go:589-640
anthropic/anthropic.go:323-425
tools/tools.go:41-167
thinking/parser.go:8-57
model/parsers/parsers.go:12-80
server/model_thinking.go:14-48,63-95
server/sched.go:540-557
llm/llama_server.go:1691,1863
server/cloud_proxy.go:227-228
430 arquivos *_test.go
```
