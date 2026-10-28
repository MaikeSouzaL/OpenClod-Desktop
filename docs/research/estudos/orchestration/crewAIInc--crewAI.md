# CrewAI

| Campo | Valor |
|---|---|
| Repositório | https://github.com/crewAIInc/crewAI |
| Clone local | `repositorios/_research/orchestration/crewAIInc--crewAI` |
| Commit | `38db11e3324fa0e23beb5eecd0d87e8e31ca2bb0` |
| Licença | MIT (`LICENSE:1`) |
| Categoria | orchestration (crew/times, flows com estado, checkpoints) |
| Stack | Python >= 3.10,<3.14 (`lib/crewai/pyproject.toml:9`), uv workspace (`lib/crewai`, `lib/crewai-core`, `lib/crewai-tools`, `lib/crewai-files`, `lib/cli`), Pydantic 2 |
| Tamanho | 37.336 arquivos (dominado por docs/i18n); 1.451 `.py`; ~438 mil linhas Python; 407 arquivos `test_*.py` |

**Caminhos:** citações que começam em `flow/`, `state/`, `agents/`, `agent/`,
`memory/`, `crew.py`, `task.py`, `process.py` ou `lite_agent.py` são relativas a
`lib/crewai/src/crewai/`. O prefixo completo aparece na primeira ocorrência de
cada arquivo.

## 1. O que é (verificado no código)

São **duas engines** no mesmo pacote:

1. **Crew**: lista de `Task` executadas por `Agent` com papel, em processo
   `sequential` ou `hierarchical` (`lib/crewai/src/crewai/process.py:4-13`).
   O loop é `Crew._execute_tasks`
   (`lib/crewai/src/crewai/crew.py:1577`), que também aceita tasks
   assíncronas e tasks condicionais.
2. **Flow**: orquestração dirigida por eventos com decorators
   `@start` / `@listen` / `@router` (`lib/crewai/src/crewai/flow/dsl/_start.py:16`,
   `_listen.py:18`, `_router.py:105`), estado tipado e persistência por método
   (`lib/crewai/src/crewai/flow/persistence/base.py:17`).

O entrypoint de biblioteca é `Crew.kickoff` (`crew.py:997`) e
`Flow.kickoff` (via `lib/crewai/src/crewai/flow/runtime/__init__.py`, 167 KB).
O README fala de "role-playing autonomous agents"; o código confirma, mas o
valor real para nós está no **Flow** e no **checkpoint de runtime**, não no
role-play.

Divergência relevante: `crew.py` reimplementa boa parte do agente no
`AgentExecutor` (`agents/agent_executor.py:187`, que herda de `Flow`), enquanto
`lite_agent.py:1` é uma engine paralela mais enxuta. São três caminhos de
execução convivendo — sinal de dívida, não de arquitetura limpa.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `crewai create crew <nome>` | `lib/cli/src/crewai_cli/` | scaffold de projeto |
| `crewai run` | `lib/cli` | executa o crew do projeto |
| `crew.kickoff(inputs={...})` | `crew.py:997` | roda todas as tasks |
| `crew.kickoff_for_each(inputs=[...])` | `crew.py:1101` | um kickoff por item, em paralelo |
| `flow.kickoff()` | `flow/runtime/__init__.py` | executa `@start` e propaga eventos |
| `flow.kickoff()` | `flow/runtime/__init__.py:2116` | executa `@start` e propaga eventos |
| `MyFlow.from_pending(uuid, persistence)` | `flow/persistence/sqlite.py:60-75` (docstring) | reconstrói fluxo aguardando feedback |
| `flow.resume("texto")` | `flow/runtime/__init__.py:1348` | injeta feedback e segue |
| `flow.resume_async("texto")` | `flow/runtime/__init__.py:1401` | variante async |

A superfície de UX do Flow é o **nome do método**: `@listen("approved")` escuta
o rótulo emitido pelo método anterior; `@router` devolve o rótulo
(`_router.py:105-130`). Não há IDs opacos — o grafo é derivado dos nomes, e
`FlowDefinition` valida colisões (`flow/flow_definition.py:778-806`).

