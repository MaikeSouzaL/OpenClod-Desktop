# Pydantic AI (+ pydantic-graph)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/pydantic/pydantic-ai |
| Clone local | `repositorios/_research/orchestration/pydantic--pydantic-ai` |
| Commit | `4ee11516b5be6b767654304ec8fe346b81369597` |
| Licença | MIT (`LICENSE:1`; `pyproject.toml:23`) |
| Categoria | orchestration (agent framework + grafo tipado + execução durável) |
| Stack | Python >= 3.11 (`pyproject.toml:50`), uv workspace: `pydantic_ai_slim`, `pydantic_graph`, `pydantic_evals`, `clai`, `src/pydantic_ai_harness` |
| Tamanho | 5.096 arquivos; 2.118 `.py`; ~881 mil linhas Python; 797 arquivos `test_*.py` |

**Caminhos:** citações que começam em `agent/`, `toolsets/`, `durable_exec/`,
`capabilities/`, `_agent_graph.py`, `run.py`, `tool_manager.py`, `messages.py`,
`usage.py`, `exceptions.py` ou `_output.py` são relativas a
`pydantic_ai_slim/pydantic_ai/`; `basenode.py`, `node.py`, `graph_builder.py`,
`join.py` e `decision.py` são relativas a `pydantic_graph/pydantic_graph/`.

## 1. O que é (verificado no código)

Um framework de agentes cujo **loop é um grafo tipado**. `pydantic_graph` lê a
anotação de retorno de `BaseNode.run` em tempo de execução e usa isso para
decidir quais nós podem vir a seguir
(`pydantic_graph/pydantic_graph/basenode.py:35-48`). O agente, por sua vez, é
esse grafo: `UserPromptNode → ModelRequestNode → CallToolsNode → (repete)`
(`pydantic_ai_slim/pydantic_ai/_agent_graph.py:667`, `:1440`, `:2376`).

Para nós, o valor não é "mais um agent framework". É a combinação de três coisas
que ainda não temos:

1. **Loop inspecionável passo a passo**: `Agent.iter(...)` devolve um `AgentRun`
   com `next_node` (`run.py:271`) e `next()` (`:579`), então dá para parar entre
   "modelo respondeu" e "tool executou".
2. **Tipagem de borda real**: o grafo valida que o retorno de um nó é um dos
   tipos de destino permitidos, não uma string mágica.
3. **Camada de execução durável genérica**: `durable_exec/_base.py` (105 KB)
   transforma cada operação (request de modelo, chamada de tool, listagem de
   tools) em uma operação com identidade de cache e codec de resultado
   (`durable_exec/_operation.py:249`, `:256`, `:307`), com backends Temporal,
   DBOS e Prefect.

Divergência README × código: o README vende "Pydantic way"; o código é bem mais
amplo — há `capabilities/`, `workspaces/`, `realtime/`, `ui/` com adapter de
protocolo AG-UI (`pydantic_ai_slim/pydantic_ai/ui/_adapter.py`). É um framework
grande, não uma lib enxuta.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `make install` / `make test` / `make lint` | `Makefile`, `AGENTS.md` | uv, pytest, ruff, pyright |
| `uv run python -m pydantic_ai` | `pydantic_ai_slim/pydantic_ai/__main__.py:1` | CLI de chat |
| `clai` | `clai/` (pacote separado) | cliente de terminal com capabilities |
| `agent.run(prompt)` | `agent/__init__.py` | execução até o resultado final |
| `agent.run_stream(prompt)` | `agent/__init__.py` | stream de texto/eventos |
| `agent.iter(prompt, ...)` | `agent/__init__.py:1458` | `AgentRun` navegável passo a passo |
| `run.next_node()` / `await run.next()` | `run.py:271`, `:579` | avança exatamente um nó |
| `ModelMessagesTypeAdapter.dump_json` | `messages.py:4529` | serializa histórico de mensagens |
| `UsageLimits(request_limit=50, ...)` | `usage.py:505-533` | orçamento por run |

