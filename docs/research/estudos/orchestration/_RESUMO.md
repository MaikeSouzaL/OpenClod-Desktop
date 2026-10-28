# Orquestração — resumo comparativo e candidatos

> Estudo estático de 5 repositórios em
> `repositorios/_research/orchestration/`. Nenhuma dependência foi instalada,
> nenhum teste dos clones foi executado. Toda afirmação dos estudos individuais
> tem caminho + linha; este resumo agrega e prioriza.

## Escopo verificado

| Repositório | Commit | Licença | Centro de gravidade | Arquivos `test_*.py` |
|---|---|---|---|---|
| LangGraph | `4c52e129eb1ab69a3da58b799f67929f77d81149` | MIT | grafo Pregel + checkpoint + interrupt | 173 |
| CrewAI | `38db11e3324fa0e23beb5eecd0d87e8e31ca2bb0` | MIT | Crew (tasks) + Flow (eventos) + runtime checkpoint | 407 |
| Pydantic AI | `4ee11516b5be6b767654304ec8fe346b81369597` | MIT | loop como grafo tipado + execução durável | 797 |
| Agno | `6d5af04a72f7b152f433394b1bd4ab740fde8aed` | Apache-2.0 | workflow com HITL + sessão/DB + AgentOS | 1.451 |
| AutoGen | `004749e6b7102c8fd317b9b1499ce5807223c278` | MIT (código) / CC-BY-4.0 (docs) | runtime de atores + group chat | 99 |

**Nenhum é TypeScript.** O `libs/sdk-js` do LangGraph é um README apontando
para `langchain-ai/langgraphjs` (`libs/sdk-js/README.md:3-5`). Portanto
"porta de código" só é literal para **schemas, DDL e formatos JSON**; o resto é
reimplementação de conceito em `src/core`. Não há nenhuma dependência Python
que faça sentido adicionar ao produto.

**AutoGen está arquivado** (`README.md:20`, `:24-30`): serve como referência,
nunca como dependência.

## Veredito por repositório

**LangGraph — a melhor referência de máquina de estado durável.** É o único que
trata checkpoint como cidadão de primeira classe, com `pending_writes`,
`versions_seen` e fork via `update_state`. O preço é um `PregelLoop` de 91 KB
acoplado a canais Python e `langchain-core`. Copiar o loop é inviável; copiar o
**schema** e a semântica de retomada é o melhor custo-benefício do estudo.

**CrewAI — a melhor referência de "pausa que sobrevive ao processo".** O
`HumanFeedbackPending` + `from_pending` + `SQLiteFlowPersistence` resolve o
problema que a maioria dos frameworks ignora: esperar humano sem manter uma
Promise viva. Em compensação, tem três engines concorrentes (`Crew`,
`AgentExecutor`, `lite_agent`) e um runtime de 167 KB — arquitetura em
transição, não modelo a imitar.

**Pydantic AI — a melhor referência de granularidade.** Separa *passo do loop*
(`AgentRun.next()`), *operação* (`DurableOperation`) e *validação de saída*
(`OutputValidator`). É o desenho que mais se parece com o que um harness de
código precisa: pausar entre "modelo respondeu" e "tool executou" sem reescrever
o runner. O custo é uma base de código grande e em movimento.

**Agno — a melhor referência de política de HITL.** `OnReject`, `OnTimeout`,
`OnError` e `HumanReview` cobrem os casos que sempre aparecem em produto
(usuário rejeitou, ninguém respondeu, step falhou). O preço é Apache-2.0 com
monolitos de 600 KB e forte dependência de Pydantic — bom para ler, ruim para
copiar.

**AutoGen — a melhor referência de topologia de time.** `Swarm`, `Selector` e
`GraphFlow` são três respostas claras para "quem fala agora", e a condição de
término combinável é elegante. Mas o projeto está arquivado, o runtime de atores
é infraestrutura que não temos, e a licença dos docs é diferente da do código.

## O que cada um resolve melhor