## 3. Arquitetura e fluxo

```
Crew.kickoff
  → _execute_tasks (sequencial + futures para async_execution)
  → task.execute_sync → AgentExecutor (que é um Flow)
      → LLM → tool calls → guardrail → TaskOutput

Flow.kickoff
  → FlowDefinition (métodos, triggers, ações)
  → evento "método X terminou" → resolve @listen/@router
  → executa próximo método
      → @persist → FlowPersistence.save_state(flow_uuid, method_name, state)
      → @human_feedback → provider.request_feedback → HumanFeedbackPending
```

- Entry point do crew: `lib/crewai/src/crewai/crew.py:997`.
- Loop sequencial: `crew.py:1577-1646`; tasks async acumulam `Future` e são
  drenadas antes da próxima task síncrona (`crew.py:1627-1631`).
- Delegação: `crew.py:1667-1679` injeta as tools de delegação quando
  `allow_delegation=True`; o corpo está em `crew.py:1839`.
- Manager hierárquico: `crew.py:1533` (`_create_manager_agent`), exigido pelo
  processo `hierarchical` (`crew.py:1670-1676`).
- Execução de task: `task.py:585` (sync) e `:609` (async), núcleo em `:809`.
- Guardrail: `task.py:1327` (`_invoke_guardrail_function`), com
  `guardrail_max_retries + 1` tentativas.
- Streaming: eventos via `crewai_event_bus` (importado em `state/runtime.py:35`),
  com tipos de evento em `events/`; o Flow emite um evento por transição de
  método (`state/checkpoint_config.py:15-90`).
- Persistência: `flow/persistence/base.py:47` + implementação SQLite em
  `flow/persistence/sqlite.py:99`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `@start` | `flow/dsl/_start.py:16` | marca entrypoint; aceita condição (`and_`/`or_`/nome) | baixo |
| `@listen` | `flow/dsl/_listen.py:18` | executa quando o trigger dispara | baixo |
| `@router` | `flow/dsl/_router.py:105` | escolhe ramo pelo retorno; `emit=` documenta saídas | baixo |
| `or_` / `and_` | `flow/dsl/_conditions.py:22`, `:27` | composição de triggers | baixo |
| `@persist(SQLiteFlowPersistence())` | `flow/persistence/decorators.py:147` | grava estado após cada método | médio (I/O) |
| `@human_feedback(message, emit, llm, provider)` | `flow/human_feedback.py:453` | pausa, coleta e emite rótulo aprovado/rejeitado | alto (chama LLM) |
| `allow_delegation` | `agents/agent_builder/base_agent.py:278` | injeta tools para delegar a colegas | alto |
| `guardrail` | `task.py:252`, impl. `:1327` | valida saída e reexecuta com feedback | médio |
| `output_pydantic` / `response_model` | `agent/core.py:1300-1301`, `:1345` | força saída estruturada | baixo |
| `respect_context_window` | `agent/core.py:293` | resume mensagens para caber no contexto | baixo |
| `use_better_compaction` | `agent/core.py:296` | move tool results grandes para artefatos | baixo |

## 5. Loop do agente, contexto e streaming

`Crew._execute_tasks` é deliberadamente simples: percorre tasks, monta contexto
com as saídas anteriores (`_get_context`, chamado em `crew.py:1633`), executa e
guarda `TaskOutput`. O paralelismo é só entre tasks marcadas
`async_execution` (`crew.py:1616-1625`), não entre tool calls.

O agente em si (`AgentExecutor`, `agents/agent_executor.py:187`) é um Flow com
estado (`AgentExecutorState`, `:149`): cada iteração do loop é um passo do Flow,
o que permite serializar o meio do raciocínio. Ele suporta plano explícito
(`generate_plan`, `:555`), todos observáveis (`_create_todos_from_plan`, `:599`)
e replanejamento com limite (`_get_max_replans`, `:741`). Isso é mais próximo de
um harness de produto do que de uma lib de prompt.