A superfície de UX é Python puro; não há slash commands no núcleo. O `clai`
(`clai/`) é quem oferece terminal, e `pydantic_ai_harness` (`src/`) é a
"biblioteca de capabilities" — o análogo mais próximo do nosso `src/core`.

## 3. Arquitetura e fluxo

```
Agent.run / .iter
  → AgentRun (pydantic_graph.GraphRun)
      → UserPromptNode        # monta instruções + histórico
      → ModelRequestNode      # chama o modelo (stream ou não)
      → CallToolsNode         # valida args, executa tools, processa saída
          → OutputSchema      # native | prompted | tool | text | image
          → volta para ModelRequestNode ou End
  → AgentRunResult(messages, usage, output)
```

- Entry point: `pydantic_ai_slim/pydantic_ai/agent/__init__.py:1458` (`iter`).
- Loop: `_agent_graph.py:608` (`AgentNode`), `:667` (`UserPromptNode`), `:1440`
  (`ModelRequestNode`), `:2376` (`CallToolsNode`).
- Execução de ferramenta: `_tool_execution.py` (76 KB) + `tool_manager.py:1011`
  (`execute_tool_call`).
- Validação de argumentos: `tool_manager.py:601` (`_validate_tool_args`) e
  hooks em `:645` (`_run_validate_hooks`).
- Streaming: `_agent_graph.py:1493` (`ModelRequestNode._stream`) e
  `:2457` (`CallToolsNode._run_stream`).
- Persistência: **não há checkpointer no grafo**. O que existe é (a)
  `ModelMessagesTypeAdapter` para o histórico e (b) a camada `durable_exec`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `FunctionToolset` | `toolsets/function.py` (43 KB) | gera schema a partir da assinatura e da docstring | médio |
| `ToolManager.execute_tool_call` | `tool_manager.py:1011` | resolve tool, valida, executa, aplica retry | alto |
| `ApprovalRequiredToolset` | `toolsets/approval_required.py:14` | exige aprovação por predicado (`ctx`, `tool_def`, `args`) | alto |
| `DeferredLoadingToolset` | `toolsets/deferred_loading.py:10` | esconde tools até serem "reveladas" | baixo |
| `_tool_search.py` | `toolsets/_tool_search.py` (26 KB) | busca de tools para catálogos grandes | baixo |
| `OutputValidator` | `_output.py:501` | valida saída e reexecuta com feedback | médio |
| `NativeOutputSchema` | `_output.py:828` | usa structured output nativo do provider | baixo |
| `ToolOutputSchema` | `_output.py:842` | força uma tool de saída (funciona em qualquer modelo) | baixo |
| `UsageLimits` | `usage.py:505` | limite de requests, tool calls e tokens | baixo |
| `GraphTask` / `GraphRun` | `pydantic_graph/graph_builder.py:406`, `:425` | unidade de trabalho e cursor de execução | baixo |
| `Fork` / `Join` / `Decision` | `pydantic_graph/node.py:66`, `join.py:32`, `decision.py:41` | paralelismo com redução e branch tipado | médio |
| `DurableOperation` | `durable_exec/_operation.py:307` | operação com identidade e resultado serializável | médio |

## 5. Loop do agente, contexto e streaming

O estado do loop é `GraphAgentState`
(`_agent_graph.py:380-428`): `message_history`, `usage`, `output_retries_used`,
`run_step`, `run_id` (UUID7), `conversation_id`, `pending_messages`. Tudo
serializável — é o que permite `run.next()` retomar de qualquer nó.

- **Chamada de tool**: `CallToolsNode` valida os argumentos **antes** de
  executar (`tool_manager.py:601`), roda hooks de validação e de execução
  (`:645`, `:725`) e só então chama. Um `ModelRetry` levantado pela tool vira
  mensagem de retry com contador por tool (`_check_max_retries`, `:519`).
