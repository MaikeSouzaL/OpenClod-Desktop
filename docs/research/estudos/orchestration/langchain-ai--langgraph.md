# LangGraph

| Campo | Valor |
|---|---|
| Repositório | https://github.com/langchain-ai/langgraph |
| Clone local | `repositorios/_research/orchestration/langchain-ai--langgraph` |
| Commit | `4c52e129eb1ab69a3da58b799f67929f77d81149` |
| Licença | MIT (`LICENSE:1`); metadados em `libs/langgraph/pyproject.toml:16` |
| Categoria | orchestration (grafo de estado, checkpoints, HITL) |
| Stack | Python >= 3.10, monorepo hatchling/uv; núcleo em `libs/langgraph`; Pydantic 2 e `xxhash` como deps (`libs/langgraph/pyproject.toml:28-34`) |
| Tamanho | 698 arquivos; 479 `.py`; ~171.6 mil linhas Python no monorepo |

**Caminhos:** citações que começam em `graph/`, `pregel/`, `channels/`,
`managed/`, `func/`, `types.py` ou `errors.py` são relativas a
`libs/langgraph/langgraph/`; `checkpoint/...` é relativa a
`libs/checkpoint/langgraph/checkpoint/`; `tool_node.py` é relativa a
`libs/prebuilt/langgraph/prebuilt/`. O prefixo completo aparece na primeira
ocorrência de cada arquivo.

## 1. O que é (verificado no código)

É um runtime de execução **Pregel/BSP** (bulk-synchronous parallel) para agentes:
o grafo é um conjunto de *channels* versionados, os nós escrevem nesses canais e
o loop avança em supersteps (`libs/langgraph/langgraph/pregel/_loop.py:650`).
O que o produto vende — "stateful, multi-actor applications with LLMs"
(`libs/langgraph/pyproject.toml:6`) — está de fato implementado como máquina de
estado durável, não como cadeia de prompts.

O entrypoint real de biblioteca é `StateGraph(...).compile(checkpointer=...)`
(`libs/langgraph/langgraph/graph/state.py:1177`), que devolve um
`CompiledStateGraph` com `invoke`/`stream`/`get_state`/`update_state`
(`libs/langgraph/langgraph/pregel/main.py:1464`, `:1514`, `:2617`).
Não há CLI de agente no pacote núcleo: o `libs/cli` empacota o servidor de
desenvolvimento, e o `libs/sdk-js` é só um stub que aponta para o repositório
`langgraphjs` (`libs/sdk-js/README.md:3-5`). Para nós, isso significa que **não
existe código TypeScript aproveitável neste clone** — só o desenho.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `make test` (por lib) | `AGENTS.md` do monorepo / `libs/langgraph/Makefile` | pytest da biblioteca |
| `make format`, `make lint` | idem | ruff/format e lint |
| `langgraph dev` | `libs/cli/langgraph_cli/cli.py:763` | sobe o servidor local do grafo |
| `langgraph up` / `build` / `dockerfile` | `libs/cli/langgraph_cli/cli.py:278`, `:419`, `:550` | stack Docker e imagem do servidor |
| `graph.invoke(input, config)` | `pregel/main.py:3871` | execução síncrona até fim/interrupção |
| `graph.stream(..., stream_mode=[...])` | `pregel/main.py:2709` | stream por `values`, `updates`, `messages`, `custom`, `checkpoints`, `tasks`, `debug` (`types.py:273-344`) |
| `graph.get_state(config)` | `pregel/main.py:1464` | último snapshot do `thread_id` |
| `graph.get_state_history(config)` | `pregel/main.py:1514` | histórico de checkpoints |
| `graph.update_state(config, values, as_node=...)` | `pregel/main.py:2617` | escrita manual no estado (fork humano) |

