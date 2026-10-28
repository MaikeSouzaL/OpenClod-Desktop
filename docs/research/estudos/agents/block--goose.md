# Goose

| Campo | Valor |
|---|---|
| Repositório | https://github.com/block/goose (`git remote get-url origin`) |
| Clone local | `repositorios/_research/agents/block--goose` |
| Commit | `2b17adc33a7176e701c2fef9578a5fc5834ea89a` |
| Licença | Apache-2.0 (`LICENSE:1-2`, `Cargo.toml:12`) |
| Categoria | agents / framework Rust com CLI, ACP e app Electron |
| Stack | Rust 2021 (workspace `crates/*`, `rust-version 1.94.1`), Tokio, clap, rmcp (MCP SDK), sqlx/SQLite, Electron/React no desktop |
| Tamanho | 2.531 arquivos versionados; 1.840 fontes (~1,03 M linhas); 138 arquivos de teste (122 em `ui`, 16 em `crates`) |

## 1. O que é (verificado no código)

Goose é um agente em Rust cuja execução é um **state machine explícito**, não um `while` de turnos. A
classe central é `StateMachine` (`crates/goose-agent/src/machine.rs:59`), que executa uma lista de
`Step::Operation`/`Step::Inference` e devolve efeitos a aplicar (`machine.rs:45-57,125-194`). O
`Agent` monta essa máquina com uma ordem fixa de operações — aprovação, skill, recipe, execução de
tool, subagent, steer, shell, compactação, doctor, projeto, retry, resposta vazia, stop hook, erro,
max turns (`crates/goose/src/agents/state_machine_builder.rs:72-123`). A API pública é streaming:
`Agent::reply` devolve `BoxStream<AgentEvent>` (`crates/goose/src/agents/agent.rs:1081-1105`). O README
fala de "AI agent extensível"; o código mostra que a extensibilidade é MCP de ponta a ponta
(`ExtensionConfig` em `crates/goose/src/agents/extension.rs:158-260`) e que o diferencial real é a
máquina de estados testável e a compactação por pares de tool call.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `goose` / `goose session` | `crates/goose-cli/src/cli.rs:807,921` | sessão interativa (alias `s`) |
| `goose run -t "..."` | `cli.rs` (variante de sessão) | execução não interativa |
| `goose configure` | `cli.rs:809-810` | assistente de configuração |
| `goose info` | `cli.rs:814-820` | mostra config; `--check` testa provedor |
| `goose doctor` | `cli.rs:822-823` | diagnóstico |
| `goose mcp` | `cli.rs:828-831` | roda MCP server embutido |
| `goose acp` | `cli.rs:835-848` | agente ACP em stdio |
| `goose serve` | `cli.rs:861-914` | ACP sobre HTTP/WebSocket (`--host`, `--port`, `--tls`) |
| `goose session list/remove/export/import/rename/diagnostics` | `cli.rs:520-597` | gestão de sessões |
| `goose schedule add/list/remove/sessions/run-now` | `cli.rs:613-676` | receitas agendadas (cron) |
| `goose recipe validate/deeplink/open/list` | `cli.rs:741-786` | receitas YAML |
| `goose plugin install/update` | `cli.rs:711-733` | plugins |
| `goose skills list` | `cli.rs:734-741` | skills disponíveis |
| `goose gateway status/start/stop/pair` | `cli.rs:680-710` | gateway de pareamento |
| `goose update` / `term` | `cli.rs:727,1077` | atualização e utilitário de terminal |

Slash commands são resolvidos no agente: comandos embutidos (`list_builtin_commands`,
`crates/goose/src/slash_commands/slash_command.rs:8-31`), `/compact` (linha 176, aceita
`compact`, `Compact`, `/COMPACT`) e comandos vindos de recipes/skills
(`recipe_slash_command.rs:517`, `skill_slash_command.rs:114`). O CLI também expõe `session` com
`--resume`, `--name` e `--edit` no `SessionCommand` (`cli.rs:520-597`).

## 3. Arquitetura e fluxo