- **Saída estruturada**: `OutputValidator` (`_output.py:501`) roda depois da
  resposta; `consume_output_retry` (`_agent_graph.py:451`) conta tentativas e
  injeta `RetryFeedbackPart` com `attempt`/`max_retries`, para o modelo saber
  que está na segunda tentativa.
- **Truncamento de tool call**: `check_incomplete_tool_call`
  (`_agent_graph.py:435`) detecta `finish_reason == "length"` com `ToolCallPart`
  incompleto e levanta `IncompleteToolCall` — erro explícito em vez de JSON
  quebrado chegando na tool.
- **Contexto**: `message_history` é a única fonte; compactação chega como
  `CompactionPart` na resposta do provedor (`_agent_graph.py:2569`) e é
  registrada como operação própria (`ModelCompactMessagesId` em
  `durable_exec/_operation.py:85`), não como mutação silenciosa do runner.
- **Streaming**: dois níveis — `ModelResponseStreamEvent` (token) e
  `AgentStreamEvent` (evento de agente), com buffer de eventos no estado
  (`_agent_graph.py:414-419`).
- **Cancelamento**: `CancellationToken` (`_run_context.py`) e
  `ModelCancelSuspendedResponseId` (`_operation.py:63`) para respostas
  suspensas.

## 6. Sessões, estado e persistência

Não existe `checkpointer` no `pydantic_graph` — procurado por
`class *Checkpoint`/`def *checkpoint` e **não encontrado** no pacote. A
persistência é responsabilidade do chamador:

- **Histórico**: `ModelMessagesTypeAdapter` (`messages.py:4529`) serializa a
  lista de `ModelMessage` com união discriminada. É o formato de fato para
  guardar conversa.
- **Handoff entre execuções**: `AgentRun` expõe `all_messages_json()` e
  `new_messages_json()` (`run.py:314`, `:329`), então o app decide o que
  persistir.
- **Execução durável**: `durable_exec/_operation.py` define IDs tipados por
  operação (`ModelRequestId:38`, `ToolsetGetToolsId:141`,
  `ToolsetCallToolId:184`, `ModelCompactMessagesId:85`), `CacheIdentity`
  (`:249`) e `ResultCodec` (`:256`). `JournalOperationNamer`
  (`_operation_names.py:46`) avisa que os nomes gerados **são dados de
  compatibilidade persistidos** e não podem mudar.
- Backends: `durable_exec/temporal/_agent.py` (84 KB),
  `durable_exec/dbos/_agent.py` (82 KB), `durable_exec/prefect/_agent.py`
  (78 KB). Todos reusam `_base.py`.
- `run_id`/`conversation_id` são UUID7 e a prioridade de resolução está
  documentada em `_agent_graph.py:388-399`.

## 7. Configuração e extensibilidade

- **Capabilities** (`capabilities/`): unidade de composição — instrumentação,
  seleção de modelo, enfileiramento de mensagens, `ProcessEventStream`.
  `durable_exec/_base.py:30-60` mostra o uso (`CombinedCapability`,
  `WrapperCapability`).
- **Toolsets compostos**: `combined.py`, `filtered.py`, `prefixed.py`,
  `renamed.py`, `prepared.py`, `set_metadata.py`, `include_return_schemas.py`.
  Tudo é `WrapperToolset`, não subclasse do núcleo — regra explícita em
  `pydantic_ai_slim/pydantic_ai/AGENTS.md`.
- **Workspaces** (`workspaces/`): isola arquivos/FS por run.
- **Modelos**: `models/` + `providers/` + `profiles/`; suporte nativo a
  OpenAI, Anthropic, Google, Bedrock, e um caminho `compat` para OpenAI-like.
- **`Agent.override(...)`** para testes; `agent_docs/` documenta as regras de
  design (não é config de runtime).
- Sem MCP nativo no núcleo? Tem: `mcp.py` (106 KB) e `toolsets/_tool_search.py`,
  além de `durable_exec/*/_mcp_toolset.py`.

## 8. Permissões, sandbox e erros

