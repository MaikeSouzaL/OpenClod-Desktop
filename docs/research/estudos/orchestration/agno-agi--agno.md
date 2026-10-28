# Agno (AgentOS)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/agno-agi/agno |
| Clone local | `repositorios/_research/orchestration/agno-agi--agno` |
| Commit | `6d5af04a72f7b152f433394b1bd4ab740fde8aed` |
| Licença | Apache-2.0 (`LICENSE:1-3`; `libs/agno/pyproject.toml:22`) |
| Categoria | orchestration (workflow com HITL, times, runtime/servidor) |
| Stack | Python >= 3.9,<4 (`libs/agno/pyproject.toml:5`); deps mínimas — pydantic, httpx, pyyaml, rich, docstring-parser (`:26-40`); SQLAlchemy/aiosqlite só em extras |
| Tamanho | 6.408 arquivos e 5.386 `.py` no clone; ~496 mil linhas no pacote `libs/agno/agno` (1.176 `.py`); 1.451 arquivos `test_*.py` |

**Caminhos:** citações que começam em `workflow/`, `session/`, `run/`, `team/`,
`db/`, `agent/`, `approval/`, `guardrails/` ou `os/` são relativas a
`libs/agno/agno/`. `libs/agno/pyproject.toml` é relativo à raiz do clone.

## 1. O que é (verificado no código)

É um framework com **três camadas de orquestração** e um servidor:

1. `Agent` (`libs/agno/agno/agent/_run.py`, 292 KB) — loop de agente único, com
   sessão, memória, tools e HITL de tool.
2. `Team` (`libs/agno/agno/team/team.py`, 89 KB) — vários agentes com quatro
   modos de coordenação (`team/mode.py:5`).
3. `Workflow` (`libs/agno/agno/workflow/workflow.py`, 599 KB) — passos com
   estado, branches, loops, paralelismo e pausa por revisão humana
   (`workflow/types.py:64`).
4. `AgentOS` (`os/app.py`, 163 KB) — servidor FastAPI que expõe agentes, times
   e workflows (`api/api.py`).

Entrypoint de biblioteca: `Agent.run` / `Team.run` / `Workflow.run`
(`workflow/workflow.py:10532`). O que interessa para nós não é o servidor, e sim
o **contrato de pausa/retomada** (`StepRequirement`) e a **persistência de run
por sessão com fencing de tentativa** (`run/status_persist.py`).

Divergência README × código: o slogan "programming language for agentic software"
não aparece no código; o que existe é um framework com muitas integrações
(16 backends de DB em `agno/db/`) e forte dependência de Pydantic.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `agent.run(msg)` | `agent/_run.py` (via `agent/agent.py`) | executa e devolve `RunOutput` |
| `agent.arun_stream(msg)` | `agent/_run.py:777` (`_run_stream`) | stream de eventos |
| `team.run(task)` | `team/team.py` | coordena membros conforme `TeamMode` |
| `team.arun(task)` | `team/_run.py` | variante concorrente (broadcast) |
| `workflow.run(input)` | `workflow/workflow.py:10532` | executa steps |
| `workflow.continue_run(run_id=..., step_requirements=[...])` | `workflow/workflow.py:6557` | retoma run pausado |
| `workflow.acontinue_run(...)` | `workflow/workflow.py:8588` | variante async |
| `AgentOS(...)` + `serve` | `os/app.py`, `api/api.py` | API HTTP + console |
| `agno` CLI | `libs/agnoctl` | scaffold/gestão de projetos |

A superfície de UX do workflow é declarativa: `Step`, `Steps`, `Loop`,
`Parallel`, `Condition`, `Router` (`workflow/types.py:748-756`), e cada um
aceita `human_review=HumanReview(...)` (`workflow/types.py:64`).

## 3. Arquitetura e fluxo

