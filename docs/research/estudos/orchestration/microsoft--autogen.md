# AutoGen (microsoft/autogen) — arquivado

| Campo | Valor |
|---|---|
| Repositório | https://github.com/microsoft/autogen |
| Clone local | `repositorios/_research/orchestration/microsoft--autogen` |
| Commit | `004749e6b7102c8fd317b9b1499ce5807223c278` |
| Licença | **Código MIT** (`LICENSE-CODE:1`; `python/packages/autogen-core/pyproject.toml` → `license = {file = "LICENSE-CODE"}`); **docs CC-BY-4.0** (`LICENSE:1`) |
| Categoria | orchestration (runtime de agentes, group chat, handoff) |
| Stack | Python >= 3.10 + .NET (`dotnet/`); pacotes `autogen-core`, `autogen-agentchat`, `autogen-ext`, `autogen-magentic-one`, `autogen-studio` |
| Tamanho | 1.837 arquivos (sem `.git`), 546 `.py`; ~112 mil linhas em `python/`; 99 arquivos `test_*.py` |

**Caminhos:** citações que começam em `teams/`, `base/`, `state/`, `agents/` ou
`conditions/` são relativas a
`python/packages/autogen-agentchat/src/autogen_agentchat/`; citações que começam
em `_single_threaded_agent_runtime.py`, `_intervention.py`, `_agent_runtime.py`,
`model_context/` ou `_routed_agent.py` são relativas a
`python/packages/autogen-core/src/autogen_core/`.

## 1. O que é (verificado no código)

Um **runtime de atores** (`autogen-core`) mais uma camada de conversação
(`autogen-agentchat`). O runtime é orientado a mensagens: agentes têm
`AgentId(type, key)`, recebem por `send_message`/`publish_message` e o
`SingleThreadedAgentRuntime` processa uma fila
(`python/packages/autogen-core/src/autogen_core/_single_threaded_agent_runtime.py:149`,
`:332`, `:387`).

Estado do projeto: **arquivado**. O README marca "status-archived"
(`README.md:20`) e recomenda migrar para o Microsoft Agent Framework
(`README.md:24-32`). Ou seja: ótimo material de estudo, **risco alto** como
dependência.

