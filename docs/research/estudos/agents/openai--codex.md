# OpenAI Codex CLI

| Campo | Valor |
|---|---|
| Repositório | https://github.com/openai/codex (`git remote get-url origin`) |
| Clone local | `repositorios/_research/agents/openai--codex` |
| Commit | `970111f6cb62cc02fe36a82ea7d71b37a2889c97` |
| Licença | Apache-2.0 (`LICENSE:1-2`, `codex-rs/Cargo.toml:176`) |
| Categoria | agents / CLI + app-server + sandbox de execução |
| Stack | Rust 2024 (workspace `codex-rs`, 114 crates), Tokio, clap, ratatui; wrapper npm em `codex-cli`; Bazel opcional |
| Tamanho | 9.515 arquivos versionados; 7.232 fontes (~2,42 M linhas); 1.566 arquivos `*_test(s)` |

## 1. O que é (verificado no código)

É o agente de codificação da OpenAI empacotado como CLI, mas o código mostra uma plataforma bem maior
que o binário: `codex-rs/cli/src/main.rs:132` define um `MultitoolCli` com 31 subcomandos, incluindo
`exec` (não interativo), `app-server` (protocolo JSON-RPC para IDE/desktop), `mcp`, `sandbox`,
`execpolicy` e `cloud` (`main.rs:149-250`). O loop de turno é `run_turn`
(`codex-rs/core/src/session/turn.rs:473`), e cada turno pode conter vários passos de amostragem
(`run_sampling_request`, `turn.rs:1730`). A execução de ferramenta é paralelizável por chamada
(`core/src/tools/parallel.rs:78`), mas o acesso ao disco é mediado por sandbox de SO
(seatbelt/landlock/bwrap/Windows) em `codex-rs/sandboxing/src/lib.rs`. O README fala de "coding agent";
o código confirma, mas acrescenta multiagente, code mode, plugins, hooks and a persistent app-server
daemon — nada disso é óbvio pela leitura do README.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `codex` | `main.rs:132-147` | TUI interativa (flags de `TuiCli` + overrides) |
| `codex exec` / `codex e` | `main.rs:157-159` | execução não interativa, com `--json` e eventos JSONL (`codex-rs/exec/src/lib.rs:121-137`) |
| `codex review` | `main.rs:161-162` | revisão de código não interativa |
| `codex app-server` | `main.rs:176-177` | servidor JSON-RPC experimental usado por IDEs/desktop (`app-server/src/app_server_tracing.rs:104`; `app-server-protocol/src/protocol/common.rs:271`) |
| `codex mcp` | `main.rs:170-171` | gerencia servidores MCP externos (`cli/src/mcp_cmd.rs`) |
| `codex plugin` | `main.rs:173-174` | instala/lista plugins |
| `codex resume` / `fork` | `main.rs:209-231` | retoma ou bifurca sessão salva (picker ou `--last`) |
| `codex queue` | `main.rs:212-213` | enfileira mensagem para sessão existente |
| `codex archive/delete/unarchive` | `main.rs:215-228` | ciclo de vida de sessões |
| `codex apply` / `a` | `main.rs:205-207` | aplica o último diff como `git apply` |
| `codex sandbox` | `main.rs:195-196` | roda comando dentro do sandbox do Codex |
| `codex doctor` | `main.rs:192-193` | diagnóstico de instalação/config/auth |
| `codex features` | `main.rs:248-249` | inspeciona feature flags |

Flags de segurança aparecem nos testes de parsing: `--sandbox read-only`, `--ask-for-approval
on-request`, `--dangerously-bypass-approvals-and-sandbox` (`main.rs:3330-3331,3477-3479`). O
`--sandbox` aceita os modos de `SandboxPolicy` e `--ask-for-approval` os de `AskForApproval`
(`codex-rs/protocol/src/protocol.rs:1098,1184`).

## 3. Arquitetura e fluxo