```
crates/goose-cli/src/main.rs → cli.rs (clap) → CliSession
  → Agent::reply (agent.rs:1081) → reply_with_state_machine (agent.rs:722)
    → build_state_machine (state_machine_builder.rs:46)
      → StateMachine::run (machine.rs:215) → loop de steps
        → Step::Operation: ToolApproval → Skill → Recipe → ToolExecution → RemainingToolCalls
                            → Subagent → Steer → BangShell → Compaction → ...
        → Step::Inference: InferenceRunner (coleta tools/prompt de TODAS as operações)
          → Provider::stream → AgentEvent
    → StateMachine::apply (machine.rs:196) → efeitos viram mensagens
    → SessionManager (SQLite)
```

- Entry point: `crates/goose-cli/src/main.rs:1` e `cli.rs:807` (`enum Command`).
- Loop do agente: `crates/goose-agent/src/machine.rs:215-232` (`run`) e `125-194` (`step`).
- Execução de ferramenta: `crates/goose/src/agents/tool_execution.rs` +
  `ToolExecutionOperation` (`state_machine_builder.rs:83-87`).
- Streaming: `crates/goose/src/agents/agent.rs:1081-1105` (`BoxStream<AgentEvent>`) e
  `crates/goose-agent/src/inference.rs`.
- Persistência: `crates/goose/src/session/session_manager.rs:34,1096-1098` (SQLite `sessions.db`).

O detalhe mais importante da máquina: **as ferramentas são coletadas de todas as operações antes de
cada inferência** (`machine.rs:147-159`), e nomes duplicados causam erro explícito
(`machine.rs:98-110`). Isso evita o bug clássico de duas extensões registrarem `read_file`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Developer extension (shell/edit/read) | `crates/goose-mcp/` (builtin) | ferramentas de arquivo e shell via MCP | alto |
| `shell` | builtin `developer` | executa comando no workspace | alto |
| `edit` / `str_replace` | builtin `developer` | edita arquivo por substituição | médio |
| `read` / `list` | builtin `developer` | leitura e listagem | baixo |
| MCP stdio | `extension.rs:158-180` | servidor MCP por processo | alto |
| MCP streamable HTTP | `extension.rs:209-258` | servidor MCP remoto | médio |
| MCP builtin | `extension.rs:181-208` | servidor embutido no binário | médio |
| subagent | `crates/goose/src/agents/subagent.rs`, `subagent_handler.rs` | delega a outro agente, até 5 concorrentes | alto |
| recipe | `crates/goose/src/recipe` | executa YAML com passos e parâmetros | médio |
| schedule | `crates/goose/src/agents/schedule_tool.rs` | agenda receita (cron) | médio |
| skills | `crates/goose/src/skills` | carrega instruções sob demanda | baixo |
| `final_output_tool` | `crates/goose/src/agents/final_output_tool.rs` | encerra com saída estruturada | baixo |
| MOIM | `crates/goose/src/agents/moim.rs` | "mixture of inference models" — escolhe modelo por passo | médio |

O catálogo é dinâmico: `Agent::list_tools` agrega as extensões da sessão
(`crates/goose/src/agents/agent.rs:478-505`), com validação e checagem de malware de extensão em
`extension_malware_check.rs` (35 KB) — um cuidado que não vimos nos outros projetos.

## 5. Loop do agente, contexto e streaming

**Um passo, muitos candidatos.** `StateMachine::step` percorre as operações em ordem e executa a
primeira que se aplica; se nenhuma se aplica, retorna `RunStatus::Yielded` (`machine.rs:177-193`). Cada
operação declara `inference_tools`, `prompt_parts` e `moim_parts` (`machine.rs:149-158`), o que permite
que uma operação injete prompt **sem** ser uma ferramenta.

**Inferência.** `Step::Inference` prepara a sessão, checa `applies(conversation)` e chama
`inference.infer(...)` (`machine.rs:138-159`). O `InferenceRunner` recebe um `request_preparer`
específico (`state_machine_builder.rs:124-135`), que resolve extensões e orçamento de contexto.

**Cancelamento.** Cada passo roda em `tokio::select!` com `cancel.cancelled()`, e o índice do passo
interrompido é guardado (`machine.rs:163-175`). Ao finalizar, `interrupted_response` sintetiza
respostas de erro para **todo** tool request sem resposta (`machine.rs:73-96`), garantindo que o
histórico nunca fique com um `tool_call` órfão — regra que o nosso runner deveria copiar.