- **Aprovação** é um toolset wrapper: `ApprovalRequiredToolset.call_tool`
  levanta `ApprovalRequired` quando `not ctx.tool_call_approved` e o predicado
  retorna `True` (`toolsets/approval_required.py:20-24`). O runner captura,
  devolve `DeferredToolResults` e **retoma** — mesma ideia do interrupt do
  LangGraph, mas com a decisão expressa como resultado de tool.
- **Tool "deferida"**: `DeferredToolResults` + `_deferred.py` permitem pausar
  sem perder o resto do turno.
- **Erros tipados**: `ModelRetry` (`exceptions.py:73`), `ApprovalRequired`
  (`:184`), `ToolRetryError` (`:1067`), `UnexpectedModelBehavior` (`:504`),
  `IncompleteToolCall` (`:1145`).
- **Sandbox**: não há. `workspaces/` isola caminhos, não processos. Para código
  arbitrário o projeto recomenda ferramenta externa.
- **SSRF**: `_ssrf.py` (41 KB) valida URLs de tools de fetch — raro em framework
  de agente e relevante para nós, que temos browser.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Agente | `tests/` (797 arquivos `test_*.py`) | loop, tools, saída, usage |
| Grafo | `pydantic_graph/` + `tests/` | forks, joins, decisões, streaming |
| Durable exec | `tests/durable_exec/` | replay Temporal/DBOS/Prefect |
| Mensagens | `tests/test_messages.py` | round-trip do `TypeAdapter` |
| Docs executáveis | `tests/test_examples.py` | todo exemplo da doc roda |
| Custo | `tests/cost_guards.py` | falha teste que abre subprocesso sem marca |

O padrão mais forte: **testar exemplos da documentação** (`tests/test_examples.py`)
e **proibir subprocesso** para manter a suíte rápida
(`AGENTS.md`, seção "Test process isolation"). Vale copiar a ideia, não o
arquivo.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Operação durável com identidade/codec | `durable_exec/_operation.py:249`, `:256`, `:307` | replay sem repetir efeito: o cache é por operação, não por mensagem | MIT | `src/core/session/run-journal.ts` | 25 |
| `AgentRun.next()` (passo a passo) | `run.py:271`, `:579` | pausa entre nós é trivial; hoje o runner é um `for` fechado | MIT | `src/core/agent/runner.ts` | 24 |
| `GraphAgentState` serializável | `_agent_graph.py:380` | estado mínimo e explícito; cabe em JSON | MIT | `src/core/agent/context-types.ts` | 21 |
| `ApprovalRequiredToolset` | `toolsets/approval_required.py:14` | aprovação por predicado, com args e definição da tool | MIT | `src/core/security/permissions.ts` | 23 |
| `OutputValidator` + retry com feedback | `_output.py:501`, `_agent_graph.py:451` | erro de schema vira instrução, não stack trace | MIT | `src/core/quality/guardrails.ts` | 20 |
| `UsageLimits` | `usage.py:505` | orçamento por run com limites separados | MIT | `src/core/agents/limits.ts` | 18 |
| `IncompleteToolCall` | `_agent_graph.py:435` | evita JSON truncado chegar na tool | MIT | `src/core/providers/compat.ts` | 17 |
| `DeferredLoadingToolset` + tool search | `toolsets/deferred_loading.py:10`, `_tool_search.py` | catálogo grande sem inflar prompt | MIT | `src/core/tools/registry.ts` | 16 |
| `Fork`/`Join` com reducer | `pydantic_graph/node.py:66`, `join.py:32` | paralelismo com ponto de junção explícito | MIT | `src/core/agent/graph.ts` | 15 |
| `JournalOperationNamer` (nomes imutáveis) | `durable_exec/_operation_names.py:46` | compatibilidade de replay documentada | MIT | `src/core/session/run-journal.ts` | 12 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `pydantic_graph` inteiro (98 KB em `graph_builder.py`) | fork/join/decisão em nível de biblioteca; nosso caso é orquestração de agente |
| Backends Temporal/DBOS/Prefect | dependência de infraestrutura pesada; queremos o *conceito* de journal |
| `Agent.override()` | padrão de teste Python; em TS usamos injeção de provider |
| `capabilities/` (dezenas de wrappers) | generalidade que não temos demanda; aumenta superfície |
| `ui/` e `realtime/` | outro produto (chat UI, voz) |
| Providers proprietários | nosso `src/core/providers` já cobre Anthropic/compat |
| Tipagem por anotação de retorno | depende de `typing.get_type_hints`; em TS a borda é union de literais |