```
codex-rs/cli/src/main.rs (clap) → codex-core::Session
  → SessionTask (RegularTask | CompactTask | ReviewTask | UserShellCommandTask)  tasks/mod.rs:181
    → run_turn (session/turn.rs:473)  loop de passos
      → capture_step_context (tool_router + environments)  turn.rs:509-545
        → run_sampling_request (turn.rs:1730) → ModelClientSession.stream
          → ToolCallRuntime.handle_tool_call (tools/parallel.rs:78) → sandbox → execpolicy
            → ResponseItem gravado no rollout (.jsonl) e no thread-store
```

- Entry point: `codex-rs/cli/src/main.rs:132` (`MultitoolCli`), dispatch em `main.rs:149-250`.
- Loop do agente: `codex-rs/core/src/session/turn.rs:473` (turno) e `turn.rs:1773` (retry de stream).
- Execução de ferramenta: `codex-rs/core/src/tools/parallel.rs:78-120`.
- Streaming: `codex-rs/core/src/session/turn.rs:1806-1818` (`try_run_sampling_request`) com utilitários
  em `core/src/stream_events_utils.rs:224-226` (`last_agent_message`, `needs_follow_up`).
- Persistência: `codex-rs/rollout/src/recorder.rs:1,82` (arquivos `.jsonl` em `~/.codex/sessions`),
  metadados em `codex-rs/thread-store/src/*`.

A separação importante: **tarefas** são o nível de agendamento (`SessionTask`), **turnos** agrupam
passos e **passos** são chamadas de modelo. `RegularTask::run` faz um `loop` que só termina quando não
há input pendente (`tasks/regular.rs:107-127`) — ou seja, uma mensagem do usuário durante o turno é
drenada para o próximo passo, não interrompe o atual.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `exec_command` (shell) | `core/src/tools/spec_plan.rs:1265` | executa comando; `write_stdin` quando unified exec está ligado | alto |
| `write_stdin` | `core/src/tools/spec_plan.rs:1266` | escreve em processo TTY persistente | alto |
| `apply_patch` | `codex-rs/apply-patch/`, specs em `core/src/tools/spec_plan.rs` | aplica patch estruturado | médio |
| `update_plan` | `core/src/tools/spec_plan.rs:1299-1301` (`PlanHandler`) | mantém plano de tarefas | baixo |
| `view_image` | `core/src/tools/spec_plan.rs:1439-1441` | lê imagem do workspace | médio |
| `list_mcp_resources` / `read_mcp_resource` | `core/src/tools/spec_plan.rs:1281-1289` | recursos MCP | médio |
| `tool_search` | `codex-rs/tools/src/tool_discovery.rs:6` | descobre ferramentas sob demanda | baixo |
| `request_permissions` | `core/src/tools/spec_plan.rs:1364` | pede permissão adicional ao usuário | médio |
| `new_context_window` / `get_context_remaining` | `core/src/tools/spec_plan.rs:1371-1376` | controla janela de contexto | médio |
| `wait_for_environment` | `core/src/tools/spec_plan.rs:1303-1312` | espera ambiente ficar pronto | baixo |
| multiagente (`spawn_agent`, `wait_agent`) | `core/src/tools/spec_plan.rs:757-782` | cria e espera subagentes | alto |
| web search (hosted) | `core/src/tools/spec_plan.rs:712-717` | busca web do provedor | médio |

O catálogo é montado por composição de fontes (`add_core_tool_sources`, `spec_plan.rs:1185-1205`) sob
política: se `require_managed_sandbox` e o perfil não for `Managed`, **nenhuma** ferramenta de core é
registrada (`spec_plan.rs:1187-1199`). Ferramentas são expostas como `Function`, `Freeform`,
`Namespace`, `ToolSearch` ou `WebSearch` (`core/src/tools/registry.rs:626-630`).

## 5. Loop do agente, contexto e streaming

**Prompt.** `run_sampling_request` reconstrói o input a cada tentativa: usa o input inicial uma vez e
depois `sess.clone_history().for_prompt(...)` (`turn.rs:1776-1782`), anexa resultados de ferramentas já
executadas (`turn.rs:1784-1786`) e monta `build_prompt(input, step_context, base_instructions,
incremental_tools)` (`turn.rs:1787-1792`). Instruções base vêm de `get_prompt_base_instructions`
(`turn.rs:1748`), que inclui `AGENTS.md` gerenciado por `core/src/agents_md.rs`.