**Compactação.** `compact_messages` resume e mantém a última mensagem de usuário quando não é manual
(`context_mgmt/mod.rs:87-130`); o gatilho é `check_if_compaction_needed` (linha 241). O threshold é
limitado por um teto de tokens (`auto_compact_threshold`, linhas 30-42, default 225.000 na linha 25) e
por `GOOSE_AUTO_COMPACT_THRESHOLD`. Três textos de continuação distinguem conversa, loop de ferramenta
e compactação manual (`mod.rs:50-63`), sempre instruindo o modelo a não mencionar o resumo.

**Tool pair compaction.** Além do resumo geral, `compute_tool_call_cutoff` (linha 383) e
`tool_ids_to_summarize` (393) escolhem pares request/response antigos para resumir em lote de 10
(`TOOLCALL_SUMMARIZATION_BATCH_SIZE`, linha 27), com `summarize_tool_call` (461). É a resposta ao
problema de outputs gigantes que nunca mais serão usados.

## 6. Sessões, estado e persistência

SQLite, um banco `sessions.db` por usuário em `data_dir/sessions` (`session_manager.rs:34,1096-1098`),
com WAL (`1091`). O `SessionManager` é `Arc` global via `LazyLock` (`74`) e expõe um
`SessionUpdateBuilder` fluente (`170-356`) que cobre nome, tipo, working dir, extensões, uso, modelo,
`goose_mode`, recipe, projeto, `parent_session_id` e `system_prompt_override`.

- **Sessões filhas**: `parent_session_id` (`session_manager.rs:337-341`) e o
  `subagent_handler.rs`, que exige `SessionType::SubAgent` (linha 37), copia `parent_session_id`
  (linha 118) e aplica `max_turns` próprio (linhas 44-80).
- **Export/import**: `session/export_markdown.rs` (48 KB) gera markdown legível; o CLI expõe
  `session export/import` (`cli.rs:561-596`).
- **Busca**: `session/chat_history_search.rs` (15 KB).
- **Legado**: `session/legacy.rs` migra formato antigo; `session/diagnostics.rs` audita integridade.
- **Naming**: `session/session_naming.rs` gera nome a partir do primeiro prompt.
- **Snippet**: `session/last_message_snippet.rs` mantém prévia para a lista de sessões.

## 7. Configuração e extensibilidade

- **Config**: `crates/goose/src/config` com `config.yaml`, keyring e fallback em arquivo
  (`config/base.rs:1222-1244`); `GooseMode` = `Auto | SmartApprove | Approve | Chat`
  (`config/base.rs:1282,1480-1485`).
- **Instruções**: `PromptManager` monta o system prompt e lê `AGENTS.md` do projeto
  (`crates/goose/src/agents/prompt_manager.rs:331`), além de `.goosehints`.
- **MCP**: `ExtensionConfig` com `stdio`, `builtin` e `streamable_http` (`extension.rs:158-260`);
  `goose-mcp` traz servidores embutidos; `mcp_client.rs` (50 KB) é o cliente.
- **Recipes**: YAML em `crates/goose/src/recipe`, com validação, deeplink e slash command próprio
  (`recipe_slash_command.rs`).
- **Skills**: `crates/goose/src/skills` + `/skills` no CLI; `SkillOperation` injeta no passo
  (`state_machine_builder.rs:74-77`).
- **Hooks**: `crates/goose/src/hooks` + `StopHookOperation` com `stop_hook_block_cap`
  (`state_machine_builder.rs:118`).
- **Subagents**: `SubagentOperation` com `GOOSE_MAX_CONCURRENT_SUBAGENTS` default 5
  (`state_machine_builder.rs:89-95`).

## 8. Permissões, sandbox e erros

Permissão é feita por **inspectores** que produzem `InspectionResult`
(`crates/goose/src/tool_inspection.rs:12-34`) e são agregados em
`PermissionCheckResult { approved, needs_approval, denied }`
(`permission/permission_judge.rs:189-192`). O `ToolInspectionManager` roda todos os inspectores por
tool request (`tool_inspection.rs:75-120`) e o `PermissionInspector` converte o resultado em decisão
(`permission/permission_inspector.rs:73-110`).