Entrypoint de time: `RoundRobinGroupChat`/`SelectorGroupChat`/`Swarm`/
`GraphFlow` — todos sobre `BaseGroupChat.run_stream`
(`python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py:351`).
Entrypoint de agente: `AssistantAgent.on_messages_stream`
(`.../agents/_assistant_agent.py:901`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pip install -U "autogen-agentchat" "autogen-ext[openai]"` | `README.md:36-40` | instala a camada de chat |
| `team.run(task=...)` | `_base_group_chat.py:247` | roda até condição de término |
| `team.run_stream(task=...)` | `_base_group_chat.py:351` | stream de mensagens/eventos |
| `team.reset()` | `_base_group_chat.py:580` | zera thread e condições |
| `team.pause()` / `team.resume()` | `_base_group_chat.py:657`, `:703` | pausa cooperativa (experimental desde 0.4.9) |
| `team.save_state()` / `load_state(state)` | `_base_group_chat.py:748`, `:798` | serializa todos os participantes |
| `runtime.process_next()` | `_single_threaded_agent_runtime.py:664` | processa **uma** mensagem (teste determinístico) |
| `runtime.save_state()` / `load_state()` | `_single_threaded_agent_runtime.py:431`, `:449` | estado de todos os agentes instanciados |
| `magentic-one-cli` | `python/packages/magentic-one-cli` | CLI do time Magentic-One |
| `autogen-studio` | `python/packages/autogen-studio` | UI web de prototipagem |

`process_next()` é a joia escondida: dá para dirigir o runtime passo a passo em
teste, sem `sleep` e sem corrida.

## 3. Arquitetura e fluxo

```
team.run_stream(task)
  → GroupChatManager seleciona próximo(s) falante(s)
  → publica GroupChatStart no tópico do time
  → participante (ChatAgentContainer) recebe, chama o agente
  → agente devolve mensagem → manager atualiza thread
  → termination_condition(mensagens) → StopMessage?
  → TaskResult(messages, stop_reason)

runtime
  → fila de envelopes (SendMessageEnvelope | PublishMessageEnvelope)
  → intervention handlers (on_send/on_publish/on_response)
  → handler roteado por tipo (_routed_agent)
  → resposta → future
```

- Entry point do time: `_base_group_chat.py:351`.
- Seleção de falante: `_base_group_chat_manager.py:306` (`select_speaker`);
  transição em `:172`; término aplicado em `:195`.
- Execução de agente: `agents/_assistant_agent.py:901` →
  `:1118` (`_process_model_result`) → `:1536` (`_execute_tool_call`).
- Runtime: `_single_threaded_agent_runtime.py:664` (`process_next`), `:796`
  (`start`), `:833` (`stop`).
- Streaming: `run_stream` emite `BaseAgentEvent | BaseChatMessage | TaskResult`.
- Persistência: `save_state`/`load_state` por time (`_base_group_chat.py:748`)
  e por runtime (`_single_threaded_agent_runtime.py:431`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `Handoff` | `base/_handoff.py:6` | alvo + descrição + mensagem; gera tool `transfer_to_<x>` (`:40`) | médio |
| `Swarm` | `teams/_group_chat/_swarm_group_chat.py:14` | próximo falante = alvo do `HandoffMessage` | médio |
| `SelectorGroupChat` | `teams/_group_chat/_selector_group_chat.py` (35 KB) | LLM escolhe o próximo falante com base em descrições | médio |
| `GraphFlow` (`DiGraphBuilder`) | `teams/_group_chat/_graph/_graph_builder.py:8` | grafo de agentes com arestas condicionais e `activation_group` | alto (ciclos) |
| `TerminationCondition` | `base/_termination.py:15` | condição com estado, combinável por `&`/`|` | baixo |
| `MaxMessageTermination` etc. | `conditions/_terminations.py:62` e seguintes | 11 condições prontas | baixo |
| `InterventionHandler` | `_intervention.py:18` | intercepta/edita/descarta mensagens do runtime | alto |
| `CancellationToken` | `_cancellation_token.py` | cancela run e tool | baixo |
| `AssistantAgent` | `agents/_assistant_agent.py:90` | loop de tool com `max_tool_iterations` (`:85`) | alto |
| `CodeExecutorAgent` | `agents/_code_executor_agent.py` (40 KB) | executa código gerado | **muito alto** |
| `UserProxyAgent` | `agents/_user_proxy_agent.py` | ponte para humano | médio |
| `SocietyOfMindAgent` | `agents/_society_of_mind_agent.py` | time interno responde como um agente | médio |

## 5. Loop do agente, contexto e streaming

`AssistantAgent` tem um loop de tool **limitado por padrão**: 
`max_tool_iterations=1` (`_assistant_agent.py:85`) e `reflect_on_tool_use`
decide se há uma segunda inferência para comentar os resultados
(`:139-146`). É o oposto do "loop até parar" — obriga o chamador a decidir
quantas rodadas aceita.

- Contexto: `ChatCompletionContext` com 5 estratégias em
  `autogen_core/model_context/`: `Buffered` (últimas N), `HeadAndTail`,
  `TokenLimited`, `Unbounded`. Trocar a política é trocar o objeto — não há
  flag booleana escondida.
- Handoff: se o modelo chama `transfer_to_x`, o agente executa as tool calls
  pendentes, devolve `HandoffMessage` com `context` e o time troca o falante
  (`_assistant_agent.py:1328-1330`).
- Reflexão: `_reflect_on_tool_use_flow` (`:1409`) e resumo
  `_summarize_tool_use` (`:1498`) com formato configurável.
- Streaming: dois níveis — chunk do modelo
  (`ModelClientStreamingChunkEvent`) e evento de agente; chunk **não** entra no
  `TaskResult.messages` (`_base_group_chat.py:362-366`).
- Cancelamento: `CancellationToken` propagado para tool e modelo; o docstring
  avisa que cancelar pode deixar o time inconsistente e que o certo é
  `ExternalTermination` (`_base_group_chat.py:260-263`).
- Retry: não há política por agente; é responsabilidade do model client
  (`autogen-ext`).

## 6. Sessões, estado e persistência

Estado é **hierárquico e nomeado**, sem checkpointer:

- `BaseState` tem `type` e `version` (`state/_states.py:5-9`).
- `TeamState.agent_states` é um mapa **nome do agente → estado**
  (`:21-25`). O docstring explica que usam nome, não `AgentId`, para o estado
  ser portátil entre runtimes (`_base_group_chat.py:766-771`).
- `BaseGroupChatManagerState` guarda `message_thread` e `current_turn`
  (`:27-33`); subclasses acrescentam `next_speaker_index`
  (RoundRobin, `:41`), `previous_speaker` (Selector, `:48`),
  `current_speaker` (Swarm, `:55`), e o ledger do Magentic-One
  (`task/facts/plan/n_rounds/n_stalls`, `:70-78`).
- `save_state` chama `runtime.agent_save_state(agent_id)` para cada
  participante **e** para o manager (`_base_group_chat.py:786-796`); `load_state`
  recusa se o time está rodando (`:808-809`).
- Limitação declarada: o runtime **não salva o estado das subscriptions**
  (`_single_threaded_agent_runtime.py:437-438`, `:456-458`). Retomar com
  subscriptions diferentes muda o roteamento.
- Não há fork, branch nem histórico de checkpoints: é snapshot do "agora".

## 7. Configuração e extensibilidade

- `Component`/`ComponentBase` + `ComponentModel`: todo agente/time declara um
  modelo Pydantic de config e um `_from_config`/`_to_config`
  (`_assistant_agent.py:1649`, `:1675`). Isso permite serializar a **definição**
  do time, não só o estado.
- `autogen-ext` concentra model clients, tools e code executors; o núcleo não
  conhece provedor.
- `Team` é interface mínima: `name`, `description`, `reset`, `pause`, `resume`,
  `save_state`, `load_state` (`base/_team.py:8-46`). Um time pode conter outro
  time (`name`/`description` existem para isso, `:14-22`).
- `InterventionHandler` é o ponto de extensão do runtime
  (`_intervention.py:18`), com `DropMessage` como sentinela explícita (`:12`).
- `_routed_agent.py` (21 KB) roteia por tipo de mensagem — o equivalente a um
  `switch` tipado, sem registro manual de handler por string.
- Sem MCP no núcleo: `autogen-core` não tem nenhuma ocorrência de "mcp"
  (**não encontrado**); a integração vive em `autogen-ext`
  (`autogen_ext.tools.mcp.McpWorkbench`, citado em
  `agents/_assistant_agent.py:417-437`).

## 8. Permissões, sandbox e erros

- **Sem permissões**: não há aprovação por tool, nem lista de risco. O
  `UserProxyAgent` é o único ponto "humano", e ele é um agente, não um gate.
- **Execução de código** é ferramenta de primeira classe
  (`agents/_code_executor_agent.py`, 40 KB) e depende de um executor
  configurado (Docker, Jupyter, etc., em `autogen-ext`). Sem executor, não roda;
  com executor mal configurado, roda tudo.
- **Erros de handler**: exceções viram `GroupChatError` e são propagadas ao
  stream (`_base_group_chat_manager.py:250`).
- **Cancelamento** é sinalizado, não forçado: `CancellationToken` + aviso de
  inconsistência (`_base_group_chat.py:260-263`).
- **Intervenção** permite descartar mensagem (`DropMessage`), o que é útil para
  policy, mas é global ao runtime — não por agente.
- Archived: sem correções de segurança. Qualquer vulnerabilidade em dependência
  fica sem patch (`README.md:24-30`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Core runtime | `python/packages/autogen-core/tests` | fila, subscriptions, intervenção, save/load |
| AgentChat | `python/packages/autogen-agentchat/tests` | times, handoff, terminação, estado |
| Ext | `python/packages/autogen-ext/tests` | model clients, code executors |
| Magentic-One | `python/packages/autogen-magentic-one/tests` | orquestrador e ledger |
| .NET | `dotnet/test` | paridade da implementação C# |

Contagem: 99 arquivos `test_*.py`. O padrão mais útil é o teste com
`process_next()`: como o runtime é uma fila, o teste avança uma mensagem por vez
e verifica o estado — sem `asyncio.sleep`. Vale copiar a ideia para o nosso
`src/core/agents/runtime.ts`.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `TerminationCondition` combinável | `base/_termination.py:15-90` | condição com estado + `&`/`|`, testável isolada | MIT | `src/core/agent/limits.ts` | 21 |
| `process_next()` (runtime dirigível) | `_single_threaded_agent_runtime.py:664` | teste determinístico sem sleep | MIT | `src/core/agents/runtime.ts` | 20 |
| Estado por nome, portátil | `_base_group_chat.py:783-796`, `_states.py:21` | desacopla estado de identidade de runtime | MIT | `src/core/session/store.ts` | 18 |
| `Handoff` como tool gerada | `base/_handoff.py:6-45` | delegação explícita no vocabulário do modelo | MIT | `src/core/agents/tools.ts` | 17 |
| `TeamMode`-like: Swarm vs Selector vs Graph | `_swarm_group_chat.py:14`, `_selector_group_chat.py`, `_graph_builder.py:8` | três topologias com trade-off claro | MIT | `src/core/agents/runtime.ts` | 16 |
| `ChatCompletionContext` plugável | `autogen_core/model_context/*` | política de contexto é objeto, não flag | MIT | `src/core/agent/context.ts` | 15 |
| `max_tool_iterations` com default 1 | `_assistant_agent.py:85` | evita loop infinito acidental | MIT | `src/core/agents/limits.ts` | 14 |
| `InterventionHandler` (on_send/publish/response) | `_intervention.py:18-56` | ponto único para policy/auditoria | MIT | `src/core/hooks/runner.ts` | 12 |
| `Component` config serializável | `_assistant_agent.py:1649`, `:1675` | definição do time como dado | MIT | `src/core/agents/definitions.ts` | 10 |
| `_routed_agent` (dispatch por tipo) | `_routed_agent.py` | evita mapa string→handler | MIT | `src/core/agents/runtime.ts` | 8 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Projeto inteiro | **arquivado**, sem patches de segurança (`README.md:24-30`) |
| Modelo de atores com fila + subscriptions | complexidade de infraestrutura; nosso runner é local e single-process |
| `autogen-core` como dependência | Python; e o runtime é o que menos precisamos |
| `CodeExecutorAgent` | risco muito alto e já temos `src/core/computer`/`sandbox` |
| `Magentic-One` completo | prompt-heavy e específico de benchmark |
| `autogen-studio` | produto separado (UI web) |
| `dotnet/` | stack incompatível |
| Docs CC-BY-4.0 | se copiar texto, precisa atribuição — evitar |

## 12. Modelo de exemplo para o nosso harness

1. **Terminação declarativa por run.** `Termination = { kind:
   'maxSteps'|'maxTokens'|'textMention'|'handoff'|'timeout'|'external', ... }`
   com composição `and`/`or` e `reset()`. Hoje o limite é um número no runner;
   passar para objeto permite "para quando o agente disser DONE **ou** 20
   passos **ou** 5 min".
2. **Driver de passo único.** Expor `advance(): Promise<StepResult>` no
   `AgentRuntime` e usar isso nos testes (um passo por `await`), em vez de rodar
   o loop inteiro e verificar o output. É o `process_next()` deles.
3. **Handoff como tool.** Ao criar um subagente, gerar
   `transfer_to_<slug>` com `{ target, description, message }`. O modelo escolhe
   delegar pelo mesmo mecanismo de tool call — sem sintaxe especial no prompt.
4. **Estado por nome + versão.** `TeamState { version, agents: { [name]:
   unknown }, thread, currentTurn }`, e `loadState` recusa se o run está
   `running`. O `version` explícito (`_states.py:5-9`) permite migrar depois.
5. **Três topologias, uma interface.** `sequential` (nosso runner), `selector`
   (LLM escolhe quem fala) e `graph` (arestas com condição). Começar por
   `sequential` + `handoff`; `graph` só quando houver demanda real.
6. **O que não copiar:** o `pause()` deles é cooperativo e explicitamente
   experimental (`_base_group_chat.py:657-663`). Nosso pause deve ser por
   checkpoint persistido, não por mensagem no barramento.

## 13. Evidências da análise

```text
git -C repositorios/_research/orchestration/microsoft--autogen rev-parse HEAD
→ 004749e6b7102c8fd317b9b1499ce5807223c278

Get-Content README.md (primeiras 40 linhas)
→ "# AutoGen [![Archived](...)]"
→ "Project archived and no longer maintained"
→ "New users should start with Microsoft Agent Framework"

Get-Content LICENSE -TotalCount 3 → "Attribution 4.0 International"
Get-Content LICENSE-CODE -TotalCount 3 → "MIT License / Copyright (c) Microsoft Corporation"

Get-ChildItem python/packages -Directory
→ agbench autogen-agentchat autogen-core autogen-ext autogen-magentic-one
  autogen-studio autogen-test-utils component-schema-gen magentic-one-cli pyautogen

Select-String autogen_agentchat/teams/_group_chat/_base_group_chat.py
→ 40 class BaseGroupChat  247 run  351 run_stream  580 reset
→ 657 pause  703 resume  748 save_state  798 load_state
→ 808 "The team cannot be loaded while it is running."

read state/_states.py:5-78
→ BaseState(type, version) / TeamState(agent_states) /
  BaseGroupChatManagerState(message_thread, current_turn) /
  SwarmManagerState(current_speaker) /
  MagenticOneOrchestratorState(task, facts, plan, n_rounds, n_stalls)

read base/_termination.py:15-90
→ "A stateful condition that determines when a conversation should be terminated"
→ __and__ / __or__ / reset

read base/_handoff.py:6-45
→ Handoff(target, description, name, message) / handoff_tool -> FunctionTool

read _single_threaded_agent_runtime.py:431-464, 664-670
→ save_state "does not currently save the subscription state"
→ process_next(): "Process the next message in the queue."

Select-String autogen_core/model_context -Pattern "class"
→ Buffered / HeadAndTail / TokenLimited / Unbounded ChatCompletionContext

(Get-ChildItem -Recurse -Filter test_*.py).Count → 99 nos diretórios tests
```