**Decisão de ferramenta.** O modelo devolve itens; o runtime os classifica e executa em paralelo com
`RwLock` de execução (`tools/parallel.rs:46-66`). Cada chamada tem estado próprio
(`ToolCallState`) e um `ToolCallTimingGuard` para telemetria (`parallel.rs:35-43`). Erros de função
viram `ResponseItem` de falha em vez de derrubar o turno (`parallel.rs:100-113`).

**Compactação.** Há três caminhos: inline (`compact.rs`, prompt `SUMMARIZATION_PROMPT` reexportado de
`codex_prompts`, `compact.rs:61`), assíncrona (`session/async_compaction.rs`) e "remote v2"
(`compact_remote_v2.rs`). O resultado é um `CompactedItem` com histórico substituto e metadados de
janela (`compact.rs:69-107`). O texto do usuário é limitado a 20.000 tokens na compactação
(`compact.rs:63`). O gatilho por orçamento aparece em `session/turn.rs:437-453` e
`run_auto_compact` em `turn.rs:1530`.

**Retry e cancelamento.** O stream tem `retry_state` e `max_retries` por provedor
(`turn.rs:1760-1769`). Cancelamento é `CancellationToken` propagado por turno, passo e tarefa
(`tasks/regular.rs:45,114`); `SessionTask` recebe o token na assinatura (`tasks/mod.rs:181`).
Interrupção grava um marcador no histórico (`tasks/mod.rs:79-103`).

## 6. Sessões, estado e persistência

O formato primário é **JSONL append-only**: `RolloutRecorder` grava
`~/.codex/sessions/rollout-<timestamp>-<conversation_id>.jsonl` (`rollout/src/recorder.rs:1,82-86`),
com variante `.jsonl.zst` comprimida e leitura transparente (`rollout/src/compression.rs:63-107`).
`thread/revert` muda o nome para incluir `_<rollout_id>` (`recorder.rs:101-102`), o que dá fork/revert
sem reescrever o arquivo antigo.

Acima do arquivo existe `codex-rs/thread-store` (store abstrato, `live_thread.rs`, `queue_store.rs`,
`thread_metadata_sync.rs`) e `codex-rs/rollout/src/state_db.rs` para índice SQLite. A configuração
global fica em `config.toml` (`core/src/config/mod.rs:271`), e o estado do app-server em
`codex-rs/codex-home`.

Recuperação: o app-server daemon (`codex-rs/app-server-daemon`) mantém threads vivas; o CLI usa
`resume`/`fork` (`main.rs:209-231`) e o teste `codex-rs/cli/src/main.rs:3277` cobre `exec --json
resume --last`. Não há checkpoint por passo no sentido do OpenCode: o rollout é o log, e a
reconstrução é por replay (`core/src/session/rollout_reconstruction.rs`).

## 7. Configuração e extensibilidade

- **Config**: `config.toml` com perfis e `model_providers` (`core/src/config/mod.rs:271-272`);
  overrides de CLI via `CliConfigOverrides` (`main.rs:134`).
- **Instruções**: `AGENTS.md` descoberto e mesclado por `core/src/agents_md.rs` e
  `agents_md_manager.rs`; há limite de bytes por documento (`DEFAULT_PROJECT_DOC_MAX_BYTES`,
  `core/src/config/mod.rs:31`).
- **Hooks**: `core/src/hook_runtime.rs` (50 KB) com `run_pre_compact_hooks`/`run_post_compact_hooks`
  (`compact.rs:17-19`) e execução externa via `hook_environment_executor.rs`/`hook_mcp_executor.rs`.
- **Plugins/extensões**: `codex-rs/plugin`, `core-plugins`, `core/src/plugins/*`; contribuintes de
  ferramentas por passo (`spec_plan.rs:349-366`).
- **MCP**: `codex-rs/rmcp-client` (cliente), `codex-rs/codex-mcp` e ponte em `core/src/mcp.rs`;
  `add_mcp_resource_tools` só registra quando há servidores (`spec_plan.rs:1276-1290`).