Dois detalhes valem ouro:

1. **Anotação MCP `read_only_hint`** é respeitada: ferramentas anotadas como read-only são cacheadas
   por agente, e as demais viram `AskBefore` (`permission_inspector.rs:50-68,22-34`).
2. **Juiz LLM de read-only**: `detect_read_only_requests` cria uma ferramenta sintética
   `read_only_tool` e pede ao modelo para classificar requests (`permission_judge.rs:41-187`), com
   prompt que mantém instruções não confiáveis fora do system prompt (teste na linha 228). É um
   classificador, não um aprovador.

`GooseMode` define o comportamento global: `Auto` (aprova o que não é perigoso), `SmartApprove`,
`Approve` (tudo pede) e `Chat` (sem ferramentas). Não há sandbox de SO: busca por
`seatbelt|landlock|bwrap|fn sandbox` em `crates/goose/src/**` não retorna nada. O que existe é uma
camada de **inspectores de segurança** que também implementam `ToolInspector`:
`AdversaryInspector` (`security/adversary_inspector.rs:51,351`), `EgressInspector`
(`security/egress_inspector.rs:11,308`), `SecurityInspector` e um `SecurityManager`
(`security/mod.rs:25-42`), apoiados por `scanner.rs`, `patterns.rs` e um `ClassificationClient`
(`security/classification_client.rs:38-118`). Erros usam `anyhow::Result` (regra em `AGENTS.md`), e o
state machine propaga `Err` sem engolir (`machine.rs:170`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| unit por crate | `crates/*/src/**/tests` e `#[cfg(test)]` | máquina, operações, permissões |
| integração de agente | `crates/goose/tests/` | MCP, sessão, recipes |
| state machine | `crates/goose-agent/src/machine.rs:310-320` | rejeita tools duplicadas entre operações |
| permissões | `permission/permission_judge.rs:200-260` | juiz distingue requests por id e argumento |
| UI | `ui/desktop` (122 arquivos) | componentes e fluxo do app |
| self-test | `goose-self-test.yaml` | receita que exercita o próprio agente |

O padrão de teste da máquina é o mais reaproveitável: cada operação é testada isolada e a composição
é testada por ordem/duplicidade. Isso é possível porque `Operation` é uma trait pequena
(`machine.rs:45-57`).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| State machine de operações | `crates/goose-agent/src/machine.rs:45-267` | passos plugáveis, ordem explícita, testável por operação | Apache-2.0 | `src/core/agent/state-machine.ts` | 25 |
| Síntese de tool response para chamada órfã | `machine.rs:73-96` | histórico nunca fica com `tool_call` sem resposta | Apache-2.0 | `src/core/agent/runner.ts` | 22 |
| Inspector de permissão agregado | `tool_inspection.rs:12-120` | múltiplos inspectores → allow/ask/deny com motivo e confiança | Apache-2.0 | `src/core/security/inspectors.ts` | 23 |
| Respeito a `read_only_hint` do MCP | `permission_inspector.rs:22-68` | usa anotação do servidor para evitar prompt desnecessário | Apache-2.0 | `src/core/mcp/catalog.ts` | 21 |
| Tool pair compaction | `context_mgmt/mod.rs:383-461` | resume pares antigos em lote, preserva o resto | Apache-2.0 | `src/core/agent/compaction.ts` | 22 |
| Textos de continuação pós-compactação | `context_mgmt/mod.rs:50-63` | instrui o modelo a não mencionar o resumo | Apache-2.0 | `src/core/agent/compaction.ts` | 18 |
| ExtensionConfig unificado (stdio/builtin/http) | `agents/extension.rs:158-260` | um tipo para três transportes MCP | Apache-2.0 | `src/core/mcp/registry.ts` | 19 |
| Inspector de segurança (adversário/egress) | `security/adversary_inspector.rs:51,351`, `security/egress_inspector.rs:11,308` | detecta injeção e vazamento no mesmo pipeline de permissão | Apache-2.0 | `src/core/security/inspectors.ts` | 20 |
| `GooseMode` como enum de modo | `config/base.rs:1282,1480-1485` | quatro modos claros em vez de flags soltas | Apache-2.0 | `src/core/security/policy.ts` | 17 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Workspace Rust inteiro | stack incompatível; o valor está no desenho, não no código |
| ACP/HTTP server + `goose serve` | já temos IPC Electron; protocolo adicional não se paga |
| Electron UI (`ui/desktop`) | já temos nosso renderer |
| Scheduler/cron embutido | nosso `src/core/scheduler` já cobre |
| `roam` (P2P via iroh) | experimental e fora de escopo |
| Juiz LLM de read-only | custo de uma chamada por lote e risco de falso positivo; melhor anotação + regra |
| Local inference (`goose-local-inference`) | candle/GPU, custoso e pesado |

## 12. Modelo de exemplo para o nosso harness

1. **Operações como unidade de extensão.** Em vez de um `switch` crescente no runner, definir
   `Operation { name, applies(ctx), run(ctx) }` e uma lista ordenada. Vantagens: testar `Steer` sem
   modelo, testar `Compact` sem sessão, e permitir que plugin registre operação.
2. **Coletar tools de todas as operações antes da inferência.** Um único ponto que monta o catálogo,
   com erro em nome duplicado (não "último vence"). Isso mata a classe de bug de duas extensões com
   `read_file`.
3. **Nunca deixar tool call órfão.** Ao cancelar/finalizar, varrer o histórico e sintetizar
   `tool_result` de erro para cada request sem resposta. Copiar a semântica de `machine.rs:73-96`.
4. **Inspectores de permissão.** Interface `inspect(call) -> { action, reason, confidence }`, com
   executores em cadeia (regra → anotação MCP → sensibilidade do path). O resultado agregado é que
   vira decisão; nenhum inspector individual bloqueia sozinho.
5. **Dois níveis de compactação.** Resumo geral + resumo de pares de tool call antigos, em lotes de
   10. O primeiro controla o tamanho; o segundo remove o "lixo" de outputs que já cumpriram seu papel.
6. **Como testar.** Um teste por operação (aplica/não aplica), um teste de composição (ordem e
   duplicidade), e um teste de cancelamento que verifica que todo `tool_call` tem resposta.

## 13. Evidências da análise

```text
git -C repositorios/_research/agents/block--goose rev-parse HEAD
  -> 2b17adc33a7176e701c2fef9578a5fc5834ea89a

Leituras:
  crates/goose-agent/src/machine.rs:40-290,310-325
  crates/goose/src/agents/state_machine_builder.rs:1-140
  crates/goose/src/agents/agent.rs:478-520,690-760,1081-1110
  crates/goose/src/context_mgmt/mod.rs:1-130,241-260,343-470
  crates/goose/src/permission/permission_inspector.rs:1-110
  crates/goose/src/permission/permission_judge.rs:13-200
  crates/goose/src/tool_inspection.rs:12-170
  crates/goose/src/session/session_manager.rs:24-90,170-360,1080-1100
  crates/goose/src/agents/extension.rs:158-360
  crates/goose/src/agents/prompt_manager.rs:53-110,325-340
  crates/goose-cli/src/cli.rs:520-700,800-1080
  crates/goose/src/slash_commands/slash_command.rs:8-31,170-240

Contagens:
  git ls-files           -> 2531
  fontes (rs/ts/tsx/md…) -> 1840
  linhas somadas         -> 1030708
  arquivos de teste      -> 138 (ui 122 / crates 16)
  Cargo.toml:10          -> license = "Apache-2.0"
  Cargo.toml:8           -> version = "1.56.0"
```

Lacunas: não li `crates/goose/src/agents/extension_malware_check.rs` (35 KB), `mcp_client.rs`
(50 KB) nem `security/scanner.rs` em profundidade; a descrição de "sem sandbox de SO" vem de busca
por `seatbelt|landlock|bwrap|fn sandbox` em `crates/goose/src/**`, sem ocorrências. Também não abri
`goose-local-inference` nem o desktop.