Contexto: `respect_context_window=True` resume quando estoura
(`agent/core.py:293`), `use_better_compaction` transforma tool result gigante em
artefato (`:296`). Retry: `max_retry_limit` (`:301`). Cancelamento: o Flow
persiste `HumanFeedbackPending` em vez de manter a pilha viva
(`flow/async_feedback/types.py`), então "cancelar" é simplesmente não retomar.

## 6. Sessões, estado e persistência

Há **três** mecanismos distintos — importante não confundi-los:

1. **Flow state por método** — `FlowPersistence` com `init_db`, `save_state`,
   `load_state` e, opcionalmente, `save_pending_feedback` /
   `load_pending_feedback` / `clear_pending_feedback`
   (`flow/persistence/base.py:38-120`). O SQLite cria
   `flow_states(id, flow_uuid, method_name, timestamp, state_json)`
   (`flow/persistence/sqlite.py:107-118`) com WAL e retry em `database is locked`
   (`:99-110`). É um **append por método**, não um snapshot do grafo.
2. **Runtime checkpoint** — `RuntimeState` é um `RootModel` que serializa
   "todas as entidades ativas" (`state/runtime.py:1-8`, `:177`), com
   `checkpoint(location)` (`:286`), `fork(branch)` (`:352`) e
   `from_checkpoint(config)` (`:392`). O backend é `BaseProvider`
   (`state/provider/core.py:10`) com
   `checkpoint(data, location, parent_id, branch)` (`:33`), `prune(location,
   max_keep, branch)` (`:61`) e `extract_id`.
3. **Event record** — DAG de eventos com arestas tipadas
   `parent|child|trigger|triggered_by|next|previous|started|completed_by`
   (`state/event_record.py:72-84`), nó `EventNode` com listas de adjacência
   (`:86`). O listener grava checkpoint automaticamente em transições
   (`state/checkpoint_listener.py:1-12`), guiado por `CheckpointEventType`
   (`state/checkpoint_config.py:15-90`), que inclui `flow_paused` e
   `human_feedback_requested`.

O SQLite do provider usa `checkpoints(id, created_at, parent_id, branch, data)`
(`state/provider/sqlite_provider.py:18-25`) e poda por branch com
`ORDER BY rowid DESC LIMIT ?` (`:33-34`). Ou seja: **branch + parent_id** são
schema, não convenção.

## 7. Configuração e extensibilidade

- Estado do Flow pode ser `dict`, `BaseModel`, JSON Schema ou desconhecido
  (`flow/flow_definition.py:81`, `:98`, `:133`, `:160`) — o motor valida e
  serializa cada variante.
- `FlowDefinition` é um modelo Pydantic que descreve métodos, triggers, ações,
  tools, crews, expressões CEL e HITL (`flow/flow_definition.py:720`), com
  `to_dict`/`from_declaration` (`:806`, `:823`). Isso permite **carregar flow de
  arquivo**, não só de classe Python.
- Ações declarativas: `FlowCodeActionDefinition`, `FlowToolActionDefinition`,
  `FlowCrewActionDefinition`, `FlowAgentActionDefinition`,
  `FlowExpressionActionDefinition` (`:352`, `:379`, `:409`, `:475`, `:508`).
- CEL para condições: `flow/expressions.py:1-30` (usa `celpy`), com registro de
  funções em `_cel_function_registry` (`:39`).
- `persistence/factory.py` escolhe backend padrão; `_persistence_registry`
  registra subclasses automaticamente (`flow/persistence/base.py:17-30`).
- `skills/` e `mcp/` no pacote expandem ferramentas; `a2a/` expõe agentes por
  protocolo.

## 8. Permissões, sandbox e erros

- Não há sandbox de shell no núcleo; `allow_code_execution` injeta tools de
  código (`crew.py:1681-1684`), e `apps` injeta tools de plataforma (`:1694`).