| Problema | Melhor referência | Evidência |
|---|---|---|
| Grafo com estado, ciclos e fan-out | LangGraph | `pregel/_algo.py:348`, `types.py:738` |
| Checkpoint com escrita pendente e fork | LangGraph | `checkpoint/base/__init__.py:93`, `pregel/_loop.py:708` |
| Interrupção com valor tipado | LangGraph | `types.py:903-1046` |
| Pausa que sobrevive a restart | CrewAI | `flow/async_feedback/types.py:163`, `runtime/__init__.py:1348` |
| Política de falha humana declarativa | Agno | `workflow/types.py:20-61` |
| Replay de operação (idempotência) | Pydantic AI | `durable_exec/_operation.py:249-307` |
| Aprovação por predicado com args | Pydantic AI | `toolsets/approval_required.py:14-24` |
| Delegação por handoff | AutoGen | `base/_handoff.py:6-45` |
| Terminação combinável | AutoGen | `base/_termination.py:15-90` |
| Status de run com fencing | Agno | `run/status_persist.py:30` |
| Checkpoint com branch e poda | CrewAI | `state/provider/core.py:33-90` |
| Fluxo como dado serializável | CrewAI / Agno | `flow/flow_definition.py:720`, `workflow/workflow.py:1212` |

## Rubrica de score (0–25)

| Critério | Peso | Como foi medido |
|---|---|---|
| Valor arquitetural | 0–10 | resolve lacuna real do nosso harness hoje |
| Custo de reimplementação (invertido) | 0–6 | 6 = schema/interface simples; 1 = monolito |
| Aderência ao `src/core` | 0–5 | encaixa em módulo existente sem refatoração ampla |
| Licença e risco | 0–4 | MIT/Apache com código próprio = 4; projeto arquivado = 1 |

Os scores das tabelas **por repositório** são relativos àquele repositório; a
tabela abaixo é o ranking global, com a mesma rubrica aplicada entre projetos.
Por isso um mesmo item pode aparecer com 22 no estudo do LangGraph e 24 aqui.

## 10 candidatos priorizados

| # | Candidato | Origem (arquivo:linha) | Score | Tipo | Destino proposto |
|---|---|---|---|---|---|
| 1 | Journal de operações duráveis (model/tool/list) com identidade e codec | `pydantic_ai_slim/pydantic_ai/durable_exec/_operation.py:249`, `:256`, `:307` | **25** | reimplementação de conceito | `src/core/session/run-journal.ts` (novo) |
| 2 | Interrupt/resume tipado por task, com reexecução do nó | `libs/langgraph/langgraph/types.py:903`, `:833` | **24** | reimplementação de conceito | `src/core/agent/interrupts.ts` (novo) |
| 3 | Checkpoint com `versions_seen` + `pending_writes` | `libs/checkpoint/langgraph/checkpoint/base/__init__.py:93`, `pregel/_loop.py:708` | **23** | reimplementação (schema quase literal) | `src/core/session/run-journal.ts` |
| 4 | Política de HITL por step: `onReject`/`onTimeout`/`onError` | `libs/agno/agno/workflow/types.py:20`, `:36`, `:50`, `:64` | **23** | reimplementação de conceito | `src/core/agent/graph.ts` (novo) |
| 5 | Aprovação de tool por predicado (`ctx`, `toolDef`, `args`) | `pydantic_ai_slim/pydantic_ai/toolsets/approval_required.py:14-24` | **22** | reimplementação de conceito | `src/core/security/permissions.ts` |
| 6 | `RunStatus` + fencing de tentativa (`STALE_ATTEMPT`, `TERMINAL_REFUSED`) | `libs/agno/agno/run/base.py:378`, `run/status_persist.py:30` | **21** | reimplementação (SQL literal) | `src/core/session/store.ts` |
| 7 | Handoff como tool gerada + 3 topologias de time | `autogen_agentchat/base/_handoff.py:6-45`, `teams/_group_chat/_swarm_group_chat.py:14` | **20** | reimplementação de conceito | `src/core/agents/runtime.ts` |
| 8 | Condições de término combináveis (`and`/`or`/`reset`) | `autogen_agentchat/base/_termination.py:15-90` | **19** | reimplementação de conceito | `src/core/agents/limits.ts` |
| 9 | Guardrail/saída estruturada com retry e feedback contado | `libs/crewai/.../task.py:1327-1360`; `pydantic_ai/_output.py:501` | **18** | reimplementação de conceito | `src/core/quality/guardrails.ts` (novo) |
| 10 | Task list compartilhada para times (`create/update/list`) | `libs/agno/agno/team/_task_tools.py:179`, `:220`, `:272` | **16** | reimplementação de conceito | `src/core/tools/plan.ts` |