- **Skills**: crate `codex-rs/skills`, integrada ao turno (`turn.rs:1121` `build_skills_and_plugins`).
- **Multiagente**: `agent-roles`, `agent-graph-store`, `agent-message-board-client`; especificação em
  `core/src/agent/role/spawn_tool_spec.rs`.

## 8. Permissões, sandbox e erros

Dois eixos independentes:

1. **Aprovação** (`AskForApproval`, `protocol/src/protocol.rs:1098-1120`): `unless-trusted` (comando
   exige aprovação salvo regra explícita), `on-request` (default; o modelo decide quando pedir),
   `granular(GranularApprovalConfig)` e `never` (falha volta ao modelo, nunca escala).
2. **Sandbox** (`SandboxPolicy`, `protocol.rs:1184-1205`): `danger-full-access`, `read-only` com
   `network_access`, `external-sandbox` e `workspace-write`.

A política de comandos é um DSL próprio: `codex-rs/execpolicy` tem parser (`parser.rs`), regras de
prefixo (`rule.rs`), avaliação (`policy.rs`) e decisão `Allow`/`Deny`/`Ask` (`decision.rs`, 791 B).
Regras de rede são separadas (`NetworkRule`, `policy.rs:96-98`). O sandbox real fica em
`codex-rs/sandboxing`: Seatbelt (macOS), Landlock + bwrap (Linux), sandbox Windows
(`windows.rs`, `windows_mxc.rs`). Denial é detectado por heurística
(`sandboxing/src/denial.rs:30-31`).

Erros: `CodexErr` (`codex-protocol/src/error.rs`) com `CodexErrorDetails::ContextWindowExceeded`
tratado explicitamente para permitir compactação e reprocessar entrada (`turn.rs:355-384`). Ferramenta
que falha na fase de função retorna `ResponseItem` de erro (`parallel.rs:100-113`), então o modelo vê
a falha em vez de o turno morrer.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| unit por crate | `codex-rs/*/src/*_tests.rs` | lógica interna; 1.566 arquivos de teste no total |
| integração de core | `codex-rs/core/tests/*` | turnos, tools, MCP, compactação |
| CLI | `codex-rs/cli/src/main.rs:3277+` (testes de parsing) | flags, subcomandos, `exec resume` |
| sandbox | `sandboxing/src/*_tests.rs` | seatbelt, landlock, windows, violações |
| execpolicy | `execpolicy/src/*` + `execpolicycheck` | parser e decisões de regra |
| app-server | `app-server-protocol` export + testes | schema JSON-RPC e compatibilidade |