- Aprovação humana é **pausa com estado**, não bloqueio de thread:
  `@human_feedback` estampa metadados (`flow/human_feedback.py:1-10`) e o
  provider levanta `HumanFeedbackPending(context=...)` (`:36-44`). O fluxo
  morre e é reconstruído com `from_pending` / `resume`.
- Guardrail reexecuta a task com contagem própria
  (`task.py:1327-1360`) e acumula falhas anteriores (`:1349-1352`), para não
  perder o histórico de tentativas bloqueadas.
- Erros de persistência são logados e **não derrubam** o flow por padrão
  (`flow/persistence/decorators.py:41-45`, mensagens `save_error`).
- `SQLiteFlowPersistence.init_db` faz retry com deadline de 30 s em
  `database is locked` (`flow/persistence/sqlite.py:22`, `:99-110`).
- Sem RBAC: qualquer método do Flow pode chamar qualquer tool registrada.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Flow DSL | `lib/crewai/tests/flow/` | `@start/@listen/@router`, `or_`/`and_` |
| Persistência | `lib/crewai/tests/flow/` (SQLite, pending feedback) | save/load por método, retomada |
| Crew | `lib/crewai/tests/` | sequencial, hierárquico, conditional task |
| State/checkpoint | `lib/crewai/tests/` (provider, fork, prune) | lineage e branch |
| Guardrails | `lib/crewai/tests/` | retry e output inválido |
| Integração | `lib/crewai-tools/tests/` | tools de terceiros |

Contagem: 407 arquivos `test_*.py`. O projeto usa `pytest-randomly`,
`pytest-split`, `vcrpy` e `pytest-recording` (`pyproject.toml:14-24`), o que
indica suíte grande o suficiente para precisar de seleção e isolamento.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `RuntimeState` + provider com `branch`/`parent_id` | `state/runtime.py:177`, `state/provider/core.py:33` | fork e poda por branch são schema, não gambiarra | MIT | `src/core/session/run-journal.ts` | 22 |
| `CheckpointEventType` (taxonomia de transições) | `state/checkpoint_config.py:15` | lista pronta de eventos que merecem checkpoint | MIT | `src/core/observability/service.ts` | 20 |
| Pausa por estado (`HumanFeedbackPending` + `from_pending`) | `flow/async_feedback/types.py`, `flow/persistence/base.py:79` | sobrevive a reinício do processo sem manter pilha | MIT | `src/core/agent/interrupts.ts` | 21 |
| `FlowPersistence` mínimo (init/save/load + pending) | `flow/persistence/base.py:38-120` | interface pequena e testável | MIT | `src/core/session/store.ts` | 18 |
| Guardrail com retry e falhas acumuladas | `task.py:1327-1360` | feedback estruturado para o modelo em vez de erro seco | MIT | `src/core/quality/guardrails.ts` | 17 |
| Delegação como tool injetada | `crew.py:1667-1679`, `:1839` | delegação é opt-in e vira tool visível ao modelo | MIT | `src/core/agents/tools.ts` | 16 |
| `respect_context_window` / `use_better_compaction` | `agent/core.py:293`, `:296` | duas alavancas separadas: resumir vs. externalizar | MIT | `src/core/agent/compaction.ts` | 15 |
| Event record com arestas `triggered_by` | `state/event_record.py:72` | reconstruir "por que este passo rodou" | MIT | `src/core/observability` | 14 |
| `FlowDefinition` serializável | `flow/flow_definition.py:720` | flow como dado, não só como classe | MIT | `src/core/agents/definitions.ts` | 11 |
| CEL para condições | `flow/expressions.py:39` | expressão declarativa sem eval | MIT | — (avaliar custo) | 6 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Role-play (`role`, `backstory`, `goal` no prompt) | infla prompt sem ganho mensurável; nosso agente é de código |
| `AgentExecutor` como Flow (167 KB de runtime) | complexidade acidental; três engines concorrentes no mesmo pacote |
| `lite_agent.py` | engine paralela redundante; sem sinergia com o resto |
| `celpy` como dependência | mais uma linguagem para manter; `and_`/`or_` em TS bastam no curto prazo |
| `lancedb`/`chromadb` no núcleo | já temos `src/core/memory` com store próprio |
| Traduções e docs (`docs/`, 30k+ arquivos) | ruído de repositório |
| `a2a/` e `plus_api.py` | integração comercial/telemetria, não arquitetura |