A superfície de UX é a configuração: `config["configurable"]["thread_id"]`
identifica a linha do tempo (`graph/state.py:1204-1214`) e
`checkpoint_id` seleciona um ponto dela. `durability` aceita `"sync"`,
`"async"` (padrão) e `"exit"` (`_internal/_constants.py:71-72`,
`pregel/main.py:2696`).

## 3. Arquitetura e fluxo

```
StateGraph.add_node/add_edge/add_conditional_edges
  → compile(checkpointer, store, interrupt_before/after)
  → PregelLoop.tick()            # 1 superstep
      prepare_next_tasks()       # quem roda agora
      executor.map / asyncio.gather
      after_tick() → apply_writes()  # canais versionados
      _put_checkpoint()          # snapshot + pending writes
  → stream(values|updates|messages|custom|checkpoints|tasks|debug)
```

- Entry point: `libs/langgraph/langgraph/graph/state.py:1177` (`compile`).
- Loop do agente: `libs/langgraph/langgraph/pregel/_loop.py:650` (`tick`) e
  `:737` (`after_tick`).
- Seleção de tarefas: `pregel/_algo.py:348` (`prepare_next_tasks`) e `:523`
  (`prepare_single_task`); fan-out por `Send` em `:937`.
- Aplicação de escritas: `pregel/_algo.py:233` (`apply_writes`) com
  `versions_seen` por nó (`checkpoint/base/__init__.py:116-121`).
- Execução de ferramenta: `libs/prebuilt/langgraph/prebuilt/tool_node.py:801`
  (sync, `executor.map`) e `:836` (async, `asyncio.gather`).