```
Workflow.run
  → resolve step atual (por índice e por outputs anteriores)
  → Step.execute(executor=agent|team|function|nested_workflow)
      → agente roda (tools, memória, sessão)
      → HumanReview? → StepRequirement → RunStatus.paused
      → save_paused_session(session, run)      # HITL persiste
  → próximo step ou fim
Workflow.continue_run(run_id, requirements)
  → carrega sessão + run pausado
  → reexecuta do step pausado com a decisão
```

- Entry point: `libs/agno/agno/workflow/workflow.py:10532` (`run`).
- Loop do workflow: `workflow/workflow.py:2927` (`_execute`), versão async em
  `:3916` (`_aexecute`), com stream em `:3275`/`:4279`.
- Execução de step: `workflow/step.py:1094` (`execute`), streaming em `:1418`.
- Pausa/retomada: `workflow/utils/hitl.py:61` (`StepPauseResult`), `:235`
  (`save_paused_session`), `:399` (`ContinueExecutionState`).
- Loop do agente: `agent/_run.py:777` (`_run_stream`) com status em
  `run/base.py:378`.
- Streaming: eventos `WorkflowRunOutputEvent` e `RunOutputEvent`; cada step
  emite `StepOutput` serializável (`workflow/types.py:550`).
- Persistência: `session/workflow.py:18` (`WorkflowSession`) + `db/base.py:614`
  (`upsert_session`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `Step` | `workflow/step.py:198` | unidade executável; exige exatamente um executor (`:990`) | médio |
| `HumanReview` | `workflow/types.py:64` | confirmação, input, revisão de saída, revisão de iteração | médio |
| `StepRequirement` | `workflow/types.py:822` | `confirm/reject/edit/set_user_input/select` | baixo |
| `OnReject` / `OnTimeout` / `OnError` | `workflow/types.py:20`, `:36`, `:50` | política de falha declarativa por step | baixo |
| `@approval(type="required"\|"audit")` | `approval/decorator.py:19` | marca tool como bloqueante ou só auditoria | alto |
| `TeamMode` | `team/mode.py:5` | `coordinate`, `route`, `broadcast`, `tasks` | médio |
| task tools do time | `team/_task_tools.py:179`, `:220`, `:272` | `create_task`, `update_task_status`, `list_tasks` | médio |
| `RunStatus` | `run/base.py:378` | `pending/running/completed/paused/cancelled/error/regenerated` | baixo |
| `RunPersistOutcome` | `run/status_persist.py:30` | resultado tipado da escrita atômica de status | baixo |
| `guardrails/prompt_injection.py` | `guardrails/prompt_injection.py` | detecção de injeção de prompt | baixo |
| `compaction/compaction.py` (59 KB) | `compaction/` | sumarização/compactação de contexto | baixo |

## 5. Loop do agente, contexto e streaming

`Agent._run_stream` mantém `RunOutput` mutável, com `status` transicionando
(`agent/_run.py:1985` `pending`, `:1173` `completed`, `:694` `error`,
`:243` `paused`). O ponto forte é que **pausa é um estado de primeira classe**,
não uma exceção: quando uma tool exige aprovação, o agente para com
`RunStatus.paused` e grava a sessão; `continue_run` retoma.

- Contexto: `compaction/` (59 KB) + `session/summary.py` (12 KB); o agente pode
  carregar histórico da sessão ou só o resumo.
- Retry: `Step.max_retries` (`workflow/step.py:213`, default 3) e
  `HumanReview.max_retries` (`types.py:104`).
- Timeout de HITL: `timeout` + `on_timeout` (`types.py:105-106`), com
  `timeout_at` calculado no step (`step.py:850-852`).
- Cancelamento: registro por `run_id` (`run/cancel.py:1-20`), com
  `CancellationStage` (`run/base.py:395`) para distinguir "pedido" de
  "concluído".
- Concorrência: `TeamMode.broadcast` roda membros em paralelo no `arun`
  (`team/mode.py:17-20`); `Workflow` tem `Parallel` como tipo de step.
- Streaming: eventos por step e por run, com `to_dict`/`from_dict` em
  `StepOutput` (`types.py:588`, `:626`).

## 6. Sessões, estado e persistência

Modelo em três níveis, todos serializáveis:

- `WorkflowSession` (`session/workflow.py:18-44`): `session_id`, `user_id`,
  `workflow_id`, `runs`, `session_data`, `workflow_data`, `metadata`,
  `created_at`, `updated_at`.
- `AgentSession` (`session/agent.py:16-45`): `session_id`, `agent_id`,
  `team_id`, `user_id`, `workflow_id`, `session_data`, `agent_data`, `runs`,
  `summary`.
- `RunOutput`/`WorkflowRunOutput` guardam `messages`, `status`, `metrics`.

O DB (`db/base.py:299` `BaseDb`) tem 16 implementações (`sqlite`, `postgres`,
`async_postgres`, `mysql`, `mongo`, `redis`, `dynamo`, `firestore`, ...).
Detalhes que valem:

- **Versionamento de schema por tabela**: `schema_versions` é criada/atualizada
  em `_create_table` (`db/sqlite/sqlite.py:576-579`) e
  `upsert_schema_version` (`:906`). `BaseDb.get_latest_schema_version`
  (`db/base.py:531`).
- **Concorrência otimista em componentes**: `ComponentVersionConflictError`
  (`db/base.py:96`), `ComponentArchivedError` (`:138`),
  `ComponentCycleError` (`:148`).
- **Fencing de tentativa em run**: `RunPersistOutcome`
  (`run/status_persist.py:30`) distingue `STALE_ATTEMPT` e `TERMINAL_REFUSED`
  de `UPDATED`; o docstring explica que a escrita sem fence poderia sobrescrever
  um run `COMPLETED`/`CANCELLED` (`:1-10`).
- **Checkpoint de UI derivado**: `os/checkpoints.py:34` monta a lista de
  checkpoints a partir de marcadores por mensagem, e o docstring diz
  explicitamente que **não** cria uma segunda fonte de persistência (`:47-50`).
  `continue_from` usa `message_index`, não o id de exibição (`:52-54`).

## 7. Configuração e extensibilidade

- `Step` aceita `agent=`, `team=`, `executor=`, ou `workflow=` — exatamente um
  (`workflow/step.py:990`). O tipo é inferido (`_executor_type`,
  `step.py:968-1019`).
- `to_dict`/`from_dict` em `Workflow` (`workflow.py:1212`, `:1285`) e em
  `Step` (`step.py:295`, `:328`): workflow é **dado**, permite serializar,
  versionar e talvez carregar de arquivo.
- `HumanReview` agrupa toda a configuração de HITL em um objeto, com validação
  de combinações inválidas no construtor (`types.py:108-114`).
- `TeamMode` é enum, mas o comportamento real está em `team/_run.py` (470 KB) e
  nas task tools (`team/_task_tools.py`), que dão ao líder `create_task`,
  `update_task_status`, `list_tasks`.
- Hooks em `hooks/`; skills em `skills/`; sandbox em `sandbox/`; scheduler e
  job_queue separados (`scheduler/`, `job_queue/`).
- `AgentOS` (`os/`) expõe tudo por HTTP com auth, scopes e service accounts
  (`os/auth.py`, `os/scopes.py`).

## 8. Permissões, sandbox e erros

- **Aprovação de tool** via decorator `@approval` (`approval/decorator.py:19`):
  `required` bloqueia; `audit` só registra. Compõe com `@tool` em qualquer
  ordem (`:6-12`).
- **HITL de workflow** com política explícita: `OnReject.skip|cancel|else|retry`
  (`types.py:20-33`), `OnTimeout.cancel|skip|approve` (`:36-47`),
  `OnError.fail|skip|pause` (`:50-61`). É o conjunto mais completo dos cinco
  repositórios para "o que fazer quando o humano não responde".
- **Sandbox**: `sandbox/` (tool de execução isolada) e `fs/` para arquivos; não
  é o runtime inteiro que é isolado.
- **Guardrails**: `guardrails/pii.py`, `guardrails/prompt_injection.py`,
  `guardrails/openai.py` — opt-in, por agente.
- **Erros de run**: `RunStatus.error` + `RunOutput` com mensagem; falha de step
  segue `OnError`.
- Sem RBAC no núcleo; autorização é do `AgentOS` (`os/auth.py`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Unit | `libs/agno/tests/unit` | agent, team, workflow, db, session |
| Integração de DB | `tests/unit/db` (metade SQLite, metade Postgres) | upsert, schema version, cancel |
| Workflow/HITL | `tests/unit/workflow` | pause, continue, requirements |
| Approval | `tests/unit/approval` | `required` vs `audit` |
| API/OS | `tests/unit/os` | rotas, auth, scopes |

Contagem: 1.451 arquivos `test_*.py`. O `pyproject.toml:44-78` mostra a
intenção: `pytest-cov` (`:49`), `pytest-mock` (`:50`), `timeout-decorator`
(`:51`), e backends reais (`postgres` em `:72`, `scheduler` em `:77`) no
ambiente de teste — eles testam a integração de verdade, não mock.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `HumanReview` + `StepRequirement` | `workflow/types.py:64`, `:822` | um objeto cobre confirmação, input, revisão de saída e seleção | Apache-2.0 | `src/core/agent/interrupts.ts` | 23 |
| `OnReject`/`OnTimeout`/`OnError` | `workflow/types.py:20`, `:36`, `:50` | política de falha declarativa, com `retry` e `pause` | Apache-2.0 | `src/core/agent/graph.ts` | 22 |
| `RunStatus` + `paused` como estado | `run/base.py:378` | pausa não é exceção; UI e DB entendem igual | Apache-2.0 | `src/core/session/store.ts` | 21 |
| Fencing de tentativa (`STALE_ATTEMPT`/`TERMINAL_REFUSED`) | `run/status_persist.py:30` | impede run zumbi sobrescrever run terminal | Apache-2.0 | `src/core/session/store.ts` | 20 |
| `TeamMode` (4 modos) | `team/mode.py:5` | vocabulário pronto para delegação | Apache-2.0 | `src/core/agents/runtime.ts` | 19 |
| task tools (`create_task`/`update_task_status`/`list_tasks`) | `team/_task_tools.py:179`, `:220`, `:272` | time com lista de tarefas compartilhada, não só chat | Apache-2.0 | `src/core/tools/plan.ts` | 18 |
| `@approval(required|audit)` | `approval/decorator.py:19` | separa bloqueio de auditoria | Apache-2.0 | `src/core/security/permissions.ts` | 17 |
| Versionamento de schema por tabela | `db/base.py:531`, `db/sqlite/sqlite.py:576` | migração incremental sem "apaga e recria" | Apache-2.0 | `src/core/session/store.ts` | 15 |
| Checkpoint derivado de mensagem (fonte única) | `os/checkpoints.py:34-54` | evita divergência entre histórico e checkpoint | Apache-2.0 | `src/core/session/rewind.ts` | 14 |
| `Workflow.to_dict`/`from_dict` | `workflow/workflow.py:1212`, `:1285` | workflow serializável para UI/armazenamento | Apache-2.0 | `src/core/agents/definitions.ts` | 11 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `workflow.py` (599 KB) | monolito; difícil de portar e de testar |
| `team/_run.py` (470 KB) | idem; acoplado a Pydantic + eventos |
| `AgentOS`/`os/app.py` (163 KB) | servidor FastAPI completo; temos Electron + IPC |
| 16 backends de DB | queremos um (SQLite/arquivo) com interface trocável |
| `guardrails/openai.py` | depende de moderation API externa |
| `job_queue/` (172 KB) | escopo de infraestrutura, não de harness local |
| Apache-2.0 sem CLA | exige revisão de NOTICE se copiarmos trechos; preferir reimplementar |

## 12. Modelo de exemplo para o nosso harness

1. **Pausa como estado do run.** `RunRecord.status` ganha `paused` e um campo
   `requirements: Requirement[]`. `Requirement` = `{ stepId, kind:
   'confirm'|'input'|'review'|'select', payload, schema, onReject, onTimeout,
   timeoutAt, maxRetries }` — o `HumanReview` deles, reduzido.
2. **Política de falha por step, não global.** `StepPolicy` com
   `onReject/onError/onTimeout` e `maxRetries`. Hoje o runner decide no código;
   passar isso para o descritor do agente permite que o usuário configure.
3. **Fencing de escrita.** Toda atualização de run leva `attempt` (incrementado
   a cada retomada) e `version`; a escrita recusa se `attempt` for menor que o
   gravado (`STALE_ATTEMPT`) ou se o run já está terminal
   (`TERMINAL_REFUSED`). Isso resolve retomada concorrente — cenário real quando
   o app reinicia e o usuário clica "continuar" duas vezes.
4. **Origem única do checkpoint.** Não criar tabela de checkpoint separada do
   histórico. Derivar de marcadores por mensagem, como
   `os/checkpoints.py:47-54`, e usar o índice da mensagem como cursor.
5. **Delegação por task list.** Para times, oferecer `create_task`,
   `update_task_status`, `list_tasks` ao agente líder (`src/core/tools/plan.ts`
   já tem `plan`; a diferença é tarefa com dono e status). É mais auditável do
   que "conversem entre si".

## 13. Evidências da análise

```text
git -C repositorios/_research/orchestration/agno-agi--agno rev-parse HEAD
→ 6d5af04a72f7b152f433394b1bd4ab740fde8aed

Get-ChildItem libs/agno/agno -Directory
→ agent agents api approval client cloud compaction company context db
  environments eval factory fs guardrails hooks integrations job_queue
  knowledge learn media memory models offload os reasoning registry remote
  run sandbox scheduler scorer session skills team tools tracing utils
  vectordb workflow

read workflow/types.py:20-136
→ OnReject skip|cancel|else|retry
→ OnTimeout cancel|skip|approve
→ OnError fail|skip|pause
→ HumanReview(requires_confirmation, requires_user_input,
   requires_output_review, requires_iteration_review, on_reject, max_retries,
   timeout, on_timeout)

read workflow/types.py:748-847
→ StepType FUNCTION|STEP|STEPS|LOOP|PARALLEL|CONDITION|ROUTER|WORKFLOW
→ PauseKind step|executor
→ StepRequirement(step_id, step_name, step_index, step_type, ...)

Select-String workflow/workflow.py
→ 627 class Workflow  1212 to_dict  1285 from_dict  2927 _execute
→ 6557 continue_run  10532 run  11234 to_dict_for_steps

Select-String workflow/step.py
→ 198 class Step  206 executor  213 max_retries = 3
→ 990 "must have one executor: agent=, team=, executor=, or workflow="

read session/workflow.py:18-44
→ WorkflowSession(session_id, user_id, workflow_id, workflow_name, runs,
   session_data, workflow_data, metadata, created_at, updated_at)

read run/base.py:378-400
→ RunStatus pending|running|completed|paused|cancelled|error|regenerated
→ CancellationStage

read run/status_persist.py:1-60
→ "row-locked, attempt-fenced"; RunPersistOutcome UPDATED|MISSING|
  STALE_ATTEMPT|TERMINAL_REFUSED|UNAVAILABLE

read os/checkpoints.py:34-54
→ "does not introduce a separate persistence source"
→ "Use message_index (not checkpoint_id) when calling /continue?continue_from="

read team/mode.py
→ TeamMode coordinate|route|broadcast|tasks

Get-ChildItem agno/db -Directory → 16 backends
```