## 12. Modelo de exemplo para o nosso harness

1. **Dois níveis, não três.** Manter `Crew` (lista de tasks) e `Flow`
   (eventos) separados, como eles fazem, mas **um único** executor por trás.
   Hoje temos `src/core/agents/runtime.ts:264` (`spawnAgent`) e
   `src/core/agent/runner.ts`; o Flow entraria como um *plano* que agenda
   chamadas ao runner, não como um segundo loop de modelo.
2. **`@listen` por rótulo, não por ID.** O evento `task.completed` carrega
   `{ step, label }`; o agendador mantém um índice `label → steps`. Isso é o
   `_completed_methods` + `_method_outputs` do CrewAI
   (`state/runtime.py:60-70`) e dá retomada barata: basta saber quais rótulos
   já saíram.
3. **Pausa = estado persistido.** Implementar `PendingInterrupt` com
   `{ runId, stepId, kind, payload, responseSchema }` em
   `src/core/session/store.ts`; `resume(runId, value)` reconstrói o run. Nunca
   manter a Promise viva esperando UI — é o erro que o `HumanFeedbackPending`
   evita.
4. **Checkpoint por transição, podado por branch.** Adotar
   `parentId`/`branch`/`keep` no journal (como
   `state/provider/sqlite_provider.py:18-34`) e uma lista fechada de eventos
   que disparam checkpoint. Sem isso, o journal cresce sem limite.
5. **Teste de mesa.** Um flow de 3 passos com `@human_feedback` no meio: matar
   o processo no `await`, reabrir, chamar `resume` e conferir que o passo 1 não
   rodou de novo. É o teste que eles chamam de `from_pending`.

## 13. Evidências da análise

```text
git -C repositorios/_research/orchestration/crewAIInc--crewAI rev-parse HEAD
→ 38db11e3324fa0e23beb5eecd0d87e8e31ca2bb0

Get-ChildItem lib -Directory
→ cli  crewai  crewai-core  crewai-files  crewai-tools  devtools

Get-Content lib/crewai/src/crewai/process.py
→ class Process(str, Enum): sequential / hierarchical

Select-String crew.py "^    def (kickoff|_execute_tasks|_add_delegation_tools|_create_manager_agent)"
→ 997 kickoff  1101 kickoff_for_each  1524 _run_sequential_process
→ 1533 _create_manager_agent  1577 _execute_tasks  1839 _add_delegation_tools

read task.py:1327-1360
→ max_attempts = self.guardrail_max_retries + 1
→ accumulated_failures = list(task_output.tool_failures)

read flow/persistence/base.py
→ class FlowPersistence(BaseModel, ABC)
→ save_state(flow_uuid, method_name, state_data) / load_state(flow_uuid)
→ save_pending_feedback / load_pending_feedback / clear_pending_feedback

read flow/persistence/sqlite.py:99-120
→ CREATE TABLE IF NOT EXISTS flow_states (id, flow_uuid, method_name, timestamp, state_json)

read state/provider/core.py:33-90
→ checkpoint(data, location, *, parent_id, branch='main') / prune(location, max_keep, branch=...)
read state/provider/sqlite_provider.py:18-34
→ checkpoints(id, created_at, parent_id, branch, data) + DELETE ... ORDER BY rowid DESC LIMIT ?

read state/event_record.py:72-90
→ EdgeType = parent|child|trigger|triggered_by|next|previous|started|completed_by

Select-String state/runtime.py "^    def (checkpoint|fork|from_checkpoint)"
→ 286 checkpoint  352 fork  392 from_checkpoint

Select-String flow/dsl/*.py "^def "
→ _start.py:16 start  _listen.py:18 listen  _router.py:105 router
→ _conditions.py:22 or_  :27 and_
```