O volume é o sinal: ~1.566 arquivos de teste para ~2,4 M linhas, com testes colocados ao lado do
código e testes de integração por crate. Não há suíte central única; cada crate é testado isolado.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Política de execução por prefixo | `codex-rs/execpolicy/src/policy.rs:71-120`, `decision.rs` | permite `allow` por prefixo de comando, com `Ask` no meio | Apache-2.0 | `src/core/security/exec-policy.ts` | 23 |
| Modelo de dois eixos (aprovação + sandbox) | `protocol/src/protocol.rs:1098-1205` | separa "quem aprova" de "o que o SO permite" | Apache-2.0 | `src/core/security/policy.ts` | 22 |
| Tool runtime paralelo com estado por chamada | `core/src/tools/parallel.rs:46-120` | chamadas independentes em paralelo com resultado tipado | Apache-2.0 | `src/core/tools/runtime.ts` | 21 |
| Roteador/registry de ferramentas por política | `core/src/tools/spec_plan.rs:1185-1205` | composição de fontes + poda por feature/política | Apache-2.0 | `src/core/tools/registry.ts` | 21 |
| Rollout JSONL append-only com replay | `rollout/src/recorder.rs:82-102` | log imutável, fork/revert por arquivo novo | Apache-2.0 | `src/core/session/rollout.ts` | 20 |
| Limite de saída de compactação | `core/src/compact.rs:63` | corta a mensagem do usuário em 20k tokens antes de resumir | Apache-2.0 | `src/core/agent/compaction.ts` | 17 |
| Detecção de denial de sandbox | `sandboxing/src/denial.rs:30-31` | distingue bloqueio de sandbox de erro real | Apache-2.0 | `src/core/security/denial.ts` | 15 |
| Marcador de turno interrompido | `tasks/mod.rs:79-103` | histórico sabe que o turno foi abortado, sem inventar resposta | Apache-2.0 | `src/core/session/tracker.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Workspace Rust de ~120 crates | stack incompatível; portar um crate exige reescrever dependências |
| `app-server` JSON-RPC completo | já temos IPC Electron; adicionar protocolo paralelo duplica estado |
| Sandbox de SO (seatbelt/landlock/bwrap) | dependência de plataforma; nosso isolamento é por permissão + worktree |
| Code mode (`codex-rs/code-mode*`) | acoplado a V8/worker e ao protocolo de exec-server |
| Multiagente com `agent-graph-store` | complexidade alta, ainda experimental no próprio repo |
| `compact_remote_v2` | depende de backend proprietário da OpenAI |

## 12. Modelo de exemplo para o nosso harness

1. **Dois eixos de segurança, não um.** Nosso `src/core/security/policy.ts` deve separar
   `ApprovalMode` (`unless-trusted | on-request | granular | never`) de `SandboxMode`
   (`read-only | workspace-write | full`). Hoje `permissions.ts` mistura decisão e efeito; separar
   permite "aprovar uma vez, executar em read-only" sem reescrever regra.
2. **Regra de execução por prefixo.** Adotar o formato `{ program, prefix[], decision }` de
   `execpolicy/src/rule.rs`, avaliado antes de qualquer spawn. Vantagem sobre regex: o comando é
   tokenizado, então `git status; rm -rf /` não casa como `git status`.
3. **Registry composto por fontes.** `src/core/tools/registry.ts` deve montar o catálogo em camadas
   (core → MCP → plugin → agente) e podar por política **antes** de serializar o schema. Isso evita o
   problema de expor ferramenta que o modelo não pode usar.
4. **Log append-only para sessão.** Antes de inventar um schema relacional, considerar um
   `session/rollout.ts` que grava eventos JSONL e projeta para o store atual. Fork = novo arquivo com
   prefixo copiado; revert = novo arquivo com corte. É o que o Codex faz e simplifica recuperação.
5. **Como testar.** Testes de política com tabela de comandos (permitido/negado/ask) e testes de
   turno com provedor falso que emite `tool-call` + `finish`; verificar que uma falha de ferramenta
   vira mensagem, não exceção.

## 13. Evidências da análise

```text
git -C repositorios/_research/agents/openai--codex rev-parse HEAD
  -> 970111f6cb62cc02fe36a82ea7d71b37a2889c97

Leituras:
  codex-rs/cli/src/main.rs:1-60,130-280,3270-3490
  codex-rs/core/src/tasks/regular.rs:1-129
  codex-rs/core/src/tasks/mod.rs:65-120,181-300
  codex-rs/core/src/session/turn.rs:340-480,460-620,1730-1819
  codex-rs/core/src/tools/spec_plan.rs:1185-1320
  codex-rs/core/src/tools/parallel.rs:1-120
  codex-rs/core/src/compact.rs:1-130
  codex-rs/execpolicy/src/policy.rs:1-120
  codex-rs/sandboxing/src/lib.rs:1-43
  codex-rs/protocol/src/protocol.rs:1098-1210
  codex-rs/rollout/src/recorder.rs:1-110
  codex-rs/rollout/src/compression.rs:20-110

Contagens:
  git ls-files                      -> 9515
  fontes (ts/tsx/js/rs/py/toml/md)  -> 7232
  linhas somadas                    -> 2419802
  arquivos de teste                 -> 1566
  codex-rs/Cargo.toml:176           -> license = "Apache-2.0"
```

Lacunas: não mapeei todos os métodos do `app-server` (só confirmei o transporte JSON-RPC em
`app-server/src/app_server_tracing.rs:104` e a conversão em
`app-server-protocol/src/protocol/common.rs:271`); a lista completa de `ClientRequest` não foi lida.
Também não abri `code-mode-runtime` nem `exec-server`.