### Notas de encaixe

1. **Journal de operações** é o de maior retorno porque resolve o único buraco
   que pode causar efeito colateral duplicado: hoje o runner grava mensagens,
   não resultados de tool. O formato do Pydantic AI (id + key + result) é
   serializável em JSON sem Pydantic.
2. **Interrupt tipado** e **checkpoint com pending_writes** são o mesmo
   subsistema visto de dois ângulos: um define *onde parar*, o outro *o que já
   foi feito*. Implementar juntos reduz o custo pela metade.
3. **Política de HITL do Agno** é a parte mais fácil de portar (enums + um
   objeto) e a que mais melhora a UX de aprovação. Não exige mudar o loop.
4. **Aprovação por predicado** encaixa direto no `ToolDef`
   (`src/core/tools/types.ts:185`), que já é o ponto onde o `runner.ts` decide
   permissão.
5. **Fencing** só faz sentido depois do journal; sem journal não há "tentativa"
   para cercar.
6. **Handoff/terminação/task list** são a camada de times. Só valem depois que
   o loop único tiver journal — senão cada subagente vira um ponto cego de
   retomada.

## Lacunas — o que nenhum dos cinco resolve para nós

| Lacuna | Por que importa | Onde ela aparece |
|---|---|---|
| Streaming com backpressure para Electron IPC | Nenhum deles tem transporte desktop; todos assumem `async for` local | nosso `runner.ts` + `ipc` |
| Checkpoint de arquivos integrado ao checkpoint de conversa | LangGraph não toca no workspace; nosso `session/checkpoint.ts` é só Git | `src/core/session/checkpoint.ts:11` |
| Custo/orçamento agregado por árvore de subagentes | `UsageLimits` do Pydantic AI é por run, não por árvore | `pydantic_ai/usage.py:505` |
| Auditoria de acesso a segredo por tool | Nenhum tem modelo de credencial por chamada | nosso `security/permissions.ts` |
| Retomada de tool já executada sem journal | LangGraph reexecuta o nó inteiro por desenho (`types.py:918`) | lacuna real para tools com efeito |
| UI de fork/branch | CrewAI tem `branch` no schema, mas não tem UI | `state/provider/core.py:33` |
| Migração de schema de run entre versões do app | Agno versiona tabela, mas não o payload do run | `db/sqlite/sqlite.py:576` |
| Cancelamento de tool em voo no Windows | Timeout do LangGraph é cooperativo e só async (`types.py:464-468`) | nosso `runner.ts` |

## Sequência sugerida

1. **Onda 1 (fundação, 1 módulo novo):** journal com `operationId`, `key`,
   `result`, `pendingWrites` + `RunStatus` com `paused`. Destrava 1, 3 e 6.
2. **Onda 2 (controle):** `interrupt<T>()` + `resume()` + política
   `onReject/onTimeout/onError` + aprovação por predicado. Destrava 2, 4 e 5.
3. **Onda 3 (saída e times):** validador de saída com retry, condições de
   término, handoff e task list. Destrava 7, 8, 9 e 10.

Critério de aceite da onda 1: matar o processo entre a execução de uma tool e a
gravação do resultado, reabrir e continuar **sem** repetir a tool. Se esse teste
não passar, nada das ondas seguintes é confiável.

## Licença e uso

- LangGraph, CrewAI e Pydantic AI são MIT: permite copiar trechos com aviso de
  copyright. Ainda assim, o código é Python acoplado a Pydantic/LangChain —
  copiar tende a custar mais do que reescrever o schema.
- Agno é Apache-2.0: cópia exige preservar `NOTICE`/`LICENSE` e indicar
  mudanças. Para os nossos fins, reimplementar os enums e o formato é mais
  barato.
- AutoGen: código MIT, **docs CC-BY-4.0**. Não copiar texto de documentação sem
  atribuição. Projeto arquivado — usar apenas como referência conceitual.

## Arquivos deste estudo

- `docs/research/estudos/orchestration/langchain-ai--langgraph.md`
- `docs/research/estudos/orchestration/crewAIInc--crewAI.md`
- `docs/research/estudos/orchestration/pydantic--pydantic-ai.md`
- `docs/research/estudos/orchestration/agno-agi--agno.md`
- `docs/research/estudos/orchestration/microsoft--autogen.md`