- Streaming: `pregel/main.py:2709`; partes tipadas em `langgraph/types.py:273-344`.
- Persistência: `checkpoint/base/__init__.py:199` (`BaseCheckpointSaver`) com
  `put`/`put_writes` (`:301`, `:324`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `ToolNode` | `libs/prebuilt/langgraph/prebuilt/tool_node.py:630` | executa `tool_calls` em paralelo e devolve `ToolMessage`/`Command` | alto (executa tools) |
| `ToolCallRequest` | `tool_node.py:141` | permite interceptar/reescrever a chamada antes de executar | médio |
| `wrap_tool_call` | `tool_node.py:1061-1088` | middleware por chamada; erro vira `ToolMessage(status="error")` | médio |
| `ToolRuntime` | `tool_node.py:1697` | injeta state, store, config, `tool_call_id`, writer de stream na tool | médio |
| `InjectedState` / `InjectedStore` | `tool_node.py:1787`, `:1863` | acesso tipado ao estado e ao store de longo prazo | alto (vaza estado) |
| `interrupt(value, response_schema=...)` | `langgraph/types.py:903` | pausa o nó e devolve valor tipado na retomada | baixo |
| `Command(resume=..., goto=..., update=...)` | `types.py:833` | retoma, redireciona e escreve estado em uma instrução | médio |
| `Send(node, arg)` | `types.py:738` | fan-out dinâmico (map-reduce) | baixo |
| `RetryPolicy` | `types.py:427` | backoff com jitter, `max_attempts`, `retry_on` | baixo |
| `TimeoutPolicy` | `types.py:461` | `run_timeout` + `idle_timeout` por tentativa | baixo |
| `CachePolicy` | `types.py:530` | cache de resultado de nó por chave | baixo |
| `HumanResponse` | `prebuilt/interrupt.py` (`type`/`args`) | contrato `accept/ignore/response/edit` para aprovação | baixo |

## 5. Loop do agente, contexto e streaming

O nó é uma função `state -> update`; o loop não monta prompt (isso é do
LangChain). O que interessa é o **contrato de execução**:

1. `tick()` para se `step > stop` (`_loop.py:658`) — orçamento de supersteps.
2. `prepare_next_tasks` calcula os nós cujos canais mudaram desde a última
   versão vista por aquele nó (`_algo.py:348`, `versions_seen` em
   `checkpoint/base/__init__.py:116`). Isso dá grafo com ciclos sem reexecutar
   tudo: só roda quem "viu" uma versão velha.
3. Antes de executar, `interrupt_before` pode levantar `GraphInterrupt`
   (`_loop.py:714-718`).
4. `after_tick` aplica as escritas e emite `values` se os canais de saída
   mudaram (`_loop.py:761-776`).
5. Retry é por tarefa: `run_with_retry` (`pregel/_retry.py:573`) decide com
   `_should_retry_on` (`:834`). Timeout é cooperativo — o docstring avisa que
   nós síncronos bloqueantes não são canceláveis (`types.py:464-468`).
6. Cancelamento: `NodeCancelledError` (`errors.py:169`) e `GraphDrained`
   (`errors.py:55`), que distingue "drenar e parar" de "erro".

Streaming é multimodal por desenho: um run pode assinar vários `stream_mode` ao
mesmo tempo (`pregel/main.py:2673-2680`) e cada parte é um `TypedDict` com
`type` discriminante (`types.py:273-344`). Para o nosso renderer isso é melhor
que um único canal de texto: dá para separar "mensagem do modelo" de "evento de
ferramenta" e de "checkpoint criado" sem inferência.

## 6. Sessões, estado e persistência

O modelo é explícito e vale copiar:

- `Checkpoint` = `{v, id, ts, channel_values, channel_versions, versions_seen,
  updated_channels}` (`checkpoint/base/__init__.py:93-125`). `id` é monotônico
  e ordenável (`:99-102`), o que permite "último checkpoint" sem relógio.
- `CheckpointMetadata` tem `source` ∈ `input|loop|update|fork`, `step`,
  `parents` (mapa namespace→checkpoint) e `run_id`
  (`checkpoint/base/__init__.py:39-63`). **Fork é cidadão de primeira classe**:
  `update_state` cria checkpoint com `source="update"` e o histórico preserva o
  pai.
- Escritas pendentes ficam separadas do snapshot (`put_writes`,
  `checkpoint/base/__init__.py:324`), então uma queda no meio do superstep não
  perde o que já terminou: `pending_writes` são reaplicadas no próximo tick
  (`_loop.py:708-711`).
- `BaseCheckpointSaver` já prevê `copy_thread` (`:374`) e `prune` (`:398`) —
  operações que normalmente faltam em implementações caseiras.
- `InMemorySaver` guarda `storage[thread_id][checkpoint_ns][checkpoint_id]`
  (`checkpoint/memory/__init__.py:86-93`), com namespace para subgrafos.
- `durability="exit"` só grava no fim (`_loop.py:1283-1285`), trocando
  retomada fina por throughput.

## 7. Configuração e extensibilidade

- `compile(checkpointer, cache, store, interrupt_before, interrupt_after,
  debug, name, transformers)` (`graph/state.py:1177-1188`).
- Por nó: `retry_policy`, `cache_policy`, `timeout`, `error_handler`,
  `destinations`, `input_schema`, `trace_policy` (`graph/state.py:667-681`).
- `add_node(..., destinations=...)` serve só para renderização, não para
  execução (`graph/state.py:712-714`) — bom lembrar ao desenhar UI de grafo.
- Esquemas separados de entrada/saída/estado (`graph/state.py:262-269`), o que
  permite esconder campos internos do contrato público.
- API funcional (`@entrypoint`/`@task`) em `langgraph/func/__init__.py`
  (23 KB) para quem não quer montar grafo à mão.
- Valores gerenciados (`IsLastStep`, `RemainingSteps`) em
  `langgraph/managed/is_last_step.py` — o nó sabe se é a última chance.

## 8. Permissões, sandbox e erros

Não há sandbox: o grafo executa código Python do usuário. O que existe é
**interrupção com contrato**:

- `GraphBubbleUp` (`errors.py:51`) é a classe base dos sinais de controle;
  `GraphInterrupt` (`:103`) e `NodeInterrupt` (`:115`) param o run sem virar
  "erro de nó".
- `interrupt()` lança na primeira chamada e, na retomada, **reexecuta o nó desde
  o início**, casando valores por ordem de chamada no mesmo task
  (`langgraph/types.py:912-922`). Isso é uma armadilha real: efeitos
  colaterais antes do `interrupt` rodam duas vezes.
- `response_schema` aceita JSON Schema (não valida) ou Pydantic/TypedDict
  (valida e devolve objeto) (`types.py:986-1002`); valor inválido não é salvo,
  então dá para responder de novo (`:1000-1002`).
- Aprovação por ferramenta é feita com `HumanResponse`
  (`prebuilt/interrupt.py`, campos `type` e `args`) — `accept|ignore|response|edit`.
  Está marcado como deprecado em favor de `langchain.agents.interrupt`.
- `InvalidUpdateError` (`errors.py:91`) protege contra escrever em canal
  inexistente; `GraphRecursionError` (`:68`) limita ciclos.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Núcleo do grafo | `libs/langgraph/tests/test_algo.py`, `test_channels.py` | canais, writes, versionamento |
| Interrupção/HITL | `libs/langgraph/tests/test_interruption.py`, `test_interrupt_state.py`, `test_interrupt_migration.py` | pausa, retomada, migração de formato |
| Checkpoints | `libs/checkpoint/tests` (7 arquivos), `libs/checkpoint-conformance` | conformidade entre savers |
| Delta channels | `libs/langgraph/tests/test_delta_channel_*.py` (15 arquivos) | snapshots incrementais, fork, ordem paralela |
| Parent/Command | `test_parent_command.py` | `Command.PARENT` em subgrafo |
| Tipos/stream | `test_types.py`, `test_stream_*` | contrato de `StreamPart` |

Contagem: 173 arquivos `test_*.py` nos diretórios `tests` do monorepo.
O padrão interessante é `checkpoint-conformance`: a interface de persistência
tem suíte de conformidade própria, o que evita "funciona só no SQLite".

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Modelo de checkpoint com `versions_seen` | `libs/checkpoint/langgraph/checkpoint/base/__init__.py:93` | permite grafo com ciclos e retomada exata sem reexecutar nós alheios | MIT | `src/core/session/run-journal.ts` | 24 |
| `pending_writes` + reaplicação | `pregel/_loop.py:708`, `checkpoint/base/__init__.py:324` | sobrevive a crash no meio do superstep; hoje só temos checkpoint de arquivos | MIT | `src/core/session/run-journal.ts` | 23 |
| `interrupt` + `Command(resume)` | `langgraph/types.py:903`, `:833` | HITL com valor tipado e retomada idempotente por task | MIT | `src/core/agent/interrupts.ts` | 22 |
| `StateSnapshot` / `get_state_history` | `types.py:711`, `pregel/main.py:1514` | UI de linha do tempo e fork sem inventar formato | MIT | `src/core/session/rewind.ts` | 21 |
| `RetryPolicy` + `TimeoutPolicy` | `types.py:427`, `:461` | política declarativa por nó, com jitter e idle timeout | MIT | `src/core/agent/retry.ts` | 19 |
| `ToolCallRequest` + `wrap_tool_call` | `prebuilt/tool_node.py:141`, `:1061` | middleware de tool com erro convertido em resultado observável | MIT | `src/core/tools/registry.ts` | 18 |
| `Send` (fan-out dinâmico) | `types.py:738` | map-reduce sem criar N nós | MIT | `src/core/agent/graph.ts` | 16 |
| `HumanResponse` (`accept/ignore/edit`) | `prebuilt/interrupt.py` | vocabulário pronto para o modal de aprovação | MIT | `src/core/security/permissions.ts` | 15 |
| `durability` por execução | `pregel/_loop.py:1283` | alterna gravação fina vs. só no fim | MIT | `src/core/session/store.ts` | 13 |
| Suíte de conformidade de checkpointer | `libs/checkpoint-conformance` | garante que o backend novo cumpre o contrato | MIT | `src/core/session/__tests__` | 10 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `PregelLoop` inteiro (91 KB) | acoplado a canais Python, `Runnable`, config do LangChain |
| Canais `DeltaChannel` (beta) | complexidade alta e API declarada instável (`checkpoint/base/__init__.py:67-70`) |
| `langgraph-sdk` / `sdk-py` | cliente HTTP do servidor deles; não temos servidor LangGraph |
| `libs/sdk-js` | só README apontando para outro repositório |
| Dependência de `langchain-core` | arrasta o framework inteiro; nosso `ProviderBlocks` já cobre a camada de modelo |
| `trace_policy` / OTel embutido | já temos `src/core/observability` |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem inventar API:

1. **Journal por run, separado do checkpoint de arquivos.** Hoje
   `src/core/session/checkpoint.ts:11` guarda `git` + patch + untracked, que é
   sobre o *workspace*. Falta o equivalente ao `Checkpoint`: `runId`,
   `parentRunId`, `step`, `channelVersions`, `pendingWrites`.
2. **Interrupt tipado.** `interrupt<T>(payload, schema)` lança um
   `HarnessInterrupt` que sobe até o runner; o runner persiste
   `{ runId, taskId, interruptId, payload }` e devolve o controle à UI. A
   retomada entra por `resume(runId, interruptId, value)` e o runner
   **reexecuta a task do início** — por isso a regra de ouro: nenhum efeito
   colateral antes do primeiro `interrupt` (é a mesma armadilha documentada em
   `langgraph/types.py:918`).
3. **Superstep com barreira.** `runStep()` coleta as tool calls do turno,
   executa em paralelo (`Promise.allSettled`, equivalente ao
   `asyncio.gather` de `tool_node.py:866`), grava `pendingWrites` antes de
   aplicar, e só então cria o checkpoint.
4. **Fork na UI.** `updateState(runId, patch, asNode)` cria um checkpoint
   `source: "update"` e o histórico mantém `parentConfig`; `src/core/session/rewind.ts`
   passa a apontar para o run pai em vez de só “voltar mensagens”.
5. **Critério de teste.** Um teste que mata o processo entre
   `pendingWrites` e `put`: ao reabrir, o run deve terminar sem repetir a tool
   já concluída. É o cenário que a suíte `test_delta_channel_write_failures.py`
   cobre do lado deles.

## 13. Evidências da análise

```text
git -C repositorios/_research/orchestration/langchain-ai--langgraph rev-parse HEAD
→ 4c52e129eb1ab69a3da58b799f67929f77d81149

Get-ChildItem libs/langgraph/langgraph -Directory
→ channels func graph managed pregel stream utils _internal

Select-String libs/langgraph/langgraph/types.py "^class |^def |^    def "
→ 584: class Interrupt  738: class Send  833: class Command
→ 427: class RetryPolicy  461: class TimeoutPolicy  711: class StateSnapshot

read types.py:903-1045
→ "The graph resumes from the start of the node, re-executing all logic."
→ "idx = scratchpad.interrupt_counter()" / "raise GraphInterrupt(...)"

read pregel/_loop.py:650-737
→ "if self.step > self.stop: self.status = 'out_of_steps'"
→ "if self.interrupt_before and should_interrupt(...): raise GraphInterrupt()"

read pregel/_loop.py:1231-1285
→ "do_checkpoint = ... (exiting or self.durability != 'exit')"

read checkpoint/base/__init__.py:39-149
→ CheckpointMetadata.source Literal['input','loop','update','fork']
→ Checkpoint{v,id,ts,channel_values,channel_versions,versions_seen,updated_channels}

read prebuilt/tool_node.py:801-868, 1031-1088
→ executor.map(self._run_one, ...) / await asyncio.gather(*coros)
→ except Exception as e: ... ToolMessage(status="error")

(Get-ChildItem libs/langgraph/tests -Filter test_*.py).Count → 74 arquivos no topo
```