## 12. Modelo de exemplo para o nosso harness

1. **Loop como máquina de estados explícita.** Trocar o `for` interno de
   `src/core/agent/runner.ts` por um `AgentStep` com union discriminada:
   `{ kind: 'model' } | { kind: 'tools', calls } | { kind: 'done', output }`.
   Cada `advance()` executa **um** passo e devolve o próximo. É o
   `next_node`/`next()` do pydantic-ai (`run.py:271`, `:579`), sem o grafo
   genérico.
2. **Journal de operações, não de mensagens.** Persistir
   `{ operationId, kind, key, result }` para `model.request`, `tool.call`,
   `tools.list`. Na retomada, se a operação existe, devolve o resultado
   gravado (idempotência). É o `DurableOperation` deles; o nosso ganho é não
   repetir tool com efeito colateral depois de um crash.
3. **Aprovação com predicado.** `requiresApproval(ctx, tool, args)` no
   `ToolDef` (`src/core/tools/types.ts:185`), avaliado antes de executar; se
   true, o runner emite `approval_required` e para. Diferente de lista fixa por
   nome, o predicado vê os argumentos.
4. **Saída estruturada com retry contado.** `validateOutput(value)` devolve
   `{ ok } | { retry, feedback }`; o runner injeta o feedback como mensagem de
   sistema e conta em `outputRetries`. Limite duro, erro claro no fim.
5. **Teste de mesa.** Rodar `advance()` até `kind: 'tools'`, serializar o
   estado, recriar o runner em outro processo e continuar. Se a tool não rodar
   duas vezes, o journal está correto.

## 13. Evidências da análise

```text
git -C repositorios/_research/orchestration/pydantic--pydantic-ai rev-parse HEAD
→ 4ee11516b5be6b767654304ec8fe346b81369597

read pydantic_graph/pydantic_graph/basenode.py:24-52
→ "The return type of this method are read by pydantic_graph at runtime and
   used to define which nodes can be called next in the graph"

Select-String pydantic_graph/graph_builder.py "^class |^    def |^def "
→ 153 Graph  235 run  385 GraphTaskRequest  406 GraphTask  425 GraphRun
→ 536 __aiter__  579 next  586 override_next  1154 GraphBuilder  1381 join

read pydantic_ai_slim/pydantic_ai/_agent_graph.py:380-476
→ GraphAgentState(message_history, usage, output_retries_used, run_step,
   run_id=uuid7, conversation_id, pending_messages)
→ "Exceeded maximum output retries ({max_output_retries})"
→ check_incomplete_tool_call: finish_reason == 'length' + ToolCallPart

Select-String tool_manager.py "^    async def "
→ 601 _validate_tool_args  645 _run_validate_hooks  725 _run_execute_hooks
→ 925 validate_tool_call  1011 execute_tool_call

read toolsets/approval_required.py
→ "if not ctx.tool_call_approved and self.approval_required_func(...):
      raise ApprovalRequired"

Select-String durable_exec/_operation.py "^class "
→ 307 DurableOperation  249 CacheIdentity  256 ResultCodec
→ 38 ModelRequestId  184 ToolsetCallToolId  85 ModelCompactMessagesId

read durable_exec/_operation_names.py:46-60
→ "Generated names are persisted compatibility data and must essentially never change."

Select-String usage.py "^class UsageLimits"
→ request_limit: int | None = 50 / tool_calls_limit / total_tokens_limit /
   per_request_input_tokens_limit

busca por checkpointer/persistence no pydantic_graph → não encontrado
```
